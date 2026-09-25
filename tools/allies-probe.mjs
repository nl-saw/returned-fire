#!/usr/bin/env node
/**
 * CPU-allies regression harness.
 *
 *   node tools/allies-probe.mjs [--port 5178]
 *
 * Three page loads against the live web build:
 *   A. `/?auto=1&allies=1`     — a real match with the option on, probed right after boot:
 *                                team 0 must already hold its tank plus the two-hull ally
 *                                garrison (and the enemy its own).
 *   B. `/?auto=1&allies=1&warmup=180` — the same match after three minutes of combat: the
 *                                player's team must still field at least the ally force, even
 *                                if the player's own hull is down and the garage is open.
 *   C. `/?auto=1` (control)    — the warm-up match without the option: team 0 holds only the
 *                                player's hull, which is what makes B's numbers mean something.
 *
 * Starts a Vite dev server for `web/` (unless one is already listening), like shot.mjs does.
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
const PORT = Number(argv[argv.indexOf('--port') + 1] ?? 5178);

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
    detached: true,
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d.toString()));
  server.stderr.on('data', (d) => (log += d.toString()));
  if (!(await waitFor(PORT, 30000))) {
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
    '--force-device-scale-factor=1',
  ],
});

const failures = [];
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
};

async function loadAndProbe(query, settleMs) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const problems = [];
  const badResponses = [];
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // "Failed to load resource" lines duplicate the response check below (which has the URL);
    // keep every other console error.
    if (/^Failed to load resource/i.test(m.text())) return;
    problems.push(`[console] ${m.text()}`);
  });
  page.on('response', (r) => {
    // The browser's automatic favicon request 404s on the dev server; not a page problem.
    if (r.status() >= 400 && !/favicon/i.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(`http://127.0.0.1:${PORT}/?${query}`, { waitUntil: 'load', timeout: 30000 });
  try {
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 60000 });
  } catch {
    // The warm-up runs inside boot; give it a fixed settle either way.
  }
  // `__READY__` is set before the first frame runs, and the vehicle views only decode after a
  // sim update — let a few real frames land before probing (the warm-up already ran in boot).
  await page.waitForTimeout(settleMs);
  const probe = await page.evaluate(() => window.rfProbe());
  await ctx.close();
  return { probe, problems: [...problems, ...badResponses.map((b) => `[4xx] ${b}`)] };
}

// A — fresh match with the option on: tank + ally garrison already in the field.
{
  const { probe, problems } = await loadAndProbe('auto=1&allies=1&vehicle=2', 2500);
  check('A: no page errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  check('A: option flag reached the game', probe.allies === true, `allies=${probe.allies}`);
  check('A: match is running', probe.phase === 'playing', `phase=${probe.phase}`);
  check(
    'A: tank + ally garrison on team 0 at boot',
    (probe.teamHulls?.[0] ?? 0) >= 2,
    `teamHulls=${JSON.stringify(probe.teamHulls)}`,
  );
  check('A: enemy garrison intact', probe.teamHulls?.[1] === 2, `teamHulls=${JSON.stringify(probe.teamHulls)}`);
}

// B — the same match after three minutes of combat: the ally force still holds, even if the
// player's own hull is down and the garage has opened for a replacement.
{
  const { probe, problems } = await loadAndProbe('auto=1&allies=1&vehicle=2&warmup=180', 500);
  check('B: no page errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  check('B: option flag reached the game', probe.allies === true, `allies=${probe.allies}`);
  check(
    'B: match is running (garage = the player\'s hull went down in combat)',
    probe.phase === 'playing' || probe.phase === 'garage',
    `phase=${probe.phase}`,
  );
  check(
    'B: player team still fields its ally force after 180 s',
    (probe.teamHulls?.[0] ?? 0) >= 2,
    `teamHulls=${JSON.stringify(probe.teamHulls)}`,
  );
}

// C — control match without the option: team 0 holds only the player's hull.
{
  const { probe, problems } = await loadAndProbe('auto=1&vehicle=2&warmup=180', 500);
  check('C: no page errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  check('C: option flag off by default', probe.allies === false, `allies=${probe.allies}`);
  check(
    'C: control match fields no allies',
    (probe.teamHulls?.[0] ?? -1) <= 1,
    `teamHulls=${JSON.stringify(probe.teamHulls)}`,
  );
}

await browser.close();
if (server?.pid) {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
}

console.log(failures.length === 0 ? '\nALLIES PROBE: PASS' : `\nALLIES PROBE: FAIL (${failures.join('; ')})`);
process.exit(failures.length === 0 ? 0 : 1);
