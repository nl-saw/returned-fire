/**
 * Combat VFX layer — turns the simulation's flat event stream into explosions, smoke, dust,
 * tracers, water spray, debris and scorch decals.
 *
 * EKIND mapping (see `../sim/layout.ts`)
 * ---------------------------------------------------------------------------------------
 *  EXPLOSION         fireball + dark smoke + ground dust ring + sparks + light + crater decal
 *  BIG_EXPLOSION     as above, bigger/slower, plus a shockwave ring and flying debris
 *  MUZZLE_FLASH      brief oriented flame cone (heading resolved from the projectile that
 *                    leaves the muzzle in the same frame) + sparks + wisp + ground light
 *  IMPACT            metal: spark shower; ground: dust burst — both with a hot flash
 *  DUST              tyre/rotor dust puff that drifts, grows and fades
 *  WATER_SPLASH      vertical spray columns + mist + expanding foam ring on the water plane
 *  SMOKE_PUFF        damaged-vehicle smoke: dark, rising, long lived
 *  TRACER            fast bright streak (a = yaw, b = pitch, c = range) with a fading tail
 *  DEBRIS            arcing chunks that bounce off the terrain and settle
 *  SHOCKWAVE         expanding translucent ground ring + a dust front
 *  SCORCH            terrain decal (a = radius), merged into the crater of its own blast
 *  VEHICLE_DESTROYED burning wreck: big explosion + extra debris + a long smoke column
 *  SOUND / NOTIFY / FLAG_TAKEN / FLAG_CAPTURED / SKULL / NONE   UI + audio: ignored
 *
 * Everything is procedural: sprite atlases are generated on canvases at start-up, particle
 * families are pooled `InstancedBufferGeometry` quads with one custom `ShaderMaterial` each,
 * and the per-frame update walks flat `Float32Array`s without allocating.
 */
import * as THREE from 'three';
import type { SurfaceLibrary } from '../assets/types.js';
import { EKIND, PKIND, type EventView, type ProjectileView, type VehicleView } from '../sim/layout.js';
import { ParticleFamily, PFLAG, defaultSeed, makeRamp, type ParticleSeed } from './vfx/particles.js';
import { DecalPool } from './vfx/decals.js';
import { DebrisPool } from './vfx/debris.js';
import { LightPool } from './vfx/lights.js';
import { makeSprite, makeWhiteTexture, type SpriteKind } from './vfx/textures.js';
import { clamp, makeRng } from './vfx/rand.js';

export interface EffectsOptions {
  quality?: 'low' | 'medium' | 'high';
  maxParticles?: number;
  /**
   * Terrain height sampler in metres. Called at spawn time only (never per particle per
   * frame) so ground effects sit on the surface and decals can be tilted to the local slope.
   * Defaults to a flat y = 0.
   */
  terrainHeight?: (x: number, z: number) => number;
  /** Sun direction, pointing *towards* the sun. Defaults to the scene's first directional light. */
  sunDirection?: { x: number; y: number; z: number };
}

