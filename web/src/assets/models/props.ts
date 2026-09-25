/**
 * props.ts — natural / scatter dressing, built to be instanced heavily.
 *
 * `buildProp` returns one `StructureModel` per call but every variant is built **once**
 * per (library, kind, variant) into a module cache and then cloned: the clones share the
 * exact same `BufferGeometry` + material instances, so the renderer can either instance
 * them or merge them without exploding memory or draw-call setup cost.
 *
 * Variants are fixed silhouettes — a given (kind, seed) always yields exactly the same
 * shape, and only the *choice* of variant varies with the seed. Natural scatter (palms,
 * rocks, scrub) is authored at true metres and reports `isUnitSized() === false`: never
 * scale those non-uniformly, give them yaw + a slightly random uniform scale instead.
 *
 * Budgets: palms <= 900 tris, rocks <= 300, scrub <= 260.
 *
 * `buildProp` also serves the renderer's instanced path for the *small unit-sized*
 * structure kinds (CRATE, BARREL, SANDBAG, CONTAINER, WRECK): those keep the unit-box
 * convention (authored in metres, normalised by 1/size) so the instanced matrix can scale
 * them by (w, h, d) exactly like `buildStructure` does. Palms and rocks stay true-scale.
 *
 * Own prop ids (100+):
 *   100 BUSH        low scrub ball, 1.1 m
 *   101 GRASS_TUFT  dry grass blades, 0.7 m
 *   102 DEAD_SHRUB  bare thorn bush, 1.4 m
 *   103 AGAVE       spiky succulent, 1.2 m
 *   104 STONES      loose pebble scatter, 0.5 m
 */

import * as THREE from 'three';
import type { StructureModel, SurfaceLibrary } from '../types';
import { Kit, cachedGeometry, countTriangles, teamTint, type V3 } from './kit';
import { PROPKIND, PROP_SIZE, SKIND, isUnitSized, propKindName, sizeOf } from './kinds';

export { isUnitSized, propKindName };

/* --------------------------------------------------------------- variants */

const PALM_VARIANTS = 3;
const SMALL_VARIANTS = 2;
const ROCK_VARIANTS = 4;
const BUSH_VARIANTS = 2;
const TUFT_VARIANTS = 2;
const SHRUB_VARIANTS = 2;
const AGAVE_VARIANTS = 2;

function variantCount(kind: number): number {
  switch (kind) {
    case SKIND.PALM:
      return PALM_VARIANTS;
    case SKIND.ROCK:
      return ROCK_VARIANTS;
    case PROPKIND.BUSH:
      return BUSH_VARIANTS;
    case PROPKIND.GRASS_TUFT:
      return TUFT_VARIANTS;
    case PROPKIND.DEAD_SHRUB:
      return SHRUB_VARIANTS;
    case PROPKIND.AGAVE:
      return AGAVE_VARIANTS;
    case SKIND.CRATE:
    case SKIND.BARREL:
    case SKIND.SANDBAG:
    case SKIND.CONTAINER:
    case SKIND.WRECK:
      return SMALL_VARIANTS;
    default:
      return 1;
  }
}

/** Deterministic 32-bit hash of a seed so variant choice is stable across sessions. */
function hashSeed(seed: number): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/* -------------------------------------------------------------- geometry */

