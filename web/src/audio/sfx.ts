/**
 * SFX recipes. Every sound is generated from oscillators, noise beds, biquads,
 * waveshapers and envelopes at call time — no samples, no files, no network.
 *
 * `renderSfx` is deliberately context-agnostic: it works on an `AudioContext` (live game)
 * or an `OfflineAudioContext` (the verification harness renders every recipe offline and
 * measures peak / RMS / duration / spectral centroid).
 */
import type { SfxName } from '../assets/types';
import {
  adsrEnv,
  biquad,
  clamp,
  disconnectAll,
  gainNode,
  noiseSource,
  osc,
  percEnv,
  rand,
  selfDestruct,
  shaper,
  startNoise,
  stopSrc,
  sweepHz,
  type NoiseKind,
} from './dsp';

/** Every SFX the game can ask for, in the contract's order (used by the preview page). */
export const SFX_NAMES: readonly SfxName[] = [
  'explosionSmall',
  'explosionBig',
  'gunTank',
  'gunChain',
  'rocketLaunch',
  'grenadeThrow',
  'mineDrop',
  'mineBlast',
  'impactMetal',
  'impactGround',
  'impactWater',
  'engineStart',
  'flagPickup',
  'flagCapture',
  'alarm',
  'laugh',
  'droneHum',
  'subLaunch',
  'resupply',
  'buildDone',
  'towerFire',
  'bailOut',
  'bridgeCollapse',
  'uiClick',
  'uiHover',
];

export interface SfxOptions {
  gain?: number;
  rate?: number;
}

/** SFX that deserve a little of the shared reverb send (used by the mixer in audio.ts). */
export const SFX_REVERB: ReadonlySet<SfxName> = new Set<SfxName>([
  'explosionBig',
  'mineBlast',
  'bridgeCollapse',
  'subLaunch',
  'laugh',
  'flagCapture',
  'bailOut',
]);

/** SFX loud enough to duck the music (big low-end events). */
export const SFX_DUCK: ReadonlySet<SfxName> = new Set<SfxName>([
  'explosionBig',
  'mineBlast',
  'bridgeCollapse',
  'subLaunch',
]);

interface SfxCtx {
  ctx: BaseAudioContext;
  out: AudioNode;
  t: number;
  rate: number;
  gain: number;
}

interface FilterSpec {
  type: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  gainDb?: number;
}

interface AmpSpec {
  peak: number;
  atk?: number;
  dec: number;
}

/* ------------------------------------------------------------------ primitives */

/** Filtered noise burst: the workhorse for explosions, impacts, splashes and clatter. */
function nz(s: SfxCtx, at: number, filt: FilterSpec, amp: AmpSpec, kind: NoiseKind = 'white', rate = 1): number {
  const { ctx, out } = s;
  const r = s.rate * rate;
  const dec = amp.dec / s.rate;
  const atk = (amp.atk ?? 0.002) / s.rate;
  const src = noiseSource(ctx, kind, r);
  const f = biquad(ctx, filt.type, clamp(filt.f0 * r, 20, ctx.sampleRate * 0.45), filt.q ?? 0.8, filt.gainDb ?? 0);
  if (filt.f1 !== undefined) sweepHz(f.frequency, at, filt.f0 * r, filt.f1 * r, atk + dec);
  const g = gainNode(ctx, 0);
  const end = percEnv(g.gain, at, amp.peak * s.gain, atk, dec);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  startNoise(src, at);
  selfDestruct(src, end + 0.02, [src, f, g]);
  return end;
}

interface ToneSpec {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  peak: number;
  atk?: number;
  dec: number;
  detune?: number;
  drive?: number;
}

/** Pitched blip/thump with an optional pitch sweep and soft-drive stage. */
function tn(s: SfxCtx, at: number, o: ToneSpec): number {
  const { ctx, out } = s;
  const dec = o.dec / s.rate;
  const atk = (o.atk ?? 0.003) / s.rate;
  const src = osc(ctx, o.type ?? 'sine', o.f0 * s.rate, o.detune ?? 0);
  if (o.f1 !== undefined) sweepHz(src.frequency, at, o.f0 * s.rate, o.f1 * s.rate, atk + dec);
  const g = gainNode(ctx, 0);
  const end = percEnv(g.gain, at, o.peak * s.gain, atk, dec);
  const chain: AudioNode[] = [src, g];
  if (o.drive) {
    const ws = shaper(ctx, 'soft', o.drive);
    src.connect(ws);
    ws.connect(g);
    chain.push(ws);
  } else {
    src.connect(g);
  }
  g.connect(out);
  src.start(at);
  selfDestruct(src, end + 0.02, chain);
  return end;
}

