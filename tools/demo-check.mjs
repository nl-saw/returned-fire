#!/usr/bin/env node
/**
 * Headless attract-mode (demo) checker.
 *
 *   node tools/demo-check.mjs [--secs 240] [--map 0] [--seed 3] [--port 5179] [--wait 15000]
 *
 * Loads `?auto=1&demo=1&mode=mirror` (Mirror matches the core probes; see below), advances
 * the simulation in chunks through `window.rfStep` (the same fixed-step path the frame loop
 * uses, minus rendering), and samples the world every 10 s of sim time. Asserts what attract
 * mode must deliver:
 *
 *   - the CPU-driven demo hull leaves the pad (it is driven by the sim AI, not a blind pilot),
 *   - anti-camping drones never spawn against it (a driver is not camping),
 *   - after a round ends, a fresh demo hull appears (the web auto-respawns; nobody clicks
 *     the garage in attract mode),
 *   - no console or page errors.
 *
 * Exits 0 on pass, 2 on fail. Like `shot.mjs`, it starts a Vite dev server unless one is
 * already listening on the port.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const SECS = Number(flag('secs', 240));
const MAP = flag('map', '0');
const SEED = flag('seed', '3');
const PORT = Number(flag('port', 5179));
const WAIT = Number(flag('wait', 15000));
const TWO = argv.includes('--two'); // split-screen attract mode: both slots CPU-driven

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700) });
    return r.ok || r.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await portAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let server = null;
if (!(await portAlive(PORT))) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: WEB,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
    detached: true,
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d.toString()));
  server.stderr.on('data', (d) => (log += d.toString()));
  const ok = await waitFor(PORT, 30000);
  if (!ok) {
    console.error('vite did not start:\n' + log);
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      server.kill('SIGKILL');
    }
    process.exit(1);
  }
}

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('no chromium found; set CHROME_PATH');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: chrome,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    '--hide-scrollbars',
  ],
});

const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const problems = [];
const notFound = [];
page.on('response', (r) => {
  if (r.status() === 404) notFound.push(r.url());
});
page.on('console', (m) => {
  const t = m.type();
  // Resource-load failures are tracked via the response listener above (which has the URL);
  // this keeps only real console errors.
  if (t === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[console] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

// `mode=mirror` matches the core probes (mapgen::generate is Mirror mode); the web boot
// default is Classic, and on some Classic maps the AI commander simply never captures
// (documented FINDING in gameplay_audit), which would starve the round-end checks.
const url = `http://127.0.0.1:${PORT}/?auto=1&demo=1&map=${MAP}&seed=${SEED}&mode=mirror${TWO ? '&two=1' : ''}`;
let status = 'ok';
try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  try {
    await page.waitForFunction('window.__READY__ === true', null, { timeout: WAIT });
  } catch {
    status = 'timeout-waiting-ready';
  }
} catch (e) {
  status = `nav-error: ${e.message}`;
}

/** One sim sample: the demo hull per player slot (buildT = slot+1), drone count, round state. */
const sample = () =>
  page.evaluate(() => {
    const g = window.rfGame;
    const sim = g.sim;
    const players = [null, null];
    let drones = 0;
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if (v.hp <= 0) continue;
      if (v.kind === 6) drones++; // vkind::DRONE
      const slot = Math.round(v.buildT) - 1;
      if ((slot === 0 || slot === 1) && !players[slot]) {
        players[slot] = { id: v.id, kind: v.kind, x: v.x, z: v.z, hp: Math.round(v.hp) };
      }
    }
    return {
      matchState: sim.matchState, // 0 playing / 1 round over / 2 match over
      score: [sim.score(0), sim.score(1)],
      players,
      drones,
      vehicles: sim.vehicleCount,
    };
  });

