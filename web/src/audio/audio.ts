/**
 * GameAudio implementation — the audio engine's public surface.
 *
 * Signal flow:
 *   sfx voices ──► panner(HRTF) ─┐
 *   engine/loop voices ──────────┼─► sfxGain ─────────────────┐
 *   reverb send ─► convolver ────┘                            ├─► masterGain ─► limiter ─► out
 *   music players ─► musicBus ─► musicGain ─► duck ───────────┘
 *
 * Nothing is allocated until `resume()` (browsers refuse to start a context outside a user
 * gesture), every method is a safe no-op before that, and the two timers that exist are
 * cleared by `suspend()`/`dispose()`.
 */
import type { EngineKind, GameAudio, SfxName, ThemeName } from '../assets/types';
import {
  clamp,
  dbToGain,
  disconnectAll,
  gainNode,
  glide,
  makeImpulseResponse,
} from './dsp';
import { createEngineVoice, createLoopVoice, type EngineVoice, type LoopName, type LoopVoice, type VoiceKind } from './engine';
import { ThemePlayer } from './music';
import { renderSfx, SFX_DUCK, SFX_REVERB } from './sfx';

/** Hard cap on simultaneous one-shot SFX voices. */
export const MAX_VOICES = 24;
/** Music sits this far below the SFX bus by default. */
export const MUSIC_BUS_DB = -14;
const MUSIC_BASE = dbToGain(-14);
/** Engine/loop `set()` calls are rate limited to this interval (seconds). */
const ENGINE_INTERVAL = 0.04;
/** Music lookahead window; players are fed a few times per second. */
const LOOKAHEAD = 0.5;
/** Housekeeping tick period. */
const TICK_MS = 100;

/**
 * The real recordings of the original soundtrack (public-domain classical, 320 kbps gamerip)
 * live in `./music` at the repo root; vite serves them at `/music/` in dev and copies them
 * into `dist/music` on build. A recording leads whenever its file is present — the
 * synthesised theme of the same name is the fallback (missing folder, network error, or a
 * browser that refuses to play the element). `?synth=1` forces the synthesised path for A/B.
 */
const MP3_URLS: Partial<Record<ThemeName, string>> = {
  title: '/music/dies-irae.mp3',
  jeep: '/music/william-tell.mp3',
  tank: '/music/mars.mp3',
  hrsv: '/music/dies-irae.mp3',
  heli: '/music/valkyries.mp3',
  flag: '/music/william-tell.mp3',
  victory: '/music/hallelujah.mp3',
};
const MP3_DISABLED = typeof location !== 'undefined' && new URLSearchParams(location.search).has('synth');

/** One persistent element + source node per recording (a source node may only be created once). */
interface Mp3Rec {
  url: string;
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  /** `el.load()` was called once — calling it again would restart a live element. */
  loaded: boolean;
}

/** A recording currently sounding (or paused across a suspend): its own crossfade gain. */
interface LiveMp3 {
  rec: Mp3Rec;
  gain: GainNode;
  /** null = one-shot sting, not the looping theme */
  theme: ThemeName | null;
  looping: boolean;
}

interface Voice {
  id: number;
  startedAt: number;
  /** requested gain, used to pick the quietest victim when saturated */
  level: number;
  endsAt: number;
  nodes: AudioNode[];
  gain: GainNode;
}

/** A voice that was culled or has finished: kept only long enough to be disconnected. */
interface Retired {
  at: number;
  nodes: AudioNode[];
}

interface Pending {
  listener: { pos: { x: number; y: number; z: number }; yaw: number } | null;
  engine: { kind: EngineKind; load: number; throttle: number };
  loop: { name: LoopName | null; load: number };
  theme: ThemeName | null;
}

/** Extra introspection used by the preview/verification page (not part of the contract). */
export interface GameAudioHandle extends GameAudio {
  voiceCount(): number;
  contextState(): string;
  nodeBudget(): number;
}

