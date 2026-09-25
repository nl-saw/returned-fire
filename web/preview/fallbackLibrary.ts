/**
 * preview/fallbackLibrary.ts — dev-only stand-in for the procedural surface library.
 *
 * The real library lives in `src/assets/textures/library.ts` and is owned by the texture
 * pass; while it is being rewritten (or if a surface generator throws) this keeps the
 * model preview rendering so geometry, proportions and rig conventions stay verifiable.
 * Same `SurfaceLibrary` contract, flat 2×2 procedural maps, no image assets.
 */
import * as THREE from 'three';
import type { MatKey, SurfaceLibrary, SurfaceMaps } from '../src/assets/types';

const BASE: Record<MatKey, number> = {
  sand: 0xc9b083,
  sandWet: 0xa8916a,
  dirt: 0x8b7053,
  rock: 0x7d7469,
  grass: 0x5c7a3c,
  asphalt: 0x4a4a4c,
  concrete: 0x9a978f,
  concreteWorn: 0x827f78,
  sandGrit: 0x8a7a5c,
  sandCoral: 0xe3d6bd,
  grassLush: 0x4f6d33,
  grassDry: 0xa0925a,
  paveTiles: 0xa9a49a,
  paveStrip: 0x9e9a90,
  metalPanel: 0x8d9096,
  metalPainted: 0x6f7a63,
  metalDark: 0x3c4045,
  rust: 0x7a4a2c,
  canvasTent: 0x8a8468,
  wood: 0x6d5334,
  glass: 0x1e2a30,
  sandbag: 0x9a8a63,
  rubber: 0x1d1d1f,
  helipad: 0x50524f,
  hazard: 0xb8a12c,
  camoGreen: 0x4f5c37,
  camoRed: 0x9c3f2e,
  vehMetal: 0x5a5f57,
  vehDetail: 0x2c2f30,
  smoke: 0x9a9a9a,
  scorch: 0x1a1715,
};

function flatMaps(key: MatKey): SurfaceMaps {
  const c = new THREE.Color(BASE[key]);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 2;
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = `#${c.getHexString()}`;
  g.fillRect(0, 0, 2, 2);
  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  const normalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  normalMap.needsUpdate = true;
  return { map, normalMap, worldScale: 4 };
}

export function createFallbackLibrary(anisotropy = 4): SurfaceLibrary {
  const surfaces = {} as Record<MatKey, SurfaceMaps>;
  for (const k of Object.keys(BASE) as MatKey[]) {
    const s = flatMaps(k);
    s.map.anisotropy = anisotropy;
    surfaces[k] = s;
  }
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  return {
    surfaces,
    mat(key, overrides) {
      const id = `${key}|${JSON.stringify(overrides ?? {})}`;
      let m = mats.get(id);
      if (!m) {
        const s = surfaces[key];
        m = new THREE.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughness: 0.85, ...overrides });
        mats.set(id, m);
      }
      return m;
    },
    clone(key, overrides) {
      const s = surfaces[key];
      return new THREE.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, ...overrides });
    },
    unlit(key, color) {
      return new THREE.MeshBasicMaterial({ map: surfaces[key].map, color: color ?? 0xffffff });
    },
    dispose() {
      for (const s of Object.values(surfaces)) {
        s.map.dispose();
        s.normalMap.dispose();
      }
      mats.clear();
    },
  };
}
