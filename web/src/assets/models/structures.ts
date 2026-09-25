/**
 * structures.ts — procedural models for every static map structure.
 *
 * ── Contract ────────────────────────────────────────────────────────────────
 * `buildStructure(kind, lib, team, seed)` returns a `StructureModel` whose `root`
 * origin sits on the ground plane (y = 0) with no rotation; the map generator supplies
 * position + `yaw` about Y only.
 *
 * Authoring conventions
 *  - Most kinds are **unit sized**: the visible geometry is normalised into the 1x1x1 box
 *    (x/z ∈ [-0.5, 0.5], y ∈ [0, 1]) and the renderer scales it by `(w, h, d)` from the
 *    `Structure` record. Inside the builder the model is written in *metres* for its
 *    authored size (`STRUCTURE_SIZE`) and then wrapped in a group scaled by 1/size, which
 *    keeps the code readable and the geometry cache shared.
 *  - Kinds that must never stretch (flag pole, radar, turret tower, watchtower, antenna,
 *    lighthouse, palms, rocks) are authored at true metres and report
 *    `isUnitSized(kind) === false`; give them yaw + position only.
 *  - `animated` holds the moving parts with a `userData.rfAnim` hint describing what the
 *    renderer should do with them (axis, travel, speed).
 *  - `ruined` is a **sibling** node (not a child of `root`) built at the same origin: when
 *    hp hits 0, hide `root`, show `ruined` and copy root's matrix onto it (see
 *    `syncTransform` in kit.ts). `fortifyRuins` builds it lazily if you would rather not
 *    pay for it up front — it is a no-op once present.
 *  - Geometry + materials are cached module-wide (see kit.ts); nothing here mutates shared
 *    state, so instances are safe to build in the hundreds.
 */

import * as THREE from 'three';
import type { StructureModel, SurfaceLibrary, TeamId } from '../types';
import { Kit, bakeMetricUV, countTriangles, syncTransform, teamTint, type V3 } from './kit';
import { RUINED_KINDS, SKIND, STRUCTURE_SIZE, TRUE_SCALE_KINDS, isUnitSized, sizeOf, structureKindName } from './kinds';
import { buildProp, propBarrel, propContainer, propCrate, propSandbag, propWreck } from './props';
import { buildRuin } from './ruins';

export { RUINED_KINDS, SKIND, STRUCTURE_SIZE, TRUE_SCALE_KINDS, isUnitSized, structureKindName };

/**
 * Everything the renderer knows about a built structure.
 *
 * Keep this JSON-safe. `Object3D.copy()` — and so every `clone()` — round-trips `userData`
 * through `JSON.parse(JSON.stringify(...))`, which calls `toJSON()` on whatever is stored
 * here. A `SurfaceLibrary` in this object made each clone re-encode the library's textures
 * into PNG data URLs through `serializeImage()`: ~1.4 s per structure, doubled by the ruined
 * variant, which blocked the boot for minutes. The library is passed in explicitly instead.
 */
export interface StructureMeta {
  kind: number;
  team: TeamId;
  seed: number;
  unitSized: boolean;
}

/** Hint attached to `animated[i].userData.rfAnim` describing the expected motion. */
export interface AnimHint {
  part: string;
  /** Axis the renderer should drive. */
  axis: 'x' | 'y' | 'z';
  /** Total travel in *model space* (unit space for unit-sized kinds, metres otherwise). */
  travel?: number;
  /** Suggested angular speed, rad/s (spin/yaw animations). */
  speed?: number;
  /** Suggested period, seconds (wave/slide animations). */
  period?: number;
}

/* ------------------------------------------------------------- materials */

function mats(kit: Kit) {
  return {
    /** Structural concrete (team tinted). */
    concrete: kit.teamMat('concreteWorn'),
    /** Whitewashed render — the Mediterranean look, barely tinted. */
    wash: kit.mat('concrete', { color: teamTint(kit.team, 0.74) }),
    /** Painted steel, team coloured. */
    panel: kit.teamMat('metalPanel'),
    paint: kit.teamMat('metalPainted'),
    dark: kit.mat('metalDark'),
    rust: kit.mat('rust'),
    hazard: kit.mat('hazard', { rough: 0.72, metal: 0.05 }),
    glass: kit.mat('glass', { rough: 0.18, metal: 0.25 }),
    wood: kit.mat('wood'),
    /** Sandbags read darker than the sand so parapets keep their silhouette from the air. */
    bags: kit.mat('sandbag', { color: 0x776a4c }),
    sandbag: kit.mat('sandbag'),
    dirt: kit.mat('dirt'),
    rock: kit.mat('rock'),
    rubber: kit.mat('rubber'),
    steel: kit.mat('metalPanel', { color: 0xb6b9bd, metal: 0.55, rough: 0.42 }),
    white: kit.mat('metalPainted', { color: 0xf1efe4, rough: 0.6 }),
    red: kit.mat('metalPainted', { color: 0xa8382c, rough: 0.6 }),
    lamp: kit.mat('metalPainted', { color: 0xf6efd8, emissive: 0xffe6ad, emissiveIntensity: 1.2, rough: 0.35 }),
    beacon: kit.mat('metalPainted', { color: 0x8c2f24, emissive: 0xff2d10, emissiveIntensity: 1.5, rough: 0.35 }),
    /** Pad/marking paint (flat, double sided so thin discs read from above). */
    mark: kit.mat('metalPainted', { color: 0xe8e4d4, rough: 0.8, side: THREE.DoubleSide }),
    scorch: kit.mat('scorch', { rough: 1, metal: 0 }),
  };
}
type Mats = ReturnType<typeof mats>;

/* ------------------------------------------------------------------ ctx */

interface Ctx {
  kit: Kit;
  root: THREE.Group;
  /** Authoring space: metres (unit-sized models get normalised by this group's scale). */
  shell: THREE.Group;
  animated: THREE.Object3D[];
  w: number;
  h: number;
  d: number;
  unitSized: boolean;
  M: Mats;
}

/**
 * Animated sub-part. Authored in metres relative to `hinge`, but parented so that the
 * node the renderer drives moves in the model's own space (unit space for unit-sized
 * kinds, metres for true-scale kinds).
 */
function animPart(c: Ctx, hinge: V3, hint: AnimHint): THREE.Group {
  const outer = new THREE.Group();
  // The renderer looks animated parts up by `__anim<index>`; keep the semantic name in
  // `userData.rfAnim.part` (and mirror it in userData.rfName for debugging).
  outer.name = `__anim${c.animated.length}`;
  outer.userData.rfName = hint.part;
  const inner = new THREE.Group();
  if (c.unitSized) {
    outer.position.set(hinge[0] / c.w, hinge[1] / c.h, hinge[2] / c.d);
    inner.scale.set(1 / c.w, 1 / c.h, 1 / c.d);
  } else {
    outer.position.set(hinge[0], hinge[1], hinge[2]);
  }
  outer.add(inner);
  outer.userData.rfAnim = hint satisfies AnimHint;
  c.root.add(outer);
  c.animated.push(outer);
  return inner;
}

/* --------------------------------------------------------- sub-assemblies */

/** Window: frame + recessed glass + sill, on a wall facing +Z, rotated by `yaw`. */
function window4(kit: Kit, M: Mats, parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, yaw = 0, shutters = false): THREE.Group {
  const g = kit.group(parent, x, y, z);
  g.rotation.y = yaw;
  kit.rect(g, M.paint, w + 0.18, h + 0.18, 0.1, 0, 0, -0.04);
  kit.rect(g, M.glass, w, h, 0.08, 0, 0, 0.03);
  kit.rect(g, M.wash, w + 0.4, 0.12, 0.34, 0, -h / 2 - 0.12, 0.1);
  if (shutters) {
    for (const s of [-1, 1]) {
      kit.rect(g, M.wood, w * 0.46, h * 0.96, 0.06, (s * (w + w * 0.46)) / 2, 0, 0.14);
    }
  }
  return g;
}

/** Rooftop greeble cluster: AC units, vent, hatch, aerial. */
function roofKit(kit: Kit, M: Mats, parent: THREE.Object3D, w: number, d: number, y: number, height: number): void {
  const ac = (x: number, z: number, yaw: number): void => {
    kit.aircon(parent, M.steel, M.dark, 1.5, 0.85, 1.05, x, y + 0.42, z, yaw);
    kit.rectOn(parent, M.dark, 1.6, 0.12, 1.15, x, y, z, { rot: [0, yaw, 0] });
  };
  ac(-w * 0.28, -d * 0.22, 0.1);
  ac(-w * 0.28, d * 0.16, -0.1);
  if (w > 8) ac(w * 0.3, -d * 0.3, 1.5);
  kit.roofHatch(parent, M.steel, M.dark, 0.55, w * 0.2, y, d * 0.3);
  const ventY = y;
  for (let i = 0; i < 2; i++) {
    const vx = w * (0.05 + i * 0.14);
    kit.cyl(parent, M.dark, 0.34, 0.34, 0.5, vx, ventY, d * 0.02, 8);
    kit.cyl(parent, M.steel, 0.42, 0.38, 0.12, vx, ventY + 0.5, d * 0.02, 8);
  }
  // Cable conduit + aerial mast.
  kit.rectOn(parent, M.dark, w * 0.6, 0.14, 0.16, -w * 0.05, y, d * 0.42);
  kit.cyl(parent, M.steel, 0.05, 0.07, Math.max(1.4, height * 0.3), w * 0.38, y, -d * 0.34, 6);
  kit.cyl(parent, M.dark, 0.02, 0.03, Math.max(1.2, height * 0.22), w * 0.38, y + Math.max(1.4, height * 0.3), -d * 0.34, 5);
}

/** Sandbag emplacement: L-shaped sangar with a firing step. */
function sangar(kit: Kit, M: Mats, parent: THREE.Object3D, x: number, y: number, z: number, len: number, yaw: number, rows = 3): void {
  const g = kit.group(parent, x, y, z);
  g.rotation.y = yaw;
  kit.sandbagWall(g, M.sandbag, len, rows, 0, 0, 0);
  // Side wall: the trailing `0.4, Math.PI / 2` are bagD + yaw - without them the wall runs
  // the wrong way and its bags are 1.57 m deep, which pushes sangars out of their footprint.
  kit.sandbagWall(g, M.sandbag, len * 0.55, rows, -len * 0.3, 0, len * 0.3, 0.62, 0.28, 0.4, Math.PI / 2);
  kit.rectOn(g, M.dirt, len * 0.7, rows * 0.2, 0.5, 0, 0, -0.45);
}

/** Fuel/water tank lying on saddles, with manway, ladder and pipework. */
function horizontalTank(kit: Kit, M: Mats, parent: THREE.Object3D, r: number, len: number, x: number, y: number, z: number, yaw: number, colour: THREE.Material): void {
  const g = kit.group(parent, x, y, z);
  g.rotation.y = yaw;
  kit.cylC(g, colour, r, r, len, 0, r, 0, 12, { rot: [0, 0, Math.PI / 2] });
  for (const s of [-0.32, 0.32]) {
    kit.rectOn(g, M.concrete, r * 0.9, r * 0.9, r * 0.5, s * len, 0, 0);
  }
  // Manway + vents on top, ladder on the side.
  kit.cyl(g, M.steel, r * 0.26, r * 0.26, 0.18, len * 0.18, 2 * r, 0, 8);
  kit.cyl(g, M.dark, 0.09, 0.09, 0.5, -len * 0.2, 2 * r - 0.05, 0, 6);
  kit.ladder(g, M.steel, 2 * r, len * 0.4, 0, r * 0.98, 0.34, Math.PI);
  kit.rectOn(g, M.hazard, len * 0.9, 0.22, 0.05, 0, r * 0.55, r * 0.99);
}

