/**
 * Combat VFX preview harness.
 *
 *   node tools/shot.mjs preview/fx.html shots/fx.png --w 1600 --h 900 --wait 25000
 *   node tools/shot.mjs 'preview/fx.html?t=3.4' shots/fx-explosion.png        # frozen frame
 *   node tools/shot.mjs 'preview/fx.html?only=water&t=1.2' shots/fx-water.png
 *   node tools/shot.mjs 'preview/fx.html?stress=1&t=6' shots/fx-stress.png
 *   node tools/shot.mjs 'preview/fx.html?stress=1&bench=1' shots/fx-bench.png
 *
 * Flags
 *   ?only=NAME   run a single scripted step (explosion, big, muzzle, impact, dust, water,
 *                smoke, debris, shockwave, scorch, vehicle)
 *   ?t=SECONDS   fast-forward the demo deterministically and freeze — screenshots always land
 *                on the same frame no matter how slow the machine is
 *   ?stress=1    60 explosions/second to prove the pools hold up
 *   ?bench=1     measure the CPU cost of `Effects.update()` and print it in the HUD
 *
 * Exposes `window.__FX_STATS__` (particles / decals / draw calls / update ms), a few debug
 * hooks (`__FX__`, `__SCENE__`, `__RENDERER__`) and sets `window.__READY__ = true` after the
 * first rendered frame. On a software rasteriser (SwiftShader) frames are paced with a short
 * idle gap so screenshot capture is never starved; on a real GPU it runs on rAF, flat out.
 */
import * as THREE from 'three';
import { createSurfaceLibrary } from '../src/assets/textures/library';
import { createEffects } from '../src/render/effects';
import { EKIND, type EventView } from '../src/sim/layout';
import { fbm2 } from '../src/render/vfx/rand';

/* ------------------------------------------------------------------ parameters */

const params = new URLSearchParams(location.search);
const ONLY = params.get('only');
const STRESS = params.get('stress') === '1';
const BENCH = params.get('bench') === '1';
const FREEZE_AT = params.get('t') !== null ? Number(params.get('t')) : null;
const QUALITY = (params.get('quality') as 'low' | 'medium' | 'high' | null) ?? 'high';
/** Camera framing overrides: dist = metres from the action, pitch = degrees above horizontal. */
const CAM_DIST = Number(params.get('dist') ?? (STRESS ? 74 : 40));
const CAM_PITCH = (Number(params.get('pitch') ?? (STRESS ? 41 : 52)) * Math.PI) / 180;

/* --------------------------------------------------------------------- terrain */

const POND_X = -34;
const POND_Z = 6;
const POND_R = 21;
const WATER_Y = -1.55;

function terrainHeight(x: number, z: number): number {
  let h = 0.95 * Math.sin(x * 0.037) * Math.cos(z * 0.043) + 0.5 * Math.sin(x * 0.021 + z * 0.017) + 0.22 * Math.sin(x * 0.09 + z * 0.07);
  const dx = x - POND_X;
  const dz = z - POND_Z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const t = Math.min(1, Math.max(0, (POND_R + 7 - d) / 11));
  const basin = t * t * (3 - 2 * t) * 3.4;
  h -= basin;
  return h;
}

/* ------------------------------------------------------------------- renderer */

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const gl = renderer.getContext();
const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
const glRenderer = dbgInfo ? String(gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL)) : '';
const SOFTWARE_GL = /swiftshader|llvmpipe|software|mesa offscreen/i.test(glRenderer);
/** Idle gap between frames on a software rasteriser, ms. 0 = run flat out on real GPUs. */
const FRAME_GAP = SOFTWARE_GL ? 150 : 0;

const scene = new THREE.Scene();

function makeSky(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 8;
  cv.height = 256;
  const g = cv.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#2b6ba6');
  grad.addColorStop(0.34, '#6fa2c9');
  grad.addColorStop(0.47, '#bcd0dc');
  grad.addColorStop(0.52, '#e0cda6');
  grad.addColorStop(0.62, '#c3ab84');
  grad.addColorStop(1.0, '#8b7757');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const sky = makeSky();
scene.background = sky;

// Debug hooks for the screenshot/perf tooling (read-only): the live scene graph, the
// renderer and the Effects instance.
(window as unknown as { __SCENE__: unknown }).__SCENE__ = scene;
(window as unknown as { __RENDERER__: unknown }).__RENDERER__ = renderer;
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 900);
camera.position.set(22, 26, 30);

