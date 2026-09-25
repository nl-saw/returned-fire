#!/usr/bin/env node
/**
 * Structure fit check: the size the generator places a structure at, the size its model is
 * authored for, and the space the model (and its ruined variant) actually occupies must agree.
 *
 *   node tools/structure-fit.mjs [--seed 1337] [--map 0] [--size small|medium|big]
 *                               [--mode mirror] [--explain KIND] [--port 5188]
 *
 * Why this exists: the renderer normalises every unit-sized structure model by
 * `STRUCTURE_SIZE[kind]` (web/src/assets/models/kinds.ts) and then scales the instance by the
 * size rf-core put in the `Structure` record, so those two numbers are the same measurement.
 * When they disagreed, the model was stretched or squashed - the HQ was authored 19x15x8.4 and
 * placed 10x8.5x11.5 (squeezed to half width, pushed 37% taller), the helipad's deck (the
 * bottom 0.4 m of a 6.2 m box) was placed at h = 0.4 (a 3 cm pad, windsock gone), and the fuel
 * depot's bund walls were authored striding 10 m across an 8 m pad (an 18 m deep depot). A
 * model can also be authored for the right *size* yet still put geometry outside it, which
 * makes it spill past its own collision footprint - exactly the "base renders as flat slabs"
 * report this tool was written for.
 *
 * It measures every mesh in the model with a precise (per-vertex) box and compares the furthest
 * reach on each axis against the box the model is normalised by: |x| <= w/2 + TOL,
 * |z| <= d/2 + TOL, y <= h + TOL, y >= -0.3 (ruins get RUIN_TOL). Masts and roof aerials may
 * stand above the box for the kinds in ALLOW_ABOVE; the bridge (BOX_EXCEPTIONS) is only checked
 * on its footprint, because its authored box is the deck-to-base span while the generator's `h`
 * for a bridge is the deck slab. Animated parts are measured at rest (a gate's leaves slide into
 * the wall run when open; a garage door rises above its box - both by design).
 *
 * Only the placements a map actually contains are checked, and the classic generator never
 * emits BRIDGE (mirror-mode maps do), so run `--mode mirror` too when touching bridges.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const PORT = Number(flag('port', process.env.FIT_PORT ?? 5188));
const SEED = Number(flag('seed', 1337));
const MAPIDX = Number(flag('map', 0));
const SIZE = flag('size', 'small');
const MODE = flag('mode', '');
const EXPLAIN = flag('explain', '');

/** Kinds whose models deliberately stand above the collision box (masts, poles). */
const ALLOW_ABOVE = new Set([
  'flagPole', 'helipad', 'radar', 'watchtower', 'antenna', 'lighthouse', 'turretTower', // masts by design
  'hq', 'bunker', 'garage', 'ammoTent', // a mast/roof aerial stands above the collision box
]);
/** How far a model may overhang its box: dressing (sandbags, decals) may stick out a little. */
const TOL = 0.35;
/** Rubble spreads: a ruined variant may overhang its box this much. */
const RUIN_TOL = 0.5;
/**
 * Kinds whose authored box is deliberately not the generator's box, and whose geometry leaves
 * it. The timber bridge is authored so its deck top sits at the top of its own box, its piles
 * run below it into the water and its railings stand above it; the generator's `h` for a bridge
 * is the deck slab (0.9 m), not that span. What matters is that its deck lands on
 * `Structure.y + h`, which `bBridge` in structures.ts documents. Only the footprint is checked.
 */
const BOX_EXCEPTIONS = new Map([
  ['bridge', "authored box = deck-to-base span; the plan's h is the deck slab"],
]);

async function alive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(700) });
    return r.status < 500;
  } catch {
    return false;
  }
}
let server = null;
if (!(await alive())) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: WEB, stdio: 'ignore', detached: true,
  });
  for (let i = 0; i < 100 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 300));
}
const chrome = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 200)}`));
const modeQuery = MODE ? `&mode=${MODE}` : '';
await page.goto(`http://127.0.0.1:${PORT}/editor.html?seed=${SEED}&map=${MAPIDX}&size=${SIZE}${modeQuery}&capture=1`, {
  waitUntil: 'load', timeout: 30000,
});
await page.waitForFunction('window.rfReady === true', null, { timeout: 180000 });