/** Small fuel pump island: base, pump body, display, hose, nozzle. */
function fuelPump(kit: Kit, M: Mats, parent: THREE.Object3D, x: number, y: number, z: number, yaw: number): void {
  const g = kit.group(parent, x, y, z);
  g.rotation.y = yaw;
  kit.rectOn(g, M.concrete, 1.5, 0.22, 1.1, 0, 0, 0);
  kit.rectOn(g, M.paint, 0.62, 1.15, 0.44, 0, 0.22, 0);
  kit.rectOn(g, M.dark, 0.5, 0.3, 0.1, 0, 1.1, 0.24);
  kit.rect(g, M.hazard, 0.5, 0.1, 0.06, 0, 1.2, 0.28);
  kit.cyl(g, M.dark, 0.05, 0.05, 0.55, 0.42, 0.75, 0.1, 6);
  kit.strut(g, M.rubber, [0.44, 0.9, 0.1], [0.5, 1.05, 0.42], 0.05);
  kit.strut(g, M.rubber, [0.5, 1.05, 0.42], [0.42, 0.78, 0.5], 0.05);
  kit.rect(g, M.dark, 0.12, 0.3, 0.12, 0.42, 0.85, 0.5);
}

/** Windsock on a mast; total height `h`. */
function windsock(kit: Kit, M: Mats, parent: THREE.Object3D, x: number, y: number, z: number, h: number, yaw: number): void {
  const g = kit.group(parent, x, y, z);
  g.rotation.y = yaw;
  kit.cyl(g, M.concrete, 0.3, 0.36, 0.3, 0, 0, 0, 8);
  kit.cyl(g, M.steel, 0.07, 0.1, h, 0, 0.3, 0, 8);
  const top = h + 0.3;
  kit.cyl(g, M.steel, 0.09, 0.09, 0.12, 0, top, 0, 8);
  const sockLen = h * 0.28;
  const hazard = kit.mat('hazard', { rough: 0.85 });
  kit.cylC(g, hazard, 0.22, 0.3, sockLen * 0.5, sockLen * 0.25, top, 0, 8, { rot: [0, 0, -Math.PI / 2] });
  kit.cylC(g, M.white, 0.17, 0.22, sockLen * 0.5, sockLen * 0.75, top, 0, 8, { rot: [0, 0, -Math.PI / 2] });
  kit.cylC(g, hazard, 0.12, 0.17, sockLen * 0.4, sockLen * 1.2, top, 0, 8, { rot: [0, 0, -Math.PI / 2] });
}

/** Lattice dish on a yoke (radar / antenna). Returns the tilted dish group. */
function dishAssembly(kit: Kit, M: Mats, parent: THREE.Object3D, radius: number, depth: number, elevation: number): THREE.Group {
  const tilt = new THREE.Group();
  tilt.rotation.x = Math.PI / 2 - elevation;
  parent.add(tilt);
  const dishMat = kit.mat('metalPanel', { color: 0xc9ccc6, metal: 0.35, rough: 0.55, side: THREE.DoubleSide });
  const profile: [number, number][] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    profile.push([0.06 + radius * t, depth * t * t]);
  }
  kit.lathe(tilt, dishMat, profile, 16);
  kit.lathe(tilt, M.steel, [[radius * 0.97, depth * 0.94], [radius, depth]], 16);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    kit.strut(tilt, M.steel, [Math.cos(a) * radius * 0.85, depth * 0.75, Math.sin(a) * radius * 0.85], [0, depth + 0.45, 0], 0.045);
  }
  kit.cyl(tilt, M.dark, 0.07, 0.1, 0.45, 0, depth + 0.3, 0, 6);
  kit.ico(tilt, M.dark, 0.15, 0, 0, depth + 0.62, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.2;
    kit.strut(tilt, M.steel, [0, -0.04, 0], [Math.cos(a) * radius * 0.78, depth * 0.72, Math.sin(a) * radius * 0.78], 0.07);
  }
  return tilt;
}

/* --------------------------------------------------------------- builders */

function bGarage(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 16 x 10 x 5.2 m: two-bay motor pool with a sliding bay door on +Z. Refitted to the box
  // rf-core places (it was authored 16 x 13 x 6.5, so the plan squashed it and its roof
  // greebles stuck 4 m above the collision).
  kit.rectOn(s, M.concrete, 16.1, 0.28, 10.0, 0, 0, 0);
  kit.rectOn(s, M.dark, 14.4, 0.06, 9.2, 0, 0.28, 0, { noShadow: true });
  for (const sx of [-1, 1]) {
    kit.boxOn(s, M.concrete, 0.6, 4.0, 9.4, sx * 7.3, 0.28, 0);
    for (let i = 0; i < 4; i++) {
      kit.rect(s, M.concrete, 0.08, 3.4, 0.1, sx * 7.62, 2.2, -3.2 + i * 2.13);
    }
  }
  kit.boxOn(s, M.concrete, 15.6, 4.0, 0.6, 0, 0.28, -4.6);
  for (const sx of [-1, 1]) {
    kit.boxOn(s, M.concrete, 3.3, 4.0, 0.6, sx * 5.85, 0.28, 4.6);
  }
  kit.boxOn(s, M.concrete, 8.6, 1.0, 0.6, 0, 3.28, 4.6);
  kit.rect(s, M.hazard, 8.5, 0.28, 0.14, 0, 3.5, 4.92);
  // Pitched roof cap + ribs + parapet lip so the roof never reads as one flat plate.
  kit.taperOn(s, M.panel, 15.6, 0.5, 9.8, 0.9, 0.85, 0, 4.28, 0);
  for (const sx of [-1, 1]) kit.rectOn(s, M.dark, 0.3, 0.18, 9.8, sx * 7.9, 4.6, 0);
  for (const sz of [-1, 1]) kit.rectOn(s, M.dark, 16.2, 0.18, 0.3, 0, 4.6, sz * 4.85);
  for (let i = 0; i < 6; i++) kit.rectOn(s, M.dark, 16.2, 0.12, 0.22, 0, 4.78, -3.6 + i * 1.44);
  for (const sx of [-1, 1]) {
    kit.rectOn(s, M.dark, 0.2, 0.12, 9.4, sx * 4.2, 4.78, 0);
  }
  // Interior: floor markings, bench, cabinet, lamps.
  kit.groundArrow(s, M.hazard, 2.6, 0.5, 0, 0.33, 2.6, -Math.PI / 2);
  for (const sx of [-1, 1]) {
    kit.rect(s, M.hazard, 0.14, 0.02, 8.0, sx * 2.6, 0.33, 0, { noShadow: true });
  }
  kit.rectOn(s, M.wood, 3.4, 0.16, 0.8, -4.2, 0.95, -3.9);
  for (const sxx of [-1.5, 1.5]) kit.rectOn(s, M.dark, 0.14, 0.8, 0.7, -4.2 + sxx, 0.3, -3.9);
  kit.rectOn(s, M.paint, 1.0, 1.5, 0.7, 0.6, 0.3, -4.0);
  kit.cyl(s, M.dark, 0.1, 0.1, 0.5, -2.4, 0.3, -4.0, 8);
  for (const sx of [-1, 1]) {
    kit.rect(s, M.lamp, 2.4, 0.12, 0.5, sx * 3.2, 3.6, -0.6, { noShadow: true });
  }
  // Roof greebles, hand-placed to stay under the 5.2 m box.
  kit.cyl(s, M.dark, 0.4, 0.4, 0.42, 3.0, 4.78, -2.0, 8);
  kit.rectOn(s, M.steel, 1.2, 0.32, 1.0, -3.4, 4.78, 1.4);
  kit.rectOn(s, M.steel, 1.5, 0.38, 1.0, 5.0, 4.78, 2.6);
  kit.rectOn(s, M.rust, 1.8, 0.38, 0.5, 6.0, 4.78, -3.2);
  // Sliding bay door (animated: slides up into the shutter housing on the roof).
  const door = animPart(c, [0, 0.3, 4.62], { part: 'garageDoor', axis: 'y', travel: -2.9 / c.h, period: 4 });
  kit.rect(door, M.panel, 8.5, 2.9, 0.26, 0, 1.62, 0);
  for (let i = 0; i < 4; i++) {
    kit.rect(door, M.dark, 8.4, 0.09, 0.32, 0, 0.72 + i * 0.7, 0);
  }
  kit.rect(door, M.hazard, 8.5, 0.4, 0.3, 0, 0.42, 0);
  kit.rect(door, M.steel, 1.1, 0.1, 0.34, -2.4, 0.9, 0);
  for (const sx of [-1, 1]) kit.rect(door, M.dark, 0.22, 2.9, 0.3, sx * 4.15, 1.62, 0);
  // Shutter housing the raised door disappears into.
  kit.boxOn(s, M.panel, 9.4, 0.85, 1.2, 0, 4.28, 4.5);
  kit.rectOn(s, M.dark, 9.5, 0.07, 1.3, 0, 5.13, 4.5);
  kit.rect(s, M.hazard, 9.4, 0.2, 0.1, 0, 4.4, 5.05);
  for (const sx of [-1, 1]) {
    kit.rectOn(s, M.dark, 0.24, 4.0, 0.18, sx * 4.4, 0.28, 4.62);
  }
  // Interior dressing: bay markings, spill, drums, crates, stores, lamps, gate posts.
  for (const sx of [-1, 1]) {
    kit.rect(s, M.rubber, 0.42, 0.02, 3.4, sx * 2.5, 0.3, 2.4, { noShadow: true });
  }
  kit.oilStain(s, 0, 1.6, 1.4, 0.32);
  kit.oilStain(s, -4.2, 3.0, 0.8, 0.32);
  kit.cableDrum(s, M.wood, 0.62, -6.4, 0.28, 3.6, 0.4);
  kit.crate(s, M.wood, M.dark, 1.3, 5.4, 0.28, 3.4, -0.35);
  kit.crate(s, M.wood, M.dark, 1.1, 5.4, 1.45, 2.0, 0.2);
  for (let i = 0; i < 3; i++) {
    kit.cyl(s, i === 1 ? M.rust : M.paint, 0.31, 0.31, 0.92, 3.6 + i * 0.72, 0.28, 4.2, 10);
  }
  for (const sx of [-1, 1]) {
    kit.sandbagWall(s, M.bags, 2.4, 4, sx * 5.6, 0.28, -3.4, 0.62, 0.26, 0);
  }
  kit.rect(s, kit.teamMat('metalPainted', { color: teamTint(kit.team, 0.35) }), 2.6, 1.0, 0.08, 0, 3.4, 4.92);
  kit.rect(s, M.white, 2.0, 0.22, 0.06, 0, 3.4, 4.97);
  for (const sx of [-1, 1]) kit.cyl(s, M.dark, 0.09, 0.09, 2.6, sx * 7.7, 0.3, 4.0, 6);
}

function bFlagPole(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // True scale: 9.4 m pole on a plinth.
  kit.boxOn(s, M.concrete, 1.6, 0.4, 1.6, 0, 0, 0);
  kit.rectOn(s, M.hazard, 1.7, 0.16, 0.2, 0, 0.4, 0.7);
  kit.sandbagWall(s, M.bags, 1.9, 2, 0, 0.4, 0.5, 0.6, 0.24, 0);
  kit.cyl(s, M.steel, 0.05, 0.08, 8.6, 0, 0.4, 0, 10);
  kit.cyl(s, M.dark, 0.16, 0.22, 0.3, 0, 0.4, 0, 10);
  kit.ico(s, M.steel, 0.09, 0, 0, 9.05, 0);
  kit.rectOn(s, M.dark, 0.1, 0.3, 0.1, 0.1, 1.2, 0);
  // Halyard + cleat.
  kit.strut(s, M.rubber, [0.08, 8.9, 0], [0.3, 1.3, 0], 0.02);
  const cloth = animPart(c, [0.08, 8.6, 0], { part: 'flagCloth', axis: 'y', speed: 1.1, period: 3 });
  const flagGeo = bakeMetricUV(new THREE.PlaneGeometry(2.6, 1.45, 8, 3), [1, 1, 1]);
  const pos = flagGeo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / 2.6 + 0.5;
    const v = pos.getY(i) / 1.45 + 0.5;
    pos.setZ(i, Math.sin(u * 5.5) * 0.1 * u + Math.sin(v * 3 + u * 2) * 0.03);
  }
  pos.needsUpdate = true;
  flagGeo.computeVertexNormals();
  const clothMat = kit.mat('canvasTent', { color: teamTint(kit.team, 0.55), side: THREE.DoubleSide });
  const flag = kit.mesh(cloth, flagGeo, clothMat, 1.35, -0.78, 0);
  flag.castShadow = true;
  kit.rect(cloth, clothMat, 2.6, 0.08, 0.04, 1.35, -0.06, 0);
  kit.rect(cloth, clothMat, 2.6, 0.08, 0.04, 1.35, -1.52, 0);
}