/** Palm frond: tapered, drooping, creased strip. `seg * 4` tris. */
function frondGeometry(len: number, width: number, droop: number, seg = 5): THREE.BufferGeometry {
  return cachedGeometry(`frond:${len},${width},${droop},${seg}`, () => {
    const spine: V3[] = [];
    const left: V3[] = [];
    const right: V3[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const x = len * t;
      const y = -droop * t * t;
      const taper = Math.sin(Math.PI * Math.pow(t, 0.5));
      const serr = i % 2 === 0 ? 1 : 0.68;
      const w = Math.max(0.02, width * taper * serr);
      spine.push([x, y, 0]);
      left.push([x, y - w * 0.5, -w]);
      right.push([x, y - w * 0.5, w]);
    }
    const out: number[] = [];
    const tri = (a: V3, b: V3, c: V3): void => {
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    };
    for (let i = 0; i < seg; i++) {
      tri(spine[i], left[i], left[i + 1]);
      tri(spine[i], left[i + 1], spine[i + 1]);
      tri(spine[i], right[i + 1], right[i]);
      tri(spine[i], spine[i + 1], right[i + 1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    g.computeVertexNormals();
    return g;
  });
}

/** Blade of grass: a single tapered quad (2 tris, double sided). */
function bladeGeometry(len: number, width: number, bend: number): THREE.BufferGeometry {
  return cachedGeometry(`blade:${len},${width},${bend}`, () => {
    const out: number[] = [];
    const steps = 3;
    const pt = (t: number, side: number): V3 => [
      side * width * (1 - t) * 0.5,
      len * t,
      bend * t * t,
    ];
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const a = pt(t0, -1);
      const b = pt(t0, 1);
      const c = pt(t1, 1);
      const d = pt(t1, -1);
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      out.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    g.computeVertexNormals();
    return g;
  });
}

/**
 * Faceted boulder from an icosahedron pushed around by a smooth position-hashed noise
 * (duplicated vertices move together, so the surface stays watertight).
 */
function boulderGeometry(radius: number, detail: number, seed: number, squash: V3 = [1, 0.8, 1]): THREE.BufferGeometry {
  return cachedGeometry(`boulder:${radius},${detail},${seed},${squash.join(',')}`, () => {
    const ico = new THREE.IcosahedronGeometry(radius, detail);
    const g = ico.index ? ico.toNonIndexed() : ico;
    const pos = g.getAttribute('position');
    const s = seed * 0.618;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const n =
        0.72 +
        0.2 * Math.sin(x * 2.1 + s) * Math.cos(z * 1.7 - s * 0.5) +
        0.14 * Math.sin(y * 2.6 + s * 1.3) +
        0.1 * Math.cos(z * 3.3 + x * 1.2 + s);
      pos.setXYZ(i, x * n * squash[0], y * n * squash[1], z * n * squash[2]);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  });
}

/* -------------------------------------------------------------- builders */

function palmTemplate(kit: Kit, variant: number): THREE.Group {
  const g = new THREE.Group();
  const trunkMat = kit.mat('wood', { color: 0x7a6446, rough: 0.92, metal: 0 });
  const frondMat = kit.mat('grass', { color: 0x74863c, side: THREE.DoubleSide, rough: 0.85, metal: 0 });
  const deadMat = kit.mat('grass', { color: 0x8a7a44, side: THREE.DoubleSide, rough: 0.95, metal: 0 });
  const cocoMat = kit.mat('wood', { color: 0x5b4a2c, rough: 0.9, metal: 0 });

  const tall = variant === 0 ? 1 : variant === 1 ? 1.12 : 0.72;
  const lean = variant === 1 ? 0.13 : variant === 2 ? 0.03 : 0.05;
  const frondCount = variant === 2 ? 13 : variant === 1 ? 9 : 11;
  const trunkH = 8.1 * tall;
  const segs = 5;
  const r0 = 0.3;
  const r1 = 0.17;

  // Trunk: stacked tapered segments with alternating radii for a ringed palm read.
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const segH = trunkH / segs;
    const ra = r0 + (r1 - r0) * t0;
    const rb = r0 + (r1 - r0) * t1;
    const bulge = i % 2 === 0 ? 1.12 : 0.94;
    const dx = Math.sin(lean) * segH;
    const seg = kit.cyl(g, trunkMat, rb * bulge, ra * bulge, segH * 1.05, cx + dx * 0.5, cy - 0.05, 0, 6);
    seg.rotation.z = -lean;
    cx += dx;
    cy += segH * Math.cos(lean);
  }

  // Crown.
  const crown = new THREE.Group();
  crown.position.set(cx, cy, 0);
  g.add(crown);
  const baseDroop = variant === 2 ? 1.5 : 2.1;
  for (let i = 0; i < frondCount; i++) {
    const a = (i / frondCount) * Math.PI * 2 + variant * 0.7;
    const len = (variant === 2 ? 2.5 : 3.2) * kit.rng.range(0.82, 1.15);
    const pitch = kit.rng.range(-0.55, 0.42) - (i % 3) * 0.08;
    const frond = kit.mesh(crown, frondGeometry(len, 0.42, baseDroop * kit.rng.range(0.8, 1.2)), frondMat, 0, 0, 0);
    frond.rotation.set(0, a, pitch);
    frond.castShadow = true;
  }
  if (variant !== 2) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const frond = kit.mesh(crown, frondGeometry(2.5, 0.34, 2.6), deadMat, 0, -0.25, 0);
      frond.rotation.set(0, a, -0.95);
      frond.castShadow = false;
    }
  }
  const coco = variant === 1 ? 4 : variant === 0 ? 3 : 2;
  for (let i = 0; i < coco; i++) {
    const a = (i / coco) * Math.PI * 2;
    kit.ico(crown, cocoMat, 0.17, 0, Math.cos(a) * 0.28, -0.24, Math.sin(a) * 0.28);
  }
  return g;
}

