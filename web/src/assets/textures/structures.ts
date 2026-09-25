/**
 * Structure surfaces: the man-made materials (sheet metal, rust, fabric, timber,
 * glass, sacks, rubber, painted markings).
 *
 * These share a trick that makes them read as objects rather than as noise: a *layout*
 * (panel grid, plank, bag, tread pitch) is evaluated per texel and drives relief, tone,
 * seams and hardware at once. The layout maths is integer-periodic, so it tiles exactly.
 */
import { hexToLinear } from './canvas';
import { cellularField, noiseField, sampleField, stretchU, stretchV } from './noise';
import * as P from './patterns';
import { hash2f, white } from './rng';
import { CH, samplePlane, type BakeContext, type Recipe, type SurfaceSpec } from './field';

function auxAt(b: BakeContext, u: number, v: number): number {
  return samplePlane(b.ch[CH.AUX], b.res, u, v);
}

/* ---------------------------------------------------------------- sheet metal */

/**
 * Riveted sheet-metal skeleton shared by the bare and painted variants: 0.5 m panels
 * over a 2 m tile, rivets every 10 cm along every seam, each panel oil-canned slightly.
 */
function plateRecipe(b: BakeContext, painted: boolean): Recipe {
  const seed = b.seed;
  const spangle = noiseField({ seed, freq: 8, res: b.half, octaves: 3 });
  const broad = noiseField({ seed: seed ^ 0x15, freq: 4, res: b.res, octaves: 3 });
  const grime = noiseField({ seed: seed ^ 0x27, freq: 6, res: b.res, octaves: 3 });
  const chips = noiseField({ seed: seed ^ 0x39, freq: 30, res: b.half, octaves: 3, kind: 'turbulence' });
  const primer = hexToLinear(painted ? 0x8a7a3c : 0x6f6a5e);
  const bare = hexToLinear(0xc2c6c7);
  const rustTint = hexToLinear(0x7d4626);
  const grimeCol = hexToLinear(0x53514a);
  const PANELS = 4;
  const RIVET_PITCH = 20; // 2 m / 20 = 10 cm
  return {
    coarse(u, v, o) {
      const pi = P.cellOf(u, PANELS);
      const pj = P.cellOf(v, PANELS);
      const h = hash2f(pi, pj, seed);
      const fu = P.cellPos(u, PANELS);
      const fv = P.cellPos(v, PANELS);
      // Oil-canning: pressed panels bulge between their fixings.
      o.h = 0.004 * (h - 0.5) + 0.0035 * Math.sin(fu * Math.PI) * Math.sin(fv * Math.PI);
      const seamMask = Math.max(P.seam(fu, 0.05), P.seam(fv, 0.05));
      o.h -= 0.003 * seamMask;
      P.tint(o, 0.96 + 0.09 * h);
      o.rough = painted ? 0.6 + 0.12 * h : 0.42 + 0.16 * h;
      o.metal = painted ? 0.18 : 0.85;
      // Grime collects in the panel gaps and streaks down the sheets.
      const streak = stretchU(grime, u, v, 8);
      P.mixTo(o, grimeCol, 0.28 * P.smoothstep(0.5, 0.85, streak) + 0.2 * seamMask);
      o.rough = P.mix(o.rough, 0.9, 0.4 * P.smoothstep(0.5, 0.85, streak));
      o.ao = 1 - 0.3 * seamMask - 0.08 * (1 - P.smoothstep(0.3, 0.7, sampleField(broad, u, v)));
      o.aux = seamMask;
    },
    detail(u, v, d) {
      const x = P.texel(u, b.size);
      const y = P.texel(v, b.size);
      const fu = P.cellPos(u, PANELS);
      const fv = P.cellPos(v, PANELS);
      // Recomputed rather than sampled from the coarse plane: chipping follows a
      // 3 cm seam, and bilinear upsampling would soften that boundary by 4 texels.
      const seamMask = Math.max(P.seam(fu, 0.05), P.seam(fv, 0.05));
      const g = white(x, y, seed) - 0.5;
      // Galvanised spangle / rolled-in grain, stretched along the rolling direction.
      const sp = stretchV(spangle, u, v, 6) - 0.5;
      d.dh += 0.0009 * g + 0.0006 * sp;
      d.tr *= 1 + 0.05 * sp + 0.03 * g;
      d.tg *= 1 + 0.05 * sp + 0.03 * g;
      d.tb *= 1 + 0.052 * sp + 0.03 * g;
      d.rough += 0.06 * sp + 0.03 * g;
      // Rivets: a dome with a dark base ring, one row either side of every seam.
      const du = (P.cellPos(u, RIVET_PITCH) - 0.5) * (b.worldScale / RIVET_PITCH);
      const panelMetres = b.worldScale / PANELS;
      const dv = Math.min(fv, 1 - fv) * panelMetres;
      const rowDist = Math.abs(dv - 0.024);
      if (rowDist < 0.02 && Math.abs(du) < 0.02) {
        const rr = Math.sqrt(du * du + rowDist * rowDist) / 0.014;
        if (rr < 1) {
          const dome = Math.sqrt(Math.max(0, 1 - rr * rr));
          d.dh += 0.005 * dome;
          const base = 1 - P.smoothstep(0.55, 1, rr);
          d.tr *= 1 - 0.3 * (1 - base);
          d.tg *= 1 - 0.3 * (1 - base);
          d.tb *= 1 - 0.3 * (1 - base);
          d.ao *= 1 - 0.25 * (1 - base);
          d.rough -= 0.08 * dome;
        }
      }
      // Chipping: paint fails first along the seams, showing primer then bare steel.
      const cf = sampleField(chips, u, v);
      const chipZone = P.smoothstep(0.35, 0.75, seamMask) + 0.25 * P.smoothstep(0.6, 0.85, cf);
      const chip = P.clamp01(chipZone) * P.smoothstep(0.45, 0.62, cf + 0.35 * (g + 0.5));
      if (chip > 0.02) {
        const deep = P.smoothstep(0.4, 0.75, cf);
        const c = deep > 0.5 ? bare : primer;
        d.tr = d.tr * (1 - 0.7 * chip) + c.r * 0.7 * chip;
        d.tg = d.tg * (1 - 0.7 * chip) + c.g * 0.7 * chip;
        d.tb = d.tb * (1 - 0.7 * chip) + c.b * 0.7 * chip;
        d.metal += (deep > 0.5 ? 0.75 : -0.1) * chip;
        d.rough += (deep > 0.5 ? -0.25 : 0.15) * chip;
        d.dh -= 0.0008 * chip;
      }
      // Rust blooms out of the crevices it can reach.
      const bloom = P.smoothstep(0.7, 0.92, sampleField(broad, u, v)) * seamMask;
      if (bloom > 0.02) {
        d.tr = d.tr * (1 - 0.5 * bloom) + rustTint.r * 0.5 * bloom;
        d.tg = d.tg * (1 - 0.5 * bloom) + rustTint.g * 0.5 * bloom;
        d.tb = d.tb * (1 - 0.5 * bloom) + rustTint.b * 0.5 * bloom;
        d.rough += 0.25 * bloom;
        d.metal -= 0.4 * bloom;
      }
    },
  };
}