function bFuelDepot(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 8.5 x 6.5 x 3.4 m: bunded pad, two tanks, two pumps - the box the base plan places.
  kit.rectOn(s, M.concrete, 8.5, 0.3, 6.5, 0, 0, 0);
  // Bund wall ring: two long sides on z, two ends on x. (The old specs had these striding
  // 10 m *across* the pad, which is what threw the depot 18 m deep.)
  for (const sz of [-3.0, 3.0]) {
    kit.boxOn(s, M.concrete, 8.4, 1.0, 0.35, 0, 0.3, sz);
    kit.rectOn(s, M.hazard, 8.3, 0.18, 0.37, 0, 1.16, sz);
  }
  for (const sx of [-1, 1]) {
    kit.boxOn(s, M.concrete, 0.35, 1.0, 5.8, sx * 3.95, 0.3, 0);
    kit.rectOn(s, M.hazard, 0.37, 0.18, 5.7, sx * 3.95, 1.16, 0);
  }
  kit.rectOn(s, M.dirt, 7.6, 0.16, 5.6, 0, 0.3, 0);
  horizontalTank(kit, M, s, 1.0, 3.8, -2.1, 0.45, -1.5, 0, M.paint);
  horizontalTank(kit, M, s, 1.0, 3.8, -2.1, 0.45, 1.5, 0, M.rust);
  // Pipework to the pump islands.
  kit.cylC(s, M.steel, 0.11, 0.11, 3.2, -0.3, 0.9, 0, 8, { rot: [0, 0, Math.PI / 2] });
  kit.cylC(s, M.steel, 0.11, 0.11, 1.8, 1.4, 0.9, 0, 8, { rot: [Math.PI / 2, 0, 0] });
  for (const sz of [-1, 1]) kit.cyl(s, M.steel, 0.09, 0.09, 0.8, 1.4, 0.3, sz * 0.8, 8);
  kit.cylC(s, M.dark, 0.22, 0.22, 0.2, 0, 0.9, 0.0, 8, { rot: [Math.PI / 2, 0, 0] });
  fuelPump(kit, M, s, 2.2, 0.46, -1.5, -Math.PI / 2);
  fuelPump(kit, M, s, 2.2, 0.46, 1.5, -Math.PI / 2);
  // Spills, drip trays, extinguisher, barrels.
  kit.oilStain(s, 2.9, -0.8, 1.2, 0.36);
  kit.oilStain(s, 3.0, 2.0, 0.85, 0.34);
  kit.rectOn(s, M.dark, 1.4, 0.12, 0.9, 2.8, 0.36, 0.5);
  kit.cyl(s, M.red, 0.16, 0.16, 0.6, 3.5, 0.4, -2.6, 8);
  for (let i = 0; i < 2; i++) kit.cyl(s, M.rust, 0.3, 0.3, 0.9, 3.4 - i * 0.7, 0.4, 2.6, 10);
  kit.floodlight(s, M.steel, M.dark, -3.7, 0.4, 2.6, 2.4, 0.6);
  kit.sign(s, M.white, M.steel, M.hazard, -3.6, 0.4, -2.5, 0.75, 0.55, 0.5);
  kit.sandbagWall(s, M.bags, 3.6, 3, 0.6, 0.4, -2.7, 0.62, 0.24, 0);
  for (const sx of [-1, 1]) kit.rect(s, M.rubber, 0.4, 0.02, 2.2, 2.6 + sx * 1.3, 0.42, 2.0, { noShadow: true });
}

function bAmmoTent(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 8 x 5.5 x 3.2 m box: canvas ammunition store under camo netting with a sandbag blast
  // wall on the back edge. `tentBody` puts its guy pegs at 0.72 * w/d, so 5.8 x 4.0 is the
  // largest body (pegs at 4.18 / 2.88 m) that stays inside the footprint.
  kit.rectOn(s, M.concrete, 8, 0.18, 5.5, 0, 0, 0); // apron, fills the footprint
  kit.tentBody(s, kit.teamMat('canvasTent', { side: THREE.DoubleSide }), M.steel, 5.8, 2.6, 4.0, 0.26);
  kit.net(s, kit.teamMat('canvasTent', { side: THREE.DoubleSide, color: teamTint(kit.team, 0.2) }), 7.0, 4.4, 0, 2.75, 0, 0.3);
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      kit.cyl(s, M.steel, 0.06, 0.08, 2.6, sx * 3.4, 0.18, sz * 2.1, 6);
    }
  }
  // Ammunition crates, pallets, loose rounds.
  const cratePos: [number, number, number, number][] = [
    [-3.0, 0.18, 1.8, 0.12],
    [-1.7, 0.18, 2.0, -0.2],
    [-3.0, 1.35, 1.8, 0.05],
    [3.0, 0.18, 1.8, 0.4],
    [3.0, 0.18, 0.4, 0.1],
    [3.2, 0.18, -1.4, -0.3],
  ];
  for (const [x, y, z, yaw] of cratePos) kit.crate(s, M.wood, M.dark, 1.25, x, y, z, yaw);
  kit.rectOn(s, M.wood, 2.6, 0.14, 1.6, 1.2, 0.18, 1.5, { rot: [0, 0.2, 0] });
  kit.rectOn(s, M.wood, 2.6, 0.14, 1.6, 1.4, 0.32, 1.5, { rot: [0, 0.2, 0] });
  for (let i = 0; i < 4; i++) {
    kit.rectOn(s, M.dark, 0.42, 0.22, 0.28, 0.4 + i * 0.5, 0.46, 1.3, { rot: [0, 0.2 + i * 0.05, 0] });
  }
  kit.sandbagWall(s, M.bags, 6.0, 4, 0, 0.18, -2.45, 0.62, 0.26, 0.4, 0); // blast wall on -z
  kit.sandbagWall(s, M.bags, 2.4, 2, -3.5, 0.18, -1.4, 0.62, 0.26, 0.4, Math.PI / 2);
  kit.floodlight(s, M.steel, M.dark, 3.6, 0.18, 2.2, 2.8, 0.9); // mast, stands above the box
  kit.sign(s, M.white, M.steel, M.hazard, -3.6, 0.18, 1.9, 0.8, 0.6, 0.35);
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, -3.5, 0.18, -0.2, 10);
  kit.oilStain(s, 2.2, -1.6, 1.0, 0.2);
}

function bHelipad(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 11 x 11 x 0.4 m box: the drivable deck is 11 m across and 0.3 m thick. The windsock mast,
  // the lamps and the sandbag/barrel dressing stand above 0.4 m on purpose (that is the one
  // allowance for this kind) but stay inside the 11 x 11 plan.
  kit.cyl(s, M.concrete, 5.45, 5.5, 0.3, 0, 0, 0, 8); // pad, 11 m across the corners
  kit.cyl(s, kit.mat('helipad', { color: 0x6a6c68 }), 5.1, 5.2, 0.08, 0, 0.3, 0, 8);
  kit.lathe(s, M.hazard, [[4.6, 0.38], [5.05, 0.38]], 24);
  kit.lathe(s, M.mark, [[2.9, 0.39], [3.1, 0.39]], 24);
  // Big painted H.
  kit.rect(s, M.mark, 0.55, 0.02, 3.2, -0.95, 0.4, 0, { noShadow: true });
  kit.rect(s, M.mark, 0.55, 0.02, 3.2, 0.95, 0.4, 0, { noShadow: true });
  kit.rect(s, M.mark, 1.35, 0.02, 0.55, 0, 0.4, 0, { noShadow: true });
  kit.groundArrow(s, M.mark, 2.6, 0.5, 0, 0.4, 4.2, -Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
    const x = Math.cos(a) * 4.75;
    const z = Math.sin(a) * 4.75;
    kit.cyl(s, M.dark, 0.16, 0.2, 0.3, x, 0.3, z, 8);
    kit.cyl(s, M.lamp, 0.14, 0.14, 0.14, x, 0.6, z, 8);
  }
  for (const sx of [-1, 1]) {
    kit.rectOn(s, M.dark, 0.4, 0.34, 0.4, sx * 5.1, 0.3, -5.1);
    kit.rectOn(s, M.dark, 0.4, 0.34, 0.4, sx * 5.1, 0.3, 5.1);
  }
  windsock(kit, M, s, 4.3, 0.3, -3.2, 4.6, -1.2); // mast, above the deck
  kit.sandbagWall(s, M.bags, 2.4, 2, -4.6, 0.3, 1.6, 0.6, 0.24, 0.4, Math.PI / 2);
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, -4.7, 0.3, -1.6, 10);
  kit.rectOn(s, M.paint, 1.2, 0.7, 0.8, 3.4, 0.3, -3.8);
  kit.oilStain(s, 0.4, -2.2, 1.2, 0.42);
}

function bRadar(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // True scale: 6.5 x 6.5 x 10.6 m lattice mast with a big spinning dish.
  kit.cyl(s, M.concrete, 3.2, 3.3, 0.35, 0, 0, 0, 8);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    kit.rectOn(s, M.steel, 0.55, 0.3, 0.55, Math.cos(a) * 2.5, 0.35, Math.sin(a) * 2.5);
  }
  // Equipment shelter with door, vents, cable run and a small fixed dish.
  kit.rectOn(s, M.panel, 2.4, 1.9, 1.8, 2.0, 0.35, -1.9);
  kit.rect(s, M.dark, 0.9, 1.5, 0.12, 2.0, 1.2, -0.98, { noShadow: true });
  kit.rect(s, M.hazard, 2.5, 0.2, 1.9, 2.0, 0.5, -1.9);
  kit.rect(s, M.dark, 1.4, 0.7, 0.1, 2.0, 1.9, -2.8, { noShadow: true });
  kit.cyl(s, M.dark, 0.07, 0.07, 0.9, 2.5, 2.25, -2.2, 6);
  kit.ico(s, M.steel, 0.35, 1, 2.5, 3.1, -2.2);
  kit.strut(s, M.rubber, [2.0, 0.4, -2.7], [0.4, 0.45, -1.0], 0.06);
  kit.cableDrum(s, M.wood, 0.6, -2.2, 0.35, 1.9, 0.7);
  kit.sandbagWall(s, M.bags, 2.6, 2, -2.6, 0.35, -1.6, 0.62, 0.26, 0.4, Math.PI / 2);
  // Lattice mast + equipment platform.
  kit.latticeMast(s, M.steel, 5.4, 1.7, 0, 0.35, 0, 5, 0.11);
  kit.rectOn(s, M.panel, 2.8, 0.25, 2.8, 0, 5.75, 0);
  kit.rail(s, M.steel, 2.8, 0, 6.0, 1.4, 0.9, 0, 4);
  kit.rail(s, M.steel, 2.8, 0, 6.0, -1.4, 0.9, 0, 4);
  kit.rail(s, M.steel, 2.8, -1.4, 6.0, 0, 0.9, Math.PI / 2, 4);
  kit.rail(s, M.steel, 2.8, 1.4, 6.0, 0, 0.9, Math.PI / 2, 4);
  kit.ladder(s, M.steel, 5.5, 1.05, 0.35, -1.15, 0.44, 0);
  kit.ladderCage(s, M.steel, 4.6, 1.05, 1.1, -1.15, 0.36, 0);
  kit.rectOn(s, M.dark, 0.7, 0.7, 0.7, 0.9, 6.0, 0.9);
  kit.floodlight(s, M.steel, M.dark, -1.2, 6.0, -1.2, 1.5, -0.8);
  kit.beacon(s, M.beacon, 1.2, 6.0, -1.2);
  // Spinning dish on a yoke: clearly concave from the game camera.
  const spin = animPart(c, [0, 6.0, 0], { part: 'radarDish', axis: 'y', speed: 0.5 });
  for (const sx of [-1, 1]) kit.rectOn(spin, M.steel, 0.32, 1.9, 0.32, sx * 1.15, 0, 0);
  kit.rect(spin, M.steel, 2.6, 0.35, 0.45, 0, 1.9, 0);
  kit.rect(spin, M.dark, 1.4, 0.9, 0.6, 0, 1.2, -0.5);
  const dishGroup = dishAssembly(kit, M, spin, 3.0, 1.15, 0.55);
  dishGroup.position.set(0, 2.0, 0);
  return;
}

