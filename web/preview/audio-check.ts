/**
 * Offline verification for the audio engine.
 *
 * Renders every SFX and every theme through an `OfflineAudioContext` and measures objective
 * properties (peak, RMS, active duration, spectral centroid, zero-crossing rate and an
 * 8-band fingerprint), then checks the encoded melodies by pitch-tracking a melody-only
 * render. This is what `preview/audio.html` prints into `window.__AUDIO_REPORT__`.
 */
import type { SfxName, ThemeName } from '../src/assets/types';
import {
  detectPitch,
  fft,
  makeImpulseResponse,
  midiToHz,
  seedRandom,
  spectralCentroid,
  zcrOf,
} from '../src/audio/dsp';
import { MUSIC_BUS_DB } from '../src/audio/audio';
import { renderSfx, SFX_NAMES } from '../src/audio/sfx';
import { flattenTheme, melodyHead, renderThemeWindow, THEME_DEFS, THEME_ORDER, themeLoopSeconds } from '../src/audio/music';

export const CHECK_SAMPLE_RATE = 44100;
const PITCH_TOLERANCE_CENTS = 60;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface Metric {
  peak: number;
  /** RMS over the whole render window */
  rmsDb: number;
  /** RMS over the active region only — the "is this actually audible?" number */
  rmsActiveDb: number;
  /** ms between the first and last sample above -60 dBFS */
  durationMs: number;
  centroid: number;
  zcr: number;
  bands: number[];
}

export interface Asserts {
  finite: boolean;
  peakOk: boolean;
  rmsOk: boolean;
  durationOk: boolean;
}

export interface SfxReport {
  metric: Metric;
  asserts: Asserts;
}

export interface ThemeReport {
  metric: Metric;
  loopSeconds: number;
  repeats: number;
  bpm: number;
  noteCount: number;
  asserts: Asserts;
  loopLengthOk: boolean;
}

export interface PitchReport {
  theme: ThemeName;
  label: string;
  expectedNames: string[];
  expectedHz: number[];
  detectedHz: number[];
  centsError: number[];
  ok: boolean;
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface AudioReport {
  ok: boolean;
  generatedAt: string;
  sampleRate: number;
  counts: { sfx: number; themes: number };
  sfx: Record<string, SfxReport>;
  themes: Record<string, ThemeReport>;
  pitch: Record<string, PitchReport>;
  distinctness: {
    minCentroid: number;
    maxCentroid: number;
    medianCentroid: number;
    similarPairs: string[];
    maxBandCosine: number;
    mostSimilarPair: string;
  };
  checks: Check[];
  failures: string[];
}

/* ------------------------------------------------------------------- metrics */

function monoOf(buf: AudioBuffer): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

function firstNonFinite(data: Float32Array): number {
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) return i;
  }
  return -1;
}

function activeRange(data: Float32Array, peak: number): [number, number] {
  const thr = Math.max(1e-4, peak * 1e-3);
  let first = -1;
  let last = -1;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return [first, last];
}

/** 8 log-spaced band energies (normalised), averaged over up to four windows. */
function bandFingerprint(data: Float32Array, from: number, to: number, sampleRate: number): number[] {
  const n = 4096;
  const bands = 8;
  const edges = [60, 150, 350, 800, 1800, 4000, 8000, 12000, 16000];
  const acc = new Array<number>(bands).fill(0);
  const span = Math.max(1, to - from);
  const windows = Math.min(4, Math.max(1, Math.floor(span / n)));
  for (let w = 0; w < windows; w++) {
    const off = from + Math.floor(((w + 0.5) / windows) * span) - n / 2;
    const start = Math.max(0, Math.min(data.length - n, off));
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      re[i] = data[start + i] * win;
    }
    fft(re, im);
    for (let k = 1; k < n / 2; k++) {
      const f = (k * sampleRate) / n;
      const mag = Math.hypot(re[k], im[k]);
      for (let b = 0; b < bands; b++) {
        if (f >= edges[b] && f < edges[b + 1]) acc[b] += mag;
      }
    }
  }
  const total = acc.reduce((a, b) => a + b, 0) || 1;
  return acc.map((v) => v / total);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function metricOf(data: Float32Array, sampleRate: number): Metric {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    sum += data[i] * data[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, data.length));
  const [from, to] = activeRange(data, peak);
  const active = from < 0 ? data.subarray(0, 1) : data.subarray(from, to + 1);
  let asum = 0;
  for (let i = 0; i < active.length; i++) asum += active[i] * active[i];
  const activeRms = Math.sqrt(asum / Math.max(1, active.length));
  return {
    peak,
    rmsDb: 20 * Math.log10(Math.max(rms, 1e-9)),
    rmsActiveDb: 20 * Math.log10(Math.max(activeRms, 1e-9)),
    durationMs: from < 0 ? 0 : ((to - from + 1) / sampleRate) * 1000,
    centroid: spectralCentroid(data, sampleRate, Math.max(0, from), Math.max(1, to + 1)),
    zcr: zcrOf(active, sampleRate),
    bands: bandFingerprint(data, Math.max(0, from), Math.max(1, to), sampleRate),
  };
}

