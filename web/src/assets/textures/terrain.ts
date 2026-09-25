/**
 * Terrain surfaces: the tileable materials the splat-blended ground shader draws.
 *
 * Scale note that drives every recipe below: `worldScale` is metres per repeat, so at
 * 512px a texel is 12-23 mm. Real 3 mm sand grains or 10 mm asphalt aggregate are
 * therefore *sub-texel*; they are represented by hash noise (which reads as tooth at
 * 1:1 and averages into believable tone at distance) while everything the eye actually
 * identifies — ripples, ruts, cracks, strata, clumps, panel seams, paint — is authored
 * at 3-40 px so it survives the 40-80 m view.
 */
import { hexToLinear } from './canvas';
import { cellularField, noiseField, sampleField, stretchU } from './noise';
import * as P from './patterns';
import { hash2f, white } from './rng';
import { CH, samplePlane, type BakeContext, type Recipe, type SurfaceSpec } from './field';

/** Cosine/sine table for per-cell rotations (16 entries per quadrant, wrapped). */
const COS_LUT = (() => {
  const t = new Float64Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.cos((i / 64) * Math.PI * 2);
  return t;
})();

/** Bilinear sample of the coarse scratch channel (masks shared between the two passes). */
function auxAt(b: BakeContext, u: number, v: number): number {
  return samplePlane(b.ch[CH.AUX], b.res, u, v);
}

/* ---------------------------------------------------------------------- sand */

export const sand: SurfaceSpec = {
  key: 'sand',
  worldScale: 12,
  base: { color: 0xc3ab84, color2: 0x9c8562, rough: 0.88, metal: 0 },
  cavityRadius: 0.0015,
  build(b): Recipe {
    const seed = b.seed;
    const broad = noiseField({ seed, freq: 2, res: b.res, octaves: 4 });
    const patch = noiseField({ seed: seed ^ 0x51, freq: 6, res: b.res, octaves: 3 });
    const compact = noiseField({ seed: seed ^ 0x77, freq: 12, res: b.half, octaves: 2 });
    const pale = hexToLinear(0xf2e6ca);
    const warm = hexToLinear(0xc2a071);
    // 12 m / 32 = 37 cm between ripple crests: the aeolian spacing that reads from 60 m.
    const RIPPLES = 32;
    return {
      coarse(u, v, o) {
        const br = sampleField(broad, u, v);
        const pa = sampleField(patch, u, v);
        P.mixTo(o, pale, 0.34 * P.smoothstep(0.42, 0.9, br));
        P.mixTo(o, warm, 0.4 * P.smoothstep(0.52, 0.08, br));
        // 2 m mottling is what keeps sand from reading as a flat sheet at 60 m, where the
        // 37 cm ripples have long since mip-averaged away.
        P.tint(o, 0.86 + 0.26 * pa);
        o.rough = 0.84 + 0.1 * sampleField(compact, u, v);
        // Dune relief plus the long-wavelength part of the ripple field.
        o.h = 0.03 * (br - 0.5) + 0.014 * (pa - 0.5);
        o.aux = br;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const pa = sampleField(patch, u, v);
        // Wind ripples: a warped triangle wave reproduces the sharp crest and the longer
        // windward slope. Spacing itself wanders so the pattern never looks extruded.
        const rc = v * RIPPLES + 1.9 * (pa - 0.5) + 0.9 * (white(x, y, seed ^ 0x2b) - 0.5);
        // Asymmetric profile: a steep lee face and a long windward ramp, which is what
        // makes a ripple field read as wind-worked sand instead of a sine wave.
        const t = Math.abs(2 * P.fract(rc) - 1);
        const crest = t * t * (3 - 2 * t);
        const g = white(x, y, seed) - 0.5;
        d.dh += 0.03 * crest + 0.007 * (pa - 0.5) + 0.0022 * g;
        // Winnowed crests are lighter and marginally coarser; troughs hold dark minerals.
        const shade = 1 + 0.2 * crest + 0.16 * g;
        d.tr = shade;
        d.tg = shade * (1 - 0.015 * crest);
        d.tb = shade * (1 - 0.05 * crest);
        const sh = white(x, y, seed ^ 0x5a);
        if (sh > 0.994) {
          // Shell fragments: pale, slightly proud, smoother than the sand around them.
          d.ar += 0.22;
          d.ag += 0.21;
          d.ab += 0.18;
          d.dh += 0.002;
          d.rough -= 0.14;
        } else if (sh < 0.02) {
          d.tr *= 0.74;
          d.tg *= 0.72;
          d.tb *= 0.7;
          d.dh -= 0.0008;
        }
      },
    };
  },
};

/* ------------------------------------------------------------------- sandWet */

export const sandWet: SurfaceSpec = {
  key: 'sandWet',
  worldScale: 12,
  base: { color: 0x8f7a58, color2: 0x5c4c36, rough: 0.36, metal: 0 },
  cavityRadius: 0.0012,
  build(b): Recipe {
    const seed = b.seed;
    const wet = noiseField({ seed, freq: 3, res: b.res, octaves: 4, warp: 1.2 });
    const fine = noiseField({ seed: seed ^ 0x31, freq: 20, res: b.half, octaves: 2 });
    const dark = hexToLinear(0x6f5c41);
    const RIPPLES = 32;
    return {
      coarse(u, v, o) {
        const w = sampleField(wet, u, v);
        // A water film darkens sand far more than it lightens: linear, not sRGB, mix.
        P.mixTo(o, dark, 0.8 * P.smoothstep(0.3, 0.72, w));
        P.tint(o, 0.93 + 0.14 * sampleField(fine, u, v));
        o.rough = P.mix(0.92, 0.3, P.smoothstep(0.25, 0.7, w));
        o.h = 0.02 * (w - 0.5);
        o.aux = w;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const w = sampleField(wet, u, v);
        const damp = P.smoothstep(0.28, 0.72, w);
        const rc = v * RIPPLES + 1.4 * (w - 0.5);
        const crest = P.pow075(Math.abs(2 * P.fract(rc) - 1));
        // Standing water flattens the ripples instead of drowning them.
        d.dh += 0.016 * crest * (1 - 0.75 * damp) + 0.0015 * (white(x, y, seed) - 0.5);
        // Tide line: a strand of shells and weed where the water has just pulled back.
        // A smooth bump instead of a gaussian: same read, no libm call per texel.
        const dl = 1 - Math.abs(w - 0.5) * 21;
        const line = dl > 0 ? dl * dl : 0;
        d.tr = 1 + 0.1 * crest - 0.1 * damp;
        d.tg = d.tr * (1 - 0.02 * crest);
        d.tb = d.tr * (1 - 0.05 * crest);
        if (line > 0.35) {
          const deb = white(x, y, seed ^ 0x9d);
          if (deb > 0.72) {
            d.ar += 0.2 * line;
            d.ag += 0.19 * line;
            d.ab += 0.15 * line;
            d.rough += 0.2 * line;
          } else {
            d.tr *= 1 - 0.2 * line;
            d.tg *= 1 - 0.22 * line;
            d.tb *= 1 - 0.25 * line;
          }
        }
        d.rough -= 0.1 * damp;
      },
    };
  },
};

