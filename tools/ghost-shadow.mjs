#!/usr/bin/env node
/**
 * Ghost-shadow detector: ground shaded by destroyed structures that are not drawn.
 *
 *   node tools/ghost-shadow.mjs [--port 5194] [--seed 11] [--map 0] [--height 150]
 *
 * Raze one half of the map through the real damage path, then look at it from the kind of high,
 * tilted, zoomed-out pose the report describes, and take four frames of that *same* frozen view:
 *
 *   N  ruins drawn,  shadows on      R  ruins hidden, shadows on
 *   S  ruins drawn,  shadows off     SR ruins hidden, shadows off
 *
 * With the shadow map off there is nothing left for a hidden caster to affect, so `S - SR` is
 * exactly the pixels the ruined models *draw*. `N - R` is everything they do - pixels drawn plus
 * ground shaded. Any pixel that changes in `N - R` but not in `S - SR` is therefore being shaded
 * by a destroyed structure that is nowhere on screen: the reported ghost.
 *
 * The four frames are taken inside one page call, because the game's own loop re-aims the camera
 * between calls and a second call would measure a different view.
 */
import { spawn } from 'node:child_process';
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
const PORT = Number(flag('port', 5194));
const SEED = flag('seed', '11');
const MAP = flag('map', '0');
const HEIGHT = Number(flag('height', 150));
const GHOST_BAR = Number(flag('bar', 400));

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
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
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
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(
  `http://127.0.0.1:${PORT}/index.html?auto=1&seed=${SEED}&map=${MAP}&allies=1&demo=1&quality=high`,
  { waitUntil: 'load' },
);
await page.waitForFunction(() => typeof window.rfStats === 'function', null, { timeout: 180000 });
await sleep(2500);

