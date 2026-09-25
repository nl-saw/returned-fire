#!/usr/bin/env node
/**
 * Audio verification runner.
 *
 *   node tools/audio-report.mjs [--out shots/audio-report.json] [--port 5178]
 *
 * Opens `web/preview/audio.html` headless, waits for `window.__AUDIO_REPORT__`, prints the
 * metric tables/assertions and writes the raw report to JSON. Exits non-zero when any
 * assertion fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
const OUT = resolve(ROOT, flag('out', 'shots/audio-report.json'));
// always run our own server on a private port: other agents/harnesses use 5178
const PORT = Number(flag('port', 0)) || 5180 + Math.floor(Math.random() * 40);
const WAIT = Number(flag('wait', 120000));

const CHROME_CANDIDATES = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700) });
    return r.ok || r.status < 500;
  } catch {
    return false;
  }
}

const server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: WEB,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORCE_COLOR: '0' },
  detached: true,
});
function stopServer() {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    try {
      server.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
{
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 30000 && !up) {
    up = await portAlive(PORT);
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    console.error('vite did not start');
    stopServer();
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
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let navigated = false;
for (let attempt = 0; attempt < 4 && !navigated; attempt++) {
  try {
    await page.goto(`http://127.0.0.1:${PORT}/preview/audio.html`, { waitUntil: 'load', timeout: 20000 });
    navigated = true;
  } catch (e) {
    if (attempt === 3) {
      stopServer();
      throw e;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
let ready = true;
try {
  await page.waitForFunction('window.__READY__ === true', null, { timeout: WAIT });
} catch {
  ready = false;
}
const report = await page.evaluate('window.__AUDIO_REPORT__ ?? null');

// exercise the live path too: resume() from a real click, drive an engine + theme, then
// flood the SFX bus and check the voice cap, then check that suspend() really stops work
let live = null;
try {
  await page.click('button:has-text("auto demo")');
  await page.waitForTimeout(2000);
  const duringDemo = await page.evaluate('window.__LIVE__ ?? null');
  for (let i = 0; i < 60; i++) {
    await page.click('button:has-text("explosionBig")', { timeout: 2000 }).catch(() => {});
  }
  const flooded = await page.evaluate('window.__LIVE__ ?? null');
  await page.click('button:has-text("stop all")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("suspend")');
  await page.waitForTimeout(400);
  const suspended = await page.evaluate('window.__LIVE__ ?? null');
  await page.click('button:has-text("resume()")');
  await page.waitForTimeout(300);
  const resumed = await page.evaluate('window.__LIVE__ ?? null');
  live = {
    duringDemo,
    flooded,
    suspended,
    resumed,
    voiceCapOk: Boolean(flooded && flooded.voices <= flooded.maxVoices),
    suspendOk: Boolean(suspended && suspended.state === 'suspended'),
    resumeOk: Boolean(resumed && resumed.state === 'running'),
  };
} catch (e) {
  live = { error: String(e) };
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ report, live, logs }, null, 2));
await browser.close();
stopServer();

if (!ready || !report) {
  console.error('harness did not produce a report');
  for (const l of logs.slice(-30)) console.error(l);
  process.exit(2);
}

const pad = (s, n) => String(s).padEnd(n);
const liveFailures = [];
if (!live || live.error) liveFailures.push(`live path error: ${live ? live.error : 'no data'}`);
else {
  if (!live.voiceCapOk) liveFailures.push(`voice cap breached: ${JSON.stringify(live.flooded)}`);
  if (!live.suspendOk) liveFailures.push(`suspend() did not suspend: ${JSON.stringify(live.suspended)}`);
  if (!live.resumeOk) liveFailures.push(`resume() did not resume: ${JSON.stringify(live.resumed)}`);
}
console.log(`LIVE  ctx during demo: ${live?.duringDemo?.state} (voices ${live?.duringDemo?.voices}/${live?.duringDemo?.maxVoices})`);
console.log(`LIVE  after 60x explosionBig: voices ${live?.flooded?.voices}/${live?.flooded?.maxVoices} (cap respected: ${live?.voiceCapOk})`);
console.log(`LIVE  after suspend(): ${live?.suspended?.state}; after resume(): ${live?.resumed?.state}`);
for (const f of liveFailures) console.log(`FAIL  ${f}`);
console.log('SFX                 peak   rmsAct dB  dur ms  centroid Hz   zcr Hz');
for (const [name, r] of Object.entries(report.sfx)) {
  const m = r.metric;
  console.log(`${pad(name, 18)} ${m.peak.toFixed(3)} ${m.rmsActiveDb.toFixed(1).padStart(8)} ${m.durationMs.toFixed(0).padStart(7)} ${m.centroid.toFixed(0).padStart(11)} ${m.zcr.toFixed(0).padStart(8)}`);
}
console.log('THEME               peak   rmsAct dB  dur ms  centroid Hz   loop s  notes');
for (const [name, r] of Object.entries(report.themes)) {
  const m = r.metric;
  console.log(`${pad(name, 18)} ${m.peak.toFixed(3)} ${m.rmsActiveDb.toFixed(1).padStart(8)} ${m.durationMs.toFixed(0).padStart(7)} ${m.centroid.toFixed(0).padStart(11)} ${r.loopSeconds.toFixed(1).padStart(8)} ${String(r.noteCount).padStart(6)}`);
}
for (const p of Object.values(report.pitch)) {
  console.log(`PITCH ${pad(p.theme, 8)} ${p.ok ? 'ok  ' : 'FAIL'} ${p.expectedNames.map((n, i) => `${n}->${p.detectedHz[i].toFixed(0)}Hz`).join(' ')}`);
}
console.log(`centroid spread ${report.distinctness.minCentroid.toFixed(0)}..${report.distinctness.maxCentroid.toFixed(0)} Hz, median ${report.distinctness.medianCentroid.toFixed(0)}`);
console.log(`max band cosine ${report.distinctness.maxBandCosine.toFixed(4)} (${report.distinctness.mostSimilarPair}), pairs within 3%: ${report.distinctness.similarPairs.length}${report.distinctness.similarPairs.length ? ` [${report.distinctness.similarPairs.join(', ')}]` : ''}`);
console.log('');
for (const c of report.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
console.log(`\nreport: ${OUT}\n${report.ok && liveFailures.length === 0 ? 'ALL CHECKS PASS' : `${report.failures.length + liveFailures.length} FAILURES`}`);
process.exit(report.ok && liveFailures.length === 0 ? 0 : 2);
