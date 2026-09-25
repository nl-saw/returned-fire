/**
 * preview/structures.ts — visual harness for the procedural structure + prop models.
 *
 * Three viewports in one frame:
 *   A (left)  every `skind` at its authored size on a 26 m pitch, with a 6.9 m tank
 *             reference box, a prop-scatter row and a triangle-count table.
 *   B (top right) a base complex laid out the way the map generator would place it
 *             (garage + HQ + walls + gate + turret towers + helipad + depot + tents),
 *             seen from the in-game camera (60° tilt, ~80 m).
 *   C (bottom right) destroyed (`ruined`) variants next to their intact models.
 *
 * Labels are painted flat on the ground (never billboards over the models) so they
 * cannot hide the silhouettes. Every area carries a 10 m ground grid for scale.
 *
 * Also demonstrates the animation contract: every `animated[i]` node carries an
 * `AnimHint` in `userData.rfAnim` and `poseAnimated()` drives it the way the renderer is
 * expected to.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createSurfaceLibrary } from '../src/assets/textures/library';
import type { StructureModel, SurfaceLibrary, TeamId } from '../src/assets/types';
import { countTriangles } from '../src/assets/models/kit';
import { SKIND, STRUCTURE_SIZE, isUnitSized, structureKindName } from '../src/assets/models/kinds';
import { buildProp, propVariant } from '../src/assets/models/props';
import { buildStructure, type AnimHint } from '../src/assets/models/structures';

declare global {
  interface Window {
    __READY__?: boolean;
    __TRI_TABLE__?: { kind: number; name: string; tris: number; ruined: number; unit: boolean }[];
  }
}

const TEAM: TeamId = 0;
const TILT = THREE.MathUtils.degToRad(60);
const FOV = 40;

const lib: SurfaceLibrary = createSurfaceLibrary({ anisotropy: 4, size: 512, full: false });

/* ------------------------------------------------------------- rendering */

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const W = window.innerWidth;
const H = window.innerHeight;
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.setScissorTest(true);

const scene = new THREE.Scene();

// Generated sky gradient (this project ships no image assets).
function skyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#4d739c');
  grad.addColorStop(0.4, '#9db4c6');
  grad.addColorStop(0.56, '#d9cfb6');
  grad.addColorStop(1.0, '#9a8d72');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(2600, 16, 12),
  new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, toneMapped: false }),
);
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
scene.environmentIntensity = 0.42;

scene.add(new THREE.HemisphereLight(0xbcd2e8, 0xa08a63, 0.5));

