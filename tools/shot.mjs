#!/usr/bin/env node
/**
 * Headless screenshot harness.
 *
 *   node tools/shot.mjs <page-path> <out.png> [--w 1600] [--h 900] [--wait 6000] [--port 5178]
 *   node tools/shot.mjs src/preview/terrain.html shots/terrain.png
 *
 * Starts a Vite dev server for `web/` (unless one is already listening), opens the page in
 * headless Chromium with SwiftShader WebGL, waits for `window.__READY__ === true` (or the
 * timeout), writes a PNG and prints any console errors / page errors it saw.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

const pagePath = positional[0] ?? 'index.html';
const outPath = resolve(ROOT, positional[1] ?? 'shots/shot.png');
const W = Number(flag('w', 1600));
const H = Number(flag('h', 900));
const WAIT = Number(flag('wait', 9000));
const PORT = Number(flag('port', 5178));
const SETTLE = Number(flag('settle', 1200));

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

async function waitFor(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await portAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let server = null;
if (!(await portAlive(PORT))) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: WEB,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
    // Own process group: killing pnpm alone leaves its vite child running forever, which
    // leaked 23 dev servers before this was fixed.
    detached: true,
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d.toString()));
  server.stderr.on('data', (d) => (log += d.toString()));
  const ok = await waitFor(PORT, 30000);
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
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
  ],
});

const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') problems.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => problems.push(`[404?] ${r.url()} ${r.failure()?.errorText ?? ''}`));

const url = `http://127.0.0.1:${PORT}/${pagePath.replace(/^\/+/, '')}`;
let status = 'ok';
try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  try {
    await page.waitForFunction('window.__READY__ === true', null, { timeout: WAIT });
  } catch {
    status = 'timeout-waiting-ready';
  }
  await page.waitForTimeout(SETTLE);
} catch (e) {
  status = `nav-error: ${e.message}`;
}

mkdirSync(dirname(outPath), { recursive: true });
await page.screenshot({ path: outPath });
await browser.close();
if (server?.pid) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
}

console.log(`screenshot: ${outPath} (${W}x${H}) status=${status}`);
if (problems.length) {
  console.log('--- page problems ---');
  for (const p of problems.slice(0, 40)) console.log(p);
} else {
  console.log('no console errors');
}
process.exit(status === 'ok' ? 0 : 2);
