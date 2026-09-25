/**
 * Persistent engine and loop voices.
 *
 * Each kind is one small graph of oscillators, filtered noise and LFO-driven amplitude
 * modulation. `set()` only ever calls `setTargetAtTime` on existing params, so switching
 * vehicles re-tunes a single voice instead of allocating nodes, and nothing accumulates on
 * the automation timeline. `audio.ts` rate-limits `set()` to ~25 Hz.
 */
import type { EngineKind } from '../assets/types';
import {
  biquad,
  clamp,
  disconnectAll,
  gainNode,
  glide,
  noiseSource,
  osc,
  shaper,
  stopSrc,
  type AudioCtx,
  type CurveKind,
} from './dsp';

export type VoiceKind = Exclude<EngineKind, 'none'>;

export interface EngineVoice {
  readonly kind: VoiceKind;
  /** load and throttle are 0..1; both are smoothed towards over ~100 ms. */
  set(load: number, throttle: number, when: number): void;
  /** Ramps to silence and releases every node; returns the time it is silent. */
  fadeOut(when: number, time: number): number;
  dispose(): void;
}

export type LoopName = 'rotor' | 'tracks' | 'drone';

export interface LoopVoice {
  readonly name: LoopName;
  set(load: number, when: number): void;
  fadeOut(when: number, time: number): number;
  dispose(): void;
}

/** A gain stage with an LFO-driven amplitude modulation layered on top of its base value. */
interface Amped {
  gain: GainNode;
  lfo: OscillatorNode;
  nodes: AudioNode[];
}

function amped(
  ctx: AudioCtx,
  base: number,
  rate: number,
  depth: number,
  shape: CurveKind,
  amount: number,
): Amped {
  const gain = gainNode(ctx, base);
  const lfo = osc(ctx, 'sine', rate);
  const ws = shaper(ctx, shape, amount);
  const d = gainNode(ctx, depth);
  lfo.connect(ws);
  ws.connect(d);
  d.connect(gain.gain);
  lfo.start(0);
  return { gain, lfo, nodes: [ws, d] };
}

interface Rig extends EngineVoice {
  /** Called on every update with the raw 0..1 inputs. */
  apply(load: number, throttle: number, when: number): void;
}

type Reg = (n: AudioNode, s?: AudioScheduledSourceNode) => void;
type RigUpdater = (load: number, throttle: number, when: number) => void;
type RigBuilder = (ctx: AudioCtx, out: GainNode, reg: Reg) => RigUpdater;
type LoopBuilder = (ctx: AudioCtx, out: GainNode, reg: Reg) => (load: number, when: number) => void;

/** Common plumbing: output gain, node bookkeeping, fade-out and dispose. */
function makeRig(
  ctx: AudioCtx,
  kind: VoiceKind,
  dest: AudioNode,
  build: RigBuilder,
): Rig {
  const out = gainNode(ctx, 0);
  out.connect(dest);
  const nodes: AudioNode[] = [out];
  const sources: AudioScheduledSourceNode[] = [];
  const reg: Reg = (n, s) => {
    nodes.push(n);
    if (s) sources.push(s);
  };
  const apply = build(ctx, out, reg);
  let disposed = false;
  // fade the layer in from silence so switching vehicles never clicks
  const t0 = ctx.currentTime;
  out.gain.setValueAtTime(0, t0);
  glide(out.gain, 1, t0, 0.25);
  return {
    kind,
    apply,
    set(load, throttle, when) {
      if (disposed) return;
      apply(clamp(load, 0, 1), clamp(throttle, 0, 1), when);
    },
    fadeOut(when, time) {
      if (disposed) return when;
      glide(out.gain, 0, when, Math.max(0.02, time) / 3);
      const end = when + Math.max(0.02, time) + 0.05;
      for (const s of sources) stopSrc(s, end);
      const last = sources[sources.length - 1];
      if (last) last.onended = () => disposeAll();
      return end;
    },
    dispose: disposeAll,
  };

  function disposeAll(): void {
    if (disposed) return;
    disposed = true;
    for (const s of sources) stopSrc(s, ctx.currentTime + 0.02);
    for (const s of sources) s.onended = null;
    disconnectAll(nodes);
  }
}