export function createGameAudio(): GameAudioHandle {
  let ctx: AudioContext | null = null;
  let unsupported = false;

  let master: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  let sfxBus: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let musicGain: GainNode | null = null;
  let duckGain: GainNode | null = null;
  let reverbIn: GainNode | null = null;
  let engineBus: GainNode | null = null;

  let masterVol = 0.9;
  let musicVol = 1;
  let duckedUntil = 0;

  let voices: Voice[] = [];
  /** culled/finished voices awaiting disconnect; bounded so a flood cannot pile up */
  let retired: Retired[] = [];
  let voiceSeq = 0;
  let engineVoice: EngineVoice | null = null;
  let engineKind: EngineKind = 'none';
  let engineAppliedAt = -1;
  let loopVoice: LoopVoice | null = null;
  let loopName: LoopName | null = null;
  let loopAppliedAt = -1;
  let players: ThemePlayer[] = [];
  let retiring: { player: ThemePlayer; at: number }[] = [];
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /* Recording (MP3) state — see the music section below. */
  let mp3Recs = new Map<string, Mp3Rec>();
  const mp3Failed = new Set<string>();
  let liveMp3s: LiveMp3[] = [];
  let mp3Retiring: { at: number; gain: GainNode; el: HTMLAudioElement }[] = [];

  const pending: Pending = {
    listener: null,
    engine: { kind: 'none', load: 0, throttle: 0 },
    loop: { name: null, load: 0 },
    theme: null,
  };

  /* ------------------------------------------------------------ context setup */

  function isRunning(): boolean {
    return ctx !== null && ctx.state === 'running';
  }

  function createContext(): void {
    if (ctx || unsupported) return;
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) {
      unsupported = true;
      return;
    }
    let c: AudioContext;
    try {
      c = new Ctor({ latencyHint: 'interactive' });
    } catch {
      unsupported = true;
      return;
    }
    ctx = c;

    master = gainNode(c, masterVol);
    limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 4;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    master.connect(limiter);
    limiter.connect(c.destination);

    sfxBus = gainNode(c, 1);
    sfxBus.connect(master);
    engineBus = gainNode(c, 0.85);
    engineBus.connect(sfxBus);

    musicBus = gainNode(c, 1);
    musicGain = gainNode(c, MUSIC_BASE * musicVol);
    duckGain = gainNode(c, 1);
    musicBus.connect(musicGain);
    musicGain.connect(duckGain);
    duckGain.connect(master);

    // one shared synthesised plate for music and the big SFX
    const convolver = c.createConvolver();
    convolver.buffer = makeImpulseResponse(c, 2.2, 2.8, 0.42);
    const reverbReturn = gainNode(c, 0.6);
    reverbIn = gainNode(c, 1);
    reverbIn.connect(convolver);
    convolver.connect(reverbReturn);
    reverbReturn.connect(master);

    applyPending();
    startTick();
  }

  function applyPending(): void {
    if (pending.listener) setListener(pending.listener.pos, pending.listener.yaw);
    // Only start the theme if it is not already playing: a suspend/resume cycle (tab switch)
    // must not drop the track back to bar one either.
    if (pending.theme && pending.theme !== activeTheme) playTheme(pending.theme);
    if (pending.engine.kind !== 'none') {
      setEngine(pending.engine.kind, pending.engine.load, pending.engine.throttle);
    }
    if (pending.loop.name) setLoop(pending.loop.name, pending.loop.load);
  }

  /* ------------------------------------------------------------------ timers */

  function retireNodes(now: number): void {
    for (let i = retired.length - 1; i >= 0; i--) {
      if (now >= retired[i].at) {
        disconnectAll(retired[i].nodes);
        retired.splice(i, 1);
      }
    }
    // hard bound: a pathological flood must not be able to grow this list
    while (retired.length > MAX_VOICES) {
      const old = retired.shift();
      if (old) disconnectAll(old.nodes);
    }
  }

  function startTick(): void {
    if (tickTimer !== null) return;
    tickTimer = setInterval(tick, TICK_MS);
  }

  function stopTick(): void {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /** One timer does all housekeeping: music lookahead, player retirement, voice reaping. */
  function tick(): void {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    for (const p of players) p.schedule(now + LOOKAHEAD);
    for (let i = retiring.length - 1; i >= 0; i--) {
      const r = retiring[i];
      if (now >= r.at) {
        r.player.dispose();
        retiring.splice(i, 1);
      } else if (r.player.isFinished()) {
        // one-shot sting: let its tail ring, then release the nodes
        r.at = Math.min(r.at, now + 1.6);
      }
    }
    for (let i = mp3Retiring.length - 1; i >= 0; i--) {
      const r = mp3Retiring[i];
      if (now >= r.at) {
        // fade complete: pause the element and release its crossfade gain
        r.el.pause();
        disconnectAll([r.gain]);
        mp3Retiring.splice(i, 1);
      }
    }
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (v.endsAt + 0.2 < now) {
        // natural end: the recipe has already stopped its own sources
        disconnectAll(v.nodes);
        voices.splice(i, 1);
      }
    }
    retireNodes(now);
  }

  /* ---------------------------------------------------------------- panners */

  type SpatialNode = PannerNode & {
    positionX?: AudioParam;
    setPosition?: (x: number, y: number, z: number) => void;
  };

  function makePanner(pos: { x: number; y: number; z: number }): PannerNode {
    const c = ctx as AudioContext;
    const p = c.createPanner() as SpatialNode;
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    // 256 m world viewed from 40-80 m up: audible from across the map, still directional
    p.refDistance = 12;
    p.maxDistance = 320;
    p.rolloffFactor = 1.1;
    p.coneInnerAngle = 360;
    p.coneOuterAngle = 360;
    p.coneOuterGain = 1;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else if (p.setPosition) {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    return p;
  }

  function setListener(pos: { x: number; y: number; z: number }, yaw: number): void {
    pending.listener = { pos, yaw };
    if (!ctx) return;
    const c = ctx;
    const l = c.listener as AudioListener & {
      positionX?: AudioParam;
      forwardX?: AudioParam;
      upX?: AudioParam;
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
    };
    // yaw convention: 0 looks down +Z, positive yaw turns towards +X
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const t = c.currentTime;
    if (l.positionX && l.forwardX && l.upX) {
      glide(l.positionX, pos.x, t, 0.02);
      glide(l.positionY, pos.y, t, 0.02);
      glide(l.positionZ, pos.z, t, 0.02);
      glide(l.forwardX, fx, t, 0.02);
      glide(l.forwardY, 0, t, 0.02);
      glide(l.forwardZ, fz, t, 0.02);
      glide(l.upX, 0, t, 0.02);
      glide(l.upY, 1, t, 0.02);
      glide(l.upZ, 0, t, 0.02);
    } else {
      l.setPosition?.(pos.x, pos.y, pos.z);
      l.setOrientation?.(fx, 0, fz, 0, 1, 0);
    }
  }

  /* ------------------------------------------------------------------- SFX */

  function voiceBudget(): number {
    return voices.length;
  }

  /** Picks the voice to sacrifice: quietest first, oldest as the tie-break. */
  function pickVictim(): Voice | null {
    if (voices.length === 0) return null;
    const now = ctx ? ctx.currentTime : 0;
    const old = voices.filter((v) => now - v.startedAt > 0.09);
    const pool = old.length > 0 ? old : voices;
    let best = pool[0];
    let bestScore = Infinity;
    for (const v of pool) {
      const age = clamp((now - v.startedAt) / 4, 0, 1);
      const score = v.level * (1 - 0.45 * age);
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  /** Ramps a voice to silence and hands its nodes to the (bounded) retired list. */
  function killVoice(v: Voice, when: number): void {
    v.gain.gain.cancelScheduledValues(when);
    v.gain.gain.setValueAtTime(v.gain.gain.value, when);
    v.gain.gain.linearRampToValueAtTime(0, when + 0.03);
    retired.push({ at: when + 0.06, nodes: v.nodes });
  }

  function play(
    name: SfxName,
    pos?: { x: number; y: number; z: number },
    opts?: { gain?: number; rate?: number },
  ): void {
    if (!isRunning()) return;
    const c = ctx as AudioContext;
    const bus = sfxBus as GainNode;
    // enforce the cap *before* adding, so `voices` never exceeds MAX_VOICES
    while (voices.length >= MAX_VOICES) {
      const victim = pickVictim();
      if (!victim) break;
      voices.splice(voices.indexOf(victim), 1);
      killVoice(victim, c.currentTime);
    }
    const level = clamp(opts?.gain ?? 1, 0, 4);
    const g = gainNode(c, 1);
    const nodes: AudioNode[] = [g];
    let tail: AudioNode = g;
    if (pos) {
      const p = makePanner(pos);
      g.connect(p);
      nodes.push(p);
      tail = p;
    }
    tail.connect(bus);
    if (reverbIn && SFX_REVERB.has(name)) {
      const send = gainNode(c, 0.32);
      g.connect(send);
      send.connect(reverbIn);
      nodes.push(send);
    }
    const t = c.currentTime + 0.012;
    const endsAt = renderSfx(c, g, name, t, opts);
    voices.push({ id: ++voiceSeq, startedAt: t, level, endsAt, nodes, gain: g });
    if (SFX_DUCK.has(name)) duck(0.42, 0.36);
  }

  /** Sidechain: pull the music down under a big low-end event, then breathe back. */
  function duck(amount: number, hold: number): void {
    if (!ctx || !duckGain) return;
    const t = ctx.currentTime;
    if (t < duckedUntil) return; // already ducking: never stack ramps
    duckedUntil = t + hold + 0.55;
    const p = duckGain.gain;
    const floor = clamp(amount, 0.05, 1);
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(floor, t + 0.02);
    p.setValueAtTime(floor, t + hold);
    p.linearRampToValueAtTime(1, t + hold + 0.5);
  }

  /* --------------------------------------------------------------- engines */

  function setEngine(kind: EngineKind, load: number, throttle: number): void {
    pending.engine = { kind, load, throttle };
    if (!isRunning()) {
      engineKind = kind;
      return;
    }
    const c = ctx as AudioContext;
    const now = c.currentTime;
    if (kind !== engineKind) {
      if (engineVoice) engineVoice.fadeOut(now, 0.35);
      engineVoice = kind === 'none' ? null : createEngineVoice(c, engineBus as GainNode, kind as VoiceKind);
      engineKind = kind;
      engineAppliedAt = -1;
    }
    if (engineVoice && (engineAppliedAt < 0 || now - engineAppliedAt >= ENGINE_INTERVAL)) {
      engineAppliedAt = now;
      engineVoice.set(load, throttle, now);
    }
  }

  function setLoop(name: LoopName | null, load: number): void {
    pending.loop = { name, load };
    if (!isRunning()) {
      loopName = name;
      return;
    }
    const c = ctx as AudioContext;
    const now = c.currentTime;
    if (name !== loopName) {
      if (loopVoice) loopVoice.fadeOut(now, 0.3);
      loopVoice = name === null ? null : createLoopVoice(c, engineBus as GainNode, name);
      loopName = name;
      loopAppliedAt = -1;
    }
    if (loopVoice && (loopAppliedAt < 0 || now - loopAppliedAt >= ENGINE_INTERVAL)) {
      loopAppliedAt = now;
      loopVoice.set(load, now);
    }
  }

  /* ----------------------------------------------------------------- music */

  function retire(player: ThemePlayer, at: number): void {
    retiring.push({ player, at });
  }

  /** The theme actually sounding (synth or recording), so `applyPending` can be idempotent. */
  let activeTheme: ThemeName | null = null;
  /** Dev counter: how many times a track has been started. Surfaced for the probe. */
  let musicStarts = 0;

  /* ------------------------------------------------- recordings (MP3 layer) */

  function ensureMp3Rec(url: string): Mp3Rec | null {
    const c = ctx as AudioContext;
    let rec = mp3Recs.get(url);
    if (rec) return rec;
    try {
      const el = new Audio();
      el.src = url;
      el.preload = 'auto';
      el.loop = true;
      const source = c.createMediaElementSource(el);
      rec = { url, el, source, loaded: false };
      mp3Recs.set(url, rec);
    } catch {
      return null; // no element/source support: this theme rides the synthesised path
    }
    return rec;
  }

  /** Start buffering every mapped recording once the context is live. */
  function prefetchMp3s(): void {
    if (MP3_DISABLED) return;
    const liveUrls = new Set(liveMp3s.map((m) => m.rec.url));
    for (const url of new Set(Object.values(MP3_URLS))) {
      if (liveUrls.has(url)) continue; // playing: `load()` would restart it from the top
      const rec = ensureMp3Rec(url);
      if (rec && !rec.loaded) {
        rec.loaded = true;
        rec.el.load();
      }
    }
  }

  /**
   * Start a recording through the music bus (so volume, ducking and the limiter all apply).
   * Returns null when no element could be created; a later `play()` rejection is reported
   * through `onFail` so the caller can fall back to the synthesised theme.
   */
  function startMp3(theme: ThemeName, looping: boolean, fadeIn: number, onFail?: () => void): LiveMp3 | null {
    const c = ctx as AudioContext;
    const url = MP3_URLS[theme];
    if (MP3_DISABLED || !url || mp3Failed.has(url)) return null;
    const rec = ensureMp3Rec(url);
    if (!rec) return null;
    rec.el.loop = looping;
    if (!looping) {
      try {
        rec.el.currentTime = 0;
      } catch {
        /* not seekable yet — it will start from the top anyway */
      }
    }
    const gain = gainNode(c, 0);
    rec.source.connect(gain);
    gain.connect(musicBus as GainNode);
    const live: LiveMp3 = { rec, gain, theme, looping };
    liveMp3s.push(live);
    const t = c.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + Math.max(0.02, fadeIn));
    if (!looping) rec.el.addEventListener('ended', () => stopLiveMp3(live, 0.5), { once: true });
    const p = rec.el.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        mp3Failed.add(url);
        dropLiveMp3(live);
        onFail?.();
      });
    }
    return live;
  }

  /** Fade a live recording out and hand its nodes to the housekeeping tick. */
  function stopLiveMp3(live: LiveMp3, fade: number): void {
    const c = ctx as AudioContext;
    const t = c.currentTime;
    const g = live.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    mp3Retiring.push({ at: t + fade + 0.15, gain: live.gain, el: live.rec.el });
    const i = liveMp3s.indexOf(live);
    if (i >= 0) liveMp3s.splice(i, 1);
  }

  /** Remove a live recording immediately (its `play()` was rejected). */
  function dropLiveMp3(live: LiveMp3): void {
    const i = liveMp3s.indexOf(live);
    if (i >= 0) liveMp3s.splice(i, 1);
    disconnectAll([live.gain]);
  }

  /* ------------------------------------------------- synthesised fallback */

  function startSynthTheme(theme: ThemeName, fade: number): void {
    const c = ctx as AudioContext;
    const player = new ThemePlayer(c, musicBus as GainNode, theme, true, { fadeIn: fade });
    player.connectWet(reverbIn as GainNode);
    player.start(c.currentTime + 0.03);
    players.push(player);
    activeTheme = theme;
    musicStarts++;
  }

  function startSynthSting(theme: ThemeName): void {
    const c = ctx as AudioContext;
    const now = c.currentTime;
    const player = new ThemePlayer(c, musicBus as GainNode, theme, false, { fadeIn: 0.04 });
    player.connectWet(reverbIn as GainNode);
    player.start(now + 0.03);
    retire(player, now + 30);
  }

  /* ------------------------------------------------------------- switching */

  function playTheme(theme: ThemeName | null, opts?: { fade?: number }): void {
    pending.theme = theme;
    if (!isRunning()) return; // `applyPending` starts it once the context is up
    const c = ctx as AudioContext;
    const now = c.currentTime;
    const fade = Math.max(0.05, opts?.fade ?? 1.2);

    // The same recording already sounding (title and HRSV both ride Dies Irae): keep it
    // exactly where it is instead of cross-fading a track into a restart of itself.
    if (theme !== null && !MP3_DISABLED) {
      const url = MP3_URLS[theme];
      if (url && liveMp3s.some((m) => m.theme !== null && m.rec.url === url)) {
        activeTheme = theme;
        return;
      }
    }

    for (const p of players) {
      p.fadeOut(now, fade);
      retire(p, now + fade + 0.2);
    }
    players = [];
    for (const m of [...liveMp3s]) stopLiveMp3(m, fade);
    if (theme === null) {
      activeTheme = null;
      return;
    }

    const live = startMp3(theme, true, fade, () => startSynthTheme(theme, 0.2));
    if (live) {
      activeTheme = theme;
      musicStarts++;
      return;
    }
    startSynthTheme(theme, fade);
  }

  function sting(theme: ThemeName): void {
    if (!isRunning()) return;
    if (!MP3_DISABLED) {
      const live = startMp3(theme, false, 0.05, () => startSynthSting(theme));
      if (live) {
        musicStarts++;
        return;
      }
    }
    startSynthSting(theme);
  }

  /* --------------------------------------------------------------- volumes */

  function setMasterVolume(v: number): void {
    masterVol = clamp(v, 0, 1);
    if (master && ctx) glide(master.gain, masterVol, ctx.currentTime, 0.03);
  }

  function setMusicVolume(v: number): void {
    musicVol = clamp(v, 0, 1);
    if (musicGain && ctx) glide(musicGain.gain, MUSIC_BASE * musicVol, ctx.currentTime, 0.05);
  }

  /* The values in force, so the settings column can start from the config file rather than
     from whatever the sliders happen to be marked up with. */
  function masterVolume(): number {
    return masterVol;
  }

  function musicVolume(): number {
    return musicVol;
  }

  /* -------------------------------------------------------------- lifecycle */

  async function resume(): Promise<void> {
    // Whether this call is what brings the context up, as opposed to a keep-awake ping while it
    // is already running. Browsers only unlock audio from a gesture, and `main.ts` routes *every*
    // key press and mouse click through here so the context never falls back to sleep — but this
    // used to replay the whole pending state on each of those, and `applyPending` starts the
    // theme from the top. Firing a shot or shifting gear therefore restarted the music mid-track:
    // the reported "the music keeps restarting, in the very same vehicle". (Measured from the game
    // side: its own theme selection fires exactly once per life, so the restart was in here.)
    const wasRunning = ctx?.state === 'running';
    createContext();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* the gesture was not accepted; the next call will try again */
      }
    }
    if (ctx.state === 'running' && !wasRunning) {
      startTick();
      applyPending();
      prefetchMp3s();
      if (pending.theme === null) {
        // Silence was requested while the context was down: drop anything that survived.
        for (const m of [...liveMp3s]) stopLiveMp3(m, 0.1);
      } else {
        // Elements keep their own clock even with a frozen graph, so a suspend paused them;
        // continue each live recording from where it left off instead of restarting it.
        for (const m of liveMp3s) {
          const p = m.rec.el.play();
          if (p && typeof p.catch === 'function') p.catch(() => mp3Failed.add(m.rec.url));
        }
      }
    }
  }

  function suspend(): void {
    stopTick();
    for (const m of liveMp3s) m.rec.el.pause();
    if (ctx && ctx.state === 'running') void ctx.suspend();
  }

  function dispose(): void {
    stopTick();
    for (const v of voices) disconnectAll(v.nodes);
    voices = [];
    for (const r of retired) disconnectAll(r.nodes);
    retired = [];
    engineVoice?.dispose();
    engineVoice = null;
    loopVoice?.dispose();
    loopVoice = null;
    for (const p of players) p.dispose();
    players = [];
    activeTheme = null;
    for (const r of retiring) r.player.dispose();
    retiring = [];
    for (const m of liveMp3s) {
      m.rec.el.pause();
      disconnectAll([m.gain]);
    }
    liveMp3s = [];
    for (const r of mp3Retiring) {
      r.el.pause();
      disconnectAll([r.gain]);
    }
    mp3Retiring = [];
    for (const rec of mp3Recs.values()) {
      rec.el.pause();
      rec.source.disconnect();
      rec.el.removeAttribute('src');
    }
    mp3Recs.clear();
    const c = ctx;
    ctx = null;
    const chain: (AudioNode | null)[] = [master, limiter, sfxBus, musicBus, musicGain, duckGain, reverbIn, engineBus];
    disconnectAll(chain.filter((n): n is AudioNode => n !== null));
    master = null;
    limiter = null;
    sfxBus = null;
    musicBus = null;
    musicGain = null;
    duckGain = null;
    reverbIn = null;
    engineBus = null;
    if (c) void c.close().catch(() => undefined);
  }

  return {
    resume,
    setMasterVolume,
    setMusicVolume,
    masterVolume,
    musicVolume,
    setListener,
    play,
    setEngine,
    setLoop,
    playTheme,
    sting,
    suspend,
    dispose,
    voiceCount: voiceBudget,
    get musicStarts() {
      return musicStarts;
    },
    get mp3Active() {
      return liveMp3s.find((m) => m.theme !== null)?.rec.url ?? null;
    },
    get mp3State() {
      const m = liveMp3s.find((x) => x.theme !== null);
      if (!m) return null;
      const el = m.rec.el;
      return { url: m.rec.url, paused: el.paused, readyState: el.readyState, time: Number(el.currentTime.toFixed(2)) };
    },
    contextState: () => (ctx ? ctx.state : 'closed'),
    nodeBudget: () => voices.length + retired.length + players.length * 8 + liveMp3s.length,
  };
}

/** Re-exported so callers can `import { createGameAudio } from '../audio/audio'`. */
export type { EngineKind, GameAudio, SfxName, ThemeName };
