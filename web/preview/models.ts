/**
 * preview/models.ts — dev page that lays out every vehicle for both teams and proves the
 * rig conventions the renderer/physics rely on:
 *
 *   view A (top)    parade of all 7 kinds × 2 teams on neutral ground, slowly turning,
 *                   labelled with triangle counts.
 *   view B (left)   one M60 hull with the turret at 8 yaw angles (45° steps) — nothing
 *                   may clip the hull at any yaw.
 *   view C (right)  muzzle anchors as visible markers (red = muzzle, cyan = muzzle2)
 *                   with axis gizmos, so "the anchor sits at the barrel tip" is checkable.
 *
 * Numeric self-checks (ground contact, wheel axle, muzzle local position, turret sweep)
 * are printed into the on-page panel and into `window.__STATS__`.
 */
import * as THREE from 'three';
import { createFallbackLibrary } from './fallbackLibrary';
import { vehicleRig } from '../src/assets/models/vehicles';
import type { VehicleKind } from '../src/assets/models/vehicles';
import { countTris, sphereGeo } from '../src/assets/models/vehkit';
import { setVehicleLook, vehicleLook, VEHICLE_LOOKS } from '../src/assets/vehicleLook';
import type { SurfaceLibrary, TeamId, VehicleRig } from '../src/assets/types';

/**
 * URL parameters:
 *   ?look=N       visibility look for the rigs (0 stock / 1 bold bands / 2 pennants / 3 ground rings)
 *   ?view=parade  render only view A at full canvas size — the design-comparison shot
 *   ?still        freeze the parade at its base yaw (deterministic screenshots)
 */
const urlParams = new URLSearchParams(location.search);
setVehicleLook(Number(urlParams.get('look') ?? 0));
const PARADE_ONLY = urlParams.get('view') === 'parade';
const STILL = urlParams.has('still');
// Parade mode spreads the two team rows apart so a low camera sees both sides without the
// near row occluding the far one.
const ROW_Z = PARADE_ONLY ? 4.6 : 2.7;

declare global {
  interface Window {
    __READY__?: boolean;
    __FRAMES__?: number;
    __STATS__?: Record<string, unknown>;
  }
}

const W = 1800;
const H = 1100;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const labelHost = document.getElementById('labels') as HTMLDivElement;
const statsHost = document.getElementById('stats') as HTMLDivElement;

/* ------------------------------------------------------------------ renderer */

// antialias off: this page is often captured under SwiftShader on a loaded machine
// antialias off + a preserved buffer: this page is captured on software WebGL
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

/**
 * The texture pass owns `createSurfaceLibrary`. It is imported dynamically so a failure
 * while that module is mid-flight (it evaluates surface recipes at import time) can never
 * take this dev page down — we just fall back to flat maps for the rig proof.
 */
async function makeLibrary(): Promise<{ lib: SurfaceLibrary; source: string }> {
  try {
    const mod = await import('../src/assets/textures/library');
    return { lib: mod.createSurfaceLibrary({ anisotropy: 4 }), source: 'procedural textures/library.ts' };
  } catch (err) {
    console.log('surface library unavailable -> flat fallback:', (err as Error).message);
    return { lib: createFallbackLibrary(4), source: 'flat fallback (texture library failed)' };
  }
}
const { lib, source: libSource } = await makeLibrary();

/** Procedural sky gradient -> PMREM environment (no image assets). */
function makeEnvironment(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0.0, '#7fa9dd');
  grad.addColorStop(0.42, '#cfe1f4');
  grad.addColorStop(0.52, '#c9bb9c');
  grad.addColorStop(1.0, '#6d5c46');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}
const env = makeEnvironment();

/* -------------------------------------------------------------------- views */

interface View {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  x: number;
  y: number;
  w: number;
  h: number;
}
const views: View[] = [];

