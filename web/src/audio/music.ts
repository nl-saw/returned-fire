/**
 * Classical themes — public-domain melodies (Holst, Wagner, Rossini, Handel, Verdi)
 * re-encoded here as note/velocity/duration data and synthesised from scratch. No samples,
 * no files: this is the FALLBACK layer. When the real recordings in `./music` are present
 * they lead (see `MP3_URLS` in audio.ts); each theme below synthesises the same piece its
 * recording plays, so a missing file degrades to the same music, not a different one.
 *
 * Vehicle themes are deliberately war pieces: Mars for the tank, Ride of the Valkyries for
 * the helicopter, the William Tell gallop for the jeep and Dies Irae for the HRSV (and the
 * title screen). Bumblebee and Mountain King dropped out of this set when the vehicle
 * themes were re-cut to a war theme — their recordings still ship in `./music`.
 *
 * Each theme is one phrase looped a few times with a per-repeat dynamic (and, where the
 * original does it, a transposition), which lands every loop in the 20-45 s window the
 * game wants without shipping a whole movement.
 *
 * Sequence notation: `pitch:beats` tokens, whitespace separated.
 *   `A4:1`      → A4 for one beat        `-:0.5` → rest
 *   `~:0.5`     → extend the previous note   `A4:1@0.6` → explicit velocity
 */
import type { ThemeName } from '../assets/types';
import {
  adsrEnv,
  biquad,
  clamp,
  disconnectAll,
  gainNode,
  midiToHz,
  noiseSource,
  noteToMidi,
  osc,
  percEnv,
  selfDestruct,
  shaper,
  startNoise,
  stopSrc,
  sweepHz,
  type AudioCtx,
} from './dsp';

/* ------------------------------------------------------------------ notation */

/** One line event: pitch name ('-' rest, '~' tie), length in beats, velocity 0..1. */
export interface Ev {
  readonly p: string;
  readonly b: number;
  readonly v: number;
}

export function parseSeq(src: string): Ev[] {
  const out: Ev[] = [];
  for (const tok of src.trim().split(/\s+/)) {
    if (!tok) continue;
    const [pb, vb] = tok.split('@');
    const [p, bs] = pb.split(':');
    out.push({ p, b: bs ? Number(bs) : 1, v: vb ? Number(vb) : 1 });
  }
  return out;
}

export type PercKind = 'kick' | 'snare' | 'hat' | 'timpani' | 'tom' | 'crash' | 'tri' | 'wood';

/** Percussive hit at `b` beats into the phrase. */
export interface PercEv {
  readonly k: PercKind;
  readonly b: number;
  readonly v?: number;
}

export interface VoiceSpec {
  readonly wave: OscillatorType;
  readonly gain: number;
  readonly attack: number;
  readonly release: number;
  readonly cutoff: number;
  /** vibrato depth in cents (0 disables the shared vibrato bus for this line) */
  readonly vib: number;
  readonly sub?: number;
}

export interface ThemeDef {
  readonly label: string;
  readonly key: string;
  readonly meter: string;
  /** quarter-note beats per minute */
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly repeats: number;
  readonly transpose?: readonly number[];
  /** transpose the bass line with the melody (used by the Mountain King crescendo) */
  readonly transposeBass?: boolean;
  readonly dynamics?: readonly number[];
  readonly melody: readonly Ev[];
  readonly bass: readonly Ev[];
  readonly perc: readonly PercEv[];
  readonly lead: VoiceSpec;
  readonly harm: VoiceSpec;
  /** beats played by `sting()` (one-shot, non-looping); defaults to the whole phrase */
  readonly stingBeats?: number;
  readonly reverb?: number;
}

/* --------------------------------------------------------------- theme data */

// Holst, "Mars" (G): the 5/4 col-legno ostinato (3+3+2+2 eighths) under a brass line.
const MARS = parseSeq(`
  -:0.5 G3:0.5 -:0.5 G3:0.5 -:0.5 G3:0.5 G3:0.5 -:0.5 G3:0.5 G3:0.5
  -:0.5 G3:0.5 -:0.5 G3:0.5 -:0.5 G3:0.5 G3:0.5 -:0.5 G3:0.5 G3:0.5
  G3:1 Bb3:1 D4:1.5 Eb4:0.5 D4:1
  G3:1 Bb3:1 D4:1.5 F4:0.5 Eb4:1
  G3:1 Bb3:1 D4:1.5 Eb4:0.5 D4:1
  C4:1 Eb4:1 G4:1.5 F4:0.5 Eb4:1
`);
const MARS_BASS = parseSeq(`
  G2:1 G2:1 G2:1 G2:1 G2:1
  G2:1 G2:1 G2:1 G2:1 G2:1
  G2:1 G2:1 G2:1 G2:1 G2:1
  G2:1 G2:1 G2:1 G2:1 G2:1
  G2:1 G2:1 G2:1 G2:1 G2:1
  C3:1 C3:1 C3:1 C3:1 C3:1
`);

