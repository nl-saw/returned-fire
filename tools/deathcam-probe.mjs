#!/usr/bin/env node
/**
 * Death-cam probe: the camera must watch the wreck of the hull the player *just* lost.
 *
 * The bug it pins down: a dead slot is re-fielded long before its last wreck stops burning
 * (`WRECK_TIME` 14 s against a rebuild of 60 % of the hull's build time — 7.2 s for a
 * helicopter — and the demo re-fields the instant the 3 s cam expires), so two wrecks of the
 * same slot routinely coexist. The core appends hulls in spawn order and never reorders, so the
 * stale wreck comes first in `sim.vehicles`; the old `startDeathCam` armed on the head of the
 * list and the camera followed the *previous* wreck whenever a hull died twice in quick
 * succession.
 *
 * Phase 1 replays that exact shape against the real method with a controlled vehicle list, so
 * it is deterministic and needs no kill to happen. Phase 2 (optional) watches the demo the
 * reported config runs and flags any frame where the cam is armed on something other than the
 * newest wreck of the player's slot. Phase 3 drives the whole thing end to end on the reported
 * config with the render loop parked: it kills the player's hull through the sim's own debug
 * seam, waits out the cam, re-fields the slot, kills the fresh hull while the first wreck is
 * still burning, and checks both the cam's target and the camera's focus point.
 *
 *   node tools/deathcam-probe.mjs [--port 5181] [--live 90]
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
const PORT = Number(flag('port', 5181));
/** Optional wall-clock demo observation (phase 2). Slow and only fires on a lucky death. */
const LIVE = Number(flag('live', 0));
const WAIT = Number(flag('wait', 20000));

/** The configuration the double death was reported on. */
const QUERY = 'auto=1&seed=11&vehicle=4&size=small&allies=1&demo=1&maxveh=16&cpu=hard';

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
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[console] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