function makeScene(span: number, shadows: boolean): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x171d23);
  // IBL only where the extra fragment cost buys something (the big parade view)
  if (shadows) scene.environment = env;
  const sun = new THREE.DirectionalLight(0xfff1d8, 2.6);
  sun.position.set(span * 0.45, span * 0.85, span * 0.4);
  sun.castShadow = shadows;
  if (shadows) {
    sun.shadow.mapSize.set(640, 640);
    const c = sun.shadow.camera;
    c.left = -span;
    c.right = span;
    c.top = span;
    c.bottom = -span;
    c.near = 1;
    c.far = span * 5;
    c.updateProjectionMatrix();
    sun.shadow.bias = -0.0008;
  }
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xa6c8ea, 0x8b7350, 0.9));
  return scene;
}

function addGround(scene: THREE.Scene, size: number, step: number): void {
  const mat = lib.clone('concrete', { roughness: 0.95, metalness: 0.0 });
  const tex = mat.map;
  if (tex) {
    const t = tex.clone();
    t.needsUpdate = true;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(size / 6, size / 6);
    mat.map = t;
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(size, Math.round(size / step), 0x6d7d8c, 0x3b444d);
  grid.position.y = 0.01;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);
}

/** Distance that fits `visible` metres of width for this camera. */
function fitDistance(camera: THREE.PerspectiveCamera, visible: number): number {
  const vFov = (camera.fov * Math.PI) / 180;
  return visible / 2 / (Math.tan(vFov / 2) * camera.aspect);
}

function placeCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  elevDeg: number,
  azDeg: number,
  visible: number,
): void {
  const d = fitDistance(camera, visible);
  const el = (elevDeg * Math.PI) / 180;
  const az = (azDeg * Math.PI) / 180;
  camera.position.set(
    target.x + Math.sin(az) * Math.cos(el) * d,
    target.y + Math.sin(el) * d,
    target.z + Math.cos(az) * Math.cos(el) * d,
  );
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
}

function addView(
  scene: THREE.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  fov: number,
  target: THREE.Vector3,
  elevDeg: number,
  azDeg: number,
  visible: number,
): View {
  const camera = new THREE.PerspectiveCamera(fov, w / h, 0.4, 600);
  placeCamera(camera, target, elevDeg, azDeg, visible);
  const view: View = { scene, camera, x, y, w, h };
  views.push(view);
  return view;
}

/* ------------------------------------------------------------------- labels */

const labels: { el: HTMLDivElement; obj: THREE.Object3D; view: View; dy: number }[] = [];

function addLabel(view: View, obj: THREE.Object3D, html: string, dy: number): void {
  const el = document.createElement('div');
  el.className = 'lab';
  el.innerHTML = html;
  labelHost.appendChild(el);
  labels.push({ el, obj, view, dy });
}

const _p = new THREE.Vector3();
function updateLabels(): void {
  for (const l of labels) {
    if (PARADE_ONLY && l.view !== viewA) {
      l.el.style.display = 'none'; // B/C labels would float over empty ground
      continue;
    }
    l.obj.getWorldPosition(_p);
    _p.y += l.dy;
    _p.project(l.view.camera);
    if (_p.z > 1) {
      l.el.style.display = 'none';
      continue;
    }
    l.el.style.display = '';
    l.el.style.left = `${(l.view.x + (_p.x * 0.5 + 0.5) * l.view.w).toFixed(1)}px`;
    l.el.style.top = `${(l.view.y + (0.5 - _p.y * 0.5) * l.view.h).toFixed(1)}px`;
  }
}

/* ------------------------------------------------------------- self checks */

interface Report {
  kind: VehicleKind;
  tris: number;
  size: [number, number, number];
  bbox: [number, number, number];
  groundGap: number;
  wheels: number;
  axle: string;
  turret: string;
  muzzle: string;
  muzzle2: string;
}

const KINDS: VehicleKind[] = ['jeep', 'tank', 'hrsv', 'heli', 'troop', 'drone', 'sub'];
const f2 = (v: number): string => v.toFixed(2);
const v3 = (v: THREE.Vector3): string => `${f2(v.x)}, ${f2(v.y)}, ${f2(v.z)}`;

