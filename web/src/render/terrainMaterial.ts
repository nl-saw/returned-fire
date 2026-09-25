/**
 * Ground material.
 *
 * The terrain's blend weights (sand / dirt / rock / grass / asphalt) are sampled per pixel
 * and each material is read at its own real-world tiling scale, so the ground stays crisp at
 * every zoom level instead of dissolving into a single low-resolution bake. Macro relief comes
 * from the baked normal map, micro relief from a fine detail normal layered on top.
 *
 * The sand and grass channels are not single materials but **ramps of three**: the map stores one
 * variant index per vertex (see `MapData::sand_var`), and the shader lerps between the two stops
 * either side of it, so painting a different sand in the editor changes the ground rather than
 * laying a decal over it. A ramp costs two fetches rather than three because only the pair the
 * value sits between is ever needed.
 *
 * Pavement is the `road` mask's *level* plus a shape index: plain concrete, square slabs, or a
 * slab strip laid along the road. A strip swaps its UV axes rather than rotating them — a rotation
 * would need `textureGrad` to keep the mip derivatives honest, and swapping is free.
 *
 * Injected into `MeshStandardMaterial` (rather than written as a standalone ShaderMaterial)
 * so the terrain keeps three.js' shadow, fog, IBL and tone-mapping pipeline for free.
 */
import * as THREE from 'three';
import type { MatKey, SurfaceLibrary } from '../assets/types.js';
import type { MapBuffers } from '../sim/bridge.js';
import type { GroundRect } from './terrain.js';

/** The sand ramp, low stop first: this is the order the map's variant index indexes into. */
const SAND: MatKey[] = ['sand', 'sandGrit', 'sandCoral'];
/** The grass ramp: lush meadow, scrub, dry straw. */
const GRASS: MatKey[] = ['grassLush', 'grass', 'grassDry'];
/** Materials blended by a single splat channel. */
const DIRT: MatKey = 'dirt';
const ROCK: MatKey = 'rock';
/** Plain pavement (no shape painted) and the two shapes. */
const PLAIN: MatKey[] = ['asphalt', 'concreteWorn'];
const TILES: MatKey = 'paveTiles';
const STRIP: MatKey = 'paveStrip';
/** Fine detail normal: generic gravel relief that reads on every surface type. */
const DETAIL: MatKey = 'dirt';
const DETAIL_TILE = 6.5;
/** Every material the albedo/normal stages may sample, in uniform-declaration order. */
const ALL: MatKey[] = [...SAND, ...GRASS, DIRT, ROCK, ...PLAIN, TILES, STRIP];
/**
 * Per-material roughness. The ORM maps would cost a dozen more fetches per ground pixel for
 * variation nobody can see from 50 m, so the roughness is a weighted constant and the budget goes
 * to the *normal* maps instead (real ripples, strata and clumps).
 */
const ROUGH: Record<string, number> = {
  sand: 0.92,
  sandGrit: 0.93,
  sandCoral: 0.84,
  dirt: 0.86,
  rock: 0.74,
  grassLush: 0.88,
  grass: 0.9,
  grassDry: 0.93,
  asphalt: 0.72,
  concreteWorn: 0.8,
  paveTiles: 0.88,
  paveStrip: 0.85,
};

export interface GroundMaterial {
  material: THREE.MeshStandardMaterial;
  /** Re-upload the ground masks after the map has been edited in place. */
  /** `dirty` narrows the copy to what an edit touched; the upload itself is still whole-texture. */
  updateMasks(map: MapBuffers, dirty?: GroundRect): void;
  dispose(): void;
}