/** Inharmonic partial stack — the difference between "metal ring" and "dull thud". */
function ring(
  s: SfxCtx,
  at: number,
  freqs: readonly number[],
  dec: number,
  peak: number,
  type: OscillatorType = 'sine',
): number {
  const { ctx, out } = s;
  let end = at;
  const chain: AudioNode[] = [];
  const sources: OscillatorNode[] = [];
  freqs.forEach((f, i) => {
    const d = (dec * (1 - i * 0.14)) / s.rate;
    const o = osc(ctx, type, f * s.rate, rand(-6, 6));
    const g = gainNode(ctx, 0);
    const e = percEnv(g.gain, at, (peak * s.gain) / (1 + i * 0.7), 0.002 / s.rate, d);
    o.connect(g);
    g.connect(out);
    o.start(at);
    chain.push(o, g);
    sources.push(o);
    end = Math.max(end, e);
  });
  for (const o of sources) stopSrc(o, end + 0.02);
  const last = sources[sources.length - 1];
  if (last) {
    last.onended = () => {
      disconnectAll(chain);
      last.onended = null;
    };
  }
  return end;
}

/** Short pitch-dropping sine — the "thump" body under every explosion. */
function thump(s: SfxCtx, at: number, f0: number, f1: number, dec: number, peak: number): number {
  return tn(s, at, { type: 'sine', f0, f1, peak, atk: 0.004, dec });
}

/* --------------------------------------------------------------------- recipes */

function explosionSmall(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  // A 120 mm shell going off. Measured against the previous recipe, this sound had 0.8 % of its
  // power below 80 Hz and was over in 0.37 s: a click with a boom glued on, not a detonation.
  // The weight is in the two stacked sweeps, the dirt is in the brown tail, and the crack is
  // the case coming apart.
  end = Math.max(end, thump(s, t, 150, 30, 0.7, 0.85));
  end = Math.max(end, thump(s, t + 0.03, 84, 24, 1.05, 0.7));
  end = Math.max(end, nz(s, t, { type: 'lowpass', f0: 2000, f1: 120, q: 1.0 }, { peak: 0.85, atk: 0.002, dec: 0.72 }));
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 3000, q: 0.7 }, { peak: 1.0, atk: 0.0008, dec: 0.06 }));
  end = Math.max(end, nz(s, t + 0.03, { type: 'lowpass', f0: 45, q: 0.7 }, { peak: 0.52, atk: 0.03, dec: 1.1 }, 'brown'));
  end = Math.max(end, nz(s, t + 0.04, { type: 'lowpass', f0: 210, q: 0.6 }, { peak: 0.6, atk: 0.05, dec: 1.4 }, 'brown'));
  end = Math.max(end, nz(s, t + 0.06, { type: 'bandpass', f0: 700, f1: 220, q: 0.7 }, { peak: 0.3, atk: 0.02, dec: 1.0 }));
  // Clods and shrapnel: fewer and lower than before, so they read as debris coming down rather
  // than as a row of ticks over the top of the blast.
  for (let i = 0; i < 5; i++) {
    const at = t + rand(0.06, 0.7);
    end = Math.max(end, nz(s, at, { type: 'bandpass', f0: rand(900, 2000), q: 5 }, { peak: rand(0.05, 0.13), atk: 0.001, dec: rand(0.04, 0.11) }, 'white', 1.1));
  }
  return end + 0.08;
}

function explosionBig(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, thump(s, t, 150, 26, 1.5, 1.0));
  end = Math.max(end, thump(s, t + 0.045, 96, 21, 1.9, 0.85));
  end = Math.max(end, nz(s, t, { type: 'lowpass', f0: 1100, f1: 90, q: 1.1 }, { peak: 1.0, atk: 0.004, dec: 0.95 }));
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 4000, q: 0.7 }, { peak: 0.26, atk: 0.001, dec: 0.05 }));
  end = Math.max(end, nz(s, t + 0.05, { type: 'lowpass', f0: 260, q: 0.6 }, { peak: 0.7, atk: 0.05, dec: 2.1 }, 'brown'));
  end = Math.max(end, nz(s, t + 0.1, { type: 'bandpass', f0: 520, f1: 170, q: 0.7 }, { peak: 0.3, atk: 0.03, dec: 1.6 }));
  for (let i = 0; i < 9; i++) {
    const at = t + rand(0.12, 1.5);
    end = Math.max(end, nz(s, at, { type: 'bandpass', f0: rand(700, 1900), q: rand(3, 8) }, { peak: rand(0.04, 0.13), atk: 0.001, dec: rand(0.04, 0.14) }, 'white', rand(0.8, 1.6)));
  }
  return end + 0.1;
}

