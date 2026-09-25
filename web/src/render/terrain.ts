/**
 * Terrain + sea.
 *
 * The ground mesh is built straight from the simulation's heightfield so physics and visuals
 * can never disagree; its material uses the baked splat texture plus a tiled detail normal so
 * it still has high-frequency detail when the camera zooms in. The sea is a custom shader:
 * depth-tinted, fresnel-lit, animated normals, foam at the waterline and a sun glint.
 */
import * as THREE from 'three';
import type { SurfaceLibrary } from '../assets/types.js';
import type { MapBuffers } from '../sim/bridge.js';
import { bakeTerrain, type BakedTerrain } from './bake.js';
import type { GroundMaterial } from './terrainMaterial.js';
import type { GameScene, Quality } from './scene.js';
import { QUALITY, sunDirection, SUN_COLOR } from './scene.js';
import { createGroundMaterial } from './terrainMaterial.js';

export interface Terrain {
  group: THREE.Group;
  ground: THREE.Mesh;
  water: THREE.Mesh;
  /** Bilinear terrain height in metres. */
  heightAt(x: number, z: number): number;
  update(time: number, cameraPos: THREE.Vector3): void;
  /**
   * Re-read the map after it has been edited in place: heights, ground weights and pavement.
   *
   * The map editor paints the layers inside wasm memory, so the mesh, the vertex colours and the
   * material's masks are all stale until this runs. It is a vertex walk plus a texture upload —
   * no geometry rebuild — because the alternative at `big` is a 500k-triangle mesh re-created
   * under every brush stroke.
   */
  /** `dirty` is the world-space rectangle an edit touched; omit it to rebuild everything. */
  updateFromMap(next: MapBuffers, dirty?: GroundRect): void;
  dispose(): void;
}

/** A world-space rectangle of ground, in metres. */
export interface GroundRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const WATER_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
uniform sampler2D uDepth;      // terrain height in metres (half float)
uniform sampler2D uSky;        // equirect sky
uniform sampler2D uWave;       // normal map
uniform float uTime;
uniform float uWorldSize;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform float uHasSky;
uniform float uDebug;

vec3 skyAt(vec3 dir) {
  if (uHasSky < 0.5) return vec3(0.55, 0.72, 0.86);
  // three.js equirect convention: v = asin(y)/PI + 0.5 (v = 0 is the nadir).
  float u = atan(dir.z, dir.x) * 0.15915494 + 0.5;
  float v = asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5;
  return texture2D(uSky, vec2(u, v)).rgb;
}

