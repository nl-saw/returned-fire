#!/usr/bin/env node
/**
 * Structure scale probe: every part of an instanced structure must stay inside the footprint
 * the generator gave it — before and after it dies and is revived.
 *
 * The bug this pins: `setBucketDead` wrote the bare outer matrix, but the build path writes
 * `outer * part.local`. The local matrix is what carries a unit-sized model's normalisation
 * (the model is authored at the size the generator expects, then carried in a shell scaled by
 * its inverse), so dropping it multiplied every part that has one by `(w, h, d)` again. A
 * garage panel came out 136 m long and a fuel-depot slab 65 m across — the "weird rectangle
 * over the base after a round finishes" report, which only ever showed once something had been
 * destroyed and the round restarted, because that is the only other writer of those matrices.
 *
 *   node tools/structure-scale.mjs [--port 5199] [--seed 11]
 *
 * Exits non-zero (and prints the offending parts) when any part sticks out more than 2.5x its
 * structure's own size in any axis.
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
const PORT = Number(flag('port', 5199));
const SEED = flag('seed', '11');

const server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: WEB,
  stdio: 'ignore',
});
const stop = () => {
  try {
    server.kill('SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', stop);

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
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(
  `http://127.0.0.1:${PORT}/index.html?auto=1&seed=${SEED}&vehicle=4&size=small&allies=1&demo=1`,
  { waitUntil: 'load' },
);
await page.waitForFunction(() => typeof window.rfStats === 'function', null, { timeout: 120000 });
await sleep(1500);

/** Every instance of every structure bucket, against the structure that stands there. */
const audit = () =>
  page.evaluate(() => {
    const sim = window.rfGame.sim;
    const pool = [];
    const near = (x, z) => {
      let best = null;
      let bd = 4;
      for (let i = 0; i < sim.structureCount; i++) {
        const s = sim.structure(i, (pool[i] ||= {}));
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      return best;
    };
    const bad = [];
    let checked = 0;
    window.rfGame.gs.scene.traverse((o) => {
      if (!o.isInstancedMesh || !(o.name || '').startsWith('struct:')) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const geo = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
      const a = o.instanceMatrix.array;
      for (let k = 0; k < (o.count ?? 0); k++) {
        const b = k * 16;
        const sc = [
          Math.hypot(a[b], a[b + 1], a[b + 2]),
          Math.hypot(a[b + 4], a[b + 5], a[b + 6]),
          Math.hypot(a[b + 8], a[b + 9], a[b + 10]),
        ];
        if (sc[0] + sc[1] + sc[2] < 1e-3) continue; // hidden slot
        const s = near(a[b + 12], a[b + 14]);
        if (!s) continue;
        checked++;
        const world = geo.map((v, i) => v * sc[i]);
        const limit = Math.max(s.w, s.h, s.d, 2.0) * 2.5;
        if (Math.max(world[0], world[1], world[2]) > limit) {
          bad.push({
            mesh: o.name,
            part: k,
            world: world.map((v) => Math.round(v * 10) / 10),
            structure: [s.w, s.h, s.d].map((v) => Math.round(v * 10) / 10),
            kind: s.kind | 0,
          });
        }
      }
    });
    return { checked, bad };
  });

const results = [];
results.push(['boot', await audit()]);

// Destroy a base: the ruined variants go through the same swap, and the round reset revives
// them through it again — the two paths the bug lived in.
const killed = await page.evaluate(() => {
  const sim = window.rfGame.sim;
  const pool = [];
  let n = 0;
  for (let i = 0; i < sim.structureCount; i++) {
    const s = sim.structure(i, (pool[i] ||= {}));
    if (s.flags & 1 || !(s.flags & 2)) continue;
    if (s.x > sim.map.worldSize * 0.55) {
      sim.game.debug_damage_structure(i, 1e6);
      n++;
    }
  }
  return n;
});
await sleep(3000);
results.push([`after destroying ${killed}`, await audit()]);
await page.evaluate(() => window.rfGame.sim.game.force_next_round());
await sleep(3000);
results.push(['after revival', await audit()]);

await browser.close();
stop();

let failed = false;
for (const [label, r] of results) {
  console.log(`${label}: ${r.checked} instances checked, ${r.bad.length} oversized`);
  for (const b of r.bad.slice(0, 6)) {
    failed = true;
    console.log(
      `  ${b.mesh} part ${b.part}: drawn ${b.world.join(' x ')} m where the structure is ` +
        `${b.structure.join(' x ')} m (kind ${b.kind})`,
    );
  }
}
if (errors.length) {
  console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  failed = true;
}
console.log(failed ? 'FAIL: structure parts are out of scale' : 'ok');
process.exit(failed ? 1 : 0);