const sun = new THREE.DirectionalLight(0xfff0d2, 3.1);
sun.position.set(58, 74, 34);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 240;
sun.shadow.camera.left = -80;
sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80;
sun.shadow.camera.bottom = -80;
sun.shadow.bias = -0.0012;
scene.add(sun);
scene.add(sun.target);
const hemi = new THREE.HemisphereLight(0xbcd6ef, 0x9c8258, 1.15);
scene.add(hemi);

/* ---------------------------------------------------------------------- ground */

function makeSand(): THREE.CanvasTexture {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const n = fbm2(u * 9, v * 9, 5, 4);
      const fine = fbm2(u * 46, v * 46, 11, 2);
      const ripple = 0.5 + 0.5 * Math.sin((u * 34 + fbm2(u * 4, v * 4, 3, 2) * 4) * Math.PI);
      const k = 0.86 + 0.22 * n + 0.1 * fine + 0.06 * ripple;
      const i = (y * S + x) * 4;
      img.data[i] = Math.min(255, 206 * k);
      img.data[i + 1] = Math.min(255, 179 * k);
      img.data[i + 2] = Math.min(255, 138 * k);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(26, 26);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const groundGeo = new THREE.PlaneGeometry(256, 256, 72, 72);
groundGeo.rotateX(-Math.PI / 2);
{
  const pos = groundGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ map: makeSand(), roughness: 0.96, metalness: 0 }));
ground.receiveShadow = true;
scene.add(ground);

const water = new THREE.Mesh(
  new THREE.CircleGeometry(POND_R + 1.5, 64),
  new THREE.MeshStandardMaterial({ color: 0x2c6c86, roughness: 0.14, metalness: 0.4, transparent: true, opacity: 0.94 }),
);
water.rotation.x = -Math.PI / 2;
water.position.set(POND_X, WATER_Y, POND_Z);
scene.add(water);

/* -------------------------------------------------------------------- effects */

let lib: ReturnType<typeof createSurfaceLibrary> | null = null;
try {
  lib = createSurfaceLibrary({ anisotropy: renderer.capabilities.getMaxAnisotropy(), size: 256, full: true });
} catch {
  lib = null;
}
const fallbackLib = {
  surfaces: {} as never,
  mat: () => new THREE.MeshStandardMaterial(),
  clone: () => new THREE.MeshStandardMaterial(),
  unlit: () => new THREE.MeshBasicMaterial(),
  dispose: () => undefined,
};
const fx = createEffects(scene, (lib ?? fallbackLib) as never, {
  quality: QUALITY,
  maxParticles: 4000,
  terrainHeight,
});
(window as unknown as { __FX__: unknown }).__FX__ = fx;

/* ---------------------------------------------------------------- demo script */

interface Scheduled {
  t: number;
  kind: number;
  a?: number;
  b?: number;
  c?: number;
  d?: number;
}
interface Step {
  label: string;
  note: string;
  dur: number;
  x: number;
  z: number;
  events: Scheduled[];
}

