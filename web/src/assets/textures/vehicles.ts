/**
 * Vehicle surfaces: the two team camouflage patterns plus hull metal and detail metal.
 *
 * Camouflage is built by quantising a *domain-warped* field into tone bands. The warp is
 * what makes the blobs flow around the hull the way sprayed disruptive patterns do; the
 * raw field is carried through the coarse channel and re-quantised per texel, so the
 * tone boundaries stay crisp instead of being blurred by the 4x upsampling.
 */
import { hexToLinear } from './canvas';
import { noiseField, sampleField, stretchU } from './noise';
import * as P from './patterns';
import { hash2f, white } from './rng';
import { CH, samplePlane, type BakeContext, type Recipe, type SurfaceSpec } from './field';

function auxAt(b: BakeContext, u: number, v: number): number {
  return samplePlane(b.ch[CH.AUX], b.res, u, v);
}

/**
 * Mud/sand spatter from hashed cells rather than a noise field: 6 ops instead of a
 * bilinear sample (~10 ns saved per texel), and droplets want hard centres anyway.
 */
function spatterCell(u: number, v: number): number {
  const i = Math.floor(u * 13);
  const j = Math.floor(v * 13);
  const h = hash2f(i, j, 0x51a7);
  const h2 = hash2f(i + 7, j + 3, 0x2b4d);
  return h * 0.7 + h2 * 0.3;
}

interface CamoPalette {
  /** Dominant tone. */
  base: number;
  /** Disruptive patches, darkest last. */
  tones: readonly [number, number, number];
  /** Airborne dust film and where it settles. */
  dust: number;
  dustAmount: number;
  /** Mud / sand spatter strength. */
  spatter: number;
  spatterColor: number;
  /** Paint failure down to primer and bare steel. */
  chipAmount: number;
  rough: number;
}

/**
 * Shared camouflage recipe. `coarse` stores a neutral 0.5 grey as the albedo carrier so
 * the per-texel pass can paint the exact band colour (multiply by 2 * colour) after
 * re-quantising the warped field with high-frequency edge jitter.
 */