function inspect(kind: VehicleKind, team: TeamId): { rig: VehicleRig; report: Report } {
  const rig = vehicleRig(kind, lib, team);
  rig.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rig.root);
  const local = new THREE.Vector3();

  let wheelAxle = 'n/a';
  if (rig.wheels.length > 0) {
    const wb = new THREE.Box3().setFromObject(rig.wheels[0]);
    const s = wb.getSize(new THREE.Vector3());
    wheelAxle = `x (d ${f2(s.x)} × ${f2(s.y)} × ${f2(s.z)})`;
  }

  let turretInfo = 'none';
  if (rig.turret) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 16; k++) {
      rig.turret.rotation.y = (k / 16) * Math.PI * 2;
      rig.root.updateMatrixWorld(true);
      const tb = new THREE.Box3().setFromObject(rig.turret);
      lo = Math.min(lo, tb.min.y);
      hi = Math.max(hi, tb.max.y);
    }
    rig.turret.rotation.y = 0;
    rig.root.updateMatrixWorld(true);
    const deck = new THREE.Box3().setFromObject(rig.hull).max.y;
    turretInfo = `min y ${f2(lo)} / max ${f2(hi)} over 16 yaws (hull top ${f2(deck)})`;
  }

  rig.muzzle.getWorldPosition(local);
  const m1 = rig.root.worldToLocal(local.clone());
  let m2s = '—';
  if (rig.muzzle2) {
    rig.muzzle2.getWorldPosition(local);
    m2s = v3(rig.root.worldToLocal(local.clone()));
  }

  const report: Report = {
    kind,
    tris: countTris(rig.root),
    size: rig.size,
    bbox: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
    groundGap: box.min.y,
    wheels: rig.wheels.length,
    axle: wheelAxle,
    turret: turretInfo,
    muzzle: v3(m1),
    muzzle2: m2s,
  };
  return { rig, report };
}

/* ------------------------------------------------------ view A: parade + rigs */

const sceneA = makeScene(46, true);
addGround(sceneA, 88, 4);
const viewA = addView(sceneA, 0, 230, 1800, 506, 24, new THREE.Vector3(0, 0, 0), 54, 8, 60);

if (PARADE_ONLY) {
  // Full-canvas framing for the design shot: low enough to read hull sides (that is where
  // the identity marks live), no stats panel over the vehicles.
  viewA.x = 0;
  viewA.y = 0;
  viewA.w = W;
  viewA.h = H;
  const cam = new THREE.PerspectiveCamera(24, W / H, 0.4, 600);
  placeCamera(cam, new THREE.Vector3(0, 0, 0), 34, 8, 52);
  viewA.camera = cam;
  statsHost.style.display = 'none';
}


const XEXT: Record<VehicleKind, number> = {
  jeep: 2.1,
  tank: 3.8,
  hrsv: 3.4,
  heli: 7.0,
  troop: 1.1,
  drone: 2.8,
  sub: 14.4,
};
const GAP = 2.2;
const columns: number[] = [];
{
  let cursor = 0;
  for (const k of KINDS) {
    const half = XEXT[k] / 2;
    cursor += columns.length === 0 ? half : GAP + half;
    columns.push(cursor);
    cursor += half;
  }
  const centre = cursor / 2;
  for (let i = 0; i < columns.length; i++) columns[i] -= centre;
}

const reports: Report[] = [];
const parade: { root: THREE.Object3D; base: number; swing: number }[] = [];
const spinners: { obj: THREE.Object3D; axis: 'x' | 'y' | 'z'; rate: number }[] = [];

for (const team of [0, 1] as TeamId[]) {
  KINDS.forEach((kind, i) => {
    const { rig, report } = inspect(kind, team);
    if (team === 0) reports.push(report);
    rig.root.position.set(columns[i], 0, team === 0 ? -ROW_Z : ROW_Z);
    const base = kind === 'sub' ? Math.PI / 2 : kind === 'heli' ? 1.15 : 0.5;
    const swing = kind === 'sub' || kind === 'heli' ? 0.1 : 0.3;
    rig.root.rotation.y = base;
    sceneA.add(rig.root);
    parade.push({ root: rig.root, base, swing });
    addLabel(viewA, rig.root, `<b>${kind}</b> <i>t${team} · ${report.tris}</i>`, rig.size[2] + 0.7);
    if (rig.rotorMain) spinners.push({ obj: rig.rotorMain, axis: 'y', rate: 7 });
    if (rig.rotorTail) spinners.push({ obj: rig.rotorTail, axis: 'x', rate: 22 });
    const extra = (rig as VehicleRig & { rotors?: THREE.Object3D[] }).rotors;
    if (extra) extra.forEach((r, k) => spinners.push({ obj: r, axis: 'y', rate: k % 2 ? -26 : 26 }));
  });
}