const SUN_DIR = new THREE.Vector3(0.7, 0.62, -0.34).normalize();
const sun = new THREE.DirectionalLight(0xfff0d4, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(1536, 1536);
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.05;
scene.add(sun);
scene.add(sun.target);

/* ---------------------------------------------------------------- layout */

interface Area {
  center: THREE.Vector3;
  coverW: number;
  coverH: number;
  radius: number;
  aspect: number;
}

function fitDistance(area: Area): number {
  const halfTan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  return Math.max(area.coverW / (2 * halfTan * area.aspect), (area.coverH * Math.sin(TILT)) / (2 * halfTan));
}

function makeCamera(area: Area, azimuthDeg: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(FOV, area.aspect, 1, 6000);
  const dist = fitDistance(area);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const horiz = dist * Math.cos(TILT);
  cam.position.set(
    area.center.x + Math.sin(az) * horiz,
    area.center.y + dist * Math.sin(TILT),
    area.center.z + Math.cos(az) * horiz,
  );
  cam.lookAt(area.center);
  cam.updateMatrixWorld();
  return cam;
}

interface View {
  cam: THREE.PerspectiveCamera;
  x: number;
  y: number;
  w: number;
  h: number;
  area: Area;
}

const BAR = 54;
const usableH = H - BAR;
const splitX = Math.round(W * 0.6);
const halfH = Math.round(usableH / 2);

const areaA: Area = { center: new THREE.Vector3(0, 0, 58), coverW: 126, coverH: 164, radius: 110, aspect: splitX / usableH };
const areaB: Area = { center: new THREE.Vector3(500, 0, 0), coverW: 84, coverH: 66, radius: 58, aspect: (W - splitX) / halfH };
const areaC: Area = { center: new THREE.Vector3(-500, 0, 2), coverW: 100, coverH: 66, radius: 62, aspect: (W - splitX) / halfH };

const views: View[] = [
  { cam: makeCamera(areaA, 0), x: 0, y: 0, w: splitX, h: usableH, area: areaA },
  { cam: makeCamera(areaB, 32), x: splitX, y: halfH, w: W - splitX, h: halfH, area: areaB },
  { cam: makeCamera(areaC, 14), x: splitX, y: 0, w: W - splitX, h: halfH, area: areaC },
];

/* ---------------------------------------------------- ground text plates */

interface Line {
  text: string;
  size: number;
  color: string;
  bold?: boolean;
}

/** Multi-line text painted flat on the ground (never occludes the models). */
function textPlate(lines: Line[], w: number, d: number, x: number, z: number, yaw = 0): THREE.Mesh {
  const cw = 1024;
  const ch = 256;
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const total = lines.reduce((a, b) => a + b.size * 1.18, 0);
  let y = (ch - total) / 2;
  g.lineJoin = 'round';
  for (const line of lines) {
    g.font = `${line.bold ? '700' : '500'} ${line.size}px ui-monospace, Menlo, Consolas, monospace`;
    g.textBaseline = 'top';
    g.lineWidth = line.size * 0.2;
    g.strokeStyle = 'rgba(8,10,12,0.9)';
    g.strokeText(line.text, 16, y);
    g.fillStyle = line.color;
    g.fillText(line.text, 16, y);
    y += line.size * 1.18;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  mesh.rotation.set(-Math.PI / 2, 0, yaw);
  mesh.position.set(x, 0.04, z);
  mesh.renderOrder = 2;
  scene.add(mesh);
  return mesh;
}

/* ----------------------------------------------------------------- ground */

const sandMat = lib.mat('sand', { color: 0xc9b083, roughness: 0.95, metalness: 0, flatShading: false });
const apronMat = lib.mat('concreteWorn', { color: 0xb0aca0, roughness: 0.92, metalness: 0, flatShading: false });

function ground(cx: number, cz: number, w: number, d: number, mat: THREE.Material): void {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  g.rotation.x = -Math.PI / 2;
  g.position.set(cx, 0, cz);
  g.receiveShadow = true;
  scene.add(g);
}

/** 10 m ground grid over an area, so every size in the shot can be measured. */
function metricGrid(cx: number, cz: number, span: number): void {
  const grid = new THREE.GridHelper(span, Math.round(span / 10), 0x5f5847, 0x5f5847);
  grid.position.set(cx, 0.02, cz);
  const m = grid.material as THREE.Material;
  m.transparent = true;
  m.opacity = 0.45;
  scene.add(grid);
}

ground(0, 58, 320, 360, sandMat);
metricGrid(0, 58, 200);
ground(500, 0, 190, 170, sandMat);
ground(500, 0, 78, 56, apronMat);
metricGrid(500, 0, 100);
ground(-500, 0, 200, 180, sandMat);
metricGrid(-500, 0, 120);

/* ----------------------------------------------------------------- state */

const anims: { node: THREE.Object3D; hint: AnimHint; base: THREE.Vector3 }[] = [];
const table: { kind: number; name: string; tris: number; ruined: number; unit: boolean }[] = [];

function place(model: StructureModel, x: number, z: number, yaw: number, kind: number): number {
  if (isUnitSized(kind)) model.root.scale.set(model.half[0] * 2, model.height, model.half[1] * 2);
  model.root.position.set(x, 0, z);
  model.root.rotation.y = yaw;
  scene.add(model.root);
  if (model.ruined) {
    model.ruined.scale.copy(model.root.scale);
    model.ruined.position.set(x, 0, z);
    model.ruined.rotation.y = yaw;
    scene.add(model.ruined);
  }
  for (const node of model.animated ?? []) {
    const hint = node.userData.rfAnim as AnimHint | undefined;
    if (hint) anims.push({ node, hint, base: node.position.clone() });
  }
  return countTriangles(model.root);
}

/** Drive every `animated[i]` node from its hint — the contract the renderer must honour. */
function poseAnimated(t: number): void {
  for (const a of anims) {
    const { hint, node, base } = a;
    if (hint.speed !== undefined && hint.travel === undefined) {
      node.rotation.y = t * hint.speed;
    }
    if (hint.travel !== undefined) {
      const period = hint.period ?? 4;
      const phase = 0.5 - 0.5 * Math.cos((t / period) * Math.PI * 2);
      node.position[hint.axis] = base[hint.axis] + hint.travel * phase;
    }
  }
}

/* --------------------------------------------------- A: every skind grid */

const ORDER: number[] = [
  SKIND.GARAGE, SKIND.HQ, SKIND.BUILDING, SKIND.HANGAR, SKIND.BUNKER,
  SKIND.BRIDGE, SKIND.WALL, SKIND.GATE, SKIND.WATCHTOWER, SKIND.TURRET_TOWER,
  SKIND.RADAR, SKIND.ANTENNA, SKIND.LIGHTHOUSE, SKIND.HELIPAD, SKIND.FUEL_DEPOT,
  SKIND.AMMO_TENT, SKIND.TENT, SKIND.SANDBAG, SKIND.CONTAINER, SKIND.CRATE,
  SKIND.BARREL, SKIND.FLAG_POLE, SKIND.WRECK, SKIND.PALM, SKIND.ROCK,
];

const PITCH = 24;
const ROW0 = -10;
let idx = 0;
for (const kind of ORDER) {
  const col = idx % 5;
  const row = Math.floor(idx / 5);
  idx++;
  const x = (col - 2) * PITCH;
  const z = ROW0 + row * PITCH;
  const model = buildStructure(kind, lib, TEAM, 7 + kind);
  const tris = place(model, x, z, 0.34, kind);
  const size = STRUCTURE_SIZE[kind];
  const unit = isUnitSized(kind);
  textPlate(
    [
      { text: structureKindName(kind).toUpperCase(), size: 66, color: '#f4ecd8', bold: true },
      { text: `${size[0]}x${size[1]}x${size[2]}m  ${tris}tri  ${unit ? 'unit' : 'TRUE'}`, size: 42, color: '#cfe0a8' },
    ],
    20,
    5,
    x,
    z + 11,
  );
  table.push({ kind, name: structureKindName(kind), tris, ruined: 0, unit });
}

// Reference row: the 6.9 m tank box everything is read against.
function refBox(w: number, h: number, d: number, x: number, z: number, color: number, label: string, wire = false): void {
  const g = new THREE.Group();
  if (!wire) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lib.mat('metalDark', { color, flatShading: false }));
    mesh.position.y = h / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
    new THREE.LineBasicMaterial({ color: 0xf4ecd8 }),
  );
  edges.position.y = h / 2;
  g.add(edges);
  g.position.set(x, 0, z);
  scene.add(g);
  textPlate([{ text: label, size: 70, color: '#f4ecd8', bold: true }], Math.max(15, label.length * 0.86), 4.6, x, z + 9);
}
refBox(6.9, 2.9, 3.6, -50, 124, 0x3c4045, 'TANK 6.9 x 3.6 x 2.9 m');
refBox(4.1, 1.9, 2.0, -36, 124, 0x474b3c, 'JEEP 4.1 m');
refBox(0.5, 1.8, 0.4, -26, 124, 0x6b6252, 'HUMAN 1.8 m');
refBox(10, 0.12, 0.35, -10, 124, 0xc9b083, 'SCALE BAR 10 m');
refBox(16, 6.5, 13, 26, 124, 0x4a4f3c, 'GARAGE BOX 16 x 13 m', true);