// Wagner, "Ride of the Valkyries" (B major, 9/8): triadic fanfare over the B major chord.
const VALKYRIES = parseSeq(`
  B4:1 D#5:0.5 B4:0.5 F#5:1 B5:0.5 F#5:0.5 B5:1 D#6:0.5 B5:0.5
  F#6:1 D#6:0.5 B5:0.5 F#5:1 B5:0.5 D#6:0.5 F#6:2
`);
const VALKYRIES_BASS = parseSeq(`
  B2:1 B2:1 B2:1 B2:1 B2:1 B2:1
  F#2:1 F#2:1 F#2:1 F#2:1 F#2:1 F#2:1
`);

// Rossini, "William Tell" finale (E major, 2/4): the galop.
const WILLIAM_TELL = parseSeq(`
  E5:0.25 E5:0.25 E5:0.25 E5:0.25 E5:0.25 E5:0.25 E5:0.25 E5:0.25
  E5:0.25 E5:0.25 F#5:0.25 G#5:0.25 A5:0.5 G#5:0.5
  E5:0.25 E5:0.25 E5:0.25 E5:0.25 E5:0.25 E5:0.25 E5:0.25 E5:0.25
  B5:0.25 B5:0.25 A5:0.25 G#5:0.25 F#5:0.5 E5:0.5
`);
const WILLIAM_TELL_BASS = parseSeq(`
  E3:0.5 E3:0.5 E3:0.5 E3:0.5 E2:0.5 E2:0.5 B2:0.5 B2:0.5
  E3:0.5 E3:0.5 A2:0.5 A2:0.5 B2:0.5 B2:0.5 E3:0.5 E3:0.5
`);

// Handel, "Hallelujah" (D major): four statements falling through I-vi-IV-V.
const HALLELUJAH = parseSeq(`
  D5:1 D5:0.5 D5:0.5 A4:2
  B4:1 B4:0.5 B4:0.5 F#4:2
  G4:1 G4:0.5 G4:0.5 D4:2
  A4:1 A4:0.5 A4:0.5 E4:2
  A4:0.5 B4:0.5 C#5:0.5 D5:0.5 E5:1 D5:0.5 C#5:0.5 B4:1 A4:0.5 B4:0.5 C#5:0.5 D5:0.5 E5:1
  D5:1 D5:0.5 D5:0.5 D5:2
`);
const HALLELUJAH_BASS = parseSeq(`
  D3:2 D3:2
  B2:2 B2:2
  G2:2 G2:2
  A2:2 A2:2
  D3:1 A2:1 D3:1 A2:1 D3:1 A2:1 D3:1 A2:1
  D3:2 D3:2
`);

// Verdi, "Dies Irae" (G minor): the plainchant line hammered out over a G minor pedal.
const DIES_IRAE = parseSeq(`
  G4:1 G4:1 G4:1 Eb4:1 G4:1 F#4:1 G4:2
  G4:1 G4:1 G4:1 Eb4:1 G4:1 F#4:1 G4:2
  Bb4:1 Bb4:1 Bb4:1 G4:1 Bb4:1 A4:1 Bb4:2
  G4:1 F4:1 Eb4:1 D4:1 C4:1 Bb3:1 A3:1 G3:1
`);
const DIES_IRAE_BASS = parseSeq(`
  G2:1 G2:1 G2:1 G2:1 G2:1 G2:1 G2:2
  G2:1 G2:1 G2:1 G2:1 G2:1 G2:1 G2:2
  Bb2:1 Bb2:1 Bb2:1 Bb2:1 Bb2:1 Bb2:1 Bb2:2
  Eb3:1 D3:1 C3:1 Bb2:1 A2:1 G2:1 D3:1 G2:1
`);