function assertMetric(m: Metric, minMs: number, finite: boolean): Asserts {
  return {
    finite,
    peakOk: m.peak <= 1.0,
    // "not silence": measured where the sound actually is (the full-window RMS of a 0.1 s
    // UI blip inside a 5 s render is dominated by the tail silence)
    rmsOk: m.rmsActiveDb > -45,
    durationOk: m.durationMs > minMs,
  };
}

export function midiName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/* ------------------------------------------------------------------ renders */

let renderSeq = 0;

/**
 * Renders one offline pass. The PRNG is re-seeded per pass so the whole report is
 * reproducible: same code in, same numbers out.
 */
async function renderOffline(
  seconds: number,
  build: (ctx: OfflineAudioContext, dest: AudioNode) => void,
): Promise<Float32Array> {
  seedRandom(0x5eed0000 + ++renderSeq);
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * CHECK_SAMPLE_RATE), CHECK_SAMPLE_RATE);
  build(ctx, ctx.destination);
  const buf = await ctx.startRendering();
  return monoOf(buf);
}

function reverbIn(ctx: OfflineAudioContext, dest: AudioNode, amount: number): AudioNode {
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulseResponse(ctx, 1.8, 3, 0.5);
  const out = ctx.createGain();
  out.gain.value = amount;
  conv.connect(out);
  out.connect(dest);
  const send = ctx.createGain();
  send.gain.value = 1;
  send.connect(conv);
  return send;
}

export async function renderSfxMetrics(): Promise<Record<string, SfxReport>> {
  const out: Record<string, SfxReport> = {};
  for (const name of SFX_NAMES as readonly SfxName[]) {
    const data = await renderOffline(5, (ctx, dest) => {
      renderSfx(ctx, dest, name, 0.02, { gain: 1 });
    });
    const metric = metricOf(data, CHECK_SAMPLE_RATE);
    out[name] = { metric, asserts: assertMetric(metric, 60, firstNonFinite(data) < 0) };
  }
  return out;
}

export async function renderThemeMetrics(): Promise<Record<string, ThemeReport>> {
  const out: Record<string, ThemeReport> = {};
  for (const theme of THEME_ORDER) {
    const def = THEME_DEFS[theme];
    const data = await renderOffline(4, (ctx, dest) => {
      const wet = reverbIn(ctx, dest, 0.3);
      renderThemeWindow(ctx, { dry: dest, wet }, theme, 0, 4);
    });
    const metric = metricOf(data, CHECK_SAMPLE_RATE);
    const loopSeconds = themeLoopSeconds(def);
    out[theme] = {
      metric,
      loopSeconds,
      repeats: def.repeats,
      bpm: def.bpm,
      noteCount: flattenTheme(def).notes.length,
      asserts: assertMetric(metric, 60, firstNonFinite(data) < 0),
      loopLengthOk: loopSeconds >= 20 && loopSeconds <= 45,
    };
  }
  return out;
}

/* -------------------------------------------------------------------- pitch */

export interface HeadNote {
  midi: number;
  time: number;
  dur: number;
}

export function themeHeadNotes(theme: ThemeName, count: number): HeadNote[] {
  return melodyHead(THEME_DEFS[theme], count).map((n) => ({ midi: n.midi, time: n.time, dur: n.dur }));
}

/** YIN on a synthetic sine — proves the detector itself works before trusting it. */
export function detectorSelfTest(): number {
  const sr = CHECK_SAMPLE_RATE;
  const n = sr;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / sr);
  return detectPitch(data, sr);
}