export const metalPanel: SurfaceSpec = {
  key: 'metalPanel',
  worldScale: 2,
  base: { color: 0x9ba0a0, color2: 0x7c8285, rough: 0.45, metal: 0.85 },
  cavityRadius: 0.006,
  build: (b) => plateRecipe(b, false),
};

export const metalPainted: SurfaceSpec = {
  key: 'metalPainted',
  worldScale: 2,
  base: { color: 0x5d6a4a, color2: 0x49543a, rough: 0.62, metal: 0.18 },
  cavityRadius: 0.006,
  build: (b) => plateRecipe(b, true),
};

/* ---------------------------------------------------------------- dark metal */

export const metalDark: SurfaceSpec = {
  key: 'metalDark',
  worldScale: 2,
  base: { color: 0x4b5157, color2: 0x343a3f, rough: 0.42, metal: 0.88 },
  cavityRadius: 0.004,
  build(b): Recipe {
    const seed = b.seed;
    const brush = noiseField({ seed, freq: 12, res: b.half, octaves: 3 });
    const brushFine = noiseField({ seed: seed ^ 0x12, freq: 40, res: b.half, octaves: 2 });
    const smudge = noiseField({ seed: seed ^ 0x24, freq: 5, res: b.res, octaves: 3 });
    const rustTint = hexToLinear(0x6d4326);
    const SCREWS = 8; // 2 m / 8 = 25 cm fixing pitch
    return {
      coarse(u, v, o) {
        const br = sampleField(brush, u, v);
        const sm = sampleField(smudge, u, v);
        P.tint(o, 0.9 + 0.16 * sm);
        // Brushed finish: roughness swings along the grain, which is what makes
        // anisotropic metal shimmer as the camera moves.
        o.rough = 0.32 + 0.22 * br + 0.1 * sm;
        o.h = 0.0012 * (br - 0.5);
        // A single plate joint, with a shallow step.
        const joint = P.seam(P.cellPos(v, 2), 0.02);
        o.h -= 0.0025 * joint;
        P.tint(o, 1 - 0.25 * joint);
        o.rough += 0.15 * joint;
        o.ao = 1 - 0.25 * joint;
        o.aux = joint;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        // Brush lines: the field is repeated 24x across U, so features stay long in V.
        const bf = stretchU(brushFine, u, v, 24) - 0.5;
        const bf2 = stretchU(brush, u, v, 4) - 0.5;
        const g = white(x, y, seed) - 0.5;
        d.dh += 0.0004 * bf + 0.0003 * g;
        d.tr *= 1 + 0.06 * bf + 0.04 * bf2;
        d.tg *= 1 + 0.06 * bf + 0.04 * bf2;
        d.tb *= 1 + 0.062 * bf + 0.04 * bf2;
        d.rough += 0.1 * bf + 0.05 * bf2 + 0.03 * g;
        // Socket-head screws on a square grid, each with an oil weep below it.
        const su = P.cellPos(u, SCREWS);
        const sv = P.cellPos(v, SCREWS);
        const px = (su - 0.5) * (b.worldScale / SCREWS);
        const py = (sv - 0.5) * (b.worldScale / SCREWS);
        const head = P.discMask(px, py, 0.012, 0.004);
        if (head > 0.02) {
          d.dh += 0.002 * head;
          d.tr *= 1 - 0.2 * head;
          d.tg *= 1 - 0.2 * head;
          d.tb *= 1 - 0.2 * head;
          const slot = P.boxMask(px, py, 0.007, 0.0018, 0.001);
          d.dh -= 0.004 * slot * head;
          d.tr *= 1 - 0.6 * slot * head;
          d.ao *= 1 - 0.4 * slot * head;
        }
        // Scuffs: shallow bright arcs where kit has been dragged across the plate.
        const scuff = P.smoothstep(0.72, 0.9, sampleField(brush, u, v)) * Math.abs(bf2);
        if (scuff > 0.05) {
          d.tr *= 1 + 0.35 * scuff;
          d.tg *= 1 + 0.35 * scuff;
          d.tb *= 1 + 0.34 * scuff;
          d.rough -= 0.15 * scuff;
        }
        const joint = auxAt(b, u, v);
        const rust = P.smoothstep(0.55, 0.85, sampleField(smudge, u, v)) * joint;
        if (rust > 0.02) {
          d.tr = d.tr * (1 - 0.5 * rust) + rustTint.r * 0.5 * rust;
          d.tg = d.tg * (1 - 0.5 * rust) + rustTint.g * 0.5 * rust;
          d.tb = d.tb * (1 - 0.5 * rust) + rustTint.b * 0.5 * rust;
          d.rough += 0.3 * rust;
          d.metal -= 0.5 * rust;
        }
      },
    };
  },
};

/* ---------------------------------------------------------------------- rust */