function camoRecipe(b: BakeContext, pal: CamoPalette): Recipe {
  const seed = b.seed;
  const shape = noiseField({ seed, freq: 3, res: b.res, octaves: 4, warp: 3.5, tag: 'camo' });
  const detail = noiseField({ seed: seed ^ 0x1c, freq: 7, res: b.res, octaves: 3 });
  const dust = noiseField({ seed: seed ^ 0x2e, freq: 4, res: b.res, octaves: 4 });

  const chips = noiseField({ seed: seed ^ 0x5c, freq: 34, res: b.half, octaves: 3, kind: 'turbulence' });
  const soot = noiseField({ seed: seed ^ 0x6e, freq: 8, res: b.res, octaves: 3 });
  const c0 = hexToLinear(pal.base);
  const c1 = hexToLinear(pal.tones[0]);
  const c2 = hexToLinear(pal.tones[1]);
  const c3 = hexToLinear(pal.tones[2]);
  const dustCol = hexToLinear(pal.dust);
  const spatterCol = hexToLinear(pal.spatterColor);
  const primer = hexToLinear(0x7d6a3a);
  const steel = hexToLinear(0xc0c4c6);
  // 3 m / 6 = 50 cm hull plates under the paint.
  const PANELS = 6;
  const RIVETS = 30; // 10 cm rivet pitch
  // Band edges: base tone dominant, then two mid tones and a sparse darkest tone.
  const toneOf = (n: number): number => (n < 0.42 ? 0 : n < 0.62 ? 1 : n < 0.82 ? 2 : 3);
  /** Expands the fbm's narrow distribution so the bands get usable area shares. */
  const spread = (n: number): number => P.clamp01((n - 0.5) * 1.7 + 0.5);
  return {
    coarse(u, v, o) {
      const n = sampleField(shape, u, v) + 0.18 * (sampleField(detail, u, v) - 0.5);
      // Neutral carrier: the detail pass repaints the exact band colour at full res,
      // so the coarse planes only carry relief, roughness and the shape value itself.
      o.r = 0.5;
      o.g = 0.5;
      o.b = 0.5;
      o.rough = pal.rough;
      o.metal = 0.12;
      o.h = 0.002 * (n - 0.5);
      // Plate seams and rivet lines telegraph faintly through the paint.
      const fu = P.cellPos(u, PANELS);
      const seamMask = Math.max(P.seam(fu, 0.05), P.seam(P.cellPos(v, PANELS), 0.05));
      o.h -= 0.0025 * seamMask;
      o.ao = 1 - 0.18 * seamMask;
      // Heavy equipment gets dusty from the bottom up.
      const dm = P.smoothstep(0.45, 0.9, sampleField(dust, u, v)) * (0.45 + 0.55 * v) * pal.dustAmount;
      o.rough = P.mix(o.rough, 0.95, dm);
      o.aux = n;
    },
    detail(u, v, d) {
      const x = P.texel(u, b.size);
      const y = P.texel(v, b.size);
      // Re-quantise at full resolution: bilinear reconstruction preserves the contour,
      // and the jitter restores the ragged edge that sprayed paint leaves behind.
      const g = white(x, y, seed) - 0.5;
      // Edge jitter from hash noise only: sampling another field here would cost more
      // than every other line of this recipe together.
      const jitter = 0.05 * (white(x, y, seed ^ 0x91) - 0.5);
      const n = spread(auxAt(b, u, v) + jitter);
      const t = toneOf(n);
      const c = t === 0 ? c0 : t === 1 ? c1 : t === 2 ? c2 : c3;
      // Coarse albedo is 0.5, so doubling the tone is an exact repaint.
      d.tr = c.r * 2;
      d.tg = c.g * 2;
      d.tb = c.b * 2;
      d.rough += 0.06 * (g + 0.5);
      d.dh += 0.0006 * g;
      // Dust film: brightens and desaturates, and settles more towards the bottom.
      // Branchless: the mix is cheap, a mispredicted branch here is not.
      const dustMask = P.smoothstep(0.48, 0.9, sampleField(dust, u, v)) * (0.45 + 0.55 * v) * pal.dustAmount;
      d.tr = d.tr * (1 - 0.5 * dustMask) + dustCol.r * dustMask;
      d.tg = d.tg * (1 - 0.5 * dustMask) + dustCol.g * dustMask;
      d.tb = d.tb * (1 - 0.5 * dustMask) + dustCol.b * dustMask;
      d.rough += 0.25 * dustMask;
      d.metal -= 0.1 * dustMask;
      d.dh += 0.0004 * dustMask;
      // Spatter: thrown mud or blown sand. Two hashes on a coarse grid give the blobs
      // (and the droplet-like speckle inside them) without another field sample.
      const speck = white(x, y, seed ^ 0x3d);
      const blob = P.smoothstep(0.62, 0.82, spatterCell(u, v)) * pal.spatter;
      const m = blob * (0.45 + 0.55 * speck);
      d.tr = d.tr * (1 - 0.6 * m) + spatterCol.r * 0.6 * m;
      d.tg = d.tg * (1 - 0.6 * m) + spatterCol.g * 0.6 * m;
      d.tb = d.tb * (1 - 0.6 * m) + spatterCol.b * 0.6 * m;
      d.rough += 0.1 * m;
      d.dh += 0.0008 * m;
      // Paint failure: primer first, then bare steel in the deepest chips.
      const cf = sampleField(chips, u, v);
      const chip = P.smoothstep(0.66, 0.86, cf + 0.1 * (g + 0.5)) * pal.chipAmount;
      const deep = P.smoothstep(0.78, 0.9, cf);
      const cr = primer.r + (steel.r - primer.r) * deep;
      const cg = primer.g + (steel.g - primer.g) * deep;
      const cb = primer.b + (steel.b - primer.b) * deep;
      d.tr = d.tr * (1 - 0.8 * chip) + cr * 0.8 * chip;
      d.tg = d.tg * (1 - 0.8 * chip) + cg * 0.8 * chip;
      d.tb = d.tb * (1 - 0.8 * chip) + cb * 0.8 * chip;
      d.metal += (-0.05 + 0.75 * deep) * chip;
      d.rough += (0.15 - 0.45 * deep) * chip;
      d.dh -= 0.0006 * chip;
      // Exhaust soot streaking up the hull.
      const sootMask = P.smoothstep(0.72, 0.92, stretchU(soot, u, v, 6)) * 0.35;
      d.tr *= 1 - 0.4 * sootMask;
      d.tg *= 1 - 0.4 * sootMask;
      d.tb *= 1 - 0.42 * sootMask;
      d.rough += 0.1 * sootMask;
      // Rivet heads along the plate seams, painted over but still readable.
      const fv = P.cellPos(v, PANELS);
      const rowDist = Math.abs(Math.min(fv, 1 - fv) * (b.worldScale / PANELS) - 0.03);
      if (rowDist < 0.018) {
        const du = (P.cellPos(u, RIVETS) - 0.5) * (b.worldScale / RIVETS);
        if (Math.abs(du) < 0.018) {
          const rr = Math.sqrt(du * du + rowDist * rowDist) / 0.013;
          if (rr < 1) {
            const dome = Math.sqrt(Math.max(0, 1 - rr * rr));
            d.dh += 0.0035 * dome;
            d.tr *= 1 + 0.12 * dome;
            d.tg *= 1 + 0.12 * dome;
            d.tb *= 1 + 0.12 * dome;
          }
        }
      }
    },
  };
}