function rockTemplate(kit: Kit, variant: number): THREE.Group {
  const g = new THREE.Group();
  const rockMat = kit.mat('rock', { color: variant % 2 ? 0x8c8578 : 0x9a8f7c, rough: 0.95, metal: 0 });
  const darkMat = kit.mat('rock', { color: 0x6f6a5f, rough: 0.95, metal: 0 });
  if (variant === 0) {
    // Single chunky boulder.
    const m = kit.mesh(g, boulderGeometry(1.05, 1, 3.1, [1.1, 0.78, 0.95]), rockMat, 0, 0.34, 0);
    m.rotation.y = 0.6;
  } else if (variant === 1) {
    // Cluster of three.
    const a = kit.mesh(g, boulderGeometry(0.72, 1, 7.3, [1, 0.8, 1]), rockMat, -0.42, 0.3, 0.16);
    a.rotation.y = -0.5;
    const b = kit.mesh(g, boulderGeometry(0.5, 0, 5.9, [1, 0.85, 1.1]), darkMat, 0.46, 0.22, -0.3);
    b.rotation.set(0.2, 1.1, 0.1);
    const c = kit.mesh(g, boulderGeometry(0.34, 0, 2.2), rockMat, 0.2, 0.16, 0.52);
    c.rotation.y = 2.1;
  } else if (variant === 2) {
    // Half-buried slab, wide and low.
    const m = kit.mesh(g, boulderGeometry(1.15, 1, 11.7, [1.15, 0.42, 1]), rockMat, 0, 0.06, 0);
    m.rotation.y = 1.2;
    kit.mesh(g, boulderGeometry(0.3, 0, 4.4), darkMat, 0.95, 0.12, 0.55);
  } else {
    // Weathered spire.
    const m = kit.mesh(g, boulderGeometry(0.78, 1, 17.9, [0.72, 1.18, 0.8]), rockMat, 0, 0.5, 0);
    m.rotation.set(0.12, 0.9, -0.08);
    kit.mesh(g, boulderGeometry(0.42, 0, 8.8), darkMat, -0.62, 0.18, 0.34);
    kit.mesh(g, boulderGeometry(0.26, 0, 6.1), rockMat, 0.58, 0.14, -0.44);
  }
  return g;
}

function bushTemplate(kit: Kit, variant: number): THREE.Group {
  const g = new THREE.Group();
  const leaf = kit.mat('grass', { color: variant ? 0x5f6b38 : 0x6d7a41, rough: 0.9, metal: 0 });
  const dry = kit.mat('grass', { color: 0x8d7f4c, rough: 0.95, metal: 0 });
  const blobs = variant ? 4 : 3;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + 0.5;
    const r = 0.34 + kit.rng.range(0, 0.16);
    kit.ico(g, i % 2 ? leaf : dry, r, 0, Math.cos(a) * 0.32, r * 0.72, Math.sin(a) * 0.32, {
      scale: [1, 0.72, 1],
      rot: [0, kit.rng.range(0, 3), 0],
    });
  }
  kit.ico(g, leaf, 0.42, 0, 0, 0.4, 0, { scale: [1, 0.8, 1] });
  for (let i = 0; i < 3; i++) {
    const a = kit.rng.range(0, Math.PI * 2);
    kit.strut(g, dry, [0, 0.05, 0], [Math.cos(a) * 0.5, 0.75, Math.sin(a) * 0.5], 0.03);
  }
  return g;
}

function tuftTemplate(kit: Kit, variant: number): THREE.Group {
  const g = new THREE.Group();
  const mat = kit.mat('grass', { color: variant ? 0xb9a468 : 0xc4b077, side: THREE.DoubleSide, rough: 0.95, metal: 0 });
  const n = variant ? 9 : 7;
  for (let i = 0; i < n; i++) {
    const a = kit.rng.range(0, Math.PI * 2);
    const len = kit.rng.range(0.4, 0.72);
    const blade = kit.mesh(g, bladeGeometry(len, 0.07, kit.rng.range(-0.25, 0.25)), mat, 0, 0, 0);
    blade.rotation.set(kit.rng.range(-0.3, 0.3), a, kit.rng.range(-0.35, 0.35));
    blade.castShadow = false;
  }
  return g;
}

