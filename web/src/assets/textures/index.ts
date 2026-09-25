/**
 * Procedural texture library — public surface.
 *
 * `createSurfaceLibrary` / `createSkyTexture` mirror the frozen contract in
 * `../types.ts`; everything else is extra: the noise/pattern toolkit (useful for one-off
 * decals), the sun helpers, per-surface timings and the async warm-up used by the
 * loading screen.
 */
export { createSurfaceLibrary, warmupLibrary, libraryTimings } from './library';
export type { SurfaceTiming } from './library';
export { MAT_KEYS, SURFACES } from './surfaces';
export { createSkyTexture, sunColor, sunDirection, sunIntensity } from './sky';
export type { SkyTextureOptions } from './sky';
export { bakeSurface, samplePlane } from './field';
export type { BakeContext, BakeResult, Cell, Detail, Recipe, SurfaceBase, SurfaceSpec } from './field';
export { CH } from './channels';
export {
  cellularField,
  cellEdge,
  clearNoiseCache,
  fbm2,
  lattice,
  noise2,
  noiseCacheStats,
  noiseField,
  polar,
  sampleCell,
  sampleField,
  sampleFieldRot,
  sampleLattice,
  stretchU,
  stretchV,
} from './noise';
export type { CellMetric, Cellular, CellularSpec, Field, NoiseKind, NoiseSpec } from './noise';
export { Rng, hash2, hash2f, hash3, hash32, hashString, seedFrom, white } from './rng';
export {
  boxMask,
  clamp01,
  discMask,
  fract,
  mix,
  mixTo,
  periodOffset,
  ringMask,
  roundBoxMask,
  seam,
  smoothstep,
  tankMarkMask,
  textMask,
  tint,
  tint3,
  weaveOver,
} from './patterns';
export { dataTexture, fillRGBA, hexToLinear, srgb8 } from './canvas';