function gunTank(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  // A 120 mm main gun, not a pop. The previous recipe measured 0.30 s long with 0.6 % of its
  // power below 80 Hz and 1 % above 1.2 kHz: everything it had sat in one 80-250 Hz lump, which
  // is what "terrible, not heavy enough" is describing. What makes a gun *heavy* is the split
  // below - a sub-bass report you feel, a muzzle blast that lasts, a shock crack on top, the
  // breech behind it, and a tail of ground and air returning the bang.
  //
  // 1. The report: two stacked sweeps through the sub-bass carry the weight.
  end = Math.max(end, thump(s, t, 120, 34, 0.85, 0.75));
  end = Math.max(end, thump(s, t + 0.02, 72, 26, 1.25, 0.65));
  // 2. Muzzle blast: broadband and dark, with a body that outlasts the transient.
  end = Math.max(end, nz(s, t, { type: 'lowpass', f0: 1400, f1: 130, q: 1.1 }, { peak: 0.75, atk: 0.0015, dec: 0.62 }));
  end = Math.max(end, nz(s, t + 0.01, { type: 'bandpass', f0: 260, f1: 110, q: 0.7 }, { peak: 0.5, atk: 0.004, dec: 0.9 }));
  // 3. The crack: the shock leaving the muzzle, gone in tens of milliseconds.
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 3200, q: 0.7 }, { peak: 0.85, atk: 0.0006, dec: 0.045 }));
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 6500, q: 0.6 }, { peak: 0.45, atk: 0.0004, dec: 0.022 }));
  // 4. Breech, recoil and the hull ringing around it - behind the report, never over it.
  end = Math.max(end, tn(s, t, { type: 'sawtooth', f0: 190, f1: 52, peak: 0.4, atk: 0.002, dec: 0.22, drive: 3 }));
  end = Math.max(end, ring(s, t + 0.012, [340, 620, 1010], 0.28, 0.13));
  // 5. The tail: ground and air coming back, which is what separates a gun from a firecracker.
  // The bottom octave: a slow brown-noise floor under the sweeps, which is the part of a gun
  // you feel rather than hear. Octave analysis of the first cut showed the whole 20-40 Hz band
  // empty (0.2 %) while 40-80 Hz carried 39 % - weight, but no depth.
  end = Math.max(end, nz(s, t + 0.03, { type: 'lowpass', f0: 45, q: 0.7 }, { peak: 0.62, atk: 0.03, dec: 1.2 }, 'brown'));
  end = Math.max(end, nz(s, t + 0.05, { type: 'lowpass', f0: 190, q: 0.6 }, { peak: 0.62, atk: 0.06, dec: 1.5 }, 'brown'));
  end = Math.max(end, nz(s, t + 0.14, { type: 'bandpass', f0: 420, f1: 150, q: 0.6 }, { peak: 0.2, atk: 0.05, dec: 1.05 }));
  return end + 0.08;
}

function gunChain(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  const shots = 7;
  const gap = 0.055 / s.rate;
  for (let i = 0; i < shots; i++) {
    const at = t + i * gap + rand(-0.004, 0.004);
    const v = 0.75 - i * 0.05;
    end = Math.max(end, nz(s, at, { type: 'bandpass', f0: rand(3900, 4900), q: 2.6 }, { peak: v, atk: 0.0006, dec: 0.028 }));
    end = Math.max(end, nz(s, at, { type: 'highpass', f0: 6000, q: 0.7 }, { peak: v * 0.35, atk: 0.0006, dec: 0.02 }));
    end = Math.max(end, tn(s, at, { type: 'square', f0: rand(780, 1150), f1: 320, peak: v * 0.22, atk: 0.001, dec: 0.03, drive: 2 }));
    end = Math.max(end, thump(s, at, 170, 70, 0.05, v * 0.18));
  }
  end = Math.max(end, nz(s, t + shots * gap, { type: 'lowpass', f0: 2000, f1: 300, q: 0.8 }, { peak: 0.2, atk: 0.005, dec: 0.4 }));
  return end + 0.05;
}

function rocketLaunch(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, nz(s, t, { type: 'bandpass', f0: 320, f1: 2600, q: 1.1 }, { peak: 0.55, atk: 0.09, dec: 0.55 }));
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 1600, q: 0.6 }, { peak: 0.4, atk: 0.12, dec: 0.85 }));
  end = Math.max(end, thump(s, t, 120, 38, 0.45, 0.7));
  end = Math.max(end, nz(s, t + 0.05, { type: 'lowpass', f0: 700, f1: 180, q: 0.7 }, { peak: 0.4, atk: 0.03, dec: 0.9 }, 'pink'));
  end = Math.max(end, tn(s, t + 0.02, { type: 'sawtooth', f0: 90, f1: 320, peak: 0.14, atk: 0.1, dec: 0.6, drive: 2 }));
  return end + 0.08;
}

function grenadeThrow(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  // "whoop": pitch rises fast then falls away, with a breathy edge
  const w = tn(s, t, { type: 'triangle', f0: 420, f1: 1180, peak: 0.46, atk: 0.02, dec: 0.16, drive: 1.6 });
  const w2 = tn(s, t + 0.14, { type: 'triangle', f0: 1180, f1: 520, peak: 0.4, atk: 0.01, dec: 0.2, drive: 1.6 });
  end = Math.max(end, w, w2);
  end = Math.max(end, tn(s, t + 0.03, { type: 'sine', f0: 2100, f1: 2800, peak: 0.17, atk: 0.02, dec: 0.26 }));
  end = Math.max(end, nz(s, t, { type: 'bandpass', f0: 900, f1: 2400, q: 0.9 }, { peak: 0.18, atk: 0.03, dec: 0.28 }));
  return end + 0.05;
}

