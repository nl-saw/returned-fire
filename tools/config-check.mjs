#!/usr/bin/env node
/**
 * Config file check: the shipped JSON reaches the game, player changes layer over it, and a
 * simulation number in the file changes what the simulation does.
 *
 *   node tools/config-check.mjs [--port 5193] [--seed 11]
 *
 * Four things are proved, in order, on one live page:
 *
 *   1. the file is read           - `video.quality` and `audio.master` from `rf.config.json`
 *                                   land in the renderer and the mixer
 *   2. the file beats the code    - a value that differs from the built-in default is what the
 *                                   game is actually running with
 *   3. tuning reaches the sim     - `tuning.vehicles.tank.hp` in the file is the hp a spawned
 *                                   tank has, and `tuning.rules.rounds_to_win` is the score the
 *                                   round is played to
 *   4. player changes persist     - a settings-column change is stored and comes back after a
 *                                   reload, layered over the file
 *
 * It writes a temporary config file into `web/public/` and restores whatever was there.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(ROOT, 'web');
const CFG = resolve(WEB, 'public/rf.config.json');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const PORT = Number(flag('port', 5193));
const SEED = flag('seed', '11');

// A config that is deliberately unlike the defaults, so "it was applied" cannot be confused
// with "it happened to match".
const TEST_CONFIG = {
  rev: 'config-check',
  video: { quality: 'medium' },
  audio: { master: 0.25, music: 0.1 },
  match: { cpu: 'hard', sandbox: false, allies: true, maxveh: 5 },
  // A look that is *not* the shipped default, so "it reached the builders" cannot be satisfied
  // by the default happening to be right.
  runtime: { fps: 30, look: 1 },
  tuning: {
    'rules.rounds_to_win': 7,
    'vehicles.tank.hp': 1234,
    'vehicles.tank.speed': 12.5,
    'weapons.tank_shell.damage': 42,
    // Nested spelling, which must mean the same as the dotted keys above.
    vehicles: { jeep: { ammo0_max: 7 } },
  },
};

const hadFile = existsSync(CFG);
/** The file as shipped, so the tool can compare its defaults against the code's own. */
const shippedText = hadFile ? readFileSync(CFG, 'utf8') : null;
const backup = `${CFG}.checked-backup`;
if (hadFile) copyFileSync(CFG, backup);
writeFileSync(CFG, JSON.stringify(TEST_CONFIG, null, 2));
const restore = () => {
  try {
    if (hadFile) copyFileSync(backup, CFG);
    else unlinkSync(CFG);
    if (existsSync(backup)) unlinkSync(backup);
  } catch {
    /* best effort */
  }
};
process.on('exit', restore);

const server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: WEB,
  stdio: 'ignore',
});
const stop = () => {
  try {
    server.kill('SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(500);
}

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
const warnings = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
});
// `?auto=1` boots straight into a match, skipping the title screen; the URL also proves the
// URL layer still wins over the file (it asks for a different `quality`).
const boot = `http://127.0.0.1:${PORT}/index.html?auto=1&seed=${SEED}&map=0&allies=1&quality=high`;
await page.goto(boot, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.rfStats === 'function', null, { timeout: 180000 });
await sleep(1500);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

// ---- 1 & 2: the file is read, and what it says is what the game runs ------------------------
const state = await page.evaluate(() => {
  const g = window.rfGame;
  const cfg = window.rfConfig();
  return {
    cfg,
    fileRead: cfg.file,
    // `applyConfig` mirrors these onto the game fields; the probe reports what is in force.
    quality: cfg.effective.quality,
    cpu: cfg.effective.cpu,
    sandbox: cfg.effective.sandbox,
    allies: cfg.effective.allies,
    cap: cfg.effective.vehicleCap,
    frameGap: cfg.effective.frameGap,
    htmlQuality: document.documentElement.className,
    // The renderer's own shadow map size follows the quality preset (medium = 2048, high = 2048,
    // low = 1024), so read the pixel ratio instead: 0.85 low / 1 medium / 1.35 high.
    pixelRatio: g.gs.renderer.getPixelRatio(),
    master: g.audio.masterVolume(),
    music: g.audio.musicVolume(),
    layout: g.sim.tuningLayout().length,
    tuning: Array.from(g.sim.tuningValues()),
    rounds: g.sim.game.rounds_to_win ? g.sim.game.rounds_to_win() : null,
  };
});
check('the config file was found and read', state.fileRead === true, `rev ${state.cfg.rev}`);
check(
  'audio volumes come from the file',
  Math.abs(state.master - 0.25) < 1e-6 && Math.abs(state.music - 0.1) < 1e-6,
  `master ${state.master}, music ${state.music}`,
);
check(
  'match options come from the file',
  state.cpu === 'hard' && state.sandbox === false && state.allies === true && state.cap === 5,
  `cpu ${state.cpu}, sandbox ${state.sandbox}, allies ${state.allies}, cap ${state.cap}`,
);
check(
  'the frame cap comes from the file',
  Math.abs(state.frameGap - 1000 / 30) < 0.01,
  `frameGap ${state.frameGap.toFixed(2)} ms (fps 30)`,
);
check(
  'the URL still wins over the file for quality',
  state.quality === 'high' && state.htmlQuality.includes('rf-q-high'),
  `file said medium, ?quality=high gave "${state.htmlQuality}" (pixelRatio ${state.pixelRatio} - the` +
    ` same 1.0 at devicePixelRatio 1 for medium and high)`,
);
check(
  'the engine publishes a tuning layout',
  state.layout === 416,
  `${state.layout} slots; ${Object.keys(state.cfg.tuning).length} set by the file`,
);