export const rust: SurfaceSpec = {
  key: 'rust',
  worldScale: 2,
  base: { color: 0x5e3a20, color2: 0x3f4245, rough: 0.95, metal: 0.15 },
  cavityRadius: 0.02,
  build(b): Recipe {
    const seed = b.seed;
    // 2 m / 56 = 3.6 cm blisters: the scale at which rust actually flakes off steel.
    const blisters = cellularField({ seed, cells: 56, res: b.half, jitter: 0.9, tag: 'blister' });
    const crust = noiseField({ seed: seed ^ 0x14, freq: 16, res: b.res, octaves: 3, kind: 'turbulence' });
    const patches = noiseField({ seed: seed ^ 0x26, freq: 4, res: b.res, octaves: 4 });
    const pits = noiseField({ seed: seed ^ 0x38, freq: 60, res: b.half, octaves: 2, kind: 'turbulence' });
    const steel = hexToLinear(0x53575a);
    const fresh = hexToLinear(0xa8551f);
    const deep = hexToLinear(0x341a0d);
    return {
      coarse(u, v, o) {
        const pm = sampleField(patches, u, v);
        // Where the paint/oxide layer still holds, bare steel survives; elsewhere the
        // whole surface has converted to scale.
        const steelMask = P.smoothstep(0.58, 0.8, pm);
        P.mixTo(o, steel, 0.9 * steelMask);
        P.tint(o, 0.82 + 0.36 * sampleField(crust, u, v));
        P.mixTo(o, deep, 0.4 * P.smoothstep(0.4, 0.1, pm));
        o.rough = P.mix(0.97, 0.6, steelMask);
        o.metal = P.mix(0.05, 0.75, steelMask);
        o.h = 0.004 * (pm - 0.5);
        o.ao = 1 - 0.15 * (1 - steelMask);
        o.aux = steelMask;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const steelMask = auxAt(b, u, v);
        const bi = P.texel(u, blisters.res);
        const bj = P.texel(v, blisters.res);
        const idx = bj * blisters.res + bi;
        const cellId = blisters.id[idx];
        const f1 = blisters.f1[idx];
        const gap = blisters.f2[idx] - blisters.f1[idx];
        const g = white(x, y, seed) - 0.5;
        // Blistered scale: domes that lift off, with flaking edges between them.
        const dome = P.smoothstep(1.05, 0.35, f1);
        const flake = 1 - P.smoothstep(0, 0.06, gap);
        d.dh += 0.006 * dome - 0.005 * flake + 0.0015 * g;
        // Fresh orange on the newly exposed blister, dark crust in the hollows.
        const tone = P.smoothstep(0.3, 0.75, cellId);
        d.tr *= 0.7 + 0.6 * tone - 0.2 * flake;
        d.tg *= 0.72 + 0.5 * tone - 0.25 * flake;
        d.tb *= 0.7 + 0.45 * tone - 0.25 * flake;
        if (tone > 0.72) {
          const hot = (tone - 0.72) * 3.5;
          d.ar += fresh.r * 0.35 * hot;
          d.ag += fresh.g * 0.35 * hot;
          d.ab += fresh.b * 0.35 * hot;
        }
        if (flake > 0.05) {
          // Underneath a flake the steel is still bright and conductive.
          d.tr = d.tr * (1 - 0.5 * flake) + steel.r * 0.5 * flake;
          d.tg = d.tg * (1 - 0.5 * flake) + steel.g * 0.5 * flake;
          d.tb = d.tb * (1 - 0.5 * flake) + steel.b * 0.5 * flake;
          d.metal += 0.6 * flake * (1 - steelMask);
          d.rough -= 0.3 * flake * (1 - steelMask);
          d.ao *= 1 - 0.5 * flake;
        }
        // Pitting: the metal under the scale has been eaten away.
        const pit = P.smoothstep(0.7, 0.9, sampleField(pits, u, v));
        d.dh -= 0.003 * pit;
        d.tr *= 1 - 0.3 * pit;
        d.tg *= 1 - 0.3 * pit;
        d.tb *= 1 - 0.28 * pit;
        d.ao *= 1 - 0.3 * pit;
        d.rough += 0.05 * g;
      },
    };
  },
};

/* --------------------------------------------------------------- canvas tent */