/* ------------------------------------------------------- sand ramp: grit, coral */

/**
 * Sand ramp: `sand` (dune, the default) -> `sandGrit` -> `sandCoral`.
 *
 * The three have to *blend*: the map stores one variant index per ground cell and the shader
 * lerps between the two stops either side of it, so each step has to change grain and tone
 * rather than be a different beach. Dune is wind-sorted pale sand, grit is the dark
 * iron-and-basalt wash that collects beside it, coral is the bleached shell hash of a reef flat —
 * a real island has all three within a few hundred metres, in that order.
 */
export const sandGrit: SurfaceSpec = {
  key: 'sandGrit',
  worldScale: 11,
  base: { color: 0x8b7a5a, color2: 0x5d5039, rough: 0.92, metal: 0 },
  cavityRadius: 0.0012,
  build(b): Recipe {
    const seed = b.seed;
    const broad = noiseField({ seed, freq: 3, res: b.res, octaves: 4 });
    const wash = noiseField({ seed: seed ^ 0x13, freq: 7, res: b.res, octaves: 3, kind: 'turbulence' });
    // 11 m / 48 = 23 cm between gravel clusters: half the dune ripple spacing, which is what
    // makes this read as a coarser ground at the same camera distance.
    const gravel = cellularField({ seed: seed ^ 0x27, cells: 34, res: b.res, jitter: 1, tag: 'grit' });
    const dark = hexToLinear(0x4a4033);
    const pale = hexToLinear(0xcdbb98);
    const RIPPLES = 48;
    return {
      coarse(u, v, o) {
        const br = sampleField(broad, u, v);
        const wa = sampleField(wash, u, v);
        // Placer streaks: heavy minerals sort into bands, which is the one feature that says
        // "coarse dark sand" rather than "sand in shadow".
        const streak = stretchU(wash, u, v, 9);
        P.mixTo(o, dark, 0.72 * P.smoothstep(0.42, 0.8, wa) + 0.3 * P.smoothstep(0.6, 0.9, streak));
        P.mixTo(o, pale, 0.22 * P.smoothstep(0.5, 0.9, br));
        const gi0 = P.texel(u, gravel.res);
        const gj0 = P.texel(v, gravel.res);
        P.tint(o, 0.8 + 0.34 * gravel.id[gj0 * gravel.res + gi0]);
        o.rough = 0.89 + 0.07 * br;
        o.h = 0.026 * (br - 0.5) + 0.012 * (wa - 0.5);
        // `broad` rides along as the scratch channel so the detail pass re-uses the same field
        // instead of evaluating another one per texel.
        o.aux = br;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const br = auxAt(b, u, v);
        // Shallower ripples than dune sand: coarse grains do not sort into sharp crests.
        const rc = v * RIPPLES + 1.1 * (br - 0.5);
        const t = Math.abs(2 * P.fract(rc) - 1);
        const crest = t * t * (3 - 2 * t);
        const g = white(x, y, seed) - 0.5;
        d.dh += 0.008 * crest + 0.005 * g;
        d.tr *= 1 + 0.05 * crest + 0.16 * g;
        d.tg *= 1 + 0.055 * crest + 0.16 * g;
        d.tb *= 1 + 0.045 * crest + 0.14 * g;
        // Basalt and ironstone pebbles: darker than the sand, proud, and slightly smoother.
        const gi = P.texel(u, gravel.res);
        const gj = P.texel(v, gravel.res);
        const idx = gj * gravel.res + gi;
        const pebble =
          P.smoothstep(0.3, 0.08, gravel.f1[idx]) * P.smoothstep(0.45, 0.7, gravel.id[idx]);
        if (pebble > 0.02) {
          d.dh += 0.013 * pebble;
          d.tr *= 1 - 0.62 * pebble;
          d.tg *= 1 - 0.6 * pebble;
          d.tb *= 1 - 0.54 * pebble;
          d.rough -= 0.14 * pebble;
          // Lit rim on the sunward side of each pebble.
          d.ar += 0.05 * pebble;
        }
        // Shell and quartz chips: the pale minority that keeps the dark wash from going muddy.
        const chip =
          P.smoothstep(0.06, 0.02, gravel.f1[idx]) * P.smoothstep(0.2, 0.06, gravel.id[idx]);
        if (chip > 0.02) {
          d.ar += 0.3 * chip;
          d.ag += 0.29 * chip;
          d.ab += 0.25 * chip;
          d.rough -= 0.1 * chip;
        }
      },
    };
  },
};

export const sandCoral: SurfaceSpec = {
  key: 'sandCoral',
  worldScale: 13,
  base: { color: 0xe3d6bd, color2: 0xb6a483, rough: 0.83, metal: 0 },
  cavityRadius: 0.0018,
  build(b): Recipe {
    const seed = b.seed;
    const bleach = noiseField({ seed, freq: 3, res: b.res, octaves: 4 });
    // 13 m / 12 = 1.1 m coral heads and rubble piles: lumpy at a scale dune sand never is.
    const lumps = cellularField({ seed: seed ^ 0x61, cells: 12, res: b.res, jitter: 1, tag: 'coral' });
    // 13 m / 24 = 54 cm rubble: the grain between a lump and a shard.
    const rubble = cellularField({ seed: seed ^ 0x74, cells: 24, res: b.res, jitter: 1, tag: 'rubble' });
    const pink = hexToLinear(0xd8b3a4);
    // Not `white`: that is the hash-noise helper this recipe's detail pass calls.
    const bleached = hexToLinear(0xf6efe0);
    const shade = hexToLinear(0x8d7f66);
    return {
      coarse(u, v, o) {
        const bl = sampleField(bleach, u, v);
        const li = P.texel(u, lumps.res);
        const lj = P.texel(v, lumps.res);
        const lIdx = lj * lumps.res + li;
        P.mixTo(o, bleached, 0.4 * P.smoothstep(0.45, 0.9, bl));
        P.mixTo(o, shade, 0.34 * P.smoothstep(0.35, 0.72, lumps.f1[lIdx]));
        // Dead coral keeps a pink cast before it bleaches out.
        P.mixTo(o, pink, 0.22 * P.smoothstep(0.6, 0.86, lumps.id[lIdx]) * (1 - bl));
        const r0 = P.texel(u, rubble.res) + P.texel(v, rubble.res) * rubble.res;
        o.rough = 0.8 + 0.12 * rubble.id[r0];
        o.h = 0.07 * P.smoothstep(0.2, 0.9, lumps.id[lIdx]) - 0.02 * lumps.f1[lIdx];
        o.aux = lumps.id[lIdx];
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const g = white(x, y, seed) - 0.5;
        const ri = P.texel(u, rubble.res);
        const rj = P.texel(v, rubble.res);
        const rIdx = rj * rubble.res + ri;
        // Shards: flat fragments lying at an angle, so they catch light on one edge and drop a
        // dark gap on the other. A bright edge beside a shadow is what a shell hash looks like;
        // a uniform pale tint just reads as more sand.
        const shard = P.smoothstep(0.26, 0.06, rubble.f1[rIdx]);
        if (shard > 0.02) {
          const edge = P.smoothstep(0.5, 0.72, rubble.id[rIdx]);
          d.dh += 0.006 * shard;
          // Chips are chalky, not glassy: lift the tone without blowing it out, and keep the
          // bright line for the shard's edge only.
          d.ar += (0.12 + 0.2 * edge) * shard;
          d.ag += (0.115 + 0.19 * edge) * shard;
          d.ab += (0.1 + 0.16 * edge) * shard;
          d.rough -= 0.08 * shard;
        }
        const gap = P.smoothstep(0.12, 0.03, rubble.f1[rIdx]);
        if (gap > 0.02) {
          d.dh -= 0.008 * gap;
          d.tr *= 1 - 0.3 * gap;
          d.tg *= 1 - 0.31 * gap;
          d.tb *= 1 - 0.32 * gap;
          d.ao *= 1 - 0.3 * gap;
        }
        d.dh += 0.0035 * g;
        d.tr *= 1 + 0.09 * g;
        d.tg *= 1 + 0.09 * g;
        d.tb *= 1 + 0.08 * g;
      },
    };
  },
};