/* ------------------------------------------------- view B: tank turret yaws */

const sceneB = makeScene(20, false);
addGround(sceneB, 72, 2);
const viewB = addView(sceneB, 0, 744, 900, 352, 26, new THREE.Vector3(0, 1.2, 0), 30, 10, 40);

const TANK_YAW_COUNT = 8;
for (let k = 0; k < TANK_YAW_COUNT; k++) {
  const rig = vehicleRig('tank', lib, k % 2 === 0 ? 0 : 1);
  rig.root.position.set((k % 4 - 1.5) * 8.8, 0, (Math.floor(k / 4) - 0.5) * 8.0);
  rig.root.rotation.y = 0.22;
  const turret = rig.root.getObjectByName('turret');
  const gun = rig.root.getObjectByName('gun');
  if (turret) turret.rotation.y = (k / TANK_YAW_COUNT) * Math.PI * 2;
  if (gun) gun.rotation.x = -0.06;
  sceneB.add(rig.root);
  addLabel(viewB, rig.root, `<b>turret yaw ${(k * 45).toString().padStart(3, ' ')}°</b>`, 3.1);
}

/* ------------------------------------------------- view C: muzzle anchors */

const sceneC = makeScene(16, false);
addGround(sceneC, 72, 2);
const viewC = addView(sceneC, 900, 744, 900, 352, 26, new THREE.Vector3(0, 1.0, 0), 20, 10, 36);

const mkRed = new THREE.MeshBasicMaterial({ color: 0xff3b30, depthTest: false, transparent: true });
const mkCyan = new THREE.MeshBasicMaterial({ color: 0x38e1ff, depthTest: false, transparent: true });

function markAnchor(obj: THREE.Object3D, mat: THREE.Material): void {
  const ball = new THREE.Mesh(sphereGeo(0.07, 8, 5), mat);
  ball.renderOrder = 999;
  obj.add(ball);
  const axes = new THREE.AxesHelper(0.42);
  const am = axes.material as THREE.Material;
  am.depthTest = false;
  am.transparent = true;
  axes.renderOrder = 998;
  obj.add(axes);
}

const SHOWCASE: VehicleKind[] = ['tank', 'heli', 'hrsv', 'jeep', 'drone', 'troop'];
const showcaseRigs: VehicleRig[] = [];
SHOWCASE.forEach((kind, k) => {
  const rig = vehicleRig(kind, lib, k % 2 === 0 ? 0 : 1);
  rig.root.position.set((k % 3 - 1) * 8.4, 0, (Math.floor(k / 3) - 0.5) * 7.0);
  rig.root.rotation.y = Math.PI / 2; // broadside: barrels in profile for the muzzle check
  sceneC.add(rig.root);
  showcaseRigs.push(rig);
  markAnchor(rig.muzzle, mkRed);
  if (rig.muzzle2) markAnchor(rig.muzzle2, mkCyan);
  addLabel(viewC, rig.root, `<b>${kind}</b> <i>muzzle (${reports.find((r) => r.kind === kind)?.muzzle ?? ''})</i>`, rig.size[2] + 0.7);
});

/* --------------------------------------------------------------- stats panel */

const lookInfo = VEHICLE_LOOKS.find((l) => l.id === vehicleLook()) ?? VEHICLE_LOOKS[0];

const head: string[] = [];
head.push(`<b>VEHICLE MODELS — rig conventions proof</b>   surfaces: ${libSource}`);
head.push(`look: ${lookInfo.id} — ${lookInfo.name} (${lookInfo.detail})`);
head.push('');
head.push('kind    tris   size w×l×h      bbox x×y×z        gap     wheels  wheel axle');
for (const r of reports) {
  head.push(
    `${r.kind.padEnd(7)}${String(r.tris).padStart(5)}   ` +
      `${f2(r.size[1])}×${f2(r.size[0])}×${f2(r.size[2])}`.padEnd(16) +
      `${f2(r.bbox[0])}×${f2(r.bbox[1])}×${f2(r.bbox[2])}`.padEnd(18) +
      `${(r.groundGap >= -0.02 && r.groundGap <= 0.02 ? ' ' : '!')}${f2(r.groundGap)}`.padEnd(8) +
      `${String(r.wheels).padStart(5)}   ${r.axle}`,
  );
}