export const canvasTent: SurfaceSpec = {
  key: 'canvasTent',
  worldScale: 1.2,
  base: { color: 0x8b8262, color2: 0x6d6549, rough: 0.95, metal: 0 },
  cavityRadius: 0.0012,
  build(b): Recipe {
    const seed = b.seed;
    const slub = noiseField({ seed, freq: 24, res: b.half, octaves: 2 });
    const stain = noiseField({ seed: seed ^ 0x16, freq: 5, res: b.res, octaves: 3 });
    const mildew = noiseField({ seed: seed ^ 0x28, freq: 20, res: b.half, octaves: 3, kind: 'turbulence' });
    const dirt = hexToLinear(0x6a6046);
    const brass = hexToLinear(0xb08b3c);
    // 1.2 m / 170 = 7 mm thread: coarse canvas weave, 3 px per thread at 512.
    const THREADS = 170;
    const STITCH_PITCH = 150; // 8 mm stitches along the seam
    return {
      coarse(u, v, o) {
        const st = sampleField(stain, u, v);
        P.tint(o, 0.88 + 0.24 * st);
        // Sun-bleached panels fade towards the top of the tile, dirt climbs the bottom.
        const bleach = 0.08 * P.smoothstep(0.7, 0.1, v);
        P.tint(o, 1 + bleach);
        P.mixTo(o, dirt, 0.3 * P.smoothstep(0.55, 0.9, st) + 0.25 * P.smoothstep(0.6, 1, v));
        o.rough = 0.9 + 0.08 * st;
        o.h = 0.0006 * (st - 0.5);
        // Flat-felled seam across the middle of the tile: double thickness of cloth.
        const seamMask = P.band(v - 0.5, 0.014);
        o.h += 0.0016 * seamMask;
        P.tint(o, 1 - 0.12 * seamMask);
        o.ao = 1 - 0.18 * seamMask;
        o.aux = seamMask;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const tu = P.cellPos(u, THREADS);
        const tv = P.cellPos(v, THREADS);
        const ti = P.cellOf(u, THREADS);
        const tj = P.cellOf(v, THREADS);
        const sl = sampleField(slub, u, v);
        // Plain weave: the over-thread rides high, the under-thread is crushed flat.
        const over = P.weaveOver(ti, tj);
        const warpProfile = P.threadProfile(P.clamp01(tu + (sl - 0.5) * 0.25));
        const weftProfile = P.threadProfile(P.clamp01(tv + (sl - 0.5) * 0.25));
        const top = over === 1 ? warpProfile : weftProfile;
        const thread = 1 - Math.min(warpProfile, weftProfile);
        d.dh += 0.00055 * (0.4 + 0.6 * top) - 0.00045 * (1 - thread) + 0.00004 * (white(x, y, seed) - 0.5);
        // Thread crowns catch the sun; the gaps between them stay in shadow.
        const shade = 1 + 0.22 * top - 0.18 * (1 - thread);
        d.tr *= shade;
        d.tg *= shade * (1 - 0.01 * (1 - thread));
        d.tb *= shade * (1 - 0.03 * (1 - thread));
        d.rough += 0.05 * (1 - thread);
        // Mildew and dust in the weave.
        const md = P.smoothstep(0.7, 0.9, sampleField(mildew, u, v));
        if (md > 0.03) {
          d.tr *= 1 - 0.3 * md;
          d.tg *= 1 - 0.28 * md;
          d.tb *= 1 - 0.3 * md;
        }
        // Stitching: two dashed rows of heavy thread either side of the seam.
        const seamy = Math.abs(v - 0.5);
        if (seamy < 0.03) {
          const rowMask = P.band(seamy - 0.011, 0.0018);
          const dash = P.band(P.fract(u * STITCH_PITCH) - 0.5, 0.34);
          const stitch = rowMask * dash;
          if (stitch > 0.02) {
            d.dh += 0.0009 * stitch;
            d.tr *= 1 - 0.22 * stitch;
            d.tg *= 1 - 0.22 * stitch;
            d.tb *= 1 - 0.24 * stitch;
            d.rough += 0.03 * stitch;
          }
        }
        // Rope grommets, brass, every 60 cm along the seam.
        if (seamy < 0.045) {
          for (let k = 0; k < 2; k++) {
            const gu = u - (0.25 + k * 0.5);
            const gv = v - 0.5;
            const ring = P.ringMask(gu, gv, 0.013, 0.007, 0.0015);
            const hole = P.discMask(gu, gv, 0.008, 0.0015);
            if (ring > 0.02) {
              d.dh += 0.0012 * ring;
              d.tr = d.tr * (1 - 0.8 * ring) + brass.r * 0.8 * ring;
              d.tg = d.tg * (1 - 0.8 * ring) + brass.g * 0.8 * ring;
              d.tb = d.tb * (1 - 0.8 * ring) + brass.b * 0.8 * ring;
              d.metal += 0.7 * ring;
              d.rough -= 0.5 * ring;
            }
            if (hole > 0.02) {
              d.dh -= 0.0016 * hole;
              d.tr *= 1 - 0.85 * hole;
              d.tg *= 1 - 0.85 * hole;
              d.tb *= 1 - 0.85 * hole;
              d.ao *= 1 - 0.6 * hole;
            }
          }
        }
      },
    };
  },
};

/* ---------------------------------------------------------------------- wood */

export const wood: SurfaceSpec = {
  key: 'wood',
  worldScale: 2,
  base: { color: 0x8a6740, color2: 0x5f452a, rough: 0.78, metal: 0 },
  cavityRadius: 0.008,
  build(b): Recipe {
    const seed = b.seed;
    const warp = noiseField({ seed, freq: 6, res: b.half, octaves: 3 });
    const pores = noiseField({ seed: seed ^ 0x18, freq: 30, res: b.half, octaves: 2, kind: 'turbulence' });
    const weather = noiseField({ seed: seed ^ 0x2a, freq: 4, res: b.res, octaves: 4 });
    const dark = hexToLinear(0x5a3f24);
    const pale = hexToLinear(0xb08a58);
    const nail = hexToLinear(0x4a4744);
    const PLANK_H = 1 / 12; // 12 boards across 2 m: 16.7 cm boards
    const PLANKS = 12;
    const RINGS = 6; // ~28 mm growth rings: readable at 3.9 mm/texel
    return {
      coarse(u, v, o) {
        const pj = P.cellOf(v, PLANKS);
        const fv = P.cellPos(v, PLANKS);
        const ph = hash2f(pj, 7, seed);
        // Every board came off a different part of the log.
        P.tint(o, 0.72 + 0.55 * ph);
        P.mixTo(o, ph > 0.6 ? pale : dark, 0.3 * Math.abs(ph - 0.5) * 2);
        const w = sampleField(weather, u, v);
        P.tint(o, 0.85 + 0.3 * w);
        P.mixTo(o, pale, 0.3 * P.smoothstep(0.65, 0.95, w));
        o.rough = 0.68 + 0.24 * (1 - P.smoothstep(0.4, 0.8, w));
        o.h = 0.002 * (ph - 0.5) + 0.0016 * Math.sin(u * 6.28318) * 0.5;
        // Gap between boards: deep, dark, and the reason a crate reads as boards.
        const gap = P.seam(fv, 0.06);
        o.h -= 0.0022 * gap;
        P.tint(o, 1 - 0.5 * gap);
        o.ao = 1 - 0.45 * gap;
        o.aux = gap;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const pj = P.cellOf(v, PLANKS);
        const fv = P.cellPos(v, PLANKS);
        const ph = hash2f(pj, 7, seed);
        const gap = auxAt(b, u, v);
        // Growth rings: warped banding inside each board, phase-shifted per board.
        const w = sampleField(warp, u, v);
        // Knots pull the grain around them.
        const knotU = hash2f(pj, 11, seed);
        const knotV = 0.25 + 0.5 * hash2f(pj, 13, seed);
        const kdx = (u - knotU) * 2;
        const kdy = (fv - knotV) * PLANK_H * 12;
        // Cheap box rejection first: the knot only affects a small neighbourhood.
        const kd = Math.abs(kdx) < 0.2 && Math.abs(kdy) < 0.2 ? Math.sqrt(kdx * kdx + kdy * kdy) : 1;
        const knotPull = Math.exp(-kd * 9);
        const rc = fv * RINGS + 0.35 * (w - 0.5) + ph * 3 + 0.55 * knotPull;
        const late = P.smoothstep(0.55, 0.92, P.fract(rc));
        const g = white(x, y, seed) - 0.5;
        const pore = stretchV(pores, u, v, 22) - 0.5;
        d.dh += 0.0008 * g + 0.0006 * pore - 0.0006 * late;
        const grainShade = 1 - 0.16 * late + 0.1 * pore;
        d.tr *= grainShade;
        d.tg *= grainShade * (1 - 0.02 * late);
        d.tb *= grainShade * (1 - 0.06 * late);
        if (kd < 0.12) {
          // The knot itself: tight rings around a resinous core.
          const rings = P.smoothstep(0.35, 0.75, P.fract(kd * 26));
          const core = P.smoothstep(0.05, 0.015, kd);
          const km = P.smoothstep(0.12, 0.05, kd);
          d.dh -= 0.0012 * km * rings;
          d.tr *= 1 - 0.5 * km * rings - 0.4 * core;
          d.tg *= 1 - 0.55 * km * rings - 0.45 * core;
          d.tb *= 1 - 0.6 * km * rings - 0.5 * core;
          d.rough += 0.1 * core;
        }
        // Saw marks: faint transverse chatter from the mill.
        const saw = P.band(P.fract(u * 90) - 0.5, 0.12) * P.smoothstep(0.4, 0.7, hash2f(pj, 3, seed));
        d.tr *= 1 - 0.05 * saw;
        d.tg *= 1 - 0.05 * saw;
        d.tb *= 1 - 0.05 * saw;
        d.dh -= 0.0002 * saw;
        // Nail heads near both ends of each board.
        {
          const dv = (fv - 0.5) * PLANK_H * b.worldScale;
          const dvNear = Math.abs(dv) < 0.008;
          for (let k = 0; k < 4 && dvNear; k++) {
            const nu = k < 2 ? 0.045 + k * 0.055 : 0.955 - (k - 2) * 0.055;
            const du = (u - nu) * b.worldScale;
            const head = P.discMask(du, dv, 0.0055, 0.0015);
            if (head > 0.02) {
              d.dh -= 0.0008 * head;
              d.tr = d.tr * (1 - 0.75 * head) + nail.r * 0.75 * head;
              d.tg = d.tg * (1 - 0.75 * head) + nail.g * 0.75 * head;
              d.tb = d.tb * (1 - 0.75 * head) + nail.b * 0.75 * head;
              d.metal += 0.5 * head;
              d.rough -= 0.2 * head;
              d.ao *= 1 - 0.2 * head;
            }
          }
        }
        // Board edges are rounded by handling: brighten the arris.
        const arris = P.seam(fv, 0.1) * 0.7;
        d.tr *= 1 + 0.1 * arris;
        d.tg *= 1 + 0.1 * arris;
        d.tb *= 1 + 0.08 * arris;
        d.tr *= 1 - 0.3 * gap;
        d.tg *= 1 - 0.3 * gap;
        d.tb *= 1 - 0.32 * gap;
      },
    };
  },
};

