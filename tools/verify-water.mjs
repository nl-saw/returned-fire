#!/usr/bin/env node
/**
 * Water-edit verification: drives the editor's real raise/lower strokes on water through the
 * wasm bridge and checks that heights actually move (and that the render rebuilds).
 *
 *   node tools/verify-water.mjs [--port 5179]
 *
 * Exits non-zero if any check fails. Prints before/after heights for each stroke.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');
const pi = process.argv.indexOf('--port');
const PORT = pi >= 0 ? Number(process.argv[pi + 1]) : 5179;

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
  while (!(await portAlive(PORT)) && Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await portAlive(PORT))) {
    console.error('vite did not start:\n' + log);
    process.exit(1);
  }
}

const chrome = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p));
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
    '--force-device-scale-factor=1',
  ],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && problems.push('console: ' + m.text()));

await page.goto(`http://127.0.0.1:${PORT}/editor.html?seed=3&map=0`, { waitUntil: 'load' });
await page.waitForFunction('window.rfReady === true', null, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500)); // let the first frame + terrain bake land

// Everything below runs in the page against the live EditorSim (TS `private` is not real).
const result = await page.evaluate(async () => {
  const app = window.rfEditor;
  const sim = app['sim'];
  const m = sim.map;
  const n = m.grid + 1;
  const cell = m.cell;
  const water = m.waterLevel;
  const H = () => sim.map.heights; // live getter: re-derives after wasm growth

  const at = (ix, iz) => H()[iz * n + ix];
  const idxOf = (x, z) => [Math.round(x / cell), Math.round(z / cell)];

  // Find a deep-water vertex near the map centre (away from bases on the edges).
  let wx = -1, wz = -1, wh = 0;
  for (let iz = 4; iz < n - 4; iz++) {
    for (let ix = 4; ix < n - 4; ix++) {
      const h = at(ix, iz);
      if (h < water - 1.2 && h < wh) {
        wh = h; wx = ix * cell; wz = iz * cell;
      }
    }
  }
  if (wx < 0) return { fail: 'no deep water found' };

  // Find a land vertex near the centre too, for the lower test.
  let lx = -1, lz = -1, lh = -1e9;
  for (let iz = 4; iz < n - 4; iz++) {
    for (let ix = 4; ix < n - 4; ix++) {
      const h = at(ix, iz);
      if (h > water + 0.8 && h > lh) {
        lh = h; lx = ix * cell; lz = iz * cell;
      }
    }
  }
  if (lx < 0) return { fail: 'no land found' };

  const stroke = (label, fn) => {
    sim.beginStroke(label);
    for (let i = 0; i < 8; i++) fn(); // a dab per frame, like holding the mouse down
    sim.endStroke();
    app['dirty'] = true; // what EditorApp.endStroke does after sim.endStroke()
  };

  const out = { water: {}, lower: {} };

  // RAISE on water: the floor climbs toward/above the waterline (water "removed").
  let [ix, iz] = idxOf(wx, wz);
  out.water.before = at(ix, iz);
  stroke('raise', () => sim.raise(wx, wz, 10, 0.6 + 0.8 * 4, 0.4));
  [ix, iz] = idxOf(wx, wz);
  out.water.after = at(ix, iz);

  // LOWER on land: the ground drops below the waterline (water appears).
  [ix, iz] = idxOf(lx, lz);
  out.lower.before = at(ix, iz);
  stroke('lower', () => sim.raise(lx, lz, 10, -(0.6 + 0.8 * 4), 0.4));
  [ix, iz] = idxOf(lx, lz);
  out.lower.after = at(ix, iz);

  // Frame the camera on the raised-water spot for the screenshot.
  app['focus'].set(wx, water, wz);
  app['rig'].zoomBy(-2); // closer than the default map-scale framing
  return { ...out, wx, wz, lx, lz, waterLevel: water, revision: sim.revision };
});

if (result.fail) {
  console.error('FAIL:', result.fail);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 2500)); // render the rebuilt terrain
mkdirSync(resolve(ROOT, 'shots'), { recursive: true });
await page.screenshot({ path: resolve(ROOT, 'shots/verify-water-edit.png') });

const checks = [
  ['raise lifted the water floor', result.water.after > result.water.before + 1.0],
  ['lower dropped land below waterline', result.lower.after < result.lower.before - 1.0 && result.lower.after < result.waterLevel],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
}
console.log(`  water floor @ (${result.wx.toFixed(1)},${result.wz.toFixed(1)}): ${result.water.before.toFixed(2)} -> ${result.water.after.toFixed(2)} (waterline ${result.waterLevel.toFixed(2)})`);
console.log(`  land       @ (${result.lx.toFixed(1)},${result.lz.toFixed(1)}): ${result.lower.before.toFixed(2)} -> ${result.lower.after.toFixed(2)}`);
if (problems.length) {
  console.log('--- page problems ---');
  for (const p of [...new Set(problems)]) console.log('[error]', p);
}
console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED');
await browser.close();
if (server) {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
}
process.exit(ok ? 0 : 1);