// Original sombre sting (D minor): a slow descending lament over Dm - Bb - Gm - A.
const DEFEAT = parseSeq(`
  D5:2 C5:1 Bb4:1 A4:2 F4:2
  G4:2 F4:1 E4:1 D4:2 A3:2
`);
const DEFEAT_BASS = parseSeq(`
  D3:2 D3:2 Bb2:2 Bb2:2
  G2:2 G2:2 A2:2 A2:2
`);
// (16 beats: matches the melody's two 8-beat phrases)

export const THEME_DEFS: Record<ThemeName, ThemeDef> = {
  // The jeep rides the William Tell gallop — a military march, not a circus swarm: the
  // light scout vehicle gets war music (the Bumblebee recording still ships in ./music).
  jeep: {
    label: 'William Tell — Overture',
    key: 'E major',
    meter: '2/4',
    bpm: 152,
    beatsPerBar: 2,
    repeats: 8,
    dynamics: [0.8, 0.9, 1, 1, 1, 1, 1, 1],
    melody: WILLIAM_TELL,
    bass: WILLIAM_TELL_BASS,
    perc: [
      { k: 'snare', b: 0, v: 0.5 },
      { k: 'snare', b: 0.5, v: 0.3 },
      { k: 'snare', b: 1, v: 0.45 },
      { k: 'snare', b: 1.5, v: 0.3 },
      { k: 'kick', b: 0, v: 0.5 },
      { k: 'kick', b: 1, v: 0.4 },
      { k: 'hat', b: 0.5, v: 0.2 },
      { k: 'hat', b: 1.5, v: 0.2 },
    ],
    lead: { wave: 'sawtooth', gain: 0.3, attack: 0.008, release: 0.08, cutoff: 3000, vib: 4 },
    harm: { wave: 'sawtooth', gain: 0.3, attack: 0.012, release: 0.15, cutoff: 620, vib: 0, sub: 0.45 },
    stingBeats: 8,
    reverb: 0.24,
  },
  tank: {
    label: 'Mars, the Bringer of War',
    key: 'G minor',
    meter: '5/4',
    bpm: 138,
    beatsPerBar: 5,
    repeats: 3,
    dynamics: [0.82, 0.92, 1],
    melody: MARS,
    bass: MARS_BASS,
    perc: [
      { k: 'timpani', b: 0, v: 1 },
      { k: 'timpani', b: 1.5, v: 0.4 },
      { k: 'timpani', b: 3, v: 0.7 },
      { k: 'timpani', b: 3.5, v: 0.3 },
      { k: 'timpani', b: 4, v: 0.5 },
      { k: 'crash', b: 0, v: 0.25 },
    ],
    lead: { wave: 'sawtooth', gain: 0.3, attack: 0.03, release: 0.25, cutoff: 2200, vib: 5 },
    harm: { wave: 'square', gain: 0.28, attack: 0.02, release: 0.2, cutoff: 500, vib: 0, sub: 0.5 },
    stingBeats: 10,
    reverb: 0.3,
  },
  // The HRSV rides Dies Irae — the day-of-wrath plainchant under hammered timpani: war music
  // for the heavy assault craft (it shares the recording with the title screen, so starting
  // in one carries the track straight into the battle without a cut).
  hrsv: {
    label: 'Dies Irae',
    key: 'G minor',
    meter: '4/4',
    bpm: 132,
    beatsPerBar: 4,
    repeats: 3,
    dynamics: [0.85, 0.95, 1],
    melody: DIES_IRAE,
    bass: DIES_IRAE_BASS,
    perc: [
      { k: 'timpani', b: 0, v: 1 },
      { k: 'timpani', b: 1, v: 0.4 },
      { k: 'timpani', b: 2, v: 0.7 },
      { k: 'timpani', b: 3, v: 0.4 },
      { k: 'crash', b: 0, v: 0.35 },
      { k: 'snare', b: 2, v: 0.25 },
    ],
    lead: { wave: 'sawtooth', gain: 0.3, attack: 0.02, release: 0.3, cutoff: 2400, vib: 4 },
    harm: { wave: 'square', gain: 0.3, attack: 0.03, release: 0.3, cutoff: 480, vib: 0, sub: 0.55 },
    stingBeats: 16,
    reverb: 0.38,
  },
  heli: {
    label: 'Ride of the Valkyries',
    key: 'B major',
    meter: '9/8',
    bpm: 132,
    beatsPerBar: 3,
    repeats: 6,
    dynamics: [0.75, 0.85, 0.95, 1, 1, 1],
    melody: VALKYRIES,
    bass: VALKYRIES_BASS,
    perc: [
      { k: 'timpani', b: 0, v: 0.8 },
      { k: 'timpani', b: 1.5, v: 0.4 },
      { k: 'timpani', b: 2.5, v: 0.55 },
      { k: 'crash', b: 0, v: 0.2 },
    ],
    lead: { wave: 'sawtooth', gain: 0.28, attack: 0.02, release: 0.18, cutoff: 3000, vib: 6 },
    harm: { wave: 'sawtooth', gain: 0.26, attack: 0.02, release: 0.2, cutoff: 520, vib: 0, sub: 0.5 },
    stingBeats: 9,
    reverb: 0.32,
  },
  flag: {
    label: 'William Tell — Finale',
    key: 'E major',
    meter: '2/4',
    bpm: 152,
    beatsPerBar: 2,
    repeats: 8,
    dynamics: [0.8, 0.9, 1, 1, 1, 1, 1, 1],
    melody: WILLIAM_TELL,
    bass: WILLIAM_TELL_BASS,
    perc: [
      { k: 'snare', b: 0, v: 0.5 },
      { k: 'snare', b: 0.5, v: 0.3 },
      { k: 'snare', b: 1, v: 0.45 },
      { k: 'snare', b: 1.5, v: 0.3 },
      { k: 'kick', b: 0, v: 0.5 },
      { k: 'kick', b: 1, v: 0.4 },
    ],
    lead: { wave: 'square', gain: 0.26, attack: 0.008, release: 0.08, cutoff: 3200, vib: 4 },
    harm: { wave: 'sawtooth', gain: 0.3, attack: 0.012, release: 0.15, cutoff: 620, vib: 0, sub: 0.45 },
    stingBeats: 8,
    reverb: 0.24,
  },
  victory: {
    label: 'Hallelujah Chorus',
    key: 'D major',
    meter: '4/4',
    bpm: 112,
    beatsPerBar: 4,
    repeats: 2,
    dynamics: [0.86, 1],
    melody: HALLELUJAH,
    bass: HALLELUJAH_BASS,
    perc: [
      { k: 'timpani', b: 0, v: 0.9 },
      { k: 'timpani', b: 2, v: 0.4 },
      { k: 'crash', b: 0, v: 0.3 },
      { k: 'tri', b: 1, v: 0.2 },
    ],
    lead: { wave: 'sawtooth', gain: 0.3, attack: 0.02, release: 0.2, cutoff: 3400, vib: 5 },
    harm: { wave: 'sawtooth', gain: 0.3, attack: 0.03, release: 0.25, cutoff: 700, vib: 0, sub: 0.5 },
    stingBeats: 20,
    reverb: 0.4,
  },
  defeat: {
    label: 'Defeat sting',
    key: 'D minor',
    meter: '4/4',
    bpm: 72,
    beatsPerBar: 4,
    repeats: 2,
    dynamics: [0.9, 0.8],
    melody: DEFEAT,
    bass: DEFEAT_BASS,
    perc: [
      { k: 'timpani', b: 0, v: 0.5 },
      { k: 'timpani', b: 8, v: 0.4 },
    ],
    lead: { wave: 'triangle', gain: 0.3, attack: 0.06, release: 0.5, cutoff: 1800, vib: 8 },
    harm: { wave: 'sawtooth', gain: 0.28, attack: 0.08, release: 0.6, cutoff: 420, vib: 0, sub: 0.5 },
    stingBeats: 8,
    reverb: 0.45,
  },
  title: {
    label: 'Dies Irae',
    key: 'G minor',
    meter: '4/4',
    bpm: 132,
    beatsPerBar: 4,
    repeats: 3,
    dynamics: [0.85, 0.95, 1],
    melody: DIES_IRAE,
    bass: DIES_IRAE_BASS,
    perc: [
      { k: 'timpani', b: 0, v: 1 },
      { k: 'timpani', b: 1, v: 0.4 },
      { k: 'timpani', b: 2, v: 0.7 },
      { k: 'timpani', b: 3, v: 0.4 },
      { k: 'crash', b: 0, v: 0.35 },
      { k: 'snare', b: 2, v: 0.25 },
    ],
    lead: { wave: 'sawtooth', gain: 0.3, attack: 0.02, release: 0.3, cutoff: 2400, vib: 4 },
    harm: { wave: 'square', gain: 0.3, attack: 0.03, release: 0.3, cutoff: 480, vib: 0, sub: 0.55 },
    stingBeats: 16,
    reverb: 0.38,
  },
};