const STEPS: Step[] = [
  {
    label: 'Explosion',
    note: 'fireball · dark smoke · ground dust ring · sparks · point light · crater decal',
    dur: 2.6,
    x: 26,
    z: 8,
    events: [
      { t: 0.06, kind: EKIND.EXPLOSION, a: 1.25 },
      { t: 0.07, kind: EKIND.SCORCH, a: 1.75, b: 0.3 },
      { t: 0.45, kind: EKIND.SMOKE_PUFF, a: 1 },
    ],
  },
  {
    label: 'Big explosion',
    note: 'bigger · slower · shockwave ring · flying debris · long smoke column',
    dur: 3.2,
    x: 36,
    z: -18,
    events: [
      { t: 0.06, kind: EKIND.BIG_EXPLOSION, a: 2.2 },
      { t: 0.07, kind: EKIND.SCORCH, a: 3.1, b: 0.6 },
      { t: 0.09, kind: EKIND.DEBRIS, a: 18, b: 0.5 },
      { t: 0.9, kind: EKIND.SMOKE_PUFF, a: 1.4 },
    ],
  },
  {
    label: 'Muzzle flash + tracer',
    note: 'oriented flash (heading matched from the projectile) · tracer streaks · ground light',
    dur: 2.4,
    x: 22,
    z: 30,
    events: [
      { t: 0.05, kind: EKIND.MUZZLE_FLASH, a: 3.6 },
      { t: 0.06, kind: EKIND.TRACER, a: 2.55, b: 0.07, c: 130 },
      { t: 0.3, kind: EKIND.MUZZLE_FLASH, a: 3.6 },
      { t: 0.31, kind: EKIND.TRACER, a: 2.5, b: 0.05, c: 130 },
      { t: 0.6, kind: EKIND.MUZZLE_FLASH, a: 3.6 },
      { t: 0.61, kind: EKIND.TRACER, a: 2.6, b: 0.09, c: 130 },
      { t: 0.95, kind: EKIND.MUZZLE_FLASH, a: 3.6 },
      { t: 0.96, kind: EKIND.TRACER, a: 2.52, b: 0.06, c: 130 },
    ],
  },
  {
    label: 'Impact',
    note: 'metal hit: spark shower · ground hit: dust burst + hot flash',
    dur: 2.4,
    x: 18,
    z: 4,
    events: [
      { t: 0.05, kind: EKIND.IMPACT, a: 1.1 },
      { t: 0.3, kind: EKIND.IMPACT, a: 0.9 },
      { t: 0.55, kind: EKIND.IMPACT, a: 1.4 },
      { t: 0.85, kind: EKIND.IMPACT, a: 1.2 },
    ],
  },
  {
    label: 'Dust',
    note: 'tyre / rotor wash: drifts with the wind, catches the sun, grows and fades',
    dur: 2.6,
    x: 12,
    z: -20,
    events: [
      { t: 0.04, kind: EKIND.DUST, a: 1.2 },
      { t: 0.3, kind: EKIND.DUST, a: 0.9 },
      { t: 0.6, kind: EKIND.DUST, a: 1.4 },
      { t: 1.0, kind: EKIND.DUST, a: 1.1 },
    ],
  },
  {
    label: 'Water splash',
    note: 'vertical spray columns · mist · expanding foam ring',
    dur: 3.0,
    x: POND_X,
    z: POND_Z,
    events: [
      { t: 0.05, kind: EKIND.WATER_SPLASH, a: 2.1 },
      { t: 0.7, kind: EKIND.WATER_SPLASH, a: 1.2 },
      { t: 1.4, kind: EKIND.WATER_SPLASH, a: 2.6 },
    ],
  },
  {
    label: 'Smoke puff',
    note: 'damaged vehicle: dark, rising, long lived',
    dur: 3.0,
    x: 28,
    z: -4,
    events: [
      { t: 0.05, kind: EKIND.SMOKE_PUFF, a: 1.1 },
      { t: 0.5, kind: EKIND.SMOKE_PUFF, a: 1.3 },
      { t: 1.0, kind: EKIND.SMOKE_PUFF, a: 1 },
      { t: 1.5, kind: EKIND.SMOKE_PUFF, a: 1.2 },
    ],
  },
  {
    label: 'Debris',
    note: 'arcing chunks that bounce off the terrain and settle',
    dur: 3.2,
    x: 31,
    z: 22,
    events: [
      { t: 0.05, kind: EKIND.DEBRIS, a: 20, b: 0.55 },
      { t: 0.8, kind: EKIND.DEBRIS, a: 12, b: 0.4 },
    ],
  },
  {
    label: 'Shockwave',
    note: 'expanding translucent ground ring + dust front',
    dur: 2.4,
    x: 16,
    z: -30,
    events: [
      { t: 0.05, kind: EKIND.SHOCKWAVE, a: 1.8 },
      { t: 0.9, kind: EKIND.SHOCKWAVE, a: 1.2 },
    ],
  },
  {
    label: 'Scorch decal',
    note: 'terrain decals: slope-aligned, multiplied into the ground, fading',
    dur: 2.4,
    x: 8,
    z: -6,
    events: [
      { t: 0.05, kind: EKIND.SCORCH, a: 3.6, b: 0.2 },
      { t: 0.5, kind: EKIND.SCORCH, a: 2.4, b: 0.7 },
      { t: 1.0, kind: EKIND.SCORCH, a: 5.0, b: 0.4 },
      { t: 1.4, kind: EKIND.IMPACT, a: 1.2 },
    ],
  },
  {
    label: 'Vehicle destroyed',
    note: 'big explosion + debris + burning smoke column',
    dur: 3.4,
    x: 34,
    z: 2,
    events: [
      { t: 0.05, kind: EKIND.VEHICLE_DESTROYED, a: 1.9 },
      { t: 0.06, kind: EKIND.SCORCH, a: 3.4, b: 0.5 },
    ],
  },
];