/* ---------------------------------------------------------------------- dirt */

export const dirt: SurfaceSpec = {
  key: 'dirt',
  worldScale: 10,
  base: { color: 0x8b7053, color2: 0xa8916f, rough: 0.93, metal: 0 },
  cavityRadius: 0.012,
  build(b): Recipe {
    const seed = b.seed;
    const broad = noiseField({ seed, freq: 3, res: b.res, octaves: 4 });
    const clods = noiseField({ seed: seed ^ 0x21, freq: 16, res: b.res, octaves: 3, kind: 'turbulence' });
    const damp = noiseField({ seed: seed ^ 0x45, freq: 2, res: b.res, octaves: 3 });
    // 10 m / 64 = 16 cm gravel clusters: 8 px at 512, so cobbles stay readable.
    const gravel = cellularField({ seed: seed ^ 0x63, cells: 40, res: b.res, jitter: 1, tag: 'gravel' });
    const cracks = noiseField({ seed: seed ^ 0x8f, freq: 10, res: b.half, octaves: 3, kind: 'turbulence', warp: 2 });
    const dust = hexToLinear(0xb9a382);
    const organic = hexToLinear(0x53412c);
    const stone = hexToLinear(0x9c9184);
    const rutA = 0.3;
    const rutB = 0.7;
    return {
      coarse(u, v, o) {
        const br = sampleField(broad, u, v);
        const dm = sampleField(damp, u, v);
        P.mixTo(o, dust, 0.4 * P.smoothstep(0.45, 0.9, br));
        P.mixTo(o, organic, 0.35 * P.smoothstep(0.55, 0.1, dm));
        P.tint(o, 0.9 + 0.2 * sampleField(clods, u, v));
        o.rough = 0.88 + 0.1 * br;
        o.h = 0.03 * (br - 0.5);
        // Two wheel ruts with a wandering centre line; the berms are compacted spoil.
        const wander = 0.035 * (sampleField(broad, u, v) - 0.5);
        const da = Math.abs(v - rutA - wander);
        const db = Math.abs(v - rutB - wander);
        const ra = 1 - da * 28;
        const rb = 1 - db * 28;
        const rut = Math.max(ra > 0 ? ra * ra : 0, rb > 0 ? rb * rb : 0);
        const ba = 1 - Math.abs(da - 0.075) * 40;
        const bb = 1 - Math.abs(db - 0.075) * 40;
        const berm = Math.max(ba > 0 ? ba * ba : 0, bb > 0 ? bb * bb : 0);
        o.h -= 0.075 * rut;
        o.h += 0.02 * berm;
        P.tint(o, 1 - 0.22 * rut);
        o.rough -= 0.18 * rut;
        o.aux = rut;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const rut = auxAt(b, u, v);
        // Gravel: each cell contributes a stone with its own size, tone and height.
        const gi = P.texel(u, b.res);
        const gj = P.texel(v, b.res);
        const gid = gravel.id[gj * gravel.res + gi];
        const gf1 = gravel.f1[gj * gravel.res + gi];
        const stoneMask = P.smoothstep(0.62, 0.35, gf1) * P.smoothstep(0.25, 0.5, gid);
        const g = white(x, y, seed) - 0.5;
        d.dh += stoneMask * 0.012 + 0.006 * g * (1 - rut * 0.6);
        if (stoneMask > 0.01) {
          const lit = 0.7 + 0.6 * gid;
          d.ar += stone.r * stoneMask * lit * 0.5;
          d.ag += stone.g * stoneMask * lit * 0.5;
          d.ab += stone.b * stoneMask * lit * 0.5;
          d.tr *= 1 - 0.25 * stoneMask;
          d.tg *= 1 - 0.25 * stoneMask;
          d.tb *= 1 - 0.25 * stoneMask;
          d.rough += 0.08 * stoneMask;
        }
        // Tyre tread bars pressed into the compacted ruts.
        const bar = rut > 0.15 ? P.band(P.fract(u * 40) - 0.5, 0.16) * rut : 0;
        d.dh -= 0.008 * bar;
        d.tr *= 1 - 0.12 * bar;
        d.tg *= 1 - 0.12 * bar;
        d.tb *= 1 - 0.1 * bar;
        // Dry-weather cracks: the zero set of a warped turbulence field.
        const cf = sampleField(cracks, u, v);
        const crack = 1 - P.smoothstep(0, 0.055, Math.abs(2 * cf - 1));
        if (crack > 0.01) {
          d.dh -= 0.014 * crack;
          d.tr *= 1 - 0.45 * crack;
          d.tg *= 1 - 0.45 * crack;
          d.tb *= 1 - 0.42 * crack;
          d.ao *= 1 - 0.3 * crack;
          d.rough += 0.05 * crack;
        }
        d.tr *= 1 + 0.12 * g * (1 - rut * 0.5);
        d.tg *= 1 + 0.11 * g * (1 - rut * 0.5);
        d.tb *= 1 + 0.1 * g * (1 - rut * 0.5);
      },
    };
  },
};

/* ---------------------------------------------------------------------- rock */