export const THEME_ORDER: readonly ThemeName[] = [
  'title',
  'jeep',
  'tank',
  'hrsv',
  'heli',
  'flag',
  'victory',
  'defeat',
];

/** Seconds per beat. */
export function beatSeconds(def: ThemeDef): number {
  return 60 / def.bpm;
}

/** Total loop length in seconds (phrase × repeats). */
export function themeLoopSeconds(def: ThemeDef): number {
  return phraseBeats(def) * def.repeats * beatSeconds(def);
}

export function phraseBeats(def: ThemeDef): number {
  return Math.max(lineBeats(def.melody), lineBeats(def.bass), percBeats(def.perc, def.beatsPerBar));
}

export function lineBeats(line: readonly Ev[]): number {
  // every token (note, rest or tie) advances the cursor by its duration
  let total = 0;
  for (const e of line) total += e.b;
  return total;
}

function percBeats(perc: readonly PercEv[], beatsPerBar: number): number {
  let last = 0;
  for (const h of perc) last = Math.max(last, h.b);
  return Math.ceil(last / beatsPerBar) * beatsPerBar;
}

/* --------------------------------------------------------------- flattening */

export interface FlatNote {
  readonly part: 'melody' | 'bass';
  readonly midi: number;
  /** seconds from the start of the loop */
  readonly time: number;
  readonly dur: number;
  readonly vel: number;
}

