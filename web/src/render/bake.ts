/**
 * One-time GPU bake of the terrain material.
 *
 * The simulation hands us a heightfield plus per-vertex blend weights (sand / dirt / rock /
 * grass / asphalt). We blend the procedural material library into a single high-resolution
 * albedo + normal + roughness set so the ground shader stays at one texture fetch per map
 * instead of eighteen, which is the difference between 60 fps and 25 fps on a laptop.
 */
import * as THREE from 'three';
import type { SurfaceLibrary } from '../assets/types.js';

export interface BakedTerrain {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
  dispose(): void;
}

interface BakeInput {
  splat: Uint8Array;
  road: Uint8Array;
  sandVar: Uint8Array;
  grassVar: Uint8Array;
  pave: Uint8Array;
  verts: number;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Blends the five ground materials, writing albedo in RGB and roughness in A. */
const FRAG_ALBEDO = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSplat;
uniform sampler2D uRoad;
uniform sampler2D uSand0;
uniform sampler2D uSand1;
uniform sampler2D uSand2;
uniform sampler2D uGrass0;
uniform sampler2D uGrass1;
uniform sampler2D uGrass2;
uniform sampler2D uDirt;
uniform sampler2D uRock;
uniform sampler2D uAsphalt;
uniform sampler2D uConcrete;
uniform sampler2D uTiles;
uniform sampler2D uStrip;
uniform sampler2D uVar;
uniform vec2 uGroundRepeat;
uniform vec2 uRoadRepeat;
uniform float uHasRoad;

// Three-stop ramp, with the stops' own tiling scales (24 m is the bake's base repeat).
vec3 ramp(sampler2D a, sampler2D b, sampler2D c, float v, float ra, float rb, float rc) {
  vec3 x = texture2D(a, vUv * uGroundRepeat * ra).rgb;
  vec3 y = texture2D(b, vUv * uGroundRepeat * rb).rgb;
  vec3 z = texture2D(c, vUv * uGroundRepeat * rc).rgb;
  return v < 1.0 ? mix(x, y, v) : mix(y, z, v - 1.0);
}

void main() {
  vec4 sp = texture2D(uSplat, vUv);
  float rawsum = sp.r + sp.g + sp.b + sp.a;
  // Zero-weight cells would otherwise divide to black (they showed up as oil-slick streaks).
  sp = rawsum > 0.004 ? sp / rawsum : vec4(1.0, 0.0, 0.0, 0.0);
  float wsum = 1.0;
  vec2 vv = texture2D(uVar, vUv).rg * 255.0;
  vec3 sand = ramp(uSand0, uSand1, uSand2, clamp(vv.x, 0.0, 2.0), 2.0, 2.18, 1.85);
  vec3 grass = ramp(uGrass0, uGrass1, uGrass2, clamp(vv.y, 0.0, 2.0), 4.0, 3.43, 3.0);
  vec3 dirt = texture2D(uDirt, vUv * uGroundRepeat * 0.83).rgb;
  vec3 rock = texture2D(uRock, vUv * uGroundRepeat * 0.71).rgb;
  vec3 ground = (sand * sp.r + dirt * sp.g + rock * sp.b + grass * sp.a) / wsum;

  vec4 rd = uHasRoad > 0.5 ? texture2D(uRoad, vUv) : vec4(0.0);
  float road = rd.r;
  float pave = rd.g * 255.0;
  vec3 asphalt = texture2D(uAsphalt, vUv * uRoadRepeat).rgb;
  vec3 concrete = texture2D(uConcrete, vUv * uRoadRepeat * 0.62).rgb;
  // Concrete roads, worn asphalt only on the dirt tracks: the mask's low band (tracks, ~0.47)
  // stays asphalt-ish, but anything the map calls a road or a base apron (>=0.9) comes out as
  // proper light concrete so it cannot be mistaken for the rock ground it crosses.
  vec3 paved = mix(asphalt, concrete, 0.40 + smoothstep(0.30, 0.92, road) * 0.60);
  // ...unless the map says which shape the pavement is laid in.
  if (pave > 1.5) {
    paved = texture2D(uStrip, vUv * uRoadRepeat * 2.4).rgb;
  } else if (pave > 0.5) {
    paved = texture2D(uTiles, vUv * uRoadRepeat * 3.0).rgb;
  }
  vec3 albedo = mix(ground, paved, smoothstep(0.15, 0.85, road));

  // Roughness: sand is smooth-ish, rock and asphalt are rough, concrete mid.
  float rough = (0.92 * sp.r + 0.86 * sp.g + 0.74 * sp.b + 0.88 * sp.a) / wsum;
  rough = mix(rough, mix(0.68, 0.78, smoothstep(0.5, 1.0, road)), smoothstep(0.15, 0.85, road));

  gl_FragColor = vec4(albedo, rough);
}
`;

/** Rebuilds a tangent-space normal map from the blended material normals. */
const FRAG_NORMAL = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSplat;
uniform sampler2D uRoad;
uniform sampler2D uNSand0;
uniform sampler2D uNSand1;
uniform sampler2D uNSand2;
uniform sampler2D uNGrass0;
uniform sampler2D uNGrass1;
uniform sampler2D uNGrass2;
uniform sampler2D uNDirt;
uniform sampler2D uNRock;
uniform sampler2D uNAsphalt;
uniform sampler2D uNConcrete;
uniform sampler2D uNTiles;
uniform sampler2D uNStrip;
uniform sampler2D uVar;
uniform vec2 uGroundRepeat;
uniform vec2 uRoadRepeat;
uniform float uHasRoad;

vec3 rampN(sampler2D a, sampler2D b, sampler2D c, float v, float ra, float rb, float rc) {
  vec3 x = texture2D(a, vUv * uGroundRepeat * ra).xyz;
  vec3 y = texture2D(b, vUv * uGroundRepeat * rb).xyz;
  vec3 z = texture2D(c, vUv * uGroundRepeat * rc).xyz;
  return v < 1.0 ? mix(x, y, v) : mix(y, z, v - 1.0);
}

void main() {
  vec4 sp = texture2D(uSplat, vUv);
  float rawsum = sp.r + sp.g + sp.b + sp.a;
  sp = rawsum > 0.004 ? sp / rawsum : vec4(1.0, 0.0, 0.0, 0.0);
  float wsum = 1.0;
  vec2 vv = texture2D(uVar, vUv).rg * 255.0;
  vec3 n = rampN(uNSand0, uNSand1, uNSand2, clamp(vv.x, 0.0, 2.0), 2.0, 2.18, 1.85) * sp.r
         + texture2D(uNDirt, vUv * uGroundRepeat * 0.83).xyz * sp.g
         + texture2D(uNRock, vUv * uGroundRepeat * 0.71).xyz * sp.b
         + rampN(uNGrass0, uNGrass1, uNGrass2, clamp(vv.y, 0.0, 2.0), 4.0, 3.43, 3.0) * sp.a;
  n /= wsum;
  vec4 rd = uHasRoad > 0.5 ? texture2D(uRoad, vUv) : vec4(0.0);
  float road = rd.r;
  float pave = rd.g * 255.0;
  vec3 pavedN = mix(
    texture2D(uNAsphalt, vUv * uRoadRepeat).xyz,
    texture2D(uNConcrete, vUv * uRoadRepeat * 0.62).xyz,
    smoothstep(0.55, 0.95, road) * 0.75
  );
  if (pave > 1.5) {
    pavedN = texture2D(uNStrip, vUv * uRoadRepeat * 2.4).xyz;
  } else if (pave > 0.5) {
    pavedN = texture2D(uNTiles, vUv * uRoadRepeat * 3.0).xyz;
  }
  vec3 blended = normalize(mix(n, pavedN, smoothstep(0.15, 0.85, road)) * vec3(1.0, 1.0, 1.0));
  gl_FragColor = vec4(blended * 0.5 + 0.5, 1.0);
}
`;

function dataTexture(data: Uint8Array, size: number, format: THREE.PixelFormat): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, format === THREE.RedFormat ? THREE.RedFormat : THREE.RGBAFormat);
  t.format = format;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function bakeTerrain(
  renderer: THREE.WebGLRenderer,
  map: BakeInput,
  worldSize: number,
  lib: SurfaceLibrary,
  size: number,
): BakedTerrain {
  const verts = map.verts;
  const splatTex = dataTexture(map.splat, verts, THREE.RGBAFormat);

  // Swizzle the single-channel road mask into RGBA so it works on every driver.
  const roadRgba = new Uint8Array(verts * verts * 4);
  for (let i = 0; i < verts * verts; i++) {
    const v = map.road[i];
    roadRgba[i * 4] = v;
    roadRgba[i * 4 + 1] = map.pave[i];
    roadRgba[i * 4 + 2] = v;
    roadRgba[i * 4 + 3] = 255;
  }
  const roadTexRgba = dataTexture(roadRgba, verts, THREE.RGBAFormat);

  // Sand variant in R, grass variant in G: the bake blends the ramps the same way the live
  // ground shader does, so a low-quality map and a high-quality map agree about the ground.
  const varRgba = new Uint8Array(verts * verts * 4);
  for (let i = 0; i < verts * verts; i++) {
    varRgba[i * 4] = map.sandVar[i];
    varRgba[i * 4 + 1] = map.grassVar[i];
    varRgba[i * 4 + 3] = 255;
  }
  const varTex = dataTexture(varRgba, verts, THREE.RGBAFormat);

  const uniforms = {
    uSplat: { value: splatTex },
    uRoad: { value: roadTexRgba },
    uVar: { value: varTex },
    uSand0: { value: lib.surfaces.sand.map },
    uSand1: { value: lib.surfaces.sandGrit.map },
    uSand2: { value: lib.surfaces.sandCoral.map },
    uDirt: { value: lib.surfaces.dirt.map },
    uRock: { value: lib.surfaces.rock.map },
    uGrass0: { value: lib.surfaces.grassLush.map },
    uGrass1: { value: lib.surfaces.grass.map },
    uGrass2: { value: lib.surfaces.grassDry.map },
    uAsphalt: { value: lib.surfaces.asphalt.map },
    uConcrete: { value: lib.surfaces.concreteWorn.map },
    uTiles: { value: lib.surfaces.paveTiles.map },
    uStrip: { value: lib.surfaces.paveStrip.map },
    uNSand0: { value: lib.surfaces.sand.normalMap },
    uNSand1: { value: lib.surfaces.sandGrit.normalMap },
    uNSand2: { value: lib.surfaces.sandCoral.normalMap },
    uNDirt: { value: lib.surfaces.dirt.normalMap },
    uNRock: { value: lib.surfaces.rock.normalMap },
    uNGrass0: { value: lib.surfaces.grassLush.normalMap },
    uNGrass1: { value: lib.surfaces.grass.normalMap },
    uNGrass2: { value: lib.surfaces.grassDry.normalMap },
    uNAsphalt: { value: lib.surfaces.asphalt.normalMap },
    uNConcrete: { value: lib.surfaces.concreteWorn.normalMap },
    uNTiles: { value: lib.surfaces.paveTiles.normalMap },
    uNStrip: { value: lib.surfaces.paveStrip.normalMap },
    uGroundRepeat: { value: new THREE.Vector2(worldSize / 24, worldSize / 24) },
    uRoadRepeat: { value: new THREE.Vector2(worldSize / 12, worldSize / 12) },
    uHasRoad: { value: 1 },
  };

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const albedoMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG_ALBEDO, uniforms, depthTest: false, depthWrite: false });
  const normalMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG_NORMAL, uniforms, depthTest: false, depthWrite: false });
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const makeRT = () =>
    new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
  const rtAlbedo = makeRT();
  const rtNormal = makeRT();

  const prevTarget = renderer.getRenderTarget();
  quad.material = albedoMat;
  renderer.setRenderTarget(rtAlbedo);
  renderer.render(bakeScene, bakeCam);
  quad.material = normalMat;
  renderer.setRenderTarget(rtNormal);
  renderer.render(bakeScene, bakeCam);
  renderer.setRenderTarget(prevTarget);

  // Read back into canvases so colour management is unambiguous (bytes are treated as sRGB
  // for albedo, raw linear for the normal map).
  const read = (rt: THREE.WebGLRenderTarget): Uint8ClampedArray => {
    const buf = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    // Flip vertically: GL origin is bottom-left, textures expect top-left.
    const flipped = new Uint8ClampedArray(size * size * 4);
    const row = size * 4;
    for (let y = 0; y < size; y++) {
      flipped.set(buf.subarray((size - 1 - y) * row, (size - y) * row), y * row);
    }
    return flipped;
  };

  const albedoBytes = read(rtAlbedo);
  const normalBytes = read(rtNormal);
  rtAlbedo.dispose();
  rtNormal.dispose();
  splatTex.dispose();
  roadTexRgba.dispose();
  varTex.dispose();
  albedoMat.dispose();
  normalMat.dispose();
  quad.geometry.dispose();

  const toTexture = (bytes: Uint8ClampedArray, srgb: boolean): THREE.CanvasTexture => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    img.data.set(bytes);
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    return tex;
  };

  const albedo = toTexture(albedoBytes, true);
  const normal = toTexture(normalBytes, false);

  // Roughness rides in the albedo's alpha channel, so reuse it (three reads .g for
  // roughness; we build a tiny swizzle-free copy instead of a second full texture).
  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = roughCanvas.height = size;
  const rctx = roughCanvas.getContext('2d')!;
  const rimg = rctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const r = albedoBytes[i * 4 + 3];
    rimg.data[i * 4] = 255;
    rimg.data[i * 4 + 1] = r; // roughness
    rimg.data[i * 4 + 2] = 0; // metalness
    rimg.data[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);
  const roughness = new THREE.CanvasTexture(roughCanvas);
  roughness.colorSpace = THREE.NoColorSpace;
  roughness.wrapS = roughness.wrapT = THREE.ClampToEdgeWrapping;
  roughness.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  roughness.needsUpdate = true;

  return {
    albedo,
    normal,
    roughness,
    dispose() {
      albedo.dispose();
      normal.dispose();
      roughness.dispose();
    },
  };
}
