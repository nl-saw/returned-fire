/**
 * The game's configuration file, and the settings that come out of it.
 *
 * Everything the game lets you change lives here: one shipped JSON file of defaults
 * (`web/public/rf.config.json`, copied into `dist/` by the build) plus the player's own changes,
 * which are kept in `localStorage` and layered on top. That split is deliberate - a browser
 * cannot write the file it was served, and a player should not have to edit JSON to turn the
 * music down - so the precedence is:
 *
 *   1. `rf.config.json`      the defaults the build ships (edit this to change the game)
 *   2. `localStorage`        what the player changed in the title screen, and any `rfConfigSet`
 *   3. URL query parameters  the harness/dev surface, applied by `main.ts` on top of both
 *
 * `rev` is the fuse on layers 1 and 2: bump it in `rf.config.json` and every stored change is
 * dropped, so editing a shipped default actually takes effect instead of being outvoted by a
 * value saved months ago. `rfConfig.reset()` does the same on demand.
 *
 * Nothing here can stop the game booting. A missing file, a truncated one, a key of the wrong
 * type or a number out of range all fall back to the built-in defaults with a console warning:
 * the config is a convenience, not a dependency.
 *
 * The simulation's own numbers are the same file under `tuning`, keyed by the dotted paths the
 * engine publishes (`rules.rounds_to_win`, `weapons.heli_cannon.life`, `vehicles.tank.hp`).
 * Only what you list is changed - every other number keeps its compiled-in value - and nested
 * objects are accepted as well as dotted keys, so `{"weapons": {"tank_shell": {"damage": 120}}}`
 * and `{"weapons.tank_shell.damage": 120}` mean the same thing.
 */

export type Quality = 'low' | 'medium' | 'high';
export type Cpu = 'easy' | 'medium' | 'hard';
export type MapModeName = 'classic' | 'mirror';
export type MapSizeName = 'small' | 'medium' | 'big';

export interface MatchConfig {
  cpu: Cpu;
  sandbox: boolean;
  allies: boolean;
  /** Map index; `-1` picks one at random on the first match. */
  map: number;
  mode: MapModeName;
  size: MapSizeName;
  /** 0 = pick one at random. */
  seed: number;
  randomPlay: boolean;
  /** Vehicle offered in the garage for player one and player two. */
  vehicle: number;
  vehicle2: number;
  /** Per-team ceiling on concurrent CPU hulls; 0 = the difficulty's own rule. */
  maxveh: number;
}

export interface VideoConfig {
  quality: Quality;
}

export interface AudioConfig {
  master: number;
  music: number;
}

export interface RuntimeConfig {
  /** Frame cap. 0 = uncapped. */
  fps: number;
  /**
   * Vehicle team-identity look (see `assets/vehicleLook.ts`): 0 stock painted marks, 1 bold hull
   * bands, 2 team pennants, 3 team-coloured ground rings. `DEFAULT_LOOK` in that module is 3 and
   * this file ships the same id, so a config that fails to load looks like one that loads; an id
   * neither of them knows is ignored. `?look=N` still overrides both.
   */
  look: number;
}

export interface GameConfig {
  /** Bumped in `rf.config.json` to invalidate stored changes. */
  rev: string;
  video: VideoConfig;
  audio: AudioConfig;
  match: MatchConfig;
  runtime: RuntimeConfig;
  /** Sparse dotted tuning keys; anything absent keeps the compiled-in value. */
  tuning: Record<string, number>;
}

/** What the title screen's settings column can change. */
export interface PlayerSettings {
  quality?: Quality;
  master?: number;
  music?: number;
  cpu?: Cpu;
  sandbox?: boolean;
  allies?: boolean;
}

const FILE = 'rf.config.json';
const STORE_KEY = 'rf.settings';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The defaults, mirroring `rf.config.json`. Used when the file is absent or unreadable. */
export function defaultConfig(): GameConfig {
  return {
    rev: '1',
    video: { quality: 'high' },
    audio: { master: 0.9, music: 1.0 },
    match: {
      cpu: 'medium',
      sandbox: false,
      allies: false,
      map: 0,
      mode: 'classic',
      size: 'small',
      seed: 0,
      randomPlay: false,
      vehicle: 1,
      vehicle2: 2,
      maxveh: 0,
    },
    runtime: { fps: 60, look: 3 },
    tuning: {},
  };
}

/** Read a nested value by path, e.g. `['audio', 'master']`. */
function getPath(root: unknown, path: string[]): unknown {
  let at: unknown = root;
  for (const key of path) {
    if (!isObj(at)) return undefined;
    at = at[key];
  }
  return at;
}

/** Write a nested value by path, creating the objects along the way. */
function setPath(root: Json, path: string[], value: unknown): void {
  let at = root;
  for (const key of path.slice(0, -1)) {
    const next = at[key];
    if (!isObj(next)) {
      const fresh: Json = {};
      at[key] = fresh;
      at = fresh;
    } else {
      at = next;
    }
  }
  at[path[path.length - 1]] = value;
}

