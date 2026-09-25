#!/usr/bin/env node
/**
 * Regression harness: a destroyed helicopter's rotors must stop spinning at the kill frame.
 *
 *   node tools/rotor-freeze.mjs
 *
 * Boots the page headless in two-player sandbox mode (?auto=1&two=1&vehicle=4&vehicle2=4&sandbox=1):
 * both players get a helicopter from the pre-parked garage hulls, and the practice range runs
 * no AI at all — so neither hull is ever shot down by the simulation itself. The script then
 * drives frames directly: `?maxframes=2` parks the rAF loop after boot, so it owns every
 * subsequent frame. It measures the main-rotor angle of one live helicopter over one second of
 * renderer time (must advance ~26 rad), kills that hull through the real wasm kill path
 * (`Game::debug_kill_vehicle`, no memory faking), and measures again (must be frozen, delta
 * exactly 0). The other live helicopter must keep spinning as a control. Exits 0 on PASS, 1 on FAIL.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');
const PORT = Number(process.env.ROTOR_PORT ?? 5182);
const BOOT_MS = 240_000;

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
  `http://127.0.0.1:${PORT}/index.html?auto=1&two=1&vehicle=4&vehicle2=4&seed=1337&map=0&sandbox=1&maxframes=2`,
  { waitUntil: 'load', timeout: 60_000 },
);
try {
  await page.waitForFunction('typeof window.rfCapture === "function"', null, { timeout: BOOT_MS, polling: 500 });
} catch {
  console.log('FATAL: boot did not finish');
  process.exit(3);
}

const result = await page.evaluate(() => {
  const g = window.rfGame;
  const sim = g.sim;
  const game = sim.game;
  const dt = 1 / 60;
  const inp = { throttle: 0, steer: 0, aim: 0, aimPitch: 0, hasAim: false, fire0: false, fire1: false, fire1Edge: false, brake: false, ascend: false, strafe: 0 };

  // One real frame: sim tick + renderer sync. The rAF loop is parked (?maxframes=2), so these
  // manual steps are the only thing moving the world — measurements are deterministic.
  function stepWorld(sec) {
    for (let i = 0; i < Math.round(sec * 60); i++) {
      g.time += dt;
      sim.update(dt, [inp, inp]);
      g.world.update(dt, sim, g.time);
    }
  }

  // All ACTIVE helicopters (kind 4) by slot index.
  const findHelis = () => {
    const out = [];
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if (v.kind === 4 && v.state === 1) out.push(i);
    }
    return out;
  };

  // Main-rotor Y angle of the rig whose root carries this vehicle id, or null if not in scene.
  const rotorMain = (id) => {
    let root = null;
    g.gs.scene.traverse((o) => {
      if (o.userData && o.userData.vehicleId === id && !root) root = o;
    });
    let main = null;
    if (root) root.traverse((o) => { if (o.name === 'rotorMain') main = o.rotation.y; });
    return main;
  };

  // Both players' helicopters spawn from pre-parked garage hulls on the first tick, so this
  // should resolve within a second; the loop is just a safety net.
  let helis = findHelis();
  for (let t = 0; helis.length < 2 && t < 120; t++) { stepWorld(1); helis = findHelis(); }
  if (helis.length < 2) return { error: `expected 2 active helicopters, found ${helis.length}` };
  const i = helis[0];
  const id = sim.vehicles[i].id;

  // 1) Alive baseline: the rotor must be spinning (~26 rad/s for a heli main rotor).
  stepWorld(1);
  const a0 = rotorMain(id);
  stepWorld(1);
  const a1 = rotorMain(id);
  if (a0 === null) return { error: 'heli rig not present in scene', id };
  const aliveDelta = Math.abs(a1 - a0) % (2 * Math.PI);

  // 2) Real kill through the wasm seam, then let the wreck settle and decode.
  game.debug_kill_vehicle(i);
  stepWorld(2);
  if (sim.vehicles[i].state !== 2) return { error: 'kill did not produce WRECK state', got: sim.vehicles[i].state };

  // 3) Wrecked: the rotor must be frozen — delta exactly 0 over one second.
  stepWorld(1);
  const b0 = rotorMain(id);
  stepWorld(1);
  const b1 = rotorMain(id);
  if (b0 === null || b1 === null) return { error: 'wreck rig disappeared from scene', id };
  const wreckDelta = Math.abs(b1 - b0);

  // 4) Control: the other live helicopter keeps spinning.
  const j = helis.find((k) => k !== i);
  const cid = sim.vehicles[j].id;
  stepWorld(1);
  const c0 = rotorMain(cid);
  stepWorld(1);
  const c1 = rotorMain(cid);
  return { aliveDelta, wreckDelta, controlDelta: Math.abs(c1 - c0) % (2 * Math.PI), killedId: id, controlId: cid };
});

await browser.close();
if (server?.pid) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
}

console.log(JSON.stringify(result, null, 2));
if (problems.length) { console.log('--- page problems ---'); for (const p of problems.slice(0, 10)) console.log(p); }
if (!result || result.error) { console.log(`FAIL: ${result?.error}`); process.exit(1); }
const okAlive = result.aliveDelta > 0.5; // mod 2π: clearly non-zero
const okWreck = result.wreckDelta === 0;
const okControl = result.controlId === null || result.controlDelta > 0.5;
if (okAlive && okWreck && okControl) {
  console.log('PASS: live rotor spins, wrecked rotor frozen' + (result.controlId !== null ? ', control rotor still spinning' : ''));
  process.exit(0);
}
console.log(`FAIL: alive=${result.aliveDelta.toFixed(3)} wreck=${result.wreckDelta.toFixed(3)} control=${result.controlDelta?.toFixed(3)}`);
process.exit(1);