/* ------------------------------------------------------------------- engines */

function buildJeep(ctx: AudioCtx, out: GainNode, reg: Reg): RigUpdater {
  // buzzy high-revving four cylinder
  const amp = amped(ctx, 0.72, 30, 0.28, 'hard', 3.5);
  reg(amp.gain, amp.lfo);
  for (const n of amp.nodes) reg(n);

  const lp = biquad(ctx, 'lowpass', 900, 3.2);
  reg(lp);
  lp.connect(amp.gain);
  amp.gain.connect(out);

  const fire = osc(ctx, 'sawtooth', 40);
  const fireUp = osc(ctx, 'sawtooth', 80, 9);
  const sub = osc(ctx, 'sine', 20);
  const whine = osc(ctx, 'triangle', 200, -6);
  const wg = gainNode(ctx, 0.05);
  reg(fire, fire);
  reg(fireUp, fireUp);
  reg(sub, sub);
  reg(whine, whine);
  reg(wg);
  const fg = gainNode(ctx, 0.5);
  const ug = gainNode(ctx, 0.24);
  const sg = gainNode(ctx, 0.42);
  reg(fg);
  reg(ug);
  reg(sg);
  fire.connect(fg);
  fireUp.connect(ug);
  sub.connect(sg);
  whine.connect(wg);
  fg.connect(lp);
  ug.connect(lp);
  sg.connect(lp);
  wg.connect(out);

  // intake growl
  const intake = noiseSource(ctx, 'white', 1, true);
  const ibp = biquad(ctx, 'bandpass', 700, 1.1);
  const ig = gainNode(ctx, 0.04);
  reg(intake, intake);
  reg(ibp);
  reg(ig);
  intake.connect(ibp);
  ibp.connect(ig);
  ig.connect(out);
  intake.start(0);

  return (load, throttle, when) => {
    const t = throttle;
    const f = 27 + t * 135 + load * 6;
    glide(fire.frequency, f, when, 0.12);
    glide(fireUp.frequency, f * 2.02, when, 0.12);
    glide(sub.frequency, f * 0.5, when, 0.12);
    glide(whine.frequency, f * 5.5, when, 0.12);
    glide(lp.frequency, 420 + t * 2400 + load * 500, when, 0.15);
    glide(amp.lfo.frequency, f, when, 0.12);
    glide(amp.gain.gain, 0.8 - load * 0.12, when, 0.15);
    glide(wg.gain, 0.02 + t * 0.06, when, 0.2);
    glide(ig.gain, 0.02 + load * 0.05 + t * 0.05, when, 0.2);
  };
}