const active = ONLY ? STEPS.filter((s) => s.label.toLowerCase().includes(ONLY.toLowerCase())) : STEPS;
const steps = active.length > 0 ? active : STEPS;
const CYCLE = steps.reduce((sum, s) => sum + s.dur, 0);

/* --------------------------------------------------------------------- state */

const statsEl = document.getElementById('stats') as HTMLDivElement;
const labelEl = document.getElementById('label') as HTMLDivElement;
const modeEl = document.getElementById('mode') as HTMLSpanElement;
modeEl.textContent = STRESS
  ? 'stress: 60 explosions / second'
  : `${ONLY ? `only=${ONLY} · ` : ''}${steps.length} scripted steps · ${CYCLE.toFixed(1)} s loop`;

const ev: EventView = { kind: 0, x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, d: 0 };
const emit = (kind: number, x: number, y: number, z: number, a = 0, b = 0, c = 0, d = 0): void => {
  ev.kind = kind;
  ev.x = x;
  ev.y = y;
  ev.z = z;
  ev.a = a;
  ev.b = b;
  ev.c = c;
  ev.d = d;
  fx.spawn(ev);
};

let clockT = 0;
let stepIndex = 0;
let stepT = 0;
let eventCursor = 0;
let orbit = 0.6;
let stressAccum = 0;
let benchMs = 0;

const targetPos = new THREE.Vector3(steps[0].x, terrainHeight(steps[0].x, steps[0].z), steps[0].z);
const camPos = new THREE.Vector3();

function emitStress(dt: number): void {
  stressAccum += dt * 60;
  const n = Math.min(12, Math.floor(stressAccum));
  stressAccum -= n;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * 46;
    const x = 22 + Math.cos(a) * r;
    const z = Math.sin(a) * r;
    emit(Math.random() < 0.35 ? EKIND.BIG_EXPLOSION : EKIND.EXPLOSION, x, terrainHeight(x, z) + 0.6, z, 1 + Math.random() * 1.6);
  }
}

function stepDemo(dt: number): void {
  if (STRESS) {
    emitStress(dt);
    return;
  }
  stepT += dt;
  const step = steps[stepIndex];
  while (eventCursor < step.events.length && step.events[eventCursor].t <= stepT) {
    const e = step.events[eventCursor++];
    const jitterX = e.kind === EKIND.DEBRIS || e.kind === EKIND.DUST ? (Math.random() - 0.5) * 3 : 0;
    const jitterZ = e.kind === EKIND.DEBRIS ? (Math.random() - 0.5) * 3 : 0;
    const x = step.x + jitterX;
    const z = step.z + jitterZ;
    const y = e.kind === EKIND.WATER_SPLASH ? WATER_Y + 0.15 : terrainHeight(x, z) + 0.4;
    emit(e.kind, x, y, z, e.a ?? 0, e.b ?? 0, e.c ?? 0, e.d ?? 0);
  }
  if (stepT >= step.dur) {
    stepT = 0;
    eventCursor = 0;
    stepIndex = (stepIndex + 1) % steps.length;
  }
}

function updateCamera(dt: number): void {
  if (STRESS) {
    targetPos.set(18, 1, 0);
  } else {
    const step = steps[stepIndex];
    const gy = terrainHeight(step.x, step.z);
    targetPos.lerp(camPos.set(step.x, gy + 1.5, step.z), Math.min(1, dt * 1.8));
  }
  orbit += dt * 0.075;
  const radius = CAM_DIST;
  const elev = CAM_PITCH;
  camPos.set(
    targetPos.x + Math.cos(orbit) * radius * Math.cos(elev),
    targetPos.y + radius * Math.sin(elev),
    targetPos.z + Math.sin(orbit) * radius * Math.cos(elev),
  );
  camera.position.copy(camPos);
  camera.lookAt(targetPos);
  sun.target.position.copy(targetPos);
  sun.target.updateMatrixWorld();
}