export const rock: SurfaceSpec = {
  key: 'rock',
  worldScale: 9,
  base: { color: 0x8b857a, color2: 0x615c54, rough: 0.87, metal: 0 },
  cavityRadius: 0.035,
  build(b): Recipe {
    const seed = b.seed;
    // 9 m / 5 = 1.8 m sedimentary bands: hard ledges with softer interbeds.
    const strataWarp = noiseField({ seed, freq: 4, res: b.res, octaves: 4, warp: 2.5 });
    const dust = noiseField({ seed: seed ^ 0x13, freq: 3, res: b.res, octaves: 3 });
    // 9 m / 13 = 70 cm blocks: fractured faces with beveled edges.
    const blocks = cellularField({ seed: seed ^ 0x2b, cells: 13, res: b.res, jitter: 0.85, tag: 'faces' });
    const pits = noiseField({ seed: seed ^ 0x3d, freq: 40, res: b.half, octaves: 2, kind: 'turbulence' });
    const lichen = noiseField({ seed: seed ^ 0x4f, freq: 8, res: b.res, octaves: 3 });
    const warmDust = hexToLinear(0xb5a68d);
    const dark = hexToLinear(0x4c453c);
    const moss = hexToLinear(0x6b6a45);
    const STRATA = 5;
    return {
      coarse(u, v, o) {
        const sw = sampleField(strataWarp, u, v);
        // Bands dip ~20 degrees so the rock reads as a bedded outcrop, not a floor.
        const band = P.fract(v * STRATA + u * STRATA * 0.34 + 0.75 * (sw - 0.5));
        const hard = P.smoothstep(0.35, 0.6, band) * P.smoothstep(0.95, 0.72, band);
        P.mixTo(o, dark, 0.35 * (1 - hard));
        P.mixTo(o, warmDust, 0.25 * P.smoothstep(0.5, 0.9, sampleField(dust, u, v)));
        P.tint(o, 0.88 + 0.24 * sw);
        o.rough = 0.8 + 0.15 * (1 - hard);
        o.h = 0.06 * hard + 0.03 * (sw - 0.5);
        // Per-block level and tone: the face has been broken along joints.
        const gi = P.texel(u, blocks.res);
        const gj = P.texel(v, blocks.res);
        const idx = gj * blocks.res + gi;
        o.h += 0.05 * (blocks.id[idx] - 0.5);
        P.tint(o, 0.86 + 0.3 * blocks.id[idx]);
        P.mixTo(o, moss, 0.3 * P.smoothstep(0.55, 0.85, sampleField(lichen, u, v)));
        o.aux = hard;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const bi = P.texel(u, blocks.res);
        const bj = P.texel(v, blocks.res);
        const bIdx = bj * blocks.res + bi;
        // Joint crevices: F2-F1, so they follow the block boundaries exactly.
        const gap = blocks.f2[bIdx] - blocks.f1[bIdx];
        const crack = 1 - P.smoothstep(0, 0.05, gap);
        const g = white(x, y, seed) - 0.5;
        d.dh += 0.012 * g - 0.05 * crack;
        if (crack > 0.01) {
          d.tr *= 1 - 0.55 * crack;
          d.tg *= 1 - 0.55 * crack;
          d.tb *= 1 - 0.5 * crack;
          d.rough += 0.06 * crack;
          d.ao *= 1 - 0.45 * crack;
        }
        // Pitting and chipped edges: high-frequency turbulence eats the faces.
        const pf = sampleField(pits, u, v);
        const pit = P.smoothstep(0.62, 0.85, pf);
        d.dh -= 0.01 * pit;
        d.tr *= 1 - 0.25 * pit;
        d.tg *= 1 - 0.25 * pit;
        d.tb *= 1 - 0.24 * pit;
        // Dust settles on the up-facing ledges, darkening the recesses between them.
        const dustMask = P.smoothstep(0.3, 0.7, sampleField(dust, u, v));
        d.tr *= 1 + 0.14 * dustMask + 0.1 * g;
        d.tg *= 1 + 0.13 * dustMask + 0.1 * g;
        d.tb *= 1 + 0.1 * dustMask + 0.1 * g;
        d.rough += 0.05 * g;
      },
    };
  },
};

/* --------------------------------------------------------------------- grass */

export const grass: SurfaceSpec = {
  key: 'grass',
  worldScale: 7,
  base: { color: 0x6f7f42, color2: 0xb0995c, rough: 0.9, metal: 0 },
  cavityRadius: 0.01,
  build(b): Recipe {
    const seed = b.seed;
    // 7 m / 16 = 44 cm clumps: the scale at which Mediterranean scrub reads from the air.
    const clumps = cellularField({ seed, cells: 16, res: b.res, jitter: 1, tag: 'clumps' });
    const moisture = noiseField({ seed: seed ^ 0x1d, freq: 3, res: b.res, octaves: 4 });
    const blades = noiseField({ seed: seed ^ 0x2e, freq: 48, res: b.half, octaves: 2, kind: 'turbulence' });
    const stones = cellularField({ seed: seed ^ 0x3f, cells: 30, res: b.res, jitter: 1, density: 0.35, tag: 'stones' });
    const soil = hexToLinear(0x6b5a3f);
    const dry = hexToLinear(0xb8a266);
    const lush = hexToLinear(0x53703a);
    return {
      coarse(u, v, o) {
        const mi = P.texel(u, clumps.res);
        const mj = P.texel(v, clumps.res);
        const idx = mj * clumps.res + mi;
        const wet = sampleField(moisture, u, v);
        // Clump density: each cell gets its own vigour, so bare ground and thick
        // scrub alternate the way overgrazed island vegetation actually does.
        const vigour = P.smoothstep(0.2, 0.7, clumps.id[idx]) * (0.55 + 1.05 * wet);
        const cover = P.clamp01(vigour * P.smoothstep(0.85, 0.25, clumps.f1[idx]));
        P.mixTo(o, soil, 1 - cover);
        P.mixTo(o, dry, 0.5 * P.smoothstep(0.4, 0.85, 1 - wet));
        P.mixTo(o, lush, 0.55 * cover);
        P.tint(o, 0.9 + 0.2 * clumps.f1[idx]);
        o.rough = 0.86 + 0.1 * (1 - cover);
        o.h = 0.09 * cover;
        o.aux = cover;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const cover = auxAt(b, u, v);
        // Blade striations: turbulence stretched 4:1 and rotated per clump, so no two
        // tussocks comb the same way.
        const ci = P.texel(u, clumps.res);
        const cj = P.texel(v, clumps.res);
        // Per-clump blade direction from a cosine table: two trig calls per texel would
        // cost more than the rest of the grass recipe put together.
        const idc = clumps.id[cj * clumps.res + ci];
        const ai = ((idc * 64) | 0) & 63;
        const ca = COS_LUT[ai] as number;
        const sa = COS_LUT[(ai + 16) & 63] as number;
        const du = u - 0.5;
        const dv = v - 0.5;
        const bf = sampleField(blades, du * ca - dv * sa + 0.5, (du * sa + dv * ca) * 4 + 0.5);
        const blade = (bf - 0.45) * cover;
        const g = white(x, y, seed) - 0.5;
        d.dh += 0.02 * blade + 0.012 * g * cover + 0.004 * g;
        d.tr *= 1 + 0.3 * blade + 0.16 * g * cover;
        d.tg *= 1 + 0.34 * blade + 0.16 * g * cover;
        d.tb *= 1 + 0.2 * blade + 0.14 * g * cover;
        // A few stones poking through the litter.
        const si = P.texel(u, stones.res);
        const sj = P.texel(v, stones.res);
        const sIdx = sj * stones.res + si;
        const sm = P.smoothstep(0.4, 0.15, stones.f1[sIdx]);
        if (sm > 0.02) {
          d.tr *= 1 - 0.4 * sm;
          d.tg *= 1 - 0.4 * sm;
          d.tb *= 1 - 0.38 * sm;
          d.dh += 0.008 * sm;
          d.rough += 0.05 * sm;
        }
        d.rough += 0.06 * g;
      },
    };
  },
};