function buildTank(ctx: AudioCtx, out: GainNode, reg: Reg): RigUpdater {
  // deep lumpy diesel with track clatter
  const amp = amped(ctx, 0.75, 9, 0.3, 'hard', 2.4);
  reg(amp.gain, amp.lfo);
  for (const n of amp.nodes) reg(n);
  const lp = biquad(ctx, 'lowpass', 320, 2.4);
  reg(lp);
  lp.connect(amp.gain);
  amp.gain.connect(out);

  const sub = osc(ctx, 'sine', 16);
  const body = osc(ctx, 'sawtooth', 32, 11);
  const body2 = osc(ctx, 'sawtooth', 32, -13);
  reg(sub, sub);
  reg(body, body);
  reg(body2, body2);
  const sg = gainNode(ctx, 0.6);
  const bg = gainNode(ctx, 0.3);
  const b2g = gainNode(ctx, 0.26);
  reg(sg);
  reg(bg);
  reg(b2g);
  sub.connect(sg);
  body.connect(bg);
  body2.connect(b2g);
  sg.connect(lp);
  bg.connect(lp);
  b2g.connect(lp);

  // exhaust chuff
  const ex = noiseSource(ctx, 'pink', 1, true);
  const exl = biquad(ctx, 'lowpass', 420, 1.1);
  const exg = gainNode(ctx, 0.05);
  reg(ex, ex);
  reg(exl);
  reg(exg);
  ex.connect(exl);
  exl.connect(exg);
  exg.connect(out);
  ex.start(0);

  // track clatter: noise gated by a fast shaped LFO
  const clat = amped(ctx, 0.22, 20, 0.5, 'hard', 4);
  reg(clat.gain, clat.lfo);
  for (const n of clat.nodes) reg(n);
  const clatN = noiseSource(ctx, 'white', 1.4, true);
  const clatF = biquad(ctx, 'bandpass', 2000, 2.2);
  reg(clatN, clatN);
  reg(clatF);
  clatN.connect(clatF);
  clatF.connect(clat.gain);
  const clatOut = gainNode(ctx, 0.05);
  reg(clatOut);
  clat.gain.connect(clatOut);
  clatOut.connect(out);
  clatN.start(0);

  // track squeak / hull ring
  const ringF = biquad(ctx, 'bandpass', 2600, 7);
  const ringG = gainNode(ctx, 0.02);
  const ringN = noiseSource(ctx, 'white', 1, true);
  reg(ringF);
  reg(ringG);
  reg(ringN, ringN);
  ringN.connect(ringF);
  ringF.connect(ringG);
  ringG.connect(out);
  ringN.start(0);

  return (load, throttle, when) => {
    const f = 13 + throttle * 26 + load * 3;
    glide(sub.frequency, f, when, 0.16);
    glide(body.frequency, f * 2.01, when, 0.16);
    glide(body2.frequency, f * 2.06, when, 0.16);
    glide(lp.frequency, 180 + throttle * 420, when, 0.2);
    glide(amp.lfo.frequency, f * 0.5, when, 0.16);
    glide(amp.gain.gain, 0.82 - load * 0.15, when, 0.2);
    glide(exg.gain, 0.03 + load * 0.06 + throttle * 0.05, when, 0.25);
    glide(clat.lfo.frequency, 9 + throttle * 22, when, 0.2);
    glide(clatOut.gain, 0.012 + load * 0.075, when, 0.25);
    glide(ringG.gain, 0.004 + load * 0.02, when, 0.25);
  };
}

function buildHrsv(ctx: AudioCtx, out: GainNode, reg: Reg): RigUpdater {
  // heavy, slow diesel — all torque, no revs
  const amp = amped(ctx, 0.8, 6, 0.26, 'hard', 2);
  reg(amp.gain, amp.lfo);
  for (const n of amp.nodes) reg(n);
  const lp = biquad(ctx, 'lowpass', 200, 1.8);
  reg(lp);
  const lope = osc(ctx, 'sine', 0.7);
  const lopeD = gainNode(ctx, 40);
  reg(lope, lope);
  reg(lopeD);
  lope.connect(lopeD);
  lopeD.connect(lp.frequency);
  lp.connect(amp.gain);
  amp.gain.connect(out);

  const sub = osc(ctx, 'sine', 11);
  const body = osc(ctx, 'sawtooth', 22, 8);
  const body2 = osc(ctx, 'sawtooth', 22, -10);
  reg(sub, sub);
  reg(body, body);
  reg(body2, body2);
  const sg = gainNode(ctx, 0.7);
  const bg = gainNode(ctx, 0.26);
  const b2g = gainNode(ctx, 0.22);
  reg(sg);
  reg(bg);
  reg(b2g);
  sub.connect(sg);
  body.connect(bg);
  body2.connect(b2g);
  sg.connect(lp);
  bg.connect(lp);
  b2g.connect(lp);

  const ex = noiseSource(ctx, 'brown', 1, true);
  const exl = biquad(ctx, 'lowpass', 260, 0.9);
  const exg = gainNode(ctx, 0.06);
  reg(ex, ex);
  reg(exl);
  reg(exg);
  ex.connect(exl);
  exl.connect(exg);
  exg.connect(out);
  ex.start(0);

  // turbo whistle creeping in under load
  const tw = osc(ctx, 'triangle', 700);
  const twg = gainNode(ctx, 0.0);
  reg(tw, tw);
  reg(twg);
  tw.connect(twg);
  twg.connect(out);

  return (load, throttle, when) => {
    const f = 9 + throttle * 22 + load * 2;
    glide(sub.frequency, f, when, 0.2);
    glide(body.frequency, f * 2.01, when, 0.2);
    glide(body2.frequency, f * 2.04, when, 0.2);
    glide(lp.frequency, 130 + throttle * 220, when, 0.25);
    glide(amp.lfo.frequency, f * 0.5, when, 0.2);
    glide(amp.gain.gain, 0.85 - load * 0.12, when, 0.25);
    glide(exg.gain, 0.035 + load * 0.07, when, 0.3);
    glide(tw.frequency, 500 + throttle * 900, when, 0.25);
    glide(twg.gain, load > 0.5 ? (load - 0.5) * 0.05 : 0, when, 0.3);
  };
}