// Natural scatter row.
const PROP_ROW: { kind: number; seed: number; label: string }[] = [
  { kind: SKIND.PALM, seed: 1, label: 'PALM v0' },
  { kind: SKIND.PALM, seed: 2, label: 'PALM v1' },
  { kind: SKIND.PALM, seed: 3, label: 'PALM v2' },
  { kind: SKIND.ROCK, seed: 1, label: 'ROCK v0' },
  { kind: SKIND.ROCK, seed: 2, label: 'ROCK v1' },
  { kind: SKIND.ROCK, seed: 3, label: 'ROCK v2' },
  { kind: SKIND.ROCK, seed: 4, label: 'ROCK v3' },
  { kind: 100, seed: 5, label: 'BUSH 100' },
  { kind: 101, seed: 6, label: 'GRASS 101' },
  { kind: 102, seed: 7, label: 'SHRUB 102' },
  { kind: 103, seed: 8, label: 'AGAVE 103' },
  { kind: 104, seed: 9, label: 'STONES 104' },
];
let px = -58;
for (const item of PROP_ROW) {
  const model = buildProp(item.kind, lib, item.seed);
  model.root.position.set(px, 0, 106);
  scene.add(model.root);
  const tris = countTriangles(model.root);
  textPlate([{ text: `${item.label} ${tris}tri`, size: 68, color: '#ffffff', bold: true }], 12, 4, px, 114);
  px += 10.6;
}

/* ------------------------------------------------- B: in-game base layout */

interface Site {
  kind: number;
  x: number;
  z: number;
  yaw: number;
  team?: TeamId;
}

