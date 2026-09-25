#!/usr/bin/env node
/**
 * Frame-stall attribution probe.
 *
 *   node tools/stall-probe.mjs [--secs 240] [--port 5196] [--url "..."]
 *
 * The reported symptom is the whole page freezing (menu included) for a minute or more and then
 * recovering, with audio still playing - which is the main thread sitting inside one frame.
 * `rfProfile()` says the cost is in `draw`, so this wraps `Game.draw` and, for every frame that
 * takes longer than `--min-ms`, records what moved inside it: the compiled-program count, the
 * uploaded geometry/texture counts, the drawn object count and the live particle/decal counts.
 *
 * A stall where `programs` jumps is a shader compile (the renderer builds a program the first
 * time a new material configuration is drawn, and a software rasteriser takes seconds over it).
 * A stall with no counter movement is raw rasterisation: fill rate, not compilation.
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
const SECS = Number(flag('secs', 240));
const PORT = Number(flag('port', 5196));
const MIN_MS = Number(flag('min-ms', 400));
const WAIT = Number(flag('wait', 60000));
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
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));

await page.goto(`http://127.0.0.1:${PORT}/index.html?${QUERY}`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: WAIT });

await page.evaluate((minMs) => {
  const g = window.rfGame;
  const r = g.gs.renderer;
  const w = window;
  w.__stalls = [];
  w.__drawCount = 0;
  w.__drawTotal = 0;
  const orig = g.draw.bind(g);
  g.draw = function patchedDraw() {
    const t0 = performance.now();
    const p0 = r.info.programs ? r.info.programs.length : 0;
    const g0 = r.info.memory.geometries;
    const x0 = r.info.memory.textures;
    orig();
    const ms = performance.now() - t0;
    w.__drawCount++;
    w.__drawTotal += ms;
    if (ms >= minMs) {
      const fx = g.fx.stats();
      w.__stalls.push({
        simT: Number(g.time.toFixed(2)),
        ms: Math.round(ms),
        programs: [p0, r.info.programs ? r.info.programs.length : 0],
        geoms: [g0, r.info.memory.geometries],
        textures: [x0, r.info.memory.textures],
        particles: fx.particles,
        decals: fx.decals,
        fxDraws: fx.drawCalls,
        vehicles: g.sim.vehicleCount,
      });
      if (w.__stalls.length > 400) w.__stalls.shift();
    }
  };
}, MIN_MS);

const t0 = Date.now();
await new Promise((r) => setTimeout(r, SECS * 1000));
const out = await page.evaluate(() => ({
  stalls: window.__stalls,
  draws: window.__drawCount,
  total: Math.round(window.__drawTotal),
  simT: window.rfGame.time,
  programs: window.rfGame.gs.renderer.info.programs.length,
  geoms: window.rfGame.gs.renderer.info.memory.geometries,
  textures: window.rfGame.gs.renderer.info.memory.textures,
}));

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

const wall = (Date.now() - t0) / 1000;
console.log(`stall probe: ?${QUERY}`);
console.log(
  `draws ${out.draws} in ${wall.toFixed(0)}s wall (sim ${out.simT.toFixed(0)}s), avg ${(out.total / Math.max(1, out.draws)).toFixed(0)} ms, ` +
    `programs ${out.programs} geoms ${out.geoms} textures ${out.textures}`,
);
const stalls = out.stalls;
console.log(`slow frames (>= ${MIN_MS} ms): ${stalls.length}`);
const compile = stalls.filter((s) => s.programs[1] > s.programs[0]);
console.log(`  of those, ${compile.length} compiled a new program inside the frame`);
for (const s of stalls.slice(0, 25)) {
  console.log(
    `  sim=${String(s.simT).padStart(7)}s draw=${(s.ms / 1000).toFixed(2)}s ` +
      `prog=${s.programs[0]}->${s.programs[1]} geo=${s.geoms[0]}->${s.geoms[1]} tex=${s.textures[0]}->${s.textures[1]} ` +
      `parts=${s.particles} decals=${s.decals} veh=${s.vehicles}`,
  );
}