function buildHeli(ctx: AudioCtx, out: GainNode, reg: Reg): RigUpdater {
  // turbine whine over a rotor-slap mid band
  const core = osc(ctx, 'sawtooth', 110);
  const core2 = osc(ctx, 'sawtooth', 110, 14);
  reg(core, core);
  reg(core2, core2);
  const coreLp = biquad(ctx, 'lowpass', 900, 1.6);
  reg(coreLp);
  const coreG = gainNode(ctx, 0.22);
  reg(coreG);
  core.connect(coreLp);
  core2.connect(coreLp);
  coreLp.connect(coreG);
  coreG.connect(out);

  // blade slap: fast amplitude modulation on a band-limited noise layer
  const slap = amped(ctx, 0.5, 13, 0.42, 'fold', 1.6);
  reg(slap.gain, slap.lfo);
  for (const n of slap.nodes) reg(n);
  const slapN = noiseSource(ctx, 'pink', 1, true);
  const slapF = biquad(ctx, 'bandpass', 260, 1.1);
  reg(slapN, slapN);
  reg(slapF);
  slapN.connect(slapF);
  slapF.connect(slap.gain);
  const slapG = gainNode(ctx, 0.22);
  reg(slapG);
  slap.gain.connect(slapG);
  slapG.connect(out);
  slapN.start(0);

  // turbine whine: two detuned saws through a resonant high band
  const w1 = osc(ctx, 'sawtooth', 900, -5);
  const w2 = osc(ctx, 'sawtooth', 1350, 7);
  const whineF = biquad(ctx, 'bandpass', 2400, 3.5);
  const whineG = gainNode(ctx, 0.055);
  reg(w1, w1);
  reg(w2, w2);
  reg(whineF);
  reg(whineG);
  w1.connect(whineF);
  w2.connect(whineF);
  whineF.connect(whineG);
  whineG.connect(out);

  // compressor hiss
  const hiss = noiseSource(ctx, 'white', 1, true);
  const hissF = biquad(ctx, 'highpass', 3500, 0.7);
  const hissG = gainNode(ctx, 0.02);
  reg(hiss, hiss);
  reg(hissF);
  reg(hissG);
  hiss.connect(hissF);
  hissF.connect(hissG);
  hissG.connect(out);
  hiss.start(0);

  return (load, throttle, when) => {
    const t = throttle;
    glide(core.frequency, 90 + t * 70, when, 0.2);
    glide(core2.frequency, (90 + t * 70) * 1.01, when, 0.2);
    glide(coreLp.frequency, 700 + t * 900, when, 0.25);
    glide(w1.frequency, 820 + t * 520, when, 0.2);
    glide(w2.frequency, (820 + t * 520) * 1.5, when, 0.2);
    glide(whineF.frequency, 2200 + t * 1400, when, 0.25);
    glide(whineG.gain, 0.035 + t * 0.05, when, 0.25);
    glide(slap.lfo.frequency, 11 + t * 5 + load * 3, when, 0.2);
    glide(slapG.gain, 0.1 + load * 0.22, when, 0.25);
    glide(hissG.gain, 0.012 + t * 0.03, when, 0.3);
    glide(coreG.gain, 0.16 + load * 0.12, when, 0.25);
  };
}