const GREEN_PALETTE: CamoPalette = {
  base: 0x4d5733,
  tones: [0x39432a, 0x5b4a30, 0x20241c],
  dust: 0xa89a78,
  dustAmount: 0.5,
  spatter: 0.75,
  spatterColor: 0x4a3c28,
  chipAmount: 0.55,
  rough: 0.62,
};

/**
 * Enemy camouflage: a brick-red disruptive pattern. Deliberately more saturated than the
 * green (dust kept low) so enemy vehicles read as RED from across the map — that is the
 * whole point of the palette.
 */
const RED_PALETTE: CamoPalette = {
  base: 0x9c3f2e,
  tones: [0x7e2f26, 0xa8542f, 0x3f1d16],
  dust: 0xb98a6a,
  dustAmount: 0.35,
  spatter: 0.45,
  spatterColor: 0x5a2d20,
  chipAmount: 0.7,
  rough: 0.64,
};

export const camoGreen: SurfaceSpec = {
  key: 'camoGreen',
  worldScale: 3,
  base: { color: 0x4d5733, color2: 0x20241c, rough: 0.62, metal: 0.12 },
  coarseDiv: 2,
  cavityRadius: 0.006,
  build: (b) => camoRecipe(b, GREEN_PALETTE),
};

export const camoRed: SurfaceSpec = {
  key: 'camoRed',
  worldScale: 3,
  base: { color: 0x9c3f2e, color2: 0x521f18, rough: 0.64, metal: 0.12 },
  coarseDiv: 2,
  cavityRadius: 0.006,
  build: (b) => camoRecipe(b, RED_PALETTE),
};

/* ---------------------------------------------------------------- hull metal */

