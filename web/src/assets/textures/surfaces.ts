/**
 * Surface registry: one spec per `MatKey`.
 *
 * The `Record<MatKey, SurfaceSpec>` type is the contract check — adding a key to
 * `MatKey` without a recipe here is a compile error, so the library can never hand the
 * renderer an undefined surface.
 */
import type { MatKey } from '../types';
import type { SurfaceSpec } from './field';
import {
  asphalt,
  concrete,
  concreteWorn,
  dirt,
  grass,
  grassDry,
  grassLush,
  paveStrip,
  paveTiles,
  rock,
  sand,
  sandCoral,
  sandGrit,
  sandWet,
} from './terrain';
import {
  canvasTent,
  glass,
  hazard,
  helipad,
  metalDark,
  metalPainted,
  metalPanel,
  rubber,
  rust,
  sandbag,
  wood,
} from './structures';
import { camoGreen, camoRed, vehDetail, vehMetal } from './vehicles';
import { scorch, smoke } from './fx';

export const SURFACES: Record<MatKey, SurfaceSpec> = {
  sand,
  sandWet,
  dirt,
  rock,
  grass,
  asphalt,
  concrete,
  concreteWorn,
  sandGrit,
  sandCoral,
  grassLush,
  grassDry,
  paveTiles,
  paveStrip,
  metalPanel,
  metalPainted,
  metalDark,
  rust,
  canvasTent,
  wood,
  glass,
  sandbag,
  rubber,
  helipad,
  hazard,
  camoGreen,
  camoRed,
  vehMetal,
  vehDetail,
  smoke,
  scorch,
};

/** Every material key, in a stable order (useful for warm-up loops and debug sheets). */
export const MAT_KEYS: readonly MatKey[] = Object.keys(SURFACES) as MatKey[];