export interface FlatPerc {
  readonly kind: PercKind;
  readonly time: number;
  readonly vel: number;
}

export interface FlatTheme {
  readonly notes: readonly FlatNote[];
  readonly perc: readonly FlatPerc[];
  readonly loopBeats: number;
  readonly loopSeconds: number;
}

function flattenLine(
  part: 'melody' | 'bass',
  line: readonly Ev[],
  spb: number,
  beatOffset: number,
  velScale: number,
): FlatNote[] {
  const out: FlatNote[] = [];
  let beat = 0;
  for (const e of line) {
    if (e.p === '~') {
      const prev = out[out.length - 1];
      if (prev) {
        out[out.length - 1] = { ...prev, dur: prev.dur + e.b * spb };
      }
      beat += e.b;
      continue;
    }
    if (e.p !== '-') {
      out.push({
        part,
        midi: noteToMidi(e.p),
        time: (beatOffset + beat) * spb,
        dur: Math.max(0.06, e.b * spb * 0.94),
        vel: clamp(e.v * velScale, 0, 1.5),
      });
    }
    beat += e.b;
  }
  return out;
}

/** Expands a theme into absolute-time events for one full loop cycle. */
export function flattenTheme(def: ThemeDef): FlatTheme {
  const spb = beatSeconds(def);
  const phrase = phraseBeats(def);
  const notes: FlatNote[] = [];
  const perc: FlatPerc[] = [];
  for (let r = 0; r < def.repeats; r++) {
    const offset = r * phrase;
    const shift = def.transpose ? (def.transpose[r % def.transpose.length] ?? 0) : 0;
    const dyn = def.dynamics ? (def.dynamics[r % def.dynamics.length] ?? 1) : 1;
    const bassShift = def.transposeBass ? shift : 0;
    const mel = flattenLine('melody', def.melody, spb, offset, dyn);
    for (const n of mel) notes.push(shift ? { ...n, midi: n.midi + shift } : n);
    const bass = flattenLine('bass', def.bass, spb, offset, dyn);
    for (const n of bass) notes.push(bassShift ? { ...n, midi: n.midi + bassShift } : n);
    for (const h of def.perc) {
      perc.push({ kind: h.k, time: (offset + h.b) * spb, vel: (h.v ?? 1) * dyn });
    }
  }
  notes.sort((a, b) => a.time - b.time);
  perc.sort((a, b) => a.time - b.time);
  return { notes, perc, loopBeats: phrase * def.repeats, loopSeconds: phrase * def.repeats * spb };
}

