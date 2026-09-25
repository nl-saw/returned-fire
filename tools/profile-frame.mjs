#!/usr/bin/env node
/**
 * Per-phase frame cost probe.
 *
 *   node tools/profile-frame.mjs [--quality high] [--map 0] [--size small|medium|big]
 *                                [--window 30000] [--port 5183] [--two 0] [--sandbox 0]
 *
 * Boots a live match (`?auto=1&vehicle=1&demo=1`: the autopilot drives and fires against the
 * CPU), lets it run for `--window` ms of wall clock, then reports the per-phase average frame
 * cost from `window.rfProfile()` plus draw calls / triangles from `rfStats()`. The render cap
 * is 20 fps so a software rasteriser still collects a useful sample in reasonable wall time.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
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

// A unique port per run: reusing a stale dev server from an earlier probe can full-reload the
// page mid-run (HMR) and destroy the evaluation context, so never inherit one.
const PORT = Number(flag('port', 0)) || 5183 + Math.floor(Math.random() * 64);
const QUALITY = String(flag('quality', 'high'));
const MAP = String(flag('map', '0'));
const SIZE = String(flag('size', 'small'));
const WINDOW_MS = Number(flag('window', 30000));
const TWO = flag('two', '0') === '1';
const SANDBOX = flag('sandbox', '0') === '1';
const W = Number(flag('w', 1152));
const H = Number(flag('h', 648));

const portAlive = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(700) });
    return r.status < 500;
  } catch {
    return false;
  }
};

let server = null;
if (!(await portAlive())) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: WEB,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  for (let i = 0; i < 60 && !(await portAlive()); i++) await sleep(300);
}
if (!(await portAlive())) {
  console.error('vite did not start');
  process.exit(1);
}

const chrome = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  .filter(Boolean)
  .find((p) => existsSync(p));
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
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
  ],
});

const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[boot]')) console.log(`  [page] ${t.slice(0, 160)}`);
});

const url =
  `http://127.0.0.1:${PORT}/index.html?auto=1&vehicle=1&demo=1&fps=20` +
  `&quality=${QUALITY}&map=${MAP}&size=${SIZE}${TWO ? '&two=1&vehicle2=4' : ''}${SANDBOX ? '&sandbox=1' : ''}`;

const t0 = Date.now();
await page.goto(url, { waitUntil: 'commit', timeout: 30000 }).catch((e) => console.log(`  goto: ${e.message}`));

const deadline = Date.now() + 180000;
let ready = false;
while (Date.now() < deadline) {
  const res = await Promise.race([
    page.evaluate('typeof window.rfProfile === "function"').then((v) => ({ ok: true, v })),
    sleep(2000).then(() => ({ ok: false, v: null })),
  ]);
  if (res.ok && res.v === true) {
    ready = true;
    break;
  }
  if (!res.ok) console.log(`  main thread busy ${((Date.now() - t0) / 1000).toFixed(0)}s in`);
  await sleep(res.ok ? 250 : 0);
}
if (!ready) {
  console.error('page never became ready');
  process.exit(1);
}
const bootMs = Date.now() - t0;

// Let the match run: vehicles deploy, the autopilot drives and fires, the CPU fields its own
// force. Then read the phase averages accumulated by the frame loop.
await sleep(WINDOW_MS);
const out = await page.evaluate(() => {
  const p = window.rfProfile();
  const s = window.rfStats();
  const c = typeof window.rfCensus === 'function' ? window.rfCensus() : null;
  return { ...p, stats: s, census: c };
});

console.log(
  `${QUALITY} ${SIZE} map=${MAP}${TWO ? ' two' : ''}${SANDBOX ? ' sandbox' : ''}: boot ${bootMs} ms, ` +
    `sampled ${out.frames} frames over ${WINDOW_MS / 1000}s`,
);
console.log(`  total ${out.totalMs.toFixed(2)} ms/frame   drawCalls=${out.stats.drawCalls} triangles=${out.stats.triangles}`);
for (const [k, v] of Object.entries(out.phases)) {
  const bar = '#'.repeat(Math.min(60, Math.round((v / out.totalMs) * 60)));
  console.log(`  ${k.padEnd(8)} ${String(v.toFixed(3)).padStart(9)} ms  ${bar}`);
}
if (out.census) {
  const totalMeshes = out.census.reduce((a, c) => a + c.meshes, 0);
  console.log(`  scene census (${totalMeshes} meshes):`);
  for (const c of out.census.slice(0, 25)) {
    console.log(`    ${c.name.padEnd(28)} meshes=${String(c.meshes).padStart(5)} tris=${c.tris}`);
  }
}

await browser.close();
if (server?.pid) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
  // Verify the port is actually free; a leaked dev server would poison the next probe.
  for (let i = 0; i < 25 && (await portAlive()); i++) await sleep(200);
  if (await portAlive()) console.warn(`  warning: vite on :${PORT} did not die (pid ${server.pid})`);
}