function buildDrone(ctx: AudioCtx, out: GainNode, reg: Reg): RigUpdater {
  // electric quadcopter whine
  const bp = biquad(ctx, 'bandpass', 700, 3.2);
  reg(bp);
  const g = gainNode(ctx, 0.34);
  reg(g);
  bp.connect(g);
  g.connect(out);

  const a = osc(ctx, 'sawtooth', 170, -8);
  const b = osc(ctx, 'sawtooth', 170, 9);
  const c = osc(ctx, 'sawtooth', 340, 3);
  reg(a, a);
  reg(b, b);
  reg(c, c);
  a.connect(bp);
  b.connect(bp);
  c.connect(bp);

  // low hum of the frame
  const hum = osc(ctx, 'sine', 52);
  const hum2 = osc(ctx, 'sine', 104, 6);
  const hg = gainNode(ctx, 0.16);
  reg(hum, hum);
  reg(hum2, hum2);
  reg(hg);
  hum.connect(hg);
  hum2.connect(hg);
  hg.connect(out);

  // slow vibrato on the whine
  const vib = osc(ctx, 'sine', 5.2);
  const vibG = gainNode(ctx, 7);
  reg(vib, vib);
  reg(vibG);
  vib.connect(vibG);
  vibG.connect(a.detune);
  vibG.connect(b.detune);

  return (load, throttle, when) => {
    const f = 150 + throttle * 190;
    glide(a.frequency, f, when, 0.15);
    glide(b.frequency, f * 1.004, when, 0.15);
    glide(c.frequency, f * 2.01, when, 0.15);
    glide(bp.frequency, 500 + throttle * 900, when, 0.2);
    glide(bp.Q, 2.4 + load * 3, when, 0.2);
    glide(g.gain, 0.24 + load * 0.16, when, 0.2);
    glide(hg.gain, 0.1 + load * 0.1, when, 0.25);
  };
}

const BUILDERS: Record<VoiceKind, RigBuilder> = {
  jeep: buildJeep,
  tank: buildTank,
  hrsv: buildHrsv,
  heli: buildHeli,
  drone: buildDrone,
};

export function createEngineVoice(ctx: AudioCtx, dest: AudioNode, kind: VoiceKind): EngineVoice {
  return makeRig(ctx, kind, dest, BUILDERS[kind]);
}

/* --------------------------------------------------------------------- loops */