/** First `count` melody notes of a theme — used by the pitch verification harness. */
export function melodyHead(def: ThemeDef, count: number): FlatNote[] {
  const spb = beatSeconds(def);
  return flattenLine('melody', def.melody, spb, 0, 1).slice(0, count);
}

/* ------------------------------------------------------------------ voices */

/** Global music-voice trim: keeps the bed ~12 dB under the SFX bus before the -14 dB bus gain. */
const MUSIC_TRIM = 0.7;

export interface MusicTargets {
  /** dry bus for musical voices */
  readonly dry: AudioNode;
  /** reverb send (optional) */
  readonly wet?: AudioNode;
}

/** Spawns one melodic note; returns the time it is silent. */
export function spawnNote(
  ctx: AudioCtx,
  targets: MusicTargets,
  spec: VoiceSpec,
  midi: number,
  when: number,
  dur: number,
  vel: number,
  vibBus: AudioNode | null,
): number {
  const f = midiToHz(midi);
  const g = gainNode(ctx, 0);
  const lp = biquad(ctx, 'lowpass', clamp(spec.cutoff + f * 2.2, 200, ctx.sampleRate * 0.4), 1.1);
  const a = osc(ctx, spec.wave, f, -6);
  const b = osc(ctx, spec.wave, f, 7);
  const chain: AudioNode[] = [g, lp, a, b];
  a.connect(lp);
  b.connect(lp);
  let head: AudioNode = lp;
  if (spec.sub) {
    const sub = osc(ctx, 'sine', f / 2, 0);
    const sg = gainNode(ctx, spec.sub);
    sub.connect(sg);
    sg.connect(lp);
    chain.push(sub, sg);
    sub.start(when);
    stopSrc(sub, when + dur + spec.release + 0.05);
  }
  if (spec.wave === 'sawtooth' || spec.wave === 'square') {
    // gentle lowpass drive keeps the synth from sounding like a raw buzzer
    const ws = shaper(ctx, 'soft', 1.2);
    lp.connect(ws);
    chain.push(ws);
    head = ws;
  }
  head.connect(g);
  g.connect(targets.dry);
  if (targets.wet) {
    const send = gainNode(ctx, 0.5);
    g.connect(send);
    send.connect(targets.wet);
    chain.push(send);
  }
  if (vibBus && spec.vib > 0) {
    const vg = gainNode(ctx, spec.vib);
    vibBus.connect(vg);
    vg.connect(a.detune);
    vg.connect(b.detune);
    chain.push(vg);
  }
  const peak = spec.gain * vel * MUSIC_TRIM;
  const end = adsrEnv(g.gain, when, peak, spec.attack, Math.max(0.02, dur - spec.attack), spec.release);
  a.start(when);
  b.start(when);
  for (const s of [a, b]) stopSrc(s, end + 0.02);
  stopSrc(b, end + 0.02);
  selfDestruct(a, end + 0.02, chain);
  return end;
}

/** Spawns one percussion hit. */
export function spawnPerc(ctx: AudioCtx, targets: MusicTargets, kind: PercKind, when: number, vel: number): number {
  const out = targets.dry;
  const mk = (f0: number, f1: number, dec: number, peak: number, type: OscillatorType = 'sine'): number => {
    const o = osc(ctx, type, f0);
    sweepHz(o.frequency, when, f0, f1, dec);
    const g = gainNode(ctx, 0);
    const e = percEnv(g.gain, when, peak * vel * MUSIC_TRIM, 0.003, dec);
    o.connect(g);
    g.connect(out);
    o.start(when);
    selfDestruct(o, e + 0.02, [o, g]);
    return e;
  };
  const noise = (type: BiquadFilterType, f0: number, f1: number, q: number, dec: number, peak: number): number => {
    const src = noiseSource(ctx, 'white', 1.2);
    const f = biquad(ctx, type, f0, q);
    if (f1 !== f0) sweepHz(f.frequency, when, f0, f1, dec);
    const g = gainNode(ctx, 0);
    const e = percEnv(g.gain, when, peak * vel * MUSIC_TRIM, 0.002, dec);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    startNoise(src, when);
    selfDestruct(src, e + 0.02, [src, f, g]);
    return e;
  };
  switch (kind) {
    case 'kick':
      return Math.max(mk(120, 42, 0.22, 0.5), noise('lowpass', 900, 200, 0.8, 0.08, 0.2));
    case 'snare':
      return Math.max(
        noise('bandpass', 1800, 1100, 0.9, 0.16, 0.3),
        mk(210, 160, 0.1, 0.16),
        noise('highpass', 4000, 4000, 0.7, 0.06, 0.12),
      );
    case 'hat':
      return noise('highpass', 7000, 6500, 0.8, 0.05, 0.16);
    case 'timpani':
      return Math.max(mk(98, 82, 0.85, 0.55), noise('lowpass', 500, 200, 0.9, 0.12, 0.16));
    case 'tom':
      return Math.max(mk(190, 110, 0.3, 0.35), noise('lowpass', 1200, 400, 0.8, 0.07, 0.12));
    case 'crash':
      return Math.max(noise('highpass', 5000, 3000, 0.7, 1.4, 0.2), noise('bandpass', 8000, 6000, 0.6, 0.5, 0.1));
    case 'tri':
      return mk(1760, 1760, 0.5, 0.1, 'triangle');
    case 'wood':
      return Math.max(noise('bandpass', 2400, 1800, 3, 0.06, 0.3), mk(700, 500, 0.05, 0.12));
  }
}