const failures = [];
await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}`, { waitUntil: 'load', timeout: 30000 });
try {
  await page.waitForFunction('window.__READY__ === true', null, { timeout: WAIT });
} catch {
  failures.push('the game never reported __READY__');
}

/* ---- phase 1: the reported shape, replayed against the real method ---------------------- */
let phase1 = null;
if (failures.length === 0) {
  phase1 = await page.evaluate(() => {
    const g = window.rfGame;
    const sim = g.sim;
    const WRECK = 2;
    const ACTIVE = 1;
    const savedCount = sim.vehicleCount;
    const saved = sim.vehicles.slice(0, savedCount);
    const load = (list) => {
      sim.vehicles.length = 0;
      for (const v of list) {
        sim.vehicles.push({ id: v.id, state: v.state ?? WRECK, buildT: v.buildT, x: 0, y: 0, z: 0 });
      }
      sim.vehicleCount = list.length;
    };
    const results = [];
    const check = (name, list, deathWreck, expectArmed, slotIndex = 0) => {
      load(list);
      g.deathWreck = deathWreck;
      g.deathT = 0;
      g.startDeathCam(slotIndex);
      results.push({ name, armed: g.deathWreck, deathT: Number(g.deathT.toFixed(3)), expectArmed });
    };
    try {
      // The regression: the stale wreck comes first in the list, the fresh one second.
      check('stale-then-fresh', [{ id: 10, buildT: 1 }, { id: 25, buildT: 1 }], -1, 25);
      // The re-arm guard still has to hold on the wreck already being watched.
      check('same-wreck-no-rearm', [{ id: 10, buildT: 1 }, { id: 25, buildT: 1 }], 25, 25);
      // ...and must not silently swallow a *different*, newer wreck.
      check('fresh-wreck-rearms', [{ id: 10, buildT: 1 }, { id: 25, buildT: 1 }], 10, 25);
      // A lone wreck still arms.
      check('single-wreck', [{ id: 10, buildT: 1 }], -1, 10);
      check('single-wreck-no-rearm', [{ id: 10, buildT: 1 }], 10, 10);
      // Other slots and AI hulls are not the player's corpse.
      check('other-slot-newer', [{ id: 10, buildT: 1 }, { id: 99, buildT: 2 }, { id: 25, buildT: 1 }], -1, 25);
      check('ai-slot-ignored', [{ id: 77, buildT: 0 }], -1, -1);
      check('no-wreck-at-all', [{ id: 77, buildT: 1, state: ACTIVE }], -1, -1);
    } finally {
      sim.vehicles.length = 0;
      for (const v of saved) sim.vehicles.push(v);
      sim.vehicleCount = savedCount;
    }
    return results;
  });
}

/* ---- phase 2: watch the reported config for a real double death ------------------------- */
const live = { samples: 0, armed: 0, mismatches: [], deaths: [] };
if (failures.length === 0 && LIVE > 0) {
  const CHUNK_FRAMES = 15;
  const t0 = Date.now();
  let lastArmed = -1;
  while (Date.now() - t0 < LIVE * 1000) {
    await page.evaluate((n) => window.rfStep(n), CHUNK_FRAMES);
    await new Promise((r) => setTimeout(r, 120));
    const st = await page.evaluate(() => {
      const g = window.rfGame;
      const sim = g.sim;
      const wrecks = [];
      for (let i = 0; i < sim.vehicleCount; i++) {
        const v = sim.vehicles[i];
        if (v.state === 2 && Math.round(v.buildT) === 1) wrecks.push({ id: v.id, left: v.wreck });
      }
      return {
        time: g.time,
        deathWreck: g.deathWreck,
        deathT: g.deathT,
        wrecks,
        alive: sim.vehicles.some((v) => v.state === 1 && Math.round(v.buildT) === 1) ? 1 : 0,
      };
    });
    live.samples++;
    if (st.wrecks.length > 1) live.deaths.push({ t: st.time, wrecks: st.wrecks.map((w) => w.id) });
    if (st.deathT > 0) {
      live.armed++;
      const newest = Math.max(-1, ...st.wrecks.map((w) => w.id));
      if (st.deathWreck !== newest) {
        live.mismatches.push({
          t: Number(st.time.toFixed(1)),
          watching: st.deathWreck,
          newest,
          wrecks: st.wrecks.map((w) => w.id),
        });
      }
      if (st.deathWreck !== lastArmed) {
        lastArmed = st.deathWreck;
      }
    } else {
      lastArmed = -1;
    }
  }
}

/* ---- phase 3: the same two deaths, driven end to end on the reported config ------------- */
let phase3 = null;
if (failures.length === 0) {
  // Phase 1/2's page is still rendering a full 3D scene on the software rasteriser, which starves
  // the next page's boot: let it go before opening the deterministic one.
  await page.close();
  // `?maxframes=2` parks the rAF loop, so every step below is ours and the sequence is
  // reproducible. `rfStep` is the real frame path: it runs `startDeathCam`, `cameraTarget` and
  // `updateCameras`, so the camera's focus point shows what the player would actually see.
  const page3 = await ctx.newPage();
  try {
    await page3.goto(`http://127.0.0.1:${PORT}/index.html?${QUERY}&maxframes=2`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    await page3.waitForFunction('window.__READY__ === true', null, { timeout: Math.max(WAIT, 45000) });
    phase3 = await page3.evaluate(() => {
      const g = window.rfGame;
      const sim = g.sim;
      const core = sim.game;
      const step = (n) => window.rfStep(n);
      const wrecksOfSlot = () => {
        const out = [];
        for (let i = 0; i < sim.vehicleCount; i++) {
          const v = sim.vehicles[i];
          if (v.state === 2 && Math.round(v.buildT) === 1) out.push({ i, id: v.id, x: v.x, z: v.z });
        }
        return out;
      };
      const liveHull = () => {
        for (let i = 0; i < sim.vehicleCount; i++) {
          const v = sim.vehicles[i];
          if (v.state === 1 && Math.round(v.buildT) === 1) return { i, id: v.id, x: v.x, z: v.z };
        }
        return null;
      };
      const focus = () => ({ x: g.focus.x, z: g.focus.z });

      // The demo fields the slot's opening hull on the first ticks.
      let first = liveHull();
      for (let t = 0; !first && t < 900; t++) {
        step(1);
        first = liveHull();
      }
      if (!first) return { error: 'the player slot never got a hull to lose' };

      // Death one.
      core.debug_kill_vehicle(first.i);
      step(2);
      const armA = { deathWreck: g.deathWreck, deathT: Number(g.deathT.toFixed(3)), focus: focus(), wrecks: wrecksOfSlot() };

      // Ride out the three seconds (the demo re-fields on its own only when the rAF flow runs,
      // and it is parked here, so the re-field below is explicit).
      step(200);
      const afterCam = { deathT: g.deathT, deathWreck: g.deathWreck };

      // Re-field, then wait for the fresh hull to arrive — the point of the bug is that the old
      // wreck is still burning when it does.
      sim.requestVehicle(0, 4);
      let second = null;
      let waited = 0;
      while (!second && waited < 1200) {
        step(1);
        waited++;
        second = liveHull();
      }
      if (!second) return { error: 'the slot never got a second hull', waited, afterCam };
      const coexisting = wrecksOfSlot();

      // Death two, inside the old wreck's 14 s burn.
      core.debug_kill_vehicle(second.i);
      step(2);
      const armB = {
        deathWreck: g.deathWreck,
        deathT: Number(g.deathT.toFixed(3)),
        focus: focus(),
        wrecks: wrecksOfSlot(),
      };
      return {
        first: { id: first.id, x: first.x, z: first.z },
        second: { id: second.id, x: second.x, z: second.z },
        waitedFrames: waited,
        armA,
        afterCam,
        coexisting,
        armB,
      };
    });
  } catch (e) {
    failures.push(`phase 3 could not run: ${e.message}`);
  }
  await page3.close();
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