const LOOP_BUILDERS: Record<LoopName, LoopBuilder> = {
  // Blade thump: a shaped LFO amplitude-modulating a low band (no per-beat scheduling,
  // so a 10 minute flight costs exactly the same as a 1 second one).
  rotor: (ctx, out, reg) => {
    const thump = amped(ctx, 0.55, 13, 0.45, 'fold', 1.7);
    reg(thump.gain, thump.lfo);
    for (const n of thump.nodes) reg(n);
    const low = osc(ctx, 'sine', 62);
    const low2 = osc(ctx, 'triangle', 124, 6);
    reg(low, low);
    reg(low2, low2);
    const lg = gainNode(ctx, 0.5);
    reg(lg);
    low.connect(lg);
    low2.connect(lg);
    lg.connect(thump.gain);
    const mid = noiseSource(ctx, 'pink', 1, true);
    const midF = biquad(ctx, 'lowpass', 320, 1.4);
    reg(mid, mid);
    reg(midF);
    const mg = gainNode(ctx, 0.5);
    reg(mg);
    mid.connect(midF);
    midF.connect(mg);
    mg.connect(thump.gain);
    const body = gainNode(ctx, 0.5);
    reg(body);
    thump.gain.connect(body);
    body.connect(out);
    mid.start(0);
    return (load, when) => {
      const rate = 11 + load * 5;
      glide(thump.lfo.frequency, rate, when, 0.15);
      glide(low.frequency, 52 + load * 14, when, 0.2);
      glide(low2.frequency, (52 + load * 14) * 2, when, 0.2);
      glide(midF.frequency, 240 + load * 200, when, 0.25);
      glide(body.gain, 0.4 + load * 0.45, when, 0.2);
      glide(thump.gain.gain, 0.6 - load * 0.15, when, 0.2);
    };
  },
  // Track clatter: same trick with a much faster, sharper gate.
  tracks: (ctx, out, reg) => {
    const gate = amped(ctx, 0.3, 22, 0.6, 'hard', 5);
    reg(gate.gain, gate.lfo);
    for (const n of gate.nodes) reg(n);
    const n1 = noiseSource(ctx, 'white', 1.3, true);
    const f1 = biquad(ctx, 'bandpass', 2200, 1.8);
    reg(n1, n1);
    reg(f1);
    n1.connect(f1);
    f1.connect(gate.gain);
    const rumble = osc(ctx, 'sine', 48);
    const rg = gainNode(ctx, 0.4);
    reg(rumble, rumble);
    reg(rg);
    rumble.connect(rg);
    rg.connect(gate.gain);
    const body = gainNode(ctx, 0.35);
    reg(body);
    gate.gain.connect(body);
    body.connect(out);
    n1.start(0);
    const flutter = osc(ctx, 'sine', 6.3);
    const flutterD = gainNode(ctx, 260);
    reg(flutter, flutter);
    reg(flutterD);
    flutter.connect(flutterD);
    flutterD.connect(f1.frequency);
    return (load, when) => {
      glide(gate.lfo.frequency, 14 + load * 20, when, 0.15);
      glide(f1.frequency, 1800 + load * 900, when, 0.2);
      glide(rumble.frequency, 40 + load * 16, when, 0.2);
      glide(body.gain, 0.25 + load * 0.4, when, 0.2);
    };
  },
  // Quadcopter buzz that follows the pack.
  drone: (ctx, out, reg) => {
    const bp = biquad(ctx, 'bandpass', 800, 4);
    reg(bp);
    const a = osc(ctx, 'sawtooth', 180, -9);
    const b = osc(ctx, 'sawtooth', 180, 11);
    reg(a, a);
    reg(b, b);
    a.connect(bp);
    b.connect(bp);
    const g = gainNode(ctx, 0.3);
    reg(g);
    bp.connect(g);
    g.connect(out);
    const hum = osc(ctx, 'sine', 90);
    const hg = gainNode(ctx, 0.12);
    reg(hum, hum);
    reg(hg);
    hum.connect(hg);
    hg.connect(out);
    const flutter = osc(ctx, 'sine', 7.5);
    const fg = gainNode(ctx, 0.06);
    reg(flutter, flutter);
    reg(fg);
    flutter.connect(fg);
    fg.connect(g.gain);
    return (load, when) => {
      glide(a.frequency, 160 + load * 120, when, 0.15);
      glide(b.frequency, (160 + load * 120) * 1.006, when, 0.15);
      glide(bp.frequency, 650 + load * 700, when, 0.2);
      glide(g.gain, 0.26 + load * 0.2, when, 0.2);
      glide(hg.gain, 0.08 + load * 0.1, when, 0.25);
    };
  },
};

export function createLoopVoice(ctx: AudioCtx, dest: AudioNode, name: LoopName): LoopVoice {
  const build = LOOP_BUILDERS[name];
  const rig = makeRig(ctx, 'drone', dest, (c, o, r) => {
    const update = build(c, o, r);
    return (load, _throttle, when) => update(load, when);
  });
  return {
    name,
    set: (load, when) => rig.set(load, load, when),
    fadeOut: (when, time) => rig.fadeOut(when, time),
    dispose: () => rig.dispose(),
  };
}
