/**
 * Low-level WebAudio primitives shared by the SFX, engine and music layers.
 *
 * House rules for everything in `src/audio`:
 *  - no module-level audio nodes (a context may not exist yet, and browsers block one
 *    created outside a user gesture),
 *  - every gain that is modulated starts and ends at ~0 (no clicks, no DC pops),
 *  - every scheduled source is stopped with an explicit time and disconnects itself from
 *    `onended`, so a long session cannot accumulate stale nodes.
 */

export type AudioCtx = BaseAudioContext;

/** Never ramp an AudioParam exactly to 0 with an exponential curve; use this floor. */
export const MIN_GAIN = 1e-4;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Deterministic xorshift32 PRNG. The game never seeds it (so shots vary naturally), but the
 * verification harness re-seeds before every render, which makes the metric tables
 * reproducible run to run.
 */
let rngState = 0x9e3779b9;

export function seedRandom(seed: number): void {
  rngState = (seed >>> 0) || 0x9e3779b9;
}

function nextRandom(): number {
  let x = rngState;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  rngState = x;
  return x / 4294967296;
}

export function rand(min: number, max: number): number {
  return min + nextRandom() * (max - min);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(g, 1e-9));
}

/* ------------------------------------------------------------------ pitch names */

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `"C#4"`, `"Bb3"`, `"A4"` → MIDI note number (C4 = 60). Unknown names fall back to A4. */
export function noteToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return 69;
  const base = SEMITONES[m[1].toUpperCase()] ?? 9;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return base + acc + (Number(m[3]) + 1) * 12;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function noteToHz(name: string): number {
  return midiToHz(noteToMidi(name));
}

/* ------------------------------------------------------------------- noise beds */

export type NoiseKind = 'white' | 'pink' | 'brown';

const noiseCache = new WeakMap<BaseAudioContext, Map<NoiseKind, AudioBuffer>>();

/** Cached noise bed per context (a 2 s mono buffer is reused by every recipe). */
export function noiseBufferFor(ctx: AudioCtx, kind: NoiseKind = 'white'): AudioBuffer {
  let perCtx = noiseCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    noiseCache.set(ctx, perCtx);
  }
  const hit = perCtx.get(kind);
  if (hit) return hit;
  const buf = makeNoiseBuffer(ctx, 2, kind);
  perCtx.set(kind, buf);
  return buf;
}

export function makeNoiseBuffer(ctx: AudioCtx, seconds = 2, kind: NoiseKind = 'white'): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (kind === 'white') {
    for (let i = 0; i < len; i++) d[i] = nextRandom() * 2 - 1;
  } else if (kind === 'pink') {
    // Paul Kellet's economy pink filter.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = nextRandom() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = nextRandom() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

/* ----------------------------------------------------------------- node factories */

export function gainNode(ctx: AudioCtx, value = 0): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export function biquad(
  ctx: AudioCtx,
  type: BiquadFilterType,
  freq: number,
  q = 0.7071,
  gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(freq, 10, ctx.sampleRate * 0.45);
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

export function osc(ctx: AudioCtx, type: OscillatorType, freq: number, detune = 0): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = clamp(freq, 0.01, ctx.sampleRate * 0.45);
  o.detune.value = detune;
  return o;
}

/** A source reading from a shared noise bed. */
export function noiseSource(ctx: AudioCtx, kind: NoiseKind = 'white', rate = 1, loop = false): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBufferFor(ctx, kind);
  src.loop = loop;
  src.playbackRate.value = rate;
  return src;
}

/** Starts a noise read at a random offset so repeated shots never phase-lock. */
export function startNoise(src: AudioBufferSourceNode, when: number): void {
  const dur = src.buffer ? src.buffer.duration : 0;
  const offset = !src.loop && dur > 0.1 ? nextRandom() * (dur - 0.05) : 0;
  try {
    src.start(Math.max(0, when), offset);
  } catch {
    /* already started */
  }
}

/* --------------------------------------------------------------- shaper curves */

export type CurveKind = 'soft' | 'hard' | 'fuzz' | 'fold';

export function makeCurve(kind: CurveKind, amount = 1, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const k = Math.max(0.001, amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y: number;
    switch (kind) {
      case 'soft':
        y = Math.tanh(x * k);
        break;
      case 'hard':
        y = clamp(x * k, -1, 1);
        break;
      case 'fuzz':
        y = Math.sign(x) * Math.pow(Math.abs(x), 1 / Math.max(1, k));
        break;
      case 'fold':
        y = Math.sin(x * k * Math.PI);
        break;
    }
    c[i] = clamp(y, -1, 1);
  }
  return c;
}

export function shaper(ctx: AudioCtx, kind: CurveKind, amount = 1): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  ws.curve = makeCurve(kind, amount);
  ws.oversample = '2x';
  return ws;
}

/* ------------------------------------------------------------------- envelopes */

/** Attack/decay envelope ending at exactly 0. Returns the time the voice is silent. */
export function percEnv(
  p: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): number {
  const a = Math.max(0.0006, attack);
  const d = Math.max(0.005, decay);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(Math.max(peak, MIN_GAIN), t0 + a);
  p.exponentialRampToValueAtTime(MIN_GAIN, t0 + a + d);
  p.setValueAtTime(0, t0 + a + d + 0.001);
  return t0 + a + d + 0.001;
}

/** Attack → hold → release. Returns the time the voice is silent. */
export function adsrEnv(
  p: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): number {
  const a = Math.max(0.0008, attack);
  const h = Math.max(0.005, hold);
  const r = Math.max(0.01, release);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(Math.max(peak, MIN_GAIN), t0 + a);
  p.setValueAtTime(Math.max(peak, MIN_GAIN), t0 + a + h);
  p.exponentialRampToValueAtTime(MIN_GAIN, t0 + a + h + r);
  p.setValueAtTime(0, t0 + a + h + r + 0.001);
  return t0 + a + h + r + 0.001;
}

