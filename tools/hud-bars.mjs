#!/usr/bin/env node
/**
 * HUD probe: every value and bar in the vehicle panel, against the simulation.
 *
 * The panel reads a per-player block mirrored out of the sim (`PlayerHud`), and the one thing it
 * cannot read is a capacity the frame does not carry - so it used to *guess*: the primary
 * magazine was "the fullest we have ever seen", falling back to a generic 24 whenever no vehicle
 * was live (dead, or waiting in the garage). A jeep's sixteen grenades then read two-thirds full
 * for the rest of the match, because nothing could bring the ceiling back down. That is the
 * "the HUD isn't updating correctly" report, and this is the check that finds it: put the player
 * in each hull, let a few real frames run, and compare the DOM against `sim.hud[0]`.
 *
 *   node tools/hud-bars.mjs [--port 5199]
 *
 * Exits non-zero and names the mismatching row when a bar disagrees with the simulated value.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(ROOT, 'web');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const PORT = Number(flag('port', 5199));

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
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const failures = [];
for (const kind of [1, 2, 3, 4]) {
  // One page load per hull: attract mode re-requests its own kind every frame, so a hull asked
  // for mid-match is replaced within a frame or two. The URL flag is what actually picks it.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?auto=1&vehicle=${kind}&size=small&demo=1`, {
    waitUntil: 'commit',
    timeout: 60000,
  });
  await page.waitForFunction(() => typeof window.rfStats === 'function', null, { timeout: 120000 });
  await sleep(2200);
  const r = await page.evaluate(async (kind) => {
    const sim = window.rfGame.sim;
    for (let i = 0; i < 60 * 20; i++) {
      const h = sim.hud[0];
      if (h.vehicleKind === kind && h.status > 0) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    // The panel updates from the game's own frame, which has been running all along.
    await new Promise((res) => setTimeout(res, 900));
    const val = (i) => Number(document.querySelectorAll('.rf-row-val')[i]?.textContent ?? NaN);
    const fill = (i) => Number(document.querySelectorAll('.rf-row-fill')[i]?.style.getPropertyValue('--v') ?? NaN);
    const h = sim.hud[0];
    return {
      kind,
      sim: {
        hp: Math.round(h.hp),
        fuel: Math.round(h.fuel),
        fuelMax: Math.round(h.fuelMax),
        ammo0: Math.round(h.ammo0),
        ammo0Max: Math.round(h.ammo0Max),
      },
      dom: { hp: val(0), fuel: val(1), ammo: val(2), fillHp: fill(0), fillFuel: fill(1), fillAmmo: fill(2) },
    };
  }, kind);
  const checks = [
    ['armour', r.dom.hp, r.sim.hp],
    ['fuel', r.dom.fuel, r.sim.fuel],
    ['ammo', r.dom.ammo, r.sim.ammo0],
  ];
  const bad = checks.filter(([, a, b]) => a !== b).map(([n, a, b]) => `${n} dom=${a} sim=${b}`);
  const wantAmmo = r.sim.ammo0Max > 0 ? Math.min(1, r.sim.ammo0 / r.sim.ammo0Max) : 0;
  const wantFuel = r.sim.fuelMax > 0 ? Math.min(1, r.sim.fuel / r.sim.fuelMax) : 0;
  if (Math.abs(r.dom.fillAmmo - wantAmmo) > 0.02) {
    bad.push(`ammo bar ${r.dom.fillAmmo.toFixed(2)} vs ${wantAmmo.toFixed(2)} (cap ${r.sim.ammo0Max})`);
  }
  if (Math.abs(r.dom.fillFuel - wantFuel) > 0.02) {
    bad.push(`fuel bar ${r.dom.fillFuel.toFixed(2)} vs ${wantFuel.toFixed(2)}`);
  }
  const name = ['', 'jeep', 'tank', 'MLRS', 'helicopter'][kind];
  console.log(
    `${name.padEnd(11)} armour ${r.sim.hp} fuel ${r.sim.fuel}/${r.sim.fuelMax} ammo ${r.sim.ammo0}/${r.sim.ammo0Max} | bars ${r.dom.fillHp.toFixed(2)}/${r.dom.fillFuel.toFixed(2)}/${r.dom.fillAmmo.toFixed(2)}${bad.length ? '  <-- ' + bad.join('; ') : ''}`,
  );
  failures.push(...bad.map((b) => `${name}: ${b}`));
}

await browser.close();
stop();
if (errors.length) {
  console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  process.exit(1);
}
if (failures.length) {
  console.log(`FAIL: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('ok: every row and bar matches the simulation for all four hulls');