/* ------------------------------------------------------- grass ramp: lush, dry */

/**
 * Grass ramp: `grassLush` -> `grass` (scrub, the default) -> `grassDry`.
 *
 * A moisture gradient, which is the one thing that makes grass types blend into each other
 * instead of looking painted on: dense green cover, then the sparse Mediterranean scrub that
 * was already here, then sun-bleached straw with the soil showing through. The shader lerps
 * between neighbouring stops, so cover and blade length move together across the whole ramp.
 */
export const grassLush: SurfaceSpec = {
  key: 'grassLush',
  worldScale: 6,
  base: { color: 0x47632c, color2: 0x8fae55, rough: 0.87, metal: 0 },
  cavityRadius: 0.008,
  build(b): Recipe {
    const seed = b.seed;
    // 6 m / 20 = 30 cm tussocks: dense enough that the ground never shows between them.
    const clumps = cellularField({ seed, cells: 20, res: b.res, jitter: 1, tag: 'tufts' });
    const wet = noiseField({ seed: seed ^ 0x1b, freq: 3, res: b.res, octaves: 4 });
    const blades = noiseField({ seed: seed ^ 0x2c, freq: 64, res: b.half, octaves: 2, kind: 'turbulence' });
    // 6 m / 26 = 23 cm between flower heads: sparse enough to be an accent, not a texture.
    const flowers = cellularField({ seed: seed ^ 0x3d, cells: 26, res: b.res, jitter: 1, density: 0.5, tag: 'flowers' });
    const soil = hexToLinear(0x4a3f2b);
    const deep = hexToLinear(0x3f5c2c);
    const lit = hexToLinear(0x8fae55);
    return {
      coarse(u, v, o) {
        const mi = P.texel(u, clumps.res);
        const mj = P.texel(v, clumps.res);
        const idx = mj * clumps.res + mi;
        const w = sampleField(wet, u, v);
        // Cover stays high everywhere: this is the wet end of the ramp, so what varies is how
        // deep the green is, not whether there is grass.
        const vigour = P.smoothstep(0.2, 0.75, clumps.id[idx]) * (0.55 + 0.85 * w);
        const cover = P.clamp01(0.45 + 0.55 * vigour) * P.smoothstep(1.0, 0.35, clumps.f1[idx]);
        P.mixTo(o, soil, 1 - cover);
        // Shadow between tussocks, sun on top of them, and a drier yellow cast where the
        // moisture field dips: a meadow that is one flat green reads as a golf course.
        P.mixTo(o, deep, 0.62 * cover * P.smoothstep(0.6, 0.1, w) * P.smoothstep(0.3, 0.75, clumps.f1[idx]));
        P.mixTo(o, lit, 0.5 * P.smoothstep(0.4, 0.9, w) * (0.5 + 0.5 * clumps.id[idx]));
        P.tint(o, 0.86 + 0.28 * clumps.f1[idx]);
        o.rough = 0.85 + 0.1 * (1 - cover);
        o.h = 0.12 * cover;
        o.aux = cover;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const cover = auxAt(b, u, v);
        const ci = P.texel(u, clumps.res);
        const cj = P.texel(v, clumps.res);
        const idc = clumps.id[cj * clumps.res + ci];
        const ai = ((idc * 64) | 0) & 63;
        const ca = COS_LUT[ai] as number;
        const sa = COS_LUT[(ai + 16) & 63] as number;
        const du = u - 0.5;
        const dv = v - 0.5;
        // Finer and denser than the scrub's blades: 8:1 instead of 4:1, so the tussock reads as
        // turf rather than as separate plants.
        const bf = sampleField(blades, du * ca - dv * sa + 0.5, (du * sa + dv * ca) * 8 + 0.5);
        const blade = (bf - 0.45) * cover;
        const g = white(x, y, seed) - 0.5;
        d.dh += 0.014 * blade + 0.008 * g * cover + 0.003 * g;
        d.tr *= 1 + 0.24 * blade + 0.14 * g * cover;
        d.tg *= 1 + 0.3 * blade + 0.14 * g * cover;
        d.tb *= 1 + 0.16 * blade + 0.12 * g * cover;
        // Flower heads: pale specks that only appear where the cover is thick.
        const fi = P.texel(u, flowers.res);
        const fj = P.texel(v, flowers.res);
        const fIdx = fj * flowers.res + fi;
        const bloom = P.smoothstep(0.16, 0.05, flowers.f1[fIdx]) * P.smoothstep(0.5, 0.8, flowers.id[fIdx]);
        if (bloom > 0.02) {
          const pale = P.smoothstep(0.55, 0.8, flowers.id[fIdx]);
          d.ar += (0.24 + 0.2 * pale) * bloom;
          d.ag += (0.24 + 0.16 * pale) * bloom;
          d.ab += (0.14 + 0.1 * pale) * bloom;
          d.dh += 0.004 * bloom;
        }
        d.rough += 0.05 * g;
      },
    };
  },
};