function mineDrop(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  for (let i = 0; i < 3; i++) {
    const at = t + i * 0.085;
    end = Math.max(end, nz(s, at, { type: 'bandpass', f0: 3200 + i * 900, q: 3.5 }, { peak: 0.55 - i * 0.1, atk: 0.0008, dec: 0.07 }));
    end = Math.max(end, nz(s, at, { type: 'highpass', f0: 6500, q: 0.7 }, { peak: 0.16, atk: 0.0008, dec: 0.03 }));
    end = Math.max(end, ring(s, at, [1240 * (1 + i * 0.12), 1960 * (1 + i * 0.1), 3320], 0.2, 0.24));
    end = Math.max(end, thump(s, at, 190, 95, 0.07, 0.2));
  }
  end = Math.max(end, tn(s, t, { type: 'triangle', f0: 700, f1: 520, peak: 0.2, atk: 0.002, dec: 0.22 }));
  return end + 0.05;
}

function mineBlast(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, thump(s, t, 110, 20, 2.2, 1.0));
  end = Math.max(end, thump(s, t + 0.07, 70, 17, 2.6, 0.9));
  end = Math.max(end, nz(s, t, { type: 'lowpass', f0: 800, f1: 80, q: 1.3 }, { peak: 1.0, atk: 0.006, dec: 1.6 }));
  end = Math.max(end, nz(s, t, { type: 'lowpass', f0: 180, q: 0.6 }, { peak: 0.8, atk: 0.02, dec: 3.0 }, 'brown'));
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 2600, q: 0.7 }, { peak: 0.24, atk: 0.001, dec: 0.07 }));
  end = Math.max(end, nz(s, t + 0.12, { type: 'bandpass', f0: 420, f1: 130, q: 0.8 }, { peak: 0.5, atk: 0.06, dec: 2.3 }));
  for (let i = 0; i < 6; i++) {
    const at = t + rand(0.2, 2.2);
    end = Math.max(end, nz(s, at, { type: 'bandpass', f0: rand(600, 2000), q: rand(4, 9) }, { peak: rand(0.05, 0.13), atk: 0.002, dec: rand(0.05, 0.2) }));
  }
  return end + 0.1;
}

function impactMetal(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, nz(s, t, { type: 'bandpass', f0: 2800, q: 1.4 }, { peak: 0.6, atk: 0.0008, dec: 0.05 }));
  end = Math.max(end, ring(s, t, [317, 623, 1041, 1780, 2610], 0.9, 0.34));
  end = Math.max(end, thump(s, t, 200, 95, 0.12, 0.35));
  return end + 0.05;
}

function impactGround(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, nz(s, t, { type: 'lowpass', f0: 700, f1: 140, q: 0.8 }, { peak: 0.75, atk: 0.002, dec: 0.22 }));
  end = Math.max(end, thump(s, t, 130, 48, 0.2, 0.6));
  end = Math.max(end, nz(s, t + 0.01, { type: 'bandpass', f0: 1600, q: 1.2 }, { peak: 0.1, atk: 0.001, dec: 0.06 }));
  return end + 0.04;
}

function impactWater(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 900, q: 0.6 }, { peak: 0.6, atk: 0.004, dec: 0.4 }));
  end = Math.max(end, tn(s, t, { type: 'sine', f0: 900, f1: 260, peak: 0.4, atk: 0.002, dec: 0.14 }));
  end = Math.max(end, nz(s, t + 0.03, { type: 'bandpass', f0: 500, f1: 1300, q: 1.4 }, { peak: 0.3, atk: 0.01, dec: 0.35 }));
  for (let i = 0; i < 6; i++) {
    const at = t + 0.12 + i * rand(0.05, 0.1);
    end = Math.max(end, tn(s, at, { type: 'sine', f0: rand(500, 1400), f1: rand(900, 2200), peak: rand(0.05, 0.14), atk: 0.004, dec: 0.05 }));
  }
  return end + 0.05;
}