function statsLine(): string {
  const s = fx.stats();
  return [
    `particles  ${String(s.particles).padStart(5)}`,
    `decals     ${String(s.decals).padStart(5)}`,
    `draw calls ${String(s.drawCalls).padStart(5)}`,
    `update     ${benchMs.toFixed(2)} ms`,
    `quality    ${QUALITY}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ main loop */

let frame = 0;
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;

function renderFrame(dt: number): void {
  fx.update(dt, camera);
  renderer.render(scene, camera);
}

function advance(dt: number): void {
  clockT += dt;
  stepDemo(dt);
  updateCamera(dt);
  renderFrame(dt);
  (window as unknown as { __FX_STATS__: unknown }).__FX_STATS__ = {
    t: clockT,
    label: STRESS ? 'stress' : steps[stepIndex].label,
    updateMs: benchMs,
    fps,
    ...fx.stats(),
  };
}

function schedule(): void {
  if (FRAME_GAP > 0) window.setTimeout(loop, FRAME_GAP);
  else requestAnimationFrame(loop);
}

function loop(): void {
  schedule();
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  // The demo runs on wall-clock time so the sequence keeps its pace even at 3 fps; the
  // particle simulation clamps its own step internally.
  if (dt > 0.5) dt = 0.5;
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum > 0.5) {
    fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }
  if (!frozen) {
    advance(dt);
  } else if (frame < 4) {
    // Deterministic frame: draw it a few times so it is definitely composited, then idle.
    renderer.render(scene, camera);
  }
  frame++;
  if (frame % 6 === 0 || frame < 3) {
    statsEl.textContent = statsLine();
    const step = steps[stepIndex];
    labelEl.innerHTML = `${STRESS ? 'stress test' : step.label}<small>${STRESS ? '60 explosions / second — pooled, capped, recycled' : step.note}</small>`;
  }
}

let last = performance.now();
let frozen = false;

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
window.addEventListener('resize', resize);
resize();

/* Deterministic fast-forward: run the whole demo (or the stress run) at a fixed 1/60 step,
 * then freeze so a screenshot always lands on exactly the same frame. */
if (FREEZE_AT !== null && Number.isFinite(FREEZE_AT)) {
  const dt = 1 / 60;
  const n = Math.max(1, Math.round(FREEZE_AT / dt));
  for (let i = 0; i < n; i++) {
    clockT += dt;
    stepDemo(dt);
    updateCamera(dt);
    fx.update(dt, camera);
  }
  renderer.render(scene, camera);
  frozen = true;
  modeEl.textContent += ` · frozen at t=${FREEZE_AT.toFixed(2)} s`;
}

/* CPU benchmark: fill the pools with 60 explosions/second, then time `Effects.update()` alone
 * (no GPU work at all), report it and freeze. */
if (BENCH) {
  const dt = 1 / 60;
  for (let i = 0; i < 200; i++) {
    stepDemo(dt);
    updateCamera(dt);
    fx.update(dt, camera);
  }
  const frames = 180;
  let ms = 0;
  for (let i = 0; i < frames; i++) {
    stepDemo(dt);
    updateCamera(dt);
    const t0 = performance.now();
    fx.update(dt, camera);
    ms += performance.now() - t0;
  }
  benchMs = ms / frames;
  const s = fx.stats();
  (window as unknown as { __BENCH__: unknown }).__BENCH__ = { updateMs: benchMs, ...s };
  const el = document.getElementById('title') as HTMLDivElement;
  el.innerHTML = `<b>BENCH</b><span>${s.particles} live particles · ${s.drawCalls} draw calls · update() ${benchMs.toFixed(2)} ms/frame (CPU only)</span>`;
  frozen = true;
}

renderer.render(scene, camera);
statsEl.textContent = statsLine();
last = performance.now();
(window as unknown as { __READY__: boolean }).__READY__ = true;
schedule();
