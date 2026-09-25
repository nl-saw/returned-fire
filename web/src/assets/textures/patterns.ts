/**
 * Pattern vocabulary shared by the material recipes.
 *
 * Everything here is cheap enough to sit in a per-texel loop: scalar maths, seam/edge
 * masks, marking masks and a 5x7 stencil font. No helper allocates — layout queries
 * return scalars (index + in-cell position) instead of objects, because these run a
 * quarter of a million times per material.
 */
import type { Cell } from './field';

/* ---------------------------------------------------------------- scalar maths */

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Fractional part, always positive. */
export function fract(x: number): number {
  const f = x - Math.floor(x);
  return f < 0 ? f + 1 : f;
}

/** 1 inside |x| < w with a soft edge; used for veins, lane paint, stripes. */
export function band(x: number, w: number): number {
  const d = Math.abs(x);
  return d >= w ? 0 : 1 - (d / w) * (d / w);
}

/** Integer texel coordinate for hash-based grain (must not be interpolated). */
export function texel(x: number, size: number): number {
  return Math.floor(x * size);
}

/* --------------------------------------------------------------- layout / cells */

/** Cell index for a layout repeated `n` times across the texture. */
export function cellOf(x: number, n: number): number {
  return Math.floor(x * n);
}

/** Position inside that cell, 0..1. */
export function cellPos(x: number, n: number): number {
  const f = x * n;
  return f - Math.floor(f);
}

/**
 * Distance to the nearest cell border, expressed as "1 at the border, 0 from `width`
 * inwards" — the seam/panel-line/groove mask used all over the library.
 */
export function seam(f: number, width: number): number {
  const d = f < 0.5 ? f : 1 - f;
  const t = d / width;
  return t >= 1 ? 0 : 1 - t * t * (3 - 2 * t);
}

/** Box mask in normalised local coordinates (half extents), soft edge in the same units. */
export function boxMask(px: number, py: number, hw: number, hh: number, soft: number): number {
  const dx = Math.abs(px) - hw;
  const dy = Math.abs(py) - hh;
  const d = Math.max(dx, dy);
  return smoothstep(soft, -soft, d);
}

/** Rounded box (signed distance), used for painted markings and stencils. */
export function roundBoxMask(px: number, py: number, hw: number, hh: number, r: number, soft: number): number {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const d = Math.min(Math.max(qx, qy), 0) + len2(Math.max(qx, 0), Math.max(qy, 0)) - r;
  return smoothstep(soft, -soft, d);
}

/** sqrt, not `Math.hypot`: these run per texel and hypot's overflow guard is not free. */
export function len2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** x^0.75 without `Math.pow`: two sqrts, which is ~5x cheaper in a pixel loop. */
export function pow075(x: number): number {
  return Math.sqrt(x * Math.sqrt(x));
}

export function discMask(px: number, py: number, r: number, soft: number): number {
  const d = len2(px, py) - r;
  return smoothstep(soft, -soft, d);
}

export function ringMask(px: number, py: number, r: number, thick: number, soft: number): number {
  const d = Math.abs(len2(px, py) - r) - thick * 0.5;
  return smoothstep(soft, -soft, d);
}

/** Plain weave over/under selector for thread (i,j). */
export function weaveOver(i: number, j: number): number {
  return ((i + j) & 1) === 0 ? 1 : 0;
}

/** Thread profile: 0 at the thread centre, 1 in the gap. Round-ish cross section. */
export function threadProfile(pos: number): number {
  const d = Math.abs(pos * 2 - 1);
  return 1 - Math.sqrt(Math.max(0, 1 - d * d));
}

/* ------------------------------------------------------------- markings / text */

/** 5x7 stencil font, one 5-bit row per entry (bit 4 = leftmost column). */
const FONT: Record<string, readonly number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

export const TEXT_CHAR_COLS = 6; // 5 columns + 1 column of letter spacing
export const TEXT_ROWS = 7;

