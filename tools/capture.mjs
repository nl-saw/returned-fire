#!/usr/bin/env node
/**
 * Render-and-capture harness for headless visual iteration.
 *
 *   node tools/capture.mjs <page-path-and-query> <out.png> [--w 1280] [--h 720] [--boot 240000]
 *
 * Unlike tools/shot.mjs this does not rely on the compositor: the page exposes
 * `window.rfCapture()` which renders one frame synchronously and returns a PNG data URL.
 * Software WebGL (SwiftShader) renders this scene at well under 1 fps, so waiting for a
 * browser screenshot would time out.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB = resolve(ROOT, 'web');
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const pagePath = positional[0] ?? 'index.html?auto=1';
const outPath = resolve(ROOT, positional[1] ?? 'shots/capture.png');
const W = Number(flag('w', 1280));
const H = Number(flag('h', 720));
const BOOT = Number(flag('boot', 240000));
const PORT = Number(flag('port', 5181));

const alive = async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(700) }); return r.status < 500; } catch { return false; } };
let server = null;
if (!(await alive())) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: WEB,
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 300));
}

const chrome = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--hide-scrollbars'],
});
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
const problems = [];
const t0 = Date.now();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text().slice(0, 400)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 400)}`));

await page.goto(`http://127.0.0.1:${PORT}/${pagePath.replace(/^\/+/, '')}`, { waitUntil: 'load', timeout: 60000 });
let ready = true;
try { await page.waitForFunction('typeof window.rfCapture === "function"', null, { timeout: BOOT, polling: 500 }); }
catch { ready = false; }
let probe = null;
try { probe = await page.evaluate('window.rfProbe ? window.rfProbe() : null'); } catch (e) { probe = { probeError: String(e) }; }
let stats = null;
try { stats = await page.evaluate('window.rfStats ? window.rfStats() : null'); } catch { stats = null; }
// Give the game a couple of real frames before grabbing the buffer.
await page.waitForTimeout(Number(flag('settle', 4000)));
let dataUrl = null;
try { dataUrl = await page.evaluate('window.rfCapture ? window.rfCapture() : null'); } catch (e) { problems.push(`[capture] ${e}`); }
// `--dom` additionally grabs the composited page, which is the only way to include the
// DOM HUD. It needs the render loop parked (`?maxframes=N`) or SwiftShader starves it.
if (argv.includes('--dom')) {
  try {
    await page.screenshot({ path: outPath.replace(/\.png$/, '-dom.png'), timeout: 180000, animations: 'disabled' });
    console.log(`dom screenshot: ${outPath.replace(/\.png$/, '-dom.png')}`);
  } catch (e) {
    problems.push(`[dom-shot] ${String(e).slice(0, 200)}`);
  }
}
console.log(`dataUrl: ${dataUrl ? `${String(dataUrl).length} chars` : 'null'}`);
if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
}
await browser.close();
if (server?.pid) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
}
console.log(`capture: ${outPath} (${W}x${H}) ready=${ready} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('probe:', JSON.stringify(probe));
if (stats) console.log('render:', JSON.stringify(stats));
if (problems.length) { console.log('--- page problems ---'); for (const p of problems.slice(0, 25)) console.log(p); }
process.exit(dataUrl && ready ? 0 : 2);