/* --------------------------------------------------------------------- glass */

export const glass: SurfaceSpec = {
  key: 'glass',
  worldScale: 2,
  base: { color: 0x21333c, color2: 0x141f26, rough: 0.06, metal: 0 },
  cavityRadius: 0,
  ao: false,
  relief: false,
  build(b): Recipe {
    const seed = b.seed;
    const waviness = noiseField({ seed, freq: 2, res: b.res, octaves: 3 });
    const dust = noiseField({ seed: seed ^ 0x1c, freq: 6, res: b.res, octaves: 3 });
    const streaks = noiseField({ seed: seed ^ 0x2e, freq: 10, res: b.res, octaves: 2 });
    const dustCol = hexToLinear(0x8d8b84);
    return {
      coarse(u, v, o) {
        const d = sampleField(dust, u, v);
        const w = sampleField(waviness, u, v);
        // Float glass is never optically flat; the waviness is what sells reflections.
        o.h = 0.00018 * (w - 0.5);
        o.rough = 0.035 + 0.02 * w + 0.3 * P.smoothstep(0.55, 0.9, d);
        P.mixTo(o, dustCol, 0.22 * P.smoothstep(0.6, 0.95, d));
        P.tint(o, 0.9 + 0.2 * w);
        o.aux = d;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const g = white(x, y, seed);
        // Cleaning streaks and the odd speck of grit.
        const st = P.smoothstep(0.6, 0.9, sampleField(streaks, u, v));
        d.rough += 0.05 * st;
        d.tr *= 1 - 0.06 * st;
        d.tg *= 1 - 0.06 * st;
        d.tb *= 1 - 0.05 * st;
        if (g > 0.9985) {
          d.ar += 0.25;
          d.ag += 0.24;
          d.ab += 0.22;
          d.rough += 0.5;
          d.dh += 0.0002;
        }
      },
    };
  },
};

/* ------------------------------------------------------------------ sandbag */

