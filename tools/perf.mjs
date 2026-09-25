#!/usr/bin/env node
/**
 * Live frame-rate probe.
 *
 *   node tools/perf.mjs [--qualities high,medium,low] [--port 5181] [--window 3000]
 *
 * Boots the real game path (`?auto=1`, no `?maxframes`, so the render loop keeps running),
 * then measures the browser's animation-frame cadence from inside the page. Reports the boot
 * time (page parse -> app ready) and frames per second per quality preset.
 *
 * Use it to judge a machine rather than the code: with hardware WebGL2 the presets differ
 * by a factor of two or more, whereas under a software rasteriser every preset lands in the
 * same single-digit range because per-draw-call overhead dominates the frame.
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

const PORT = Number(flag('port', 5181));
const QUALITIES = String(flag('qualities', 'high,medium,low')).split(',').map((s) => s.trim());
const WINDOW_MS = Number(flag('window', 3000));
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

const cadence = `new Promise((resolve) => {
  let n = 0;
  const t = performance.now();
  const tick = () => {
    n++;
    const dt = performance.now() - t;
    if (dt < ${WINDOW_MS}) requestAnimationFrame(tick);
    else resolve({ frames: n, ms: Math.round(dt), fps: +(n / (dt / 1000)).toFixed(1) });
  };
  requestAnimationFrame(tick);
})`;

for (const quality of QUALITIES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[boot]')) console.log(`  [page] ${t.slice(0, 140)}`);
  });

  const t0 = Date.now();
  await page
    .goto(`http://127.0.0.1:${PORT}/index.html?auto=1&quality=${quality}`, { waitUntil: 'commit', timeout: 30000 })
    .catch((e) => console.log(`  goto: ${e.message}`));

  let bootMs = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const res = await Promise.race([
      page.evaluate('typeof window.rfStats === "function"').then((v) => ({ ok: true, v })),
      sleep(2000).then(() => ({ ok: false, v: null })),
    ]);
    if (res.ok && res.v === true) {
      bootMs = Date.now() - t0;
      break;
    }
    if (!res.ok) console.log(`  ${quality}: main thread busy ${((Date.now() - t0) / 1000).toFixed(0)}s in`);
    await sleep(res.ok ? 250 : 0);
  }

  const results = [];
  for (let i = 0; i < 3 && bootMs !== null; i++) {
    const s = Date.now();
    const res = await Promise.race([page.evaluate(cadence), sleep(120000).then(() => null)]);
    const wall = Date.now() - s;
    results.push(res ? `${res.fps} fps (${res.frames} frames / ${res.ms} ms, answered +${wall - res.ms} ms)` : `blocked >${wall} ms`);
  }

  console.log(
    `${quality.padEnd(7)} boot ${bootMs === null ? '>180s' : `${bootMs} ms`}   ` +
      (results.length ? results.join('   ') : 'not measured'),
  );
  await ctx.close();
}

await browser.close();
if (server?.pid) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
}
