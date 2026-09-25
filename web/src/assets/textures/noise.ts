/**
 * Tileable procedural noise.
 *
 * Seamlessness is not a post-process here: every generator is defined on a *periodic
 * integer lattice* whose period equals the sample period, so the texture wraps exactly
 * by construction (octave k uses a lattice of `freq * 2^k` cells across the whole
 * texture, and lookups wrap with a bit mask). That costs nothing at runtime and avoids
 * the brightness dip that blended seams produce.
 *
 * Fields are computed once at a *reduced resolution* and sampled bilinearly by the
 * surface recipes: low-frequency structure does not need a sample per texel, and this
 * is what keeps the whole 25-material library inside a few hundred milliseconds.
 *
 * Everything is cached by parameter tuple, so two materials asking for "4-octave fbm at
 * 8 cells with seed 7" share one buffer.
 */
import { Rng, hash2, seedFrom } from './rng';

/* ------------------------------------------------------------------- lattices */

export interface Lattice {
  readonly size: number;
  /** size - 1 for power-of-two sizes (bit-mask wrap), -1 otherwise (modulo wrap). */
  readonly mask: number;
  readonly values: Float32Array;
}

const latticeCache = new Map<string, Lattice>();

/**
 * A square periodic random lattice of `size` x `size` values. Any size >= 2 works: the
 * period must equal the number of cells across the texture, and forcing powers of two
 * there would rule out useful spacings (5 ripple bands, 12 planks, 150 stitches).
 * Power-of-two sizes keep a bit-mask wrap, everything else falls back to modulo.
 */
export function lattice(size: number, seed: number | string): Lattice {
  const s = Math.max(2, size | 0);
  const sd = seedFrom(seed);
  const key = `${s}:${sd}`;
  const hit = latticeCache.get(key);
  if (hit) return hit;
  const values = new Float32Array(s * s);
  for (let i = 0; i < values.length; i++) {
    const row = (i / s) | 0;
    values[i] = hash2(i - row * s, row, sd) / 4294967296;
  }
  const pot = (s & (s - 1)) === 0;
  const l: Lattice = { size: s, mask: pot ? s - 1 : -1, values };
  latticeCache.set(key, l);
  return l;
}