function engineStart(s: SfxCtx): number {
  const t = s.t;
  const { ctx, out } = s;
  let end = 0;
  // starter motor whine
  const st = osc(ctx, 'sawtooth', 70);
  const stf = biquad(ctx, 'lowpass', 340, 1.6);
  const stg = gainNode(ctx, 0);
  st.connect(stf);
  stf.connect(stg);
  stg.connect(out);
  sweepHz(st.frequency, t, 55, 190, 0.7);
  adsrEnv(stg.gain, t, 0.22 * s.gain, 0.05, 0.45, 0.2);
  st.start(t);
  selfDestruct(st, t + 0.75, [st, stf, stg]);
  end = Math.max(end, t + 0.75);
  // ignition: three lumpy chugs, then a settling idle
  for (let i = 0; i < 3; i++) {
    const at = t + 0.72 + i * 0.12;
    end = Math.max(end, nz(s, at, { type: 'lowpass', f0: 320, q: 1.6 }, { peak: 0.7 - i * 0.12, atk: 0.006, dec: 0.19 }));
    end = Math.max(end, tn(s, at, { type: 'sawtooth', f0: 62, f1: 44, peak: 0.4, atk: 0.006, dec: 0.16, drive: 3 }));
  }
  // exhaust puff + idle bed that fades out (the engine voice takes over from here)
  end = Math.max(end, nz(s, t + 1.05, { type: 'bandpass', f0: 240, q: 0.9 }, { peak: 0.35, atk: 0.02, dec: 0.6 }, 'pink'));
  const idle = osc(ctx, 'sawtooth', 42);
  const idf = biquad(ctx, 'lowpass', 260, 1.2);
  const idg = gainNode(ctx, 0);
  idle.connect(idf);
  idf.connect(idg);
  idg.connect(out);
  idg.gain.setValueAtTime(0, t + 1.02);
  idg.gain.linearRampToValueAtTime(0.3 * s.gain, t + 1.25);
  idg.gain.setValueAtTime(0.3 * s.gain, t + 1.55);
  idg.gain.linearRampToValueAtTime(0, t + 2.05);
  idle.start(t + 1.0);
  selfDestruct(idle, t + 2.1, [idle, idf, idg]);
  return Math.max(end, t + 2.1);
}

/** Bright bell: two-op FM-ish partial stack with a fast decay. */
function bell(s: SfxCtx, at: number, f: number, dec: number, peak: number): number {
  const { ctx, out } = s;
  const car = osc(ctx, 'sine', f);
  const mod = osc(ctx, 'sine', f * 3.5);
  const modG = gainNode(ctx, f * 1.6);
  mod.connect(modG);
  modG.connect(car.frequency);
  const g = gainNode(ctx, 0);
  const e = percEnv(g.gain, at, peak * s.gain, 0.004, dec);
  car.connect(g);
  g.connect(out);
  car.start(at);
  mod.start(at);
  stopSrc(mod, e + 0.02);
  selfDestruct(car, e + 0.02, [car, mod, modG, g]);
  return e;
}

function flagPickup(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  const notes = [659.25, 830.61, 987.77, 1318.51];
  notes.forEach((f, i) => {
    end = Math.max(end, bell(s, t + i * 0.075, f, 0.45, 0.42));
    end = Math.max(end, bell(s, t + i * 0.075, f * 2, 0.22, 0.16));
  });
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 6000, q: 0.7 }, { peak: 0.22, atk: 0.01, dec: 0.5 }));
  return end + 0.05;
}

function flagCapture(s: SfxCtx): number {
  const t = s.t;
  const { ctx, out } = s;
  let end = 0;
  const notes = [587.33, 739.99, 880, 1174.66, 1479.98];
  notes.forEach((f, i) => {
    end = Math.max(end, bell(s, t + i * 0.11, f, 0.8, 0.55));
  });
  // sustained triumphant pad
  const g = gainNode(ctx, 0);
  const f = biquad(ctx, 'lowpass', 3200, 0.8);
  const detunes = [-8, 0, 9];
  const oscs = detunes.map((d) => osc(ctx, 'sawtooth', 587.33, d));
  for (const o of oscs) {
    o.connect(f);
    o.start(t + 0.45);
  }
  f.connect(g);
  g.connect(out);
  const e = adsrEnv(g.gain, t + 0.45, 0.22 * s.gain, 0.05, 0.5, 0.7);
  for (const o of oscs) stopSrc(o, e + 0.02);
  const last = oscs[oscs.length - 1];
  if (last) {
    last.onended = () => {
      disconnectAll([...oscs, f, g]);
      last.onended = null;
    };
  }
  end = Math.max(end, e);
  end = Math.max(end, nz(s, t + 0.1, { type: 'highpass', f0: 6000, q: 0.6 }, { peak: 0.2, atk: 0.15, dec: 1.1 }));
  return end + 0.05;
}

function alarm(s: SfxCtx): number {
  const t = s.t;
  const { ctx, out } = s;
  let end = 0;
  const f = biquad(ctx, 'bandpass', 1700, 1.1);
  const g = gainNode(ctx, 0);
  const o = osc(ctx, 'square', 660);
  const o2 = osc(ctx, 'square', 1320, 6);
  const o2g = gainNode(ctx, 0.45);
  f.connect(g);
  g.connect(out);
  o.connect(f);
  o2.connect(o2g);
  o2g.connect(f);
  o2.start(t);
  // two-tone klaxon, four cycles
  for (let i = 0; i < 4; i++) {
    const at = t + i * 0.34;
    o.frequency.setValueAtTime(660, at);
    o.frequency.setValueAtTime(880, at + 0.17);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.28 * s.gain, at + 0.03);
    g.gain.setValueAtTime(0.28 * s.gain, at + 0.15);
    g.gain.linearRampToValueAtTime(0.0001, at + 0.19);
    g.gain.setValueAtTime(0.0001, at + 0.3);
    end = at + 0.3;
  }
  o.start(t);
  stopSrc(o2, end + 0.05);
  selfDestruct(o, end + 0.05, [o, o2, o2g, f, g]);
  end = Math.max(end, t + 0.02 + nz(s, t, { type: 'bandpass', f0: 1800, q: 0.9 }, { peak: 0.08, atk: 0.02, dec: 1.2 }));
  return end + 0.05;
}

