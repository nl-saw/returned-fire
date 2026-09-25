#!/usr/bin/env node
/**
 * SFX spectrum probe: render a procedural sound offline and describe its balance in octave
 * bands, so "make it heavier" can be measured instead of argued about.
 *
 * Every sound in this game is synthesised (`web/src/audio/sfx.ts`), and the useful question
 * about a bang is where its power sits: a real 120 mm gun is a *low* event with a short crack
 * on top, and the recipe it replaced put 95 % of its power into one 80-250 Hz lump with 0.2 %
 * below 80 Hz - a click with a boom glued on, which is what "terrible, not heavy enough" was
 * describing. Octave bands are the fair comparison: per-bin density rewards a pure tone (few
 * bins, huge amplitude) and a plain sum rewards broadband noise (many bins, small amplitude),
 * while octaves split the difference and match how the ear groups them.
 *
 *   node tools/sfx-spectrum.mjs [--names gunTank,explosionSmall] [--port 5199]
 *
 * Prints duration, attack, peak, RMS and the octave share, plus sub / body / crack summaries.
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
const NAMES = flag('names', 'gunTank,explosionSmall,explosionBig').split(',');

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
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/index.html?auto=1`, { waitUntil: 'commit', timeout: 60000 });
await sleep(2000);

const rows = await page.evaluate(async (names) => {
  const sfx = await import('/src/audio/sfx.ts');
  const SR = 48000;
  const out = [];
  for (const name of names) {
    const ctx = new OfflineAudioContext(1, SR * 4, SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    sfx.renderSfx(ctx, bus, name, 0, {});
    const buf = await ctx.startRendering();
    const x = buf.getChannelData(0);

    let peak = 0;
    let peakAt = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) {
        peak = a;
        peakAt = i;
      }
    }
    let tail = peakAt;
    for (let i = peakAt; i < x.length; i++) if (Math.abs(x[i]) > peak * 0.01) tail = i;
    let riseAt = peakAt;
    for (let i = 0; i < peakAt; i++) {
      if (Math.abs(x[i]) > peak * 0.1) {
        riseAt = i;
        break;
      }
    }
    let rms = 0;
    for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / x.length);

    // A 4096-point FFT of the window at the transient, then octave-band totals.
    const N = 4096;
    const start = Math.min(peakAt, x.length - N - 1);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); // Hann
      re[i] = x[start + i] * w;
    }
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k);
          const wi = Math.sin(ang * k);
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr;
          im[i + k + len / 2] = ui - vi;
        }
      }
    }
    const edges = [20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 12000];
    const bands = new Array(edges.length - 1).fill(0);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * SR) / N;
      const mag = Math.hypot(re[k], im[k]);
      for (let b = 0; b < bands.length; b++) if (f >= edges[b] && f < edges[b + 1]) bands[b] += mag * mag;
    }
    const total = bands.reduce((a, b) => a + b, 0) || 1;
    const share = bands.map((v) => (v / total) * 100);
    out.push({
      name,
      duration: (tail - 0) / SR,
      attackMs: ((peakAt - riseAt) / SR) * 1000,
      peak,
      rms,
      sub: share[0] + share[1],
      body: share[2] + share[3] + share[4],
      crack: share[6] + share[7] + share[8],
      octaves: share,
    });
  }
  return out;
}, NAMES);

await browser.close();
stop();

console.log('octave bands: ' + [20, 40, 80, 160, 320, 640, 1280, 2560, 5120].map((f, i) => `${f}-${[40, 80, 160, 320, 640, 1280, 2560, 5120, 12000][i]}`).join('  '));
console.log('name             dur    atk    peak  rms    sub<80  body80-640  crack>1.2k');
for (const r of rows) {
  console.log(
    `${r.name.padEnd(16)} ${r.duration.toFixed(2)}s ${r.attackMs.toFixed(1).padStart(5)}ms ${r.peak.toFixed(2)}  ${r.rms.toFixed(3)}  ${r.sub.toFixed(1).padStart(5)}%  ${r.body.toFixed(1).padStart(9)}%  ${r.crack.toFixed(1).padStart(9)}%`,
  );
  console.log(`                 octaves: ${r.octaves.map((v) => v.toFixed(1).padStart(5)).join('  ')}`);
}
if (errors.length) {
  console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  process.exit(1);
}