/** Quintic smoothstep: C2-continuous interpolation, so derived normals stay smooth. */
function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Bilinear value-noise sample of a periodic lattice. `x`/`y` are in lattice cells;
 * negative and out-of-range coordinates wrap (JS `&` on a negative int is two's complement).
 */
export function sampleLattice(l: Lattice, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const m = l.mask;
  let x0: number;
  let y0: number;
  let x1: number;
  let y1: number;
  if (m >= 0) {
    x0 = xi & m;
    y0 = yi & m;
    x1 = (xi + 1) & m;
    y1 = (yi + 1) & m;
  } else {
    const s = l.size;
    x0 = ((xi % s) + s) % s;
    y0 = ((yi % s) + s) % s;
    x1 = ((xi + 1) % s + s) % s;
    y1 = ((yi + 1) % s + s) % s;
  }
  const u = quintic(x - xi);
  const v = quintic(y - yi);
  const s = l.size;
  const r0 = y0 * s;
  const r1 = y1 * s;
  const a = l.values[r0 + x0];
  const b = l.values[r0 + x1];
  const c = l.values[r1 + x0];
  const d = l.values[r1 + x1];
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/* --------------------------------------------------------------------- fields */

/** A square scalar field sampled on [0,1) x [0,1), wrapping at the edges. */
export interface Field {
  readonly res: number;
  readonly data: Float32Array;
}

export type NoiseKind = 'fbm' | 'ridged' | 'turbulence';

export interface NoiseSpec {
  seed: number | string;
  /** Lattice cells across the texture for octave 0 (power of two). */
  freq: number;
  /** Sampling resolution in texels (power of two). */
  res: number;
  /** Octave count. Default 4. */
  octaves?: number;
  /** Amplitude falloff per octave. Default 0.5. */
  gain?: number;
  /** Frequency multiplier per octave. Default 2. */
  lacunarity?: number;
  kind?: NoiseKind;
  /** Domain warp: position is displaced by a low-frequency field, in octave-0 cells. */
  warp?: number;
  /** Warp field frequency in cells (default `freq`). */
  warpFreq?: number;
  /** Output remap: value is raised to this power after normalisation (default 1). */
  contrast?: number;
  /** Distinguishes two identical specs used for different jobs in the cache. */
  tag?: string;
}

const fieldCache = new Map<string, Field>();

function fieldKey(s: Required<Pick<NoiseSpec, 'seed' | 'freq' | 'res'>> & NoiseSpec): string {
  return [
    seedFrom(s.seed),
    s.freq,
    s.res,
    s.octaves ?? 4,
    s.gain ?? 0.5,
    s.lacunarity ?? 2,
    s.kind ?? 'fbm',
    s.warp ?? 0,
    s.warpFreq ?? 0,
    s.contrast ?? 1,
    s.tag ?? '',
  ].join(':');
}

/** Number of octaves that still carry visible amplitude: below ~1/512 gain the term is invisible in 8-bit. */
function effectiveOctaves(octaves: number, gain: number): number {
  let n = 1;
  let a = gain;
  let total = 1;
  while (n < octaves) {
    total += a;
    if (a < 0.004) break;
    a *= gain;
    n++;
  }
  return n;
}

/**
 * Builds (or returns a cached) tileable noise field.
 *
 * Quality notes:
 *  - quintic interpolation keeps the fbm free of the diamond artefacts bilinear produces
 *    once a normal map amplifies it;
 *  - each octave gets its own random offset and every other octave is transposed, which
 *    breaks the axis-aligned "grid" look of value noise without losing periodicity;
 *  - `warp` displaces the domain by another field, sampled at two offsets so a single
 *    buffer provides both components.
 */
export function noiseField(spec: NoiseSpec): Field {
  const key = fieldKey(spec);
  const hit = fieldCache.get(key);
  if (hit) return hit;

  const res = Math.max(4, spec.res | 0);
  const gain = spec.gain ?? 0.5;
  const lac = spec.lacunarity ?? 2;
  const kind: NoiseKind = spec.kind ?? 'fbm';
  const octaves = effectiveOctaves(spec.octaves ?? 4, gain);
  const seed = seedFrom(spec.seed);
  const rng = new Rng(seed ^ 0x5bf03635);
  const baseFreq = Math.max(1, spec.freq | 0);

  // Per-octave lattices + squash offsets. Offsets are integers so the wrap stays exact.
  const layers: Lattice[] = [];
  const offX: number[] = [];
  const offY: number[] = [];
  const amps: number[] = [];
  let freq = baseFreq;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push(lattice(Math.max(2, freq), seed + o * 0x9e37));
    offX.push(rng.int(Math.max(2, freq)));
    offY.push(rng.int(Math.max(2, freq)));
    amps.push(amp);
    norm += amp;
    amp *= gain;
    freq = Math.max(2, Math.round(freq * lac));
  }

  // Optional warp buffer (its own field, no warp of its own to avoid recursion).
  let warp: Field | null = null;
  let warpAmp = 0;
  if (spec.warp) {
    warpAmp = spec.warp;
    warp = noiseField({
      seed: seed ^ 0x1b56c4e9,
      freq: Math.max(2, spec.warpFreq ?? baseFreq),
      res,
      octaves: 3,
      gain: 0.5,
      kind: 'fbm',
      tag: 'warp',
    });
  }

  const data = new Float32Array(res * res);
  const inv = 1 / res;
  const contrast = spec.contrast ?? 1;
  const invNorm = 1 / norm;

  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < res; x++) {
      const u = (x + 0.5) * inv;
      let su = u;
      let sv = v;
      if (warp) {
        // Two offsets of one buffer give a decorrelated 2D displacement for free.
        const wx = sampleField(warp, u, v);
        const wy = sampleField(warp, u + 0.5, v + 0.5);
        su += (wx * 2 - 1) * warpAmp * inv;
        sv += (wy * 2 - 1) * warpAmp * inv;
      }
      let sum = 0;
      for (let o = 0; o < octaves; o++) {
        const f = layers[o].size;
        // Alternating transpose: hides the lattice alignment of successive octaves.
        const n =
          (o & 1) === 0
            ? sampleLattice(layers[o], su * f + offX[o], sv * f + offY[o])
            : sampleLattice(layers[o], sv * f + offY[o], su * f + offX[o]);
        if (kind === 'ridged') {
          const r = 1 - Math.abs(n * 2 - 1);
          sum += r * r * amps[o];
        } else if (kind === 'turbulence') {
          sum += Math.abs(n * 2 - 1) * amps[o];
        } else {
          sum += n * amps[o];
        }
      }
      let out = sum * invNorm;
      if (kind === 'turbulence') out = out; // already 0..1
      if (contrast !== 1) out = Math.pow(out < 0 ? 0 : out > 1 ? 1 : out, contrast);
      data[y * res + x] = out;
    }
  }

  const field: Field = { res, data };
  fieldCache.set(key, field);
  return field;
}