const failures = [];
if (status === 'ok') {
  const SLOTS = TWO ? 2 : 1; // CPU-driven slots under test
  const CHUNK_S = 10; // rfStep advances 60 fixed steps per call-second
  let maxDrones = 0;
  let roundEnds = 0;
  let respawnedAfterRound = false;
  let prevState = 0;
  const saw = Array.from({ length: SLOTS }, () => false);
  const firstPos = Array.from({ length: SLOTS }, () => null);
  const maxDist = Array.from({ length: SLOTS }, () => 0);
  const midRoundDeathSeen = Array.from({ length: SLOTS }, () => false);
  const respawnedMidRound = Array.from({ length: SLOTS }, () => false);
  const hullIds = Array.from({ length: SLOTS }, () => new Set());
  const log = [];

  for (let s = CHUNK_S; s <= SECS; s += CHUNK_S) {
    await page.evaluate((frames) => window.rfStep(frames), CHUNK_S * 60);
    // Let the render loop breathe between chunks: in a real browser session attract mode
    // lives on requestAnimationFrame frames, and it is those frames that run updateFlow —
    // which owns the demo auto-respawn. A tight evaluate loop starves them.
    await new Promise((r) => setTimeout(r, 400));
    const st = await sample();
    if (prevState === 0 && st.matchState !== 0) roundEnds++; // entered a round/match end
    prevState = st.matchState;
    maxDrones = Math.max(maxDrones, st.drones);
    let playerLine = '';
    for (let p = 0; p < SLOTS; p++) {
      const pl = st.players[p];
      if (pl) {
        saw[p] = true;
        hullIds[p].add(pl.id);
        if (!firstPos[p]) firstPos[p] = { x: pl.x, z: pl.z };
        maxDist[p] = Math.max(maxDist[p], Math.hypot(pl.x - firstPos[p].x, pl.z - firstPos[p].z));
        // A hull in the field after a round end is the auto-respawn working.
        if (roundEnds > 0) respawnedAfterRound = true;
        // A hull back in the field after a mid-round death is the auto-respawn working.
        if (midRoundDeathSeen[p] && roundEnds === 0) respawnedMidRound[p] = true;
      } else if (st.matchState === 0) {
        midRoundDeathSeen[p] = true; // no ride during play: the hull died this round
      }
      playerLine += ` p${p}=${pl ? `#${pl.id}@(${Math.round(pl.x)},${Math.round(pl.z)})hp${pl.hp}` : 'none'}`;
    }
    log.push(
      `t=${String(s).padStart(3)}s state=${st.matchState} score=[${st.score[0]},${st.score[1]}]${playerLine} drones=${st.drones} vehicles=${st.vehicles}`,
    );
  }

  for (let p = 0; p < SLOTS; p++) {
    if (!saw[p]) failures.push(`CPU-driven slot ${p}: its demo hull never appeared in the world`);
    if (maxDist[p] <= 40) failures.push(`slot ${p} demo hull never left the pad (max distance ${maxDist[p].toFixed(1)} m)`);
    // The first demo hull usually dies early (the enemy garrison ambushed it in the core probe
    // too). Attract mode must re-field it: a hull back in the field after a mid-round death is
    // the auto-respawn working. (If the first hull happens to survive, there is nothing to check.)
    if (midRoundDeathSeen[p] && !respawnedMidRound[p]) {
      failures.push(`slot ${p}: the demo hull died mid-round and no replacement ever reappeared (attract-mode auto-respawn broken)`);
    }
  }
  if (maxDrones > 0) failures.push(`anti-camping drones spawned against the demo driver(s) (max ${maxDrones})`);
  if (roundEnds > 0 && !respawnedAfterRound) {
    failures.push('a round ended but no fresh demo hull reappeared (attract-mode auto-respawn broken)');
  }

  console.log(`demo check: map=${MAP} seed=${SEED} two=${TWO} ${SECS}s of sim time`);
  for (const line of log.filter((l, i) => i % 3 === 0)) console.log('  ' + line);
  const summary = [];
  for (let p = 0; p < SLOTS; p++) {
    summary.push(`slot${p}: hulls=${hullIds[p].size} maxDistFromPad=${maxDist[p].toFixed(1)}m`);
  }
  console.log(`summary: ${summary.join(' | ')} maxDrones=${maxDrones} roundEnds=${roundEnds} respawnedAfterRound=${respawnedAfterRound}`);
}

await browser.close();
if (server?.pid) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
}

// Chromium always asks for /favicon.ico; the page links no icon, so that 404 is expected.
const realNotFound = notFound.filter((u) => !/favicon/i.test(u));
if (realNotFound.length) {
  console.log('--- unexpected 404s ---');
  for (const u of realNotFound.slice(0, 10)) console.log(u);
  failures.push(`${realNotFound.length} unexpected 404 response(s)`);
}

if (problems.length) {
  console.log('--- page problems ---');
  for (const p of problems.slice(0, 40)) console.log(p);
  failures.push(`${problems.length} console/page error(s)`);
}

if (failures.length) {
  console.log('FAIL:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(2);
}
console.log(
  TWO
    ? 'PASS: split-screen attract mode drives both CPU hulls, summons no drones, and re-fields after deaths'
    : 'PASS: attract mode drives a real CPU hull, summons no drones, and re-fields after rounds',
);
process.exit(0);