function bWall(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 7.1 x 0.9 x 2.6 m box: a concrete panel whose end posts reach exactly |x| = 3.55, so
  // segments placed end to end (and the 0.9 x 0.9 corner-post squash) leave no gap. The
  // sandbag row leans on the front face inside the 0.9 m depth.
  kit.rectOn(s, M.concrete, 7.1, 0.4, 0.9, 0, 0, 0); // plinth, fills the footprint
  kit.boxOn(s, M.concrete, 6.6, 1.9, 0.62, 0, 0.4, 0); // panel between the posts
  for (const sx of [-1, 1]) {
    kit.boxOn(s, M.concrete, 0.5, 2.2, 0.86, sx * 3.3, 0.4, 0); // post: outer face at x 3.55
    kit.rectOn(s, M.dark, 0.56, 0.16, 0.9, sx * 3.3, 2.44, 0); // post cap band, top 2.6
    kit.rectOn(s, M.hazard, 0.52, 0.3, 0.88, sx * 3.3, 0.4, 0);
  }
  kit.rectOn(s, M.concrete, 6.6, 0.2, 0.88, 0, 2.3, 0); // panel cap, top 2.5
  kit.rect(s, M.dark, 0.08, 1.9, 0.66, -0.6, 1.35, 0, { noShadow: true });
  kit.rect(s, M.dark, 0.08, 1.9, 0.66, 1.4, 1.35, 0, { noShadow: true });
  kit.rect(s, M.dark, 5.4, 0.08, 0.66, 0.4, 2.2, 0, { noShadow: true });
  // Firing slit + weathering.
  kit.rect(s, M.dark, 1.3, 0.34, 0.66, 0.2, 1.55, 0, { noShadow: true });
  kit.rectOn(s, M.steel, 1.5, 0.1, 0.66, 0.2, 1.36, 0.02);
  kit.sandbagWall(s, M.bags, 3.4, 2, -1.2, 0.4, 0.24, 0.6, 0.24, 0.4, 0);
  kit.oilStain(s, 1.8, 0.05, 0.4, 0.44);
  kit.rect(s, M.scorch, 0.8, 0.02, 0.5, -2.0, 0.44, 0.05, { noShadow: true });
}

function bBunker(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 6.5 x 5.5 x 2.4 m box: a squat casemate - earth bank, embrasure, entrance and roof
  // sandbags all inside 2.4 m. The old 2.6 m aerial is cut to a 0.55 m whip, the only part
  // left standing above the collision box.
  const ROOF = 1.9; // roof slab top: 2 sandbag rows take it to 2.37 m
  kit.taperOn(s, M.dirt, 6.5, 1.1, 5.5, 0.78, 0.78, 0, 0, 0); // earth bank, fills the footprint
  kit.rectOn(s, M.rock, 5.4, 0.18, 4.4, 0, 1.0, 0); // rock course on the bank
  kit.boxOn(s, M.concrete, 5.2, 1.25, 4.2, 0, 0.35, 0); // casemate, 0.35 .. 1.6
  kit.taperOn(s, M.concrete, 5.0, 0.3, 4.0, 0.94, 0.9, 0, 1.6, 0); // sloped cap, 1.6 .. 1.9
  kit.rectOn(s, M.concrete, 5.5, 0.22, 4.5, 0, 1.7, 0); // roof slab, 1.7 .. 1.92
  // Embrasure: wide dark slit, steel lintels and a concrete hood.
  kit.rect(s, M.dark, 3.2, 0.4, 0.6, 0, 1.15, 2.05, { noShadow: true });
  kit.rect(s, M.steel, 3.5, 0.18, 0.5, 0, 0.9, 2.15);
  kit.rect(s, M.steel, 3.5, 0.18, 0.5, 0, 1.4, 2.15);
  kit.rect(s, M.concrete, 3.8, 0.4, 0.45, 0, 1.58, 2.1);
  for (const sx of [-1, 1]) kit.rect(s, M.concrete, 0.6, 1.1, 0.45, sx * 1.9, 1.15, 2.1);
  // Side firing slit.
  kit.rect(s, M.dark, 0.45, 0.35, 1.8, -2.6, 1.1, -0.4, { noShadow: true });
  kit.rect(s, M.steel, 0.3, 0.14, 2.0, -2.7, 0.92, -0.4);
  // Entrance at the back: tunnel mouth, blast door, lamp, apron.
  kit.rect(s, M.dark, 1.7, 1.3, 0.9, 0.3, 0.5, -2.3, { noShadow: true });
  kit.rect(s, M.steel, 1.2, 1.3, 0.16, 0.3, 0.5, -2.7);
  kit.rect(s, M.hazard, 1.4, 0.2, 0.22, 0.3, 1.3, -2.72);
  kit.rect(s, M.rust, 0.18, 1.4, 0.18, -0.5, 0.5, -2.74);
  kit.boxOn(s, M.concrete, 2.0, 0.3, 1.0, 0.3, 0, -2.5);
  kit.floodlight(s, M.steel, M.dark, 2.2, 0.3, -2.4, 1.8, Math.PI);
  // Roof: sandbag parapets, hatch, periscope, vents and the cut-down whip.
  kit.sandbagWall(s, M.bags, 3.4, 2, -1.0, ROOF, 1.4, 0.56, 0.24, 0.4, 0); // top 2.37
  kit.sandbagWall(s, M.bags, 3.0, 2, 1.4, ROOF, -1.4, 0.56, 0.24, 0.4, 0);
  kit.roofHatch(s, M.steel, M.dark, 0.38, -2.2, ROOF, -1.4);
  kit.rectOn(s, M.dark, 0.45, 0.3, 0.45, 2.1, ROOF, -1.5);
  kit.cyl(s, M.steel, 0.08, 0.08, 0.18, 2.1, ROOF + 0.3, -1.5, 6); // periscope, top 2.4
  kit.cyl(s, M.steel, 0.02, 0.03, 0.36, 2.1, ROOF + 0.48, -1.5, 5); // stub whip, top 2.74
  for (const sx of [-1, 1]) kit.cyl(s, M.dark, 0.15, 0.15, 0.42, sx * 2.2, ROOF, -2.0, 8);
  kit.aircon(s, M.steel, M.dark, 0.9, 0.44, 0.7, 2.2, ROOF + 0.22, 1.4, -Math.PI / 2);
  // Ground dressing at the foot of the bank.
  kit.cableDrum(s, M.wood, 0.5, 2.9, 0.15, 2.2, 0.2);
  kit.crate(s, M.wood, M.dark, 1.0, 2.9, 0.15, -1.9, 0.3);
  kit.oilStain(s, 2.4, 2.4, 0.55, 0.12);
  kit.sandbagWall(s, M.bags, 2.4, 2, -2.0, 0.2, 2.2, 0.56, 0.24, 0.4, 0);
  kit.rect(s, M.hazard, 1.8, 0.22, 0.06, 0.3, 1.25, -2.82);
}

/**
 * Timber plank bridge: a run of transverse planks between two joint boards, on a low kerb
 * each side, carried by pile bents standing in the water.
 *
 * Authored in the 18 x 3.6 x 8 m unit box (`STRUCTURE_SIZE[SKIND.BRIDGE]`), which the
 * renderer stretches to the map's deck piece (w x 0.9 x 7 m). Authored `y = 3.6` is the top
 * of the box, i.e. `Structure.y + h` — the drivable surface `World::bridge_deck` raises the
 * ground to — so every plank top sits exactly on the surface a vehicle drives on.
 *
 * Seams. A map bridge is a run of these pieces: each piece is `pitch + 0.4` long on a
 * `pitch` spacing (13.9 ... 20.4 m in the shipped maps), so neighbouring pieces overlap by
 * 0.4 m and the pitch is not knowable from inside a model. The plank field therefore stops
 * `BAND` short of both ends of the footprint and each end carries a full-width, near-flush
 * *joint board* in that band. At a seam the two joint boards overlap along the run at
 * slightly different heights (the -x board of the upper piece is the higher one), so no two
 * surfaces are ever coplanar; the seam reads as one dark joint board and, at any pitch, no
 * plank can double up or leave a hole. The kerbs run the full footprint, each tilted a hair
 * so two abutting kerbs are never coplanar either.
 */