/* ------------------------------------------------------------------ player */

export interface ThemePlayerOptions {
  readonly fadeIn?: number;
}

/**
 * Schedules one looping theme. The owner calls `schedule(ctx.currentTime + lookahead)`
 * a few times per second; notes are spawned just ahead of the playhead and every note
 * node releases itself, so a long session never accumulates scheduled events.
 */
export class ThemePlayer {
  private readonly ctx: AudioCtx;
  private readonly gate: GainNode;
  private readonly clip: WaveShaperNode;
  private readonly wetSend: GainNode | null;
  private readonly vib: OscillatorNode | null;
  private readonly vibBus: GainNode | null;
  private readonly def: ThemeDef;
  private readonly flat: FlatTheme;
  private readonly spb: number;
  private readonly loop: boolean;
  private readonly limitBeats: number;

  private startTime = 0;
  private cursor = 0;
  private percCursor = 0;
  private finished = false;
  private disposed = false;

  constructor(
    ctx: AudioCtx,
    dest: AudioNode,
    theme: ThemeName,
    loop: boolean,
    opts: ThemePlayerOptions = {},
  ) {
    this.ctx = ctx;
    this.def = THEME_DEFS[theme];
    this.flat = flattenTheme(this.def);
    this.spb = beatSeconds(this.def);
    this.loop = loop;
    this.limitBeats = loop ? Infinity : (this.def.stingBeats ?? this.flat.loopBeats);
    this.gate = gainNode(ctx, 0);
    // gentle tanh saturation: musical glue and a hard guarantee of no digital clipping
    this.clip = shaper(ctx, 'soft', 1.1);
    this.gate.connect(this.clip);
    this.clip.connect(dest);
    const fade = Math.max(0.02, opts.fadeIn ?? 0.6);
    this.gate.gain.setValueAtTime(0, ctx.currentTime);
    this.gate.gain.linearRampToValueAtTime(1, ctx.currentTime + fade);
    // per-note sends land on this bus; the mixer attaches the convolver via connectWet()
    this.wetSend = this.def.reverb ? gainNode(ctx, this.def.reverb) : null;
    // one shared vibrato bus for the whole theme (cheap and phase-coherent)
    if (this.def.lead.vib > 0) {
      const lfo = osc(ctx, 'sine', 5.4);
      const bus = gainNode(ctx, 1);
      lfo.connect(bus);
      lfo.start(ctx.currentTime);
      this.vib = lfo;
      this.vibBus = bus;
    } else {
      this.vib = null;
      this.vibBus = null;
    }
  }

  connectWet(node: AudioNode): void {
    if (this.wetSend) this.wetSend.connect(node);
  }

  start(when: number): void {
    this.startTime = when;
    this.cursor = 0;
    this.percCursor = 0;
  }