export function createGroundMaterial(
  lib: SurfaceLibrary,
  map: MapBuffers,
  opts: { detail?: boolean } = {},
): GroundMaterial {
  const verts = map.grid + 1;
  const gcell = map.cell;
  const splatData = new Uint8Array(map.splat);
  const splat = new THREE.DataTexture(splatData, verts, verts, THREE.RGBAFormat);
  // Mipmapped + anisotropic: the masks are only 2 m/texel, so without a mip chain they moire
  // into a paving-grid pattern across every large sand flat.
  splat.generateMipmaps = true;
  splat.minFilter = THREE.LinearMipmapLinearFilter;
  splat.magFilter = THREE.LinearFilter;
  splat.anisotropy = 8;
  splat.wrapS = splat.wrapT = THREE.ClampToEdgeWrapping;
  splat.needsUpdate = true;

  // Sand variant in R, grass variant in G, both 0..2 as raw bytes (the shader scales by 255).
  // Interpolating the *index* is what makes a ramp: 1.5 in this texture is a half-and-half mix
  // of the two stops either side of it.
  const variantRgba = new Uint8Array(verts * verts * 4);
  for (let i = 0; i < verts * verts; i++) {
    variantRgba[i * 4] = map.sandVar[i];
    variantRgba[i * 4 + 1] = map.grassVar[i];
    variantRgba[i * 4 + 3] = 255;
  }
  const variant = new THREE.DataTexture(variantRgba, verts, verts, THREE.RGBAFormat);
  variant.generateMipmaps = true;
  variant.minFilter = THREE.LinearMipmapLinearFilter;
  variant.magFilter = THREE.LinearFilter;
  variant.anisotropy = 4;
  variant.wrapS = variant.wrapT = THREE.ClampToEdgeWrapping;
  variant.needsUpdate = true;

  // Road level in R, pavement shape in G (0 plain / 1 slabs / 2 strip along x / 3 along z).
  const roadRgba = new Uint8Array(verts * verts * 4);
  for (let i = 0; i < verts * verts; i++) {
    const v = map.road[i];
    roadRgba[i * 4] = v;
    roadRgba[i * 4 + 1] = map.pave[i];
    roadRgba[i * 4 + 2] = v;
    roadRgba[i * 4 + 3] = 255;
  }
  const road = new THREE.DataTexture(roadRgba, verts, verts, THREE.RGBAFormat);
  road.generateMipmaps = true;
  road.minFilter = THREE.LinearMipmapLinearFilter;
  road.magFilter = THREE.LinearFilter;
  road.anisotropy = 8;
  road.wrapS = road.wrapT = THREE.ClampToEdgeWrapping;
  road.needsUpdate = true;

  const world = map.worldSize;
  const scale = (k: MatKey): number => world / lib.surfaces[k].worldScale;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    dithering: true,
  });
  // A real normalMap must be bound for three to define the tangent-space plumbing we reuse.
  const detailTex = lib.surfaces[DETAIL].normalMap.clone();
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
  detailTex.repeat.set(world / DETAIL_TILE, world / DETAIL_TILE);
  detailTex.colorSpace = THREE.NoColorSpace;
  detailTex.needsUpdate = true;
  material.normalMap = detailTex;
  material.normalScale = new THREE.Vector2(0.55, 0.55);

  const uniforms: Record<string, THREE.IUniform> = {
    uSplatTex: { value: splat },
    uVarTex: { value: variant },
    uRoadTex: { value: road },
    uDetailS: { value: world / DETAIL_TILE },
    uHasRoad: { value: 1 },
  };
  for (const k of ALL) {
    uniforms[`uS_${k}`] = { value: scale(k) };
    uniforms[`uAlb_${k}`] = { value: lib.surfaces[k].map };
    uniforms[`uNrm_${k}`] = { value: lib.surfaces[k].normalMap };
  }

  const samplerDecls = ALL.map(
    (k) => `uniform sampler2D uAlb_${k};\nuniform sampler2D uNrm_${k};\nuniform float uS_${k};`,
  ).join('\n');
  const roughDecls = ALL.map(
    (k) => `const float kRough_${k} = ${(ROUGH[k] ?? 0.85).toFixed(2)};`,
  ).join('\n');
  // Sampler name lists for a ramp, so the GLSL is generated from the same arrays the uniforms
  // are: a hand-typed list is one rename away from sampling the wrong material.
  const alb = (keys: MatKey[]): string => keys.map((k) => `uAlb_${k}`).join(', ');
  const nrm = (keys: MatKey[]): string => keys.map((k) => `uNrm_${k}`).join(', ');
  const sz = (keys: MatKey[]): string => keys.map((k) => `uS_${k}`).join(', ');

  const helpers = /* glsl */ `
    uniform sampler2D uSplatTex;
    uniform sampler2D uVarTex;
    uniform sampler2D uRoadTex;
    ${samplerDecls}
    ${roughDecls}
    uniform float uDetailS; uniform float uHasRoad;

    // The masks are fetched once per fragment and shared by the albedo, normal and roughness
    // stages (they used to be sampled twice each).
    vec4 gWeights;
    float gRoad;
    float gSandVar;
    float gGrassVar;
    float gPave;
    void rfGroundMasks() {
      gWeights = texture2D(uSplatTex, vGroundUv);
      vec4 r = uHasRoad > 0.5 ? texture2D(uRoadTex, vGroundUv) : vec4(0.0);
      gRoad = r.r;
      gPave = r.g * 255.0;
      vec2 v = texture2D(uVarTex, vGroundUv).rg * 255.0;
      gSandVar = clamp(v.x, 0.0, 2.0);
      gGrassVar = clamp(v.y, 0.0, 2.0);
    }

    // Unweighted cells exist (the generator leaves some regions at zero); dividing by their
    // sum used to return black, which read as oil slicks through the water. Fall back to sand.
    vec4 rfGroundWeights() {
      vec4 w = gWeights;
      float sum = w.r + w.g + w.b + w.a;
      return sum > 0.004 ? w / sum : vec4(1.0, 0.0, 0.0, 0.0);
    }

    // A three-stop ramp: two fetches, whichever pair the variant sits between.
    vec3 rfRampAlb(sampler2D t0, sampler2D t1, sampler2D t2, float v,
                   float s0, float s1, float s2) {
      vec2 p = vGroundPos.xz;
      return v < 1.0
        ? mix(texture2D(t0, p / s0).rgb, texture2D(t1, p / s1).rgb, v)
        : mix(texture2D(t1, p / s1).rgb, texture2D(t2, p / s2).rgb, v - 1.0);
    }
    vec3 rfRampNrm(sampler2D t0, sampler2D t1, sampler2D t2, float v,
                   float s0, float s1, float s2) {
      vec2 p = vGroundPos.xz;
      vec3 a = texture2D(t0, p / s0).xyz * 2.0 - 1.0;
      vec3 b = texture2D(t1, p / s1).xyz * 2.0 - 1.0;
      vec3 c = texture2D(t2, p / s2).xyz * 2.0 - 1.0;
      return v < 1.0 ? mix(a, b, v) : mix(b, c, v - 1.0);
    }

    // Pavement, in the shape the map stored for this cell. A strip is laid *along* the road, so
    // its U axis follows the road: the two orientations are the same texture with the axes
    // swapped, which is exact and keeps the derivatives valid.
    vec3 rfPavedAlb() {
      vec2 p = vGroundPos.xz;
      if (gPave > 1.5) {
        vec2 q = gPave > 2.5 ? p.yx : p;
        return texture2D(uAlb_${STRIP}, q / uS_${STRIP}).rgb;
      }
      if (gPave > 0.5) {
        return texture2D(uAlb_${TILES}, p / uS_${TILES}).rgb;
      }
      return mix(
        texture2D(uAlb_asphalt, p / uS_asphalt).rgb,
        texture2D(uAlb_concreteWorn, p / uS_concreteWorn).rgb,
        smoothstep(0.55, 0.95, gRoad) * 0.75
      );
    }
    vec3 rfPavedNrm() {
      vec2 p = vGroundPos.xz;
      if (gPave > 1.5) {
        vec2 q = gPave > 2.5 ? p.yx : p;
        return texture2D(uNrm_${STRIP}, q / uS_${STRIP}).xyz * 2.0 - 1.0;
      }
      if (gPave > 0.5) {
        return texture2D(uNrm_${TILES}, p / uS_${TILES}).xyz * 2.0 - 1.0;
      }
      return mix(
        texture2D(uNrm_asphalt, p / uS_asphalt).xyz * 2.0 - 1.0,
        texture2D(uNrm_concreteWorn, p / uS_concreteWorn).xyz * 2.0 - 1.0,
        smoothstep(0.55, 0.95, gRoad) * 0.75
      );
    }
    float rfPavedRough() {
      if (gPave > 1.5) return kRough_${STRIP};
      if (gPave > 0.5) return kRough_${TILES};
      return mix(kRough_asphalt, kRough_concreteWorn, smoothstep(0.55, 0.95, gRoad) * 0.75);
    }

    vec3 rfGroundAlbedo() {
      vec4 w = rfGroundWeights();
      vec3 c = rfRampAlb(${alb(SAND)}, gSandVar, ${sz(SAND)}) * w.r
             + texture2D(uAlb_${DIRT}, vGroundPos.xz / uS_${DIRT}).rgb * w.g
             + texture2D(uAlb_${ROCK}, vGroundPos.xz / uS_${ROCK}).rgb * w.b
             + rfRampAlb(${alb(GRASS)}, gGrassVar, ${sz(GRASS)}) * w.a;
      if (gRoad > 0.02) {
        c = mix(c, rfPavedAlb(), smoothstep(0.12, 0.72, gRoad));
      }
      return c;
    }

    // Blended tangent-space normal: sand ripples, rock strata and grass clumps all survive
    // into the blend, which is what stops the ground reading as uniform tan mush.
    vec3 rfGroundNormalTS() {
      vec4 w = rfGroundWeights();
      vec3 n = rfRampNrm(${nrm(SAND)}, gSandVar, ${sz(SAND)}) * w.r
             + (texture2D(uNrm_${DIRT}, vGroundPos.xz / uS_${DIRT}).xyz * 2.0 - 1.0) * w.g
             + (texture2D(uNrm_${ROCK}, vGroundPos.xz / uS_${ROCK}).xyz * 2.0 - 1.0) * w.b
             + rfRampNrm(${nrm(GRASS)}, gGrassVar, ${sz(GRASS)}) * w.a;
      if (gRoad > 0.02) {
        n = mix(n, rfPavedNrm(), smoothstep(0.12, 0.72, gRoad));
      }
      n.xy *= 0.85;
      return normalize(vec3(n.xy, max(n.z, 0.2)));
    }

    float rfGroundRough() {
      vec4 w = rfGroundWeights();
      float sr = mix(kRough_${SAND[0]}, kRough_${SAND[1]}, clamp(gSandVar, 0.0, 1.0));
      sr = mix(sr, kRough_${SAND[2]}, clamp(gSandVar - 1.0, 0.0, 1.0));
      float gr = mix(kRough_${GRASS[0]}, kRough_${GRASS[1]}, clamp(gGrassVar, 0.0, 1.0));
      gr = mix(gr, kRough_${GRASS[2]}, clamp(gGrassVar - 1.0, 0.0, 1.0));
      float r = sr * w.r + kRough_${DIRT} * w.g + kRough_${ROCK} * w.b + gr * w.a;
      if (gRoad > 0.02) {
        r = mix(r, rfPavedRough(), smoothstep(0.12, 0.72, gRoad));
      }
      return r;
    }
  `;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec2 vGroundUv;
         varying vec3 vGroundPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vGroundUv = uv;
         vGroundPos = position;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec2 vGroundUv;
         varying vec3 vGroundPos;
         ${helpers}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         rfGroundMasks();
         diffuseColor.rgb *= rfGroundAlbedo();`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = rfGroundRough();`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         normal = normalize(tbn * rfGroundNormalTS());`,
      );
    // Macro shape comes from the heightfield geometry normals, micro shape from the blended
    // material normals we inject above. `normalMap` stays bound only so three builds the
    // tangent frame (`tbn`) for us; its own fetch is overridden immediately afterwards.
    void opts.detail;
  };
  material.customProgramCacheKey = () => 'rf-ground-v4';
  void uniforms.uDetailS;

  return {
    material,
    /**
     * Copy an edited map's masks into the live textures.
     *
     * The arrays are the ones the textures hold, so this is a memcpy plus three `needsUpdate`
     * flags: the editor paints the layer in wasm memory and the material follows it without a
     * new texture, a new material or a shader recompile.
     */
    updateMasks(next: MapBuffers, dirty?: GroundRect) {
      // Which ground vertices an edit touched. The repack below is one GPU texel per vertex, so it
      // is the same rectangle in both spaces — and a brush dab narrows it from the whole map to a
      // few thousand texels. The upload is still whole-texture: three.js has no partial update for
      // a `DataTexture` that survives its row alignment, and the upload was never the cost.
      let gx0 = 0;
      let gz0 = 0;
      let gx1 = verts - 1;
      let gz1 = verts - 1;
      if (dirty) {
        gx0 = Math.max(0, Math.floor(dirty.x0 / gcell));
        gz0 = Math.max(0, Math.floor(dirty.z0 / gcell));
        gx1 = Math.min(verts - 1, Math.ceil(dirty.x1 / gcell));
        gz1 = Math.min(verts - 1, Math.ceil(dirty.z1 / gcell));
      }
      const whole = gx0 === 0 && gz0 === 0 && gx1 === verts - 1 && gz1 === verts - 1;
      if (whole) {
        const n = Math.min(splatData.length, next.splat.length);
        splatData.set(next.splat.subarray(0, n));
      } else {
        for (let iz = gz0; iz <= gz1; iz++) {
          const a = (iz * verts + gx0) * 4;
          const b = (iz * verts + gx1 + 1) * 4;
          splatData.set(next.splat.subarray(a, b), a);
        }
      }
      for (let iz = gz0; iz <= gz1; iz++) {
        for (let ix = gx0; ix <= gx1; ix++) {
          const j = iz * verts + ix;
          const i = j * 4;
          variantRgba[i] = next.sandVar[j];
          variantRgba[i + 1] = next.grassVar[j];
          roadRgba[i] = next.road[j];
          roadRgba[i + 1] = next.pave[j];
          roadRgba[i + 2] = next.road[j];
        }
      }
      splat.needsUpdate = true;
      variant.needsUpdate = true;
      road.needsUpdate = true;
    },
    dispose() {
      splat.dispose();
      variant.dispose();
      road.dispose();
      detailTex.dispose();
      material.dispose();
    },
  };
}
