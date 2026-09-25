#!/usr/bin/env node
/**
 * Long-play soak: watches a real match for growth and stalls.
 *
 *   node tools/soak.mjs [--secs 600] [--sample 5000] [--port 5186] [--fps 0] [--url "..."]
 *
 * Boots the live page (no `?maxframes`, so the render loop keeps running) and samples every
 * `--sample` ms: the real frame cadence from an injected rAF sampler, the per-phase frame cost
 * from `rfProfile()` (reset each window, so each row is that window's average), the renderer's
 * resource counters (draw calls, geometries, textures, compiled programs) and both heaps (JS
 * and wasm linear memory). It exists to catch the reported "freezes after 8-10 min of play" -
 * a stall shows up as one sample with a huge max frame gap, and a leak shows up as a trend in
 * geometries/textures/programs/heaps.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
const SECS = Number(flag('secs', 600));
const SAMPLE = Number(flag('sample', 5000));
const PORT = Number(flag('port', 5186));
const FPS = Number(flag('fps', 0));
const WAIT = Number(flag('wait', 45000));
const QUERY = flag('url', 'auto=1&seed=11&vehicle=4&size=small&allies=1&demo=1&maxveh=16&cpu=hard');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

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
  let ok = false;
  while (Date.now() - t0 < 30000) {
    if (await portAlive(PORT)) {
      ok = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ok) {
    console.error('vite did not start:\n' + log);
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      server.kill('SIGKILL');
    }
    process.exit(1);
  }
}

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
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
    '--disable-frame-rate-limit',
    '--hide-scrollbars',
    '--js-flags=--expose-gc',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[console] ${m.text()}`);
});

const url = `http://127.0.0.1:${PORT}/index.html?${QUERY}${FPS > 0 ? `&fps=${FPS}` : ''}`;
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: WAIT });

// A frame-cadence sampler of our own: the game's `fps` field is an EMA of the clamped dt, which
// cannot show a multi-second stall (dt is capped at 0.1 s). rAF timestamps can.
await page.evaluate(() => {
  const w = window;
  w.__soakTick = { last: 0, gaps: [], frames: 0 };
  const tick = (t) => {
    const s = w.__soakTick;
    if (s.last > 0) {
      s.gaps.push(t - s.last);
      if (s.gaps.length > 4096) s.gaps.shift();
    }
    s.last = t;
    s.frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const rows = [];
const t0 = Date.now();
let worst = { gap: 0, at: 0, simT: 0 };
while ((Date.now() - t0) / 1000 < SECS) {
  await new Promise((r) => setTimeout(r, SAMPLE));
  const s = await page.evaluate(() => {
    const g = window.rfGame;
    const sim = g.sim;
    const r = g.gs.renderer;
    const prof = window.rfProfile();
    window.rfProfileReset();
    const tick = window.__soakTick;
    const gaps = tick.gaps.splice(0, tick.gaps.length);
    const maxGap = gaps.length ? Math.max(...gaps) : 0;
    const medGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 0;
    const frames = tick.frames;
    tick.frames = 0;
    let wrecks = 0;
    for (let i = 0; i < sim.vehicleCount; i++) if (sim.vehicles[i].state === 2) wrecks++;
    const mem = performance.memory;
    // Scene census: what the renderer is actually holding. `renderer.info.memory` counts what
    // was uploaded; this says which *type* of object is piling up, and whether the scene graph
    // itself is growing (objects) or being churned (unique geometries while meshes hold).
    const geoTypes = {};
    const matTypes = {};
    const geos = new Set();
    const mats = new Set();
    const texs = new Set();
    let meshes = 0;
    let objects = 0;
    g.gs.scene.traverse((o) => {
      objects++;
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      meshes++;
      if (o.geometry) {
        geos.add(o.geometry);
        const t = o.geometry.type || '?';
        geoTypes[t] = (geoTypes[t] || 0) + 1;
      }
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m) continue;
        mats.add(m);
        const t = m.type || '?';
        matTypes[t] = (matTypes[t] || 0) + 1;
        for (const k of ['map', 'alphaMap', 'normalMap', 'emissiveMap', 'roughnessMap']) {
          if (m[k]) texs.add(m[k]);
        }
      }
    });
    const fx = g.fx.stats();
    return {
      simT: g.time,
      frames,
      maxGap,
      medGap,
      phases: prof.phases,
      totalMs: prof.totalMs,
      draws: r.info.render.calls,
      tris: r.info.render.triangles,
      geoms: r.info.memory.geometries,
      textures: r.info.memory.textures,
      programs: r.info.programs ? r.info.programs.length : -1,
      vehicles: sim.vehicleCount,
      wrecks,
      projectiles: sim.projectileCount,
      structures: sim.structureCount,
      matchState: sim.matchState,
      jsHeap: mem ? mem.usedJSHeapSize : 0,
      wasmBytes: sim.memory.buffer.byteLength,
      objects,
      meshes,
      geos: geos.size,
      mats: mats.size,
      texs: texs.size,
      geoTypes,
      matTypes,
      fxDecals: fx.decals,
      fxParticles: fx.particles,
      fxDraws: fx.drawCalls,
    };
  });
  const wall = (Date.now() - t0) / 1000;
  rows.push({ wall, ...s });
  if (s.maxGap > worst.gap) worst = { gap: s.maxGap, at: wall, simT: s.simT };
  const p = s.phases;
  console.log(
    `t=${wall.toFixed(0).padStart(4)}s sim=${s.simT.toFixed(0).padStart(4)}s ` +
      `frames=${String(s.frames).padStart(4)} gap(med/max)=${s.medGap.toFixed(0)}/${s.maxGap.toFixed(0)}ms ` +
      `ms[sim=${p.sim} cam=${p.cameras} world=${p.world} fx=${p.fx} draw=${p.draw} hud=${p.hud}] ` +
      `draws=${s.draws} tris=${(s.tris / 1000).toFixed(0)}k geo=${s.geoms} tex=${s.textures} prog=${s.programs} ` +
      `veh=${s.vehicles}(wreck ${s.wrecks}) proj=${s.projectiles} struct=${s.structures} ` +
      `jsHeap=${(s.jsHeap / 1048576).toFixed(0)}M wasm=${(s.wasmBytes / 1048576).toFixed(0)}M state=${s.matchState} | ` +
      `scene obj=${s.objects} mesh=${s.meshes} geo=${s.geos} mat=${s.mats} tex=${s.texs} ` +
      `fx(part=${s.fxParticles} decal=${s.fxDecals})`,
  );
}

await page.close();
await ctx.close();
await browser.close();
if (server) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
}

const first = rows[0];
const last = rows[rows.length - 1];
const fmt = (v) => (v / 1048576).toFixed(0) + 'M';
console.log('\n=== soak summary ===');
console.log(`url   ?${QUERY}${FPS > 0 ? `&fps=${FPS}` : ''}`);
console.log(`run   ${rows.length} samples over ${((Date.now() - t0) / 1000).toFixed(0)}s wall, sim time ${last.simT.toFixed(0)}s`);
console.log(`worst frame gap ${worst.gap.toFixed(0)} ms at wall ${worst.at.toFixed(0)}s (sim ${worst.simT.toFixed(0)}s)`);
console.log(
  `js heap ${fmt(first.jsHeap)} -> ${fmt(last.jsHeap)} | wasm ${fmt(first.wasmBytes)} -> ${fmt(last.wasmBytes)}`,
);
console.log(
  `geometries ${first.geoms} -> ${last.geoms} | textures ${first.textures} -> ${last.textures} | programs ${first.programs} -> ${last.programs}`,
);
console.log(
  `scene objects ${first.objects} -> ${last.objects} | meshes ${first.meshes} -> ${last.meshes} | ` +
    `unique geometries ${first.geos} -> ${last.geos} | materials ${first.mats} -> ${last.mats} | textures ${first.texs} -> ${last.texs}`,
);
const typeDelta = (key) => {
  const keys = new Set([...Object.keys(first[key] || {}), ...Object.keys(last[key] || {})]);
  const out = [];
  for (const k of keys) {
    const a = (first[key] || {})[k] || 0;
    const b = (last[key] || {})[k] || 0;
    if (b !== a) out.push(`${k} ${a}->${b}`);
  }
  return out.join(', ') || 'none';
};
console.log(`geometry type counts  ${typeDelta('geoTypes')}`);
console.log(`material type counts  ${typeDelta('matTypes')}`);

const stall = rows.filter((r) => r.maxGap > 2000);
if (stall.length) {
  console.log(`\nSTALLS (>2 s between frames): ${stall.length} window(s)`);
  for (const r of stall.slice(0, 10)) {
    console.log(`  wall ${r.wall.toFixed(0)}s sim ${r.simT.toFixed(0)}s gap ${(r.maxGap / 1000).toFixed(1)}s`);
  }
} else {
  console.log('\nno stall window over 2 s in this run');
}
for (const p of problems.slice(0, 5)) console.log('problem: ' + p);