export const sandbag: SurfaceSpec = {
  key: 'sandbag',
  worldScale: 2,
  base: { color: 0xa3925f, color2: 0x7d6c44, rough: 0.96, metal: 0 },
  cavityRadius: 0.008,
  build(b): Recipe {
    const seed = b.seed;
    const weaveNoise = noiseField({ seed, freq: 30, res: b.half, octaves: 2 });
    const grime = noiseField({ seed: seed ^ 0x1a, freq: 5, res: b.res, octaves: 4 });
    const folds = noiseField({ seed: seed ^ 0x2c, freq: 14, res: b.half, octaves: 3, kind: 'turbulence' });
    const straw = noiseField({ seed: seed ^ 0x3e, freq: 40, res: b.half, octaves: 2 });
    const dirt = hexToLinear(0x5f5133);
    const pale = hexToLinear(0xc0ae7c);
    const strawCol = hexToLinear(0xd8c070);
    // 4 bags across x 8 rows over a 2 m tile, staggered like a real parapet.
    const BAGS_U = 4;
    const BAGS_V = 8;
    /** Bag silhouette: staggered rows of superellipse bags, crisp in both passes. */
    const bagAt = (u: number, v: number): number => {
      const row = P.cellOf(v, BAGS_V);
      const stagger = (row & 1) === 0 ? 0 : 0.5 / BAGS_U;
      const bu = P.fract(u * BAGS_U + stagger);
      const bv = P.cellPos(v, BAGS_V);
      const dx = Math.abs(bu * 2 - 1);
      const dy = Math.abs(bv * 2 - 1);
      // ^0.5 rather than ^0.45: the bag silhouette is indistinguishable and sqrt is free.
      return Math.sqrt(P.clamp01(1 - (dx * dx * dx + dy * dy * dy)));
    };
    return {
      coarse(u, v, o) {
        const row = P.cellOf(v, BAGS_V);
        const stagger = (row & 1) === 0 ? 0 : 0.5 / BAGS_U;
        const bh = hash2f(P.cellOf(u * BAGS_U + stagger, 1), row, seed);
        const bulge = bagAt(u, v);
        o.h = 0.055 * bulge - 0.02 * (1 - bulge);
        P.tint(o, 0.82 + 0.36 * bh);
        P.mixTo(o, pale, 0.25 * P.smoothstep(0.4, 0.8, sampleField(grime, u, v)));
        // Damp and dirt concentrate under each bag.
        P.mixTo(o, dirt, 0.4 * P.smoothstep(0.5, 0.95, 1 - bulge) + 0.25 * P.smoothstep(0.55, 0.95, sampleField(grime, u, v)));
        o.rough = 0.92 + 0.07 * (1 - bulge);
        o.ao = 0.55 + 0.45 * bulge;
        o.aux = bulge;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const bulge = bagAt(u, v);
        const row = P.cellOf(v, BAGS_V);
        const stagger = (row & 1) === 0 ? 0 : 0.5 / BAGS_U;
        const bu = P.fract(u * BAGS_U + stagger);
        const bv = P.cellPos(v, BAGS_V);
        const bh = hash2f(P.cellOf(u * BAGS_U + stagger, 1), row, seed);
        // Hessian weave. Two scales on purpose: a 2 px thread that mips into fabric
        // sheen, and a coarser 6 px rib that still reads as burlap from 40 m.
        const fineU = P.cellPos(u, 256);
        const fineV = P.cellPos(v, 256);
        const coarseU = P.cellPos(u, 85);
        const coarseV = P.cellPos(v, 85);
        const wob = (sampleField(weaveNoise, u, v) - 0.5) * 0.5;
        const th = P.threadProfile(P.clamp01(fineU + wob)) * P.threadProfile(P.clamp01(fineV + wob));
        const rib = Math.abs(2 * P.fract(coarseU + coarseV * 0.35) - 1);
        const weave = 0.65 * (1 - th) + 0.35 * rib * (1 - th);
        const g = white(x, y, seed) - 0.5;
        d.dh += 0.0016 * (weave - 0.5) + 0.0006 * g;
        const shade = 1 + 0.2 * (weave - 0.5) + 0.06 * g;
        d.tr *= shade;
        d.tg *= shade * (1 - 0.01 * weave);
        d.tb *= shade * (1 - 0.04 * weave);
        d.rough += 0.04 * weave;
        // Crumpled cloth: a few fold ridges across each bag.
        const fold = P.smoothstep(0.68, 0.9, sampleField(folds, u, v)) * bulge;
        if (fold > 0.03) {
          d.dh += 0.0025 * fold;
          d.tr *= 1 - 0.12 * fold;
          d.tg *= 1 - 0.12 * fold;
          d.tb *= 1 - 0.12 * fold;
        }
        // Torn corner: hessian splits and straw works its way out.
        if (bh > 0.86 && bu > 0.6 && bv > 0.55) {
          const tear = P.smoothstep(0.55, 0.85, sampleField(straw, u, v));
          if (tear > 0.25) {
            const s = white(x, y, seed ^ 0x5b);
            if (s > 0.35) {
              d.ar += strawCol.r * 0.5;
              d.ag += strawCol.g * 0.5;
              d.ab += strawCol.b * 0.4;
              d.rough += 0.04;
            }
            d.dh -= 0.002 * tear;
            d.tr *= 1 - 0.2 * tear;
          }
        }
      },
    };
  },
};

/* -------------------------------------------------------------------- rubber */

export const rubber: SurfaceSpec = {
  key: 'rubber',
  worldScale: 1.5,
  base: { color: 0x24262a, color2: 0x33363a, rough: 0.88, metal: 0 },
  cavityRadius: 0.004,
  build(b): Recipe {
    const seed = b.seed;
    const wear = noiseField({ seed, freq: 3, res: b.res, octaves: 3 });
    const grain = noiseField({ seed: seed ^ 0x1e, freq: 40, res: b.half, octaves: 2, kind: 'turbulence' });
    const cracks = noiseField({ seed: seed ^ 0x2f, freq: 24, res: b.half, octaves: 3, kind: 'turbulence', warp: 1.5 });
    const dust = hexToLinear(0x6b6558);
    const PITCH = 50; // 1.5 m / 50 = 3 cm tread pitch: heavy truck / track pad
    return {
      coarse(u, v, o) {
        const w = sampleField(wear, u, v);
        P.tint(o, 0.85 + 0.3 * w);
        o.rough = 0.86 + 0.1 * w;
        o.h = 0.0008 * (w - 0.5);
        o.aux = w;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const w = auxAt(b, u, v);
        // Block tread: rib grooves plus staggered lateral slots, worn in the middle.
        const rib = P.band(P.fract(u * PITCH) - 0.5, 0.18);
        const si = P.cellOf(v, PITCH);
        const stagger = (si & 1) === 0 ? 0 : 0.5;
        const slotRaw = P.fract(v * PITCH + stagger);
        const slot = P.band(slotRaw - 0.5, 0.13);
        const groove = P.clamp01(Math.max(rib, slot));
        const worn = P.smoothstep(0.4, 0.8, w);
        d.dh -= 0.005 * groove * (1 - 0.45 * worn) + 0.0004 * (white(x, y, seed) - 0.5);
        d.tr *= 1 - 0.35 * groove;
        d.tg *= 1 - 0.35 * groove;
        d.tb *= 1 - 0.33 * groove;
        d.rough += 0.06 * groove - 0.12 * worn;
        // Sipes: hairline cuts across each block.
        const sipe = P.band(P.fract(v * PITCH * 2) - 0.5, 0.035) * (1 - groove);
        d.dh -= 0.0012 * sipe;
        d.tr *= 1 - 0.3 * sipe;
        // Rubber grain and age cracks.
        const gr = sampleField(grain, u, v) - 0.5;
        d.dh += 0.0004 * gr;
        d.tr *= 1 + 0.1 * gr;
        d.tg *= 1 + 0.1 * gr;
        d.tb *= 1 + 0.1 * gr;
        const cf = sampleField(cracks, u, v);
        const crack = (1 - P.smoothstep(0, 0.05, Math.abs(2 * cf - 1))) * (0.4 + 0.6 * worn);
        if (crack > 0.02) {
          d.dh -= 0.002 * crack;
          d.tr *= 1 - 0.4 * crack;
          d.ao *= 1 - 0.3 * crack;
        }
        // Grit and dust packed into the grooves.
        const dustMask = P.smoothstep(0.55, 0.85, sampleField(grain, u, v)) * groove;
        if (dustMask > 0.05) {
          d.tr = d.tr * (1 - 0.5 * dustMask) + dust.r * 0.5 * dustMask;
          d.tg = d.tg * (1 - 0.5 * dustMask) + dust.g * 0.5 * dustMask;
          d.tb = d.tb * (1 - 0.5 * dustMask) + dust.b * 0.5 * dustMask;
          d.rough += 0.08 * dustMask;
        }
      },
    };
  },
};

