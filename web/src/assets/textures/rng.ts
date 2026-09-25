/**
 * Seeded randomness for the procedural texture library.
 *
 * Two flavours live here on purpose:
 *  - `hash*` functions are allocation-free integer mixes usable *inside* per-pixel loops
 *    (white noise, per-cell jitter, per-plank variation). They must stay branch-free and
 *    cheap: a speckle pass calls them once per texel.
 *  - `Rng` is a stateful stream used while *building* a recipe (picking clump centres,
 *    plank tones, chip positions). Same seed => same texture, which keeps the game's
 *    look reproducible across reloads and machines.
 */

/** Murmur3-style 32-bit finalizer. ~5 ops, excellent avalanche for our purposes. */
export function hash32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of two integer coordinates (texel or lattice cell) plus a seed. */
export function hash2(x: number, y: number, seed: number): number {
  return hash32(Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1));
}

/** `hash2` mapped to [0,1). */
export function hash2f(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}

/** Three-input hash, used for per-cell ids that must stay stable across passes. */
export function hash3(x: number, y: number, z: number, seed: number): number {
  return hash32(hash2(x, y, seed) ^ Math.imul(z | 0, 0x85ebca6b));
}

/** Maps a string seed ("sand", "camoGreen") onto a 32-bit integer. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return hash32(h);
}

/** Accepts a human-readable or numeric seed and always yields a non-zero integer. */
export function seedFrom(seed: number | string): number {
  const n = typeof seed === 'string' ? hashString(seed) : hash32(seed);
  return n === 0 ? 0x9e3779b9 : n;
}

/** Tiny stateful PRNG (mulberry32): fast, decent quality, 32-bit state. */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = seedFrom(seed);
  }

  /** Uniform in [0,1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [a,b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Uniform integer in [0,n). */
  int(n: number): number {
    return Math.floor(this.next() * n) % n;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Symmetric jitter in [-a,a]. */
  jitter(a: number): number {
    return (this.next() * 2 - 1) * a;
  }

  /** Random element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length] as T;
  }
}

/**
 * Per-texel white noise in [0,1). Used for grain, aggregate speckle and paint
 * chipping: content that is meant to sit at (or below) the pixel scale.
 */
export function white(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}
