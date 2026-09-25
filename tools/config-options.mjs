#!/usr/bin/env node
/**
 * Print the config file's option list — no browser, no match. Loads the shipped wasm directly
 * and asks the engine for its tuning layout (the same `tuningLayout()` the web side matches
 * `rf.config.json` against), so the names cannot drift from the code.
 *
 *   node tools/config-options.mjs              # everything: file sections + all 416 tuning slots
 *   node tools/config-options.mjs rules        # only names containing "rules" (case-insensitive)
 *   node tools/config-options.mjs tank         # ...or "tank", "heli_cannon", "hp", whatever
 *   node tools/config-options.mjs --json       # machine-readable [[name, default], ...]
 *
 * Each tuning slot is printed with its compiled-in default — the value a config file would
 * override. `config-check.mjs` is the end-to-end *check* that a value in the file reaches the
 * simulation; this tool is just the list.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(ROOT, 'web');
const PKG = resolve(WEB, 'src/sim/pkg');
const CFG = resolve(WEB, 'public/rf.config.json');

if (!existsSync(`${PKG}/rf_core_bg.wasm`)) {
  console.error('wasm package missing - run ./scripts/build-wasm.sh first');
  process.exit(1);
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const filter = argv.filter((a) => !a.startsWith('--'))[0]?.toLowerCase();

// The engine is the source of truth for the names: load it straight from the built package.
const { default: init, Game } = await import(`${PKG}/rf_core.js`);
await init({ module_or_path: readFileSync(`${PKG}/rf_core_bg.wasm`) });
const game = new Game(11, 0, 0, 0, false);
const names = game.tuning_layout();
const values = Array.from(game.tuning_values());

if (asJson) {
  const rows = names.map((n, i) => [n, values[i]]).filter(([n]) => !filter || n.toLowerCase().includes(filter));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

// ---- the file-level sections (the keys a config may hold outside `tuning`) ------------------
console.log('rf.config.json sections:');
const shipped = existsSync(CFG) ? JSON.parse(readFileSync(CFG, 'utf8')) : {};
for (const [section, body] of Object.entries(shipped)) {
  if (section.startsWith('$') || section === 'rev' || section === 'tuning') continue;
  const keys = Object.entries(body)
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  console.log(`  ${section}: ${keys.join('  ')}`);
}
console.log('  tuning: any of the slots below, dotted ("tuning.vehicles.tank.hp") or nested');
console.log();

// ---- the tuning slots, grouped by their section prefix --------------------------------------
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
const shown = [];
let group = '';
for (let i = 0; i < names.length; i++) {
  const n = names[i];
  if (filter && !n.toLowerCase().includes(filter)) continue;
  const g = n.split('.')[0] === 'rules' ? 'rules' : n.slice(0, n.lastIndexOf('.'));
  if (g !== group) {
    if (group !== '') console.log();
    group = g;
    const inGroup = names.filter((x) => (x.split('.')[0] === 'rules' ? 'rules' : x.slice(0, x.lastIndexOf('.'))) === g).length;
    console.log(`${g}.  (${inGroup} slots)`);
  }
  shown.push(n);
  console.log(`  ${n.padEnd(42)} ${fmt(values[i])}`);
}
console.log();
console.log(`${shown.length} of ${names.length} slots${filter ? ` matching "${filter}"` : ''}`);
