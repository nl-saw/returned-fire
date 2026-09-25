#!/usr/bin/env node
/**
 * Terrain refresh cost, per battlefield size.
 *
 *   node tools/terrain-cost.mjs [--sizes small,medium,big] [--dabs 12] [--port 5178]
 *
 * A brush stroke rebuilds three things and no more: `EditorSim`'s wasm ops (the Rust edit), the
 * nav grid (rasterised on stroke close), and the renderer's in-place update — `Terrain.updateFromMap`
 * re-walking the positions, normals and vertex colours, plus `GroundMaterial.updateMasks` copying
 * the ground textures. The first two are bounded by the brush's own rectangle; the renderer's is
 * the one that touches every vertex of the map, so it is the one that scales with `?size=`.
 *
 * This measures each part separately, in a real browser, on the real code path — the editor page
 * driven through `window.rfEditor`, the same calls the toolbar makes. It reports wall-clock
 * milliseconds per dab, the renderer's share of it, and the vertex count it had to walk.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
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

const PORT = Number(flag('port', 5178));
const SIZES = String(flag('sizes', 'small,medium,big')).split(',').map((s) => s.trim());
const DABS = Number(flag('dabs', 12));

const portAlive = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(700) });
    return r.status < 500;
  } catch {
    return false;
  }
};

let server = null;
if (!(await portAlive())) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: WEB,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  for (let i = 0; i < 60 && !(await portAlive()); i++) await sleep(300);
}
if (!(await portAlive())) {
  console.error('vite did not start');
  process.exit(1);
}

const chrome = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!chrome) {
  console.error('no chromium found; set CHROME_PATH');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
const stop = () => {
  if (server && !server.killed) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
};

const out = [];
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(`http://127.0.0.1:${PORT}/editor.html?size=${size}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.rfEditor !== undefined, null, { timeout: 120000 });
  await sleep(1500);

  const r = await page.evaluate(async (dabs) => {
    const app = window.rfEditor;
    const sim = app.sim;
    const grid = sim.map.grid;
    const verts = (grid + 1) * (grid + 1);
    // Paint along a diagonal through the middle, one dab at a time, timing each layer.
    const c = sim.map.worldSize * 0.5;
    const step = (sim.map.worldSize * 0.35) / Math.max(dabs, 1);
    const wasm = [];
    const refresh = [];
    let worst = 0;
    const bridge = [];
    const whole = [];
    const rect = [];
    for (let i = 0; i < dabs; i++) {
      const x = c + i * step * 0.5;
      const z = c + i * step;
      const t0 = performance.now();
      app.dab(x, z, true, false);
      const t1 = performance.now();
      // The bridge re-reading the map: pointers, live views, and the mask copies.
      sim.refresh();
      const t2 = performance.now();
      // The whole-map refresh the editor used to do after every dab...
      app.terrain.updateFromMap(sim.map);
      const t3 = performance.now();
      // ...and the region-local one it does now, over the brush's own rectangle.
      const r = app.brushRect(x, z);
      app.terrain.updateFromMap(sim.map, r);
      const t4 = performance.now();
      wasm.push(t1 - t0);
      bridge.push(t2 - t1);
      whole.push(t3 - t2);
      rect.push(t4 - t3);
      refresh.push(t4 - t1);
      worst = Math.max(worst, t4 - t1);
    }
    app.endStroke(false);
    // Correctness: a region update has to leave the mesh exactly as a full one would. Refresh the
    // whole map, snapshot, dab, update by region, and compare every buffer byte for byte.
    app.dab(c - step, c - step, true, false);
    app.terrain.updateFromMap(sim.map);
    const snap = () => {
      const g = app.terrain.group.getObjectByProperty('type', 'Mesh');
      const geo = (g ?? app.terrain.group.children[0]).geometry;
      const grab = (name) => Array.from(geo.getAttribute(name).array);
      return {
        position: grab('position'),
        normal: grab('normal'),
        color: grab('color'),
      };
    };
    const before = snap();
    app.dab(c + step * 0.5, c + step * 0.5, true, false);
    app.terrain.updateFromMap(sim.map, app.brushRect(c + step * 0.5, c + step * 0.5));
    const byRegion = snap();
    app.terrain.updateFromMap(sim.map);
    const byWhole = snap();
    const cmp = (a, b) => {
      if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
      let worst = 0;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      return worst;
    };
    const diff = {
      position: cmp(byRegion.position, byWhole.position),
      normal: cmp(byRegion.normal, byWhole.normal),
      color: cmp(byRegion.color, byWhole.color),
      changedSomething: cmp(before.position, byWhole.position) > 0,
    };
    const avg = (a) => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
    return {
      size: sim.sizeIndex(),
      grid,
      verts,
      worldSize: sim.map.worldSize,
      wasmMs: avg(wasm),
      bridgeMs: avg(bridge),
      wholeMeshMs: avg(whole),
      rectMeshMs: avg(rect),
      refreshMs: avg(refresh),
      worstRefreshMs: worst,
      regionMatchesWhole: diff,
    };
  }, DABS);

  out.push({ requested: size, ...r, errors });
  await page.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
stop();