/* ------------------------------------------------------------------ helipad */

export const helipad: SurfaceSpec = {
  key: 'helipad',
  worldScale: 8,
  // Markings are painted edges: they need more than 4 texels of resolution.
  coarseDiv: 2,
  base: { color: 0x8f8b83, color2: 0x76726b, rough: 0.9, metal: 0 },
  cavityRadius: 0.012,
  build(b): Recipe {
    const seed = b.seed;
    const stains = noiseField({ seed, freq: 4, res: b.res, octaves: 4 });
    const blotch = noiseField({ seed: seed ^ 0x1b, freq: 16, res: b.res, octaves: 3 });
    const cracks = noiseField({ seed: seed ^ 0x2d, freq: 9, res: b.half, octaves: 3, kind: 'turbulence', warp: 2 });
    const grime = noiseField({ seed: seed ^ 0x3f, freq: 12, res: b.half, octaves: 3 });
    const paint = hexToLinear(0xe6e2d6);
    const grimeCol = hexToLinear(0x55524b);
    // Marking geometry in metres, centred on the tile (8 m across).
    const H_BAR_X = 0.62;
    const H_BAR_HW = 0.22;
    const H_BAR_HH = 1.45;
    const H_CROSS_HH = 0.24;
    const RING_R = 2.75;
    const RING_T = 0.2;
    // Shared by both passes: the coarse pass paints it, the detail pass wears it down.
    const markAt = (u: number, v: number): number => {
      const px = (u - 0.5) * b.worldScale;
      const py = (v - 0.5) * b.worldScale;
      const barL = P.roundBoxMask(px + H_BAR_X, py, H_BAR_HW, H_BAR_HH, 0.03, 0.012);
      const barR = P.roundBoxMask(px - H_BAR_X, py, H_BAR_HW, H_BAR_HH, 0.03, 0.012);
      const cross = P.roundBoxMask(px, py, H_BAR_X, H_CROSS_HH, 0.03, 0.012);
      // The dashed ring needs an angle, so it is only evaluated inside its own annulus.
      const rr = P.len2(px, py);
      let dash = 0;
      if (Math.abs(rr - RING_R) < 0.3) {
        dash = 0.5 + 0.5 * Math.cos(Math.atan2(py, px) * 12);
      }
      const ring = P.ringMask(px, py, RING_R, RING_T, 0.01) * P.smoothstep(0.25, 0.6, dash);
      return P.clamp01(Math.max(Math.max(barL, barR), Math.max(cross, ring)));
    };
    return {
      coarse(u, v, o) {
        const st = sampleField(stains, u, v);
        P.tint(o, 0.88 + 0.2 * st);
        P.mixTo(o, grimeCol, 0.3 * P.smoothstep(0.5, 0.9, st));
        o.rough = 0.86 + 0.12 * st;
        o.h = 0.004 * (sampleField(blotch, u, v) - 0.5);
        // Painted markings, as a mask the detail pass refines with wear.
        const mark = markAt(u, v);
        P.mixTo(o, paint, 0.9 * mark);
        o.rough = P.mix(o.rough, 0.7, mark);
        o.h += 0.0016 * mark;
        o.aux = mark;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const g = white(x, y, seed) - 0.5;
        // The painted layout comes from the coarse channel (one sample instead of three
        // rounded-box distances), and the jittered threshold restores a crisp, chipped
        // paint edge - which is what worn stencil paint looks like anyway.
        const g2j = white(x, y, seed ^ 0x71) - 0.5;
        const markRaw = auxAt(b, u, v);
        const mark = P.smoothstep(0.34, 0.66, markRaw + 0.22 * g2j);
        const g2 = g2j + 0.5;
        d.dh += 0.002 * g;
        d.tr *= 1 + 0.09 * g;
        d.tg *= 1 + 0.09 * g;
        d.tb *= 1 + 0.085 * g;
        d.rough += 0.05 * g;
        // Paint wears through where tyres and boots pass: erosion, not a fade.
        const wear = P.smoothstep(0.45, 0.75, sampleField(grime, u, v)) + 0.3 * P.smoothstep(0.8, 0.95, g2);
        const alive = P.clamp01(mark - P.clamp01(wear) * 0.85);
        if (mark > 0.02 && alive < mark) {
          const lost = mark - alive;
          d.tr *= 1 - 0.25 * lost;
          d.tg *= 1 - 0.25 * lost;
          d.tb *= 1 - 0.24 * lost;
          d.rough += 0.1 * lost;
        }
        if (alive > 0.05) {
          d.dh += 0.0012 * alive;
          d.rough -= 0.06 * alive;
        }
        // Tyre scuffs arc around the pad.
        const px = (u - 0.5) * b.worldScale;
        const py = (v - 0.5) * b.worldScale;
        const r = P.len2(px, py);
        const scuff = P.band(r - 3.35, 0.16) * P.smoothstep(0.35, 0.7, sampleField(grime, u, v));
        if (scuff > 0.02) {
          d.tr *= 1 - 0.4 * scuff;
          d.tg *= 1 - 0.4 * scuff;
          d.tb *= 1 - 0.38 * scuff;
          d.rough -= 0.15 * scuff;
        }
        // A faded pad number by the edge: stencilled, then half worn away.
        const num = P.textMask('07', u, v, 0.06, 0.3, 0.05, 0.16);
        const numAlive = num * (1 - P.smoothstep(0.3, 0.8, sampleField(grime, u, v) * 0.5 + 0.5 * (g2 + 0.5)));
        if (numAlive > 0.05) {
          d.tr = d.tr * (1 - 0.5 * numAlive) + paint.r * 0.5 * numAlive;
          d.tg = d.tg * (1 - 0.5 * numAlive) + paint.g * 0.5 * numAlive;
          d.tb = d.tb * (1 - 0.5 * numAlive) + paint.b * 0.5 * numAlive;
          d.rough -= 0.05 * numAlive;
        }
        // Cracks run through everything, paint included.
        const cf = sampleField(cracks, u, v);
        const crack = 1 - P.smoothstep(0, 0.05, Math.abs(2 * cf - 1));
        if (crack > 0.02) {
          d.dh -= 0.01 * crack;
          d.tr *= 1 - 0.45 * crack;
          d.tg *= 1 - 0.45 * crack;
          d.tb *= 1 - 0.44 * crack;
          d.ao *= 1 - 0.4 * crack;
        }
      },
    };
  },
};