export const grassDry: SurfaceSpec = {
  key: 'grassDry',
  worldScale: 8,
  base: { color: 0x9c8b52, color2: 0xd2bd80, rough: 0.93, metal: 0 },
  cavityRadius: 0.012,
  build(b): Recipe {
    const seed = b.seed;
    // 8 m / 22 = 36 cm tufts, and far apart: the bare ground between them is the point.
    const tufts = cellularField({ seed, cells: 22, res: b.res, jitter: 1, tag: 'tufts' });
    // 8 m / 44 = 18 cm: a second, finer layer of litter clumps, so the cover is not one soft
    // blob per cell at camera range.
    const litter2 = cellularField({ seed: seed ^ 0x5c, cells: 44, res: b.res, jitter: 1, tag: 'litter' });
    const arid = noiseField({ seed: seed ^ 0x29, freq: 3, res: b.res, octaves: 4 });
    // Stretched 3:1 along the wind: dry litter lies down, it does not stand up.
    const litter = noiseField({ seed: seed ^ 0x3a, freq: 40, res: b.half, octaves: 2, kind: 'turbulence' });
    const stones = cellularField({ seed: seed ^ 0x4b, cells: 34, res: b.res, jitter: 1, density: 0.4, tag: 'stones' });
    const dust = hexToLinear(0xb9a678);
    const soil = hexToLinear(0x8a6f47);
    const straw = hexToLinear(0xd9c68d);
    return {
      coarse(u, v, o) {
        const ti = P.texel(u, tufts.res);
        const tj = P.texel(v, tufts.res);
        const idx = tj * tufts.res + ti;
        const ar = sampleField(arid, u, v);
        // Cover swings hard with the moisture field: green islands in a straw sea.
        const vigour = P.smoothstep(0.42, 0.85, tufts.id[idx]) * (0.2 + 1.25 * ar);
        // Sparse: most of this ground is bare, and the tufts that are there are islands in it.
        const cover = P.clamp01(vigour * P.smoothstep(0.7, 0.1, tufts.f1[idx]) * 0.85);
        const bare = 1 - cover;
        P.mixTo(o, soil, bare);
        P.mixTo(o, dust, 0.5 * P.smoothstep(0.45, 0.1, ar) * bare);
        const li = P.texel(u, litter2.res);
        const lj = P.texel(v, litter2.res);
        const lIdx = lj * litter2.res + li;
        P.mixTo(o, straw, 0.55 * cover * (0.6 + 0.8 * litter2.id[lIdx]));
        P.tint(o, 0.86 + 0.3 * tufts.f1[idx] * (0.5 + 0.5 * litter2.id[lIdx]));
        o.rough = 0.91 + 0.06 * bare;
        o.h = 0.07 * cover;
        o.aux = cover;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const cover = auxAt(b, u, v);
        // Litter: the same turbulence as the scrub's blades, stretched 3:1 and laid flat, with
        // only a weak vertical component so it reads as stalks on the ground, not a haystack.
        const bf = sampleField(litter, u * 4, v);
        const strand = (bf - 0.48) * (0.5 + 0.5 * cover);
        const g = white(x, y, seed) - 0.5;
        d.dh += 0.012 * strand + 0.004 * g;
        // Straw is bright: the litter has to lift the surface, and its shadow has to fall
        // beside it, or the ground stays a flat tan sheet at camera range.
        d.tr *= 1 + 0.34 * strand + 0.16 * g;
        d.tg *= 1 + 0.33 * strand + 0.15 * g;
        d.tb *= 1 + 0.2 * strand + 0.11 * g;
        const under = P.smoothstep(0.06, 0.2, -strand);
        if (under > 0.02) {
          d.tr *= 1 - 0.26 * under;
          d.tg *= 1 - 0.26 * under;
          d.tb *= 1 - 0.24 * under;
          d.ao *= 1 - 0.22 * under;
        }
        const si = P.texel(u, stones.res);
        const sj = P.texel(v, stones.res);
        const sIdx = sj * stones.res + si;
        const sm = P.smoothstep(0.35, 0.12, stones.f1[sIdx]);
        if (sm > 0.02) {
          d.dh += 0.007 * sm;
          d.tr *= 1 - 0.32 * sm;
          d.tg *= 1 - 0.32 * sm;
          d.tb *= 1 - 0.3 * sm;
          d.rough += 0.04 * sm;
        }
        d.rough += 0.05 * g;
      },
    };
  },
};

/* ------------------------------------------------------------------- asphalt */

export const asphalt: SurfaceSpec = {
  key: 'asphalt',
  worldScale: 8,
  base: { color: 0x3f4144, color2: 0x5f6265, rough: 0.86, metal: 0 },
  cavityRadius: 0.006,
  build(b): Recipe {
    const seed = b.seed;
    const patches = noiseField({ seed, freq: 3, res: b.res, octaves: 3 });
    const tar = noiseField({ seed: seed ^ 0x17, freq: 22, res: b.res, octaves: 2, kind: 'turbulence' });
    const cracks = noiseField({ seed: seed ^ 0x29, freq: 11, res: b.half, octaves: 3, kind: 'turbulence', warp: 2.5 });
    const oil = noiseField({ seed: seed ^ 0x3b, freq: 5, res: b.res, octaves: 3 });
    const paint = hexToLinear(0xc8c4b8);
    const fresh = hexToLinear(0x35373a);
    const stoneA = hexToLinear(0xa8a49c);
    const stoneB = hexToLinear(0x6f6a63);
    // A patch grid with hard edges: 8 m / 4 = 2 m repairs, as cut by a road crew.
    const PATCH = 4;
    return {
      coarse(u, v, o) {
        const pi = P.cellOf(u, PATCH);
        const pj = P.cellOf(v, PATCH);
        const h = hash2f(pi, pj, seed);
        P.mixTo(o, fresh, P.smoothstep(0.55, 0.75, h) * 0.75);
        P.tint(o, 0.9 + 0.18 * sampleField(patches, u, v));
        o.rough = 0.8 + 0.14 * (1 - P.smoothstep(0.55, 0.75, h));
        o.h = 0.004 * (h - 0.5);
        // Bitumen bleed along the repair edges plus the tarry seam itself.
        const edge = Math.max(P.seam(P.cellPos(u, PATCH), 0.02), P.seam(P.cellPos(v, PATCH), 0.02));
        o.h -= 0.006 * edge;
        P.tint(o, 1 - 0.3 * edge);
        o.rough += 0.08 * edge;
        // Faded lane paint running along the tile, worn away in patches.
        const lane = P.band(v - 0.5 - 0.004 * (sampleField(tar, u, v) - 0.5), 0.009);
        const wear = P.smoothstep(0.35, 0.62, sampleField(tar, u, v));
        const paintMask = lane * wear * 0.75;
        P.mixTo(o, paint, 0.85 * paintMask);
        o.rough = P.mix(o.rough, 0.72, paintMask);
        o.h += 0.002 * paintMask;
        o.aux = paintMask;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const g = white(x, y, seed);
        // Aggregate: sub-texel chips of stone in bitumen. Two hashes give a light and a
        // dark population so the surface sparkles under the sun instead of looking flat.
        const g2 = white(x, y, seed ^ 0x6d);
        const chip = P.smoothstep(0.63, 0.8, g);
        d.dh += 0.0035 * (g - 0.5) + 0.002 * chip;
        d.tr *= 1 + 0.32 * (g2 - 0.5);
        d.tg *= 1 + 0.31 * (g2 - 0.5);
        d.tb *= 1 + 0.3 * (g2 - 0.5);
        if (chip > 0.02) {
          const cs = g2 > 0.5 ? stoneA : stoneB;
          d.ar += cs.r * 0.55 * chip;
          d.ag += cs.g * 0.55 * chip;
          d.ab += cs.b * 0.55 * chip;
          d.rough -= 0.1 * chip;
        }
        const cf = sampleField(cracks, u, v);
        const crack = 1 - P.smoothstep(0, 0.05, Math.abs(2 * cf - 1));
        if (crack > 0.01) {
          d.dh -= 0.012 * crack;
          d.tr *= 1 - 0.5 * crack;
          d.tg *= 1 - 0.5 * crack;
          d.tb *= 1 - 0.48 * crack;
          d.ao *= 1 - 0.4 * crack;
        }
        // Oil and diesel stains soak in darker and slightly glossier.
        const om = P.smoothstep(0.58, 0.8, sampleField(oil, u, v));
        d.tr *= 1 - 0.35 * om;
        d.tg *= 1 - 0.34 * om;
        d.tb *= 1 - 0.32 * om;
        d.rough -= 0.18 * om;
        d.rough += 0.05 * g;
      },
    };
  },
};