export const vehMetal: SurfaceSpec = {
  key: 'vehMetal',
  worldScale: 3,
  base: { color: 0x6d7266, color2: 0x4c5049, rough: 0.58, metal: 0.35 },
  cavityRadius: 0.006,
  build(b): Recipe {
    const seed = b.seed;
    const dents = noiseField({ seed, freq: 4, res: b.res, octaves: 3 });
    const rolled = noiseField({ seed: seed ^ 0x11, freq: 14, res: b.half, octaves: 3 });
    const grime = noiseField({ seed: seed ^ 0x23, freq: 8, res: b.res, octaves: 3 });
    const wear = noiseField({ seed: seed ^ 0x35, freq: 26, res: b.half, octaves: 3, kind: 'turbulence' });
    const primer = hexToLinear(0x87763f);
    const bare = hexToLinear(0xc4c8c9);
    const rustTint = hexToLinear(0x74452a);
    const grimeCol = hexToLinear(0x4c4a41);
    const WELD_V = 0.5;
    return {
      coarse(u, v, o) {
        const dn = sampleField(dents, u, v);
        const dent = P.smoothstep(0.55, 0.8, dn);
        // Oil-canning between the stiffeners plus discrete dents from battle damage.
        o.h = 0.003 * Math.sin(P.cellPos(u, 3) * Math.PI) * Math.sin(P.cellPos(v, 2) * Math.PI) - 0.012 * dent;
        P.tint(o, 0.92 + 0.16 * sampleField(rolled, u, v) - 0.12 * dent);
        o.rough = 0.52 + 0.18 * sampleField(wear, u, v) + 0.15 * dent;
        o.metal = 0.35;
        // A welded plate joint: the bead sits proud of the parent metal.
        const weld = P.band(v - WELD_V - 0.004 * (sampleField(grime, u, v) - 0.5), 0.012);
        o.h += 0.004 * weld;
        o.rough += 0.1 * weld;
        o.ao = 1 - 0.22 * weld - 0.2 * dent;
        const streak = stretchU(grime, u, v, 10);
        P.mixTo(o, grimeCol, 0.3 * P.smoothstep(0.55, 0.9, streak));
        o.aux = weld;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const g = white(x, y, seed) - 0.5;
        const roll = sampleField(rolled, u, v) - 0.5;
        d.dh += 0.0007 * g + 0.0004 * roll;
        d.tr *= 1 + 0.07 * roll + 0.04 * g;
        d.tg *= 1 + 0.07 * roll + 0.04 * g;
        d.tb *= 1 + 0.07 * roll + 0.04 * g;
        d.rough += 0.06 * roll;
        // Weld bead ripple: the stacked-dime pattern of a hand weld.
        const weldPos = v - WELD_V - 0.004 * (sampleField(grime, u, v) - 0.5);
        const weld = P.band(weldPos, 0.012);
        if (weld > 0.02) {
          const ripple = 0.5 + 0.5 * Math.cos(u * 6.28318 * 60 + weldPos * 40);
          d.dh += (0.0016 * ripple - 0.0004) * weld;
          d.tr *= 1 - 0.08 * weld + 0.1 * ripple * weld;
          d.tg *= 1 - 0.08 * weld + 0.1 * ripple * weld;
          d.tb *= 1 - 0.08 * weld + 0.1 * ripple * weld;
          // Heat tint either side of the bead.
          const heat = P.band(weldPos, 0.03) * (1 - weld);
          d.tr = d.tr * (1 - 0.3 * heat) + rustTint.r * 0.3 * heat;
          d.tg = d.tg * (1 - 0.3 * heat) + rustTint.g * 0.3 * heat;
          d.tb = d.tb * (1 - 0.3 * heat) + rustTint.b * 0.3 * heat;
        }
        // Scratches: shallow ones polish the paint, deep ones cut to bare steel.
        const wf = sampleField(wear, u, v);
        const scratch = (1 - P.smoothstep(0, 0.06, Math.abs(2 * wf - 1))) * P.smoothstep(0.4, 0.7, white(x, y, seed ^ 0x47));
        if (scratch > 0.03) {
          const deep = wf > 0.55;
          const cc = deep ? bare : primer;
          const m = scratch * (deep ? 0.85 : 0.4);
          d.tr = d.tr * (1 - m) + cc.r * m;
          d.tg = d.tg * (1 - m) + cc.g * m;
          d.tb = d.tb * (1 - m) + cc.b * m;
          d.metal += (deep ? 0.6 : 0) * scratch;
          d.rough += (deep ? -0.25 : 0.1) * scratch;
          d.dh -= 0.0005 * scratch;
        }
        // Stencilled handling instruction, half worn away.
        const stencil = P.textMask('NO STEP', u, v, 0.52, 0.96, 0.68, 0.78);
        if (stencil > 0.5) {
          const life = P.smoothstep(0.35, 0.75, sampleField(grime, u, v));
          const ink = stencil * (1 - 0.7 * life);
          d.tr = d.tr * (1 - 0.7 * ink) + 0.9 * ink;
          d.tg = d.tg * (1 - 0.7 * ink) + 0.9 * ink;
          d.tb = d.tb * (1 - 0.7 * ink) + 0.86 * ink;
          d.rough -= 0.1 * ink;
        }
      },
    };
  },
};

