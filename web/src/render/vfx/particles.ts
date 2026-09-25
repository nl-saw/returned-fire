/**
 * Pooled GPU particle family.
 *
 * One family = one `InstancedBufferGeometry` (a unit quad) + one custom `ShaderMaterial`,
 * i.e. exactly one draw call, with a fixed capacity chosen up front. Live particles are kept
 * compacted at the front of every array, so the per-frame upload only covers the live range.
 *
 * The whole simulation runs on the CPU over flat `Float32Array`s: no per-particle objects,
 * no closures, no allocation in `update()`.
 */
import * as THREE from 'three';
import { clamp } from './rand.js';

/** Behaviour bits stored per particle. */
export const PFLAG = {
  /** Collide with the terrain height cached at spawn time. */
  GROUND: 1,
  /** Die (instead of bouncing) when touching the ground — rain/spray droplets. */
  DIE_ON_GROUND: 2,
} as const;

/** Colour ramp: stop times in [0,1] plus linear-space rgb per stop. */
export interface ParticleRamp {
  times: Float32Array;
  colors: Float32Array;
}

/** Build a ramp from `[time, hex]` stops. Hex values are sRGB and get linearised. */
export function makeRamp(stops: ReadonlyArray<readonly [number, number]>): ParticleRamp {
  const times = new Float32Array(stops.length);
  const colors = new Float32Array(stops.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < stops.length; i++) {
    times[i] = stops[i][0];
    c.setHex(stops[i][1], THREE.SRGBColorSpace);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  return { times, colors };
}

/**
 * Spawn parameters. Emitters reuse a single instance (see `defaultSeed`) so spawning a
 * particle never allocates.
 */
export interface ParticleSeed {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Diameter in metres at birth and at death — fire shrinks as it cools, smoke grows. */
  size0: number; size1: number;
  rot: number; rotVel: number;
  /** Seconds. `delay` keeps the particle dormant (invisible) before it starts. */
  life: number; delay: number;
  alpha: number;
  /** Linear rgb multipliers applied on top of the ramp, lerped across the life. */
  r: number; g: number; b: number;
  r1: number; g1: number; b1: number;
  /** Sub-range of the family ramp this particle walks through. */
  ramp0: number; rampSpan: number;
  /** Per-second velocity damping. */
  drag: number;
  /** Downward acceleration (m/s²). */
  gravity: number;
  /** Buoyancy (m/s², positive = upwards). */
  rise: number;
  /** How strongly the global wind pushes this particle (0..1). */
  wind: number;
  /** 0 = round billboard, 1 = fully stretched along its velocity. */
  stretch: number;
  /** Ground bounce restitution. */
  bounce: number;
  /** Fraction of life spent fading in. */
  fadeIn: number;
  /** >0 = may evict a live particle when the pool is full; <=0 = droppable. */
  priority: number;
  /** Terrain height cached at spawn (metres). */
  groundY: number;
  flags: number;
}

export function defaultSeed(): ParticleSeed {
  return {
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    size0: 1, size1: 1,
    rot: 0, rotVel: 0,
    life: 1, delay: 0,
    alpha: 1,
    r: 1, g: 1, b: 1,
    r1: 1, g1: 1, b1: 1,
    ramp0: 0, rampSpan: 1,
    drag: 0, gravity: 0, rise: 0, wind: 0,
    stretch: 0, bounce: 0, fadeIn: 0.08,
    priority: 1, groundY: 0, flags: 0,
  };
}

export interface FamilyOptions {
  capacity: number;
  texture: THREE.Texture;
  ramp: ParticleRamp;
  /** Additive (fire, sparks, tracers) vs alpha blended (smoke, dust, spray). */
  additive: boolean;
  /** Flat: the quad lies in the world XZ plane (ground rings) instead of billboarding. */
  flat?: boolean;
  /** Elongation applied to fully stretched particles. */
  stretch?: number;
  /** Longest half-length a stretched particle may reach, in world metres. */
  stretchMax?: number;
  /**
   * The sprite is a streak (a tracer) rather than a round blob. A particle whose velocity
   * points into or out of the screen has no screen-space direction to stretch along: a round
   * sprite is fine as a plain billboard there, but a streak would be a beam pointing nowhere,
   * so a streaked family draws only the head of its texture and reads as a dot.
   */
  streak?: boolean;
  /** Extra detail map (usually from the SurfaceLibrary) modulating alpha + luminance. */
  detail?: THREE.Texture | null;
  detailAmount?: number;
  renderOrder?: number;
  /** Debug/quality label, also used as the mesh name. */
  name?: string;
}

const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

const SPRITE_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec3 iCol;
attribute vec4 iData;   // x size, y rotation, z alpha, w seed
attribute vec2 iMisc;   // x stretch, y lambert amount
uniform float uSizeScale;
uniform float uStretch;
uniform float uStretchMax;
uniform float uStreak;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
varying float vLit;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vToCam;

void main() {
  float size = iData.x * uSizeScale;
  float cs = cos(iData.y);
  float sn = sin(iData.y);
  vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs) * size;

  float st = iMisc.x;
  float asDot = 0.0;
  if (st > 0.002) {
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    vec2 ax = vv.xy;
    float l = length(ax);
    if (l < length(vv) * 0.06) {
      // Travelling into or out of the screen: there is no screen-space direction to stretch
      // along, so draw the round dot instead of a beam along numerical noise. A streak-shaped
      // sprite has to change shape for that (see the vUv below); a round one does not.
      st = 0.0;
      asDot = uStreak;
    } else {
      ax /= l;
      // NOTE: the perpendicular is (ax.y, -ax.x), not (-ax.y, ax.x): the other choice mirrors
      // the quad (negative determinant) which flips its winding and gets it back-face culled.
      vec2 px = vec2(ax.y, -ax.x);
      // uStretch is a multiple of the sprite size, so an uncapped tracer came out 24 m long.
      // Cap the elongation in WORLD metres: a tracer is a streak of a few metres, not a beam
      // the length of a football pitch.
      float lenScale = mix(1.0, min(uStretch, uStretchMax / max(size, 1e-3)), st);
      float wide = mix(1.0, 0.55, st);
      // Lay the quad's own axes across and along the particle's screen direction. Writing the
      // two projections straight back into screen x/y instead (the old vec2 of dot(q, px) * wide
      // and dot(q, ax) * lenScale) scaled the quad along the SCREEN y axis whatever the particle
      // was flying at, so every stretched tracer came out as a screen-vertical spindle.
      q = px * (q.x * wide) + ax * (q.y * lenScale);
    }
  }

  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += q;
  gl_Position = projectionMatrix * mv;

  vec2 uv = position.xy * 0.5 + 0.5;
  // A streak sprite with no screen direction: sample the bright head of the texture only, so
  // the tracer degrades into a dot instead of an axis-aligned streak.
  vUv = mix(uv, vec2(0.5, 0.25) + (uv - 0.5) * 0.5, asDot);
  vCol = iCol;
  vAlpha = iData.z;
  vLit = iMisc.y;
  vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vToCam = normalize(cameraPosition - iPos);
}
`;

const SPRITE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uDetail;
uniform float uDetailAmount;
uniform float uDetailScale;
uniform float uOpacity;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
varying float vLit;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vToCam;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float alpha = tex.a * vAlpha * uOpacity;
  if (alpha < 0.0035) discard;

  vec3 col = vCol * tex.rgb;

  // Spherical normal over the billboard so sunlit dust reads as volume.
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = min(dot(p, p), 1.0);
  vec3 n = normalize(vRight * p.x + vUp * p.y + vToCam * sqrt(max(0.0, 1.0 - r2)));
  float wrap = clamp(dot(n, uSunDir) * 0.62 + 0.44, 0.0, 1.0);
  col *= mix(vec3(1.0), vec3(0.34 + 0.86 * wrap), vLit);

  if (uDetailAmount > 0.0) {
    vec3 dtex = texture2D(uDetail, vUv * uDetailScale + vec2(vUv.y * 0.37, vUv.x * 0.11)).rgb;
    float dl = sqrt(clamp(dot(dtex, vec3(0.299, 0.587, 0.114)), 0.0, 1.0));
    float w = uDetailAmount;
    col *= mix(1.0, 0.55 + 0.95 * dl, w);
    alpha *= mix(1.0, 0.70 + 0.60 * dl, w * 0.8);
  }

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FLAT_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iCol;
attribute vec4 iData;   // x size, y rotation, z alpha, w seed
uniform float uSizeScale;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;

void main() {
  float size = iData.x * uSizeScale;
  float cs = cos(iData.y);
  float sn = sin(iData.y);
  vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs) * size;
  vec3 wp = iPos + vec3(q.x, 0.0, q.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
  vUv = position.xy * 0.5 + 0.5;
  vCol = iCol;
  vAlpha = iData.z;
}
`;

