/**
 * Ground decal pool — scorch marks and craters.
 *
 * Decals are one instanced quad draw call. They are multiplied into the framebuffer
 * (`ZERO / SRC_COLOR`) instead of alpha blended, so a scorch mark darkens the terrain under
 * it like real soot, never washes out in bright sun, and needs no depth sorting. Each decal
 * is oriented along the terrain normal sampled at spawn time and lifted a few centimetres
 * along it so it cannot z-fight the ground.
 */
import * as THREE from 'three';
import { clamp } from './rand.js';

const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

const DECAL_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iNrm;
attribute vec4 iData;   // x radius, y rotation, z strength, w seed
varying vec2 vUv;
varying vec3 vWorld;
varying float vStrength;
varying float vSeed;

void main() {
  vec3 n = normalize(iNrm);
  vec3 t = normalize(cross(vec3(0.0, 0.0, 1.0), n) + vec3(1e-4, 0.0, 0.0));
  vec3 b = cross(n, t);
  float cs = cos(iData.y);
  float sn = sin(iData.y);
  vec2 p = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs) * iData.x;
  vec3 wp = iPos + t * p.x + b * p.y;
  vWorld = wp;
  vUv = position.xy * 0.5 + 0.5;
  vStrength = iData.z;
  vSeed = iData.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const DECAL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uLib;
uniform float uLibScale;
uniform float uLibAmount;
varying vec2 vUv;
varying vec3 vWorld;
varying float vStrength;
varying float vSeed;

