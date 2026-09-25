#!/usr/bin/env node
/**
 * Targeted browser probe for the jeep combat-doctrine change: in attract mode the CPU-driven
 * demo hull (a jeep) must keep running at the enemy flag instead of parking in its old 26 m
 * standoff ring whenever an enemy is in sight. Samples the hull's distance to the enemy flag
 * every 10 s of sim time and reports the trend; asserts it gets well inside its starting range
 * (old code: the first contact held it out at ~120-140 m for the rest of the round).
 *
 *   node tools/jeep-demo-probe.mjs [--secs 240] [--map 0] [--seed 3] [--port 5180]
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
const PORT = Number(flag('port', 5180));
const WAIT = Number(flag('wait', 15000));

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
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 30000) {
    if (await portAlive(PORT)) {
      ok = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
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
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[console] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const url = `http://127.0.0.1:${PORT}/?auto=1&demo=1&map=${MAP}&seed=${SEED}&mode=mirror`;
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

/** Demo hull (slot 0, buildT=1) distance to the enemy flag + match state. */
const sample = () =>
  page.evaluate(() => {
    const g = window.rfGame;
    const sim = g.sim;
    let hull = null;
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if (v.hp <= 0) continue;
      const slot = Math.round(v.buildT) - 1;
      if (slot === 0 && !hull) hull = { id: v.id, kind: v.kind, x: v.x, z: v.z };
    }
    const f = sim.flags[1];
    return {
      matchState: sim.matchState,
      score: [sim.score(0), sim.score(1)],
      flagState: f.state,
      hull,
      distFlag: hull ? Math.hypot(hull.x - f.x, hull.z - f.z) : null,
    };
  });

const failures = [];
if (status === 'ok') {
  const CHUNK_S = 10;
  let startDist = null;
  let minDist = Infinity;
  let captures = 0;
  let prevScore = [0, 0];
  const log = [];

  for (let s = CHUNK_S; s <= SECS; s += CHUNK_S) {
    await page.evaluate((frames) => window.rfStep(frames), CHUNK_S * 60);
    // Let the render loop breathe between chunks: those rAF frames run updateFlow, which owns
    // the demo auto-respawn. A tight evaluate loop starves them.
    await new Promise((r) => setTimeout(r, 400));
    const st = await sample();
    if (st.score[0] > prevScore[0]) captures += st.score[0] - prevScore[0];
    prevScore = [st.score[0], st.score[1]];
    if (st.distFlag != null) {
      if (startDist == null) startDist = st.distFlag;
      minDist = Math.min(minDist, st.distFlag);
    }
    log.push(
      `t=${String(s).padStart(3)}s state=${st.matchState} score=[${st.score[0]},${st.score[1]}] flag=${st.flagState} ` +
        (st.hull ? `hull#${st.hull.id}(k${st.hull.kind})@(${Math.round(st.hull.x)},${Math.round(st.hull.z)}) dFlag=${st.distFlag.toFixed(0)}m` : 'hull=none'),
    );
  }

  console.log(`jeep demo probe: map=${MAP} seed=${SEED} ${SECS}s of sim time`);
  for (const line of log) console.log('  ' + line);
  console.log(
    `summary: startDist=${startDist?.toFixed(0)}m minDist=${minDist.toFixed(0)}m capturesByTeam0=${captures}`,
  );

  if (startDist == null) failures.push('the CPU-driven demo hull never appeared in the world');
  else if (minDist > startDist * 0.6) {
    failures.push(
      `demo hull never got inside ${Math.round(startDist * 0.6)} m of the enemy flag (closest ${minDist.toFixed(0)} m from a start of ${startDist.toFixed(0)} m): it is still parking on first contact instead of running the flag`,
    );
  }
}

await browser.close();
if (server?.pid) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
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
console.log('PASS: the CPU-driven demo jeep keeps running at the enemy flag through contacts');
process.exit(0);