/* ---- report ----------------------------------------------------------------------------- */
console.log(`deathcam probe: port=${PORT} url=?${QUERY}`);
if (phase1) {
  console.log('phase 1: reported shape replayed against startDeathCam()');
  for (const r of phase1) {
    const ok = r.armed === r.expectArmed;
    if (!ok) {
      failures.push(
        `${r.name}: startDeathCam armed on wreck ${r.armed}, expected ${r.expectArmed}` +
          (r.expectArmed >= 0 ? '' : ' (nothing)'),
      );
    }
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(22)} armed=${String(r.armed).padStart(4)} deathT=${r.deathT} expect=${r.expectArmed}`,
    );
  }
}
if (LIVE > 0) {
  console.log(
    `phase 2: ${live.samples} samples over ${LIVE}s of demo; ${live.armed} watched ` +
      `(coexisting-wreck frames: ${live.deaths.length})`,
  );
  for (const d of live.deaths.slice(0, 6)) {
    console.log(`  t=${String(d.t.toFixed(1)).padStart(6)}s two wrecks on slot 0: [${d.wrecks.join(', ')}]`);
  }
  for (const m of live.mismatches.slice(0, 6)) {
    failures.push(
      `t=${m.t}s the cam watched wreck ${m.watching} while the newest wreck of the slot was ${m.newest} ` +
        `(wrecks [${m.wrecks.join(', ')}])`,
    );
  }
}
if (phase3) {
  if (phase3.error) {
    failures.push(`phase 3: ${phase3.error}`);
  } else {
    const { first, second, armA, afterCam, coexisting, armB } = phase3;
    const ids = (list) => list.map((w) => w.id);
    const newer = armB.wrecks.find((w) => w.id === second.id);
    const focusErrNew = newer ? Math.hypot(armB.focus.x - newer.x, armB.focus.z - newer.z) : Infinity;
    const old = armB.wrecks.find((w) => w.id === first.id);
    const focusErrOld = old ? Math.hypot(armB.focus.x - old.x, armB.focus.z - old.z) : Infinity;
    console.log('phase 3: two real deaths on the reported config (render loop parked)');
    console.log(
      `  hull #${first.id} killed -> cam armed on ${armA.deathWreck} (deathT ${armA.deathT}s), ` +
        `wrecks [${ids(armA.wrecks)}]`,
    );
    console.log(`  after 3 s: deathT=${afterCam.deathT} deathWreck=${afterCam.deathWreck}`);
    console.log(
      `  re-fielded in ${phase3.waitedFrames} frames; hull #${second.id} spawned while wreck(s) ` +
        `[${ids(coexisting)}] were still burning`,
    );
    console.log(
      `  hull #${second.id} killed -> cam armed on ${armB.deathWreck} (deathT ${armB.deathT}s), ` +
        `wrecks [${ids(armB.wrecks)}]`,
    );
    console.log(
      `  camera focus ${focusErrNew.toFixed(2)} m from wreck #${second.id}, ` +
        `${Number.isFinite(focusErrOld) ? focusErrOld.toFixed(2) + ' m from #' + first.id : 'old wreck culled'}`,
    );
    if (armA.deathWreck !== first.id) failures.push(`phase 3: the first death armed on ${armA.deathWreck}, not #${first.id}`);
    if (afterCam.deathT !== 0) failures.push(`phase 3: the 3 s cam never expired (deathT ${afterCam.deathT})`);
    if (!ids(coexisting).includes(first.id)) {
      console.log('  note: the first wreck was culled before the re-field, so this run did not overlap');
    }
    if (armB.deathWreck !== second.id) {
      failures.push(
        `phase 3: the second death armed the cam on wreck ${armB.deathWreck} instead of the new wreck #${second.id}`,
      );
    }
    if (focusErrNew > 1.0) {
      failures.push(`phase 3: the camera focus was ${focusErrNew.toFixed(2)} m off the new wreck #${second.id}`);
    }
    if (Number.isFinite(focusErrOld) && focusErrOld < focusErrNew) {
      failures.push(`phase 3: the camera focus sat closer to the stale wreck #${first.id}`);
    }
  }
}
for (const p of problems.slice(0, 5)) failures.push(p);

if (failures.length) {
  console.log('\nFAIL');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\nPASS: the death cam arms on the newest wreck of the player slot');