void main() {
  vec2 uv = vWorld.xz / uWorldSize;
  // Real depth under this fragment, straight out of the heightfield.
  float h = texture2D(uDepth, uv).r;
  float depth = clamp(-h, 0.0, 14.0);

  vec2 p = vWorld.xz;
  // Long swell, wind chop, fine ripple.
  vec3 w1 = texture2D(uWave, p * 0.026 + vec2(uTime * 0.0062, uTime * 0.0038)).xyz * 2.0 - 1.0;
  vec3 w2 = texture2D(uWave, p * 0.058 - vec2(uTime * 0.0105, uTime * 0.0062)).xyz * 2.0 - 1.0;
  vec3 w3 = texture2D(uWave, p * 0.128 + vec2(-uTime * 0.019, uTime * 0.016)).xyz * 2.0 - 1.0;
  // Waves flatten as they run out of water, which is what sells a real shoreline.
  float amp = mix(0.34, 1.0, smoothstep(0.0, 2.4, depth));
  vec3 viewDir = normalize(cameraPosition - vWorld);
  // The sea is viewed at a shallow angle, where a strong normal perturbation turns into long
  // smeared streaks (they read as oil, not water). Fade the chop as the view goes grazing and
  // as the water deepens, so the offshore surface stays calm and readable.
  float viewY = clamp(viewDir.y, 0.0, 1.0);
  float deepMix = smoothstep(0.5, 8.0, depth);
  float chop = mix(0.30, 1.0, smoothstep(0.05, 0.5, viewY)) * mix(1.0, 0.55, deepMix);
  vec3 n = normalize(vec3(0.0, 1.0, 0.0) + (w1 * 0.30 + w2 * 0.22 + w3 * 0.13) * amp * chop);

  float ndv = clamp(dot(viewDir, n), 0.0, 1.0);
  // Schlick fresnel: almost no reflection looking down, full sky at grazing angles.
  float fres = 0.06 + 0.94 * pow(1.0 - ndv, 5.0);

  vec3 refl = reflect(-viewDir, n);
  refl.y = abs(refl.y);
  vec3 sky = skyAt(refl);

  // Clear tropical water: sand-tinted turquoise in the shallows, blue-teal offshore.
  vec3 body = mix(uShallow, uDeep, deepMix);
  body += uShallow * exp(-depth * 0.9) * 0.22;
  // Offshore water still catches a lot of sky; without this the far field goes to ink.
  body = mix(body, sky * 0.95, 0.30 * deepMix);

  // Sun glint: a tight specular core plus glitter that breaks up on the chop, so it reads
  // as sparkle instead of a white blob.
  vec3 hv = normalize(uSunDir + viewDir);
  float ndh = max(dot(n, hv), 0.0);
  float spec = pow(ndh, 1200.0) * 1.15;
  spec += pow(ndh, 160.0) * (0.05 + 0.22 * max(w3.y, 0.0));

  // Foam: one thin broken line hugging the waterline, breathing with the swell.
  float line = 1.0 - smoothstep(0.0, 0.34, depth);
  float fA = texture2D(uWave, p * 0.085 + vec2(uTime * 0.02, uTime * 0.012)).x;
  float fB = texture2D(uWave, p * 0.21 - vec2(uTime * 0.03, uTime * 0.021)).y;
  float surge = 0.5 + 0.5 * sin(uTime * 0.5 + fA * 7.0);
  float foam = smoothstep(0.58, 1.0, line * (0.55 + 0.55 * fB + 0.3 * surge));
  foam += smoothstep(0.74, 1.0, line) * 0.30;
  // A fainter second line where the swell has already broken and is running up the sand.
  foam += smoothstep(0.26, 0.5, line) * smoothstep(0.66, 0.96, fA) * 0.30;

  vec3 color = mix(body, sky, clamp(fres * 0.8 + 0.14, 0.0, 1.0));
  color += uSunColor * spec;
  color = mix(color, uFoam, clamp(foam, 0.0, 0.8));

  // Nearly clear over the sand, opaque out where it is deep.
  float alpha = mix(0.26, 0.96, smoothstep(0.0, 2.6, depth));
  alpha = clamp(alpha + fres * 0.55 + foam * 0.5, 0.0, 1.0);
  gl_FragColor = vec4(color, alpha);

  // ?water=flat paints the surface magenta; ?water=depth paints the sampled depth as
  // greyscale. Both exist so a screenshot can prove what the sea surface is really doing.
  if (uDebug > 0.5) {
    gl_FragColor = uDebug < 1.5
      ? vec4(1.0, 0.0, 1.0, 1.0)
      : vec4(vec3(clamp(depth / 14.0, 0.0, 1.0)), 1.0);
  }
}
`;

/**
 * Metres of open sea drawn beyond the playable edge.
 *
 * This is a *band*, not a multiple of the world. It used to be `worldSize * 2.6`, which for
 * the original 256 m world meant a 665 m ocean — 6.8x the playable area of nothing but water
 * around the island. That ratio is what made the player's zoomed-out screenshot read as "a
 * small island in a huge empty sea" at any world size. The sea still has to reach past the
 * far plane at full zoom-out, which is what `update()` below scales for.
 */
export const SEA_BAND = 190;

/**
 * Tileable "water surface" normal map built from a handful of sine waves. Generating it here
 * keeps the sea independent of the material library (which owns land materials only).
 */
function makeWaveNormal(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  // Six directions instead of four: fewer long straight crests, so the surface breaks up
  // into chop rather than smearing into streaks when seen at a shallow angle.
  const waves = [
    { fx: 4, fz: 2, amp: 0.5, phase: 0.0 },
    { fx: 2, fz: -5, amp: 0.42, phase: 1.7 },
    { fx: 7, fz: 6, amp: 0.3, phase: 3.1 },
    { fx: -9, fz: 4, amp: 0.22, phase: 0.6 },
    { fx: 13, fz: -11, amp: 0.15, phase: 2.2 },
    { fx: -17, fz: -13, amp: 0.11, phase: 4.4 },
  ];
  const tau = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let dhdx = 0;
      let dhdz = 0;
      for (const w of waves) {
        const a = tau * (w.fx * u + w.fz * v) + w.phase;
        dhdx += w.amp * w.fx * Math.cos(a);
        dhdz += w.amp * w.fz * Math.cos(a);
      }
      const n = new THREE.Vector3(-dhdx * 0.045, 1, -dhdz * 0.045).normalize();
      const i = (y * size + x) * 4;
      data[i] = Math.round((n.x * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function createTerrain(
  map: MapBuffers,
  gs: GameScene,
  lib: SurfaceLibrary,
  quality: Quality,
  bakeOverride?: number,
): Terrain {
  const group = new THREE.Group();
  const verts = map.grid + 1;
  const cell = map.cell;
  const worldSize = map.worldSize;
  // The simulation grid is 2 m/cell. Subdividing the mesh (heights are interpolated, so
  // physics is untouched) smooths the waterline, but every step doubles the vertex and index
  // buffers — at 2x the software rasteriser used by the capture harness ran out of room and
  // produced empty frames, so the shipping default is the simulation resolution.
  const SUB = 1;
  const mverts = map.grid * SUB + 1;
  const mcell = cell / SUB;
  /**
   * The vertex colour of a ground vertex, from its height alone.
   *
   * Wet sand darkens the waterline, dry ridges bleach out a little, and two low-frequency waves
   * keep big sand flats from reading as one sheet. Pure and shared, so a region update paints the
   * same colour the full build would have.
   */
  const shadeAt = (h: number, mx: number, mz: number): [number, number, number] => {
    const wet = 1 - Math.min(1, Math.max(0, (h - map.waterLevel) / 0.9));
    const bleach = Math.min(1, Math.max(0, (h - 1.2) / 8.0));
    const mottle = Math.sin(mx * 0.031 + mz * 0.017) * 0.5 + Math.sin(mx * 0.011 - mz * 0.023) * 0.5;
    const shade = 1 - wet * 0.17 + bleach * 0.06 + mottle * 0.035;
    return [shade, shade * (1 - wet * 0.02), shade * (1 - wet * 0.06 - mottle * 0.012)];
  };

  const sampleH = (ix: number, iz: number): number => {
    const fx = ix / SUB;
    const fz = iz / SUB;
    const x0 = Math.min(map.grid, Math.floor(fx));
    const z0 = Math.min(map.grid, Math.floor(fz));
    const x1 = Math.min(map.grid, x0 + 1);
    const z1 = Math.min(map.grid, z0 + 1);
    const tx = fx - x0;
    const tz = fz - z0;
    const h00 = map.heights[z0 * verts + x0];
    const h10 = map.heights[z0 * verts + x1];
    const h01 = map.heights[z1 * verts + x0];
    const h11 = map.heights[z1 * verts + x1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };

  // ---- ground mesh -----------------------------------------------------------
  const positions = new Float32Array(mverts * mverts * 3);
  const uvs = new Float32Array(mverts * mverts * 2);
  const normals = new Float32Array(mverts * mverts * 3);
  const colors = new Float32Array(mverts * mverts * 3);
  let minH = Infinity;
  let maxH = -Infinity;
  for (let iz = 0; iz < mverts; iz++) {
    for (let ix = 0; ix < mverts; ix++) {
      const i = iz * mverts + ix;
      const h = sampleH(ix, iz);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      positions[i * 3] = ix * mcell;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = iz * mcell;
      uvs[i * 2] = ix / (mverts - 1);
      uvs[i * 2 + 1] = iz / (mverts - 1);

      const [cr, cg, cb] = shadeAt(h, ix * mcell, iz * mcell);
      colors[i * 3] = cr;
      colors[i * 3 + 1] = cg;
      colors[i * 3 + 2] = cb;
    }
  }
  const idx = new Uint32Array(map.grid * SUB * map.grid * SUB * 6);
  let k = 0;
  for (let iz = 0; iz < map.grid * SUB; iz++) {
    for (let ix = 0; ix < map.grid * SUB; ix++) {
      const a = iz * mverts + ix;
      const b = a + 1;
      const c = a + mverts;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
    }
  }
  // Smooth normals from the heightfield (central differences, matches the sim's slope).
  for (let iz = 0; iz < mverts; iz++) {
    for (let ix = 0; ix < mverts; ix++) {
      const i = iz * mverts + ix;
      const hx0 = sampleH(Math.max(0, ix - 1), iz);
      const hx1 = sampleH(Math.min(mverts - 1, ix + 1), iz);
      const hz0 = sampleH(ix, Math.max(0, iz - 1));
      const hz1 = sampleH(ix, Math.min(mverts - 1, iz + 1));
      const dx = (hx1 - hx0) / (2 * mcell);
      const dz = (hz1 - hz0) / (2 * mcell);
      const n = new THREE.Vector3(-dx, 1, -dz).normalize();
      normals[i * 3] = n.x;
      normals[i * 3 + 1] = n.y;
      normals[i * 3 + 2] = n.z;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  // Two paths: the splat material (crisp at every zoom, used on medium/high) and a cheap
  // one-off bake of the same blend for low quality, where the extra fetches are not worth it.
  let groundMat: GroundMaterial | null = null;
  let baked: BakedTerrain | null = null;
  let mat: THREE.MeshStandardMaterial;
  if (quality === 'low') {
    const bakeSize = bakeOverride ?? QUALITY[quality].terrainBake;
    try {
      baked = bakeTerrain(
        gs.renderer,
        { splat: map.splat, road: map.road, sandVar: map.sandVar, grassVar: map.grassVar, pave: map.pave, verts },
        worldSize,
        lib,
        bakeSize,
      );
    } catch (err) {
      console.warn('terrain bake failed, falling back to the splat material', err);
      baked = null;
    }
  }
  if (baked) {
    mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      dithering: true,
      map: baked.albedo,
      normalMap: baked.normal,
      roughnessMap: baked.roughness,
    });
  } else {
    groundMat = createGroundMaterial(lib, map);
    mat = groundMat.material;
  }
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  ground.castShadow = false;
  ground.name = 'terrain';
  group.add(ground);

  // ---- sea -------------------------------------------------------------------
  // Half-float heightfield: an 8-bit encoding of a 38 m range steps in 15 cm slices, which
  // quantises the shallow gradient into the flat colour bands that give away a cheap sea.
  const depthData = new Uint16Array(mverts * mverts * 4);
  for (let iz = 0; iz < mverts; iz++) {
    for (let ix = 0; ix < mverts; ix++) {
      const i = iz * mverts + ix;
      const half = THREE.DataUtils.toHalfFloat(sampleH(ix, iz));
      depthData[i * 4] = half;
      depthData[i * 4 + 1] = half;
      depthData[i * 4 + 2] = half;
      depthData[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const depthTex = new THREE.DataTexture(depthData, mverts, mverts, THREE.RGBAFormat, THREE.HalfFloatType);
  depthTex.minFilter = THREE.LinearFilter;
  depthTex.magFilter = THREE.LinearFilter;
  depthTex.wrapS = depthTex.wrapT = THREE.ClampToEdgeWrapping;
  depthTex.needsUpdate = true;

  const wave = makeWaveNormal();
  const skyTex = (gs.scene.background as THREE.Texture) ?? null;
  const waterMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uDepth: { value: depthTex },
      uSky: { value: skyTex },
      uWave: { value: wave },
      uTime: { value: 0 },
      uWorldSize: { value: worldSize },
      uSunDir: { value: sunDirection() },
      uSunColor: { value: SUN_COLOR.clone() },
      uShallow: { value: new THREE.Color(0x5ccfc0) },
      uDeep: { value: new THREE.Color(0x2a7f9e) },
      uFoam: { value: new THREE.Color(0xeef9f8) },
      uHasSky: { value: skyTex ? 1 : 0 },
      uDebug: {
        value:
          new URLSearchParams(location.search).get('water') === 'flat'
            ? 1
            : new URLSearchParams(location.search).get('water') === 'depth'
              ? 2
              : 0,
      },
    },
  });
  // The sea is a fixed coastal band around the playable square (see `SEA_BAND`), wide enough
  // to hold the horizon at the default view. `update()` scales it up as the camera rises, so
  // a full zoom-out never shows its far edge while the default view never pays for 1000 m of
  // water: the shader samples the depth field in *world* units, so scaling the mesh does not
  // move a single wave or shoreline.
  const seaHalf = worldSize * 0.5 + SEA_BAND;
  const waterGeo = new THREE.PlaneGeometry(seaHalf * 2, seaHalf * 2, 1, 1);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set(worldSize / 2, map.waterLevel, worldSize / 2);
  water.renderOrder = 2;
  group.add(water);

  // A darker "deep ocean floor" so the transparent water does not reveal the sky beneath.
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x0a2f42 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(seaHalf * 2, seaHalf * 2), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(worldSize / 2, minH - 0.6, worldSize / 2);
  group.add(floor);

  const heightAt = (x: number, z: number): number => {
    const gx = Math.min(map.grid, Math.max(0, x / cell));
    const gz = Math.min(map.grid, Math.max(0, z / cell));
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const ix1 = Math.min(map.grid, ix + 1);
    const iz1 = Math.min(map.grid, iz + 1);
    const tx = gx - ix;
    const tz = gz - iz;
    const h00 = map.heights[iz * verts + ix];
    const h10 = map.heights[iz * verts + ix1];
    const h01 = map.heights[iz1 * verts + ix];
    const h11 = map.heights[iz1 * verts + ix1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };

  void maxH;
  return {
    group,
    ground,
    water,
    heightAt,
    updateFromMap(next: MapBuffers, dirty?: GroundRect) {
      // Vertex 0 to `mverts - 1` covers the whole mesh; a rect narrows it to what an edit actually
      // touched. A full pass over a big battlefield is 263k vertices of sin/cos and half-float
      // conversion — 48 ms measured — whereas a brush dab touches a few thousand, so the editor
      // hands in the rect and painting stays interactive instead of dropping to 20 fps.
      let x0 = 0;
      let z0 = 0;
      let x1 = mverts - 1;
      let z1 = mverts - 1;
      if (dirty) {
        const sub = SUB;
        x0 = Math.max(0, Math.floor((dirty.x0 / mcell) * sub) - 1);
        z0 = Math.max(0, Math.floor((dirty.z0 / mcell) * sub) - 1);
        x1 = Math.min(mverts - 1, Math.ceil((dirty.x1 / mcell) * sub) + 1);
        z1 = Math.min(mverts - 1, Math.ceil((dirty.z1 / mcell) * sub) + 1);
      }
      // The rectangle the *normals* need is one wider on every side: a normal is a difference of
      // its neighbours, so a ridge just outside the edit still tilts the vertices inside it.
      const nx0 = Math.max(0, x0 - 1);
      const nz0 = Math.max(0, z0 - 1);
      const nx1 = Math.min(mverts - 1, x1 + 1);
      const nz1 = Math.min(mverts - 1, z1 + 1);
      const touchedNormals = x0 !== 0 || z0 !== 0 || x1 !== mverts - 1 || z1 !== mverts - 1;

      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const i = iz * mverts + ix;
          const h = next.heights[iz * verts + ix];
          positions[i * 3 + 1] = h;
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
          const [cr, cg, cb] = shadeAt(h, ix * mcell, iz * mcell);
          colors[i * 3] = cr;
          colors[i * 3 + 1] = cg;
          colors[i * 3 + 2] = cb;
        }
      }
      for (let iz = nz0; iz <= nz1; iz++) {
        for (let ix = nx0; ix <= nx1; ix++) {
          const i = iz * mverts + ix;
          const hx0 = next.heights[iz * verts + Math.max(0, ix - 1)];
          const hx1 = next.heights[iz * verts + Math.min(mverts - 1, ix + 1)];
          const hz0 = next.heights[Math.max(0, iz - 1) * verts + ix];
          const hz1 = next.heights[Math.min(mverts - 1, iz + 1) * verts + ix];
          // Straight into the buffer: a `Vector3` per vertex is 263k allocations a frame.
          const dx = (hx1 - hx0) / (2 * mcell);
          const dz = (hz1 - hz0) / (2 * mcell);
          const len = Math.hypot(dx, 1, dz) || 1;
          normals[i * 3] = -dx / len;
          normals[i * 3 + 1] = 1 / len;
          normals[i * 3 + 2] = -dz / len;
        }
      }
      const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
      const nrmAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
      const colAttr = geo.getAttribute('color') as THREE.BufferAttribute;
      posAttr.needsUpdate = true;
      nrmAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      // three.js treats update ranges as an *exact* upload list, not a hint: whatever is not
      // listed here never reaches the GPU. The vertex array is row-major, so a rect spans several
      // disjoint rows and each needs its own range — a single range only ever covered the first
      // row, which left every brush stroke invisible on the mesh while the wasm heights changed
      // underneath (the "water cannot be removed" bug). A full pass is one contiguous range.
      const uploadRows = (attr: THREE.BufferAttribute, ax0: number, az0: number, ax1: number, az1: number): void => {
        if (!attr.addUpdateRange) return; // pre-range three uploads everything on needsUpdate
        if (ax0 === 0 && az0 === 0 && ax1 === mverts - 1 && az1 === mverts - 1) {
          attr.addUpdateRange(0, mverts * mverts * 3);
        } else {
          for (let iz = az0; iz <= az1; iz++) attr.addUpdateRange((iz * mverts + ax0) * 3, (ax1 - ax0 + 1) * 3);
        }
      };
      uploadRows(posAttr, x0, z0, x1, z1);
      // Normals were recomputed one vertex wider than the heights; colours exactly where written.
      uploadRows(nrmAttr, nx0, nz0, nx1, nz1);
      uploadRows(colAttr, x0, z0, x1, z1);
      if (!touchedNormals) geo.computeBoundingSphere();
      // Sea depth: the same field the water shader reads, re-sampled over the same rect.
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const i = iz * mverts + ix;
          const half = THREE.DataUtils.toHalfFloat(next.heights[iz * verts + ix]);
          depthData[i * 4] = half;
          depthData[i * 4 + 1] = half;
          depthData[i * 4 + 2] = half;
        }
      }
      depthTex.needsUpdate = true;
      groundMat?.updateMasks(next, dirty);
    },
    update(time: number, cameraPos: THREE.Vector3) {
      waterMat.uniforms.uTime.value = time;
      // Keep the sea centred on the camera so it always reaches the horizon, and grow it with
      // the camera height: the ground distance the top of the frame sees is roughly
      // `height / tan(35 deg)`, so 2.4x the height of extra radius always covers it.
      const want = seaHalf + Math.max(0, cameraPos.y) * 2.4;
      const k = want / seaHalf;
      water.scale.setScalar(k);
      floor.scale.setScalar(k);
      water.position.x = cameraPos.x;
      water.position.z = cameraPos.z;
      floor.position.x = cameraPos.x;
      floor.position.z = cameraPos.z;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      groundMat?.dispose();
      waterGeo.dispose();
      waterMat.dispose();
      baked?.dispose();
      depthTex.dispose();
      floorMat.dispose();
      floor.geometry.dispose();
    },
  };
}
