#!/usr/bin/env node
/**
 * What a big minefield costs: sim time per tick, and draw calls / triangles per mine.
 *
 *   node tools/minecost-probe.mjs [--secs 420] [--port 5205] [--url "..."]
 *
 * The renderer is parked (`?maxframes=2`) so the sim can be advanced through a whole match
 * quickly, and `sim.update` (the wasm tick, the memory sync and the view decode) is timed on
 * every frame, bucketed by how many mines were live. When the field is big the page renders the
 * frame once, then hides exactly the mine objects and renders again: the difference is the
 * minefield's own draw calls and triangles, with everything else in the scene held constant.
 * Draw calls and triangles are machine-independent, so they describe a real GPU; the wall-clock
 * draw time here does not, because this runs on a software rasteriser.
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
const SECS = Number(flag('secs', 420));
const PORT = Number(flag('port', 5205));
const WAIT = Number(flag('wait', 60000));
const CHUNK = Number(flag('chunk', 240));
const HIGH = Number(flag('high', 400));
const QUERY = flag('url', 'auto=1&seed=11&vehicle=4&size=medium&allies=1&demo=1&maxveh=24&cpu=easy');

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
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}/index.html?${QUERY}&maxframes=2`, {
  waitUntil: 'load',
  timeout: 30000,
});
await page.waitForFunction('window.__READY__ === true', null, { timeout: WAIT });

await page.evaluate(() => {
  const g = window.rfGame;
  const sim = g.sim;
  const r = g.gs.renderer;
  const w = window;
  w.__mc = { samples: [], simMs: 0, simCalls: 0 };

  // The whole bridge update: wasm tick + memory sync + view decode.
  const orig = sim.update.bind(sim);
  sim.update = function timed(dt, inputs) {
    const t0 = performance.now();
    orig(dt, inputs);
    w.__mc.simMs += performance.now() - t0;
    w.__mc.simCalls++;
  };

  /** Step and return the average `sim.update` cost over those frames, plus the mine count. */
  w.__step = (chunk) => {
    const before = w.__mc.simCalls;
    w.__mc.simMs = 0;
    w.rfStep(chunk);
    const calls = w.__mc.simCalls - before;
    const avgMs = calls ? w.__mc.simMs / calls : 0;
    w.__mc.simMs = 0;
    return { simT: g.time, mines: sim.game.mines_len(), avgMs, vehicles: sim.vehicleCount };
  };

  /**
   * Mine objects are the two-mesh groups the world builder makes per mine (a cylinder body with
   * a sphere LED). Find them by that shape, so the A/B hides mines and nothing else.
   */
  w.__mineCost = () => {
    const live = sim.game.mines_len();
    // `rfStep` runs the sim and the cameras but not the world sync, so the mine meshes have to
    // be built the way the real frame builds them *before* they can be found or counted.
    for (let i = 0; i < 3; i++) g.world.update(1 / 60, sim, g.time);
    // The field is two instanced draws now (a cylinder body and a sphere LED); the mine body
    // cylinder is not used by anything else in the scene.
    const inst = [];
    g.gs.scene.traverse((o) => {
      if (!o.isInstancedMesh || !o.geometry) return;
      if (o.geometry.type === 'CylinderGeometry' || o.geometry.type === 'SphereGeometry') inst.push(o);
    });
    r.info.autoReset = false;

    r.info.reset();
    g.draw();
    const withCalls = r.info.render.calls;
    const withTris = r.info.render.triangles;

    const restore = [];
    for (const mesh of inst) {
      if (!mesh.visible) continue;
      mesh.visible = false;
      restore.push(mesh);
    }
    r.info.reset();
    g.draw();
    const withoutCalls = r.info.render.calls;
    const withoutTris = r.info.render.triangles;
    for (const mesh of restore) mesh.visible = true;

    // Per-instance blink: read the LED colours back and re-derive them from each mine's id, to
    // prove the pattern is a function of (id, time) and not of the array slot - which is what
    // makes it survive a detonation in the middle of the field.
    const led = inst.find((o) => o.geometry.type === 'SphereGeometry');
    const hash01 = (n) => {
      const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const blinkRows = [];
    if (led && led.instanceColor) {
      const arr = led.instanceColor.array;
      const k = Math.min(6, led.count);
      for (let i = 0; i < k; i++) {
        const id = sim.mines[i].id;
        const rate = 4.2 + hash01(id + 57.0) * 1.6;
        const phase = hash01(id) * Math.PI * 2;
        const blink = (Math.sin(g.time * rate + phase) + 1) * 0.5;
        blinkRows.push({
          slot: i,
          id,
          rate: Number(rate.toFixed(3)),
          armed: sim.mines[i].armed,
          actualGreen: Number(arr[i * 3 + 1].toFixed(4)),
          expectedGreen: Number((0.15 + blink * 0.5).toFixed(4)),
        });
      }
    }

    const byType = {};
    let groups = 0;
    g.gs.scene.traverse((o) => {
      if (o.isMesh && o.geometry) byType[o.geometry.type] = (byType[o.geometry.type] || 0) + 1;
      if (o.isGroup) groups++;
    });
    return {
      liveMines: live,
      instanced: inst.map((o) => ({ geo: o.geometry.type, instances: o.count, cap: o.instanceMatrix.count })),
      sceneGroups: groups,
      byType,
      blinkRows,
      withCalls,
      withoutCalls,
      withTris,
      withoutTris,
      vehicles: sim.vehicleCount,
      particles: g.fx.stats().particles,
    };
  };
});

