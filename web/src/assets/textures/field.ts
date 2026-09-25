/**
 * The bake pipeline: one recipe per material, three passes, four output maps.
 *
 * Why it is shaped like this:
 *
 *  1. `coarse` runs at size/4 on a small number of channels. Broad tonal structure,
 *     stains, strata and colour zoning are low frequency; evaluating multi-octave noise
 *     per texel for them would cost 16x more for identical pixels.
 *  2. `detail` runs per texel and owns everything that has to stay crisp: grain, weave,
 *     rivets, speckle, chipping. It returns micro-relief `dh` in *metres*.
 *  3. Normals come from a real height field in metres via a 3x3 Sobel, scaled by the
 *     material's world scale (metres per texel). That is what makes bump strength
 *     physically consistent between a 12 m sand tile and a 2 m metal panel: a 2 cm
 *     rivet is a 2 cm rivet in the normal map, whatever the texture resolution.
 *  4. AO is curvature based: the same neighbour taps that feed the Sobel give the
 *     Laplacian, so pits darken for free. `cavityRadius` is the radius of curvature (in
 *     metres) that occludes by 50%, which reads the same at every texture size.
 */
import type { MatKey } from '../types';
import { CH, type ChannelPlanes } from './channels';
import { hexToLinear, srgb8, type LinearRGB } from './canvas';
import { seedFrom } from './rng';

export { CH };
export type { ChannelPlanes };

/** Mutable per-cell state handed to a recipe's `coarse` pass. */
export interface Cell {
  /** Height above the nominal surface, in metres. */
  h: number;
  /** Linear-light albedo. */
  r: number;
  g: number;
  b: number;
  /** 0..1, 1 = fully rough. */
  rough: number;
  /** 0..1 metalness. */
  metal: number;
  /** Baked (large scale) ambient occlusion, 1 = open sky. */
  ao: number;
  /** Scratch channel: whatever the recipe wants to hand to its detail pass. */
  aux: number;
}

/** Mutable per-texel state handed to a recipe's `detail` pass. */
export interface Detail {
  /** Extra micro-relief in metres, added to the coarse height. */
  dh: number;
  /** Multiplicative albedo tint (1 = unchanged). */
  tr: number;
  tg: number;
  tb: number;
  /** Additive linear albedo (highlights: shell, gravel, bare metal). */
  ar: number;
  ag: number;
  ab: number;
  /** Additive roughness / metalness deltas. */
  rough: number;
  metal: number;
  /** Multiplicative AO (crevice darkening the Laplacian cannot see). */
  ao: number;
  /** Output alpha (fx decals only). */
  a: number;
}

export interface SurfaceBase {
  /** Authored sRGB hex; converted to linear once at bake time. */
  color: number;
  /** Optional second tone recipes mix towards. */
  color2?: number;
  rough: number;
  metal: number;
}

export interface BakeContext {
  /** Full texture resolution. */
  readonly size: number;
  /** Coarse pass resolution (size / coarseDiv). */
  readonly res: number;
  /** size / 2: for crisp mid-frequency fields (crack networks, chipping). */
  readonly half: number;
  /** Metres covered by one texture repeat (the material's `worldScale`). */
  readonly worldScale: number;
  /** Metres per texel at full resolution. */
  readonly px: number;
  readonly seed: number;
  readonly full: boolean;
  /** Coarse channel planes, readable from `detail` (e.g. `CH.AUX`). */
  readonly ch: ChannelPlanes;
}

/**
 * The two per-pixel entry points a recipe exposes. They are produced by `build()` so
 * that noise fields, lattice handles and derived constants are created once per bake
 * and captured in the closure — looking them up per texel (even from a cache) would
 * cost more than the noise itself.
 */
export interface Recipe {
  /** Broad structure pass at coarse resolution; `u`,`v` are normalised and tile. */
  coarse(u: number, v: number, o: Cell): void;
  /** Per-texel detail pass; omit for surfaces with no pixel-scale structure. */
  detail?(u: number, v: number, d: Detail): void;
}

export interface SurfaceSpec {
  key: MatKey;
  /** Metres per texture repeat. */
  worldScale: number;
  base: SurfaceBase;
  /** Builds the per-bake closures. Called once per bake, before any pass runs. */
  build(b: BakeContext): Recipe;
  /** Coarse pass divisor: 4 (default), 2 for recipes with sharp mid-frequency masks. */
  coarseDiv?: 4 | 2;
  /** Set false when `detail` only tints (skips the extra relief evaluation). */
  relief?: boolean;
  /** Radius of curvature in metres that occludes 50%; 0 disables curvature AO. */
  cavityRadius?: number;
  /** Normal slope multiplier (1 = physically derived from metres). */
  bump?: number;
  /** Clamp wrapping for decals whose soft edges must not bleed. */
  clamp?: boolean;
  /** Emit an `aoMap` for this surface (default true). */
  ao?: boolean;
}