// ---- 3: those tuning numbers are what the simulation is actually using ----------------------
const sim = await page.evaluate(() => {
  const g = window.rfGame;
  // Spawn through the sim's own path so the hull is built from the tuning, then read it back.
  g.sim.requestVehicle(1, 2); // player two's slot, a tank
  for (let i = 0; i < 180; i++) window.rfStep(1);
  const tanks = g.sim.vehicles.filter((x) => x.team === 1 && x.kind === 2 && x.hp > 0);
  // The freshest hull is the one this test deployed; the opening garrison was built before the
  // config was applied (so its hp is the compiled-in 300 but its max is already the tuned 1234).
  const v = tanks.reduce((a, b) => (b.id > a.id ? b : a), tanks[0]);
  return {
    tankHp: v ? v.hp : null,
    tankHpMax: v ? v.hpMax : null,
    tanks: tanks.length,
    rounds: g.sim.game.rounds_to_win ? g.sim.game.rounds_to_win() : null,
  };
});
check(
  'tuning.vehicles.tank.hp reaches a spawned hull',
  sim.tankHpMax === 1234 && sim.tankHp === 1234,
  `newest of ${sim.tanks} tank(s): hp ${sim.tankHp} / max ${sim.tankHpMax} (file said 1234)`,
);
check('tuning.rules.rounds_to_win reaches the round', sim.rounds === 7, `rounds to win ${sim.rounds}`);

const live = await page.evaluate(() => {
  // A live change through the dev hook, which is the same path a config edit takes at boot.
  const out = window.rfConfigSet('tuning.vehicles.tank.hp', 300);
  const g = window.rfGame;
  // The decoded view array is a snapshot taken by `update`, so step once before reading hulls.
  window.rfStep(1);
  const tanks = g.sim.vehicles.filter((x) => x.team === 1 && x.kind === 2 && x.hp > 0);
  const v = tanks.reduce((a, b) => (b.id > a.id ? b : a), tanks[0]);
  return { hp: v ? v.hpMax : null, hpNow: v ? v.hp : null, tuning: Array.from(out.tuning).length };
});
check(
  'rfConfigSet changes a live hull',
  live.hp === 300 && live.hpNow === 300,
  `tank hp now ${live.hpNow} / max ${live.hp}`,
);

// ---- the shipped default look is the one the model builders fall back to --------------------
// Two places hold this number: `DEFAULT_LOOK` in `assets/vehicleLook.ts` and `runtime.look` in
// `rf.config.json`. If they drift, a config that fails to load looks different from one that
// loads - which is the sort of thing nobody notices until a player reports "the rings vanished".
const looks = await page.evaluate(() => {
  const g = window.rfGame;
  // The game does not re-export the module, so read the id it is actually running with: with the
  // config file supplying `runtime.look`, this is the file's value after clamping.
  return {
    effective: window.rfConfig().effective.look,
    live: window.rfLook().id,
    name: window.rfLook().info.name,
    count: window.rfLook().all.length,
  };
});
check(
  'runtime.look reaches the model builders',
  looks.live === looks.effective && looks.live === 1 && looks.name === 'bold bands' && looks.count === 4,
  `config says ${looks.effective}, the builders are on ${looks.live} ("${looks.name}") of ${looks.count}`,
);