/** Laughing-skull taunt: detuned saw "ha" syllables shaped by vowel formants. */
function laugh(s: SfxCtx): number {
  const { ctx, out, t } = s;
  let end = t;
  let at = t + 0.02;
  const syllables = 7;
  const vowels: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
    // f, q, amp  — "ah" then "eh" then a darker "aw" for the tail
    [[730, 7, 1], [1180, 9, 0.55], [2600, 11, 0.22]],
    [[560, 8, 1], [1000, 10, 0.5], [2450, 12, 0.18]],
    [[480, 7, 1], [880, 9, 0.45], [2200, 11, 0.15]],
  ];
  for (let i = 0; i < syllables; i++) {
    const v = vowels[i < 3 ? 0 : i < 5 ? 1 : 2];
    const f0 = 165 * Math.pow(0.94, i) * (i % 2 === 1 ? 1.06 : 0.97);
    const dur = 0.15 + (i >= 5 ? 0.12 : 0);
    const chain: AudioNode[] = [];
    // consonant "h": breathy noise burst before the vowel
    end = Math.max(end, nz(s, at, { type: 'bandpass', f0: 1200, f1: 500, q: 1.1 }, { peak: 0.1, atk: 0.004, dec: 0.045 }));
    const mix = gainNode(ctx, 1);
    const voiceOut = gainNode(ctx, 0);
    for (const [fq, q, amp] of v) {
      const bp = biquad(ctx, 'bandpass', fq, q);
      const fg = gainNode(ctx, amp);
      mix.connect(bp);
      bp.connect(fg);
      fg.connect(voiceOut);
      chain.push(bp, fg);
    }
    const direct = gainNode(ctx, 0.16);
    mix.connect(direct);
    direct.connect(voiceOut);
    chain.push(direct);
    const dull = biquad(ctx, 'lowpass', 1800, 0.9);
    voiceOut.connect(dull);
    dull.connect(out);
    chain.push(dull);
    const a = osc(ctx, 'sawtooth', f0 * 1.05, -9);
    const b = osc(ctx, 'sawtooth', f0 * 0.5, 14);
    sweepHz(a.frequency, at, f0 * 1.1, f0 * 0.8, dur);
    sweepHz(b.frequency, at, f0 * 0.56, f0 * 0.41, dur);
    a.connect(mix);
    b.connect(mix);
    const e = percEnv(voiceOut.gain, at, 0.85 * s.gain, 0.014, dur);
    a.start(at);
    b.start(at);
    stopSrc(b, e + 0.02);
    selfDestruct(a, e + 0.02, [a, b, mix, voiceOut, ...chain]);
    chain.push(a, b, mix, voiceOut);
    end = Math.max(end, e);
    at = e + 0.03;
  }
  // dying growl
  end = Math.max(end, tn(s, at, { type: 'sawtooth', f0: 120, f1: 70, peak: 0.25, atk: 0.02, dec: 0.5, drive: 4 }));
  return end + 0.1;
}

function droneHum(s: SfxCtx): number {
  const { ctx, out, t } = s;
  const voice = gainNode(ctx, 1);
  const env = gainNode(ctx, 0);
  const f = biquad(ctx, 'lowpass', 1400, 2.2);
  const oscs = [0, 7, 12, 19].map((semi, i) =>
    osc(ctx, i === 3 ? 'triangle' : 'sawtooth', 110 * Math.pow(2, semi / 12), rand(-14, 14)),
  );
  const trem = osc(ctx, 'sine', 8.5);
  const tremG = gainNode(ctx, 0.22);
  trem.connect(tremG);
  for (const o of oscs) {
    o.connect(f);
    o.start(t);
  }
  f.connect(voice);
  voice.connect(env);
  env.connect(out);
  const e = adsrEnv(env.gain, t, 0.3 * s.gain, 0.12, 0.55, 0.35);
  // subtle amplitude flicker (on its own stage, so the envelope can still reach true 0)
  voice.gain.value = 0.85;
  tremG.connect(voice.gain);
  stopSrc(trem, e + 0.02);
  for (const o of oscs) stopSrc(o, e + 0.02);
  const last = oscs[oscs.length - 1];
  if (last) {
    last.onended = () => {
      disconnectAll([...oscs, f, voice, env, trem, tremG]);
      last.onended = null;
    };
  }
  return e + 0.05;
}

