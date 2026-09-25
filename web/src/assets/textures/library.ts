/**
 * The surface library facade: lazy generation, shared materials, disposal.
 *
 * Everything is generated on first access through property getters, so building the
 * library is free and the game can warm materials up behind a loading bar
 * (`warmupLibrary`) instead of stalling the first frame. `surfaces[key]` is always
 * synchronous and always returns usable maps.
 */
import * as THREE from 'three';
import type { MatKey, SurfaceLibrary, SurfaceLibraryOptions, SurfaceMaps } from '../types';
import { bakeSurface, type SurfaceSpec } from './field';
import { clearNoiseCache } from './noise';
import { dataTexture, flatNormalTexture } from './canvas';
import { MAT_KEYS, SURFACES } from './surfaces';

export { MAT_KEYS, SURFACES } from './surfaces';
export { createSkyTexture, sunColor, sunDirection, sunIntensity } from './sky';
export type { SkyTextureOptions } from './sky';

/** Per-surface generation cost, for the loading screen and for perf regressions. */
export interface SurfaceTiming {
  key: MatKey;
  ms: number;
  /** Approximate bytes uploaded for this material's maps. */
  bytes: number;
  textures: number;
}

const timings = new WeakMap<SurfaceLibrary, SurfaceTiming[]>();

/** Generation timings recorded so far (empty for an unknown library). */
export function libraryTimings(lib: SurfaceLibrary): readonly SurfaceTiming[] {
  return timings.get(lib) ?? [];
}

/** Every resource the library owns, so `dispose()` can free all of it. */
interface Owned {
  textures: Set<THREE.Texture>;
  materials: Set<THREE.Material>;
  records: SurfaceTiming[];
}

function clampSize(v: number): number {
  // Power of two keeps the noise lattices and the mip chain exact.
  const s = Math.max(32, Math.min(2048, Math.round(v)));
  return 2 ** Math.round(Math.log2(s));
}

/** Signature of a primitive-only override object, used for material cache keys. */
function overrideKey(o: THREE.MeshStandardMaterialParameters | undefined): string | null {
  if (!o) return '';
  let k = '';
  for (const key of Object.keys(o).sort()) {
    const v = (o as Record<string, unknown>)[key];
    const t = typeof v;
    if (v === null || t === 'number' || t === 'boolean') k += `${key}=${String(v)};`;
    else if (t === 'string') k += `${key}=${String(v)};`;
    else return null; // textures/colours/vectors: not worth caching, caller owns it
  }
  return k;
}