/* ------------------------------------------------------------------ concrete */

/** Shared skeleton for both concrete variants; `worn` adds traffic damage. */
function concreteRecipe(b: BakeContext, worn: boolean): Recipe {
  const seed = b.seed;
  const stains = noiseField({ seed, freq: 5, res: b.res, octaves: 4 });
  const streaks = noiseField({ seed: seed ^ 0x19, freq: 10, res: b.res, octaves: 3 });
  const blotch = noiseField({ seed: seed ^ 0x2a, freq: 14, res: b.res, octaves: 3 });
  const chips = cellularField({ seed: seed ^ 0x4c, cells: 9, res: b.res, jitter: 1, tag: 'chips' });
  const chalk = hexToLinear(0xd8d4c8);
  const grime = hexToLinear(0x5f5c55);
  const rustBleed = hexToLinear(0x7a4a2a);
  // 6 m / 4 = 1.5 m form boards; tie holes on a 0.6 m grid within them.
  const PANELS = 4;
  const TIES = 10;
  return {
    coarse(u, v, o) {
      const pi = P.cellOf(u, PANELS);
      const pj = P.cellOf(v, PANELS);
      const h = hash2f(pi, pj, seed);
      // Each form board poured slightly differently: tone and level both drift.
      P.tint(o, 0.92 + 0.14 * h);
      o.h = 0.005 * (h - 0.5) + 0.012 * (sampleField(blotch, u, v) - 0.5);
      const seamMask = Math.max(P.seam(P.cellPos(u, PANELS), 0.03), P.seam(P.cellPos(v, PANELS), 0.03));
      o.h -= 0.012 * seamMask;
      P.tint(o, 1 - 0.35 * seamMask);
      o.rough += 0.06 * seamMask;
      o.ao = 1 - 0.35 * seamMask;
      // Chalky efflorescence and rain streaks: the two things that age concrete.
      P.mixTo(o, chalk, 0.4 * P.smoothstep(0.55, 0.85, sampleField(stains, u, v)));
      const streak = stretchU(streaks, u, v, 12);
      P.mixTo(o, grime, (worn ? 0.5 : 0.3) * P.smoothstep(0.45, 0.8, streak));
      o.rough = P.mix(o.rough, 0.95, 0.4 * P.smoothstep(0.5, 0.85, streak));
      o.aux = seamMask;
    },
    detail(u, v, d) {
      const x = P.texel(u, b.size);
      const y = P.texel(v, b.size);
      const seamMask = auxAt(b, u, v);
      const g = white(x, y, seed) - 0.5;
      const g2 = white(x, y, seed ^ 0x7e);
      // Fine pitting plus a faint aggregate tooth.
      const pit = P.smoothstep(0.82, 0.95, g2);
      d.dh += 0.0022 * g - 0.004 * pit - 0.004 * seamMask;
      d.tr *= 1 + 0.1 * g - 0.06 * pit;
      d.tg *= 1 + 0.1 * g - 0.06 * pit;
      d.tb *= 1 + 0.095 * g - 0.06 * pit;
      d.rough += 0.06 * g + 0.08 * pit;
      // Tie-rod holes: a recessed disc with a chalky ring, every other grid position.
      const ti = P.cellOf(u, TIES);
      const tj = P.cellOf(v, TIES);
      if (((ti + tj) & 1) === 0) {
        const px = (P.cellPos(u, TIES) - 0.5) * (b.worldScale / TIES);
        const py = (P.cellPos(v, TIES) - 0.5) * (b.worldScale / TIES);
        const hole = P.discMask(px, py, 0.014, 0.006);
        const ring = P.ringMask(px, py, 0.02, 0.008, 0.006);
        if (hole > 0.01) {
          d.dh -= 0.012 * hole;
          d.tr *= 1 - 0.5 * hole;
          d.tg *= 1 - 0.5 * hole;
          d.tb *= 1 - 0.48 * hole;
          d.ao *= 1 - 0.45 * hole;
        }
        if (ring > 0.01) {
          d.dh += 0.0015 * ring;
          d.tr *= 1 + 0.12 * ring;
          d.tg *= 1 + 0.12 * ring;
          d.tb *= 1 + 0.1 * ring;
        }
      }
      // Chipped corners: blocks of the pour have spalled off, exposing aggregate.
      const ci = P.texel(u, chips.res);
      const cj = P.texel(v, chips.res);
      const idx = cj * chips.res + ci;
      const chipMask = P.smoothstep(0.14, 0.05, chips.f1[idx]) * P.smoothstep(0.72, 0.9, chips.id[idx]);
      if (chipMask > 0.02) {
        d.dh -= 0.01 * chipMask;
        d.tr *= 1 - 0.35 * chipMask;
        d.tg *= 1 - 0.34 * chipMask;
        d.tb *= 1 - 0.32 * chipMask;
        d.rough += 0.08 * chipMask;
        d.ao *= 1 - 0.35 * chipMask;
      }
      if (worn) {
        // Traffic polish in the wheel paths and rust bleeding out of the cracks.
        const polish = P.smoothstep(0.55, 0.85, sampleField(streaks, u, v));
        d.rough -= 0.2 * polish;
        d.tr *= 1 - 0.1 * polish;
        d.tg *= 1 - 0.1 * polish;
        d.tb *= 1 - 0.1 * polish;
        const bleed = P.smoothstep(0.72, 0.92, sampleField(blotch, u, v));
        if (bleed > 0.02) {
          d.ar += rustBleed.r * 0.4 * bleed;
          d.ag += rustBleed.g * 0.4 * bleed;
          d.ab += rustBleed.b * 0.4 * bleed;
          d.metal += 0.1 * bleed;
        }
      }
    },
  };
}

export const concrete: SurfaceSpec = {
  key: 'concrete',
  worldScale: 6,
  base: { color: 0xa8a49b, color2: 0x8d8981, rough: 0.9, metal: 0 },
  cavityRadius: 0.014,
  build: (b) => concreteRecipe(b, false),
};

export const concreteWorn: SurfaceSpec = {
  key: 'concreteWorn',
  worldScale: 6,
  base: { color: 0x94908a, color2: 0x7a766f, rough: 0.87, metal: 0 },
  cavityRadius: 0.016,
  build: (b) => concreteRecipe(b, true),
};

/* ----------------------------------------------------------------- pavement */

/**
 * Pavement, in the two shapes the editor lays down: single square slabs (`paveTiles`) and a
 * line-up of long slabs (`paveStrip`, laid along the road or apron it surfaces).
 *
 * A paving slab is a *real* object with a real size, so these are authored as arrays rather than
 * as noise: 1 m squares on a 4 m repeat, and 2.5 x 1.25 m slabs on a 5 m repeat. That is what
 * lets the joints line up with each other across neighbouring cells — noise-based paving reads
 * as mottled concrete, which is exactly what the existing `concrete`/`concreteWorn` pair already
 * covers. `strip` swaps the axes so the strip runs along one direction only; the map stores which
 * direction a paved cell was laid in, and the shader swaps its UVs rather than rotating them
 * (a rotated lookup would break the mip derivatives and alias at distance).
 */