function subLaunch(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  // sonar ping with two decaying echoes
  end = Math.max(end, tn(s, t, { type: 'sine', f0: 1000, f1: 940, peak: 0.5, atk: 0.004, dec: 1.1 }));
  end = Math.max(end, tn(s, t + 0.42, { type: 'sine', f0: 990, f1: 930, peak: 0.16, atk: 0.004, dec: 0.9 }));
  end = Math.max(end, tn(s, t + 0.92, { type: 'sine', f0: 980, f1: 920, peak: 0.06, atk: 0.004, dec: 0.8 }));
  // launch: water rush + low rumble
  end = Math.max(end, nz(s, t + 0.05, { type: 'lowpass', f0: 500, f1: 120, q: 0.8 }, { peak: 0.6, atk: 0.08, dec: 1.6 }, 'brown'));
  end = Math.max(end, nz(s, t + 0.05, { type: 'bandpass', f0: 400, f1: 1800, q: 0.9 }, { peak: 0.3, atk: 0.2, dec: 1.2 }));
  end = Math.max(end, thump(s, t + 0.08, 90, 30, 1.2, 0.6));
  end = Math.max(end, nz(s, t + 0.3, { type: 'highpass', f0: 2500, q: 0.6 }, { peak: 0.12, atk: 0.3, dec: 1.0 }));
  return end + 0.1;
}

function resupply(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  [523.25, 659.25, 783.99].forEach((f, i) => {
    end = Math.max(end, bell(s, t + i * 0.09, f, 0.6, 0.45));
  });
  end = Math.max(end, nz(s, t + 0.3, { type: 'bandpass', f0: 1800, q: 2.4 }, { peak: 0.22, atk: 0.004, dec: 0.12 }));
  end = Math.max(end, thump(s, t + 0.3, 220, 110, 0.14, 0.3));
  return end + 0.05;
}

function buildDone(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  // hammer taps
  for (let i = 0; i < 2; i++) {
    const at = t + i * 0.14;
    end = Math.max(end, nz(s, at, { type: 'bandpass', f0: 2000 + i * 400, q: 2 }, { peak: 0.4, atk: 0.001, dec: 0.06 }));
    end = Math.max(end, thump(s, at, 240, 120, 0.1, 0.3));
  }
  // rising confirmation triad
  [587.33, 739.99, 880, 1174.66].forEach((f, i) => {
    end = Math.max(end, bell(s, t + 0.32 + i * 0.08, f, 0.7, 0.45));
  });
  end = Math.max(end, tn(s, t + 0.32, { type: 'sawtooth', f0: 146.83, peak: 0.16, atk: 0.03, dec: 0.9, drive: 2 }));
  return end + 0.05;
}

function towerFire(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 2200, q: 0.7 }, { peak: 0.5, atk: 0.006, dec: 0.35 }));
  end = Math.max(end, thump(s, t, 150, 45, 0.28, 0.6));
  end = Math.max(end, tn(s, t + 0.04, { type: 'sawtooth', f0: 1400, f1: 260, peak: 0.3, atk: 0.02, dec: 0.7 }));
  end = Math.max(end, nz(s, t + 0.1, { type: 'bandpass', f0: 900, f1: 300, q: 1.1 }, { peak: 0.25, atk: 0.05, dec: 0.7 }, 'pink'));
  return end + 0.05;
}

function bailOut(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, thump(s, t, 130, 50, 0.25, 0.8));
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 2600, q: 0.6 }, { peak: 0.6, atk: 0.002, dec: 0.1 }));
  end = Math.max(end, nz(s, t, { type: 'bandpass', f0: 4200, f1: 3000, q: 1.2 }, { peak: 0.35, atk: 0.001, dec: 0.05 }));
  end = Math.max(end, nz(s, t + 0.06, { type: 'bandpass', f0: 500, f1: 2400, q: 0.9 }, { peak: 0.35, atk: 0.1, dec: 0.6 }));
  end = Math.max(end, tn(s, t + 0.1, { type: 'sine', f0: 1600, f1: 500, peak: 0.18, atk: 0.05, dec: 0.7 }));
  // canopy flaps
  for (let i = 0; i < 3; i++) {
    const at = t + 0.6 + i * 0.22;
    end = Math.max(end, nz(s, at, { type: 'lowpass', f0: 900, f1: 300, q: 0.7 }, { peak: 0.3 - i * 0.06, atk: 0.01, dec: 0.16 }));
  }
  return end + 0.05;
}