/** Smooth one-pole glide, for engine/loop morphs that are updated every frame. */
export function glide(p: AudioParam, value: number, time: number, tc = 0.09): void {
  p.setTargetAtTime(value, time, tc);
}

/** Exponential frequency sweep (never touches 0 Hz). */
export function sweepHz(p: AudioParam, t0: number, from: number, to: number, dur: number): void {
  p.setValueAtTime(Math.max(1, from), t0);
  p.exponentialRampToValueAtTime(Math.max(1, to), t0 + Math.max(0.002, dur));
}

/* ----------------------------------------------------------- lifecycle helpers */

export function stopSrc(src: AudioScheduledSourceNode, when: number): void {
  try {
    src.stop(Math.max(0, when));
  } catch {
    /* never started or already stopped */
  }
}

export function disconnectAll(nodes: readonly AudioNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

/** Stops a source at `when` and drops the whole chain once it has finished. */
export function selfDestruct(src: AudioScheduledSourceNode, stopAt: number, chain: readonly AudioNode[]): void {
  stopSrc(src, stopAt);
  src.onended = () => {
    disconnectAll(chain);
    src.onended = null;
  };
}

/* ------------------------------------------------------------ reverb impulse */

/**
 * Synthesised stereo impulse response: exponentially decaying noise plus a handful of
 * early reflections. `damp` controls how fast the high end dies (0..1, higher = darker).
 */
export function makeImpulseResponse(
  ctx: AudioCtx,
  seconds = 2.2,
  decay = 2.8,
  damp = 0.42,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(8, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  const early: ReadonlyArray<readonly [number, number]> = [
    [7, 0.5],
    [13, 0.4],
    [23, 0.32],
    [31, 0.24],
    [47, 0.18],
  ];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    const skew = ch === 0 ? 1 : -1;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const w = nextRandom() * 2 - 1;
      lp += (w - lp) * damp;
      d[i] = lp * Math.pow(1 - t, decay) * 0.7;
    }
    for (const [ms, g] of early) {
      const idx = Math.floor((rate * ms) / 1000) + (ch === 0 ? 0 : 5);
      if (idx < len) d[idx] += g * skew;
    }
  }
  return buf;
}

/* ------------------------------------------------------------------- analysis */

/** Peak absolute sample value. */
export function peakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

export function rmsOf(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}

/** Zero-crossing rate in crossings per second. */
export function zcrOf(data: Float32Array, sampleRate: number): number {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++;
  }
  return (crossings * sampleRate) / Math.max(1, data.length);
}

/**
 * Spectral centroid in Hz via a radix-2 FFT magnitude spectrum over `[from, to)`.
 * The window is Hann-windowed so broadband bursts do not leak.
 */
export function spectralCentroid(
  data: Float32Array,
  sampleRate: number,
  from = 0,
  to = data.length,
): number {
  const lo = Math.max(0, Math.min(from, data.length - 1));
  const hi = Math.max(lo + 1, Math.min(to, data.length));
  const span = hi - lo;
  const n = 1 << Math.floor(Math.log2(Math.min(span, 8192)));
  if (n < 64) return 0;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const off = Math.max(0, Math.min(data.length - n, lo + Math.floor((span - n) / 2)));
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = data[off + i] * w;
  }
  fft(re, im);
  let num = 0;
  let den = 0;
  for (let k = 1; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    const f = (k * sampleRate) / n;
    num += f * mag;
    den += mag;
  }
  return den > 1e-12 ? num / den : 0;
}

/** In-place iterative radix-2 FFT (re/im must be a power-of-two length). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * YIN-style fundamental estimate (cumulative-mean-normalised difference).
 * Returns Hz, or 0 when the window is not periodic enough to trust.
 */
export function detectPitch(
  data: Float32Array,
  sampleRate: number,
  fMin = 50,
  fMax = 2200,
): number {
  const n = Math.min(data.length, 8192);
  if (n < 256) return 0;
  const start = Math.max(0, Math.floor((data.length - n) / 2));
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  const tauMax = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / fMin));
  if (tauMax <= tauMin + 2) return 0;

  const diff = new Float64Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < n - tauMax; i++) {
      const d = data[start + i] - data[start + i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }
  const cmnd = new Float64Array(tauMax + 1);
  let running = 0;
  cmnd[0] = 1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += diff[tau];
    cmnd[tau] = running > 1e-12 ? (diff[tau] * (tau - tauMin + 1)) / running : 1;
  }
  // first local minimum under the threshold wins (avoids octave-too-low errors)
  let best = -1;
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (cmnd[tau] < 0.18 && cmnd[tau] <= cmnd[tau - 1] && cmnd[tau] <= cmnd[tau + 1]) {
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let minVal = 1;
    for (let tau = tauMin + 1; tau < tauMax; tau++) {
      if (cmnd[tau] < minVal) {
        minVal = cmnd[tau];
        best = tau;
      }
    }
    if (best < 0 || minVal > 0.45) return 0;
  }
  // parabolic interpolation around the minimum
  const y0 = cmnd[best - 1];
  const y1 = cmnd[best];
  const y2 = cmnd[best + 1];
  const denom = 2 * (2 * y1 - y2 - y0);
  const shift = denom !== 0 ? (y2 - y0) / denom : 0;
  const tau = best + clamp(shift, -1, 1);
  return tau > 0 ? sampleRate / tau : 0;
}
