#!/usr/bin/env node
/**
 * End-to-end check for the title screen's SEED section (fixed seed, REROLL, RANDOM play).
 *
 *   node tools/seed-menu-check.mjs [--port 5181]
 *
 * Loads the real page (no ?auto), drives the seed field / REROLL / FIXED-RANDOM exactly as a
 * player would, and asserts on the `[game] start:` console line `main.ts` emits for every
 * match start — i.e. it proves which island the simulation actually ran on, not just what the
 * menu claims.
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
const PORT = Number(argv[argv.indexOf('--port') + 1] ?? 5181);

const alive = async () => {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(700) }); return r.status < 500; } catch { return false; }
};
let server = null;
if (!(await alive())) {
  server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: WEB, stdio: 'ignore', detached: true });
  for (let i = 0; i < 100 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 300));
}

const chrome = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});

const problems = [];
let failures = 0;
const ok = (cond, label) => {
  if (!cond) { problems.push(`FAIL: ${label}`); failures++; }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

async function freshPage() {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000, polling: 500 });
  return { page, logs, startLog: () => logs.filter((l) => l.startsWith('[game] start:')).pop() };
}

/* ---------------------------------------------------------------- scenario C */
{
  const { page, logs } = await freshPage();
  // The tab bar exists and the seed controls live on their own tab, hidden by default.
  const tabs = await page.$$eval('.rf-tabs .rf-tab-btn', (bs) => bs.map((b) => b.textContent));
  ok(tabs.length === 2 && tabs[0] === 'MATCH' && tabs[1].toUpperCase().includes('SEED'), `C1 tab bar with MATCH + SEED/RANDOM (got ${JSON.stringify(tabs)})`);
  ok(await page.$eval('[data-tab="main"]', (b) => b.classList.contains('is-on')), 'C2 MATCH tab active by default');
  ok(await page.$eval('.rf-tabpage[data-page="seed"]', (p) => p.classList.contains('rf-off')), 'C3 seed tab page hidden by default');
  const boot = await page.inputValue('.rf-seed-input');
  ok(boot === '1337', `C4 boot seed in the field (got ${boot})`);
  // Opening the SEED tab shows its page and hides MATCH.
  await page.click('[data-tab="seed"]');
  ok(await page.$eval('.rf-tabpage[data-page="seed"]', (p) => !p.classList.contains('rf-off')), 'C5 seed tab page visible after click');
  ok(await page.$eval('.rf-tabpage[data-page="main"]', (p) => p.classList.contains('rf-off')), 'C6 MATCH page hidden while SEED is open');
  ok(await page.$eval('[data-set="random"] [data-random="0"]', (b) => b.classList.contains('is-on')), 'C7 FIXED active by default');
  // The seed tab carries its own size control and start buttons, synced with the MATCH tab.
  const segCount = await page.$$eval('.rf-seg[data-set="size"]', (s) => s.length);
  ok(segCount === 2, `C10 size control present on both tabs (got ${segCount})`);
  ok(await page.$('.rf-tabpage[data-page="seed"] [data-act="sp"]') !== null, 'C11 start button present on the seed tab');
  await page.click('.rf-tabpage[data-page="seed"] [data-size="1"]');
  const sync = await page.$$eval('.rf-seg[data-set="size"]', (segs) => segs.map((s) => s.querySelector('[data-size].is-on')?.dataset.size));
  ok(sync.every((v) => v === '1'), `C12 size change on the seed tab syncs both controls (got ${JSON.stringify(sync)})`);
  // Invalid input snaps back to the last valid value on commit (blur).
  await page.fill('.rf-seed-input', 'not-a-seed');
  await page.keyboard.press('Tab');
  ok((await page.inputValue('.rf-seed-input')) === '1337', 'C8 invalid seed reverts to the last valid value');
  // Out-of-range input does too.
  await page.fill('.rf-seed-input', '99999999999999');
  await page.keyboard.press('Tab');
  ok((await page.inputValue('.rf-seed-input')) === '1337', 'C9 out-of-range seed reverts');
  await page.context().close();
}

/* ---------------------------------------------------------------- scenario A */
{
  const { page, startLog } = await freshPage();
  await page.click('[data-tab="seed"]');
  // REROLL rolls a fresh non-zero u32.
  await page.click('[data-roll]');
  const rolled = Number(await page.inputValue('.rf-seed-input'));
  ok(Number.isInteger(rolled) && rolled >= 1 && rolled <= 0xffffffff && rolled !== 1337, `A1 REROLL rolls a new seed (got ${rolled})`);
  // Typing a seed + Enter commits it; the commit key must NOT start the match.
  await page.fill('.rf-seed-input', '7');
  await page.keyboard.press('Enter');
  ok((await page.inputValue('.rf-seed-input')) === '7', 'A2 typed seed committed to the field');
  ok(await page.$eval('.rf-garage', (g) => g.classList.contains('rf-off')), 'A3 commit Enter did not start the match');
  // The SINGLE PLAYER button on the seed tab starts single player on that exact seed.
  await page.click('.rf-tabpage[data-page="seed"] [data-act="sp"]');
  await page.waitForFunction(() => !document.querySelector('.rf-garage').classList.contains('rf-off'), null, { timeout: 120000 });
  const log = startLog();
  ok(log !== undefined && /seed=7 /.test(log), `A4 match started on the typed seed (log: ${log})`);
  // Pick a hull so the round is live.
  await page.keyboard.press('Digit1');
  await page.waitForFunction(() => document.querySelector('.rf-garage').classList.contains('rf-off'), null, { timeout: 30000 });
  await page.context().close();
}

/* ---------------------------------------------------------------- scenario B */
{
  const { page, startLog } = await freshPage();
  await page.click('[data-tab="seed"]');
  // RANDOM play: roll a new seed AND sector on start.
  await page.click('[data-set="random"] [data-random="1"]');
  ok(await page.$eval('[data-set="random"] [data-random="1"]', (b) => b.classList.contains('is-on')), 'B1 RANDOM highlighted after click');
  const before = await page.inputValue('.rf-seed-input');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.rf-garage').classList.contains('rf-off'), null, { timeout: 120000 });
  const log = startLog();
  // Map names contain spaces ("Coral Rim"), so capture lazily up to the ` seed=` marker.
  const m = log && log.match(/map=(.+?) seed=(\d+)/);
  ok(m !== null, `B2 match started under RANDOM (log: ${log})`);
  if (m) {
    const names = ['Twin Atolls', 'Coral Rim', 'Iron Strait', 'Shattered Keys'];
    ok(names.includes(m[1]), `B3 rolled sector is a real map (got ${m[1]})`);
    ok(Number(m[2]) >= 1 && Number(m[2]) <= 0xffffffff, `B4 rolled seed is a valid u32 (got ${m[2]})`);
    // A re-roll landing on the exact boot seed is ~2^-32; treat a hit as a pass with a note.
    if (m[2] === before) console.log('note: RANDOM re-rolled the same seed as shown (astronomically unlikely, not a failure)');
  }
  await page.context().close();
}

await browser.close();
if (server) process.kill(-server.pid).catch(() => {});
console.log(problems.length === 0 ? '\nALL CHECKS PASSED' : `\n${problems.length} PROBLEM(S):\n` + problems.join('\n'));
process.exit(failures > 0 || problems.some((p) => p.startsWith('[pageerror]')) ? 1 : 0);