function shrubTemplate(kit: Kit, variant: number): THREE.Group {
  const g = new THREE.Group();
  const wood = kit.mat('wood', { color: 0x7d6a4a, rough: 0.95, metal: 0 });
  const leaf = kit.mat('grass', { color: 0x7c7f4a, side: THREE.DoubleSide, rough: 0.95, metal: 0 });
  const branches = variant ? 6 : 4;
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + kit.rng.range(-0.3, 0.3);
    const len = kit.rng.range(0.6, 1.15);
    kit.strut(g, wood, [0, 0.02, 0], [Math.cos(a) * len * 0.7, len * 0.85, Math.sin(a) * len * 0.7], 0.045);
    if (i % 2 === 0) {
      kit.mesh(g, frondGeometry(0.34, 0.14, 0.1, 2), leaf, Math.cos(a) * len * 0.6, len * 0.7, Math.sin(a) * len * 0.6, {
        rot: [0, a, 0.4],
        noShadow: true,
      });
    }
  }
  return g;
}

function agaveTemplate(kit: Kit, variant: number): THREE.Group {
  const g = new THREE.Group();
  const mat = kit.mat('grass', { color: variant ? 0x7d8a63 : 0x6d7f5a, side: THREE.DoubleSide, rough: 0.9, metal: 0 });
  const leaves = 9;
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2;
    const pitch = kit.rng.range(0.35, 0.95);
    const leaf = kit.mesh(g, frondGeometry(0.95, 0.2, -0.25, 2), mat, 0, 0.06, 0);
    leaf.rotation.set(0, a, Math.PI / 2 - pitch);
  }
  kit.cyl(g, mat, 0.02, 0.05, 1.3, 0, 0, 0, 5);
  return g;
}

function stonesTemplate(kit: Kit): THREE.Group {
  const g = new THREE.Group();
  const mat = kit.mat('rock', { color: 0x93897a, rough: 0.95, metal: 0 });
  for (let i = 0; i < 3; i++) {
    const a = kit.rng.range(0, Math.PI * 2);
    const d = kit.rng.range(0.15, 0.5);
    kit.ico(g, mat, kit.rng.range(0.12, 0.24), 0, Math.cos(a) * d, 0.06, Math.sin(a) * d, {
      scale: [1, 0.6, 1],
      rot: [0, kit.rng.range(0, 3), 0],
    });
  }
  return g;
}

/* ------------------------------------------- small unit-sized instanced props */

/**
 * Materials for the small unit-prop builders (crate/barrel/sandbag/container/wreck).
 * Kept local so `props.ts` never has to import `structures.ts` (which imports us).
 */
function smallMats(kit: Kit) {
  return {
    concrete: kit.teamMat('concreteWorn'),
    wash: kit.mat('concrete', { color: teamTint(kit.team, 0.74) }),
    panel: kit.teamMat('metalPanel'),
    paint: kit.teamMat('metalPainted'),
    dark: kit.mat('metalDark'),
    rust: kit.mat('rust'),
    hazard: kit.mat('hazard', { rough: 0.72, metal: 0.05 }),
    glass: kit.mat('glass', { rough: 0.18, metal: 0.25 }),
    wood: kit.mat('wood'),
    dirt: kit.mat('dirt'),
    rock: kit.mat('rock'),
    rubber: kit.mat('rubber'),
    steel: kit.mat('metalPanel', { color: 0xb6b9bd, metal: 0.55, rough: 0.42 }),
    white: kit.mat('metalPainted', { color: 0xf1efe4, rough: 0.6 }),
    red: kit.mat('metalPainted', { color: 0xa8382c, rough: 0.6 }),
    lamp: kit.mat('metalPainted', { color: 0xf6efd8, emissive: 0xffe6ad, emissiveIntensity: 1.2, rough: 0.35 }),
    scorch: kit.mat('scorch', { rough: 1, metal: 0 }),
  };
}
type SmallMats = ReturnType<typeof smallMats>;