const t0 = Date.now();
const samples = [];
let cost = null;
while ((Date.now() - t0) / 1000 < SECS) {
  const s = await page.evaluate((chunk) => window.__step(chunk), CHUNK);
  samples.push(s);
  if (!cost && s.mines >= HIGH) {
    cost = await page.evaluate(() => window.__mineCost());
  }
}
if (!cost) cost = await page.evaluate(() => window.__mineCost());

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

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
};
const buckets = [
  ['0 mines', (m) => m === 0],
  ['1-49', (m) => m >= 1 && m < 50],
  ['50-199', (m) => m >= 50 && m < 200],
  ['200+', (m) => m >= 200],
];
console.log(`minefield cost: ?${QUERY}&maxframes=2`);
console.log(
  `${samples.length} samples over ${((Date.now() - t0) / 1000).toFixed(0)}s wall, sim time ` +
    `${samples[samples.length - 1].simT.toFixed(0)}s, peak mines ${Math.max(...samples.map((s) => s.mines))}`,
);
console.log('\nsim.update (wasm tick + sync + view decode), median per mine bucket:');
for (const [label, test] of buckets) {
  const xs = samples.filter((s) => test(s.mines)).map((s) => s.avgMs);
  if (!xs.length) continue;
  console.log(`  ${label.padEnd(9)} n=${String(xs.length).padStart(3)}  median ${median(xs).toFixed(3)} ms`);
}
console.log('\nminefield scene footprint:');
for (const m of cost.instanced) {
  console.log(`  instanced ${m.geo.padEnd(18)} ${m.instances} instances drawn of ${m.cap} capacity`);
}
console.log(`  scene groups total ${cost.sceneGroups} (per-mine groups: none)`);
console.log(`  meshes by geometry: ${JSON.stringify(cost.byType)}`);
console.log('\nrender A/B with the minefield hidden (one frame, everything else identical):');
console.log(`  live mines ${cost.liveMines}`);
console.log(`  draws   ${cost.withCalls} with mines -> ${cost.withoutCalls} without  (delta ${cost.withCalls - cost.withoutCalls})`);
console.log(
  `  tris    ${Math.round(cost.withTris / 1000)}k with mines -> ${Math.round(cost.withoutTris / 1000)}k without  ` +
    `(delta ${cost.withTris - cost.withoutTris})`,
);
console.log(
  `  vehicles ${cost.vehicles}, particles ${cost.particles}; ` +
    `the whole field is ${cost.withCalls - cost.withoutCalls} draw calls, whatever its size`,
);
console.log('\nLED blink, read back from instanceColor and re-derived from each mine id:');
let blinkOk = true;
for (const row of cost.blinkRows) {
  const match = Math.abs(row.actualGreen - row.expectedGreen) < 0.002;
  if (!match) blinkOk = false;
  console.log(
    `  slot ${row.slot} mine #${String(row.id).padStart(3)} rate=${row.rate} armed=${row.armed.toFixed(1)} ` +
      `green=${row.actualGreen} (expected ${row.expectedGreen}) ${match ? 'ok' : 'MISMATCH'}`,
  );
}
const rates = new Set(cost.blinkRows.map((r) => r.rate));
console.log(
  `  ${blinkOk ? 'PASS' : 'FAIL'}: colours follow sin(time * rate + phase) keyed by id; ` +
    `${rates.size} distinct rates among ${cost.blinkRows.length} sampled LEDs`,
);
if (!blinkOk) process.exitCode = 1;