/** Flatten nested objects into dotted keys, so both spellings of a tuning entry work. */
function flatten(prefix: string, value: unknown, out: Record<string, number>, bad: string[]): void {
  if (isNum(value)) {
    out[prefix] = value;
    return;
  }
  if (isObj(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$')) continue;
      flatten(prefix ? `${prefix}.${key}` : key, child, out, bad);
    }
    return;
  }
  bad.push(prefix);
}

/**
 * Copy the settings `src` actually carries onto `dst`, section by section.
 *
 * Written as an explicit list rather than a generic deep merge because the merge *is* the
 * validation: a key that is not in this list cannot reach the game, a wrong type is dropped, and
 * every number is clamped here rather than at the point of use.
 */
export function merge(dst: GameConfig, src: unknown): string[] {
  const dropped: string[] = [];
  if (!isObj(src)) return ['(not an object)'];
  const take = <T>(path: string[], ok: (v: unknown) => v is T, apply: (v: T) => void) => {
    const v = getPath(src, path);
    if (v === undefined) return;
    if (ok(v)) apply(v);
    else dropped.push(path.join('.'));
  };
  const bool = (v: unknown): v is boolean => typeof v === 'boolean';
  const oneOf =
    <T extends string>(allowed: readonly T[]) =>
    (v: unknown): v is T =>
      typeof v === 'string' && (allowed as readonly string[]).includes(v);

  take<string | number>(
    ['rev'],
    (v): v is string | number => typeof v === 'string' || isNum(v),
    (v) => {
      dst.rev = String(v);
    },
  );
  take<Quality>(['video', 'quality'], oneOf(['low', 'medium', 'high'] as const), (v) => {
    dst.video.quality = v;
  });
  // Volumes are 0..1 and clamped: the mixer's gain nodes assume that range.
  take<number>(['audio', 'master'], isNum, (v) => {
    dst.audio.master = Math.min(1, Math.max(0, v));
  });
  take<number>(['audio', 'music'], isNum, (v) => {
    dst.audio.music = Math.min(1, Math.max(0, v));
  });
  take<Cpu>(['match', 'cpu'], oneOf(['easy', 'medium', 'hard'] as const), (v) => {
    dst.match.cpu = v;
  });
  take<boolean>(['match', 'sandbox'], bool, (v) => {
    dst.match.sandbox = v;
  });
  take<boolean>(['match', 'allies'], bool, (v) => {
    dst.match.allies = v;
  });
  take<number>(['match', 'map'], isNum, (v) => {
    dst.match.map = Math.max(-1, Math.round(v));
  });
  take<MapModeName>(['match', 'mode'], oneOf(['classic', 'mirror'] as const), (v) => {
    dst.match.mode = v;
  });
  take<MapSizeName>(['match', 'size'], oneOf(['small', 'medium', 'big'] as const), (v) => {
    dst.match.size = v;
  });
  take<number>(['match', 'seed'], isNum, (v) => {
    dst.match.seed = Math.max(0, Math.round(v)) >>> 0;
  });
  take<boolean>(['match', 'randomPlay'], bool, (v) => {
    dst.match.randomPlay = v;
  });
  take<number>(['match', 'vehicle'], isNum, (v) => {
    dst.match.vehicle = Math.round(v);
  });
  take<number>(['match', 'vehicle2'], isNum, (v) => {
    dst.match.vehicle2 = Math.round(v);
  });
  take<number>(['match', 'maxveh'], isNum, (v) => {
    dst.match.maxveh = Math.max(0, Math.round(v));
  });
  take<number>(['runtime', 'fps'], isNum, (v) => {
    dst.runtime.fps = Math.max(0, v);
  });
  take<number>(['runtime', 'look'], isNum, (v) => {
    dst.runtime.look = Math.max(0, Math.round(v));
  });
  const tuning = getPath(src, ['tuning']);
  if (tuning !== undefined) {
    if (isObj(tuning)) {
      // Keys starting with `$` are documentation, and are skipped rather than warned about.
      const flat: Record<string, number> = {};
      flatten('', tuning, flat, dropped);
      Object.assign(dst.tuning, flat);
    } else {
      dropped.push('tuning');
    }
  }
  return dropped;
}

/** The stored change overlay, if it belongs to the file revision in force. */
function readStore(rev: string): Json {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw) as unknown;
    if (!isObj(parsed)) return {};
    // A stored change belongs to the file revision it was made against. When the shipped
    // defaults change, stored choices are stale by definition and are dropped.
    if (String(parsed.rev ?? '') !== rev) return {};
    return isObj(parsed.values) ? parsed.values : {};
  } catch {
    return {};
  }
}

function writeStore(rev: string, values: Json): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ rev, values }));
  } catch (err) {
    // Private mode, or a full quota, is not a reason to lose the session's settings.
    console.warn('rf: settings could not be stored', err);
  }
}

