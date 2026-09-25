#!/usr/bin/env node
/**
 * Repro harness for "vehicles no longer spawn after some play" on an EDITOR map: the user's
 * session was solo on a map saved from the editor. Boots `editor.html`, makes light edits
 * (move a base, lay a road, drop walls — what a player does), stores the `.rfmap` the same way
 * "play this map" does, navigates to the game (which boots on the stored map) and then runs the
 * garage-stall session: demo autopilot driving at the enemy flag, re-picking a vehicle on a
 * timer and after every death, watching for (a) an unfulfilled player request and (b) an empty
 * CPU field. Also logs every match-state transition so round ends are visible.
 *
 *   node tools/editor-stall.mjs [minutes] [seed]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');
const PORT = Number(process.env.EDITOR_STALL_PORT ?? 5192);
const BOOT_MS = 240_000;
const MINUTES = Number(process.argv[2] ?? 30);
const SEED = process.argv[3] ?? '7';

const alive = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(700) });
    return r.status < 500;
  } catch {
    return false;
  }
};
let server = null;
if (!(await alive())) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: WEB,
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 300));
}

const chrome = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean)
  .find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`));

// --- editor: make a map and hand it to the game the way "play this map" does -------------
await page.goto(`http://127.0.0.1:${PORT}/editor.html?seed=${SEED}`, { waitUntil: 'load', timeout: BOOT_MS });
try {
  await page.waitForFunction('window.rfReady === true', null, { timeout: BOOT_MS, polling: 500 });
} catch {
  console.log('FATAL: editor did not boot');
  process.exit(3);
}

const edited = await page.evaluate(() => {
  const app = window.rfEditor;
  const sim = app.sim;
  // Light edits: move team 0's base, lay a road, drop a couple of walls.
  const [bx, bz] = sim.baseAt(0);
  sim.moveBase(0, bx + 60, bz - 40, 0);
  sim.beginStroke('road');
  sim.roadStroke([bx, bz, bx + 120, bz], 4, 2, false);
  sim.endStroke();
  const wall = sim.catalog.find((c) => c.name === 'wall').kind;
  sim.place(wall, 0, bx + 150, bz, 0, true);
  sim.place(wall, 0, bx + 160, bz, 0, true);
  const bytes = sim.toBytes();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  localStorage.setItem('rf.editor.play', btoa(s));
  return { bytes: bytes.length, baseAt: sim.baseAt(0), base1: sim.baseAt(1) };
});
console.log(`edited map stored: ${edited.bytes} bytes, bases at [${edited.baseAt}] / [${edited.base1}]`);

// --- game: boot on the stored map and play ----------------------------------------------
await page.goto(`http://127.0.0.1:${PORT}/index.html?auto=1&vehicle=1&maxframes=2`, {
  waitUntil: 'domcontentloaded',
  timeout: BOOT_MS,
});
try {
  await page.waitForFunction('typeof window.rfCapture === "function"', null, { timeout: BOOT_MS, polling: 500 });
} catch {
  console.log('FATAL: game did not boot');
  process.exit(3);
}

const result = await page.evaluate((minutes) => {
  const g = window.rfGame;
  const sim = g.sim;
  const dt = 1 / 60;
  const KINDS = [1, 2, 3, 4];
  const failures = [];

  const playerVeh = () => {
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if (v.buildT >= 1 && v.state === 1) return v;
    }
    return null;
  };

  const cpuField = () => {
    let n = 0;
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if (v.state === 1 && v.team === 1 && v.buildT === 0 && [1, 2, 3, 4].includes(v.kind)) n++;
    }
    return n;
  };

  // Steer at the enemy flag like a player pushing for it.
  const inpFor = (pv) => {
    if (!pv) return { throttle: 0, steer: 0, aim: 0, aimPitch: 0, hasAim: false, fire0: false, fire1: false, fire1Edge: false, brake: false, ascend: false, strafe: 0 };
    const f = sim.flags[1];
    const bearing = Math.atan2(f.x - pv.x, f.z - pv.z);
    let err = bearing - pv.yaw;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    return {
      throttle: 1,
      steer: Math.max(-1, Math.min(1, err * 2.5)),
      aim: bearing,
      aimPitch: 0.02,
      hasAim: Number.isFinite(bearing),
      fire0: true,
      fire1: false,
      fire1Edge: false,
      brake: false,
      ascend: false,
      strafe: 0,
    };
  };

  const dump = () => {
    const out = [];
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if (v.state === 2 && v.hp <= 0) continue;
      out.push(`#${v.id} k${v.kind} t${v.team} p${v.buildT} st${v.state} @${Math.round(v.x)},${Math.round(v.z)}`);
    }
    return {
      time: sim.time,
      state: sim.matchState,
      vehicles: out.join(' | '),
      hud0: sim.teamHud[0],
      spawnPos: `(${sim.map ? 'n/a' : ''})`,
    };
  };

  const totalTicks = Math.round(minutes * 60 * 60);
  let kindIdx = 1;
  let nextSwapAt = 90;
  let lastId = -1;
  let pendingSince = -1;
  let cpuEmptySince = -1;
  const transitions = [];
  let prevState = sim.matchState;

  for (let tick = 0; tick < totalTicks; tick++) {
    const t = tick * dt;
    sim.update(dt, [inpFor(playerVeh()), inpFor(null)]);

    const pv = playerVeh();
    if (pv && pv.id !== lastId) {
      if (lastId >= 0) pendingSince = -1;
      lastId = pv.id;
    }

    const dead = !pv;
    if (t >= nextSwapAt || (dead && pendingSince < 0)) {
      const kind = KINDS[kindIdx % 4];
      kindIdx++;
      sim.requestVehicle(0, kind);
      pendingSince = t;
      nextSwapAt = t + 90;
    }

    if (pendingSince >= 0 && t - pendingSince > 60) {
      failures.push({ at: t, kind: 'player-request-stall', since: pendingSince, dump: dump() });
      pendingSince = -1;
    }

    const playing = sim.matchState === 0;
    if (playing && cpuField() === 0) {
      if (cpuEmptySince < 0) cpuEmptySince = t;
      else if (t - cpuEmptySince > 90) {
        failures.push({ at: t, kind: 'cpu-field-stall', since: cpuEmptySince, dump: dump() });
        cpuEmptySince = -1;
      }
    } else {
      cpuEmptySince = -1;
    }

    if (sim.matchState !== prevState) {
      transitions.push(`${t.toFixed(0)}s ${prevState}->${sim.matchState}`);
      prevState = sim.matchState;
    }

    if (failures.length >= 3) break;
  }
  return { failures, final: dump(), transitions };
}, MINUTES);

if (problems.length) console.log('page errors:\n' + problems.join('\n'));
console.log(`state transitions (${result.transitions.length}): ${result.transitions.slice(0, 20).join('; ')}${result.transitions.length > 20 ? ' ...' : ''}`);
console.log(`final state: t=${result.final.time.toFixed(0)}s matchState=${result.final.state}`);
const h = result.final.hud0;
console.log(`teamHud[0]: ready=(${h.readyJeep},${h.readyTank},${h.readyHrsv},${h.readyHeli}) build=(${h.buildJeep.toFixed(1)},${h.buildTank.toFixed(1)},${h.buildHrsv.toFixed(1)},${h.buildHeli.toFixed(1)})`);
console.log(`vehicles: ${result.final.vehicles}`);

if (result.failures.length) {
  console.log(`\n*** REPRODUCED: ${result.failures.length} stall(s) ***`);
  for (const f of result.failures) {
    console.log(`\n[${f.kind}] at t=${f.at.toFixed(0)}s (since t=${f.since.toFixed(0)}s)`);
    const d = f.dump;
    console.log(`  sim time=${d.time.toFixed(1)} matchState=${d.state}`);
    console.log(`  teamHud[0]: ready=(${d.hud0.readyJeep},${d.hud0.readyTank},${d.hud0.readyHrsv},${d.hud0.readyHeli}) build=(${d.hud0.buildJeep.toFixed(1)},${d.hud0.buildTank.toFixed(1)},${d.hud0.buildHrsv.toFixed(1)},${d.hud0.buildHeli.toFixed(1)})`);
    console.log(`  vehicles: ${d.vehicles}`);
  }
  process.exitCode = 1;
} else {
  console.log(`clean over ${MINUTES} min of play on the edited map (seed ${SEED})`);
}

await browser.close();
if (server) server.kill();