/* -------------------------------------------------------------- detail metal */

export const vehDetail: SurfaceSpec = {
  key: 'vehDetail',
  worldScale: 3,
  base: { color: 0x353a3c, color2: 0x22262a, rough: 0.6, metal: 0.55 },
  cavityRadius: 0.01,
  build(b): Recipe {
    const seed = b.seed;
    const grime = noiseField({ seed, freq: 7, res: b.res, octaves: 4 });
    const oil = noiseField({ seed: seed ^ 0x12, freq: 12, res: b.res, octaves: 3 });
    const rough = noiseField({ seed: seed ^ 0x24, freq: 40, res: b.half, octaves: 3 });
    const paint = hexToLinear(0xe2ded0);
    const oilCol = hexToLinear(0x1a1712);
    const bare = hexToLinear(0xa9adae);
    const grimeCol = hexToLinear(0x4a463c);
    const SLATS = 16; // grille slats across the top band
    const BOLTS = 10;
    return {
      coarse(u, v, o) {
        const gm = sampleField(grime, u, v);
        P.tint(o, 0.85 + 0.3 * gm);
        P.mixTo(o, grimeCol, 0.35 * P.smoothstep(0.5, 0.9, gm));
        o.rough = 0.55 + 0.25 * gm;
        // Top band is a grille: slats standing proud of a dark plenum.
        if (v < 0.26) {
          const slat = P.cellOf(u, SLATS);
          const inSlat = (slat & 1) === 0;
          o.h = inSlat ? 0.004 : -0.012;
          o.rough = inSlat ? 0.5 : 0.85;
          o.metal = inSlat ? 0.6 : 0.2;
          o.ao = inSlat ? 0.95 : 0.35;
          P.tint(o, inSlat ? 1.15 : 0.5);
        } else {
          o.h = 0.0015 * Math.sin(P.cellPos(u, 2) * Math.PI);
          o.metal = 0.55;
          o.ao = 1;
        }
        o.aux = gm;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const g = white(x, y, seed) - 0.5;
        const rf = sampleField(rough, u, v) - 0.5;
        d.dh += 0.0005 * g + 0.0003 * rf;
        d.tr *= 1 + 0.06 * rf + 0.05 * g;
        d.tg *= 1 + 0.06 * rf + 0.05 * g;
        d.tb *= 1 + 0.06 * rf + 0.05 * g;
        d.rough += 0.05 * rf;
        // Grille slats: crisp per-texel edges, with the plenum behind them in shadow.
        if (v < 0.265) {
          const su = P.fract(u * SLATS);
          const slat = P.cellOf(u, SLATS);
          const inSlat = (slat & 1) === 0;
          const edge = P.smoothstep(0.06, 0.0, Math.abs(su - 0.5) - 0.42);
          const band = P.smoothstep(0.26, 0.24, v);
          if (inSlat) {
            // Rounded slat face: bright at the crown, dark where it turns away.
            const crown = 1 - Math.abs(su - 0.5) * 2;
            d.dh += 0.002 * crown * band;
            d.tr *= 1 + 0.18 * crown * band;
            d.tg *= 1 + 0.18 * crown * band;
            d.tb *= 1 + 0.18 * crown * band;
            d.rough -= 0.12 * crown * band;
          } else {
            d.dh -= 0.004 * band;
            d.tr *= 1 - 0.4 * band;
            d.ao *= 1 - 0.45 * band;
            d.rough += 0.15 * band;
          }
          d.tr *= 1 - 0.25 * edge * band;
        }
        // Bolt heads along the panel edges, each weeping oil downwards.
        for (let k = 0; k < 2; k++) {
          const rowV = k === 0 ? 0.34 : 0.9;
          if (Math.abs(v - rowV) < 0.03) {
            const du = (P.cellPos(u, BOLTS) - 0.5) * (b.worldScale / BOLTS);
            const dv = (v - rowV) * b.worldScale;
            const head = P.discMask(du, dv, 0.016, 0.005);
            if (head > 0.02) {
              d.dh += 0.003 * head;
              const flat = P.boxMask(du, dv, 0.008, 0.008, 0.002);
              d.tr *= 1 + 0.15 * head - 0.3 * flat;
              d.tg *= 1 + 0.15 * head - 0.3 * flat;
              d.tb *= 1 + 0.15 * head - 0.3 * flat;
              d.metal += 0.2 * head;
              d.rough -= 0.15 * head;
              if (dv > 0.01) {
                const weep = P.smoothstep(0.02, 0.09, dv) * P.smoothstep(0.06, 0.02, Math.abs(du));
                d.tr = d.tr * (1 - 0.6 * weep) + oilCol.r * 0.6 * weep;
                d.tg = d.tg * (1 - 0.6 * weep) + oilCol.g * 0.6 * weep;
                d.tb = d.tb * (1 - 0.6 * weep) + oilCol.b * 0.6 * weep;
                d.rough -= 0.25 * weep;
              }
            }
          }
        }
        // Stencilled unit markings.
        const t1 = P.textMask('M1A2', u, v, 0.08, 0.4, 0.42, 0.56);
        const t2 = P.textMask('FUEL', u, v, 0.55, 0.9, 0.44, 0.55);
        const ink = Math.max(t1, t2) * (1 - 0.45 * P.smoothstep(0.4, 0.8, sampleField(oil, u, v)));
        if (ink > 0.5) {
          d.tr = d.tr * (1 - 0.8 * ink) + paint.r * 0.8 * ink;
          d.tg = d.tg * (1 - 0.8 * ink) + paint.g * 0.8 * ink;
          d.tb = d.tb * (1 - 0.8 * ink) + paint.b * 0.8 * ink;
          d.rough -= 0.15 * ink;
          d.metal -= 0.2 * ink;
        }
        // Kill marks: a row of stencilled vehicle silhouettes, one per confirmed kill.
        for (let k = 0; k < 6; k++) {
          const ku = 0.12 + k * 0.13;
          const kills = P.smoothstep(0.35, 0.4, hash2f(41, 3, seed) + (k < 4 ? 0.2 : -0.2));
          const du = (u - ku) * 22;
          const dv = (v - 0.78) * 22;
          const mark = P.tankMarkMask(du, dv, 0.06) * kills;
          if (mark > 0.4) {
            d.tr = d.tr * (1 - 0.75 * mark) + paint.r * 0.75 * mark;
            d.tg = d.tg * (1 - 0.75 * mark) + paint.g * 0.75 * mark;
            d.tb = d.tb * (1 - 0.75 * mark) + paint.b * 0.75 * mark;
            d.rough -= 0.1 * mark;
            d.dh += 0.0003 * mark;
          }
        }
        // Chipped paint and scuffed corners.
        const chip = P.smoothstep(0.72, 0.9, sampleField(oil, u, v)) * P.smoothstep(0.45, 0.65, g + 0.5);
        if (chip > 0.03) {
          d.tr = d.tr * (1 - 0.7 * chip) + bare.r * 0.7 * chip;
          d.tg = d.tg * (1 - 0.7 * chip) + bare.g * 0.7 * chip;
          d.tb = d.tb * (1 - 0.7 * chip) + bare.b * 0.7 * chip;
          d.metal += 0.6 * chip;
          d.rough -= 0.2 * chip;
        }
      },
    };
  },
};