/*
 * Glyphs indexed by character code (lower case folds onto upper case). A per-texel
 * `toUpperCase()`/`charAt()` would allocate a string 250k times per material, so the
 * lookup table is built once and `textMask` stays allocation-free.
 */
const FONT_BY_CODE: (readonly number[] | undefined)[] = (() => {
  const table: (readonly number[] | undefined)[] = new Array(128);
  for (const k of Object.keys(FONT)) {
    const code = k.charCodeAt(0);
    table[code] = FONT[k];
    if (code >= 65 && code <= 90) table[code + 32] = FONT[k];
  }
  return table;
})();

/**
 * Ink coverage of `text` laid out inside the box [x0,x1] x [y0,y1].
 * Glyphs are 5x7 with one column of tracking, drawn as hard-edged stencil paint.
 */
export function textMask(
  text: string,
  u: number,
  v: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  soft = 0,
): number {
  const cols = text.length * TEXT_CHAR_COLS - 1;
  if (cols <= 0) return 0;
  const tx = ((u - x0) / (x1 - x0)) * cols;
  const ty = ((v - y0) / (y1 - y0)) * TEXT_ROWS;
  if (ty < 0 || ty >= TEXT_ROWS) return 0;
  const ci = Math.floor(tx);
  if (ci < 0 || ci >= cols) return 0;
  if (soft <= 0) {
    const gi = (ci / TEXT_CHAR_COLS) | 0;
    const gc = ci - gi * TEXT_CHAR_COLS;
    if (gc > 4) return 0;
    const rows = FONT_BY_CODE[text.charCodeAt(gi) & 127];
    if (!rows) return 0;
    return ((rows[Math.floor(ty)] as number) >> (4 - gc)) & 1 ? 1 : 0;
  }
  // Antialiased variant: 4 taps around the sample point (rarely needed, kept cheap).
  let acc = 0;
  for (let s = 0; s < 4; s++) {
    const ou = s < 2 ? -soft * 0.5 : soft * 0.5;
    const ov = (s & 1) === 0 ? -soft * 0.5 : soft * 0.5;
    acc += textMask(text, u + ou, v + ov, x0, x1, y0, y1, 0);
  }
  return acc * 0.25;
}

/** Small armoured-vehicle silhouette (kill marks / unit badges). */
export function tankMarkMask(px: number, py: number, soft: number): number {
  // Local coordinates: hull box, turret box, barrel line, track strips.
  const hull = boxMask(px, py + 0.05, 0.42, 0.16, soft);
  const trackL = boxMask(px, py + 0.13, 0.40, 0.07, soft);
  const turret = boxMask(px, py - 0.05, 0.18, 0.10, soft);
  const barrel = boxMask(px - 0.30, py - 0.05, 0.22, 0.025, soft);
  return Math.max(hull, trackL, turret, barrel);
}

/* -------------------------------------------------------------- cell utilities */

/** Shortest signed offset from `x` to a multiple of `period` (stripes, ruts, weave). */
export function periodOffset(x: number, period: number): number {
  const f = fract(x / period);
  return (f < 0.5 ? f : f - 1) * period;
}

/* ------------------------------------------------------------------- cell tint */

/** Multiplies a cell's albedo (shading, dust, tone variation). */
export function tint(o: Cell, f: number): void {
  o.r *= f;
  o.g *= f;
  o.b *= f;
}

/** Multiplies each channel independently. */
export function tint3(o: Cell, fr: number, fg: number, fb: number): void {
  o.r *= fr;
  o.g *= fg;
  o.b *= fb;
}

/** Pushes a cell's albedo towards a linear colour by `t`. */
export function mixTo(o: Cell, c: { r: number; g: number; b: number }, t: number): void {
  o.r += (c.r - o.r) * t;
  o.g += (c.g - o.g) * t;
  o.b += (c.b - o.b) * t;
}
