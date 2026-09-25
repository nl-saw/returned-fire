#!/usr/bin/env node
/**
 * Deterministic repro for "the terrain brushes do nothing visible over water": boot the editor,
 * find an open-water point, and read the *rendered* pixels above it (camera forced straight down,
 * synchronous render + readPixels — no camera drift, no screenshot confounds). `?water=flat`
 * paints the surface magenta (G channel ~0); raised land has G well above 50. Then raise the
 * point with the same stroke the toolbar makes and read again: if the GPU mesh did not receive
 * the edit, the pixels stay water.
 *
 *   node tools/editor-water-probe.mjs [--seed 7] [--port 5198]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(ROOT, 'web');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SEED = Number(flag('seed', 7));
const PORT = Number(flag('port', 5198));

const server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: WEB,
  stdio: 'ignore',
});
process.on('exit', () => {
  try {
    server.kill('SIGKILL');
  } catch {
    /* gone */
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/editor.html`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(500);
}

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/editor.html?seed=${SEED}&water=flat`, { waitUntil: 'load' });
await page.waitForFunction(() => window.rfReady === true, null, { timeout: 120000 });

// Wait until the WebGL scene has actually produced a frame (swiftshader's first compile is slow;
// a black canvas would make every pixel readback meaningless).
const px = await page.evaluate(async () => {
  const app = window.rfEditor;
  const m = app.sim.map;
  const verts = m.grid + 1;
  const vh = (ix, iz) => m.heights[iz * verts + ix];

  // Find an open-water point (below the waterline, with water beside it), away from the map
  // edges so a full brush fits on the map.
  const cx = m.worldSize / 2;
  const cz = m.worldSize / 2;
  let found = null;
  outer: for (let iz = 8; iz < m.grid - 8; iz += 2) {
    for (let ix = 8; ix < m.grid - 8; ix += 2) {
      const h0 = vh(ix, iz);
      if (h0 > m.waterLevel - 1.0) continue;
      if (vh(Math.min(m.grid, ix + 8), iz) > m.waterLevel - 1.0) continue; // want open water
      const x = ix * m.cell;
      const z = iz * m.cell;
      if (Math.hypot(x - cx, z - cz) < 60) continue; // clear of the centre for camera focus
      found = { x, z, h0 };
      break outer;
    }
  }
  if (!found) return { error: 'no open water found' };

  const canvas = app.gs.renderer.domElement;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return { error: 'no webgl context' };

  /** Render with the camera forced straight down on (x, z) and read the centre pixels. */
  const sample = (x, z) => {
    const cam = app.gs.camera;
    const pos = cam.position.clone();
    const quat = cam.quaternion.clone();
    const up = cam.up.clone();
    cam.up.set(0, 0, -1); // straight-down lookAt is degenerate with the default up
    cam.position.set(x, 260, z);
    cam.lookAt(x, 0, z);
    app.gs.render();
    const S = 32;
    const buf = new Uint8Array(S * S * 4);
    gl.readPixels(
      Math.floor(canvas.width / 2 - S / 2),
      Math.floor(canvas.height / 2 - S / 2),
      S,
      S,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      buf,
    );
    cam.position.copy(pos);
    cam.quaternion.copy(quat);
    cam.up.copy(up);
    // Classify every pixel: flat-debug water is magenta (high R+B, low G); land has green well
    // above that. Reporting the split makes a half-uploaded mesh impossible to average away.
    let water = 0;
    let land = 0;
    let other = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      if (g > 80 && r < 220) land++;
      else if (r > 150 && b > 150 && g < 90) water++;
      else other++;
    }
    return { water, land, other };
  };

  // Settle: let the frame loop run and the first real frames land.
  await new Promise((res) => setTimeout(res, 4000));
  const before = sample(found.x, found.z);

  // The raise stroke the toolbar makes, through the real UI path: `dab()` is what a mouse-down
  // calls — it writes the wasm height AND marks the dirty rect that drives the mesh upload.
  app.tool = 'raise';
  app.brush.radius = 30;
  app.brush.strength = 1;
  app.brush.hard = 0.4;
  const sim = app.sim;
  sim.beginStroke('water raise');
  for (let dz = -60; dz <= 60; dz += 20) {
    for (let dx = -60; dx <= 60; dx += 20) {
      app.dab(found.x + dx, found.z + dz, true, false);
    }
  }
  sim.endStroke();
  await new Promise((res) => setTimeout(res, 1500)); // let frames run the dirty-rect upload

  const after = sample(found.x, found.z);
  const dataH = vh(Math.round(found.x / m.cell), Math.round(found.z / m.cell));

  // Undo through the real button: it takes the *full* pass (dirtyFull), so this also proves the
  // full-range upload — the patch must render as water again. The button's disabled state only
  // syncs through `syncUi`, which this probe bypasses, so re-enable it by hand.
  const undoBtn = document.getElementById('undo');
  undoBtn.disabled = false;
  undoBtn.click();
  await new Promise((res) => setTimeout(res, 1500));

  const afterUndo = sample(found.x, found.z);
  const dataAfterUndo = vh(Math.round(found.x / m.cell), Math.round(found.z / m.cell));
  return {
    point: { x: Math.round(found.x), z: Math.round(found.z), h0: +found.h0.toFixed(2) },
    waterLevel: m.waterLevel,
    dataAfter: +dataH.toFixed(2),
    dataAfterUndo: +dataAfterUndo.toFixed(2),
    before, // rendered pixels above the patch, pre-stroke
    after, // rendered pixels above the patch, post-stroke (rect upload)
    afterUndo, // rendered pixels after undo (full upload)
  };
});

if (px.error) {
  console.error(px.error);
  process.exit(1);
}
mkdirSync(resolve(ROOT, 'shots'), { recursive: true });
await page.screenshot({ path: resolve(ROOT, 'shots/editor-water-after.png') });

const total = 32 * 32;
const waterBefore = px.before.water > total * 0.5;
const landAfter = px.after.land > total * 0.5;
const waterAfterUndo = px.afterUndo.water > total * 0.5;
console.log(JSON.stringify(px, null, 2));
for (const e of errors) console.error('pageerror:', e);
const ok = waterBefore && px.dataAfter > px.point.h0 + 1 && landAfter && waterAfterUndo;
console.log(
  ok
    ? 'PASS: raise renders as land (rect upload), undo restores water (full upload)'
    : `FAIL: before=${JSON.stringify(px.before)} after=${JSON.stringify(px.after)} afterUndo=${JSON.stringify(px.afterUndo)}`,
);
await browser.close();
process.exit(ok ? 0 : 3);