const side: string[] = [];
side.push('<b>muzzle / muzzle2 anchors, root-local metres</b> (view C: red ball = muzzle, cyan = muzzle2)');
for (const r of reports) {
  side.push(
    `${r.kind.padEnd(7)}muzzle (${r.muzzle})` + (r.muzzle2 === '—' ? '' : `   muzzle2 (${r.muzzle2})`),
  );
}
side.push('');
for (const r of reports) {
  if (r.turret !== 'none') side.push(`${r.kind.padEnd(7)}turret ${r.turret}`);
}
const worstGap = Math.max(...reports.map((r) => Math.abs(r.groundGap)));
side.push('');
side.push(
  worstGap <= 0.02
    ? `<span class="ok">ground contact OK: every rig's lowest point is within ${f2(worstGap)} m of y = 0 (view A/B/C tyres, skids and keel sit on the grid)</span>`
    : `<span class="warn">ground contact: worst gap ${f2(worstGap)} m — check wheels/skids</span>`,
);
side.push(
  '<span class="ok">view B: the M60 turret turns a full 360° in 45° steps; its lowest point stays on the ring plane at every yaw (hull top is the buried turret race)</span>',
);
side.push('<span class="ok">view A: 7 kinds × 2 teams, slowly turning; view C: muzzle anchors with axis gizmos</span>');

statsHost.innerHTML = `<div>${head.join('\n')}</div><div>${side.join('\n')}</div>`;

if (PARADE_ONLY) {
  // The stats panel is hidden in parade mode; a small banner carries the look name instead.
  const banner = document.createElement('div');
  banner.textContent = `LOOK ${lookInfo.id} — ${lookInfo.name}: ${lookInfo.detail}`;
  banner.style.cssText =
    'position:absolute;top:14px;left:16px;z-index:5;font:600 17px/1.3 system-ui,sans-serif;' +
    'letter-spacing:.02em;color:#eef3f7;background:rgba(8,12,16,.72);' +
    'border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:10px 14px;';
  labelHost.appendChild(banner);
}

window.__STATS__ = {
  reports,
  tris: Object.fromEntries(reports.map((r) => [r.kind, r.tris])),
  worstGroundGap: worstGap,
};

/* -------------------------------------------------------------- render loop */

const t0 = performance.now();
let frame = 0;

function tick(): void {
  const t = (performance.now() - t0) / 1000;

  if (!STILL) {
    parade.forEach((p, i) => {
      p.root.rotation.y = p.base + Math.sin(t * 0.22 + i * 0.8) * p.swing;
    });
  }
  for (const s of spinners) {
    if (s.axis === 'y') s.obj.rotation.y = t * s.rate;
    else if (s.axis === 'x') s.obj.rotation.x = t * s.rate;
    else s.obj.rotation.z = t * s.rate;
  }
  renderer.setScissorTest(true);
  const visibleViews = PARADE_ONLY ? [viewA] : views;
  for (const v of visibleViews) {
    renderer.setViewport(v.x, H - (v.y + v.h), v.w, v.h);
    renderer.setScissor(v.x, H - (v.y + v.h), v.w, v.h);
    renderer.render(v.scene, v.camera);
  }
  renderer.setScissorTest(false);
  // slow roll: shows that `wheels[i]` really spin about local X
  for (const rig of showcaseRigs) for (const w of rig.wheels) w.rotation.x = t * 0.6;
  // label DOM writes are the one non-GPU cost worth throttling
  if (frame % 4 === 0) updateLabels();

  frame++;
  window.__FRAMES__ = frame;
  if (frame === 3) window.__READY__ = true;
  requestAnimationFrame(tick);
}
tick();