/* ------------------------------------------------------------------- hazard */

export const hazard: SurfaceSpec = {
  key: 'hazard',
  worldScale: 2,
  base: { color: 0xd8b62a, color2: 0x1e1e20, rough: 0.55, metal: 0.3 },
  cavityRadius: 0.004,
  build(b): Recipe {
    const seed = b.seed;
    const paintNoise = noiseField({ seed, freq: 26, res: b.half, octaves: 3, kind: 'turbulence' });
    const dirt = noiseField({ seed: seed ^ 0x1f, freq: 6, res: b.res, octaves: 3 });
    const dents = noiseField({ seed: seed ^ 0x2b, freq: 4, res: b.res, octaves: 3 });
    const blackPaint = hexToLinear(0x24242a);
    const primer = hexToLinear(0x6d6255);
    const bare = hexToLinear(0xb6b9ba);
    const grimeCol = hexToLinear(0x4f4a3d);
    const STRIPES = 8; // 2 m / 8 = 25 cm hazard bands
    return {
      coarse(u, v, o) {
        const t = P.fract((u + v) * STRIPES);
        const isYellow = t < 0.5;
        if (isYellow) {
          // The base colour is already the yellow; only the black bands recolour.
          o.rough = 0.55;
          o.metal = 0.25;
        } else {
          P.mixTo(o, blackPaint, 0.9);
          o.rough = 0.6;
          o.metal = 0.25;
        }
        const dn = sampleField(dents, u, v);
        o.h = 0.004 * (dn - 0.5);
        P.tint(o, 0.88 + 0.22 * sampleField(dirt, u, v));
        P.mixTo(o, grimeCol, 0.35 * P.smoothstep(0.55, 0.9, sampleField(dirt, u, v)));
        o.rough += 0.12 * P.smoothstep(0.55, 0.9, sampleField(dirt, u, v));
        o.aux = isYellow ? 1 : 0;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const g = white(x, y, seed) - 0.5;
        const g2 = white(x, y, seed ^ 0x63);
        const paint = sampleField(paintNoise, u, v);
        // Worn stripe edges: the boundary frays instead of staying razor sharp.
        const t = P.fract((u + v) * STRIPES + (paint - 0.5) * 0.07);
        const edge = P.smoothstep(0.5, 0.46, Math.abs(t - 0.5));
        const chip = P.smoothstep(0.42, 0.6, paint + 0.25 * (g + 0.5));
        d.dh += 0.0008 * g - 0.0012 * chip;
        d.tr *= 1 + 0.05 * g;
        d.tg *= 1 + 0.05 * g;
        d.tb *= 1 + 0.05 * g;
        if (chip > 0.03) {
          const c = edge > 0.5 ? primer : bare;
          const strength = 0.7 * chip;
          d.tr = d.tr * (1 - strength) + c.r * strength;
          d.tg = d.tg * (1 - strength) + c.g * strength;
          d.tb = d.tb * (1 - strength) + c.b * strength;
          d.metal += 0.4 * chip;
          d.rough += 0.15 * chip;
          d.ao *= 1 - 0.25 * chip;
        }
        // Deep scratches down to bare steel.
        const scratch = P.band(P.fract((u * 0.7 + v * 3.1) * 6) - 0.5, 0.03) * P.smoothstep(0.6, 0.85, g2);
        if (scratch > 0.05) {
          d.tr = d.tr * (1 - 0.6 * scratch) + bare.r * 0.6 * scratch;
          d.tg = d.tg * (1 - 0.6 * scratch) + bare.g * 0.6 * scratch;
          d.tb = d.tb * (1 - 0.6 * scratch) + bare.b * 0.6 * scratch;
          d.metal += 0.8 * scratch;
          d.rough -= 0.25 * scratch;
          d.dh -= 0.0006 * scratch;
        }
        // Grime, heavier towards the bottom of the panel.
        const dirtMask = P.smoothstep(0.5, 0.85, sampleField(dirt, u, v)) * (0.4 + 0.6 * v);
        if (dirtMask > 0.03) {
          d.tr *= 1 - 0.3 * dirtMask;
          d.tg *= 1 - 0.3 * dirtMask;
          d.tb *= 1 - 0.28 * dirtMask;
          d.rough += 0.12 * dirtMask;
        }
      },
    };
  },
};