/** Bilinear wrap sample of a field; `u`,`v` are normalised texture coordinates. */
export function sampleField(f: Field, u: number, v: number): number {
  const res = f.res;
  const mask = res - 1;
  // `+ res` keeps the coordinate positive so `| 0` can stand in for `Math.floor` (a big
  // win: this is the single hottest function in the library) while the bit-mask wrap
  // still makes the 0/1 seam exact. A truncating conversion on a negative coordinate
  // would silently break tiling, hence the offset rather than a bare `| 0`.
  const fx = u * res + res - 0.5;
  const fy = v * res + res - 0.5;
  const xi = fx | 0;
  const yi = fy | 0;
  const tx = fx - xi;
  const ty = fy - yi;
  const x0 = xi & mask;
  const y0 = yi & mask;
  const x1 = (xi + 1) & mask;
  const y1 = (yi + 1) & mask;
  const d = f.data;
  const r0 = y0 * res;
  const r1 = y1 * res;
  const a = d[r0 + x0];
  const b = d[r0 + x1];
  const c = d[r1 + x0];
  const e = d[r1 + x1];
  const top = a + (b - a) * tx;
  const bot = c + (e - c) * tx;
  return top + (bot - top) * ty;
}

/* ------------------------------------------------------------------- cellular */

export type CellMetric = 'euclid' | 'manhattan' | 'chebyshev';

export interface CellularSpec {
  seed: number | string;
  /** Cells across the texture. */
  cells: number;
  /** Sampling resolution in texels. */
  res: number;
  /** 0 = points on the lattice, 1 = fully jittered inside their cell. Default 0.9. */
  jitter?: number;
  metric?: CellMetric;
  /** 1 = every cell has a point, 0 = random dropout (cracks, chipped patches). Default 1. */
  density?: number;
  tag?: string;
}

/** Distance to the nearest (F1) and second nearest (F2) feature point, plus the winner id. */
export interface Cellular {
  readonly res: number;
  readonly cells: number;
  readonly f1: Float32Array;
  readonly f2: Float32Array;
  /** Stable pseudo-random id of the winning cell (for per-cell colour/level variation). */
  readonly id: Float32Array;
}

const cellCache = new Map<string, Cellular>();

/**
 * Jittered-grid Worley noise on a periodic domain. F2-F1 gives crisp cell borders
 * (cracks, chipped paint, stone edges, sandbag seams); F1 gives blobby cells.
 */
export function cellularField(spec: CellularSpec): Cellular {
  const res = Math.max(4, spec.res | 0);
  const cells = Math.max(2, spec.cells | 0);
  const jitter = spec.jitter ?? 0.9;
  const metric: CellMetric = spec.metric ?? 'euclid';
  const density = spec.density ?? 1;
  const seed = seedFrom(spec.seed);
  const key = [seed, cells, res, jitter, metric, density, spec.tag ?? ''].join(':');
  const hit = cellCache.get(key);
  if (hit) return hit;

  const f1 = new Float32Array(res * res);
  const f2 = new Float32Array(res * res);
  const id = new Float32Array(res * res);
  const inv = 1 / res;

  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) * inv;
    const cy = Math.floor(v * cells);
    for (let x = 0; x < res; x++) {
      const u = (x + 0.5) * inv;
      const cx = Math.floor(u * cells);
      let best = 1e9;
      let second = 1e9;
      let bestId = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const gy = cy + oy;
        const wy = ((gy % cells) + cells) % cells;
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const wx = ((gx % cells) + cells) % cells;
          const h = hash2(wx, wy, seed);
          if (density < 1 && (h & 1023) / 1023 > density) continue;
          const px = gx + 0.5 + ((hash2(wx, wy, seed ^ 0x51ed) / 4294967296) - 0.5) * jitter;
          const py = gy + 0.5 + ((hash2(wx, wy, seed ^ 0x2f7c) / 4294967296) - 0.5) * jitter;
          const dx = (u * cells - px) / cells;
          const dy = (v * cells - py) / cells;
          let d: number;
          if (metric === 'manhattan') d = Math.abs(dx) + Math.abs(dy);
          else if (metric === 'chebyshev') d = Math.max(Math.abs(dx), Math.abs(dy));
          else d = Math.sqrt(dx * dx + dy * dy);
          if (d < best) {
            second = best;
            best = d;
            bestId = h;
          } else if (d < second) {
            second = d;
          }
        }
      }
      const i = y * res + x;
      // Normalised to cell units so recipes can reason in "fraction of a cell".
      f1[i] = best * cells;
      f2[i] = second * cells;
      id[i] = (bestId >>> 8) / 16777216;
    }
  }

  const c: Cellular = { res, cells, f1, f2, id };
  cellCache.set(key, c);
  return c;
}