function bBridge(c: Ctx): void {
  const { kit, shell: s } = c;
  const DECK_TOP = 3.6; // = Structure.y + h: the drivable surface
  const DECK_TH = 0.8; // 0.20 m of plank
  const FLOOR = DECK_TOP - DECK_TH; // underside of the deck (0.5 m above sea level)
  const HALF_Z = 4.0; // the full 7 m deck width
  const STRIP_Z = 3.9; // gap strips sit just inside the plank edge: never coplanar sides
  const JOINT_Z = 3.97; // joint boards stop a hair inside the kerb face (no shared plane)
  const BAND = 0.5; // joint board = the piece overlap (0.4 m) plus a margin
  const PLANKS = 23;
  const GAP_F = 0.2; // share of the pitch taken by the dark gap
  const DROP = 0.36; // 0.09 m: how far the gap strip sits below the plank tops
  const KERB_H = 0.96; // 0.24 m kerb (no railings, no trusses)
  const KERB_W = 0.28;
  const KERB_SINK = 0.14; // buried in the deck so the tilt can never lift it off
  const KERB_TILT = 0.012; // rad: ~5 cm between abutting kerbs, so they never z-fight
  const PILE_TOP = 2.4; // piles run from here down to 0.9 m below sea level
  const PILE_BOT = -5.6;

  // Warm brown deck wood, three tones so the planks read as individual boards.
  const wood = [
    kit.mat('wood'),
    kit.mat('wood', { color: 0x9a7448, rough: 0.8 }),
    kit.mat('wood', { color: 0x7c5c3a, rough: 0.8 }),
  ];
  const kerb = kit.mat('wood', { color: 0x74593a, rough: 0.85 });
  const joint = kit.mat('wood', { color: 0x533d26, rough: 0.88 });
  const gapWood = kit.mat('wood', { color: 0x241a10, rough: 0.92 });
  const pile = kit.mat('wood', { color: 0x59462e, rough: 0.88 });

  const fieldA = -9 + BAND;
  const fieldB = 9 - BAND;
  const pitch = (fieldB - fieldA) / PLANKS;
  const plankW = pitch * (1 - GAP_F);
  const gapW = pitch * GAP_F;

  for (let i = 0; i < PLANKS; i++) {
    const x0 = fieldA + i * pitch;
    // Plank: spans the deck width, so the UV bake is rotated a quarter turn to lay the
    // grain along the plank instead of across it.
    kit.rect(s, wood[((i * 2654435761) >>> 26) % 3], HALF_Z * 2, DECK_TH, plankW, x0 + plankW / 2, FLOOR + DECK_TH / 2, 0, {
      rot: [0, Math.PI / 2, 0],
    });
    // Dark, recessed strip in the gap: the shadow line between two planks, and the reason
    // you can never see the water through the deck.
    kit.rect(s, gapWood, gapW, DECK_TH - DROP, STRIP_Z * 2, x0 + plankW + gapW / 2, FLOOR + (DECK_TH - DROP) / 2, 0);
  }

  // Joint boards: full width and almost flush, in the band each piece leaves free at both
  // ends. The -x board is the higher one, so where two pieces overlap the upper board wins
  // and the lower one is hidden underneath it.
  kit.rect(s, joint, BAND, DECK_TH - 0.22, JOINT_Z * 2, -9 + BAND / 2, FLOOR + (DECK_TH - 0.22) / 2, 0);
  kit.rect(s, joint, BAND, DECK_TH - 0.1, JOINT_Z * 2, 9 - BAND / 2, FLOOR + (DECK_TH - 0.1) / 2, 0);

  // Low kerb board along each deck edge, full footprint so it always bridges a seam.
  for (const sz of [-1, 1]) {
    kit.rect(s, kerb, 18, KERB_H + KERB_SINK, KERB_W, 0, DECK_TOP - KERB_SINK + (KERB_H + KERB_SINK) / 2, sz * (HALF_Z - KERB_W / 2), {
      rot: [0, 0, KERB_TILT],
    });
  }

  // Two stringers under the planks, ending with the plank field.
  for (const sz of [-1, 1]) {
    kit.rect(s, pile, fieldB - fieldA, 0.5, 0.22, 0, FLOOR - 0.25, sz * 2.2);
  }

  // Pile bents: two piles, a cross head and two braces, at four points along the run.
  for (const i of [2, 8, 14, 20]) {
    const bx = fieldA + i * pitch + plankW / 2;
    kit.rect(s, pile, 0.5, 0.6, HALF_Z * 2 - 0.3, bx, FLOOR - 0.3, 0);
    for (const sz of [-1, 1]) {
      kit.cyl(s, pile, 0.13, 0.16, PILE_TOP - PILE_BOT, bx, PILE_BOT, sz * 2.2, 8);
      kit.strut(s, pile, [bx, PILE_TOP - 0.2, sz * 2.2], [bx, PILE_BOT + 5.0, -sz * 2.2], 0.16);
    }
  }
}

function bTent(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 6 x 5 x 2.6 m box: canvas tent. `tentBody` puts its guy pegs at 0.72 * w/d, so 4.6 x 3.8 is
  // the largest body whose pegs (3.31 / 2.74 m) stay inside the 6 x 5 footprint.
  kit.rectOn(s, M.wood, 6, 0.14, 5, 0, 0, 0); // groundsheet, fills the box
  kit.tentBody(s, kit.teamMat('canvasTent', { side: THREE.DoubleSide }), M.steel, 4.6, 2.3, 3.8, 0.24);
  for (const sz of [-1, 1]) {
    kit.strut(s, M.rubber, [-2.3, 2.0, sz * 1.2], [-3.1, 0.02, sz * 2.5], 0.025);
    kit.strut(s, M.rubber, [2.3, 2.0, sz * 1.2], [3.1, 0.02, sz * 2.5], 0.025);
  }
  kit.sandbagWall(s, M.bags, 2.2, 2, -0.2, 0.14, 2.25, 0.6, 0.24, 0.4, 0);
  kit.sandbagWall(s, M.bags, 1.6, 2, -2.6, 0.14, 1.4, 0.6, 0.24, 0.4, Math.PI / 2);
  kit.sandbagWall(s, M.bags, 1.6, 2, 2.6, 0.14, -1.4, 0.6, 0.24, 0.4, Math.PI / 2);
  kit.crate(s, M.wood, M.dark, 1.1, 2.4, 0.14, 1.9, 0.4);
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, 2.3, 0.14, -1.6, 10);
  kit.rectOn(s, M.dark, 0.4, 0.34, 0.3, -2.4, 0.14, -1.7);
  kit.cyl(s, M.dark, 0.18, 0.22, 0.3, -2.0, 0.14, -1.9, 8);
  kit.rect(s, M.lamp, 0.24, 0.2, 0.2, -2.0, 0.6, -1.9, { noShadow: true });
  kit.oilStain(s, 1.4, -1.4, 0.6, 0.2);
}

function bTurretTower(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // True scale: 5 x 5 m, 8.6 m tower with a SAM pod on the roof.
  kit.cyl(s, M.concrete, 2.7, 2.8, 0.35, 0, 0, 0, 8);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.rectOn(s, M.steel, 0.5, 0.3, 0.5, sx * 1.8, 0.35, sz * 1.8);
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.boxOn(s, M.panel, 0.5, 5.3, 0.5, sx * 1.75, 0.6, sz * 1.75);
    }
  }
  // Infill walls: three sides closed, one open with a door.
  for (const sz of [-1, 1]) {
    kit.boxOn(s, M.panel, 3.1, 4.6, 0.24, 0, 0.85, sz * 1.62);
    kit.rect(s, M.dark, 0.7, 1.1, 0.3, 0, 3.4, sz * 1.75, { noShadow: true });
  }
  kit.boxOn(s, M.panel, 0.24, 4.6, 3.1, -1.62, 0.85, 0);
  kit.rect(s, M.dark, 0.3, 2.1, 1.3, -1.75, 2.0, 0, { noShadow: true });
  kit.rectOn(s, M.steel, 0.16, 2.2, 1.4, -1.86, 0.9, 0.6);
  kit.rectOn(s, M.hazard, 0.3, 2.5, 0.4, -1.72, 0.85, -1.5);
  kit.rectOn(s, M.steel, 3.4, 0.25, 3.4, 0, 5.9, 0);
  kit.rectOn(s, M.steel, 3.4, 0.25, 3.4, 0, 3.4, 0);
  // Roof deck, sangar, searchlight, beacon.
  kit.rectOn(s, M.steel, 4.4, 0.35, 4.4, 0, 6.15, 0);
  kit.sandbagRing(s, M.bags, 1.85, 3, 0, 6.5, 0, 0.66, 0.25);
  kit.rail(s, M.steel, 4.2, 0, 6.5, 2.1, 0.9, 0, 4);
  kit.floodlight(s, M.steel, M.dark, -1.6, 6.5, -1.6, 1.5, 2.4);
  kit.ladder(s, M.steel, 5.6, 0, 0.35, 2.15, 0.42, 0);
  kit.ladderCage(s, M.steel, 4.6, 0, 1.2, 2.15, 0.36, 0);
  kit.rectOn(s, M.dark, 0.6, 0.6, 0.6, 1.7, 6.5, 1.7);
  // Spinning SAM pod.
  const pod = animPart(c, [0, 6.5, 0], { part: 'turretPod', axis: 'y', speed: 1.35 });
  kit.rect(pod, M.dark, 1.5, 0.3, 1.5, 0, 0.15, 0);
  kit.rect(pod, M.paint, 1.5, 1.35, 2.3, 0, 0.95, 0);
  kit.rect(pod, M.panel, 1.6, 0.55, 2.4, 0, 1.75, 0);
  for (let i = 0; i < 4; i++) {
    const x = i % 2 === 0 ? -0.4 : 0.4;
    const y = i < 2 ? 1.35 : 2.05;
    kit.cylC(pod, M.dark, 0.19, 0.19, 1.1, x, y, 0.55, 8, { rot: [Math.PI / 2, 0, 0] });
    kit.cylC(pod, M.red, 0.2, 0.2, 0.16, x, y, 1.16, 8, { rot: [Math.PI / 2, 0, 0] });
  }
  kit.ico(pod, M.glass, 0.28, 1, 0, 1.9, -0.9);
  kit.rect(pod, M.dark, 0.9, 0.5, 0.3, 0, 1.9, -1.15, { rot: [0.2, 0, 0] });
  kit.beacon(s, M.beacon, -1.6, 6.5, 1.6);
  kit.crate(s, M.wood, M.dark, 1.1, 2.2, 0.35, 2.2, 0.3);
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, -2.4, 0.35, -2.2, 10);
  kit.oilStain(s, 1.2, -1.8, 1.0, 0.3);
}

function bBuilding(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 13 x 9.5 x 6.5 m box: a three-storey whitewashed block on a plinth (0.4 .. 5.9, i.e.
  // 1.83 m storeys) plus a single-storey annex on +X. `roofKit` and the water tank go on the
  // annex roof: the roof-kit aerial alone stands 2.6 m proud of whatever carries it, which the
  // 6.5 m box cannot spare on top of three storeys.
  const ROOF = 5.9; // main block roof slab
  const ANNEX = 3.4; // annex roof slab: roof kit alone there already tops out at 6.2 m
  const STOREY = (ROOF - 0.4) / 3; // 1.83 m storey pitch
  kit.rectOn(s, M.concrete, 13, 0.4, 9.5, 0, 0, 0); // plinth, fills the footprint
  kit.boxOn(s, M.wash, 8.6, ROOF - 0.4, 8.4, -2.1, 0.4, 0); // main block, 0.4 .. 5.9
  for (const sz of [-1, 1]) kit.rectOn(s, M.wash, 8.6, 0.5, 0.4, -2.1, ROOF, sz * 4.1); // parapet, 6.4
  for (const sx of [-1, 1]) kit.rectOn(s, M.wash, 0.4, 0.5, 8.4, -2.1 + sx * 4.1, ROOF, 0);
  kit.rectOn(s, M.concrete, 8.4, 0.2, 8.8, -2.1, ROOF, 0); // roof slab, 0.2 m overhang
  // Storey bands + three rows of windows on the long faces.
  for (const row of [1, 2]) kit.rect(s, M.wash, 8.7, 0.26, 8.6, -2.1, 0.4 + row * STOREY, 0);
  for (const sz of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      for (let i = -1; i <= 1; i++) {
        window4(kit, M, s, -2.1 + i * 2.5, 0.4 + STOREY * (row + 0.5), sz * 4.23, 1.3, 1.2, sz > 0 ? 0 : Math.PI, row === 0 && i < 0);
      }
    }
  }
  for (const sx of [-1, 1]) window4(kit, M, s, -2.1 + sx * 4.28, 4.9, 1.6, 1.2, 1.15, sx * (Math.PI / 2), true);
  // Entrance porch with canopy and steps.
  kit.rectOn(s, M.concrete, 3.0, 0.36, 1.1, 0.2, 0.4, 4.5);
  kit.rectOn(s, M.dark, 1.4, 2.2, 0.2, 0.2, 0.76, 4.4);
  kit.rect(s, M.glass, 1.2, 0.9, 0.1, 0.2, 2.1, 4.35, { noShadow: true });
  for (const sx of [-1, 1]) kit.cyl(s, M.steel, 0.1, 0.1, 2.6, 0.2 + sx * 1.4, 0.4, 4.9, 8);
  kit.rectOn(s, M.wash, 3.4, 0.25, 1.3, 0.2, 3.0, 4.4);
  kit.rect(s, M.hazard, 3.4, 0.18, 0.1, 0.2, 3.05, 5.02, { noShadow: true });
  // Single-storey annex with the roof kit + water tank on its roof.
  kit.boxOn(s, M.wash, 4.4, ANNEX - 0.4, 7.0, 4.2, 0.4, 0);
  kit.rectOn(s, M.concrete, 4.6, 0.2, 7.2, 4.2, ANNEX, 0);
  roofKit(kit, M, kit.group(s, 4.2, ANNEX + 0.2, 1.9), 3.6, 3.6, 0, 2.6);
  kit.cyl(s, M.steel, 1.0, 1.0, 1.6, 4.4, ANNEX + 0.2, -1.9, 10);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    kit.rectOn(s, M.dark, 0.12, 0.6, 0.12, 4.4 + Math.cos(a) * 0.85, ANNEX + 0.2, -1.9 + Math.sin(a) * 0.85);
  }
  // Ground dressing: pipes, AC, crates, sandbags, stains, sign, floodlight.
  kit.sandbagWall(s, M.bags, 2.6, 2, -5.0, 0.4, -4.4, 0.62, 0.24, 0.4, 0);
  for (let i = 0; i < 3; i++) kit.rect(s, M.dark, 0.14, 5.2, 0.14, -6.4, 2.9, -2.6 + i * 2.6);
  kit.aircon(s, M.steel, M.dark, 1.2, 0.8, 0.8, -5.4, 1.3, 4.2, 0);
  kit.crate(s, M.wood, M.dark, 1.1, -5.2, 0.4, -4.2, 0.2);
  kit.crate(s, M.wood, M.dark, 1.0, -3.9, 0.4, -4.3, -0.2);
  sangar(kit, M, s, 4.4, 0.4, -3.9, 2.0, -0.3, 3);
  kit.oilStain(s, -1.6, -4.5, 0.4, 0.44);
  kit.sign(s, M.white, M.steel, M.hazard, 1.2, 0.4, 4.4, 0.8, 0.6, 0.1);
  kit.floodlight(s, M.steel, M.dark, -6.0, 0.4, 4.3, 2.4, 2.4);
}