await page.evaluate(() => {
  const g = window.rfGame;
  const gs = g.gs;
  const sun = gs.scene.children.find((o) => o.isDirectionalLight && o.castShadow);
  const src = gs.renderer.domElement;
  const c2 = document.createElement('canvas');
  c2.width = src.width;
  c2.height = src.height;
  const ctx = c2.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    ctx.clearRect(0, 0, c2.width, c2.height);
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, c2.width, c2.height).data;
  };
  const ruined = [];
  gs.scene.traverse((o) => {
    if (o.isMesh && (o.name || '').includes(':ruined:')) ruined.push(o);
  });
  const dirV = sun.position.clone().sub(sun.target.position).normalize();
  const V = Object.getPrototypeOf(gs.camera.position).constructor;

  const setRuins = (on) => {
    for (const m of ruined) m.visible = on;
  };
  /** Aim the sun's box the way `updateShadowFocus` does for the frozen camera. */
  const aimSun = (half) => {
    const cam = gs.camera;
    const fwd = cam.getWorldDirection(new V());
    const ahead = half * 0.45;
    const fx = cam.position.x + fwd.x * ahead;
    const fz = cam.position.z + fwd.z * ahead;
    sun.target.position.set(fx, 0, fz);
    sun.target.updateMatrixWorld();
    sun.position.set(fx + dirV.x * 150, dirV.y * 150, fz + dirV.z * 150);
    sun.updateMatrixWorld();
    const sc = sun.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.far = 160 + half * 2.6;
    sc.updateProjectionMatrix();
  };

  window.rfGhost = {
    ruinedSets: () => ruined.length,
    /** Destroy every destructible structure past `x0` through the real damage path. */
    raze(x0) {
      const sim = g.sim;
      const pool = [];
      let n = 0;
      for (let i = 0; i < sim.structureCount; i++) {
        const s = sim.structure(i, (pool[i] ||= {}));
        if (s.flags & 1 || !(s.flags & 2) || s.x < x0) continue;
        sim.game.debug_damage_structure(i, 1e6);
        n++;
      }
      g.world.update(0, g.sim, g.time);
      return n;
    },
    /** Dead structures, and whether a ruined instance is standing at each. */
    dead() {
      const sim = g.sim;
      const pool = [];
      const placed = new Map();
      for (const m of ruined) {
        const a = m.instanceMatrix.array;
        for (let k = 0; k < (m.count ?? 0); k++) {
          const b = k * 16;
          const sc =
            Math.hypot(a[b], a[b + 1], a[b + 2]) +
            Math.hypot(a[b + 4], a[b + 5], a[b + 6]) +
            Math.hypot(a[b + 8], a[b + 9], a[b + 10]);
          if (sc < 1e-3) continue;
          const key = `${Math.round(a[b + 12])},${Math.round(a[b + 14])}`;
          placed.set(key, (placed.get(key) ?? 0) + 1);
        }
      }
      const out = [];
      for (let i = 0; i < sim.structureCount; i++) {
        const s = sim.structure(i, (pool[i] ||= {}));
        if (!(s.flags & 1)) continue;
        out.push({
          x: s.x,
          z: s.z,
          kind: s.kind | 0,
          ruins: placed.get(`${Math.round(s.x)},${Math.round(s.z)}`) ?? 0,
        });
      }
      return out;
    },
    /**
     * The precise test: for every ruined set that has instances standing, is three.js going to
     * drop it from the colour pass *while some of its rubble is on screen*? That is the bug.
     *
     * Culling is reproduced with the renderer's own inputs - the six frustum planes from
     * `projection * viewInverse`, tested against `object.boundingSphere` exactly as
     * `Frustum.intersectsObject` does - so this measures the culling decision itself rather than
     * inferring it from pixels.
     */
    culling(at, height, tilt, half) {
      const cam = gs.camera;
      cam.position.set(at[0], height, at[1] + tilt);
      cam.lookAt(at[0], 0, at[1]);
      cam.updateMatrixWorld(true);
      aimSun(half);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      gs.scene.updateMatrixWorld(true);
      const M = cam.projectionMatrix.constructor;
      const planesOf = (c) => {
        const m = new M().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
        const e = m.elements;
        const r = (i) => [e[i], e[4 + i], e[8 + i], e[12 + i]];
        const r0 = r(0);
        const r1 = r(1);
        const r2 = r(2);
        const r3 = r(3);
        const comb = (a, b, s) => a.map((v, i) => v + s * b[i]);
        return [comb(r3, r0, 1), comb(r3, r0, -1), comb(r3, r1, 1), comb(r3, r1, -1), comb(r3, r2, 1), comb(r3, r2, -1)];
      };
      const inside = (planes, c, r) =>
        planes.every((p) => p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] >= -r);
      const camPlanes = planesOf(cam);
      const shadowPlanes = planesOf(sun.shadow.camera);
      const V2 = Object.getPrototypeOf(cam.position).constructor;
      let culled = 0;
      let culledButOnScreen = 0;
      let culledButCastable = 0;
      const spots = [];
      for (const m of ruined) {
        const a = m.instanceMatrix.array;
        let live = 0;
        let onScreen = 0;
        let inShadowBox = 0;
        for (let k = 0; k < (m.count ?? 0); k++) {
          const b = k * 16;
          const sc =
            Math.hypot(a[b], a[b + 1], a[b + 2]) +
            Math.hypot(a[b + 4], a[b + 5], a[b + 6]) +
            Math.hypot(a[b + 8], a[b + 9], a[b + 10]);
          if (sc < 1e-3) continue;
          live++;
          const p = new V2(a[b + 12], a[b + 13], a[b + 14]);
          const ndc = p.clone().project(cam);
          if (Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z <= 1) onScreen++;
          if (inside(shadowPlanes, p, 6)) inShadowBox++;
        }
        if (!live) continue;
        const bs = m.boundingSphere;
        if (!bs) continue;
        const world = bs.clone().applyMatrix4(m.matrixWorld);
        const droppedFromColour = !inside(camPlanes, world.center, world.radius);
        if (!droppedFromColour) continue;
        culled++;
        if (onScreen > 0) {
          culledButOnScreen++;
          if (spots.length < 8) spots.push({ name: m.name, live, onScreen });
        }
        if (inShadowBox > 0) culledButCastable++;
      }
      return { camPlanes: camPlanes.length, culled, culledButOnScreen, culledButCastable, spots };
    },
    /** The four-frame split, plus where the ghost pixels are on the ground. */
    pose(at, height, tilt, half) {
      const shoot = (ruinsOn, shadowsOn) => {
        setRuins(ruinsOn);
        sun.castShadow = shadowsOn;
        const cam = gs.camera;
        cam.position.set(at[0], height, at[1] + tilt);
        cam.lookAt(at[0], 0, at[1]);
        cam.updateMatrixWorld(true);
        aimSun(half);
        gs.render();
        return grab();
      };
      const N = shoot(true, true);
      const R = shoot(false, true);
      const S = shoot(true, false);
      const SR = shoot(false, false);
      setRuins(true);
      sun.castShadow = true;
      const w = c2.width;
      const h = c2.height;
      const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      let drawn = 0;
      let total = 0;
      let ghost = 0;
      let ghostSum = 0;
      const spots = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i4 = (y * w + x) * 4;
          const colour = Math.abs(lum(S, i4) - lum(SR, i4));
          const all = Math.abs(lum(N, i4) - lum(R, i4));
          if (colour > 10) drawn++;
          if (all <= 10) continue;
          total++;
          if (colour <= 4) {
            ghost++;
            ghostSum += all;
            if (spots.length < 6000) spots.push([x, y]);
          }
        }
      }
      // Cluster the ghost pixels and put each cluster back on the ground.
      const clusters = [];
      for (const [x, y] of spots) {
        const hit = clusters.find((c) => Math.abs(c.sx / c.n - x) < 26 && Math.abs(c.sy / c.n - y) < 26);
        if (hit) {
          hit.sx += x;
          hit.sy += y;
          hit.n++;
        } else clusters.push({ sx: x, sy: y, n: 1 });
      }
      const cam = gs.camera;
      const at3 = clusters
        .filter((c) => c.n > 25)
        .sort((a, b) => b.n - a.n)
        .slice(0, 6)
        .map((c) => {
          const nx = (c.sx / c.n / w) * 2 - 1;
          const ny = -((c.sy / c.n / h) * 2 - 1);
          const p = new V(nx, ny, 0.5).unproject(cam);
          const dir = p.sub(cam.position).normalize();
          const t = cam.position.y / Math.max(0.1, -dir.y);
          return {
            n: c.n,
            at: [
              Math.round((cam.position.x + dir.x * t) * 10) / 10,
              Math.round((cam.position.z + dir.z * t) * 10) / 10,
            ],
          };
        });
      return { w, h, drawn, total, ghost, ghostSum, clusters: at3, shadowEffect: total - drawn };
    },
  };
});