function bridgeCollapse(s: SfxCtx): number {
  const t = s.t;
  const { ctx, out } = s;
  let end = 0;
  end = Math.max(end, nz(s, t, { type: 'lowpass', f0: 600, f1: 90, q: 0.9 }, { peak: 0.85, atk: 0.05, dec: 2.4 }, 'brown'));
  end = Math.max(end, thump(s, t, 100, 24, 2.0, 0.9));
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 3000, q: 0.6 }, { peak: 0.3, atk: 0.01, dec: 0.3 }));
  // twisting metal groans: detuned saws dragged through a resonant bandpass
  for (let i = 0; i < 4; i++) {
    const at = t + 0.15 + i * rand(0.3, 0.55);
    const o = osc(ctx, 'sawtooth', rand(90, 220), rand(-25, 25));
    const f = biquad(ctx, 'bandpass', rand(500, 1500), 6);
    const g = gainNode(ctx, 0);
    sweepHz(o.frequency, at, o.frequency.value * 0.6, o.frequency.value * 1.3, rand(0.5, 1.1));
    sweepHz(f.frequency, at, f.frequency.value, f.frequency.value * rand(0.5, 1.8), rand(0.5, 1.1));
    o.connect(f);
    f.connect(g);
    g.connect(out);
    const e = adsrEnv(g.gain, at, 0.2 * s.gain, 0.08, rand(0.2, 0.6), 0.4);
    o.start(at);
    selfDestruct(o, e + 0.02, [o, f, g]);
    end = Math.max(end, e);
  }
  for (let i = 0; i < 12; i++) {
    const at = t + rand(0.1, 2.4);
    end = Math.max(end, nz(s, at, { type: 'bandpass', f0: rand(600, 2000), q: rand(2, 6) }, { peak: rand(0.05, 0.2), atk: 0.002, dec: rand(0.05, 0.3) }, 'white', rand(0.7, 1.4)));
  }
  return end + 0.1;
}

function uiClick(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, nz(s, t, { type: 'highpass', f0: 2500, q: 0.7 }, { peak: 0.35, atk: 0.0006, dec: 0.03 }));
  end = Math.max(end, tn(s, t, { type: 'triangle', f0: 1180, f1: 900, peak: 0.35, atk: 0.001, dec: 0.14 }));
  end = Math.max(end, tn(s, t, { type: 'sine', f0: 2400, peak: 0.15, atk: 0.001, dec: 0.09 }));
  return end + 0.03;
}

function uiHover(s: SfxCtx): number {
  const t = s.t;
  let end = 0;
  end = Math.max(end, nz(s, t, { type: 'bandpass', f0: 4200, q: 1.6 }, { peak: 0.34, atk: 0.001, dec: 0.05 }));
  end = Math.max(end, tn(s, t, { type: 'sine', f0: 2100, f1: 2300, peak: 0.34, atk: 0.002, dec: 0.16 }));
  end = Math.max(end, tn(s, t, { type: 'triangle', f0: 1050, peak: 0.12, atk: 0.002, dec: 0.13 }));
  return end + 0.03;
}

/* ------------------------------------------------------------------ dispatcher */

/**
 * Renders one SFX into `out` starting at `when` (context time).
 * Returns the absolute time at which the voice is silent.
 */
export function renderSfx(
  ctx: BaseAudioContext,
  out: AudioNode,
  name: SfxName,
  when: number,
  opts: SfxOptions = {},
): number {
  // Every recipe sums several layers, so the voice gets its own tanh saturation stage:
  // it glues the layers together and makes "peak <= 0 dBFS" a structural guarantee.
  const clip = shaper(ctx, 'soft', 1.1);
  clip.connect(out);
  const s: SfxCtx = {
    ctx,
    out: clip,
    t: Math.max(0, when),
    rate: clamp(opts.rate ?? 1, 0.25, 4),
    gain: clamp(opts.gain ?? 1, 0, 4),
  };
  switch (name) {
    case 'explosionSmall':
      return explosionSmall(s);
    case 'explosionBig':
      return explosionBig(s);
    case 'gunTank':
      return gunTank(s);
    case 'gunChain':
      return gunChain(s);
    case 'rocketLaunch':
      return rocketLaunch(s);
    case 'grenadeThrow':
      return grenadeThrow(s);
    case 'mineDrop':
      return mineDrop(s);
    case 'mineBlast':
      return mineBlast(s);
    case 'impactMetal':
      return impactMetal(s);
    case 'impactGround':
      return impactGround(s);
    case 'impactWater':
      return impactWater(s);
    case 'engineStart':
      return engineStart(s);
    case 'flagPickup':
      return flagPickup(s);
    case 'flagCapture':
      return flagCapture(s);
    case 'alarm':
      return alarm(s);
    case 'laugh':
      return laugh(s);
    case 'droneHum':
      return droneHum(s);
    case 'subLaunch':
      return subLaunch(s);
    case 'resupply':
      return resupply(s);
    case 'buildDone':
      return buildDone(s);
    case 'towerFire':
      return towerFire(s);
    case 'bailOut':
      return bailOut(s);
    case 'bridgeCollapse':
      return bridgeCollapse(s);
    case 'uiClick':
      return uiClick(s);
    case 'uiHover':
      return uiHover(s);
  }
}