/** What the file itself said, kept so the overlay can be re-merged on every change. */
let fileLayer: Json = {};
/** The stored overlay: player changes and `rfConfigSet`, as a nested object. */
let overlay: Json = {};
let current: GameConfig = defaultConfig();

/** The config in force. Never null: the built-in defaults are always there to fall back on. */
export function config(): GameConfig {
  return current;
}

/** Whether the shipped file was read (the harness reports this; the game does not care). */
export function configFromFile(): boolean {
  return Object.keys(fileLayer).length > 0;
}

/** The stored changes in force - what `resetOverrides()` would throw away. */
export function overrides(): Json {
  return overlay;
}

/** Mirror the quality onto `<html>` so the stylesheet can drop expensive glass on "low". */
export function applyQualityClass(quality: Quality): void {
  const root = document.documentElement;
  root.classList.remove('rf-q-low', 'rf-q-medium', 'rf-q-high');
  root.classList.add(`rf-q-${quality}`);
}

/** Rebuild the config from the file layer and the overlay. */
function recompute(): GameConfig {
  const cfg = defaultConfig();
  merge(cfg, fileLayer);
  merge(cfg, overlay);
  current = cfg;
  applyQualityClass(cfg.video.quality);
  return cfg;
}

/**
 * Load the shipped config and layer the stored changes on it.
 *
 * Called once, before the game exists, so the renderer can be built at the configured quality.
 */
export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<GameConfig> {
  fileLayer = {};
  try {
    // Relative to the document, so the game works from a subpath and not only a server root.
    const url = new URL(FILE, document.baseURI).href;
    const res = await fetchImpl(url, { cache: 'no-cache' });
    if (res.ok) {
      const parsed: unknown = JSON.parse(await res.text()) as unknown;
      const probe = defaultConfig();
      const dropped = merge(probe, parsed);
      if (dropped.length) console.warn('rf: ignored unusable config keys:', dropped.join(', '));
      fileLayer = isObj(parsed) ? parsed : {};
    } else if (res.status !== 404) {
      console.warn(`rf: ${FILE} returned ${res.status}; using built-in defaults`);
    }
  } catch (err) {
    console.warn(`rf: ${FILE} could not be read; using built-in defaults`, err);
  }
  const probe = defaultConfig();
  merge(probe, fileLayer);
  overlay = readStore(probe.rev);
  const cfg = recompute();
  if (!configFromFile()) console.info('rf: no config file; built-in defaults in force');
  return cfg;
}

/**
 * Change one setting by path and store it, so it survives a reload.
 *
 * This is what the settings column calls (through `setOverrides`), and what `rfConfigSet` uses
 * for anything the UI does not cover - including simulation tuning. The value is checked by the
 * same code that reads the file, so an unusable one is reported rather than reaching the game.
 */
export function patchConfig(path: string[], value: unknown): GameConfig {
  setPath(overlay, path, value);
  const cfg = recompute();
  const check = defaultConfig();
  const dropped = merge(check, overlay);
  if (dropped.length) console.warn('rf: ignored unusable settings:', dropped.join(', '));
  writeStore(cfg.rev, overlay);
  return cfg;
}

/** The settings column's changes, as one patch. */
export function setOverrides(patch: PlayerSettings): GameConfig {
  if (patch.quality !== undefined) patchConfig(['video', 'quality'], patch.quality);
  if (patch.master !== undefined) patchConfig(['audio', 'master'], patch.master);
  if (patch.music !== undefined) patchConfig(['audio', 'music'], patch.music);
  if (patch.cpu !== undefined) patchConfig(['match', 'cpu'], patch.cpu);
  if (patch.sandbox !== undefined) patchConfig(['match', 'sandbox'], patch.sandbox);
  if (patch.allies !== undefined) patchConfig(['match', 'allies'], patch.allies);
  return current;
}

/** Drop every stored change: the shipped file's values come back into force immediately. */
export function resetOverrides(): GameConfig {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to do */
  }
  overlay = {};
  return recompute();
}

/**
 * The tuning values to install into the simulation, as the flat array `layout` describes.
 *
 * `layout` comes from the engine (`Sim.tuningLayout()`), so this side never keeps its own copy of
 * the field order; a key the layout does not know is reported and skipped, and a slot the config
 * does not mention stays `NaN`, which the engine reads as "keep the compiled-in default".
 */
export function tuningValues(layout: readonly string[], cfg: GameConfig = current): Float32Array {
  const values = new Float32Array(layout.length).fill(Number.NaN);
  const keys = Object.keys(cfg.tuning);
  if (!keys.length) return values;
  const index = new Map<string, number>();
  layout.forEach((name, i) => index.set(name, i));
  for (const key of keys) {
    const i = index.get(key);
    if (i === undefined) {
      console.warn(`rf: tuning key "${key}" is not in the simulation's layout; ignored`);
      continue;
    }
    values[i] = cfg.tuning[key];
  }
  return values;
}