function bWatchtower(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // True scale: 4.6 x 4.6 m footprint, 8.8 m observation tower.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.rectOn(s, M.concrete, 0.9, 0.45, 0.9, sx * 1.6, 0, sz * 1.6);
      kit.boxOn(s, M.dark, 0.3, 5.9, 0.3, sx * 1.6, 0.45, sz * 1.6);
    }
  }
  kit.rectOn(s, M.concrete, 4.6, 0.2, 4.6, 0, 0.05, 0);
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const y0 = 0.5 + i * 1.45;
      const flip = i % 2 === 0;
      kit.strut(s, M.steel, [-1.6, y0, sz * 1.6], [1.6, y0 + (flip ? 1.45 : -1.45) + 1.45, sz * 1.6], 0.09);
      kit.strut(s, M.steel, [-1.6, y0 + 1.45, sz * 1.6], [1.6, y0, sz * 1.6], 0.09);
    }
    kit.rectOn(s, M.steel, 3.6, 0.1, 0.1, 0, 6.0, sz * 1.6);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      kit.strut(s, M.steel, [sx * 1.6, 0.5 + i * 1.9, -1.6], [sx * 1.6, 0.5 + i * 1.9 + 1.9, 1.6], 0.08);
      kit.strut(s, M.steel, [sx * 1.6, 0.5 + i * 1.9 + 1.9, -1.6], [sx * 1.6, 0.5 + i * 1.9, 1.6], 0.08);
    }
  }
  // Platform, cabin, roof.
  kit.rectOn(s, M.panel, 4.4, 0.35, 4.4, 0, 6.35, 0);
  kit.boxOn(s, M.panel, 2.7, 2.2, 2.7, 0, 6.7, 0);
  kit.rect(s, M.glass, 1.9, 1.0, 0.1, 0, 8.0, 1.36, { noShadow: true });
  kit.rect(s, M.glass, 0.1, 1.0, 1.9, 1.36, 8.0, 0, { noShadow: true });
  kit.rect(s, M.glass, 0.1, 1.0, 1.9, -1.36, 8.0, 0, { noShadow: true });
  kit.rectOn(s, M.hazard, 2.8, 0.2, 2.8, 0, 6.6, 0);
  kit.rectOn(s, M.steel, 3.3, 0.18, 3.3, 0, 8.9, 0);
  for (let i = 0; i < 5; i++) kit.rect(s, M.dark, 3.3, 0.06, 0.12, 0, 9.1, -1.3 + i * 0.65, { noShadow: true });
  kit.rail(s, M.steel, 4.3, 0, 6.7, 2.2, 1.0, 0, 5);
  kit.rail(s, M.steel, 4.3, 0, 6.7, -2.2, 1.0, 0, 5);
  kit.rail(s, M.steel, 4.3, 2.2, 6.7, 0, 1.0, Math.PI / 2, 5);
  kit.rail(s, M.steel, 4.3, -2.2, 6.7, 0, 1.0, Math.PI / 2, 5);
  kit.sandbagWall(s, M.bags, 2.6, 2, 0, 6.7, 1.9, 0.6, 0.24, 0);
  kit.ladder(s, M.steel, 6.4, 0, 0.2, 2.35, 0.44, 0);
  kit.ladderCage(s, M.steel, 5.4, 0, 1.0, 2.35, 0.36, 0);
  kit.net(s, kit.teamMat('canvasTent', { side: THREE.DoubleSide, color: teamTint(kit.team, 0.24) }), 3.4, 3.0, -1.9, 6.9, -1.0, 0.4);
  kit.floodlight(s, M.steel, M.dark, 1.5, 6.7, 1.5, 1.3, 2.4);
  kit.cyl(s, M.steel, 0.04, 0.05, 2.4, -1.2, 9.1, -1.2, 5);
  kit.cyl(s, M.dark, 0.02, 0.03, 1.6, -1.2, 11.4, -1.2, 5);
  kit.beacon(s, M.beacon, -1.2, 13.0, -1.2);
  kit.crate(s, M.wood, M.dark, 1.0, 2.4, 0.25, -2.2, 0.4);
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, -2.4, 0.25, 2.0, 10);
  kit.oilStain(s, 1.0, -1.4, 1.0, 0.3);
}

function bHangar(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 22 x 17 x 8.6 m: arched hangar, one bay open, gantry rail inside.
  kit.rectOn(s, M.concrete, 22, 0.3, 17, 0, 0, 0);
  for (const sx of [-1, 1]) kit.rect(s, M.hazard, 0.5, 0.02, 15, sx * 9.6, 0.31, -1, { noShadow: true });
  // Arch shell: built in the X-Z plane then rotated so the span runs along X.
  const shell = kit.mesh(s, kit.gShell(14, 8.4, 10, 0.35), M.panel, 0, 0.3, 0, { rot: [0, Math.PI / 2, 0] });
  shell.scale.set(1, 1, 1.3);
  kit.rectOn(s, M.dark, 19, 0.2, 13, 0, 0.3, 0);
  // Gable end wall (back) + door frame (front).
  kit.rectOn(s, M.wash, 21, 8.3, 0.35, 0, 0.3, -6.6);
  kit.rect(s, M.dark, 5.2, 3.6, 0.2, 0, 2.6, -7.0, { noShadow: true });
  for (const sx of [-1, 1]) {
    kit.boxOn(s, M.panel, 1.6, 7.6, 1.2, sx * 9.3, 0.3, 6.6);
    kit.rect(s, M.hazard, 1.7, 0.8, 1.3, sx * 9.3, 1.0, 6.6, { noShadow: true });
  }
  kit.rectOn(s, M.steel, 21, 1.2, 1.0, 0, 7.3, 6.6);
  kit.rect(s, M.hazard, 19, 0.7, 0.2, 0, 7.9, 7.0, { noShadow: true });
  // One door leaf closed, one rolled open against the frame.
  kit.rect(s, M.panel, 8.4, 6.4, 0.35, -4.6, 3.5, 6.5);
  for (let i = 0; i < 4; i++) kit.rect(s, M.dark, 8.3, 0.12, 0.4, -4.6, 1.2 + i * 1.6, 6.5);
  for (let i = 0; i < 6; i++) kit.rect(s, M.panel, 0.5, 6.3, 0.5, 5.0 + i * 0.55, 3.5, 6.9);
  // Interior: arch ribs, gantry, benches, drums, lamps.
  for (let i = 0; i < 4; i++) {
    const z = -5.4 + i * 3.6;
    for (let k = 0; k < 5; k++) {
      const a0 = (k / 5) * Math.PI;
      const a1 = ((k + 1) / 5) * Math.PI;
      kit.strut(
        s,
        M.steel,
        [Math.cos(a0) * 8.0, Math.sin(a0) * 8.0 + 0.3, z],
        [Math.cos(a1) * 8.0, Math.sin(a1) * 8.0 + 0.3, z],
        0.12,
      );
    }
  }
  kit.rectOn(s, M.steel, 0.4, 0.4, 11, 0, 7.0, -0.5);
  kit.rect(s, M.dark, 1.2, 0.8, 0.6, 0, 6.5, 1.5);
  kit.rect(s, M.hazard, 1.3, 0.2, 0.7, 0, 6.1, 1.5, { noShadow: true });
  for (const sx of [-1, 1]) {
    kit.rect(s, M.lamp, 2.0, 0.14, 0.5, sx * 4.0, 6.2, 2.0, { noShadow: true });
  }
  kit.rectOn(s, M.wood, 5.0, 0.16, 1.0, -5.0, 0.85, -5.6);
  for (const sx of [-2, 2]) kit.rectOn(s, M.dark, 0.14, 0.85, 0.9, -5.0 + sx, 0, -5.6);
  for (let i = 0; i < 4; i++) kit.cyl(s, i % 2 ? M.rust : M.paint, 0.3, 0.3, 0.9, 6.0, 0.5, -4.6 + i * 0.8, 10);
  kit.crate(s, M.wood, M.dark, 1.3, 5.4, 0.5, 2.6, 0.2);
  kit.crate(s, M.wood, M.dark, 1.3, 5.4, 1.7, 2.6, -0.1);
  // Exterior dressing.
  for (const sx of [-1, 1]) kit.rect(s, M.rubber, 0.6, 0.02, 8, sx * 4.2, 0.32, 11.5, { noShadow: true });
  kit.oilStain(s, -6.0, 9.0, 1.8, 0.3);
  kit.oilStain(s, 8.0, 8.6, 1.4, 0.4);
  kit.sandbagWall(s, M.bags, 6.0, 4, -8.0, 0.3, 8.4, 0.62, 0.26, 0);
  kit.floodlight(s, M.steel, M.dark, 8.6, 0.3, 8.6, 2.6, 2.4);
  kit.sign(s, M.white, M.steel, M.hazard, 9.6, 0.3, 4.0, 0.9, 0.65, -0.3);
  kit.cableDrum(s, M.wood, 0.7, -9.0, 0.3, -2.0, 0.6);
  kit.rectOn(s, M.rust, 2.0, 1.0, 1.0, 7.4, 0.3, -6.0);
}

