/**
 * Coarse channel layout, shared by the pipeline (`field.ts`) and the recipes
 * (`surfaces.ts`) without either importing the other.
 */
export const CH = {
  /** Height in metres. */
  H: 0,
  /** Linear albedo. */
  R: 1,
  G: 2,
  B: 3,
  /** 0..1 roughness. */
  ROUGH: 4,
  /** 0..1 metalness. */
  METAL: 5,
  /** Baked large-scale AO, 1 = open sky. */
  AO: 6,
  /** Free scratch channel for the recipe's detail pass. */
  AUX: 7,
} as const;

/** Eight square planes at the coarse pass resolution. */
export type ChannelPlanes = readonly [
  Float32Array,
  Float32Array,
  Float32Array,
  Float32Array,
  Float32Array,
  Float32Array,
  Float32Array,
  Float32Array,
];

export const CHANNEL_COUNT = 8;
