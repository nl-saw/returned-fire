/**
 * FX decals: smoke puffs and scorch marks.
 *
 * Both are alpha-carrying RGBA albedo maps (the renderer only has to set
 * `transparent: true`), and both fade to alpha 0 at the tile border, so they can still
 * be used with repeat wrapping without a visible seam. Their relief is derived from the
 * density field, which is what gives a flat quad the self-shadowed look of a volume.
 */
import { hexToLinear } from './canvas';
import { noiseField, polar, sampleField } from './noise';
import * as P from './patterns';
import { white } from './rng';
import { CH, samplePlane, type BakeContext, type Recipe, type SurfaceSpec } from './field';

/** Bilinear sample of the coarse density channel written by the `coarse` pass. */
function auxAt(b: BakeContext, u: number, v: number): number {
  return samplePlane(b.ch[CH.AUX], b.res, u, v);
}

/* --------------------------------------------------------------------- smoke */

export const smoke: SurfaceSpec = {
  key: 'smoke',
  worldScale: 4,
  base: { color: 0xbdbab4, color2: 0x8e8b86, rough: 0.98, metal: 0 },
  clamp: true,
  ao: false,
  cavityRadius: 0,
  build(b): Recipe {
    const seed = b.seed;
    const turbulence = noiseField({ seed, freq: 4, res: b.half, octaves: 5, warp: 2.5, tag: 'puff' });
    const wisp = noiseField({ seed: seed ^ 0x1a, freq: 14, res: b.half, octaves: 3, kind: 'turbulence' });
    const soot = hexToLinear(0x4e4b47);
    const bright = hexToLinear(0xe8e5df);
    return {
      coarse(u, v, o) {
        const dx = u - 0.5;
        const dy = v - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;
        const t = sampleField(turbulence, u, v);
        // A puff that fills the tile and dies out at the border: two lobes plus noise
        // read as billowing smoke rather than as a radial gradient.
        const basePuff = P.smoothstep(1.02, 0.18, r) * (0.55 + 0.5 * Math.cos(Math.atan2(dy, dx) * 2 + 1.2));
        const dens = P.clamp01(basePuff * (0.35 + 1.15 * t) * (1 - 0.2 * r));
        o.r = 0.5;
        o.g = 0.5;
        o.b = 0.5;
        o.h = 0.35 * dens;
        o.rough = 0.95;
        o.aux = dens;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        // The coarse pass owns the billowing shape; the per-texel pass only tears its
        // edges into filaments and turns density into colour.
        const dens = P.clamp01(auxAt(b, u, v));
        const fine = sampleField(wisp, u, v) - 0.5;
        const alpha = P.smoothstep(0.3, 0.62, dens + 0.22 * fine);
        const g = white(x, y, seed) - 0.5;
        // Thin edges are lit through (bright), the core carries soot (darker).
        const core = P.smoothstep(0.35, 0.75, dens);
        const col = P.mix(0.62, 1.0, 1 - P.clamp01(Math.abs(dens - 0.55) * 2.4));
        d.tr = col * 2;
        d.tg = col * 2 * (1 - 0.05 * core);
        d.tb = col * 2 * (1 - 0.09 * core);
        d.ar = -soot.r * 0.25 * core;
        d.ag = -soot.g * 0.25 * core;
        d.ab = -soot.b * 0.25 * core;
        d.ar += bright.r * 0.2 * (1 - dens);
        d.ag += bright.g * 0.2 * (1 - dens);
        d.ab += bright.b * 0.2 * (1 - dens);
        d.a = alpha;
        d.dh = 0.35 * dens + 0.05 * fine;
        d.rough = 0.1 * g;
        d.ao = 1 - 0.25 * core;
      },
    };
  },
};

/* -------------------------------------------------------------------- scorch */

export const scorch: SurfaceSpec = {
  key: 'scorch',
  worldScale: 4,
  base: { color: 0x1d1a17, color2: 0x3a3129, rough: 0.97, metal: 0 },
  clamp: true,
  ao: false,
  cavityRadius: 0,
  build(b): Recipe {
    const seed = b.seed;
    const burst = noiseField({ seed, freq: 3, res: b.half, octaves: 4, warp: 3, tag: 'burst' });
    const filaments = noiseField({ seed: seed ^ 0x17, freq: 6, res: b.half, octaves: 4, tag: 'filament' });
    const grain = noiseField({ seed: seed ^ 0x29, freq: 20, res: b.half, octaves: 3, kind: 'turbulence' });
    const ashCol = hexToLinear(0x6d6559);
    const warmCol = hexToLinear(0x53341c);
    return {
      coarse(u, v, o) {
        const dx = u - 0.5;
        const dy = v - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;
        const bf = sampleField(burst, u, v);
        // Irregular blast boundary: a radial falloff chewed up by warped noise.
        const edge = P.smoothstep(0.98, 0.2, r + 0.28 * (bf - 0.5));
        const core = P.smoothstep(0.65, 0.05, r);
        o.r = 0.5;
        o.g = 0.5;
        o.b = 0.5;
        o.h = 0.004 * edge;
        o.rough = 0.95;
        o.aux = edge + core;
      },
      detail(u, v, d) {
        const x = P.texel(u, b.size);
        const y = P.texel(v, b.size);
        const dx = u - 0.5;
        const dy = v - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;
        const bf = sampleField(burst, u, v);
        const edge = P.smoothstep(1.0, 0.18, r + 0.3 * (bf - 0.5));
        const g = white(x, y, seed) - 0.5;
        // Radial filaments: noise sampled in polar coordinates is stretched outwards,
        // which is exactly how a soot blast streaks away from the charge. atan2 per texel
        // is expensive, so it only runs inside the scorch itself.
        const fil = edge > 0.02 ? polar(filaments, u, v, 0.5, 0.5, 5) : 0.5;
        const dens = P.clamp01(edge * (0.55 + 0.75 * fil) * (1 - 0.25 * r) + 0.06 * g);
        const alpha = P.smoothstep(0.22, 0.62, dens);
        // Soot is densest and blackest at the centre; ash greys the fringe, and the
        // very edge picks up a warm scorched-earth tone.
        const core = P.smoothstep(0.55, 0.1, r);
        const ash = P.clamp01((dens - 0.35) * 1.4) * (1 - core);
        const col = 0.55 + 0.45 * core;
        d.tr = col * 2;
        d.tg = col * 2 * (1 - 0.06 * ash);
        d.tb = col * 2 * (1 - 0.14 * ash);
        d.ar += ashCol.r * 0.18 * ash;
        d.ag += ashCol.g * 0.18 * ash;
        d.ab += ashCol.b * 0.18 * ash;
        const warm = P.smoothstep(0.6, 0.95, dens) * (1 - core) * 0.35;
        d.ar += warmCol.r * warm;
        d.ag += warmCol.g * warm;
        d.ab += warmCol.b * warm;
        d.a = alpha;
        d.dh = 0.005 * dens + 0.002 * (sampleField(grain, u, v) - 0.5) * alpha;
        d.rough = 0.05 * g;
        // Faint heat ring where the blast scoured the ground just outside the soot.
        const ring = P.band(r - 0.72, 0.09) * 0.4;
        if (ring > 0.02) {
          d.ao = 1 - 0.2 * ring;
        }
      },
    };
  },
};