const report = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const kinds = await import('/src/assets/models/kinds.ts');
  const structs = await import('/src/assets/models/structures.ts');
  const ruins = await import('/src/assets/models/ruins.ts');
  const libmod = await import('/src/assets/textures/library.ts');
  const lib = libmod.createSurfaceLibrary({ size: 64, full: false });

  // what the generator actually places, per kind
  const sim = window.rfEditor.sim;
  const n = sim.structureCount();
  const view = {};
  const plan = {};
  for (let i = 0; i < n; i++) {
    sim.structure(i, view);
    const k = view.kind | 0;
    const p = (plan[k] ??= { w: view.w, d: view.d, h: view.h, teams: new Set() });
    p.teams.add(view.team | 0);
  }

  /** Box around every mesh in `root`, in metres, using precise per-vertex boxes. */
  const measure = (root, size) => {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      tmp.setFromObject(o, true);
      box.union(tmp);
    });
    const s = box.getSize(new THREE.Vector3());
    return { x: s.x * size[0], y: s.y * size[2], z: s.z * size[1], minY: box.min.y * size[2] };
  };

  const parts = (root, size) => {
    root.updateMatrixWorld(true);
    const out = [];
    const tmp = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      tmp.setFromObject(o, true);
      out.push({
        name: o.name || o.type,
        ex: +(Math.max(Math.abs(tmp.min.x), Math.abs(tmp.max.x)) * size[0]).toFixed(2),
        ez: +(Math.max(Math.abs(tmp.min.z), Math.abs(tmp.max.z)) * size[1]).toFixed(2),
        ey: +(tmp.max.y * size[2]).toFixed(2),
      });
    });
    return out;
  };

  const rows = [];
  for (const [name, id] of Object.entries(kinds.SKIND)) {
    if (name === 'NONE') continue;
    const p = plan[id];
    if (!p) continue;
    const authored = kinds.STRUCTURE_SIZE[id];
    const unit = kinds.isUnitSized(id);
    const norm = unit ? authored : [1, 1, 1]; // true-scale models are not normalised
    const model = structs.buildStructure(id, lib, 1, 1);
    const modelParts = parts(model.root, authored);
    const ruin = ruins.buildRuin(id, lib, 1, 1);
    const ruinParts = ruin ? parts(ruin, authored) : null;
    rows.push({
      name,
      id,
      unit,
      plan: [p.w, p.d, p.h],
      authored,
      model: measure(model.root, norm),
      modelParts,
      ruinParts,
      ruin: ruin ? measure(ruin, norm) : null,
    });
  }
  return rows;
});