function paveRecipe(b: BakeContext, strip: boolean): Recipe {
  const seed = b.seed;
  const stains = noiseField({ seed, freq: 5, res: b.res, octaves: 4 });
  const blotch = noiseField({ seed: seed ^ 0x15, freq: 12, res: b.res, octaves: 3 });
  const grit = cellularField({ seed: seed ^ 0x36, cells: 64, res: b.res, jitter: 1, tag: 'grit' });
  const weeds = cellularField({ seed: seed ^ 0x57, cells: 8, res: b.res, jitter: 1, density: 0.35, tag: 'weeds' });
  const chalk = hexToLinear(0xcac4b6);
  const grime = hexToLinear(0x55524b);
  const moss = hexToLinear(0x4c5a34);
  // 4 m / 4 = 1 m slabs; a strip is 3.2 m / 4 = 80 cm across and / 2 = 1.6 m along, i.e. a road
  // course of small setts rather than the 2.5 m flags it started as — from the game camera those
  // read as a wide grey band with a line down it, which is what "the pavement is too wide" meant.
  const ALONG = strip ? 2 : 4;
  const ACROSS = strip ? 4 : 4;
  // Joint width as a fraction of a cell: thin setts need thin joints, or the joints become the
  // texture.
  const JOINT = strip ? 0.012 : 0.022;
  return {
    coarse(u, v, o) {
      const ci = P.cellOf(u, ALONG);
      const cj = P.cellOf(v, ACROSS);
      const h = hash2f(ci, cj, seed);
      // Each slab is cast on its own, so tone and level both drift slab to slab. A few are
      // darker still — replaced, patched or just dirtier — which is what stops a run of paving
      // reading as one printed sheet.
      const patchy = P.smoothstep(0.78, 0.95, hash2f(ci + 7, cj - 3, seed ^ 0x9a));
      P.tint(o, 0.84 + 0.3 * h - 0.22 * patchy);
      o.h = 0.007 * (h - 0.5) - 0.004 * patchy + 0.01 * (sampleField(blotch, u, v) - 0.5);
      const ju = P.seam(P.cellPos(u, ALONG), JOINT);
      const jv = P.seam(P.cellPos(v, ACROSS), JOINT);
      const joint = Math.max(ju, jv);
      o.h -= 0.02 * joint;
      P.tint(o, 1 - 0.4 * joint);
      o.rough += 0.07 * joint;
      o.ao = 1 - 0.4 * joint;
      // Efflorescence, then traffic grime, then weeds in the joint: the three things that age
      // paving, in the order they arrive.
      P.mixTo(o, chalk, 0.32 * P.smoothstep(0.55, 0.88, sampleField(stains, u, v)));
      const dirty = strip ? stretchU(stains, u, v, 10) : sampleField(stains, u, v);
      P.mixTo(o, grime, 0.26 * P.smoothstep(0.5, 0.85, dirty) * (0.4 + 0.6 * joint));
      const wi = P.texel(u, weeds.res);
      const wj = P.texel(v, weeds.res);
      const wIdx = wj * weeds.res + wi;
      const weed = P.smoothstep(0.2, 0.06, weeds.f1[wIdx]) * joint;
      if (weed > 0.02) {
        P.mixTo(o, moss, 0.7 * weed);
        o.h += 0.008 * weed;
      }
      // Wheel tracks: a strip is surfaced to be driven on, so it polishes down the middle.
      {
        // Wheel tracks: whatever this is, it is driven on, and the polish follows the same two
        // lines on both pavement shapes.
        const across = strip ? P.cellPos(v, ACROSS) : P.cellPos(v, ALONG);
        const track = Math.max(
          P.smoothstep(0.17, 0.05, Math.abs(across - 0.3)),
          P.smoothstep(0.17, 0.05, Math.abs(across - 0.7)),
        );
        P.tint(o, 1 - 0.09 * track);
        o.rough -= 0.12 * track;
        P.mixTo(o, grime, 0.14 * track);
      }
      o.aux = joint;
    },
    detail(u, v, d) {
      const x = P.texel(u, b.size);
      const y = P.texel(v, b.size);
      const joint = auxAt(b, u, v);
      const g = white(x, y, seed) - 0.5;
      const g2 = white(x, y, seed ^ 0x6d);
      // Chamfer: the arris beside a joint catches the light, the joint itself stays in shadow.
      // Without the bright line the paving reads as tiles drawn on flat ground.
      const chamfer = P.smoothstep(0.02, 0.07, joint) * (1 - P.smoothstep(0.07, 0.1, joint));
      d.dh += 0.002 * g - 0.006 * P.smoothstep(0.6, 0.95, joint) + 0.0015 * chamfer;
      d.ar += 0.05 * chamfer;
      d.ag += 0.05 * chamfer;
      d.ab += 0.045 * chamfer;
      d.tr *= 1 + 0.08 * g - 0.05 * P.smoothstep(0.8, 0.98, g2);
      d.tg *= 1 + 0.08 * g - 0.05 * P.smoothstep(0.8, 0.98, g2);
      d.tb *= 1 + 0.075 * g - 0.05 * P.smoothstep(0.8, 0.98, g2);
      d.rough += 0.05 * g;
      // Grit and broken arrises collecting in the joint.
      const gi = P.texel(u, grit.res);
      const gj = P.texel(v, grit.res);
      const gIdx = gj * grit.res + gi;
      const bit = P.smoothstep(0.14, 0.04, grit.f1[gIdx]) * P.smoothstep(0.5, 0.8, grit.id[gIdx]);
      if (bit > 0.02 && joint > 0.05) {
        d.dh += 0.003 * bit;
        d.ar += 0.1 * bit;
        d.ag += 0.1 * bit;
        d.ab += 0.09 * bit;
        d.rough += 0.06 * bit;
      }
      // Hairline cracks wandering out of the joints, which is where paving actually fails.
      const cr = sampleField(blotch, u * 2, v * 2);
      const crack = P.smoothstep(0.9, 0.97, cr) * P.smoothstep(0.02, 0.12, joint);
      if (crack > 0.02) {
        d.dh -= 0.004 * crack;
        d.tr *= 1 - 0.4 * crack;
        d.tg *= 1 - 0.4 * crack;
        d.tb *= 1 - 0.38 * crack;
      }
    },
  };
}

export const paveTiles: SurfaceSpec = {
  key: 'paveTiles',
  worldScale: 4,
  base: { color: 0xa9a49a, color2: 0x8b867c, rough: 0.88, metal: 0 },
  cavityRadius: 0.012,
  build: (b) => paveRecipe(b, false),
};

export const paveStrip: SurfaceSpec = {
  key: 'paveStrip',
  worldScale: 3.2,
  base: { color: 0x9e9a90, color2: 0x817d74, rough: 0.85, metal: 0 },
  cavityRadius: 0.012,
  build: (b) => paveRecipe(b, true),
};
