#!/usr/bin/env node
/**
 * End-to-end check that the player can shoot at an AIRBORNE unit.
 *
 * Drives the real mouse onto a live enemy aircraft's projected screen position (taken from
 * `rfProbe().airTargets`) and holds the trigger, so it exercises the whole player path:
 * canvas mousemove -> mouseNdc -> `pickAirTarget` -> InputFrame.aim/aimPitch -> rf-core's
 * intercept solution -> the swept projectile test. Prints the picked aircraft id, the aim
 * elevation (positive = laid up at the aircraft) and the target's hit points before/after.
 *
 *   node tools/aircheck.mjs [--q "index.html?auto=1&map=0&seed=7&warmup=30&zoom=3&capture=1"]
 *                           [--port 5195] [--steps 120] [--out shots/aircheck.png]
 *
 * `?auto=1` plus a warm-up of ~30 s is the cheapest setup that puts an enemy recon drone in
 * the air: the AI sends drones after a player who sits still for 14 s. Exits 3 if no aircraft
 * is on screen. The drone flies at 22 m/s, so the cursor has to be re-aimed as it moves —
 * a single stale mouse position misses by ~1.5 m at 170 m.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// playwright-core is installed under web/, so resolve it from there (same as tools/capture.mjs).
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'package.json'));
const { chromium } = require('playwright-core');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const q = flag('q', 'index.html?auto=1&map=0&seed=7&warmup=180&zoom=3&capture=1');
const PORT = Number(flag('port', 5195));
// Sim steps of firing to run (6 per iteration): 120 iterations = 12 s of sim time.
const STEPS = Number(flag('steps', 120));
const OUT = flag('out', '');
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const alive = async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(700) }); return r.status < 500; } catch { return false; } };
let server = null;
if (!(await alive())) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: WEB, stdio: 'ignore', detached: true });
  for (let i = 0; i < 100 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 300));
}

const chrome = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`[error] ${m.text().slice(0, 300)}`); });

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/${q.replace(/^\/+/, '')}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('typeof window.rfCapture === "function"', null, { timeout: 300000, polling: 500 });
// A fresh Vite server re-optimises deps and full-reloads once, which destroys the execution
// context mid-evaluate; retry until the page has settled.
const evalRetry = async (expr, tries = 12) => {
  for (let i = 0; i < tries; i++) {
    try { return await page.evaluate(expr); } catch { await page.waitForTimeout(2000); await page.waitForFunction('typeof window.rfProbe === "function"', null, { timeout: 120000, polling: 500 }).catch(() => {}); }
  }
  throw new Error(`evaluate failed: ${expr}`);
};
await page.waitForTimeout(3000);
await page.waitForFunction('typeof window.rfProbe === "function"', null, { timeout: 180000, polling: 500 });
const boot = await evalRetry('window.rfProbe()');
const rect = await evalRetry('(() => { const c = document.querySelector("canvas"); const r = c.getBoundingClientRect(); return { w: r.width, h: r.height, x: r.left, y: r.top }; })()');

const air = (boot.airTargets ?? []).filter((t) => t.hp > 0 && Math.abs(t.ndc[0]) < 0.97 && Math.abs(t.ndc[1]) < 0.97);
console.log('boot:', JSON.stringify({ vehicles: boot.vehicles, player: boot.vehicleKind, airTargets: boot.airTargets, rect }));
if (air.length === 0) {
  console.log(`NO-ONSCREEN-AIRCRAFT after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (OUT) { const d = await page.evaluate('window.rfCapture()'); writeFileSync(OUT, Buffer.from(d.split(',')[1], 'base64')); }
  await browser.close(); if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); } }
  process.exit(3);
}
const pick = air.sort((a, b) => (a.ndc[0] ** 2 + a.ndc[1] ** 2) - (b.ndc[0] ** 2 + b.ndc[1] ** 2))[0];
console.log(`tracking aircraft #${pick.id} team${pick.team} hp${pick.hp} startNdc=${pick.ndc}`);

// Track it like a player does: a drone flies at 22 m/s, so a cursor position computed from a
// stale probe lands ~1.5 m off at 170 m. Re-read its screen position and re-aim each iteration.
const aimAt = async (id, settle = 0) => {
  const p = await evalRetry('window.rfProbe()');
  const t = (p.airTargets ?? []).find((x) => x.id === id);
  if (t && Math.abs(t.ndc[0]) < 0.98 && Math.abs(t.ndc[1]) < 0.98) {
    await page.mouse.move(rect.x + ((t.ndc[0] + 1) / 2) * rect.w, rect.y + ((1 - t.ndc[1]) / 2) * rect.h);
  }
  if (settle > 0) await page.waitForTimeout(settle);
  return evalRetry('window.rfProbe()');
};
let aimed = null;
for (let i = 0; i < 10; i++) {
  aimed = await aimAt(pick.id);
  if (!(aimed.airTargets ?? []).some((t) => t.id === pick.id)) break;
  if (aimed.airPick === pick.id) break;
}
console.log('after tracking:', JSON.stringify({ airPick: aimed.airPick, aimPitch: aimed.aimPitch, want: pick.id, playerTeam: aimed.playerTeam, mouseNdc: aimed.mouseNdc }));

// Fixed 1/60 s steps, not wall-clock: SwiftShader renders this scene at ~1 fps, so waiting on
// real time advances the simulation by almost nothing and a round's flight time never elapses.
// Re-aim every 6 steps (0.1 s): the drone covers 2.2 m in that time, inside the pick volume.
await page.mouse.down();
let hp = pick.hp;
for (let i = 0; i < STEPS && hp > 0; i++) {
  await aimAt(pick.id, 0);
  await page.evaluate('window.rfStep(6)');
  if (i % 10 === 0) {
    const p = await evalRetry('window.rfProbe()');
    const t = (p.airTargets ?? []).find((x) => x.id === pick.id);
    hp = t ? t.hp : 0;
  }
}
await page.mouse.up();
const after = await evalRetry('window.rfProbe()');
const tgt = (after.airTargets ?? []).find((t) => t.id === pick.id);
console.log('after firing:', JSON.stringify({ airPick: after.airPick, aimPitch: after.aimPitch, hpBefore: pick.hp, hpAfter: tgt ? tgt.hp : 0, target: tgt ?? 'gone (killed)' }));
if (OUT) { const d = await page.evaluate('window.rfCapture()'); writeFileSync(OUT, Buffer.from(d.split(',')[1], 'base64')); console.log('shot:', OUT); }
await browser.close();
if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); } }
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (problems.length) { console.log('--- page problems ---'); for (const p of problems.slice(0, 10)) console.log(p); }