/** Unit-box wrapper for the instanced small structures (scale is applied by the caller). */
function unitShell(
  kind: number,
  lib: SurfaceLibrary,
  variant: number,
  build: (kit: Kit, shell: THREE.Group, mats: SmallMats, variant: number) => void,
): THREE.Group {
  const size = sizeOf(kind);
  const kit = new Kit(lib, 0, 1000 + kind * 17 + variant * 101, [1, 1, 1]);
  const root = new THREE.Group();
  const shell = new THREE.Group();
  shell.scale.set(1 / size[0], 1 / size[2], 1 / size[1]);
  root.add(shell);
  build(kit, shell, smallMats(kit), variant);
  return root;
}

export function propCrate(kit: Kit, s: THREE.Group, M: SmallMats, variant = 0): void {
  // 2.2 x 2.2 x 2.0 m box (`STRUCTURE_SIZE[SKIND.CRATE]`). A full-size crate leaves no room
  // for a second one beside it, so variant 1 splits the same volume into two half-width
  // crates - both variants fill the 2.2 m footprint and stop just under 2.0 m.
  const CRATE = 2.0; // crate body: 2.0 m across, 2.02 m once the slat frame is on it
  const BASE = 0.12; // pallet slab under the crates
  kit.rectOn(s, M.dark, 2.16, BASE, 2.16, 0, 0, 0); // 2.16 x 2.16 slab (box 2.2 x 2.2)
  if (variant % 2 === 1) {
    for (const sx of [-1, 1]) {
      kit.crate(s, M.wood, M.dark, CRATE, sx * 0.53, BASE, 0, 0, [0.5, 1, 1]); // 1.0 x 1.8 x 2.0
      kit.rect(s, M.hazard, 0.5, 0.3, 0.05, sx * 0.53, 0.95, 1.03, { noShadow: true });
    }
    kit.rectOn(s, M.dark, 2.1, 0.1, 0.5, 0, BASE + CRATE * 0.9, 0); // batten across both lids
  } else {
    kit.crate(s, M.wood, M.dark, CRATE, 0, BASE, 0, 0);
    kit.rect(s, M.hazard, 0.6, 0.34, 0.05, 0, 0.95, 1.03, { noShadow: true });
    kit.rect(s, M.white, 0.7, 0.14, 0.55, 0, BASE + CRATE * 0.9 + 0.1, 0, { noShadow: true, rot: [0, 0.2, 0] });
  }
}

/** One fuel drum standing upright at (x, z) on `yBase`: body, ribs, top rim, bung, bands. */
function drum(kit: Kit, s: THREE.Group, M: SmallMats, r: number, h: number, x: number, yBase: number, z: number): void {
  kit.cyl(s, M.rust, r, r, h, x, yBase, z, 12);
  for (const y of [h * 0.28, h * 0.62]) kit.cyl(s, M.dark, r * 1.04, r * 1.04, r * 0.18, x, yBase + y, z, 12);
  kit.cyl(s, M.dark, r * 1.02, r * 1.02, 0.06, x, yBase + h, z, 12);
  kit.cyl(s, M.steel, 0.09, 0.09, 0.06, x + r * 0.4, yBase + h + 0.02, z, 8);
  kit.rect(s, M.hazard, r * 1.3, 0.16, 0.02, x, yBase + h * 0.5, z + r + 0.01, { noShadow: true });
  kit.rect(s, M.white, r * 0.85, 0.2, 0.02, x, yBase + h * 0.78, z + r, { noShadow: true });
}

export function propBarrel(kit: Kit, s: THREE.Group, M: SmallMats, variant = 0): void {
  // 1.4 x 1.4 x 1.6 m box (`STRUCTURE_SIZE[SKIND.BARREL]`): a two-drum cluster that fills the
  // footprint - one drum upright, the other either tipped against it (variant 0) or standing
  // in a tidy pair (variant 1). Three drums in a row need 2.4 m and no longer fit.
  const R = 0.4; // 0.8 m drum: two of them are exactly the 1.4 m box width
  const H = 1.42; // + top rim and bung = the 1.5 m cluster height
  if (variant % 2 === 0) {
    drum(kit, s, M, R, H, -0.3, 0.02, -0.25); // upright drum on -x
    // Tipped drum resting against it, lying along +z.
    kit.cylC(s, M.rust, R, R, 1.0, 0.3, 0.02 + R, 0.2, 12, { rot: [Math.PI / 2, 0, 0] });
    kit.cylC(s, M.dark, R * 1.04, R * 1.04, 0.07, 0.3, 0.02 + R, 0.68, 12, { rot: [Math.PI / 2, 0, 0] });
    kit.cylC(s, M.dark, R, R, 0.07, 0.3, 0.02 + R, -0.28, 12, { rot: [Math.PI / 2, 0, 0] });
    kit.oilStain(s, -0.3, -0.2, 0.35, 0.02);
  } else {
    for (const sx of [-1, 1]) drum(kit, s, M, 0.35, H, sx * 0.35, 0.02, 0.05 * sx);
  }
}