/** Bilinear wrap sample of one cellular plane. */
export function sampleCell(c: Cellular, plane: Float32Array, u: number, v: number): number {
  return sampleField({ res: c.res, data: plane }, u, v);
}

/** 1 on cell borders (F2-F1 -> 0), 0 inside cells. `width` is in cell units. */
export function cellEdge(c: Cellular, u: number, v: number, width: number): number {
  const d = sampleCell(c, c.f2, u, v) - sampleCell(c, c.f1, u, v);
  const t = d / width;
  return t >= 1 ? 0 : 1 - t * t * (3 - 2 * t);
}

/* --------------------------------------------------------------------- domain */

/**
 * Bilinear sample of an arbitrary field with an independent rotation, used by recipes
 * that need "the same noise, but stretched along a per-clump direction".
 */
export function sampleFieldRot(f: Field, u: number, v: number, cos: number, sin: number, stretch: number): number {
  const du = u - 0.5;
  const dv = v - 0.5;
  const ru = (du * cos - dv * sin) * stretch + 0.5;
  const rv = (du * sin + dv * cos) + 0.5;
  return sampleField(f, wrap01(ru), wrap01(rv));
}

/** Positive modulo 1. */
export function wrap01(x: number): number {
  const f = x - Math.floor(x);
  return f < 0 ? f + 1 : f;
}

/**
 * Samples a field with `reps` integer repeats along V, which stretches its features
 * along U. Integer repeats keep the wrap exact, so brushed metal, wood grain, water
 * streaks and tyre ruts all stay seamless. `reps` must be a positive integer.
 */
export function stretchV(f: Field, u: number, v: number, reps: number): number {
  return sampleField(f, u, wrap01(v * reps));
}

/** As `stretchV`, stretched along V instead (vertical streaks, drips, rain run-off). */
export function stretchU(f: Field, u: number, v: number, reps: number): number {
  return sampleField(f, wrap01(u * reps), v);
}

/**
 * Polar sample around (cx,cy): U becomes the angle (so it wraps by construction) and V
 * the radius, which turns isotropic noise into radial filaments (smoke, soot bursts).
 */
export function polar(f: Field, u: number, v: number, cx: number, cy: number, radial: number): number {
  const dx = u - cx;
  const dy = v - cy;
  return sampleField(f, Math.atan2(dy, dx) * 0.15915494 + 0.5, Math.sqrt(dx * dx + dy * dy) * radial);
}


/** Value noise evaluated directly (no buffer) at normalised `u`,`v`; `period` cells across. */
export function noise2(u: number, v: number, period: number, seed: number | string): number {
  return sampleLattice(lattice(period, seed), u * period, v * period);
}

/** Sum of `octaves` direct value-noise octaves at normalised `u`,`v`. */
export function fbm2(u: number, v: number, freq: number, octaves: number, seed: number | string): number {
  let f = freq;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  const sd = seedFrom(seed);
  for (let o = 0; o < octaves; o++) {
    sum += sampleLattice(lattice(Math.max(2, Math.round(f)), sd + o * 0x9e37), u * f, v * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Drops every cached lattice/field. Called by `SurfaceLibrary.dispose()`. */
export function clearNoiseCache(): void {
  latticeCache.clear();
  fieldCache.clear();
  cellCache.clear();
}

/** Diagnostics: how much noise data is currently retained. */
export function noiseCacheStats(): { lattices: number; fields: number; cellular: number } {
  return { lattices: latticeCache.size, fields: fieldCache.size, cellular: cellCache.size };
}