export interface Effects {
  /** Consume one simulation event (see EKIND). Called for every event, every frame. */
  spawn(e: EventView): void;
  /** Projectiles that need a live trail (rockets/missiles): called every frame. */
  trackProjectile(p: ProjectileView, dt: number): void;
  /**
   * Continuous soot for one surviving wreck. Called every frame for every wreck that should
   * smoke (the caller never passes a drone). Emission is throttled internally, so this costs
   * one timer compare per wreck on most frames.
   */
  trackWreck(v: VehicleView, dt: number): void;
  update(dt: number, camera: THREE.Camera): void;
  /** Quality/perf knobs. */
  setQuality(q: 'low' | 'medium' | 'high'): void;
  stats(): { particles: number; decals: number; drawCalls: number };
  /**
   * Wipe the ground decals — called when a round ends and when the map is rebuilt, the two
   * moments where craters on the ground stopped meaning anything.
   */
  clearDecals(): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ colour ramps */

const RAMP_FIRE = makeRamp([
  [0.0, 0xfff4d8],
  [0.09, 0xffd070],
  [0.26, 0xff8a1e],
  [0.52, 0xe03a04],
  [0.8, 0x5a1707],
  [1.0, 0x0d0705],
]);
/** Smoke starts white-hot while the fireball is alive, then cools into soot (see `ramp0`). */
const RAMP_SMOKE = makeRamp([
  [0.0, 0xff9c4e],
  [0.07, 0x8a5b3a],
  [0.18, 0x2f2b27],
  [0.55, 0x3d3832],
  [1.0, 0x5f584e],
]);
const RAMP_DUST = makeRamp([
  [0.0, 0xfdf2da],
  [0.45, 0xf0dcb4],
  [1.0, 0xd8c096],
]);
const RAMP_SPARK = makeRamp([
  [0.0, 0xfff4d2],
  [0.3, 0xffc247],
  [0.72, 0xff5a12],
  [1.0, 0x7a1a04],
]);
const RAMP_SPRAY = makeRamp([
  [0.0, 0xf4fcff],
  [0.55, 0xdcefff],
  [1.0, 0xc2dcef],
]);
const RAMP_RING = makeRamp([
  [0.0, 0xffe4b4],
  [0.35, 0xffab5e],
  [0.7, 0xd0601c],
  [1.0, 0x4a1a08],
]);
const RAMP_FOAM = makeRamp([
  [0.0, 0xffffff],
  [0.5, 0xf0f7ff],
  [1.0, 0xd8e7f2],
]);

/** Share of the particle budget per family (sums to 1). */
const FRACTION = {
  fire: 0.2,
  smoke: 0.24,
  dust: 0.2,
  spark: 0.12,
  spray: 0.08,
  tracer: 0.06,
  ring: 0.05,
  foam: 0.05,
} as const;

type Quality = 'low' | 'medium' | 'high';
const QUALITY_FACTOR: Record<Quality, number> = { low: 0.5, medium: 1, high: 1.5 };
const QUALITY_SIZE: Record<Quality, number> = { low: 1.14, medium: 1, high: 0.94 };

const TAU = Math.PI * 2;

function flatGround(_x: number, _z: number): number {
  return 0;
}

function safeMap(lib: SurfaceLibrary | undefined, key: 'smoke' | 'scorch'): THREE.Texture | null {
  const t = lib?.surfaces?.[key]?.map;
  return t && (t as THREE.Texture).isTexture ? t : null;
}

function safeWorldScale(lib: SurfaceLibrary | undefined, key: 'smoke' | 'scorch'): number {
  const s = lib?.surfaces?.[key]?.worldScale;
  return typeof s === 'number' && s > 0 ? s : 4;
}

/* ------------------------------------------------------------------- the factory */

export function createEffects(scene: THREE.Scene, lib: SurfaceLibrary, opts: EffectsOptions = {}): Effects {
  const rand = makeRng(0x9e3779b9);
  const terrain = opts.terrainHeight ?? flatGround;
  const baseBudget = Math.max(256, Math.floor(opts.maxParticles ?? 4000));
  // Allocate for the largest quality step so `setQuality` never reallocates a buffer.
  const alloc = Math.ceil(baseBudget * 1.5);
  // Doubled from 256: scorch/crater lifetimes are now ~104-140 s (was 52-70 s), so the steady-
  // state pool occupancy doubles too. Without the extra headroom, sustained fire would recycle
  // the oldest decals before their TTL and they would still die after only one lifetime.
  const baseDecals = 512;

  /* ---- procedural textures ------------------------------------------------- */
  const sprites: Partial<Record<SpriteKind, THREE.Texture>> = {};
  const sprite = (kind: SpriteKind): THREE.Texture => {
    let t = sprites[kind];
    if (!t) {
      t = makeSprite(kind);
      sprites[kind] = t;
    }
    return t;
  };
  const white = makeWhiteTexture();
  const libSmoke = safeMap(lib, 'smoke');
  const libScorch = safeMap(lib, 'scorch') ?? white;

  /* ---- families ------------------------------------------------------------ */
  const fam = (
    frac: number,
    kind: SpriteKind,
    additive: boolean,
    ramp: ReturnType<typeof makeRamp>,
    extra: {
      flat?: boolean;
      stretch?: number;
      streak?: boolean;
      detail?: THREE.Texture | null;
      detailAmount?: number;
      renderOrder?: number;
      name?: string;
    } = {},
  ): ParticleFamily =>
    new ParticleFamily({
      capacity: Math.max(16, Math.round(alloc * frac)),
      texture: sprite(kind),
      ramp,
      additive,
      ...extra,
    });

  const fire = fam(FRACTION.fire, 'fire', true, RAMP_FIRE, { stretch: 3.2, renderOrder: 14, name: 'fire' });
  const smoke = fam(FRACTION.smoke, 'smoke', false, RAMP_SMOKE, {
    detail: libSmoke,
    detailAmount: libSmoke ? 0.4 : 0,
    renderOrder: 12,
    name: 'smoke',
  });
  const dust = fam(FRACTION.dust, 'dust', false, RAMP_DUST, {
    detail: libSmoke,
    detailAmount: libSmoke ? 0.2 : 0,
    renderOrder: 11,
    name: 'dust',
  });
  const spark = fam(FRACTION.spark, 'spark', true, RAMP_SPARK, { stretch: 5, renderOrder: 15, name: 'spark' });
  const spray = fam(FRACTION.spray, 'spray', false, RAMP_SPRAY, { stretch: 6, renderOrder: 12, name: 'spray' });
  const tracer = fam(FRACTION.tracer, 'tracer', true, RAMP_SPARK, { stretch: 40, streak: true, renderOrder: 16, name: 'tracer' });
  const ring = fam(FRACTION.ring, 'ring', true, RAMP_RING, { flat: true, renderOrder: 13, name: 'ring' });
  const foam = fam(FRACTION.foam, 'foam', false, RAMP_FOAM, { flat: true, renderOrder: 12, name: 'foam' });
  smoke.litAmount = 0.5;
  dust.litAmount = 1;
  spray.litAmount = 0.6;

  const families: ParticleFamily[] = [fire, smoke, dust, spark, spray, tracer, ring, foam];
  const familyFor = (key: keyof typeof FRACTION): ParticleFamily => {
    switch (key) {
      case 'fire':
        return fire;
      case 'smoke':
        return smoke;
      case 'dust':
        return dust;
      case 'spark':
        return spark;
      case 'spray':
        return spray;
      case 'tracer':
        return tracer;
      case 'ring':
        return ring;
      default:
        return foam;
    }
  };
  for (const f of families) scene.add(f.mesh);

  /* ---- decals, debris, lights --------------------------------------------- */
  // The decal map must not be mipmapped. Zoomed out, the mip chain averages the sprite's
  // transparent border into the burn: the *colour* stays dark across the whole quad while a
  // sliver of alpha survives, so `strength` never drops below the discard threshold and the
  // decal stops being a soft scorch mark and becomes a sharp-edged dark rectangle on the
  // ground - the "dark blue-ish rectangles after battles, when zoomed out" report.
  const decalMap = sprite('scorch').clone();
  decalMap.generateMipmaps = false;
  decalMap.minFilter = THREE.LinearFilter;
  decalMap.needsUpdate = true;
  const decals = new DecalPool(Math.ceil(baseDecals * 1.5), decalMap, libScorch, safeWorldScale(lib, 'scorch'));
  scene.add(decals.mesh);

  const debrisMaterial = lib
    ? lib.clone('metalDark', { flatShading: true, roughness: 0.82, metalness: 0.28 })
    : new THREE.MeshStandardMaterial({ color: 0x3a3a3c, flatShading: true, roughness: 0.85, metalness: 0.3 });
  const baseDebris = Math.max(24, Math.round(baseBudget / 40));
  const debris = new DebrisPool(Math.ceil(baseDebris * 1.5), debrisMaterial);
  scene.add(debris.mesh);

  const quality0: Quality = opts.quality ?? 'medium';
  const lights = new LightPool(scene, quality0 === 'low' ? 1 : 3);

  /* ---- sun ---------------------------------------------------------------- */
  const sunDir = new THREE.Vector3(0.42, 0.78, 0.46).normalize();
  if (opts.sunDirection) sunDir.set(opts.sunDirection.x, opts.sunDirection.y, opts.sunDirection.z).normalize();
  let sunResolved = !!opts.sunDirection;
  let sunScan = 0;
  const findSun = (): void => {
    let found: THREE.DirectionalLight | null = null;
    scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (!found && l.isDirectionalLight === true) found = l;
    });
    const light = found as THREE.DirectionalLight | null;
    if (light) {
      sunDir.copy(light.position).sub(light.target.position);
      if (sunDir.lengthSq() < 1e-6) sunDir.set(0.42, 0.78, 0.46);
      sunDir.normalize();
      sunResolved = true;
    }
  };

  /* ---- quality ------------------------------------------------------------- */
  const applyQuality = (q: Quality): void => {
    const k = QUALITY_FACTOR[q];
    for (const key of Object.keys(FRACTION) as Array<keyof typeof FRACTION>) {
      familyFor(key).setLimit(Math.round(baseBudget * FRACTION[key] * k));
    }
    const sizeScale = QUALITY_SIZE[q];
    for (const f of families) f.setScale(sizeScale);
    decals.setLimit(Math.round(baseDecals * k));
    debris.setLimit(Math.round(baseDebris * k));
    debris.setShadows(q !== 'low');
    if (libSmoke) {
      smoke.setDetailAmount(q === 'low' ? 0.22 : 0.4);
      dust.setDetailAmount(q === 'low' ? 0.1 : 0.2);
    }
  };

  /* ---- reusable spawn seed ------------------------------------------------- */
  const S: ParticleSeed = defaultSeed();

  const reset = (x: number, y: number, z: number, gy: number): void => {
    S.x = x;
    S.y = y;
    S.z = z;
    S.groundY = gy;
    S.vx = 0;
    S.vy = 0;
    S.vz = 0;
    S.size0 = 1;
    S.size1 = 1;
    S.rot = rand() * TAU;
    S.rotVel = (rand() - 0.5) * 1.4;
    S.life = 1;
    S.delay = 0;
    S.alpha = 1;
    S.r = 1;
    S.g = 1;
    S.b = 1;
    S.r1 = 1;
    S.g1 = 1;
    S.b1 = 1;
    S.ramp0 = 0;
    S.rampSpan = 1;
    S.drag = 0;
    S.gravity = 0;
    S.rise = 0;
    S.wind = 0;
    S.stretch = 0;
    S.bounce = 0;
    S.fadeIn = 0.08;
    S.priority = 1;
    S.flags = 0;
  };

  const groundAt = (x: number, z: number): number => {
    const h = terrain(x, z);
    return Number.isFinite(h) ? h : 0;
  };

  /* ---- muzzle direction resolver ------------------------------------------
   * MUZZLE_FLASH carries no direction (its `a` is the barrel offset), but the projectile it
   * launches appears at the muzzle in the same frame. Recent muzzle positions and recent
   * projectile headings are matched up, whichever of the two events arrives first.
   */
  const PEND = 24;
  const pendX = new Float32Array(PEND);
  const pendY = new Float32Array(PEND);
  const pendZ = new Float32Array(PEND);
  const pendAge = new Float32Array(PEND);
  const pendDone = new Uint8Array(PEND);
  const pendSlots = new Int32Array(PEND * 3);
  const pendN = new Int32Array(PEND);
  let pendCursor = 0;
  for (let i = 0; i < PEND; i++) pendAge[i] = 99;

  const PROJ = 16;
  const projX = new Float32Array(PROJ);
  const projY = new Float32Array(PROJ);
  const projZ = new Float32Array(PROJ);
  const projDX = new Float32Array(PROJ);
  const projDY = new Float32Array(PROJ);
  const projDZ = new Float32Array(PROJ);
  const projAge = new Float32Array(PROJ);
  let projCursor = 0;
  for (let i = 0; i < PROJ; i++) projAge[i] = 99;

  const orientPending = (px: number, py: number, pz: number, dx: number, dy: number, dz: number): void => {
    for (let i = 0; i < PEND; i++) {
      if (pendDone[i] === 1 || pendAge[i] > 0.2) continue;
      const ax = pendX[i] - px;
      const ay = pendY[i] - py;
      const az = pendZ[i] - pz;
      if (ax * ax + ay * ay + az * az > 6.25) continue;
      const n = pendN[i];
      for (let k = 0; k < n; k++) {
        const slot = pendSlots[i * 3 + k];
        const speed = 5 + k * 3.4 + rand() * 3;
        fire.setVelocity(slot, dx * speed + (rand() - 0.5) * 1.6, dy * speed + (rand() - 0.5) * 1.6 + 0.6, dz * speed + (rand() - 0.5) * 1.6);
        fire.setStretch(slot, 1);
      }
      pendDone[i] = 1;
    }
  };

  const rememberProjDir = (x: number, y: number, z: number, vx: number, vy: number, vz: number): void => {
    const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (l < 1e-4) return;
    const i = projCursor;
    projCursor = (projCursor + 1) % PROJ;
    projX[i] = x;
    projY[i] = y;
    projZ[i] = z;
    projDX[i] = vx / l;
    projDY[i] = vy / l;
    projDZ[i] = vz / l;
    projAge[i] = 0;
    orientPending(x, y, z, projDX[i], projDY[i], projDZ[i]);
  };

  const matchProjDir = (x: number, y: number, z: number, out: THREE.Vector3): boolean => {
    for (let i = 0; i < PROJ; i++) {
      if (projAge[i] > 0.2) continue;
      const ax = projX[i] - x;
      const ay = projY[i] - y;
      const az = projZ[i] - z;
      if (ax * ax + ay * ay + az * az > 6.25) continue;
      out.set(projDX[i], projDY[i], projDZ[i]);
      return true;
    }
    return false;
  };

  const TMP = new THREE.Vector3();

  /* ------------------------------------------------------------ spawn helpers */

  const sparkBurst = (x: number, y: number, z: number, gy: number, n: number, speed: number, up: number, life: number, size: number): void => {
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU;
      const v = speed * (0.35 + rand() * 0.9);
      reset(x, y, z, gy);
      S.vx = Math.cos(a) * v;
      S.vz = Math.sin(a) * v;
      S.vy = up * (0.3 + rand());
      S.size0 = size * (0.85 + rand() * 0.8);
      S.size1 = size * 0.25;
      S.life = life * (0.55 + rand() * 0.8);
      S.delay = rand() * 0.04;
      S.alpha = 0.8 + rand() * 0.2;
      S.r = 1.5;
      S.g = 1.28;
      S.b = 0.95;
      S.r1 = 0.9;
      S.g1 = 0.7;
      S.b1 = 0.5;
      S.ramp0 = rand() * 0.2;
      S.rampSpan = 0.75 + rand() * 0.25;
      S.gravity = 15 + rand() * 8;
      S.drag = 1.1;
      S.stretch = 1;
      S.bounce = 0.36;
      S.flags = PFLAG.GROUND;
      S.priority = 1;
      S.fadeIn = 0.02;
      spark.emit(S);
    }
  };

  const dustPuff = (
    x: number,
    y: number,
    z: number,
    gy: number,
    size: number,
    speed: number,
    life: number,
    alpha: number,
    n: number,
    prio: number,
  ): void => {
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU;
      const v = speed * (0.4 + rand() * 1.1);
      reset(x, y, z, gy);
      S.vx = Math.cos(a) * v;
      S.vz = Math.sin(a) * v;
      S.vy = 0.5 + rand() * 1.6;
      S.size0 = size * (0.5 + rand() * 0.6);
      S.size1 = size * (1.7 + rand() * 1.4);
      S.life = life * (0.75 + rand() * 0.6);
      S.delay = rand() * 0.08;
      S.alpha = alpha * (0.7 + rand() * 0.5);
      S.ramp0 = rand() * 0.25;
      S.rampSpan = 0.5 + rand() * 0.45;
      S.gravity = 0.7;
      S.rise = 0.7 + rand() * 0.7;
      S.drag = 1.5;
      S.wind = 0.45 + rand() * 0.5;
      S.r = 1.3;
      S.g = 1.24;
      S.b = 1.14;
      S.r1 = 0.8;
      S.g1 = 0.79;
      S.b1 = 0.8;
      S.rotVel = (rand() - 0.5) * 1.1;
      S.groundY = gy;
      S.priority = prio;
      S.fadeIn = 0.12;
      dust.emit(S);
    }
  };

  /**
   * Dark smoke. `rampStart` slides the particle along the family ramp, so the same emitter
   * produces fire-lit smoke (0) and cold soot (0.3+) without a second material.
   */
  const smokePuff = (
    x: number,
    y: number,
    z: number,
    gy: number,
    n: number,
    size0: number,
    size1: number,
    life: number,
    alpha: number,
    rise: number,
    spread: number,
    delay: number,
    rampStart: number,
    hot: number,
    prio: number,
  ): void => {
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU;
      const r = spread * (0.25 + rand() * 0.95);
      reset(x + Math.cos(a) * r, y + rand() * spread * 0.4, z + Math.sin(a) * r, gy);
      S.vx = Math.cos(a) * spread * 0.9 * (0.3 + rand() * 1.2);
      S.vz = Math.sin(a) * spread * 0.9 * (0.3 + rand() * 1.2);
      S.vy = rise * (0.5 + rand());
      S.size0 = size0 * (0.45 + rand() * 1.05);
      S.size1 = size1 * (0.55 + rand() * 0.95);
      S.life = life * (0.7 + rand() * 0.7);
      S.delay = delay * rand();
      S.alpha = alpha * (0.5 + rand() * 0.85);
      S.ramp0 = rampStart * (0.85 + rand() * 0.3);
      S.rampSpan = 0.5 + rand() * 0.45;
      S.gravity = 0;
      S.rise = 0.8 + rand() * 1.5;
      S.drag = 1.35;
      S.wind = 0.5 + rand() * 0.6;
      S.rotVel = (rand() - 0.5) * 0.8;
      const dens = 0.55 + rand() * 1.05;
      S.r = hot * dens;
      S.g = hot * dens;
      S.b = hot * dens;
      S.r1 = 0.8 * dens;
      S.g1 = 0.8 * dens;
      S.b1 = 0.83 * dens;
      S.priority = prio;
      S.fadeIn = 0.16;
      smoke.emit(S);
    }
  };

  const debrisColor = new THREE.Color();
  const nextDebrisColor = (): THREE.Color => {
    const t = rand();
    if (t < 0.55) return debrisColor.setRGB(0.72 + rand() * 0.25, 0.69 + rand() * 0.25, 0.62 + rand() * 0.22);
    if (t < 0.8) return debrisColor.setRGB(0.95 + rand() * 0.3, 0.78 + rand() * 0.24, 0.55 + rand() * 0.18);
    return debrisColor.setRGB(0.5 + rand() * 0.2, 0.44 + rand() * 0.18, 0.4 + rand() * 0.15);
  };

  const debrisBurst = (x: number, y: number, z: number, gy: number, n: number, speed: number, size: number, life: number): void => {
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU;
      const v = speed * (0.3 + rand());
      debris.spawn({
        x,
        y: y + rand() * 0.6,
        z,
        vx: Math.cos(a) * v,
        vy: 4 + rand() * 9,
        vz: Math.sin(a) * v,
        size: size * (0.6 + rand() * 0.9),
        spin: 6 + rand() * 16,
        life: life * (0.7 + rand() * 0.7),
        groundY: gy,
        bounce: 0.32 + rand() * 0.2,
        color: nextDebrisColor(),
      });
    }
  };

  /* ---- decal de-duplication: a SCORCH event lands on the crater of its own blast ---- */
  const RECENT = 10;
  const recX = new Float32Array(RECENT);
  const recZ = new Float32Array(RECENT);
  const recT = new Float32Array(RECENT);
  const recSlot = new Int32Array(RECENT);
  let recCursor = 0;
  for (let i = 0; i < RECENT; i++) {
    recT[i] = 99;
    recSlot[i] = -1;
  }

  const addDecal = (x: number, y: number, z: number, radius: number, strength: number, life: number): void => {
    const gy = groundAt(x, z);
    // A scorch is a burn mark on the terrain, so it only exists where there is terrain to burn.
    // The blast of a vehicle killed in the air is drawn at altitude, and this used to stamp its
    // crater at that altitude too: a helicopter emptied out at 40 m left a scorch disc hanging
    // in the sky, which is the reported "airborne units leave impact decals floating". Above a
    // metre or two there is nothing under the blast to scorch, so skip the decal entirely —
    // the fireball, sparks and falling wreck already carry the hit.
    if (y - gy > 2.0) return;
    const cy = Math.max(y, gy);
    // Terrain normal from finite differences so the decal lies on the slope.
    const e = 0.45;
    const hx = groundAt(x + e, z) - groundAt(x - e, z);
    const hz = groundAt(x, z + e) - groundAt(x, z - e);
    const slot = decals.spawn({
      x,
      y: cy,
      z,
      nx: -hx,
      ny: 2 * e,
      nz: -hz,
      radius,
      rot: rand() * TAU,
      strength,
      life,
      lift: 0.035 + radius * 0.012,
    });
    recX[recCursor] = x;
    recZ[recCursor] = z;
    recT[recCursor] = 0;
    recSlot[recCursor] = slot;
    recCursor = (recCursor + 1) % RECENT;
  };

  /* ---------------------------------------------------------------- EKIND cases */

  const shockwave = (x: number, y: number, z: number, scale: number): void => {
    const gy = groundAt(x, z);
    const cy = Math.max(y, gy + 0.06);
    reset(x, cy, z, gy);
    S.size0 = 0.7 * scale;
    S.size1 = 5.0 * scale;
    S.life = 0.6;
    S.alpha = 0.35;
    S.ramp0 = 0;
    S.rampSpan = 0.8;
    S.priority = 2;
    S.fadeIn = 0.02;
    ring.emit(S);
    dustPuff(x, cy, z, gy, 1.1 * scale, 16 * scale, 1.5, 0.34, 14, 2);
  };

  const explosion = (x: number, y: number, z: number, scale: number, big: boolean): void => {
    const gy = groundAt(x, z);
    const cy = Math.max(y, gy + 0.05);
    const R = (big ? 4.6 : 3.0) * scale;
    const prio = 2;

    // Hot core flash: one big additive quad that expands and dies fast.
    reset(x, cy + R * 0.32, z, gy);
    S.size0 = R * 0.4;
    S.size1 = R * 1.0;
    S.life = 0.12;
    S.alpha = 0.32;
    S.ramp0 = 0;
    S.rampSpan = 0.2;
    S.priority = prio;
    S.fadeIn = 0;
    fire.emit(S);

    // Fireball: a shell of flame that flies outwards and shrinks as it cools.
    const nFire = big ? 36 : 22;
    for (let i = 0; i < nFire; i++) {
      const a = rand() * TAU;
      const el = 0.15 + rand() * 0.95;
      const sp = (3.4 + rand() * 9.5) * scale;
      const ce = Math.cos(el);
      reset(x + Math.cos(a) * ce * R * 0.22, cy + 0.25 + Math.sin(el) * R * 0.3, z + Math.sin(a) * ce * R * 0.22, gy);
      S.vx = Math.cos(a) * ce * sp;
      S.vz = Math.sin(a) * ce * sp;
      S.vy = Math.sin(el) * sp * 0.8 + 1.2;
      S.size0 = R * (0.42 + rand() * 0.4);
      S.size1 = R * (0.12 + rand() * 0.2);
      S.life = (big ? 0.8 : 0.5) * (0.65 + rand() * 0.85);
      S.delay = rand() * 0.06;
      S.alpha = 0.2 + rand() * 0.22;
      S.ramp0 = rand() * 0.18;
      S.rampSpan = 0.6 + rand() * 0.42;
      S.gravity = 1.6;
      S.rise = 5.5;
      S.drag = 2.2;
      S.priority = prio;
      S.fadeIn = 0.02;
      S.rotVel = (rand() - 0.5) * 3;
      fire.emit(S);
    }

    // Smoke: born lit by the fireball, then cools into a dark rising column.
    smokePuff(
      x,
      cy + R * 0.35,
      z,
      gy,
      big ? 24 : 13,
      R * 0.5,
      R * (big ? 2.3 : 2.0),
      big ? 4.2 : 3.3,
      big ? 0.5 : 0.44,
      1.7,
      R * 0.85,
      big ? 0.34 : 0.2,
      0.05,
      1.3,
      prio,
    );

    // Ground dust ring kicked outwards by the blast.
    dustPuff(x, cy + 0.05, z, gy, R * 0.62, (big ? 17 : 13) * scale, big ? 2.6 : 2.0, 0.62, big ? 20 : 12, prio);

    // Sparks and chunks.
    sparkBurst(x, cy + 0.2, z, gy, big ? 30 : 16, (big ? 23 : 15) * scale, 5.5, big ? 1.5 : 1.15, 0.2);
    if (big) debrisBurst(x, cy, z, gy, 12, 9, 0.42, 5.5);

    // Point light.
    lights.request(x, cy + R * 0.4, z, (big ? 130 : 48) * scale, big ? 0.55 : 0.36, 2, 0xff9a3c);

    // Crater decal (a SCORCH event from the same blast reinforces it a frame later).
    addDecal(x, cy, z, clamp(R * 0.62, 1.4, 9), big ? 0.95 : 0.82, big ? 140 : 104);

    if (big) shockwave(x, cy, z, scale);
  };

  const muzzleFlash = (x: number, y: number, z: number, scale: number): void => {
    const gy = groundAt(x, z);
    const cy = Math.max(y, gy + 0.05);
    const s = clamp(scale, 0.7, 2.2);
    const hasDir = matchProjDir(x, cy, z, TMP);
    const dx = hasDir ? TMP.x : 0;
    const dy = hasDir ? TMP.y : 1;
    const dz = hasDir ? TMP.z : 0;

    // Core flash plus flame shards, stretched along the barrel once the heading is known.
    reset(x, cy, z, gy);
    S.size0 = 0.75 * s;
    S.size1 = 1.6 * s;
    S.life = 0.09;
    S.alpha = 0.8;
    S.ramp0 = 0;
    S.rampSpan = 0.3;
    S.priority = 1.5;
    S.fadeIn = 0;
    S.stretch = hasDir ? 1 : 0;
    S.vx = dx * 6;
    S.vy = dy * 6;
    S.vz = dz * 6;
    const core = fire.emit(S);

    const pend = pendCursor;
    pendCursor = (pendCursor + 1) % PEND;
    pendX[pend] = x;
    pendY[pend] = cy;
    pendZ[pend] = z;
    pendAge[pend] = 0;
    pendDone[pend] = hasDir ? 1 : 0;
    pendSlots[pend * 3] = core;
    pendN[pend] = 1;

    for (let i = 0; i < 5; i++) {
      const sp = 6 + i * 4.2 + rand() * 3;
      reset(x, cy, z, gy);
      S.vx = dx * sp + (rand() - 0.5) * 1.6;
      S.vy = dy * sp + (rand() - 0.5) * 1.6 + 0.6;
      S.vz = dz * sp + (rand() - 0.5) * 1.6;
      S.size0 = (0.4 + rand() * 0.3) * s;
      S.size1 = 0.1;
      S.life = 0.1 + rand() * 0.08;
      S.alpha = 0.85;
      S.ramp0 = 0.04 * i;
      S.rampSpan = 0.4;
      S.drag = 4.5;
      S.gravity = 2;
      S.stretch = hasDir ? 1 : 0;
      S.priority = 1.5;
      S.fadeIn = 0;
      if (pendN[pend] < 3) pendSlots[pend * 3 + pendN[pend]++] = fire.emit(S);
    }

    // Burning propellant wisp, a little ground dust if the muzzle sits low, and a flash.
    smokePuff(x, cy, z, gy, 3, 0.5 * s, 2.1 * s, 1.3, 0.32, 0.9, 0.3 * s, 0.1, 0.34, 0.9, 0.6);
    if (cy - gy < 2.2) dustPuff(x, gy + 0.04, z, gy, 0.9 * s, 6 * s, 1.1, 0.36, 6, 0.6);
    sparkBurst(x, cy, z, gy, 5, 11, 3.5, 0.55, 0.11);
    lights.request(x, cy + 0.2, z, 11 * s, 0.11, 1, 0xffb45a);
  };

  const impact = (x: number, y: number, z: number, scale: number): void => {
    const gy = groundAt(x, z);
    const metal = y > gy + 0.45;
    const cy = Math.max(y, gy + 0.03);
    const s = clamp(scale, 0.4, 2.2);

    reset(x, cy, z, gy);
    S.size0 = 1.1 * s;
    S.size1 = 2.6 * s;
    S.life = 0.15;
    S.alpha = 0.85;
    S.ramp0 = 0;
    S.rampSpan = 0.3;
    S.priority = 1;
    S.fadeIn = 0;
    fire.emit(S);

    if (metal) {
      sparkBurst(x, cy, z, gy, 14 + Math.round(10 * s), 16 * s, 3.5, 1.0, 0.14);
      smokePuff(x, cy, z, gy, 2, 0.35 * s, 1.3 * s, 1.2, 0.22, 0.9, 0.25, 0.05, 0.45, 0.7, 0.5);
      lights.request(x, cy, z, 8 * s, 0.1, 1, 0xffd9a0);
    } else {
      sparkBurst(x, cy, z, gy, 9 + Math.round(7 * s), 13 * s, 3.4, 0.9, 0.13);
      dustPuff(x, cy, z, gy, 1.0 * s, 7.0 * s, 1.8, 0.55, 9, 0.8);
      lights.request(x, cy, z, 6 * s, 0.09, 0, 0xffc98a);
    }
  };

  const dustCloud = (x: number, y: number, z: number, scale: number): void => {
    const gy = groundAt(x, z);
    const cy = Math.max(y, gy + 0.03);
    const s = clamp(scale, 0.3, 2.4);
    dustPuff(x, cy, z, gy, 0.9 * s, 4.2 * s, 2.2, 0.5, 4, 0.5);
  };

  const waterSplash = (x: number, y: number, z: number, scale: number): void => {
    const surface = y;
    const s = clamp(scale, 0.3, 3.2);

    // Vertical spray columns: fast droplets that die as they fall back to the surface.
    const n = Math.round(clamp(14 * s, 10, 30));
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU;
      const out = (0.4 + rand() * 1.9) * s;
      reset(x + Math.cos(a) * 0.2 * s, surface + 0.05, z + Math.sin(a) * 0.2 * s, surface - 0.1);
      S.vx = Math.cos(a) * out;
      S.vz = Math.sin(a) * out;
      S.vy = (5.5 + rand() * 11.5) * Math.sqrt(s);
      S.size0 = (0.19 + rand() * 0.16) * s;
      S.size1 = (0.09 + rand() * 0.09) * s;
      S.life = 0.7 + rand() * 0.6;
      S.alpha = 0.75 + rand() * 0.25;
      S.ramp0 = rand() * 0.15;
      S.rampSpan = 0.5;
      S.gravity = 16;
      S.drag = 0.45;
      S.stretch = 1;
      S.flags = PFLAG.GROUND | PFLAG.DIE_ON_GROUND;
      S.priority = 0.8;
      S.fadeIn = 0.02;
      spray.emit(S);
    }
    // Mist hanging over the impact point.
    for (let i = 0; i < 5; i++) {
      const a = rand() * TAU;
      reset(x, surface + 0.25 + rand() * 0.6, z, surface - 0.1);
      S.vx = Math.cos(a) * 1.6 * s;
      S.vz = Math.sin(a) * 1.6 * s;
      S.vy = 1.1 + rand() * 1.4;
      S.size0 = 0.45 * s;
      S.size1 = 2.4 * s;
      S.life = 0.75 + rand() * 0.5;
      S.alpha = 0.3;
      S.ramp0 = 0;
      S.rampSpan = 0.55;
      S.gravity = 0.4;
      S.rise = 0.5;
      S.drag = 1.7;
      S.wind = 0.3;
      S.priority = 0.7;
      spray.emit(S);
    }
    // Expanding foam ring.
    const rings = s > 1.4 ? 2 : 1;
    for (let i = 0; i < rings; i++) {
      reset(x, surface + 0.02 + i * 0.01, z, surface);
      S.size0 = (0.9 + i * 0.8) * s;
      S.size1 = (4.2 + i * 2.4) * s;
      S.life = 1.1 + i * 0.5;
      S.alpha = 0.75 - i * 0.25;
      S.ramp0 = 0;
      S.rampSpan = 0.5 + i * 0.3;
      S.priority = 1.2;
      S.fadeIn = 0.02;
      foam.emit(S);
    }
  };

  const smokePuffEvent = (x: number, y: number, z: number, scale: number): void => {
    const s = clamp(scale, 0.4, 2);
    const gy = groundAt(x, z);
    smokePuff(x, y, z, gy, 3, 0.5 * s, 2.6 * s, 3.0, 0.32, 1.5, 0.3 * s, 0.1, 0.42, 0.95, 0.5);
  };

  /**
   * Tracer spark for a bullet: a short streak that travels *with* the round.
   *
   * `speed` is the round's own muzzle velocity, carried in the event's `d` slot. It used to be
   * hard-coded at 470 m/s while the chain gun fires at 210 m/s, so the spark outran the bullet
   * it was drawn for and hung in the air ahead of it as a long detached beam. The length is
   * capped in world metres by the particle shader (`uStretchMax`), so this only has to keep the
   * spark co-located with the round.
   */
  const tracerRound = (
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    range: number,
    speed: number,
  ): void => {
    const cp = Math.cos(pitch);
    const dx = Math.sin(yaw) * cp;
    const dy = Math.sin(pitch);
    const dz = Math.cos(yaw) * cp;
    const life = clamp(range / speed, 0.06, 0.42);

    reset(x, y, z, 0);
    S.vx = dx * speed;
    S.vy = dy * speed;
    S.vz = dz * speed;
    S.size0 = 0.3;
    S.size1 = 0.2;
    S.life = life;
    S.alpha = 1;
    S.r = 1.8;
    S.g = 1.45;
    S.b = 1.05;
    S.r1 = 1.5;
    S.g1 = 1.15;
    S.b1 = 0.8;
    S.ramp0 = 0;
    S.rampSpan = 0.55;
    S.stretch = 1;
    S.rot = 0;
    S.priority = 1.4;
    S.fadeIn = 0;
    tracer.emit(S);

    reset(x, y, z, 0);
    S.vx = dx * speed;
    S.vy = dy * speed;
    S.vz = dz * speed;
    S.size0 = 0.78;
    S.size1 = 0.55;
    S.life = life * 0.9;
    S.alpha = 0.26;
    S.r = 1.4;
    S.g = 1.15;
    S.b = 0.85;
    S.r1 = 1.1;
    S.g1 = 0.9;
    S.b1 = 0.7;
    S.ramp0 = 0.15;
    S.rampSpan = 0.5;
    S.stretch = 1;
    S.rot = 0;
    S.priority = 1.2;
    S.fadeIn = 0;
    tracer.emit(S);

    // A tracer also tells us where a muzzle flash was pointing.
    orientPending(x, y, z, dx, dy, dz);
  };

  const scorchEvent = (x: number, y: number, z: number, radius: number): void => {
    for (let i = 0; i < RECENT; i++) {
      if (recSlot[i] < 0 || recT[i] > 0.25) continue;
      const dx = recX[i] - x;
      const dz = recZ[i] - z;
      if (dx * dx + dz * dz > 6.25) continue;
      decals.reinforce(recSlot[i], radius * 0.75, 0.92);
      recT[i] = 0;
      return;
    }
    addDecal(x, y, z, clamp(radius * 0.8, 1.2, 9), 0.9, 120);
  };

  /* ---- projectile trails --------------------------------------------------- */
  const TRAIL = 48;
  const trailId = new Float32Array(TRAIL);
  const trailX = new Float32Array(TRAIL);
  const trailY = new Float32Array(TRAIL);
  const trailZ = new Float32Array(TRAIL);
  const trailT = new Float32Array(TRAIL);
  for (let i = 0; i < TRAIL; i++) {
    trailId[i] = -1;
    trailT[i] = 99;
  }
  let trailCursor = 0;

  const trailSlotOf = (id: number): number => {
    for (let i = 0; i < TRAIL; i++) if (trailId[i] === id) return i;
    const s = trailCursor;
    trailCursor = (trailCursor + 1) % TRAIL;
    trailId[s] = id;
    trailX[s] = 0;
    trailY[s] = 0;
    trailZ[s] = 0;
    trailT[s] = 99;
    return s;
  };

  /* ------------------------------------------------------------------- public */

  const spawn = (e: EventView): void => {
    switch (e.kind | 0) {
      case EKIND.EXPLOSION:
        explosion(e.x, e.y, e.z, clamp(e.a || 1, 0.5, 3), false);
        break;
      case EKIND.BIG_EXPLOSION:
        explosion(e.x, e.y, e.z, clamp(e.a || 1.7, 0.8, 4), true);
        break;
      case EKIND.MUZZLE_FLASH:
        muzzleFlash(e.x, e.y, e.z, 0.6 + (e.a || 0) * 0.12);
        break;
      case EKIND.IMPACT:
        impact(e.x, e.y, e.z, e.a || 1);
        break;
      case EKIND.DUST:
        dustCloud(e.x, e.y, e.z, e.a || 1);
        break;
      case EKIND.WATER_SPLASH:
        waterSplash(e.x, e.y, e.z, e.a || 1);
        break;
      case EKIND.SMOKE_PUFF:
        smokePuffEvent(e.x, e.y, e.z, e.a || 1);
        break;
      case EKIND.TRACER:
        // `d` is the round's real muzzle speed (see `tracerRound`); 470 is a safe legacy default
        // for events pushed before the payload existed.
        tracerRound(e.x, e.y, e.z, e.a, e.b, e.c || 90, e.d > 1 ? e.d : 470);
        break;
      case EKIND.DEBRIS:
        debrisBurst(e.x, e.y, e.z, groundAt(e.x, e.z), Math.round(clamp(e.a || 14, 4, 26)), clamp(56 * (e.b || 0.45), 6, 20), 0.4, 5.5);
        break;
      case EKIND.SHOCKWAVE:
        shockwave(e.x, e.y, e.z, clamp(e.a || 1.4, 0.4, 3));
        break;
      case EKIND.SCORCH:
        scorchEvent(e.x, e.y, e.z, clamp(e.a || 2, 0.6, 10));
        break;
      case EKIND.VEHICLE_DESTROYED: {
        const scale = clamp(e.a || 1.8, 1, 3);
        explosion(e.x, e.y, e.z, scale, true);
        debrisBurst(e.x, e.y, e.z, groundAt(e.x, e.z), 10, 10, 0.44, 6);
        smokePuff(e.x, e.y + 0.5, e.z, groundAt(e.x, e.z), 6, 0.75, 3.4, 4.5, 0.34, 1.8, 0.5, 0.1, 0.42, 1, 1);
        break;
      }
      default:
        // SOUND, NOTIFY, FLAG_TAKEN, FLAG_CAPTURED, SKULL, NONE: not ours.
        break;
    }
  };

  const trackProjectile = (p: ProjectileView, dt: number): void => {
    const kind = p.kind | 0;
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    rememberProjDir(p.x, p.y, p.z, p.vx, p.vy, p.vz);
    if (kind !== PKIND.ROCKET && kind !== PKIND.MISSILE && kind !== PKIND.HOMING) return;

    const slot = trailSlotOf(p.id);
    const dx = p.x - trailX[slot];
    const dy = p.y - trailY[slot];
    const dz = p.z - trailZ[slot];
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
    trailT[slot] += dt;
    if (trailT[slot] > 90) {
      // First frame we see this projectile: just remember where it is.
      trailX[slot] = p.x;
      trailY[slot] = p.y;
      trailZ[slot] = p.z;
      trailT[slot] = 0;
      return;
    }
    // A puff every ~12 ms of flight (or per 12 ms of travel for slow projectiles).
    const spacing = Math.max(0.5, speed * 0.012);
    if (moved >= spacing || trailT[slot] >= 0.012) {
      smokePuff(p.x, p.y, p.z, groundAt(p.x, p.z), 1, 0.3, 1.6, 0.9, 0.34, 0.35, 0.12, 0, 0.78, 1.7, 0.6);
      reset(p.x, p.y, p.z, groundAt(p.x, p.z));
      S.size0 = 0.26;
      S.size1 = 0.05;
      S.life = 0.1;
      S.alpha = 0.85;
      S.ramp0 = 0.05;
      S.rampSpan = 0.3;
      S.priority = 0.8;
      S.fadeIn = 0;
      fire.emit(S);
      trailX[slot] = p.x;
      trailY[slot] = p.y;
      trailZ[slot] = p.z;
      trailT[slot] = 0;
    }
  };

  /* ---- burning wrecks: a continuous, throttled soot column ------------------ */
  // Nothing used to drive smoke from a surviving wreck, so a hull could burn for 14 s with no
  // soot after the blast. This emits a few puffs a second for as long as the wreck survives,
  // tapering with the seconds left in its `VehicleView.wreck` clock, and never for a drone
  // (the sim withholds BURNING for those and `world.ts` skips the call).
  const WRECK_TRACK = 32;
  const wreckId = new Float32Array(WRECK_TRACK);
  const wreckClock = new Float32Array(WRECK_TRACK);
  for (let i = 0; i < WRECK_TRACK; i++) wreckId[i] = -1;
  let wreckCursor = 0;
  /** Fallback lifetime for a view whose `wreck` field was not decoded (stale bridge). */
  const WRECK_LIFE = 14.0;

  const wreckSlotOf = (id: number): number => {
    for (let i = 0; i < WRECK_TRACK; i++) if (wreckId[i] === id) return i;
    const s = wreckCursor;
    wreckCursor = (wreckCursor + 1) % WRECK_TRACK;
    wreckId[s] = id;
    wreckClock[s] = 0;
    return s;
  };

  const trackWreck = (v: VehicleView, dt: number): void => {
    const slot = wreckSlotOf(v.id);
    wreckClock[slot] += dt;
    const left =
      typeof v.wreck === 'number' && Number.isFinite(v.wreck) ? Math.max(0, v.wreck) : WRECK_LIFE;
    const frac = clamp(left / WRECK_LIFE, 0, 1);
    // ~1.3 puffs/s as the fire dies, ~5/s while it is fresh.
    const interval = 0.75 - 0.57 * frac;
    if (wreckClock[slot] < interval) return;
    wreckClock[slot] = 0;
    // A wreck sits on the ground, so anchor the column on the terrain under it — the hull
    // origin is the model's contact point, which for a crashed flyer is already at grade.
    const gy = groundAt(v.x, v.z);
    const y = Math.max(v.y, gy) + 0.9;
    smokePuff(
      v.x,
      y,
      v.z,
      gy,
      1,
      0.55,
      2.4 - 0.9 * frac,
      3.4,
      0.3 * (0.4 + 0.6 * frac),
      1.5,
      0.35,
      0,
      0.42,
      0.55,
      0.7,
    );
  };

  const update = (dtRaw: number, camera: THREE.Camera): void => {
    const dt = clamp(dtRaw, 0, 0.05);
    if (!sunResolved) {
      sunScan += dt;
      if (sunScan > 1.5) {
        sunScan = 0;
        findSun();
      }
    }
    // Light offshore breeze: dust and smoke drift with it, fire does not care.
    const windX = 1.15;
    const windZ = 0.55;
    camera.updateMatrixWorld();
    const camPos = TMP.setFromMatrixPosition(camera.matrixWorld);
    const cx = camPos.x;
    const cy = camPos.y;
    const cz = camPos.z;
    for (let i = 0; i < families.length; i++) {
      const f = families[i];
      (f.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
      f.update(dt, windX, windZ, cx, cy, cz);
    }
    decals.update(dt);
    debris.update(dt);
    lights.update(dt);
    for (let i = 0; i < PEND; i++) if (pendAge[i] < 99) pendAge[i] += dt;
    for (let i = 0; i < PROJ; i++) if (projAge[i] < 99) projAge[i] += dt;
    for (let i = 0; i < RECENT; i++) if (recT[i] < 99) recT[i] += dt;
  };

  const stats = (): { particles: number; decals: number; drawCalls: number } => {
    let particles = 0;
    let drawCalls = 0;
    for (let i = 0; i < families.length; i++) {
      const n = families[i].count;
      particles += n;
      if (n > 0) drawCalls++;
    }
    if (decals.count > 0) drawCalls++;
    if (debris.count > 0) drawCalls++;
    return { particles, decals: decals.count, drawCalls };
  };

  const dispose = (): void => {
    for (const f of families) {
      scene.remove(f.mesh);
      f.dispose();
    }
    for (const key of Object.keys(sprites) as SpriteKind[]) sprites[key]?.dispose();
    white.dispose();
    scene.remove(decals.mesh);
    decals.dispose();
    decalMap.dispose(); // the pool's own mip-free copy of the scorch sprite
    scene.remove(debris.mesh);
    debris.dispose();
    debrisMaterial.dispose();
    lights.dispose(scene);
  };

  applyQuality(quality0);

  /**
   * Wipe the ground decals. Called when a round ends and when the map is rebuilt: both are
   * moments where the craters on the ground stopped meaning anything - they are the previous
   * fight's, on ground that is about to be a different island (or the same one, after a fresh
   * round). Everything else in here expires on its own in a second or two, so it needs no help.
   */
  const clearDecals = (): void => {
    decals.clear();
    // Any pending SCORCH that was going to reinforce a crater must not resurrect one.
    for (let i = 0; i < RECENT; i++) recSlot[i] = -1;
  };

  return { spawn, trackProjectile, trackWreck, update, setQuality: applyQuality, stats, dispose, clearDecals };
}