export function propSandbag(kit: Kit, s: THREE.Group, M: SmallMats, variant = 0): void {
  // 4 x 1.4 x 1.0 m box (`STRUCTURE_SIZE[SKIND.SANDBAG]`): a straight sangar parapet with a
  // firing step and loose bags. A C-shaped parapet needs more depth than the 1.4 m footprint
  // gives, so the wall runs along +z with the step and the loose bags behind it.
  const bag = kit.mat('sandbag', { color: 0x6d6144 });
  const bagW = 0.62; // 6 bags: a 3.9 m cloud inside the 4 m width
  const bagH = 0.3; // 3 rows = 0.97 m, the box height
  kit.rectOn(s, M.dirt, 3.9, 0.14, 1.3, 0, 0, 0); // spoil pad, 3.9 x 1.3 (box 4 x 1.4)
  kit.sandbagWall(s, bag, 3.6, 3, 0, 0.14, 0.32, bagW, bagH, 0.4, 0);
  kit.rectOn(s, M.wood, 1.9, 0.3, 0.5, 0, 0.14, -0.3); // firing step
  kit.rectOn(s, M.dirt, 2.0, 0.22, 0.5, 0, 0, -0.3);
  for (let i = 0; i < 4; i++) {
    kit.box(s, bag, 0.6, 0.28, 0.42, -1.6 + i * 0.5, 0.28 + (i % 2) * 0.26, -0.42 + (i % 2) * 0.3, {
      rot: [0, i * 0.7, 0.05],
    });
  }
  if (variant % 2 === 1) kit.sandbagWall(s, bag, 1.6, 2, 0, 0.14, -0.42, bagW, bagH, 0.4, 0);
  kit.rectOn(s, M.dark, 0.45, 0.32, 0.3, 1.5, 0.14, -0.45); // ammo box
  kit.rect(s, M.hazard, 0.4, 0.08, 0.32, 1.5, 0.45, -0.45, { noShadow: true });
  kit.oilStain(s, -0.8, 0.2, 0.45, 0.15);
}

export function propContainer(kit: Kit, s: THREE.Group, M: SmallMats, variant = 0): void {
  // 6.5 x 2.8 x 2.7 m box (`STRUCTURE_SIZE[SKIND.CONTAINER]`): 6.0 m ISO container, one
  // door end, corrugated sides. Only boxes, handles and folded-back leaves go past the shell.
  const body = M.rust;
  kit.rectOn(s, M.dark, 6.1, 0.2, 2.5, 0, 0, 0);
  kit.boxOn(s, body, 6.0, 2.35, 2.45, 0, 0.2, 0);
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 11; i++) {
      kit.rect(s, M.dark, 0.16, 2.2, 0.06, -2.7 + i * 0.54, 1.38, sz * 1.24);
    }
    kit.rect(s, M.hazard, 5.4, 0.22, 0.04, 0, 0.62, sz * 1.28, { noShadow: true });
  }
  for (const sx of [-1, 1]) {
    for (const sy of [0, 1]) {
      for (const sz of [-1, 1]) {
        kit.rect(s, M.dark, 0.26, 0.26, 0.26, sx * 2.95, 0.28 + sy * 2.1, sz * 1.2);
      }
    }
  }
  kit.rect(s, M.rust, 0.18, 2.3, 2.4, 3.0, 1.38, 0);
  for (const sz of [-1, 1]) {
    kit.rect(s, M.steel, 0.14, 2.0, 0.14, 3.06, 1.4, sz * 0.6);
    kit.rect(s, M.dark, 0.1, 0.5, 0.1, 3.12, 1.4, sz * 0.6);
  }
  kit.rect(s, M.dark, 0.16, 0.2, 2.3, 3.06, 1.4, 0);
  // Roof ribs, hatch, stencil.
  for (let i = 0; i < 4; i++) kit.rectOn(s, M.dark, 0.14, 0.08, 2.4, -2.2 + i * 1.5, 2.55, 0);
  kit.rectOn(s, M.steel, 0.9, 0.18, 0.9, 1.0, 2.63, 0);
  kit.rect(s, M.white, 1.2, 0.5, 0.04, -1.6, 1.7, 1.25, { noShadow: true });
  kit.rect(s, kit.teamMat('metalPainted'), 0.6, 0.34, 0.04, -0.1, 1.7, 1.25, { noShadow: true });
  kit.rect(s, M.dark, 0.5, 0.24, 0.04, 0.9, 1.7, 1.25, { noShadow: true });
  if (variant % 2 === 1) {
    // Open end: the leaves fold back flat against the end frame - a swung-open 1.2 m door
    // cannot fit in the 0.25 m the 6.5 m box leaves past the 6.0 m shell.
    for (const sz of [-1, 1]) {
      kit.rect(s, M.rust, 0.12, 2.3, 1.15, 3.12, 1.35, sz * 0.62);
      kit.rect(s, M.dark, 0.14, 1.4, 0.12, 3.2, 1.4, sz * 1.2);
    }
    kit.rect(s, M.dark, 0.1, 1.9, 2.0, 3.02, 1.3, 0, { noShadow: true }); // dark doorway
  }
  kit.oilStain(s, 1.6, 0.8, 0.5, 0.02);
  kit.rectOn(s, M.wood, 1.6, 0.14, 1.2, -2.6, 0.2, 0.8);
}