  /** Schedules every event that starts before `until` (context time). */
  schedule(until: number): void {
    if (this.disposed || this.finished) return;
    const cycle = this.flat.loopSeconds;
    // If the timer was starved (hidden tab, long frame), resync instead of flooding the
    // graph with a backlog of stale notes.
    if (until - this.startTime > cycle * 2) {
      const skip = Math.floor((until - this.startTime) / cycle);
      this.startTime += skip * cycle;
    }
    let budget = 96;
    const targets: MusicTargets = this.wetSend ? { dry: this.gate, wet: this.wetSend } : { dry: this.gate };
    while (budget-- > 0) {
      const nextNote = this.flat.notes[this.cursor];
      const nextPerc = this.flat.perc[this.percCursor];
      const noteAt = nextNote ? this.startTime + nextNote.time : Infinity;
      const percAt = nextPerc ? this.startTime + nextPerc.time : Infinity;
      const at = Math.min(noteAt, percAt);
      if (!(at < until)) break;
      if (noteAt <= percAt && nextNote) {
        if (nextNote.time / this.spb >= this.limitBeats) {
          this.finished = true;
          break;
        }
        const spec = nextNote.part === 'melody' ? this.def.lead : this.def.harm;
        spawnNote(this.ctx, targets, spec, nextNote.midi, at, nextNote.dur, nextNote.vel, this.vibBusFor(nextNote.part));
        this.cursor++;
      } else if (nextPerc) {
        if (nextPerc.time / this.spb >= this.limitBeats) {
          this.percCursor++;
          continue;
        }
        spawnPerc(this.ctx, targets, nextPerc.kind, at, nextPerc.vel);
        this.percCursor++;
      }
      if (this.cursor >= this.flat.notes.length || this.percCursor >= this.flat.perc.length) {
        if (!this.loop) {
          this.finished = true;
          break;
        }
        // wrap to the next cycle
        this.startTime += cycle;
        this.cursor = 0;
        this.percCursor = 0;
      }
    }
  }

  private vibBusFor(part: 'melody' | 'bass'): AudioNode | null {
    return part === 'melody' ? this.vibBus : null;
  }

  /** True once a non-looping theme has played everything it was asked to. */
  isFinished(): boolean {
    return this.finished;
  }

  fadeOut(when: number, time: number): void {
    if (this.disposed) return;
    const t = Math.max(0.02, time);
    this.gate.gain.cancelScheduledValues(when);
    this.gate.gain.setValueAtTime(this.gate.gain.value, when);
    this.gate.gain.linearRampToValueAtTime(0, when + t);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.vib) stopSrc(this.vib, this.ctx.currentTime + 0.02);
    if (this.vibBus) disconnectAll([this.vibBus]);
    disconnectAll([this.gate, this.clip, ...(this.wetSend ? [this.wetSend] : [])]);
  }
}

/**
 * Offline helper: renders `seconds` of a theme through a soft clipper (used by the
 * verification harness and by anything that needs a theme without a live context).
 */
export function renderThemeWindow(
  ctx: AudioCtx,
  targets: MusicTargets,
  theme: ThemeName,
  startTime: number,
  seconds: number,
  opts: { melodyOnly?: boolean; gain?: number } = {},
): void {
  const def = THEME_DEFS[theme];
  const flat = flattenTheme(def);
  const limit = startTime + seconds;
  const bus = gainNode(ctx, opts.gain ?? 1);
  const clip = shaper(ctx, 'soft', 1.1);
  bus.connect(clip);
  clip.connect(targets.dry);
  if (targets.wet) {
    const send = gainNode(ctx, 0.3);
    bus.connect(send);
    send.connect(targets.wet);
  }
  const inner: MusicTargets = { dry: bus };
  let vib: OscillatorNode | null = null;
  let vibBus: GainNode | null = null;
  if (def.lead.vib > 0) {
    vib = osc(ctx, 'sine', 5.4);
    vibBus = gainNode(ctx, 1);
    vib.connect(vibBus);
    vib.start(startTime);
    stopSrc(vib, limit + 3);
    const busRef = vibBus;
    vib.onended = () => disconnectAll([busRef]);
  }
  if (!opts.melodyOnly) {
    for (const h of flat.perc) {
      const at = startTime + h.time;
      if (at >= limit) break;
      spawnPerc(ctx, inner, h.kind, at, h.vel);
    }
  }
  for (const n of flat.notes) {
    const at = startTime + n.time;
    if (at >= limit) break;
    if (opts.melodyOnly && n.part !== 'melody') continue;
    const spec = n.part === 'melody' ? def.lead : def.harm;
    spawnNote(ctx, inner, spec, n.midi, at, n.dur, n.vel, n.part === 'melody' ? vibBus : null);
  }
}