function bAntenna(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // True scale: 4 x 4 m base, 12.6 m lattice mast with a dish.
  kit.rectOn(s, M.concrete, 3.2, 0.5, 3.2, 0, 0, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.rectOn(s, M.steel, 0.5, 0.3, 0.5, sx * 1.2, 0.5, sz * 1.2);
      kit.strut(s, M.dark, [sx * 1.2, 0.7, sz * 1.2], [sx * 0.6, 8.5, sz * 0.6], 0.035);
    }
  }
  kit.latticeMast(s, M.steel, 8.5, 1.3, 0, 0.5, 0, 6, 0.1);
  kit.latticeMast(s, M.steel, 3.0, 0.85, 0, 9.0, 0, 3, 0.08);
  kit.rectOn(s, M.dark, 1.4, 1.4, 0.8, 1.6, 0.5, 0.9, { rot: [0, 0.4, 0] });
  kit.rect(s, M.dark, 0.9, 0.9, 0.08, 1.45, 1.2, 1.32, { noShadow: true, rot: [0, 0.4, 0] });
  kit.cyl(s, M.dark, 0.07, 0.07, 0.8, 1.9, 1.9, 0.9, 6);
  kit.strut(s, M.rubber, [1.6, 0.6, 0.9], [0.2, 1.2, 0.2], 0.05);
  kit.sign(s, M.white, M.steel, M.hazard, -1.6, 0.5, 1.5, 0.7, 0.5, 0.4);
  // Banded paint + warning light.
  for (const y of [3.0, 6.0, 9.5]) {
    kit.rectOn(s, M.white, 1.45, 1.2, 0.06, 0, y, -0.68);
    kit.rectOn(s, M.white, 1.45, 1.2, 0.06, 0, y, 0.68);
  }
  kit.cyl(s, M.steel, 0.03, 0.05, 3.0, 0, 12.0, 0, 5);
  kit.beacon(s, M.beacon, 0, 15.0, 0);
  // Spinning comms dish.
  const dish = animPart(c, [0, 10.6, 0], { part: 'commDish', axis: 'y', speed: 0.25 });
  kit.rect(dish, M.steel, 0.3, 0.8, 0.3, 0, -0.4, 0);
  const g = dishAssembly(kit, M, dish, 1.15, 0.45, -0.9);
  g.position.set(0, 0.35, 0);
  kit.rect(dish, M.dark, 0.35, 0.35, 0.45, 0, 0.1, -0.7);
  kit.ladder(s, M.steel, 8.0, 0, 0.5, -0.75, 0.4, 0);
}


function bHq(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 10 x 8.5 x 11.5 m control tower - the box rf-core's base plan places the HQ at, so this
  // is a narrow three-storey shaft with a glazed cab on top, not the old wide command post.
  // Only the mast (and the roof-kit aerial) stand above the box; the sandbagged ops deck and
  // the building itself stay inside it.
  kit.rectOn(s, M.concrete, 10, 0.35, 8.5, 0, 0, 0); // apron, fills the footprint
  kit.rectOn(s, kit.mat('asphalt', { rough: 0.95 }), 6.0, 0.06, 2.6, 1.4, 0.35, 2.4, { noShadow: true });
  const SH_X = 7.2; // shaft, metres
  const SH_Z = 6.2;
  const SH_TOP = 8.9;
  kit.boxOn(s, M.wash, SH_X, SH_TOP - 0.35, SH_Z, 0, 0.35, -0.5);
  // Three storeys of windows on both long faces, plus a storey band between them.
  for (const sz of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      for (let i = -1; i <= 1; i++) {
        window4(kit, M, s, i * 2.2, 1.9 + row * 2.9, -0.5 + sz * (SH_Z / 2 + 0.03), 1.5, 1.7, sz > 0 ? 0 : Math.PI, row === 0 && i < 0);
      }
    }
  }
  for (const row of [1, 2]) kit.rect(s, M.wash, SH_X + 0.2, 0.3, SH_Z + 0.2, 0, 0.35 + row * 2.9 - 1.4, -0.5);
  // Glazed control cab, overhanging the shaft on every side.
  const CAB_X = 8.6;
  const CAB_Z = 7.4;
  kit.boxOn(s, M.wash, CAB_X, 1.7, CAB_Z, 0, SH_TOP, -0.4);
  for (const sz of [-1, 1]) {
    for (let i = -1; i <= 1; i++) window4(kit, M, s, i * 2.4, SH_TOP + 0.85, -0.4 + sz * (CAB_Z / 2 + 0.03), 2.0, 1.15, sz > 0 ? 0 : Math.PI);
  }
  for (const sx of [-1, 1]) {
    for (const i of [-1, 1]) window4(kit, M, s, sx * (CAB_X / 2 + 0.03), SH_TOP + 0.85, -0.4 + i * 2.1, 1.8, 1.15, (sx * Math.PI) / 2);
  }
  const roofY = SH_TOP + 1.7; // 10.6
  kit.rectOn(s, M.concrete, CAB_X + 0.2, 0.28, CAB_Z + 0.2, 0, roofY, -0.4);
  // Roof ops deck: mast, dishes, sandbags, generator, hatch. Everything here stays within
  // the 11.5 m box except the aerials.
  kit.latticeMast(s, M.steel, 3.6, 0.9, -2.6, roofY + 0.28, -2.4, 4, 0.08);
  kit.cyl(s, M.steel, 0.03, 0.05, 2.2, -2.6, roofY + 3.9, -2.4, 5);
  kit.beacon(s, M.beacon, -2.6, roofY + 6.2, -2.4);
  kit.rectOn(s, M.dark, 1.0, 0.8, 0.9, 2.6, roofY + 0.28, 2.0);
  kit.rect(s, M.dark, 0.7, 0.55, 0.08, 2.6, roofY + 0.8, 2.48, { noShadow: true });
  kit.cyl(s, M.rust, 0.26, 0.26, 0.7, 0.2, roofY + 0.28, 2.6, 8);
  kit.roofHatch(s, M.steel, M.dark, 0.5, 0.8, roofY + 0.28, -2.6);
  kit.sandbagWall(s, M.bags, 3.4, 2, 2.4, roofY + 0.28, -2.9, 0.62, 0.24, 0.4, 0);
  kit.sandbagWall(s, M.bags, 3.0, 2, -4.0, roofY + 0.28, 0.4, 0.62, 0.24, 0.4, Math.PI / 2);
  kit.cyl(s, M.steel, 0.05, 0.07, 1.3, 3.9, roofY + 0.28, -3.2, 6);
  // Ground dressing: entrance, flag, sangars, generator, cable, crates, stains. All of it
  // sits inside the 10 x 8.5 m footprint.
  kit.rectOn(s, M.concrete, 3.4, 0.4, 1.5, 1.6, 0.35, 3.4);
  kit.rect(s, M.glass, 2.4, 2.1, 0.2, 1.6, 1.8, 2.75, { noShadow: true });
  kit.rect(s, M.dark, 0.9, 2.1, 0.14, 0.7, 1.8, 2.7, { noShadow: true });
  for (const sx of [-1, 1]) kit.cyl(s, M.steel, 0.08, 0.08, 3.0, 1.6 + sx * 1.5, 0.75, 3.6, 8);
  kit.rectOn(s, M.wash, 3.8, 0.3, 1.9, 1.6, 3.8, 3.3);
  kit.rect(s, M.hazard, 3.8, 0.2, 0.1, 1.6, 3.7, 4.2, { noShadow: true });
  for (let i = 0; i < 3; i++) kit.rectOn(s, M.concrete, 2.6, 0.18, 0.4, 1.6, 0.35 + i * 0.18, 4.0 - i * 0.3);
  kit.cyl(s, M.steel, 0.06, 0.08, 4.6, -4.3, 0.35, 3.4, 8);
  kit.rect(s, kit.teamMat('canvasTent', { side: THREE.DoubleSide }), 1.5, 0.95, 0.04, -3.6, 4.0, 3.4);
  kit.rectOn(s, M.concrete, 1.4, 0.3, 1.4, -4.3, 0.35, 3.4);
  sangar(kit, M, s, -3.2, 0.35, -2.9, 2.4, 0.4, 3); // pulled in from -3.4: sangars reach 1.9 m
  sangar(kit, M, s, 3.4, 0.35, -2.8, 2.2, Math.PI - 0.3, 3);
  kit.rectOn(s, M.paint, 2.2, 1.1, 1.1, -4.2, 0.35, -0.6);
  kit.cyl(s, M.dark, 0.13, 0.13, 1.3, -3.5, 1.45, -0.6, 6);
  kit.strut(s, M.rubber, [-3.6, 1.4, -0.6], [-1.6, 0.4, 0.2], 0.06);
  kit.cableDrum(s, M.wood, 0.55, -1.4, 0.35, 2.6, 0.4);
  kit.crate(s, M.wood, M.dark, 1.2, 3.6, 0.35, 3.0, 0.2);
  kit.crate(s, M.wood, M.dark, 1.0, 3.6, 1.35, 3.0, -0.3);
  kit.oilStain(s, 0.6, 1.4, 1.2, 0.3);
  kit.oilStain(s, -2.6, 1.0, 0.9, 0.2);
  kit.floodlight(s, M.steel, M.dark, -4.5, 0.35, 1.6, 2.6, 1.6);
  kit.floodlight(s, M.steel, M.dark, 4.5, 0.35, -1.4, 2.6, -1.6);
  kit.sign(s, M.white, M.steel, M.hazard, 4.6, 0.35, 1.8, 0.8, 0.6, 0.1);
  kit.groundArrow(s, M.mark, 2.4, 0.5, -0.6, 0.36, 3.0, Math.PI / 2);
}

function bGate(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // 7.4 x 1.2 x 4.2 m box: a thin checkpoint gate frame - pillars whose outer faces sit at
  // |x| = 3.7, sliding leaves between them, and a boom barrier in front. The 1.2 m depth
  // leaves no ground room beside the leaves, so the sentry box rides on the -X pillar.
  kit.rectOn(s, M.concrete, 7.4, 0.25, 1.2, 0, 0, 0); // apron, fills the footprint
  for (const sx of [-1, 1]) {
    kit.boxOn(s, M.concrete, 0.8, 2.3, 1.1, sx * 3.3, 0.25, 0); // pillar: outer face at x 3.7
    kit.rectOn(s, M.concrete, 0.8, 0.2, 1.15, sx * 3.3, 2.55, 0);
    kit.rectOn(s, M.hazard, 0.8, 0.32, 1.12, sx * 3.3, 0.4, 0);
  }
  // Gate rails + leaves (animated: slide outwards; travel stays in model space).
  for (const sz of [-1, 1]) kit.rectOn(s, M.dark, 6.6, 0.1, 0.1, 0, 2.2, sz * 0.42);
  const leaf = (side: number): THREE.Group => {
    const hinge: V3 = [side * 2.75, 0.25, 0];
    const g = animPart(c, hinge, { part: side < 0 ? 'gateLeafA' : 'gateLeafB', axis: 'x', travel: (side * 2.7) / c.w, period: 3 });
    const dir = -side;
    kit.rect(g, M.steel, 2.7, 0.16, 0.14, dir * 1.35, 2.35, 0);
    kit.rect(g, M.steel, 2.7, 0.16, 0.14, dir * 1.35, 0.35, 0);
    kit.rect(g, M.steel, 2.7, 0.16, 0.14, dir * 1.35, 1.35, 0);
    for (let i = 1; i <= 4; i++) {
      kit.rect(g, M.dark, 0.12, 2.2, 0.12, dir * i * 0.54, 1.32, 0);
    }
    kit.rect(g, M.hazard, 2.6, 0.3, 0.1, dir * 1.35, 2.0, 0.1, { noShadow: true });
    kit.rect(g, M.hazard, 2.6, 0.3, 0.1, dir * 1.35, 0.7, 0.1, { noShadow: true });
    return g;
  };
  const leafA = leaf(-1);
  const leafB = leaf(1);
  const spinA = leafA.parent;
  const spinB = leafB.parent;
  if (spinA) spinA.name = 'anim:gateLeafA';
  if (spinB) spinB.name = 'anim:gateLeafB';
  // Boom barrier + counterweight, on a post just in front of the leaves.
  kit.cyl(s, M.steel, 0.12, 0.14, 1.1, 2.2, 0.25, 0.45, 8);
  kit.hazardStripes(s, M.hazard, 4.6, 0.16, 0.14, 0.3, 1.3, 0.45, 9);
  kit.rect(s, M.dark, 0.7, 0.3, 0.2, 2.2, 1.3, 0.45);
  kit.rectOn(s, M.rubber, 2.6, 0.06, 0.4, -0.9, 0.25, 0.3);
  for (let i = 0; i < 8; i++) kit.rect(s, M.steel, 0.08, 0.14, 0.3, -2.1 + i * 0.32, 0.32, 0.3, { rot: [0, 0, 0.4] });
  // Sentry box on the -X pillar: walls, glazing, awning band. 1.1 m wide so it stops at x 3.7.
  kit.boxOn(s, M.wash, 1.1, 1.3, 1.1, -3.15, 2.75, 0);
  kit.rect(s, M.hazard, 1.14, 0.18, 1.14, -3.15, 2.75, 0);
  kit.rect(s, M.glass, 0.8, 0.55, 0.1, -3.15, 3.65, 0.55, { noShadow: true });
  kit.rect(s, kit.teamMat('canvasTent'), 1.1, 0.12, 1.25, -3.15, 4.05, 0); // awning, top 4.17
  kit.cyl(s, M.steel, 0.05, 0.06, 0.4, 3.3, 2.55, 0, 6);
  kit.ico(s, M.lamp, 0.12, 0, 3.3, 3.1, 0);
  // Sign, sandbags, cable drum, floodlight - all inside the 1.2 m depth.
  kit.sign(s, M.white, M.steel, M.hazard, 3.3, 0.25, 0.45, 0.7, 0.5, -0.4);
  kit.sandbagWall(s, M.bags, 2.4, 2, -1.4, 0.25, -0.45, 0.6, 0.24, 0.4, 0);
  kit.floodlight(s, M.steel, M.dark, 3.3, 2.75, 0, 1.1, -1.2); // top 4.08
  kit.cableDrum(s, M.wood, 0.5, 2.4, 0.25, -0.1, 0.3);
  kit.oilStain(s, -1.2, 0.0, 0.45, 0.28);
  kit.rect(s, M.rubber, 0.5, 0.02, 6.0, 0.6, 0.26, 0, { noShadow: true, rot: [0, Math.PI / 2, 0] });
}