export function propWreck(kit: Kit, s: THREE.Group, M: SmallMats, variant = 0): void {
  // 6.5 x 3.2 x 2.2 m box (`STRUCTURE_SIZE[SKIND.WRECK]`): burnt-out hulk, no turret,
  // twisted hull. The thrown track, road wheels and rubble all sit inside |z| <= 1.9.
  kit.rectOn(s, M.scorch, 6.4, 0.25, 3.2, 0, 0.1, 0);
  kit.boxOn(s, M.scorch, 6.2, 1.0, 3.1, 0, 0.3, 0, { rot: [0, 0.04, 0] });
  kit.taperOn(s, M.rust, 1.9, 0.8, 3.0, 0.75, 0.86, 2.35, 0.85, 0, { rot: [0.05, 0, 0] });
  kit.rectOn(s, M.scorch, 6.4, 0.6, 0.3, 0, 0.3, 1.5);
  kit.rectOn(s, M.scorch, 6.4, 0.6, 0.3, 0, 0.3, -1.5);
  // Blown-open turret ring with jagged remnants.
  kit.lathe(s, M.rust, [[0.75, 1.35], [1.0, 1.35]], 12);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    kit.strut(s, M.rust, [Math.cos(a) * 0.9, 1.3, Math.sin(a) * 0.9], [Math.cos(a) * 1.0 + 0.1, 1.3 + (i % 3) * 0.3, Math.sin(a) * 1.0], 0.1);
  }
  kit.rect(s, M.scorch, 1.9, 0.5, 1.7, -0.2, 1.15, 0, { rot: [0.06, 0.2, 0.05] });
  // Bent barrel lying across the engine deck.
  kit.cylC(s, M.dark, 0.12, 0.15, 2.6, 0.9, 1.15, -0.9, 8, { rot: [0, 0.5, Math.PI / 2 - 0.08] });
  kit.rect(s, M.rust, 0.7, 0.24, 0.6, -1.0, 1.5, -1.2);
  // Rear engine deck blown open.
  kit.rect(s, M.scorch, 2.0, 0.2, 2.8, -2.2, 1.5, 0, { rot: [0.35, 0.1, 0.1] });
  kit.rect(s, M.scorch, 1.2, 0.3, 1.6, -2.6, 0.6, 0.4, { rot: [-0.2, 0.5, 0] });
  // Thrown track + road wheels, pulled in against the hull.
  for (let i = 0; i < 6; i++) {
    kit.rect(s, M.rubber, 0.4, 0.16, 0.5, 1.0 + i * 0.4, 0.22 + (i % 2) * 0.12, 1.4 + Math.sin(i) * 0.15, {
      rot: [0, i * 0.25, 0.1],
    });
  }
  kit.cylC(s, M.dark, 0.42, 0.42, 0.3, -2.0, 0.42, 1.35, 10, { rot: [Math.PI / 2, 0, 0.4] });
  kit.cylC(s, M.rust, 0.36, 0.36, 0.26, -1.0, 0.36, 1.2, 10, { rot: [Math.PI / 2, 0, -0.3] });
  kit.rebar(s, M.rust, 2.2, 0.9, 0.6, 0.9, 5, 0.2);
  kit.rubble(s, M.rock, 0.8, -1.4, 0.15, -1.0, 7);
  kit.oilStain(s, 0.4, 0.2, 1.3, 0.02);
  kit.mesh(s, kit.gBox(1.2, 0.4, 0.5), M.scorch, 2.6, 0.5, -0.9, { rot: [0.3, 0.8, 0.2] });
  if (variant % 2 === 1) {
    kit.rect(s, M.scorch, 2.8, 0.3, 1.4, -0.4, 1.45, 0.5, { rot: [0.2, -0.45, 0.15] });
    kit.cylC(s, M.dark, 0.28, 0.28, 0.8, -2.6, 0.35, 1.4, 10, { rot: [Math.PI / 2, 0.3, -0.2] });
    kit.rubble(s, M.rock, 0.8, 2.2, 0.15, 0.9, 5);
  }
}


