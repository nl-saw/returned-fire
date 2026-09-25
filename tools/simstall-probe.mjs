#!/usr/bin/env node
/**
 * Instant-freeze hunt: which call blocks the main thread, and in what world state.
 *
 *   node tools/simstall-probe.mjs [--secs 900] [--port 5199] [--min-ms 250] [--url "..."]
 *
 * The reported freeze is instant and total (the menu stops responding too), audio keeps playing,
 * and it clears after a minute or so - the shape of one synchronous call on the main thread, not
 * of a slow renderer. Rendering is parked (`?maxframes=2`) and the world is advanced with
 * `rfStep`, which is the real fixed-step path minus drawing, so many minutes of sim time fit in
 * a few minutes of wall clock. Every per-frame method the loop calls is wrapped and any call
 * slower than `--min-ms` is recorded with the world state that produced it.
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
const SECS = Number(flag('secs', 900));
const PORT = Number(flag('port', 5199));
const MIN_MS = Number(flag('min-ms', 250));
const WAIT = Number(flag('wait', 60000));
const CHUNK = Number(flag('chunk', 300));
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
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));

await page.goto(`http://127.0.0.1:${PORT}/index.html?${QUERY}&maxframes=2`, {
  waitUntil: 'load',
  timeout: 30000,
});
await page.waitForFunction('window.__READY__ === true', null, { timeout: WAIT });

await page.evaluate((minMs) => {
  const g = window.rfGame;
  const sim = g.sim;
  const w = window;
  w.__slow = [];
  w.__calls = 0;

  const state = () => {
    let wrecks = 0;
    let alive = 0;
    const kinds = {};
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if (v.state === 2) wrecks++;
      else if (v.state === 1) alive++;
      const k = v.kind | 0;
      kinds[k] = (kinds[k] || 0) + 1;
    }
    return {
      simT: Number(g.time.toFixed(1)),
      round: sim.roundTimeLeft === undefined ? -1 : Number(sim.roundTimeLeft.toFixed(1)),
      matchState: sim.matchState,
      vehicles: sim.vehicleCount,
      alive,
      wrecks,
      kinds,
      projectiles: sim.projectileCount,
      mines: sim.mineCount,
      structures: sim.structureCount,
      turrets: sim.turretCount,
      events: sim.eventCount,
    };
  };

  // Wrap every per-frame entry point the loop uses. A freeze is one of these sitting on the
  // main thread, so the label that blows up names the subsystem outright.
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const orig = obj[name].bind(obj);
    obj[name] = function wrapped(...args) {
      const t0 = performance.now();
      try {
        return orig(...args);
      } finally {
        const ms = performance.now() - t0;
        w.__calls++;
        if (ms >= minMs) {
          w.__slow.push({ label, ms: Math.round(ms), ...state() });
          if (w.__slow.length > 200) w.__slow.shift();
        }
      }
    };
  };
  wrap(sim, 'update', 'sim.update');
  wrap(g, 'consumeEvents', 'consumeEvents');
  wrap(g, 'updateCameras', 'updateCameras');
  wrap(g.world, 'update', 'world.update');
  wrap(g.fx, 'update', 'fx.update');
  wrap(g.hud, 'update', 'hud.update');
  wrap(g, 'draw', 'draw');
  wrap(g, 'updateFlow', 'updateFlow');
}, MIN_MS);

// Drive the world with `rfStep` (fixed step, no drawing) and let the render-side per-frame
// updates run between chunks so their cost is covered too.
const t0 = Date.now();
let simT = 0;
while ((Date.now() - t0) / 1000 < SECS) {
  const done = await page.evaluate((chunk) => {
    window.rfStep(chunk);
    const g = window.rfGame;
    // One render-side frame's worth of the non-draw updates.
    g.world.update(1 / 60, g.sim, g.time);
    g.fx.update(1 / 60, g.gs.camera);
    return { simT: g.time, slow: window.__slow.length, calls: window.__calls };
  }, CHUNK);
  simT = done.simT;
  if (done.slow > 0) {
    // Report as soon as something is caught: the first stall is the interesting one.
    console.log(`caught a slow call at sim ${simT.toFixed(1)}s (after ${done.calls} calls)`);
    break;
  }
}

const out = await page.evaluate(() => ({
  slow: window.__slow,
  calls: window.__calls,
  simT: window.rfGame.time,
  state: (() => {
    const g = window.rfGame;
    const sim = g.sim;
    return {
      vehicles: sim.vehicleCount,
      projectiles: sim.projectileCount,
      structures: sim.structureCount,
      matchState: sim.matchState,
    };
  })(),
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

console.log(`sim-stall probe: ?${QUERY}&maxframes=2`);
console.log(
  `${out.calls} wrapped calls in ${((Date.now() - t0) / 1000).toFixed(0)}s wall, sim time ${out.simT.toFixed(0)}s, ` +
    `final vehicles ${out.state.vehicles} projectiles ${out.state.projectiles} structures ${out.state.structures}`,
);
console.log(`calls over ${MIN_MS} ms: ${out.slow.length}`);
for (const s of out.slow.slice(0, 20)) {
  console.log(
    `  ${s.label} took ${s.ms} ms at sim ${s.simT}s (state ${s.matchState}) veh=${s.vehicles} alive=${s.alive} ` +
      `wreck=${s.wrecks} proj=${s.projectiles} mines=${s.mines} struct=${s.structures} turrets=${s.turrets} ` +
      `events=${s.events} kinds=${JSON.stringify(s.kinds)}`,
  );
}