const SITES: Site[] = [
  { kind: SKIND.GARAGE, x: 13, z: 5, yaw: 0 },
  { kind: SKIND.HQ, x: -12, z: -12, yaw: 0 },
  { kind: SKIND.HELIPAD, x: 25, z: -16, yaw: 0.2 },
  { kind: SKIND.FUEL_DEPOT, x: -25, z: 9, yaw: 0 },
  { kind: SKIND.AMMO_TENT, x: -6, z: 17, yaw: 0.1 },
  { kind: SKIND.TENT, x: 6, z: 20, yaw: -0.2 },
  { kind: SKIND.TURRET_TOWER, x: -32, z: -20, yaw: 0 },
  { kind: SKIND.TURRET_TOWER, x: 33, z: 21, yaw: 0 },
  { kind: SKIND.WATCHTOWER, x: -36, z: 0, yaw: 0.4 },
  { kind: SKIND.RADAR, x: -33, z: 22, yaw: 0 },
  { kind: SKIND.FLAG_POLE, x: -3, z: -2, yaw: 0 },
  { kind: SKIND.CONTAINER, x: 22, z: 20, yaw: 0.3 },
  { kind: SKIND.CONTAINER, x: 22, z: 17, yaw: -0.1 },
  { kind: SKIND.CRATE, x: 8, z: 15, yaw: 0.4 },
  { kind: SKIND.BARREL, x: 6.5, z: 13.5, yaw: 0 },
  { kind: SKIND.SANDBAG, x: 3, z: 14, yaw: -0.5 },
];
for (let i = 0; i < 10; i++) {
  const x = -36 + i * 7.1;
  if (Math.abs(x) < 6.2) continue;
  SITES.push({ kind: SKIND.WALL, x, z: 25, yaw: 0 });
}
for (let i = 0; i < 7; i++) {
  SITES.push({ kind: SKIND.WALL, x: -36, z: -21 + i * 7.1, yaw: Math.PI / 2 });
  SITES.push({ kind: SKIND.WALL, x: 36, z: -21 + i * 7.1, yaw: Math.PI / 2 });
}
for (let i = 0; i < 10; i++) {
  const x = -36 + i * 7.1;
  if (Math.abs(x) < 6.2) continue;
  SITES.push({ kind: SKIND.WALL, x, z: -24, yaw: 0 });
}
SITES.push({ kind: SKIND.GATE, x: 0, z: 25, yaw: 0 });

for (const site of SITES) {
  const model = buildStructure(site.kind, lib, site.team ?? TEAM, 21 + site.kind);
  place(model, 500 + site.x, site.z, site.yaw, site.kind);
}

// Vehicles parked in front of the garage (boxes) for scale.
refBox(6.9, 2.9, 3.6, 500 + 9, 15.5, 0x3d4436, 'TANK 6.9 m');
refBox(4.1, 1.9, 2.0, 500 + 16.5, 15.2, 0x474b3c, 'JEEP 4.1 m');
refBox(10, 0.12, 0.35, 500 - 14, 22.5, 0xc9b083, '10 m');

/* ------------------------------------------- C: destroyed vs intact pairs */

const PAIRS: number[] = [SKIND.WALL, SKIND.BUNKER, SKIND.BUILDING, SKIND.TURRET_TOWER, SKIND.CONTAINER, SKIND.GATE];
let pi = 0;
for (const kind of PAIRS) {
  const col = pi % 3;
  const row = Math.floor(pi / 3);
  pi++;
  const cx = -500 + (col - 1) * 31;
  const cz = (row - 0.5) * 34 + 2;
  const intact = buildStructure(kind, lib, TEAM, 31 + kind);
  const t1 = place(intact, cx - 8.4, cz, 0.25, kind);
  const broken = buildStructure(kind, lib, TEAM, 31 + kind);
  place(broken, cx + 8.4, cz, 0.25, kind);
  if (broken.ruined) {
    broken.root.visible = false;
    broken.ruined.visible = true;
  }
  const rTris = broken.ruined ? countTriangles(broken.ruined) : 0;
  table.push({ kind, name: `${structureKindName(kind)} ruin`, tris: t1, ruined: rTris, unit: isUnitSized(kind) });
  textPlate(
    [{ text: `${structureKindName(kind).toUpperCase()} ${t1}tri`, size: 70, color: '#ffffff', bold: true }],
    16,
    4,
    cx - 8.4,
    cz + 11,
  );
  textPlate([{ text: `RUINED ${rTris}tri`, size: 70, color: '#ffc9a8', bold: true }], 14, 4, cx + 8.4, cz + 11);
}

/* ------------------------------------------------------------- overlays */