export async function checkThemePitches(theme: ThemeName, count = 8): Promise<PitchReport> {
  const def = THEME_DEFS[theme];
  const head = themeHeadNotes(theme, count);
  const last = head[head.length - 1];
  const span = last ? last.time + last.dur + 0.5 : 1;
  const data = await renderOffline(Math.max(1, span), (ctx, dest) => {
    renderThemeWindow(ctx, { dry: dest }, theme, 0, span, { melodyOnly: true });
  });
  const detected: number[] = [];
  for (const note of head) {
    const start = Math.max(0, Math.floor((note.time + 0.02) * CHECK_SAMPLE_RATE));
    const want = Math.max(1024, Math.floor(Math.min(note.dur * 0.75, 0.28) * CHECK_SAMPLE_RATE));
    const slice = data.subarray(start, Math.min(data.length, start + want));
    detected.push(detectPitch(slice, CHECK_SAMPLE_RATE, 55, 2500));
  }
  const expectedHz = head.map((n) => midiToHz(n.midi));
  const centsError = expectedHz.map((f, i) => {
    const d = detected[i];
    return d > 0 ? 1200 * Math.log2(d / f) : Number.POSITIVE_INFINITY;
  });
  return {
    theme,
    label: def.label,
    expectedNames: head.map((n) => midiName(n.midi)),
    expectedHz,
    detectedHz: detected,
    centsError,
    ok: centsError.every((c) => Math.abs(c) <= PITCH_TOLERANCE_CENTS),
  };
}

/* ---------------------------------------------------------------- full suite */

export async function runAudioChecks(): Promise<AudioReport> {
  const failures: string[] = [];
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
    if (!pass) failures.push(`${name}: ${detail}`);
  };

  const sfx = await renderSfxMetrics();
  const themes = await renderThemeMetrics();
  const pitch: Record<string, PitchReport> = {};
  for (const theme of THEME_ORDER) pitch[theme] = await checkThemePitches(theme, 8);

  // 1. detector sanity: an A4 sine must read back as A4
  const selfTest = detectorSelfTest();
  const selfCents = 1200 * Math.log2(selfTest / 440);
  add('pitch-detector self test (440 Hz sine)', Math.abs(selfCents) < 10, `detected ${selfTest.toFixed(2)} Hz (${selfCents.toFixed(2)} cents)`);

  // 2. every SFX: finite, no clipping, not silent, longer than 60 ms
  let sfxBad = 0;
  for (const name of Object.keys(sfx)) {
    const a = sfx[name].asserts;
    const pass = a.finite && a.peakOk && a.rmsOk && a.durationOk;
    if (!pass) {
      sfxBad++;
      add(`sfx ${name}`, false, JSON.stringify({ ...a, ...sfx[name].metric, bands: undefined }));
    }
  }
  add('all SFX finite / peak<=1 / rms>-45dBFS / dur>60ms', sfxBad === 0, `${Object.keys(sfx).length - sfxBad}/${Object.keys(sfx).length} passed`);

  // 3. every theme: same thresholds, plus a 20-45 s loop length
  let themeBad = 0;
  for (const name of Object.keys(themes)) {
    const t = themes[name];
    const pass = t.asserts.finite && t.asserts.peakOk && t.asserts.rmsOk && t.asserts.durationOk && t.loopLengthOk;
    if (!pass) {
      themeBad++;
      add(`theme ${name}`, false, JSON.stringify({ ...t.asserts, loop: t.loopSeconds, peak: t.metric.peak }));
    }
  }
  add('all themes finite / peak<=1 / rms>-45dBFS / loop 20-45s', themeBad === 0, `${Object.keys(themes).length - themeBad}/${Object.keys(themes).length} passed`);

  // 4. SFX must not all be the same noise burst: centroid spread + band fingerprints
  const names = Object.keys(sfx);
  const centroids = names.map((n) => sfx[n].metric.centroid).sort((a, b) => a - b);
  const similarPairs: string[] = [];
  let maxCos = 0;
  let mostSimilar = '';
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = sfx[names[i]].metric;
      const b = sfx[names[j]].metric;
      const rel = Math.abs(a.centroid - b.centroid) / Math.max(a.centroid, b.centroid, 1);
      if (rel < 0.03) similarPairs.push(`${names[i]}~${names[j]}`);
      const c = cosine(a.bands, b.bands);
      if (c > maxCos) {
        maxCos = c;
        mostSimilar = `${names[i]}~${names[j]}`;
      }
    }
  }
  const medianCentroid = centroids[Math.floor(centroids.length / 2)];
  const pairs = (names.length * (names.length - 1)) / 2;
  const similarBudget = Math.floor(pairs * 0.03);
  add(
    `SFX spectral centroids are distinct (<=${similarBudget} of ${pairs} pairs within 3%, spread >= 4x)`,
    similarPairs.length <= similarBudget && centroids[centroids.length - 1] >= centroids[0] * 4,
    `pairs within 3%: ${similarPairs.length}${similarPairs.length ? ` [${similarPairs.join(', ')}]` : ''}; ` +
      `centroid ${centroids[0].toFixed(0)}..${centroids[centroids.length - 1].toFixed(0)} Hz, median ${medianCentroid.toFixed(0)} Hz`,
  );
  add(
    'no two SFX share a spectral fingerprint (band cosine < 0.999)',
    maxCos < 0.999,
    `max cosine ${maxCos.toFixed(4)} (${mostSimilar})`,
  );

  // 5. the music bed must sit under the SFX once the bus trim is applied
  const sfxNames = Object.keys(sfx);
  const avgSfx = sfxNames.reduce((a, n) => a + sfx[n].metric.rmsActiveDb, 0) / Math.max(1, sfxNames.length);
  const themeNames = Object.keys(themes);
  const avgMusic = themeNames.reduce((a, n) => a + themes[n].metric.rmsActiveDb, 0) / Math.max(1, themeNames.length);
  const musicUnderSfxDb = avgSfx - (avgMusic + MUSIC_BUS_DB);
  add(
    'music bed sits >= 8 dB under the SFX bus',
    musicUnderSfxDb >= 8,
    `mean SFX ${avgSfx.toFixed(1)} dBFS, mean music ${avgMusic.toFixed(1)} dBFS, bus ${MUSIC_BUS_DB} dB -> music ${musicUnderSfxDb.toFixed(1)} dB below SFX`,
  );

  // 6. melodies: the first eight rendered notes must match the encoded pitches
  let pitchBad = 0;
  for (const theme of THEME_ORDER) {
    const p = pitch[theme];
    if (!p.ok) {
      pitchBad++;
      add(
        `theme pitch ${theme}`,
        false,
        p.expectedNames.map((n, i) => `${n}→${p.detectedHz[i].toFixed(1)}Hz(${p.centsError[i].toFixed(0)}c)`).join(' '),
      );
    }
  }
  add(
    'melody pitch verification: first 8 notes of all 8 themes within 60 cents',
    pitchBad === 0,
    `${THEME_ORDER.length - pitchBad}/${THEME_ORDER.length} themes matched`,
  );

  // 7. contract coverage
  add('all 25 SfxName values rendered', Object.keys(sfx).length === 25, `${Object.keys(sfx).length} rendered`);
  add('all 8 ThemeName values rendered', Object.keys(themes).length === 8, `${Object.keys(themes).length} rendered`);

  const report: AudioReport = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    sampleRate: CHECK_SAMPLE_RATE,
    counts: { sfx: Object.keys(sfx).length, themes: Object.keys(themes).length },
    sfx,
    themes,
    pitch,
    distinctness: {
      minCentroid: centroids[0],
      maxCentroid: centroids[centroids.length - 1],
      medianCentroid,
      similarPairs,
      maxBandCosine: maxCos,
      mostSimilarPair: mostSimilar,
    },
    checks,
    failures,
  };
  return report;
}