export interface BakeResult {
  size: number;
  /** sRGB albedo, alpha channel used by fx decals. */
  albedo: ImageData;
  /** Tangent-space normal, OpenGL convention (green = +V). */
  normal?: ImageData;
  /** Packed ORM: R = AO, G = roughness, B = metalness. */
  orm?: ImageData;
}

/*
 * Height scratch. One buffer, grown on demand and reused across bakes: allocating a
 * fresh megabyte per material would hand the GC 25 MB of garbage during startup.
 * Baking is synchronous, so a single shared buffer is safe.
 */
let heightScratch = new Float32Array(0);
function heightBuffer(size: number): Float32Array {
  const need = size * size;
  if (heightScratch.length < need) heightScratch = new Float32Array(need);
  return heightScratch;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Bilinear wrap sample of one coarse plane; also usable from recipes in `detail`. */
export function samplePlane(plane: Float32Array, res: number, u: number, v: number): number {
  const mask = res - 1;
  // See `sampleField`: positive offset + `| 0` instead of `Math.floor`.
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
  const r0 = y0 * res;
  const r1 = y1 * res;
  const a = plane[r0 + x0];
  const b = plane[r0 + x1];
  const c = plane[r1 + x0];
  const d = plane[r1 + x1];
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

function resetCell(o: Cell, base: LinearRGB, rough: number, metal: number): void {
  o.h = 0;
  o.r = base.r;
  o.g = base.g;
  o.b = base.b;
  o.rough = rough;
  o.metal = metal;
  o.ao = 1;
  o.aux = 0;
}

function resetDetail(d: Detail): void {
  d.dh = 0;
  d.tr = 1;
  d.tg = 1;
  d.tb = 1;
  d.ar = 0;
  d.ag = 0;
  d.ab = 0;
  d.rough = 0;
  d.metal = 0;
  d.ao = 1;
  d.a = 1;
}

/** Runs a recipe and returns its pixel buffers. */
export function bakeSurface(spec: SurfaceSpec, opts: { size: number; full: boolean }): BakeResult {
  const size = Math.max(16, opts.size | 0);
  const full = opts.full;
  const res = Math.max(16, Math.round(size / (spec.coarseDiv ?? 4)));
  const px = spec.worldScale / size;
  const base = hexToLinear(spec.base.color);

  const ch: ChannelPlanes = [
    new Float32Array(res * res), // height (metres)
    new Float32Array(res * res), // albedo r
    new Float32Array(res * res), // albedo g
    new Float32Array(res * res), // albedo b
    new Float32Array(res * res), // roughness
    new Float32Array(res * res), // metalness
    new Float32Array(res * res), // baked AO
    new Float32Array(res * res), // aux
  ];
  const [hCh, rCh, gCh, bCh, roughCh, metalCh, aoCh, auxCh] = ch;

  const b: BakeContext = {
    size,
    res,
    half: Math.max(16, size >> 1),
    worldScale: spec.worldScale,
    px,
    seed: seedFrom(spec.key),
    full,
    ch,
  };

  /* ---------------------------------------------------------------- pass 1: coarse */
  const recipe = spec.build(b);
  const o: Cell = { h: 0, r: 0, g: 0, b: 0, rough: 0, metal: 0, ao: 1, aux: 0 };
  const inv = 1 / res;
  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) * inv;
    const row = y * res;
    for (let x = 0; x < res; x++) {
      const u = (x + 0.5) * inv;
      resetCell(o, base, spec.base.rough, spec.base.metal);
      recipe.coarse(u, v, o);
      const i = row + x;
      hCh[i] = o.h;
      rCh[i] = clamp01(o.r);
      gCh[i] = clamp01(o.g);
      bCh[i] = clamp01(o.b);
      roughCh[i] = clamp01(o.rough);
      metalCh[i] = clamp01(o.metal);
      aoCh[i] = clamp01(o.ao);
      auxCh[i] = o.aux;
    }
  }

  const albedo = new ImageData(size, size);
  const alb = albedo.data;
  const normal = full ? new ImageData(size, size) : undefined;
  const orm = full ? new ImageData(size, size) : undefined;
  const nrm = normal?.data;
  const ormD = orm?.data;
  // The height field only exists to derive normals and curvature, so it is skipped
  // entirely in non-`full` mode.
  const height = full ? heightBuffer(size) : null;
  const detail = recipe.detail;
  const wantsRelief = full && detail !== undefined && spec.relief !== false;

  const d: Detail = { dh: 0, tr: 1, tg: 1, tb: 1, ar: 0, ag: 0, ab: 0, rough: 0, metal: 0, ao: 1, a: 1 };
  const mask = res - 1;
  const step = res / size;
  const bump = spec.bump ?? 1;
  const invPx = 1 / px;

  /*
   * Pass 2 composes colour, roughness, metalness, pre-curvature AO and the height field.
   * The detail callback is evaluated exactly ONCE per texel here - running a separate
   * height pass would double the most expensive part of the whole pipeline.
   */
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const fy = (y + 0.5) * step - 0.5;
    const yi = Math.floor(fy);
    const ty = fy - yi;
    const y0 = (yi & mask) * res;
    const y1 = ((yi + 1) & mask) * res;
    const row = y * size;
    const byteRow = row << 2;

    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const fx = (x + 0.5) * step - 0.5;
      const xi = Math.floor(fx);
      const tx = fx - xi;
      const x0 = xi & mask;
      const x1 = (xi + 1) & mask;
      // Shared bilinear weights: seven channels read the same four texels.
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const i00 = y0 + x0;
      const i10 = y0 + x1;
      const i01 = y1 + x0;
      const i11 = y1 + x1;

      let r = w00 * rCh[i00] + w10 * rCh[i10] + w01 * rCh[i01] + w11 * rCh[i11];
      let g = w00 * gCh[i00] + w10 * gCh[i10] + w01 * gCh[i01] + w11 * gCh[i11];
      let bl = w00 * bCh[i00] + w10 * bCh[i10] + w01 * bCh[i01] + w11 * bCh[i11];
      let rough = w00 * roughCh[i00] + w10 * roughCh[i10] + w01 * roughCh[i01] + w11 * roughCh[i11];
      let metal = w00 * metalCh[i00] + w10 * metalCh[i10] + w01 * metalCh[i01] + w11 * metalCh[i11];
      let ao = w00 * aoCh[i00] + w10 * aoCh[i10] + w01 * aoCh[i01] + w11 * aoCh[i11];

      if (detail) {
        resetDetail(d);
        detail(u, v, d);
        r = r * d.tr + d.ar;
        g = g * d.tg + d.ag;
        bl = bl * d.tb + d.ab;
        rough += d.rough;
        metal += d.metal;
        ao *= d.ao;
      }

      const ro = byteRow + (x << 2);
      alb[ro] = srgb8(r);
      alb[ro + 1] = srgb8(g);
      alb[ro + 2] = srgb8(bl);
      alb[ro + 3] = detail ? clamp01(d.a) * 255 : 255;

      if (height) {
        const hc = w00 * hCh[i00] + w10 * hCh[i10] + w01 * hCh[i01] + w11 * hCh[i11];
        height[row + x] = wantsRelief ? hc + d.dh : hc;
      }
      if (ormD) {
        ormD[ro] = clamp01(ao) * 255;
        ormD[ro + 1] = clamp01(rough) * 255;
        ormD[ro + 2] = clamp01(metal) * 255;
        ormD[ro + 3] = 255;
      }
    }
  }

  /*
   * Pass 3: tangent-space normals from the metric height field, and curvature AO folded
   * into the red channel. No callbacks and no noise here, so it is cheap.
   */
  if (height && nrm && ormD) {
    const cavityRadius = spec.cavityRadius ?? 0;
    const sizeMask = size - 1;
    for (let y = 0; y < size; y++) {
      const hUp = ((y - 1) & sizeMask) * size;
      const hRow = y * size;
      const hDn = ((y + 1) & sizeMask) * size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1) & sizeMask;
        const xp = (x + 1) & sizeMask;
        const h00 = height[hUp + xm];
        const h10 = height[hUp + x];
        const h20 = height[hUp + xp];
        const h01 = height[hRow + xm];
        const h11 = height[hRow + x];
        const h21 = height[hRow + xp];
        const h02 = height[hDn + xm];
        const h12 = height[hDn + x];
        const h22 = height[hDn + xp];

        // Sobel (the kernel sums to 8), converted to a world-space slope via metres/texel.
        const gx = h20 + 2 * h21 + h22 - (h00 + 2 * h01 + h02);
        const gy = h02 + 2 * h12 + h22 - (h00 + 2 * h10 + h20);
        // Tangent space, OpenGL convention: +V points "up" in the map, so a surface that
        // rises with V tilts its normal towards -V.
        const nx = -gx * (invPx / 8) * bump;
        const ny = -gy * (invPx / 8) * bump;
        const invLen = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        const ro = (hRow + x) << 2;
        nrm[ro] = (nx * invLen * 0.5 + 0.5) * 255;
        nrm[ro + 1] = (ny * invLen * 0.5 + 0.5) * 255;
        nrm[ro + 2] = (invLen * 0.5 + 0.5) * 255;
        nrm[ro + 3] = 255;

        if (cavityRadius > 0) {
          // Laplacian from the same taps: positive in pits, so AO darkens crevices.
          const lap = (h10 + h12 + h01 + h21 - 4 * h11) * invPx * invPx;
          if (lap > 0) {
            const ao = (ormD[ro] / 255) / (1 + lap * cavityRadius);
            ormD[ro] = (ao < 0.15 ? 0.15 : ao) * 255;
          }
        }
      }
    }
  }

  return { size, albedo, normal, orm };
}