// Parity check: the renderer's instanced path builds CRATE/BARREL/SANDBAG/CONTAINER/WRECK
// through buildProp while the single path uses buildStructure — both must match.
const instancedProps = [SKIND.CRATE, SKIND.BARREL, SKIND.SANDBAG, SKIND.CONTAINER, SKIND.WRECK];
function seedForVariant(kind: number, want: number): number {
  for (let s = 0; s < 64; s++) if (propVariant(kind, s) === want) return s;
  return 0;
}
const parityBad = instancedProps.filter((k) => {
  const a = countTriangles(buildProp(k, lib, seedForVariant(k, 0)).root);
  const b = countTriangles(buildStructure(k, lib, TEAM, 3).root);
  return a !== b;
});

const legendA = document.getElementById('legendA') as HTMLElement;
legendA.innerHTML =
  '<b>A - EVERY skind</b> at STRUCTURE_SIZE, 26 m pitch, 10 m ground grid<br />' +
  '<span class="k">unit</span> = renderer scales by (w,h,d) from the Structure record - ' +
  '<span class="k">TRUE</span> = authored at true metres, yaw only<br />' +
  'radar dish / turret pod / gate leaves / garage door / flag / beacon posed at t=1.15 s<br />' +
  `instanced-path parity (buildProp vs buildStructure): ${parityBad.length === 0 ? 'OK - crate, barrel, sandbag, container, wreck' : 'MISMATCH ' + parityBad.map((k) => structureKindName(k)).join(', ')}`;

const legendB = document.getElementById('legendB') as HTMLElement;
legendB.innerHTML =
  '<b>B - BASE COMPLEX</b> (map-generator layout, team 0 olive-drab)<br />' +
  'garage - HQ - 23 wall segments - gate - 2 turret towers - watchtower - radar<br />' +
  'helipad + windsock - fuel depot (pumps, spill) - ammo tent (camo net) - tents';

const legendC = document.getElementById('legendC') as HTMLElement;
legendC.innerHTML =
  '<b>C - RUINED VARIANTS</b> - renderer swaps at hp 0: hide root, show ruined, copy matrix<br />' +
  'wall - bunker - building - turret tower - container - gate (14 kinds ship one)<br />' +
  'rubble, broken walls, twisted rebar, collapsed roofs, scorched concrete, thrown pod';

const trisEl = document.getElementById('tris') as HTMLElement;
const rows = table
  .map((t) => {
    const cls = t.tris > 4000 ? ' class="over"' : '';
    const r = t.ruined > 0 ? `/${t.ruined}r` : '';
    return `<div${cls}>${t.name.padEnd(13, ' ')}${String(t.tris).padStart(5)}${r}</div>`;
  })
  .join('');
const total = table.reduce((a, b) => a + b.tris, 0);
const max = table.reduce((a, b) => Math.max(a, b.tris), 0);
trisEl.innerHTML = `<b>triangles</b> (r = ruined variant)<br />${rows}<div>max ${max} / budget 4000 - sum ${total}</div>`;
window.__TRI_TABLE__ = table;

const pxm = splitX / areaA.coverW;
(document.getElementById('barSub') as HTMLElement).textContent =
  `procedural geometry only | metres | 25 kinds | max ${max} tri | A: ${fitDistance(areaA).toFixed(0)} m, ${pxm.toFixed(1)} px/m | 60 deg tilt | ACESFilmic | shadows + sky IBL`;

/* ---------------------------------------------------------------- render */

const t0 = performance.now();
poseAnimated(1.15);

function renderView(v: View): void {
  renderer.setViewport(v.x, v.y, v.w, v.h);
  renderer.setScissor(v.x, v.y, v.w, v.h);
  sun.position.copy(v.area.center).addScaledVector(SUN_DIR, 340);
  sun.target.position.copy(v.area.center);
  sun.target.updateMatrixWorld();
  const sc = sun.shadow.camera;
  sc.left = -v.area.radius;
  sc.right = v.area.radius;
  sc.top = v.area.radius;
  sc.bottom = -v.area.radius;
  sc.near = 1;
  sc.far = 1000;
  sc.updateProjectionMatrix();
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, v.cam);
}

function frame(): void {
  for (const v of views) renderView(v);
}

frame();

// Slow, serialised live loop so a human can watch the animated parts cycle.
function loop(): void {
  poseAnimated(1.15 + (performance.now() - t0) / 1000);
  frame();
  setTimeout(loop, 250);
}

// Only announce readiness once the browser has actually presented the first frame
// (two rAFs), so the screenshot harness never captures an empty canvas.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__READY__ = true;
    setTimeout(loop, 250);
  });
});