const FLAT_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float alpha = tex.a * vAlpha * uOpacity;
  if (alpha < 0.0035) discard;
  gl_FragColor = vec4(vCol * tex.rgb, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ParticleFamily {
  readonly capacity: number;
  readonly mesh: THREE.Mesh;
  /** Live particle count (delayed particles included). */
  count = 0;
  /** Active capacity — lowered by the quality knob without reallocating. */
  limit: number;

  private readonly cap: number;
  private evict = 0;
  private readonly flat: boolean;
  private readonly ramp: ParticleRamp;

  // CPU simulation state.
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly ttl: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly rot: Float32Array;
  private readonly rotVel: Float32Array;
  private readonly alpha: Float32Array;
  private readonly ramp0: Float32Array;
  private readonly rampSpan: Float32Array;
  private readonly tintA: Float32Array;
  private readonly tintB: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private readonly rise: Float32Array;
  private readonly wind: Float32Array;
  private readonly stretch: Float32Array;
  private readonly bounce: Float32Array;
  private readonly fadeIn: Float32Array;
  private readonly groundY: Float32Array;
  private readonly pflags: Uint8Array;
  private readonly seed: Float32Array;

  // GPU attributes.
  private readonly aPos: Float32Array;
  private readonly aVel: Float32Array;
  private readonly aCol: Float32Array;
  private readonly aData: Float32Array;
  private readonly aMisc: Float32Array;
  private readonly gPos: THREE.InstancedBufferAttribute;
  private readonly gVel: THREE.InstancedBufferAttribute;
  private readonly gCol: THREE.InstancedBufferAttribute;
  private readonly gData: THREE.InstancedBufferAttribute;
  private readonly gMisc: THREE.InstancedBufferAttribute;

  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly detailAmount: number;

  constructor(opts: FamilyOptions) {
    const cap = Math.max(1, opts.capacity | 0);
    this.cap = cap;
    this.capacity = cap;
    this.limit = cap;
    this.flat = opts.flat === true;
    this.ramp = opts.ramp;
    this.detailAmount = opts.detailAmount ?? 0;

    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.ttl = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.size1 = new Float32Array(cap);
    this.rot = new Float32Array(cap);
    this.rotVel = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.ramp0 = new Float32Array(cap);
    this.rampSpan = new Float32Array(cap);
    this.tintA = new Float32Array(cap * 3);
    this.tintB = new Float32Array(cap * 3);
    this.drag = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.rise = new Float32Array(cap);
    this.wind = new Float32Array(cap);
    this.stretch = new Float32Array(cap);
    this.bounce = new Float32Array(cap);
    this.fadeIn = new Float32Array(cap);
    this.groundY = new Float32Array(cap);
    this.pflags = new Uint8Array(cap);
    this.seed = new Float32Array(cap);
    for (let i = 0; i < cap; i++) this.ttl[i] = 1;

    this.aPos = new Float32Array(cap * 3);
    this.aVel = new Float32Array(cap * 3);
    this.aCol = new Float32Array(cap * 3);
    this.aData = new Float32Array(cap * 4);
    this.aMisc = new Float32Array(cap * 2);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
    geo.setIndex(QUAD_INDEX);
    this.gPos = new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.gVel = new THREE.InstancedBufferAttribute(this.aVel, 3).setUsage(THREE.DynamicDrawUsage);
    this.gCol = new THREE.InstancedBufferAttribute(this.aCol, 3).setUsage(THREE.DynamicDrawUsage);
    this.gData = new THREE.InstancedBufferAttribute(this.aData, 4).setUsage(THREE.DynamicDrawUsage);
    this.gMisc = new THREE.InstancedBufferAttribute(this.aMisc, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.gPos);
    geo.setAttribute('iCol', this.gCol);
    geo.setAttribute('iData', this.gData);
    geo.setAttribute('iMisc', this.gMisc);
    if (!this.flat) geo.setAttribute('iVel', this.gVel);
    geo.instanceCount = 0;
    this.geometry = geo;

    const uniforms: Record<string, THREE.IUniform> = {
      uMap: { value: opts.texture },
      uSizeScale: { value: 1 },
      uOpacity: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.45).normalize() },
      uDetail: { value: opts.detail ?? null },
      uDetailAmount: { value: this.detailAmount },
      uDetailScale: { value: 2.7 },
      uStretch: { value: opts.stretch ?? 6 },
      uStretchMax: { value: opts.stretchMax ?? 2.0 },
      uStreak: { value: opts.streak === true ? 1 : 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: this.flat ? FLAT_VERT : SPRITE_VERT,
      fragmentShader: this.flat ? FLAT_FRAG : SPRITE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: this.flat ? THREE.DoubleSide : THREE.FrontSide,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = opts.renderOrder ?? 10;
    this.mesh.visible = false;
    this.mesh.name = opts.name ? `vfx-${opts.name}` : 'vfx-particles';
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  /** Quality knob: shrink the usable part of the pool (no reallocation). */
  setLimit(n: number): void {
    const v = clamp(n | 0, 8, this.cap);
    this.limit = v;
    if (this.count > v) this.count = v;
  }

  setScale(scale: number): void {
    this.material.uniforms.uSizeScale.value = scale;
  }

  setDetailAmount(amount: number): void {
    this.material.uniforms.uDetailAmount.value = amount;
  }

  /**
   * Spawn one particle. Returns its slot (so the owner can keep steering it), or -1 when the
   * pool is full and the particle was droppable.
   */
  emit(sp: ParticleSeed): number {
    let slot: number;
    if (this.count < this.limit) {
      slot = this.count++;
    } else {
      const win = Math.min(48, this.limit);
      let best = 0;
      let bestT = -Infinity;
      for (let k = 0; k < win; k++) {
        const s = (this.evict + k) % this.limit;
        const t = this.age[s] / this.ttl[s];
        if (t > bestT) {
          bestT = t;
          best = s;
        }
      }
      this.evict = (best + 1) % this.limit;
      if (bestT < 0.5 && sp.priority < 1) return -1;
      slot = best;
    }

    this.px[slot] = sp.x;
    this.py[slot] = sp.y;
    this.pz[slot] = sp.z;
    this.vx[slot] = sp.vx;
    this.vy[slot] = sp.vy;
    this.vz[slot] = sp.vz;
    this.age[slot] = -sp.delay;
    this.ttl[slot] = Math.max(0.016, sp.life);
    this.size0[slot] = sp.size0;
    this.size1[slot] = sp.size1;
    this.rot[slot] = sp.rot;
    this.rotVel[slot] = sp.rotVel;
    this.alpha[slot] = sp.alpha;
    this.ramp0[slot] = sp.ramp0;
    this.rampSpan[slot] = sp.rampSpan;
    const t3 = slot * 3;
    this.tintA[t3] = sp.r;
    this.tintA[t3 + 1] = sp.g;
    this.tintA[t3 + 2] = sp.b;
    this.tintB[t3] = sp.r1;
    this.tintB[t3 + 1] = sp.g1;
    this.tintB[t3 + 2] = sp.b1;
    this.drag[slot] = sp.drag;
    this.grav[slot] = sp.gravity;
    this.rise[slot] = sp.rise;
    this.wind[slot] = sp.wind;
    this.stretch[slot] = sp.stretch;
    this.bounce[slot] = sp.bounce;
    this.fadeIn[slot] = sp.fadeIn;
    this.groundY[slot] = sp.groundY;
    this.pflags[slot] = sp.flags;
    this.seed[slot] = this.seedOf(slot);
    return slot;
  }

  /** Cheap, stable per-slot random in [0,1) — reused as texture rotation/phase. */
  private seedOf(slot: number): number {
    let h = Math.imul(slot + 1, 2654435761) ^ Math.imul((this.count + 17) | 0, 40503);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  setVelocity(slot: number, x: number, y: number, z: number): void {
    if (slot < 0 || slot >= this.count) return;
    this.vx[slot] = x;
    this.vy[slot] = y;
    this.vz[slot] = z;
  }

  setStretch(slot: number, amount: number): void {
    if (slot < 0 || slot >= this.count) return;
    this.stretch[slot] = amount;
  }

  alive(slot: number): boolean {
    return slot >= 0 && slot < this.count;
  }

  getPosition(slot: number, out: THREE.Vector3): THREE.Vector3 {
    if (slot < 0 || slot >= this.count) return out.set(0, 0, 0);
    return out.set(this.px[slot], this.py[slot], this.pz[slot]);
  }

  /** Drop a particle by swapping the last live one into its slot. */
  private swapRemove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.age[i] = this.age[last];
      this.ttl[i] = this.ttl[last];
      this.size0[i] = this.size0[last];
      this.size1[i] = this.size1[last];
      this.rot[i] = this.rot[last];
      this.rotVel[i] = this.rotVel[last];
      this.alpha[i] = this.alpha[last];
      this.ramp0[i] = this.ramp0[last];
      this.rampSpan[i] = this.rampSpan[last];
      const i3 = i * 3;
      const l3 = last * 3;
      this.tintA[i3] = this.tintA[l3];
      this.tintA[i3 + 1] = this.tintA[l3 + 1];
      this.tintA[i3 + 2] = this.tintA[l3 + 2];
      this.tintB[i3] = this.tintB[l3];
      this.tintB[i3 + 1] = this.tintB[l3 + 1];
      this.tintB[i3 + 2] = this.tintB[l3 + 2];
      this.drag[i] = this.drag[last];
      this.grav[i] = this.grav[last];
      this.rise[i] = this.rise[last];
      this.wind[i] = this.wind[last];
      this.stretch[i] = this.stretch[last];
      this.bounce[i] = this.bounce[last];
      this.fadeIn[i] = this.fadeIn[last];
      this.groundY[i] = this.groundY[last];
      this.pflags[i] = this.pflags[last];
      this.seed[i] = this.seed[last];
    }
  }

  /** Evaluate the family ramp at `t` into `out3`. */
  private rampAt(t: number, out: Float32Array, o: number): void {
    const times = this.ramp.times;
    const cols = this.ramp.colors;
    const u = clamp(t, 0, 1);
    let s = 0;
    while (s < times.length - 2 && u > times[s + 1]) s++;
    const t0 = times[s];
    const t1 = times[s + 1];
    const f = t1 > t0 ? (u - t0) / (t1 - t0) : 0;
    const a = s * 3;
    const b = a + 3;
    out[o] = cols[a] + (cols[b] - cols[a]) * f;
    out[o + 1] = cols[a + 1] + (cols[b + 1] - cols[a + 1]) * f;
    out[o + 2] = cols[a + 2] + (cols[b + 2] - cols[a + 2]) * f;
  }

  private scratch = new Float32Array(3);

  /**
   * Advance the simulation and repack the GPU attributes. O(live particles), allocation free.
   * `nearX/Y/Z` fade particles that are about to swallow the camera.
   */
  update(dt: number, windX: number, windZ: number, nearX: number, nearY: number, nearZ: number): void {
    const { px, py, pz, vx, vy, vz, age, ttl, size0, size1, rot, rotVel, alpha, ramp0, rampSpan } = this;
    const { tintA, tintB, drag, grav, rise, wind, stretch, bounce, fadeIn, groundY, pflags, seed } = this;
    const aPos = this.aPos;
    const aVel = this.aVel;
    const aCol = this.aCol;
    const aData = this.aData;
    const aMisc = this.aMisc;
    const col = this.scratch;
    const near2 = 9;
    let i = 0;
    while (i < this.count) {
      const a = age[i] + dt;
      age[i] = a;
      if (a < 0) {
        // Dormant: park it off screen so it never rasterises.
        const i4 = i * 4;
        aData[i4] = 0;
        aData[i4 + 1] = 0;
        aData[i4 + 2] = 0;
        aData[i4 + 3] = seed[i];
        aPos[i * 3] = px[i];
        aPos[i * 3 + 1] = -1000;
        aPos[i * 3 + 2] = pz[i];
        i++;
        continue;
      }
      const life = ttl[i];
      if (a >= life) {
        this.swapRemove(i);
        continue;
      }
      const t = a / life;

      let nvx = vx[i];
      let nvy = vy[i];
      let nvz = vz[i];
      nvy += (rise[i] - grav[i]) * dt;
      let d = 1 - drag[i] * dt;
      if (d < 0) d = 0;
      nvx = nvx * d + windX * wind[i] * dt;
      nvy *= d;
      nvz = nvz * d + windZ * wind[i] * dt;

      let x = px[i] + nvx * dt;
      let y = py[i] + nvy * dt;
      let z = pz[i] + nvz * dt;

      const fl = pflags[i];
      if ((fl & PFLAG.GROUND) !== 0) {
        const g = groundY[i] + 0.02;
        if (y < g) {
          if ((fl & PFLAG.DIE_ON_GROUND) !== 0) {
            this.swapRemove(i);
            continue;
          }
          y = g;
          if (nvy < 0) nvy = -nvy * bounce[i];
          if (nvy < 0.4) nvy = 0;
          nvx *= 0.7;
          nvz *= 0.7;
        }
      }

      px[i] = x;
      py[i] = y;
      pz[i] = z;
      vx[i] = nvx;
      vy[i] = nvy;
      vz[i] = nvz;
      let r = rot[i] + rotVel[i] * dt;
      if (r > 6.2831853) r -= 6.2831853;
      else if (r < 0) r += 6.2831853;
      rot[i] = r;

      // Alpha: fade in, hold, fade the last 20% of life so nothing pops.
      let al = alpha[i];
      const fi = fadeIn[i];
      if (fi > 0 && t < fi) al *= t / fi;
      if (t > 0.8) al *= (1 - t) * 5;

      // Do not let a puff swallow the camera.
      const dx = x - nearX;
      const dy = y - nearY;
      const dz = z - nearZ;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 < near2) al *= Math.sqrt(dist2) * 0.3333333;

      this.rampAt(ramp0[i] + rampSpan[i] * t, col, 0);
      const i3 = i * 3;
      const tr = tintA[i3] + (tintB[i3] - tintA[i3]) * t;
      const tg = tintA[i3 + 1] + (tintB[i3 + 1] - tintA[i3 + 1]) * t;
      const tb = tintA[i3 + 2] + (tintB[i3 + 2] - tintA[i3 + 2]) * t;
      aCol[i3] = col[0] * tr;
      aCol[i3 + 1] = col[1] * tg;
      aCol[i3 + 2] = col[2] * tb;
      aPos[i3] = x;
      aPos[i3 + 1] = y;
      aPos[i3 + 2] = z;
      const i4 = i * 4;
      aData[i4] = size0[i] + (size1[i] - size0[i]) * t;
      aData[i4 + 1] = r;
      aData[i4 + 2] = al;
      aData[i4 + 3] = seed[i];
      const i2 = i * 2;
      aMisc[i2] = stretch[i];
      aMisc[i2 + 1] = this.litAmount;
      if (!this.flat) {
        aVel[i3] = nvx;
        aVel[i3 + 1] = nvy;
        aVel[i3 + 2] = nvz;
      }
      i++;
    }
    this.flush();
  }

  /** Per-particle lambert weight for this family (dust catches the sun, fire does not). */
  litAmount = 0;

  private flush(): void {
    const n = this.count;
    if (n === 0) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.geometry.instanceCount = n;
    const a = this.geometry.attributes;
    (a.iPos as THREE.InstancedBufferAttribute).addUpdateRange(0, n * 3);
    (a.iPos as THREE.InstancedBufferAttribute).needsUpdate = true;
    (a.iCol as THREE.InstancedBufferAttribute).addUpdateRange(0, n * 3);
    (a.iCol as THREE.InstancedBufferAttribute).needsUpdate = true;
    (a.iData as THREE.InstancedBufferAttribute).addUpdateRange(0, n * 4);
    (a.iData as THREE.InstancedBufferAttribute).needsUpdate = true;
    (a.iMisc as THREE.InstancedBufferAttribute).addUpdateRange(0, n * 2);
    (a.iMisc as THREE.InstancedBufferAttribute).needsUpdate = true;
    if (!this.flat) {
      (a.iVel as THREE.InstancedBufferAttribute).addUpdateRange(0, n * 3);
      (a.iVel as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  /** Hide everything without touching the simulation (used when the whole layer is idle). */
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