function bLighthouse(c: Ctx): void {
  const { kit, shell: s, M } = c;
  // True scale: 6.5 x 6.5 m rock base, 15 m tower with a spinning beacon.
  kit.cyl(s, M.rock, 3.2, 3.4, 1.1, 0, 0, 0, 9);
  kit.cyl(s, M.concrete, 2.7, 2.8, 0.5, 0, 0.9, 0, 10);
  const baseY = 1.4;
  const bands: [number, number, number, THREE.Material][] = [
    [2.4, 2.2, 4.2, M.wash],
    [2.2, 2.0, 1.7, M.red],
    [2.0, 1.75, 3.6, M.wash],
    [1.75, 1.55, 1.6, M.red],
    [1.55, 1.4, 1.4, M.wash],
  ];
  let y = baseY;
  for (const [r0, r1, h, m] of bands) {
    kit.cyl(s, m, r1, r0, h, 0, y, 0, 12);
    y += h;
  }
  // Door, window slits, ladder, drip course.
  kit.rectOn(s, M.dark, 1.0, 1.9, 0.2, 0, baseY, 2.3);
  kit.rect(s, M.hazard, 1.1, 0.2, 0.24, 0, baseY + 2.0, 2.32, { noShadow: true });
  for (const a of [0.8, 2.4, 4.0]) {
    kit.rect(s, M.dark, 0.3, 0.7, 0.2, Math.cos(a) * 1.9, baseY + 5.2, Math.sin(a) * 1.9, { rot: [0, -a, 0], noShadow: true });
  }
  kit.cyl(s, M.concrete, 1.62, 1.66, 0.16, 0, baseY + 11.1, 0, 12);
  // Gallery deck + railing.
  kit.cyl(s, M.steel, 2.0, 1.95, 0.22, 0, y, 0, 12);
  kit.lathe(s, M.steel, [[1.98, y + 1.05], [2.02, y + 1.05]], 14);
  kit.lathe(s, M.steel, [[1.98, y + 0.6], [2.02, y + 0.6]], 14);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    kit.cyl(s, M.steel, 0.035, 0.035, 1.05, Math.cos(a) * 2.0, y + 0.22, Math.sin(a) * 2.0, 5);
  }
  // Lamp room.
  const lampY = y + 0.22;
  kit.cyl(s, M.dark, 1.25, 1.3, 0.2, 0, lampY, 0, 10);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    kit.rect(s, M.glass, 0.72, 1.25, 0.1, Math.cos(a) * 1.16, lampY + 0.85, Math.sin(a) * 1.16, { rot: [0, -a, 0], noShadow: true });
    kit.rect(s, M.dark, 0.12, 1.35, 0.16, Math.cos(a + 0.39) * 1.2, lampY + 0.85, Math.sin(a + 0.39) * 1.2, { rot: [0, -(a + 0.39), 0] });
  }
  kit.cyl(s, M.dark, 1.3, 1.25, 0.22, 0, lampY + 1.5, 0, 10);
  kit.lathe(s, M.red, [[0.0, 2.6], [0.55, 2.45], [0.95, 2.1], [1.2, 1.72]], 12).position.y = lampY;
  kit.cyl(s, M.steel, 0.05, 0.08, 1.0, 0, lampY + 2.55, 0, 6);
  kit.ico(s, M.steel, 0.14, 1, 0, lampY + 3.6, 0);
  // Spinning beacon lens assembly.
  const beacon = animPart(c, [0, lampY + 0.15, 0], { part: 'beacon', axis: 'y', speed: 1.5 });
  kit.cyl(beacon, M.dark, 0.35, 0.4, 1.3, 0, 0, 0, 8);
  for (let i = 0; i < 2; i++) {
    kit.rect(beacon, M.lamp, 0.3, 1.0, 0.9, i === 0 ? 0.2 : -0.2, 0.65, 0, { noShadow: true, rot: [0, i * Math.PI, 0] });
  }
  kit.ico(beacon, M.beacon, 0.2, 1, 0, 1.35, 0);
  // Keeper's shed + winch + rocks.
  kit.boxOn(s, M.wash, 2.6, 2.1, 2.2, 3.0, 1.0, -2.2);
  kit.rectOn(s, M.red, 3.0, 0.18, 2.6, 3.0, 3.1, -2.2);
  kit.rect(s, M.dark, 0.9, 1.4, 0.1, 3.0, 1.9, -1.04, { noShadow: true });
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, 1.6, 1.0, 3.4, 10);
  kit.cableDrum(s, M.wood, 0.55, -2.6, 1.0, 2.6, 0.5);
  kit.rubble(s, M.rock, 2.0, -2.4, 0.1, -2.6, 8);
  kit.rubble(s, M.rock, 1.4, 2.6, 0.1, 2.4, 6);
  kit.oilStain(s, 1.2, 1.0, 0.9, 0.3);
}

/* ---------------------------------------------- small instanced unit props */

// These five live in `props.ts` because the renderer instances them through `buildProp`;
// delegating keeps both code paths (instanced + single) geometrically identical.
function bCrate(c: Ctx): void {
  propCrate(c.kit, c.shell, c.M);
}

function bBarrel(c: Ctx): void {
  propBarrel(c.kit, c.shell, c.M);
}

function bSandbag(c: Ctx): void {
  propSandbag(c.kit, c.shell, c.M);
}

function bContainer(c: Ctx): void {
  propContainer(c.kit, c.shell, c.M);
}

function bWreck(c: Ctx): void {
  propWreck(c.kit, c.shell, c.M);
}

/* ------------------------------------------------------------- dispatch */

type Builder = (c: Ctx) => void;

const BUILDERS: Readonly<Record<number, Builder>> = {
  [SKIND.GARAGE]: bGarage,
  [SKIND.FLAG_POLE]: bFlagPole,
  [SKIND.FUEL_DEPOT]: bFuelDepot,
  [SKIND.AMMO_TENT]: bAmmoTent,
  [SKIND.HELIPAD]: bHelipad,
  [SKIND.RADAR]: bRadar,
  [SKIND.WALL]: bWall,
  [SKIND.BUNKER]: bBunker,
  [SKIND.BRIDGE]: bBridge,
  [SKIND.TENT]: bTent,
  [SKIND.TURRET_TOWER]: bTurretTower,
  [SKIND.BUILDING]: bBuilding,
  [SKIND.CRATE]: bCrate,
  [SKIND.BARREL]: bBarrel,
  [SKIND.SANDBAG]: bSandbag,
  [SKIND.WATCHTOWER]: bWatchtower,
  [SKIND.HANGAR]: bHangar,
  [SKIND.ANTENNA]: bAntenna,
  [SKIND.WRECK]: bWreck,
  [SKIND.HQ]: bHq,
  [SKIND.GATE]: bGate,
  [SKIND.CONTAINER]: bContainer,
  [SKIND.LIGHTHOUSE]: bLighthouse,
};

/* ------------------------------------------------------------- factory */

/**
 * Build one structure of `kind` for `team`.
 *
 * The returned root sits on the ground at its own origin; `half`/`height` report the
 * authored (map-generator typical) size. Scale by `(w, h, d)` when `isUnitSized(kind)`,
 * otherwise apply yaw + position only.
 */
export function buildStructure(kind: number, lib: SurfaceLibrary, team: TeamId, seed = 1): StructureModel {
  // Palms and rocks are shared with the scatter layer so both look identical.
  if (kind === SKIND.PALM || kind === SKIND.ROCK) {
    const prop = buildProp(kind, lib, seed);
    prop.root.userData.rf = { kind, team, seed, unitSized: false } satisfies StructureMeta;
    return prop;
  }

  const size = sizeOf(kind);
  const unitSized = isUnitSized(kind);
  const kit = new Kit(lib, team, 1013 + kind * 7919 + (seed >>> 0) * 2654435761, [1, 1, 1]);
  const root = new THREE.Group();
  root.name = `struct:${structureKindName(kind)}`;
  const shell = new THREE.Group();
  if (unitSized) {
    shell.scale.set(1 / size[0], 1 / size[2], 1 / size[1]);
  }
  root.add(shell);
  const animated: THREE.Object3D[] = [];
  const ctx: Ctx = { kit, root, shell, animated, w: size[0], h: size[2], d: size[1], unitSized, M: mats(kit) };
  const build = BUILDERS[kind];
  if (build) {
    build(ctx);
  } else {
    // Unknown kind: a sensible generic crate that fits any footprint.
    bCrate(ctx);
  }
  root.userData.rf = { kind, team, seed, unitSized } satisfies StructureMeta;

  const model: StructureModel = {
    root,
    half: [size[0] / 2, size[1] / 2],
    height: size[2],
  };
  if (animated.length > 0) model.animated = animated;

  const ruined = buildRuin(kind, lib, team, seed);
  if (ruined) {
    ruined.visible = false;
    model.ruined = ruined;
  }
  return model;
}

/**
 * Lazily build `model.ruined` for kinds that have a destroyed variant. No-op when the
 * variant is already present (buildStructure always builds it) or the kind never breaks.
 * `ruined` is a *sibling* of `root`: copy root's transform onto it (see `syncTransform`).
 *
 * The library is an argument rather than a `userData` field so that cloning a model stays
 * free of texture serialization (see `StructureMeta`).
 */
export function fortifyRuins(model: StructureModel, lib: SurfaceLibrary): void {
  if (model.ruined) return;
  const meta = model.root.userData.rf as StructureMeta | undefined;
  if (!meta) return;
  const ruined = buildRuin(meta.kind, lib, meta.team, meta.seed);
  if (!ruined) return;
  ruined.visible = false;
  model.ruined = ruined;
}

/** Convenience for previews: place a `ruined` node exactly where `root` sits. */
export function showRuined(model: StructureModel): void {
  if (!model.ruined) return;
  syncTransform(model.root, model.ruined);
  model.root.visible = false;
  model.ruined.visible = true;
}

/** Triangle count of a freshly built structure (budget checks). */
export function structureTriangles(kind: number, lib: SurfaceLibrary, team: TeamId, seed = 1): number {
  return countTriangles(buildStructure(kind, lib, team, seed).root);
}