if (EXPLAIN) {
  const detail = await page.evaluate(async (kindName) => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const kinds = await import('/src/assets/models/kinds.ts');
    const structs = await import('/src/assets/models/structures.ts');
    const libmod = await import('/src/assets/textures/library.ts');
    const lib = libmod.createSurfaceLibrary({ size: 64, full: false });
    const id = kinds.SKIND[kindName];
    const size = kinds.STRUCTURE_SIZE[id];
    const model = structs.buildStructure(id, lib, 1, 1);
    model.root.updateMatrixWorld(true); // the explain pass measures children in root space
    const out = [];
    const box = new THREE.Box3();
    model.root.traverse((o) => {
      const m = o;
      if (!m.isMesh || !m.geometry) return;
      box.setFromObject(m, true);
      const sz = box.getSize(new THREE.Vector3());
      out.push({
        name: m.name || m.type,
        x: +(sz.x * size[0]).toFixed(2),
        y: +(sz.y * size[2]).toFixed(2),
        z: +(sz.z * size[1]).toFixed(2),
        cz: +((box.min.z + box.max.z) / 2 * size[1]).toFixed(2),
        cx: +((box.min.x + box.max.x) / 2 * size[0]).toFixed(2),
        cy: +((box.min.y + box.max.y) / 2 * size[2]).toFixed(2),
        ex: +(Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) * size[0]).toFixed(2),
        ez: +(Math.max(Math.abs(box.min.z), Math.abs(box.max.z)) * size[1]).toFixed(2),
        ey: +(box.max.y * size[2]).toFixed(2),
      });
    });
    // sort by how far the part reaches from the origin, as a fraction of its box half-extent
    out.sort(
      (a, b) =>
        Math.max(b.ex / size[0], b.ez / size[1], b.ey / size[2]) -
        Math.max(a.ex / size[0], a.ez / size[1], a.ey / size[2]),
    );
    return { size, out: out.slice(0, 10) };
  }, EXPLAIN);
  console.log(`explain ${EXPLAIN}: box ${JSON.stringify(detail.size)} (w,d,h)`);
  for (const r of detail.out) {
    console.log(
      `  ${r.name.padEnd(20)} size ${r.x} x ${r.y} x ${r.z}  extent x±${r.ex} z±${r.ez} top ${r.ey}  centre ${r.cx},${r.cy},${r.cz}`,
    );
  }
}
let failures = 0;
console.log(`structure fit — seed=${SEED} map=${MAPIDX} ${SIZE}\n`);
console.log('kind           unit  generator (w,d,h)      authored (w,d,h)       model occupies (x,y,z)     verdict');
for (const r of report) {
  const [pw, pd, ph] = r.plan;
  const [aw, ad, ah] = r.authored;
  const notes = [];
  const fails = [];
  const excepted = BOX_EXCEPTIONS.get(r.name.toLowerCase());
  if (excepted) notes.push(`note: ${excepted}`);
  if (r.unit && !excepted) {
    if (Math.abs(aw - pw) > TOL || Math.abs(ad - pd) > TOL || Math.abs(ah - ph) > TOL) {
      fails.push('AUTHORED!=GENERATOR');
    }
  }
  const reachOf = (list) => {
    if (!list || !list.length) return null;
    return {
      x: Math.max(...list.map((q) => q.ex)),
      y: Math.max(...list.map((q) => q.ey)),
      z: Math.max(...list.map((q) => q.ez)),
    };
  };
  const m = reachOf(r.modelParts) ?? r.model;
  if (r.unit) {
    if (m.x > aw / 2 + TOL) fails.push(`model wide ${m.x.toFixed(2)}>${(aw / 2 + TOL).toFixed(2)}`);
    if (m.z > ad / 2 + TOL) fails.push(`model deep ${m.z.toFixed(2)}>${(ad / 2 + TOL).toFixed(2)}`);
    if (!excepted) {
      if (m.y > ah + TOL && !ALLOW_ABOVE.has(r.name.toLowerCase())) fails.push(`model tall ${m.y.toFixed(2)}>${(ah + TOL).toFixed(2)}`);
      if (r.model && r.model.minY < -0.3) fails.push(`model sinks ${r.model.minY}`);
    }
    const g = reachOf(r.ruinParts);
    if (g) {
      if (g.x > aw / 2 + RUIN_TOL) fails.push(`ruin wide ${g.x.toFixed(2)}>${(aw / 2 + RUIN_TOL).toFixed(2)}`);
      if (g.z > ad / 2 + RUIN_TOL) fails.push(`ruin deep ${g.z.toFixed(2)}>${(ad / 2 + RUIN_TOL).toFixed(2)}`);
      if (g.y > ah + RUIN_TOL && !ALLOW_ABOVE.has(r.name.toLowerCase())) fails.push(`ruin tall ${g.y.toFixed(2)}>${(ah + RUIN_TOL).toFixed(2)}`);
    }
  }
  if (fails.length) failures++;
  if (fails.length && r.modelParts) {
    const worst = [...r.modelParts]
      .sort(
        (a, b) =>
          Math.max(b.ex / aw, b.ez / ad, b.ey / ah) - Math.max(a.ex / aw, a.ez / ad, a.ey / ah),
      )
      .slice(0, 2)
      .map((w) => `${w.name} x±${w.ex} z±${w.ez} top ${w.ey}`);
    notes.push(`worst: ${worst.join(' ; ')}`);
  }
  console.log(
    `${r.name.padEnd(14)}${(r.unit ? 'unit' : 'true').padEnd(6)}` +
      `${`${pw.toFixed(1)},${pd.toFixed(1)},${ph.toFixed(1)}`.padEnd(22)}` +
      `${`${aw},${ad},${ah}`.padEnd(23)}` +
      `${`${m.x.toFixed(1)},${m.y.toFixed(1)},${m.z.toFixed(1)}`.padEnd(27)}` +
      `${[...fails, ...notes].join(' | ') || 'ok'}`,
  );
}
if (problems.length) console.log(`\npage problems: ${problems.slice(0, 4).join(' | ')}`);
console.log(`\n${failures ? `FAIL — ${failures} kind(s) need work` : 'PASS — every model fits the size the generator places'}`);
await browser.close();
if (server?.pid) {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
}
process.exit(failures ? 1 : 0);