const ruinedSets = await page.evaluate(() => window.rfGhost.ruinedSets());
const killed = await page.evaluate((x0) => window.rfGhost.raze(x0), 0.5 * 512);
await sleep(300);
const dead = await page.evaluate(() => window.rfGhost.dead());
const withRuin = dead.filter((s) => s.ruins > 0);
console.log(
  `seed ${SEED} map ${MAP}: ${ruinedSets} ruined sets in the scene; razed ${killed} structures, ` +
    `${dead.length} dead, ${withRuin.length} with a ruined instance standing`,
);
if (!withRuin.length) {
  console.log('nothing to test: no destroyed structure has a ruin model on this map');
  await browser.close();
  server.kill('SIGKILL');
  process.exit(0);
}
const cx = withRuin.reduce((a, s) => a + s.x, 0) / withRuin.length;
const cz = withRuin.reduce((a, s) => a + s.z, 0) / withRuin.length;
console.log(`looking at (${cx.toFixed(0)}, ${cz.toFixed(0)}) - the centroid of the destroyed structures`);

const half = Math.min(150, Math.max(58, (58 * HEIGHT) / 52));
let ghosts = 0;
for (const zoom of [HEIGHT, HEIGHT * 1.6]) {
  const cull = await page.evaluate(
    ({ at, zoom, half }) => window.rfGhost.culling(at, zoom, zoom * 0.55, half),
    { at: [cx, cz], zoom, half },
  );
  const px = await page.evaluate(
    ({ at, zoom, half }) => window.rfGhost.pose(at, zoom, zoom * 0.55, half),
    { at: [cx, cz], zoom, half },
  );
  ghosts += cull.culledButOnScreen;
  console.log(
    `zoom ${String(zoom.toFixed(0)).padStart(3)} m: ${cull.culled} ruined sets dropped from the ` +
      `colour pass, of which ${cull.culledButOnScreen} have rubble standing in view ` +
      `(${cull.culledButCastable} still inside the sun's box, so they shadow the ground anyway)`,
  );
  console.log(
    `         pixels: ruins drawn over ${px.drawn} px, their shadow covers ${px.shadowEffect} px - ` +
      `the ratio says whether the shadow you can see belongs to rubble you can see`,
  );
  for (const s of cull.spots) {
    console.log(`    ${s.name}: ${s.live} placed instance(s), ${s.onScreen} of them in view, set culled`);
  }
}

await browser.close();
server.kill('SIGKILL');
if (errors.length) {
  console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  process.exit(2);
}
console.log(
  ghosts > 0
    ? `FAIL: ${ghosts} ruined sets are culled while their rubble is on screen - those shade the ` +
        `ground with nothing drawn`
    : 'ok: no ruined set is culled while its rubble is in view',
);
process.exit(ghosts > 0 ? 1 : 0);