export function createSurfaceLibrary(opts: SurfaceLibraryOptions = {}): SurfaceLibrary {
  const full = opts.full !== false;
  const size = clampSize(opts.size ?? (full ? 512 : 256));
  const anisotropy = Math.max(1, Math.min(16, Math.round(opts.anisotropy ?? 4)));

  const state: Owned = { textures: new Set(), materials: new Set(), records: [] };
  const registry = new Map<MatKey, SurfaceMaps>();
  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const basicCache = new Map<string, THREE.MeshBasicMaterial>();
  // One shared flat normal map for non-`full` libraries: no per-material 1x1 textures.
  const flatNormal = full ? null : flatNormalTexture();

  const buildSurface = (key: MatKey): SurfaceMaps => {
    const spec: SurfaceSpec = SURFACES[key];
    const t0 = performance.now();
    const baked = bakeSurface(spec, { size, full });
    const wrap = spec.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;

    const map = dataTexture(baked.albedo, { srgb: true, wrap, anisotropy, name: `${key}-albedo` });
    let normalMap: THREE.Texture;
    let roughnessMap: THREE.Texture | undefined;
    let aoMap: THREE.Texture | undefined;
    let bytes = baked.albedo.data.byteLength;
    let textures = 1;

    if (full && baked.normal) {
      normalMap = dataTexture(baked.normal, { srgb: false, wrap, anisotropy, name: `${key}-normal` });
      bytes += baked.normal.data.byteLength;
      textures++;
    } else {
      normalMap = flatNormal ?? flatNormalTexture();
    }

    if (full && baked.orm) {
      // Packed ORM: three reads roughness from G, metalness from B and AO from R, so a
      // single texture is bound three times. `channel = 0` makes aoMap sample `uv`
      // instead of the default `uv1` attribute, which our geometry does not carry.
      const orm = dataTexture(baked.orm, { srgb: false, wrap, anisotropy, name: `${key}-orm` });
      orm.channel = 0;
      roughnessMap = orm;
      aoMap = spec.ao === false ? undefined : orm;
      bytes += baked.orm.data.byteLength;
      textures++;
    }

    state.textures.add(map);
    if (normalMap !== flatNormal) state.textures.add(normalMap);
    if (roughnessMap) state.textures.add(roughnessMap);

    const maps: SurfaceMaps = { map, normalMap, worldScale: spec.worldScale };
    if (roughnessMap) maps.roughnessMap = roughnessMap;
    if (aoMap) maps.aoMap = aoMap;

    state.records.push({ key, ms: performance.now() - t0, bytes, textures });
    return maps;
  };

  /** Registers the lazy getters and returns the record the contract asks for. */
  const makeRecord = (): Record<MatKey, SurfaceMaps> => {
    const target = {} as Record<MatKey, SurfaceMaps>;
    for (const key of MAT_KEYS) {
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get(): SurfaceMaps {
          const cached = registry.get(key);
          if (cached) return cached;
          const built = buildSurface(key);
          registry.set(key, built);
          return built;
        },
      });
    }
    return target;
  };

  const surfaces = makeRecord();

  const buildMaterial = (key: MatKey, overrides?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const s = surfaces[key];
    const spec = SURFACES[key];
    const params: THREE.MeshStandardMaterialParameters = { map: s.map, normalMap: s.normalMap };
    if (s.roughnessMap) {
      // With an ORM map the textures own the values, so the scalar multipliers stay 1.
      params.roughnessMap = s.roughnessMap;
      params.metalnessMap = s.roughnessMap;
      params.roughness = 1;
      params.metalness = 1;
    } else {
      params.roughness = spec.base.rough;
      params.metalness = spec.base.metal;
    }
    if (s.aoMap) {
      params.aoMap = s.aoMap;
      params.aoMapIntensity = 1;
    }
    if (key === 'smoke' || key === 'scorch') {
      // Alpha-carrying decals: correct defaults so a caller can just drop them in.
      params.transparent = true;
      params.depthWrite = false;
      if (key === 'scorch') {
        params.polygonOffset = true;
        params.polygonOffsetFactor = -2;
        params.polygonOffsetUnits = -2;
      }
    }
    const merged = { ...params, ...overrides };
    const mat = new THREE.MeshStandardMaterial(merged);
    mat.name = `mat-${key}`;
    state.materials.add(mat);
    return mat;
  };

  const lib: SurfaceLibrary = {
    surfaces: surfaces as Record<MatKey, SurfaceMaps>,

    mat(key: MatKey, overrides?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
      const sig = overrideKey(overrides);
      if (sig === null) return buildMaterial(key, overrides);
      const id = key + '|' + sig;
      const hit = materialCache.get(id);
      if (hit) return hit;
      const mat = buildMaterial(key, overrides);
      materialCache.set(id, mat);
      return mat;
    },

    clone(key: MatKey, overrides?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
      const mat = buildMaterial(key, overrides);
      state.materials.add(mat);
      return mat;
    },

    unlit(key: MatKey, color?: number): THREE.MeshBasicMaterial {
      const c = color ?? 0xffffff;
      const id = `${key}|${c}`;
      const hit = basicCache.get(id);
      if (hit) return hit;
      const mat = new THREE.MeshBasicMaterial({ map: surfaces[key].map, color: c });
      mat.name = `unlit-${key}`;
      basicCache.set(id, mat);
      state.materials.add(mat);
      return mat;
    },

    dispose(): void {
      for (const tex of state.textures) tex.dispose();
      state.textures.clear();
      for (const mat of state.materials) mat.dispose();
      state.materials.clear();
      materialCache.clear();
      basicCache.clear();
      registry.clear();
      state.records.length = 0;
      // Noise buffers are the biggest retained allocation after the textures.
      clearNoiseCache();
    },
  };

  timings.set(lib, state.records);
  return lib;
}

/**
 * Generates materials a few at a time, yielding to the event loop in between, so a
 * loading screen can stay responsive and the first rendered frame never stalls.
 */
export async function warmupLibrary(
  lib: SurfaceLibrary,
  keys: readonly MatKey[] = MAT_KEYS,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const total = keys.length;
  for (let i = 0; i < total; i++) {
    const key = keys[i] as MatKey;
    // Touching the getter is what triggers generation.
    void lib.surfaces[key];
    onProgress?.(i + 1, total);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