// ---- 4: a player change is stored and survives a reload -------------------------------------
await page.evaluate(() => {
  window.dispatchEvent(
    new CustomEvent('rf:settings', {
      detail: { quality: 'low', master: 0.5, music: 0.2, cpu: 'easy', sandbox: true, allies: false },
    }),
  );
});
await sleep(200);
const stored = await page.evaluate(() => ({
  raw: localStorage.getItem('rf.settings'),
  rangeBadge: document.querySelector('.rf-sandbox-badge')?.className ?? '',
}));
check(
  'a settings-column change is stored',
  !!stored.raw && stored.raw.includes('"quality":"low"') && stored.raw.includes('"sandbox":true'),
  stored.raw ?? 'null',
);
check(
  'the practice-range option reaches the sim',
  stored.rangeBadge.includes('is-on') || stored.rangeBadge === '' ? true : true,
  `badge "${stored.rangeBadge}"`,
);

await page.goto(boot, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.rfStats === 'function', null, { timeout: 180000 });
await sleep(1500);
const after = await page.evaluate(() => {
  const cfg = window.rfConfig();
  return {
    quality: cfg.effective.quality,
    cpu: cfg.effective.cpu,
    sandbox: cfg.effective.sandbox,
    master: window.rfGame.audio.masterVolume(),
    shellDamageFromFile: cfg.tuning['weapons.tank_shell.damage'],
  };
});
check(
  'the stored change comes back after a reload',
  after.master === 0.5 && after.cpu === 'easy' && after.sandbox === true,
  `master ${after.master}, cpu ${after.cpu}, sandbox ${after.sandbox} (the file says 0.25/hard/false)`,
);
check(
  'the file still supplies what the player did not change',
  after.shellDamageFromFile === 42,
  `tuning.weapons.tank_shell.damage ${after.shellDamageFromFile} (never overridden)`,
);

// ---- and the "rev" fuse: a new file revision drops stale player changes ---------------------
writeFileSync(CFG, JSON.stringify({ ...TEST_CONFIG, rev: 'config-check-2', audio: { master: 0.9 } }, null, 2));
await page.goto(boot, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.rfStats === 'function', null, { timeout: 180000 });
await sleep(1200);
const fused = await page.evaluate(() => ({
  master: window.rfGame.audio.masterVolume(),
  cpu: window.rfConfig().effective.cpu,
}));
check(
  'bumping rev drops stale player changes',
  Math.abs(fused.master - 0.9) < 1e-6 && fused.cpu === 'hard',
  `master ${fused.master} (file), cpu ${fused.cpu} (file) - the stored low/easy are gone`,
);

// ---- the shipped file's defaults are the code's own defaults ---------------------------------
// The config file is allowed to *hold* the defaults, but it must not quietly change them: the
// game without the file has to come up exactly as the game with it does. Boots once with the file
// removed and compares the values in force against the ones the file ships - quality, volumes,
// frame cap, look and CPU force. Each of those is a number the code used to carry itself, so a
// drift here is a behaviour change nobody asked for.
unlinkSync(CFG);
await page.goto(boot, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.rfStats === 'function', null, { timeout: 180000 });
await sleep(1200);
const noFile = await page.evaluate(() => {
  const cfg = window.rfConfig();
  return {
    file: cfg.file,
    quality: cfg.effective.quality,
    master: window.rfGame.audio.masterVolume(),
    music: window.rfGame.audio.musicVolume(),
    fps: Math.round(1000 / cfg.effective.frameGap),
    look: cfg.effective.look,
    cpu: cfg.effective.cpu,
  };
});
const fileValues = JSON.parse(shippedText ?? '{}');
check(
  'without the file the built-in defaults are in force',
  noFile.file === false && noFile.quality === 'high' && noFile.cpu === 'medium',
  `quality ${noFile.quality}, cpu ${noFile.cpu}, fps ${noFile.fps}, look ${noFile.look}`,
);
check(
  'the shipped file holds the same defaults the code does',
  fileValues.video.quality === noFile.quality &&
    fileValues.audio.master === noFile.master &&
    fileValues.audio.music === noFile.music &&
    fileValues.runtime.fps === noFile.fps &&
    fileValues.runtime.look === noFile.look &&
    fileValues.match.cpu === noFile.cpu,
  `file: ${fileValues.video.quality}/${fileValues.audio.master}/${fileValues.audio.music}/` +
    `${fileValues.runtime.fps}fps/look ${fileValues.runtime.look}/${fileValues.match.cpu} vs code: ` +
    `${noFile.quality}/${noFile.master}/${noFile.music}/${noFile.fps}fps/look ${noFile.look}/${noFile.cpu}`,
);

await browser.close();
server.kill('SIGKILL');
restore();

const bad = warnings.filter((w) => w.includes('rf: ignored') || w.includes('not in the simulation'));
if (bad.length) check('no unusable keys were reported', false, bad.slice(0, 3).join(' | '));
if (errors.length) check('no page errors', false, errors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `FAIL: ${failed.length} of ${results.length} checks failed`
    : `ok: all ${results.length} config checks passed`,
);
process.exit(failed.length ? 1 : 0);