/** Compact human-readable table for the console (and the shot harness's warning channel). */
export function formatReport(report: AudioReport): string[] {
  const lines: string[] = [];
  lines.push(`AUDIO OFFLINE REPORT — ${report.ok ? 'ALL CHECKS PASS' : `FAILURES: ${report.failures.length}`}`);
  lines.push('SFX                 peak   rmsAct dB  dur ms  centroid Hz   zcr Hz');
  for (const [name, r] of Object.entries(report.sfx)) {
    const m = r.metric;
    lines.push(
      `${name.padEnd(18)} ${m.peak.toFixed(3)} ${m.rmsActiveDb.toFixed(1).padStart(8)} ${m.durationMs.toFixed(0).padStart(7)} ${m.centroid.toFixed(0).padStart(11)} ${m.zcr.toFixed(0).padStart(8)}`,
    );
  }
  lines.push('THEME               peak   rmsAct dB  dur ms  centroid Hz   loop s');
  for (const [name, r] of Object.entries(report.themes)) {
    const m = r.metric;
    lines.push(
      `${name.padEnd(18)} ${m.peak.toFixed(3)} ${m.rmsActiveDb.toFixed(1).padStart(8)} ${m.durationMs.toFixed(0).padStart(7)} ${m.centroid.toFixed(0).padStart(11)} ${r.loopSeconds.toFixed(1).padStart(8)}`,
    );
  }
  for (const p of Object.values(report.pitch)) {
    const det = p.detectedHz.map((h, i) => `${p.expectedNames[i]}→${h.toFixed(0)}`).join(' ');
    lines.push(`PITCH ${p.theme.padEnd(8)} ${p.ok ? 'ok  ' : 'FAIL'} ${det}`);
  }
  for (const c of report.checks) lines.push(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  return lines;
}