void main() {
  vec4 proc = texture2D(uMap, vUv);
  float strength = proc.a * vStrength;
  if (strength < 0.004) discard;

  // The procedural map is authored in display space so 8-bit darks keep their precision.
  vec3 mult = pow(max(proc.rgb, vec3(0.0)), vec3(2.2));
  if (uLibAmount > 0.0) {
    vec3 lib = texture2D(uLib, vWorld.xz * uLibScale + vSeed * 0.37).rgb;
    float lm = clamp(dot(lib, vec3(0.299, 0.587, 0.114)) * 3.0, 0.45, 1.25);
    mult *= mix(1.0, lm, uLibAmount);
  }

  gl_FragColor = vec4(mix(vec3(1.0), mult, strength), 1.0);
  #include <colorspace_fragment>
}
`;

export interface DecalSpawn {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  radius: number;
  rot: number;
  /** 0..1 initial burn strength. */
  strength: number;
  life: number;
  /** Offset along the surface normal, metres. */
  lift: number;
}

export class DecalPool {
  readonly mesh: THREE.Mesh;
  count = 0;
  private cap: number;
  private limit: number;
  private cursor = 0;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly nx: Float32Array;
  private readonly ny: Float32Array;
  private readonly nz: Float32Array;
  private readonly radius: Float32Array;
  private readonly rot: Float32Array;
  private readonly strength: Float32Array;
  private readonly age: Float32Array;
  private readonly ttl: Float32Array;
  private readonly seed: Float32Array;

  private readonly aPos: Float32Array;
  private readonly aNrm: Float32Array;
  private readonly aData: Float32Array;
  private readonly gPos: THREE.InstancedBufferAttribute;
  private readonly gNrm: THREE.InstancedBufferAttribute;
  private readonly gData: THREE.InstancedBufferAttribute;

  private readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;

  constructor(capacity: number, scorchTexture: THREE.Texture, libTexture: THREE.Texture, libWorldScale: number) {
    const cap = Math.max(1, capacity | 0);
    this.cap = cap;
    this.limit = cap;
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.nx = new Float32Array(cap);
    this.ny = new Float32Array(cap);
    this.nz = new Float32Array(cap);
    this.radius = new Float32Array(cap);
    this.rot = new Float32Array(cap);
    this.strength = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.ttl = new Float32Array(cap);
    this.seed = new Float32Array(cap);
    this.aPos = new Float32Array(cap * 3);
    this.aNrm = new Float32Array(cap * 3);
    this.aData = new Float32Array(cap * 4);
    for (let i = 0; i < cap; i++) this.ttl[i] = 1;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
    geo.setIndex(QUAD_INDEX);
    this.gPos = new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.gNrm = new THREE.InstancedBufferAttribute(this.aNrm, 3).setUsage(THREE.DynamicDrawUsage);
    this.gData = new THREE.InstancedBufferAttribute(this.aData, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.gPos);
    geo.setAttribute('iNrm', this.gNrm);
    geo.setAttribute('iData', this.gData);
    geo.instanceCount = 0;
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: scorchTexture },
        uLib: { value: libTexture },
        uLibScale: { value: 1 / Math.max(0.5, libWorldScale) },
        uLibAmount: { value: 0.55 },
      },
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    this.mesh.name = 'vfx-decals';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  setLimit(n: number): void {
    this.limit = clamp(n | 0, 4, this.cap);
    if (this.count > this.limit) this.count = this.limit;
  }

  /** Add a decal; recycles the oldest slot once the pool is full. Returns its slot. */
  spawn(d: DecalSpawn): number {
    let slot: number;
    if (this.count < this.limit) {
      slot = this.count++;
    } else {
      slot = this.cursor % this.limit;
      this.cursor = (slot + 1) % this.limit;
    }
    this.px[slot] = d.x + d.nx * d.lift;
    this.py[slot] = d.y + d.ny * d.lift;
    this.pz[slot] = d.z + d.nz * d.lift;
    const inv = 1 / Math.max(1e-4, Math.sqrt(d.nx * d.nx + d.ny * d.ny + d.nz * d.nz));
    this.nx[slot] = d.nx * inv;
    this.ny[slot] = d.ny * inv;
    this.nz[slot] = d.nz * inv;
    this.radius[slot] = d.radius;
    this.rot[slot] = d.rot;
    this.strength[slot] = d.strength;
    this.age[slot] = 0;
    this.ttl[slot] = Math.max(1, d.life);
    this.seed[slot] = (slot * 0.6180339887) % 1;
    const i3 = slot * 3;
    this.aPos[i3] = this.px[slot];
    this.aPos[i3 + 1] = this.py[slot];
    this.aPos[i3 + 2] = this.pz[slot];
    this.aNrm[i3] = this.nx[slot];
    this.aNrm[i3 + 1] = this.ny[slot];
    this.aNrm[i3 + 2] = this.nz[slot];
    this.writeData(slot, 0);
    return slot;
  }

  /** Grow an existing decal (a SCORCH event landing on the crater it belongs to). */
  reinforce(slot: number, radius: number, strength: number): void {
    if (slot < 0 || slot >= this.count) return;
    if (radius > this.radius[slot]) this.radius[slot] = radius;
    if (strength > this.strength[slot]) this.strength[slot] = strength;
    this.age[slot] = 0;
    this.writeData(slot, 0);
  }

  getRadius(slot: number): number {
    return slot >= 0 && slot < this.count ? this.radius[slot] : 0;
  }

  getX(slot: number): number {
    return slot >= 0 && slot < this.count ? this.px[slot] : 0;
  }

  getZ(slot: number): number {
    return slot >= 0 && slot < this.count ? this.pz[slot] : 0;
  }

  private writeData(slot: number, t: number): void {
    // Burn in fast (2% of life) then fade the last 35% so old craters wash out.
    const fade = t < 0.02 ? t / 0.02 : t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1;
    const i4 = slot * 4;
    this.aData[i4] = this.radius[slot];
    this.aData[i4 + 1] = this.rot[slot];
    this.aData[i4 + 2] = this.strength[slot] * clamp(fade, 0, 1);
    this.aData[i4 + 3] = this.seed[slot];
  }

  private swapRemove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.pz[i] = this.pz[last];
      this.nx[i] = this.nx[last];
      this.ny[i] = this.ny[last];
      this.nz[i] = this.nz[last];
      this.radius[i] = this.radius[last];
      this.rot[i] = this.rot[last];
      this.strength[i] = this.strength[last];
      this.age[i] = this.age[last];
      this.ttl[i] = this.ttl[last];
      this.seed[i] = this.seed[last];
      const i3 = i * 3;
      const l3 = last * 3;
      this.aPos[i3] = this.aPos[l3];
      this.aPos[i3 + 1] = this.aPos[l3 + 1];
      this.aPos[i3 + 2] = this.aPos[l3 + 2];
      this.aNrm[i3] = this.aNrm[l3];
      this.aNrm[i3 + 1] = this.aNrm[l3 + 1];
      this.aNrm[i3 + 2] = this.aNrm[l3 + 2];
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      const a = this.age[i] + dt;
      this.age[i] = a;
      if (a >= this.ttl[i]) {
        this.swapRemove(i);
        continue;
      }
      this.writeData(i, a / this.ttl[i]);
      i++;
    }
    if (this.count === 0) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.geometry.instanceCount = this.count;
    this.gPos.addUpdateRange(0, this.count * 3);
    this.gPos.needsUpdate = true;
    this.gNrm.addUpdateRange(0, this.count * 3);
    this.gNrm.needsUpdate = true;
    this.gData.addUpdateRange(0, this.count * 4);
    this.gData.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.mesh.visible = false;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
