#!/usr/bin/env node
/**
 * Mine-pool overflow probe: the freeze that arrives with a minefield.
 *
 *   node tools/minecap-probe.mjs [--secs 600] [--port 5201] [--url "..."]
 *
 * `World::drop_mine` has no global cap - a hull lays `mine_max` mines (ten per HRSV) and
 * resupply refills it - while the JS side keeps a pooled view per mine. When the field outgrew
 * that pool, `Sim.decode` wrote through `undefined` *inside* `Sim.update`, so the exception
 * aborted the rest of the frame: no camera, no world sync, no draw, no HUD. That is the report:
 * a frozen picture with the music still playing, clearing by itself once mines detonated back
 * under the pool size.
 *
 * Renders nothing (`?maxframes=2` parks the loop) and advances the world with `rfStep`, so the
 * whole episode fits in a couple of minutes of wall clock. Reports the mine count over sim time,
 * every exception the update raises, and whether the frame recovers.
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
const PORT = Number(flag('port', 5201));
const WAIT = Number(flag('wait', 60000));
const CHUNK = Number(flag('chunk', 120));
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

/** Step `frames` frames, one at a time so a throw is attributed to the frame that caused it. */
await page.evaluate(() => {
  const g = window.rfGame;
  const w = window;
  w.__mine = { samples: [], errors: [], maxMines: 0, frames: 0, recoveredAt: -1 };
  w.__step = (frames) => {
    for (let i = 0; i < frames; i++) {
      let error = null;
      try {
        w.rfStep(1);
      } catch (e) {
        error = String((e && e.message) || e);
      }
      w.__mine.frames++;
      const mines = g.sim.game.mines_len();
      if (mines > w.__mine.maxMines) w.__mine.maxMines = mines;
      if (error) {
        if (w.__mine.errors.length < 40) {
          w.__mine.errors.push({ simT: Number(g.time.toFixed(2)), mines, error });
        }
        w.__mine.lastErrorAt = g.time;
      } else if (w.__mine.errors.length && w.__mine.recoveredAt < 0) {
        w.__mine.recoveredAt = Number(g.time.toFixed(2));
      }
      if (w.__mine.frames % 60 === 0) {
        w.__mine.samples.push({ simT: Number(g.time.toFixed(1)), mines, veh: g.sim.vehicleCount });
      }
    }
  };
});

const t0 = Date.now();
let simT = 0;
while ((Date.now() - t0) / 1000 < SECS) {
  const done = await page.evaluate((chunk) => {
    window.__step(chunk);
    return { simT: window.rfGame.time, errors: window.__mine.errors.length };
  }, CHUNK);
  simT = done.simT;
  if (done.errors > 20) break; // the failure mode is characterised; no need to grind
}

const out = await page.evaluate(() => ({
  mine: window.__mine,
  simT: window.rfGame.time,
  mineCount: window.rfGame.sim.game.mines_len(),
  minePool: window.rfGame.sim.mines.length,
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

console.log(`mine-pool probe: ?${QUERY}&maxframes=2`);
console.log(
  `${out.mine.frames} frames stepped in ${((Date.now() - t0) / 1000).toFixed(0)}s wall, sim time ${out.simT.toFixed(0)}s, ` +
    `peak live mines ${out.mine.maxMines}, view pool now ${out.minePool}`,
);
const samples = out.mine.samples;
console.log('mine count over sim time:');
for (let i = 0; i < samples.length; i += Math.max(1, Math.floor(samples.length / 12))) {
  const s = samples[i];
  console.log(`  sim ${String(s.simT).padStart(6)}s mines=${String(s.mines).padStart(4)} vehicles=${s.veh}`);
}
if (out.mine.errors.length) {
  console.log(`\nupdate() threw on ${out.mine.errors.length}${out.mine.errors.length >= 40 ? '+' : ''} frames:`);
  for (const e of out.mine.errors.slice(0, 6)) {
    console.log(`  sim ${e.simT}s with ${e.mines} mines live: ${e.error}`);
  }
  if (out.mine.recoveredAt >= 0) console.log(`recovered at sim ${out.mine.recoveredAt}s once the field shrank`);
  console.log('\nFAIL: the frame dies once the minefield outgrows the view pool');
  process.exit(1);
}
console.log('\nPASS: no frame was lost - the mine pool grew with the field');
