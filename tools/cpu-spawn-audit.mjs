#!/usr/bin/env node
/**
 * CPU force audit: how fast and in what mix does the enemy commander field hulls?
 *
 *   node tools/cpu-spawn-audit.mjs [minutes] [seed] [map]
 *
 * Boots the real page (?auto=1&demo parks rAF; the demo autopilot gives the CPU real
 * attrition) and drives the sim manually through `sim.update`, exactly like the frame
 * loop. Every tick it scans `sim.vehicles` for team-1 ids never seen before and logs
 * (time, kind). Prints the per-kind mix, the inter-spawn gaps (median/p90/max) and the
 * peak field size - the numbers behind "enemy vehicles spawn too quickly after each
 * other" and "the CPU never spawns MLRS and helis". Port via SPAWN_AUDIT_PORT (5184).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');
const PORT = Number(process.env.SPAWN_AUDIT_PORT ?? 5184);
const BOOT_MS = 240_000;
const MINUTES = Number(process.argv[2] ?? 8);
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
  for (let i = 0; i < 100 && !(await alive()); i++) await new Promise((r) => setTimeout(r), 300);
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
  const total = Math.round(minutes * 60 * 60); // one iteration = one 60 Hz tick
  const KIND_NAME = { 1: 'JEEP', 2: 'TANK', 3: 'MLRS', 4: 'HELI', 5: 'TROOP', 6: 'DRONE', 7: 'SUB' };

  // Same player-one autopilot as tools/garage-stall.mjs: push for the enemy flag and fire,
  // so the CPU takes real attrition and the commander keeps replacing hulls.
  const playerVeh = () => {
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if (v.buildT >= 1 && v.state === 1) return v;
    }
    return null;
  };
  const demoInp = (t) => {
    const pv = playerVeh();
    let aim = 0;
    let steer = Math.sin(t * 0.35) * 0.45;
    let hasAim = true;
    if (pv) {
      const f = sim.flags[1];
      const bearing = Math.atan2(f.x - pv.x, f.z - pv.z);
      aim = bearing;
      hasAim = Number.isFinite(bearing);
      let err = bearing - pv.yaw;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      steer = Math.max(-1, Math.min(1, err * 2.5));
    }
    return {
      throttle: 1, steer, aim, aimPitch: 0.02, hasAim,
      fire0: Math.sin(t * 1.9) > 0.55, fire1: Math.sin(t * 0.7) > 0.97,
      fire1Edge: false, brake: false, ascend: false, strafe: 0,
    };
  };
  const idle = { throttle: 0, steer: 0, aim: 0, aimPitch: 0, hasAim: false, fire0: false, fire1: false, fire1Edge: false, brake: false, ascend: false, strafe: 0 };

  const seen = new Set();
  const events = []; // [t, kind]
  let peak = 0;
  for (let tick = 0; tick < total; tick++) {
    const t = tick * dt;
    const inp = playerVeh() ? demoInp(t) : idle;
    sim.update(dt, [inp, inp]);
    let field1 = 0;
    for (let j = 0; j < sim.vehicleCount; j++) {
      const v = sim.vehicles[j];
      if (v.team !== 1) continue;
      if (!seen.has(v.id)) {
        seen.add(v.id);
        events.push([+t.toFixed(2), v.kind]);
      }
      // The commander's garrison: live, fielded (not in build), garage kinds only.
      if (v.state === 1 && v.buildT === 0 && [1, 2, 3, 4].includes(v.kind)) field1++;
    }
    if (field1 > peak) peak = field1;
  }
  const gaps = [];
  for (let i = 1; i < events.length; i++) gaps.push(events[i][0] - events[i - 1][0]);
  gaps.sort((a, b) => a - b);
  const q = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : 0);
  const mix = {};
  for (const [, k] of events) mix[KIND_NAME[k] ?? k] = (mix[KIND_NAME[k] ?? k] ?? 0) + 1;
  return { minutes, spawns: events.length, mix, peak, gaps: { n: gaps.length, min: q(0), median: q(0.5), p90: q(0.9), max: q(1) }, events };
}, MINUTES);

console.log(`=== CPU spawn audit: ${result.minutes} sim-min (seed ${SEED} map ${MAP})`);
console.log('spawns:', result.spawns, ' peak field:', result.peak);
console.log('mix:', JSON.stringify(result.mix));
const gp = result.gaps;
console.log(`gaps s: min ${gp.min?.toFixed(2)} median ${gp.median?.toFixed(2)} p90 ${gp.p90?.toFixed(2)} max ${gp.max?.toFixed(2)}`);
console.log('timeline (t, kind):');
for (let i = 0; i < result.events.length; i += 8) {
  console.log('  ' + result.events.slice(i, i + 8).map(([t, k]) => `${t}s:${k}`).join('  '));
}
if (problems.length) console.log('PROBLEMS:\n' + problems.join('\n'));
await browser.close();
if (server) server.unref();
