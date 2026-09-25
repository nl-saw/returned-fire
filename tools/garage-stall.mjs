#!/usr/bin/env node
/**
 * Repro harness: "after some play, vehicles no longer spawn" (player and CPU), garage cards
 * unselectable, only the heli still deploys.
 *
 *   node tools/garage-stall.mjs [minutes] [seed] [map]
 *
 * Boots the real page (?auto=1&demo&maxframes=2 parks the rAF loop) and then drives the
 * simulation manually through the exact public path the frame loop uses: `sim.update(dt,
 * inputs)` with demo-autopilot player input. The "human" re-picks a vehicle from the garage
 * on a timer and immediately after every death — `sim.requestVehicle(0, kind)`, cycling
 * jeep/tank/hrsv/heli — exactly like clicking a card. Two failure modes are watched:
 *   (a) a player request unfulfilled 60 s after it was made (no new hull), and
 *   (b) the CPU field (team 1, garage kinds) empty for 90 s while the round is live.
 * Exits 0 clean, 1 on a stall (with a full state dump).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');
const PORT = Number(process.env.GARAGE_PORT ?? 5183);
const BOOT_MS = 240_000;
const MINUTES = Number(process.argv[2] ?? 30);
const SEED = process.argv[3] ?? '0';
const MAP = process.argv[4] ?? '0';

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
const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`));

await page.goto(
  `http://127.0.0.1:${PORT}/index.html?auto=1&demo&vehicle=1&seed=${SEED}&map=${MAP}&maxframes=2`,
  { waitUntil: 'domcontentloaded', timeout: BOOT_MS },
);
try {
  await page.waitForFunction('typeof window.rfCapture === "function"', null, { timeout: BOOT_MS, polling: 500 });
} catch {
  console.log('FATAL: boot did not finish');
  process.exit(3);
}

const result = await page.evaluate((minutes) => {
  const g = window.rfGame;
  const sim = g.sim;
  const dt = 1 / 60;
  const KINDS = [1, 2, 3, 4]; // jeep tank hrsv heli
  const failures = [];

  // Drive at the enemy flag like a player would push for it, firing on the way. Steer is a
  // sustained correction toward the bearing (the wobble-only input just spun the hull in place).
  const demoInp = (t) => {
    const pv = playerVeh();
    let aim = 0;
    let steer = Math.sin(t * 0.35) * 0.45;
    let hasAim = true;
    if (pv) {
      const f = sim.flags[1]; // enemy flag
      const bearing = Math.atan2(f.x - pv.x, f.z - pv.z);
      aim = bearing;
      hasAim = Number.isFinite(bearing);
      let err = bearing - pv.yaw;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      steer = Math.max(-1, Math.min(1, err * 2.5));
    }
    return {
      throttle: 1,
      steer,
      aim,
      aimPitch: 0.02,
      hasAim,
      fire0: Math.sin(t * 1.9) > 0.55,
      fire1: Math.sin(t * 0.7) > 0.97,
      fire1Edge: false,
      brake: false,
      ascend: false,
      strafe: 0,
    };
  };

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
      // The team HUD is what the garage cards read.
      hud0: sim.teamHud[0],
    };
  };

  const totalTicks = Math.round(minutes * 60 * 60); // one iteration = one 60 Hz tick
  let kindIdx = 1;
  let nextSwapAt = 90;
  let lastId = -1;
  let pendingSince = -1;
  let cpuEmptySince = -1;
  const transitions = [];
  let prevState = sim.matchState;

  for (let tick = 0; tick < totalTicks; tick++) {
    const t = tick * dt; // simulation seconds
    const inp = playerVeh() ? demoInp(t) : { throttle: 0, steer: 0, aim: 0, aimPitch: 0, hasAim: false, fire0: false, fire1: false, fire1Edge: false, brake: false, ascend: false, strafe: 0 };
    sim.update(dt, [inp, inp]);

    const pv = playerVeh();
    if (pv && pv.id !== lastId) {
      if (lastId >= 0) pendingSince = -1; // a new hull arrived: request honoured
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
      transitions.push(`${t.toFixed(0)}s ${prevState} -> ${sim.matchState}`);
      prevState = sim.matchState;
    }

    if (failures.length >= 3) break;
  }
  return { failures, final: dump(), transitions };
}, MINUTES);

if (problems.length) console.log('page errors:\n' + problems.join('\n'));
console.log(`state transitions (${result.transitions.length}): ${result.transitions.join('; ') || 'none'}`);
console.log(`final state: t=${result.final.time.toFixed(0)}s matchState=${result.final.state}`);
console.log(`teamHud[0]: ready=(${result.final.hud0.readyJeep},${result.final.hud0.readyTank},${result.final.hud0.readyHrsv},${result.final.hud0.readyHeli}) build=(${result.final.hud0.buildJeep.toFixed(1)},${result.final.hud0.buildTank.toFixed(1)},${result.final.hud0.buildHrsv.toFixed(1)},${result.final.hud0.buildHeli.toFixed(1)})`);
console.log(`vehicles: ${result.final.vehicles}`);

if (result.failures.length) {
  console.log(`\n*** REPRODUCED: ${result.failures.length} stall(s) ***`);
  for (const f of result.failures) {
    console.log(`\n[${f.kind}] at t=${f.at}s (empty since t=${f.since}s)`);
    const d = f.dump;
    console.log(`  sim time=${d.time.toFixed(1)} matchState=${d.state}`);
    console.log(`  teamHud[0]: ready=(${d.hud0.readyJeep},${d.hud0.readyTank},${d.hud0.readyHrsv},${d.hud0.readyHeli}) build=(${d.hud0.buildJeep.toFixed(1)},${d.hud0.buildTank.toFixed(1)},${d.hud0.buildHrsv.toFixed(1)},${d.hud0.buildHeli.toFixed(1)})`);
    console.log(`  vehicles: ${d.vehicles}`);
  }
  process.exitCode = 1;
} else {
  console.log(`clean over ${MINUTES} min of play (seed ${SEED} map ${MAP})`);
}

await browser.close();
if (server) server.kill();