function buildTemplate(kind: number, variant: number, lib: SurfaceLibrary): THREE.Group {
  const kit = new Kit(lib, 0, 1000 + kind * 17 + variant * 101, [1, 1, 1]);
  switch (kind) {
    case SKIND.PALM:
      return palmTemplate(kit, variant);
    case SKIND.ROCK:
      return rockTemplate(kit, variant);
    case PROPKIND.BUSH:
      return bushTemplate(kit, variant);
    case PROPKIND.GRASS_TUFT:
      return tuftTemplate(kit, variant);
    case PROPKIND.DEAD_SHRUB:
      return shrubTemplate(kit, variant);
    case PROPKIND.AGAVE:
      return agaveTemplate(kit, variant);
    case PROPKIND.STONES:
      return stonesTemplate(kit);
    case SKIND.CRATE:
      return unitShell(kind, lib, variant, propCrate);
    case SKIND.BARREL:
      return unitShell(kind, lib, variant, propBarrel);
    case SKIND.SANDBAG:
      return unitShell(kind, lib, variant, propSandbag);
    case SKIND.CONTAINER:
      return unitShell(kind, lib, variant, propContainer);
    case SKIND.WRECK:
      return unitShell(kind, lib, variant, propWreck);
    default:
      // Sensible generic scatter: a small rock.
      return rockTemplate(kit, 1);
  }
}

/* ----------------------------------------------------------------- cache */

const templates = new WeakMap<SurfaceLibrary, Map<string, THREE.Group>>();

function templateFor(kind: number, variant: number, lib: SurfaceLibrary): THREE.Group {
  let byLib = templates.get(lib);
  if (!byLib) {
    byLib = new Map<string, THREE.Group>();
    templates.set(lib, byLib);
  }
  const key = `${kind}:${variant}`;
  let t = byLib.get(key);
  if (!t) {
    t = buildTemplate(kind, variant, lib);
    t.name = `prop:${propKindName(kind)}:${variant}`;
    byLib.set(key, t);
  }
  return t;
}

/** Which silhouette variant a seed selects (0..variantCount-1). */
export function propVariant(kind: number, seed: number): number {
  return hashSeed(seed) % variantCount(kind);
}

/** Triangle count of a prop variant (all instances of a variant share geometry). */
export function propTriangles(kind: number, lib: SurfaceLibrary, seed = 0): number {
  const variant = hashSeed(seed) % variantCount(kind);
  return countTriangles(templateFor(kind, variant, lib));
}

/* --------------------------------------------------------------- factory */

/**
 * Natural scatter prop. `seed` picks the silhouette variant (and nothing else), so the
 * same seed is cheap to reuse per map cell; rotate with `yaw` and jitter with a uniform
 * scale on the root for variety.
 */
export function buildProp(kind: number, lib: SurfaceLibrary, seed: number): StructureModel {
  const variant = hashSeed(seed) % variantCount(kind);
  const template = templateFor(kind, variant, lib);
  const root = template.clone(true);
  root.name = `prop:${propKindName(kind)}`;
  root.userData.rf = { kind, seed, variant, unitSized: isUnitSized(kind) };
  const size = sizeOf(kind);
  return {
    root,
    half: [size[0] / 2, size[1] / 2],
    height: size[2],
  };
}

/** Props never have a destroyed variant — use `fortifyRuins` from `structures.ts`. */

export { PROP_SIZE, PROPKIND };
