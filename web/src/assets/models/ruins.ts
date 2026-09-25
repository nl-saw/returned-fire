/**
 * ruins.ts — destroyed variants (`model.ruined`) for the destructible structure kinds.
 *
 * Same authoring rules as structures.ts: unit-sized kinds are written in metres and
 * normalised into the 1x1x1 box, true-scale kinds stay in metres. Ruins are always
 * static (no `animated`) and deliberately cheaper than the intact model: broken wall
 * stubs, collapsed roof slabs, twisted rebar, scorched concrete, spilled sandbags.
 *
 * `buildRuin` returns `undefined` for kinds that do not break apart (props, wrecks,
 * lighthouse, radar, antennas...).
 */

import * as THREE from 'three';
import type { SurfaceLibrary, TeamId } from '../types';
import { Kit, teamTint } from './kit';
import { SKIND, isUnitSized, sizeOf } from './kinds';

interface RMats {
  concrete: THREE.Material;
  slab: THREE.Material;
  /** Scorched but still readable concrete (pure `scorch` reads as a black hole from above). */
  burnt: THREE.Material;
  rubble: THREE.Material;
  soot: THREE.Material;
  rust: THREE.Material;
  dirt: THREE.Material;
  rock: THREE.Material;
  wood: THREE.Material;
  dark: THREE.Material;
  steel: THREE.Material;
  sandbag: THREE.Material;
  canvas: THREE.Material;
  glass: THREE.Material;
  hazard: THREE.Material;
}

function rMats(kit: Kit, team: TeamId): RMats {
  return {
    concrete: kit.mat('concreteWorn', { color: 0x8a857c }),
    slab: kit.mat('concrete', { color: 0x9a958a }),
    burnt: kit.mat('concreteWorn', { color: 0x585349, rough: 0.98 }),
    rubble: kit.mat('concreteWorn', { color: 0x8f8a80 }),
    soot: kit.mat('scorch', { rough: 1, metal: 0 }),
    rust: kit.mat('rust'),
    dirt: kit.mat('dirt'),
    rock: kit.mat('rock'),
    wood: kit.mat('wood', { color: 0x554430 }),
    dark: kit.mat('metalDark', { color: 0x2b2c2c }),
    steel: kit.mat('metalPanel', { color: 0x63666a, metal: 0.4, rough: 0.62 }),
    sandbag: kit.mat('sandbag', { color: 0x8a7d5c }),
    canvas: kit.mat('canvasTent', { color: teamTint(team, 0.28), side: THREE.DoubleSide }),
    glass: kit.mat('glass', { rough: 0.3, metal: 0.2 }),
    hazard: kit.mat('hazard', { rough: 0.85, color: 0x9a8a52 }),
  };
}

interface RCtx {
  kit: Kit;
  shell: THREE.Group;
  M: RMats;
  w: number;
  h: number;
  d: number;
}

/** Tilted, cracked slab of concrete. */
function slab(c: RCtx, x: number, y: number, z: number, w: number, h: number, d: number, tiltZ: number, tiltX = 0, mat?: THREE.Material): THREE.Mesh {
  return c.kit.box(c.shell, mat ?? c.M.slab, w, h, d, x, y, z, { rot: [tiltX, c.kit.rng.range(-0.5, 0.5), tiltZ] });
}

/** Irregular pile of broken slabs + chunks. */
function debris(c: RCtx, x: number, z: number, r: number, count = 9, h = 0.5): void {
  for (let i = 0; i < count; i++) {
    const a = c.kit.rng.range(0, Math.PI * 2);
    const dist = Math.sqrt(c.kit.rng()) * r;
    const sw = r * c.kit.rng.range(0.35, 0.85);
    const sh = h * c.kit.rng.range(0.3, 1.1);
    const sd = r * c.kit.rng.range(0.3, 0.8);
    slab(
      c,
      x + Math.cos(a) * dist,
      sh * 0.4,
      z + Math.sin(a) * dist,
      sw,
      sh,
      sd,
      c.kit.rng.range(-0.5, 0.5),
      c.kit.rng.range(-0.4, 0.4),
      c.kit.rng.chance(0.35) ? c.M.burnt : c.M.rubble,
    );
  }
  c.kit.rubble(c.shell, c.M.rock, r * 0.7, x, 0.05, z, Math.round(count * 0.7));
}

/* ------------------------------------------------------------- the ruins */
// Every unit-sized ruin below is authored inside the box `STRUCTURE_SIZE` gives its kind,
// because the renderer normalises the model by exactly that box and then scales the instance
// by the size the generator placed: `hw`/`hd` are that box's half extents on X / Z.
// `tools/structure-fit.mjs` measures the occupied *extent* (max - min), so a tilted slab that
// dips below grade spends the same height budget as one that pokes above it — which is why the
// rubble is a handful of small piles rather than one wide field.

function ruinGarage(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 16 x 10 x 5.2 m (`hw`/`hd` are its half extents on X / Z).
  const hw = c.w / 2;
  const hd = c.d / 2;
  // Slab, surviving wall stubs, roof caved in over the bays.
  kit.rectOn(s, M.concrete, 2 * hw - 0.4, 0.3, 2 * hd - 0.4, 0, 0, 0);
  kit.rectOn(s, M.soot, 9, 0.05, 7.5, -0.5, 0.3, 0.5, { noShadow: true });
  // Long west wall (runs along Z), rear wall and a front stub.
  kit.brokenWall(s, M.concrete, 2 * hd - 0.8, 4.4, 0.6, -(hw - 0.6), 0.3, 0, Math.PI / 2);
  kit.brokenWall(s, M.concrete, 8.0, 3.8, 0.6, 0, 0.3, -(hd - 0.5));
  kit.brokenWall(s, M.concrete, 4.0, 2.8, 0.6, hw - 2.4, 0.3, hd - 0.5);
  for (let i = 0; i < 3; i++) {
    slab(c, -2.6 + i * 2.6, 1.7 + i * 0.3, -1.4 + i * 1.1, 5.6, 0.4, 4.8, c.kit.rng.range(-0.45, -0.15), 0.15, i % 2 ? M.burnt : M.slab);
  }
  slab(c, 2.2, 1.15, 1.4, 4.2, 0.32, 3.0, 0.45, -0.15, M.burnt);
  slab(c, -2.0, 0.5, 3.4, 5.4, 0.3, 0.3, 0.1, 0.05, M.dark);
  kit.rebar(s, M.rust, -5.0, 0.4, 3.4, 1.4, 6, 0.3);
  kit.rebar(s, M.rust, 2.0, 0.4, -3.0, 1.6, 5, 0.3);
  // Rubble piles are small and numerous: a wider field would sink past the ground plane.
  debris(c, 4.6, 1.6, 0.65, 8, 0.3);
  debris(c, -2.8, -2.4, 0.6, 6, 0.28);
  debris(c, 0.4, 3.0, 0.6, 6, 0.28);
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, 6.2, 0.3, 3.6, 10, { rot: [Math.PI / 2, 0, 0.2] });
  kit.cyl(s, M.dark, 0.31, 0.31, 0.9, 4.4, 0.3, 4.2, 10, { rot: [Math.PI / 2, 0.4, -0.1] });
  for (let i = 0; i < 4; i++) {
    kit.box(s, M.sandbag, 0.6, 0.22, 0.38, -6.0 + i * 0.7, 0.35, 4.2 + i * 0.1, { rot: [0, i * 0.5, 0] });
  }
}

function ruinWall(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 7.1 x 0.9 x 2.6 m: a thin wall line, so the wreck stays on that line —
  // the rubble piles are small and scattered *along* X instead of spilled across Z.
  const hw = c.w / 2;
  const hd = c.d / 2;
  kit.rectOn(s, M.concrete, 2 * hw - 0.3, 0.4, 2 * hd - 0.1, 0, 0, 0);
  kit.brokenWall(s, M.concrete, 2.4, 2.2, 0.44, -2.0, 0.4, 0);
  kit.brokenWall(s, M.concrete, 1.4, 1.4, 0.44, 1.6, 0.4, 0.05);
  // Fallen cap slab lying on the wall line.
  kit.rect(s, M.slab, 1.4, 0.28, 0.4, 2.8, 0.34, 0, { rot: [0, 0.25, 0.12] });
  kit.rebar(s, M.rust, -0.4, 0.4, 0, 0.4, 5, 0.14);
  kit.rebar(s, M.rust, 2.2, 0.4, 0, 0.35, 4, 0.12);
  debris(c, -2.6, 0, 0.28, 4, 0.2);
  debris(c, 0.4, 0, 0.28, 5, 0.22);
  debris(c, 2.6, 0, 0.28, 4, 0.2);
  kit.rect(s, M.soot, 3.4, 0.03, 0.7, 0.4, 0.42, 0, { noShadow: true });
  for (let i = 0; i < 3; i++) {
    kit.box(s, M.sandbag, 0.6, 0.22, 0.38, -1.0 + i * 0.7, 0.45, 0.1, { rot: [0, i * 0.6, 0] });
  }
}

function ruinBunker(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 6.5 x 5.5 x 2.4 m: the sand berm fills the footprint, the cracked roof
  // slab sets the height, and everything dropped inside stays under it.
  const hw = c.w / 2;
  const hd = c.d / 2;
  kit.taperOn(s, M.dirt, 2 * hw, 1.0, 2 * hd, 0.78, 0.78, 0, 0, 0);
  kit.rectOn(s, M.concrete, 2 * hw - 0.7, 0.7, 2 * hd - 0.7, 0, 1.0, 0);
  // Cracked roof: two slabs dropped into the interior, one thrown clear onto the berm.
  slab(c, -1.2, 1.45, 0, 2.6, 0.35, 3.6, -0.35, 0.1, M.concrete);
  slab(c, 1.2, 1.3, -0.5, 2.6, 0.35, 3.6, 0.42, -0.12, M.burnt);
  slab(c, 1.6, 0.6, 1.4, 2.0, 0.3, 1.8, 0.24, 0.25);
  kit.rectOn(s, M.soot, 4.6, 0.06, 4.0, 0, 1.7, 0, { noShadow: true });
  kit.rect(s, M.dark, 3.0, 0.9, 0.5, 0, 1.6, 2.2, { rot: [0.2, 0.1, 0] });
  kit.rebar(s, M.rust, 0.4, 1.65, -1.0, 0.45, 7, 0.3);
  kit.rebar(s, M.rust, -1.6, 1.65, 1.4, 0.4, 5, 0.25);
  debris(c, 1.6, 1.0, 0.55, 6, 0.22);
  for (let i = 0; i < 4; i++) {
    kit.box(s, M.sandbag, 0.64, 0.24, 0.4, -1.5 + i * 0.9, 1.75 + (i % 2) * 0.2, 2.0 + (i % 3) * 0.2, { rot: [0, i * 0.7, 0.1] });
  }
  kit.rubble(s, M.rock, 0.55, 0, 1.5, 1.5, 6);
}

function ruinBridge(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 18 x 8 x 3.6 m. The intact deck is a timber run whose *top* is authored
  // 3.6 (`Structure.y + h`, the surface `World::bridge_deck` reports) and whose underside is
  // 2.8, so the ruin has to meet that line: the shore abutments survive up to the underside,
  // and what fell into the gap is broken deck timber rather than the concrete slab the old
  // model was authored around.
  const deckY = 2.8;
  // Abutments survive, the middle span has fallen into the gap.
  for (const sx of [-1, 1]) {
    kit.boxOn(s, M.concrete, 3.4, deckY, 7.4, sx * 7.2, 0, 0);
    kit.boxOn(s, M.concrete, 2.6, 0.5, 6.4, sx * 6.0, deckY - 0.5, 0);
    slab(c, sx * 5.2, 1.35, 0, 4.4, 0.36, 6.4, -sx * 0.5, 0.05, M.wood);
    // Sheared pile stubs at the water's edge, matching the intact model's bents.
    kit.boxOn(s, M.wood, 0.34, 1.5, 0.34, sx * 4.4, 0.2, 2.6);
    kit.boxOn(s, M.wood, 0.34, 1.2, 0.34, sx * 4.4, 0.2, -2.6);
  }
  kit.rectOn(s, M.concrete, 3.2, 0.9, 6.0, 0, 0, 0);
  for (const sx of [-1, 1]) {
    kit.rectOn(s, M.dark, 1.7, 1.3, 2.0, sx * 3.6, 0, 0);
    kit.rect(s, M.steel, 6.0, 0.12, 0.12, sx * 2.4, 2.0, 3.5, { rot: [0, 0, -sx * 0.25] });
  }
  // Rebar tufts stay low: the deck line is only 3.6 m up.
  kit.rebar(s, M.rust, -3.4, 1.0, 0, 1.8, 8, 0.4);
  kit.rebar(s, M.rust, 3.4, 1.0, 0, 1.8, 8, 0.4);
  debris(c, 1.2, 0, 0.8, 8, 0.35);
  kit.rectOn(s, M.soot, 5.0, 0.05, 2.6, -1.0, 0.9, 0.6, { noShadow: true, rot: [0, 0.3, 0] });
  kit.rect(s, M.hazard, 2.4, 0.1, 0.4, -6.4, deckY + 0.42, 3.7, { noShadow: true });
  kit.rubble(s, M.rock, 0.7, -2.0, 0.05, -1.6, 8);
  kit.cableDrum(s, M.wood, 0.5, 4.6, 0.1, 2.6, 0.3);
}

function ruinTent(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 6 x 5 x 2.6 m (`hw`/`hd` are its half extents on X / Z).
  const hw = c.w / 2;
  const hd = c.d / 2;
  kit.rectOn(s, M.wood, 2 * hw - 0.4, 0.14, 2 * hd - 0.4, 0, 0, 0);
  // Collapsed canvas: two sagging ridge halves on snapped poles.
  kit.ridgeOn(s, M.canvas, 2.6, 1.0, 3.0, 0.3, -0.8, 0.25, 0, { rot: [0, 0.1, -0.4] });
  kit.ridgeOn(s, M.soot, 2.6, 0.85, 2.8, 0.3, 0.8, 0.2, 0, { rot: [0, -0.2, 0.36] });
  kit.rectOn(s, M.soot, 5.2, 0.06, 4.2, 0, 0.16, 0, { noShadow: true });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    kit.strut(s, M.steel, [Math.cos(a) * 2.0, 0.1, Math.sin(a) * 1.7], [Math.cos(a) * 0.6, 1.1 + i * 0.1, Math.sin(a) * 0.5], 0.06);
  }
  kit.crate(s, M.wood, M.dark, 1.0, 2.0, 0.14, 1.5, 0.9);
  kit.rect(s, M.wood, 1.2, 0.14, 0.8, 1.2, 0.2, 1.4, { rot: [0.15, 0.4, 0.08] });
  for (let i = 0; i < 5; i++) {
    kit.box(s, M.sandbag, 0.6, 0.22, 0.38, -2.4 + i * 0.9, 0.2 + (i % 2) * 0.16, -2.0 + (i % 3) * 0.4, { rot: [0, i * 0.8, 0.1] });
  }
  kit.cyl(s, M.rust, 0.3, 0.3, 0.8, -2.4, 0.16, 1.6, 10, { rot: [Math.PI / 2, 0, -0.2] });
}

function ruinTurretTower(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Burnt-out ring: walls sheared off, deck collapsed, pod thrown to the ground.
  kit.cyl(s, M.concrete, 2.7, 2.8, 0.35, 0, 0, 0, 8);
  kit.brokenWall(s, M.burnt, 4.2, 4.6, 0.4, 0, 0.35, 1.6, 0);
  kit.brokenWall(s, M.concrete, 4.2, 3.4, 0.4, 0, 0.35, -1.6, 0);
  kit.brokenWall(s, M.burnt, 3.0, 2.6, 0.4, -1.6, 0.35, 0, Math.PI / 2);
  kit.brokenWall(s, M.concrete, 2.2, 1.6, 0.4, 1.6, 0.35, 0, Math.PI / 2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.boxOn(s, M.dark, 0.5, 2.0 + (sx * sz > 0 ? 1.4 : 0.4), 0.5, sx * 1.75, 0.6, sz * 1.75, {
        rot: [0, 0, sx * 0.12],
      });
    }
  }
  slab(c, -0.6, 4.2, 0.4, 4.4, 0.35, 4.4, 0.62, -0.2, M.burnt);
  slab(c, 3.2, 0.7, -2.4, 3.6, 0.3, 3.6, 0.3, 0.4, M.burnt);
  // The pod, blown off and lying on its side.
  const pod = kit.group(s, 3.6, 0.55, 2.6, 'ruin:pod');
  pod.rotation.set(0.1, 0.7, 1.35);
  kit.rect(pod, M.dark, 1.5, 1.35, 2.3, 0, 0, 0);
  kit.rect(pod, M.dark, 1.6, 0.5, 2.4, 0, 0.6, 0);
  for (let i = 0; i < 3; i++) {
    kit.cylC(pod, M.dark, 0.19, 0.19, 1.1, i === 0 ? -0.4 : 0.4, i < 2 ? 0.3 : 0.9, 0.6 + i * 0.3, 8, { rot: [Math.PI / 2, 0, 0] });
  }
  kit.rebar(s, M.rust, 0.2, 0.4, -1.0, 2.6, 8, 0.5);
  kit.rebar(s, M.rust, -1.4, 0.4, 1.8, 2.0, 6, 0.4);
  debris(c, 0.4, 0.6, 3.4, 12, 0.6);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    kit.box(s, M.sandbag, 0.64, 0.24, 0.4, Math.cos(a) * 2.6, 0.4, Math.sin(a) * 2.6, { rot: [0, a, 0.1] });
  }
  kit.rectOn(s, M.soot, 5.4, 0.05, 5.4, 0, 0.36, 0, { noShadow: true });
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, -2.6, 0.35, 2.4, 10, { rot: [Math.PI / 2, 0, 0.3] });
}

function ruinBuilding(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 13 x 9.5 x 6.5 m (`hw`/`hd` are its half extents on X / Z).
  const hw = c.w / 2;
  const hd = c.d / 2;
  kit.rectOn(s, M.concrete, 2 * hw - 0.4, 0.4, 2 * hd - 0.5, 0, 0, 0);
  // One wing still standing (with window holes), the rest is a slab pile. The wing tops out
  // below the authored 6.5 m: the measured height is top-minus-bottom, and the rubble that
  // settles into the floor sinks ~0.2 m below grade.
  kit.boxOn(s, M.concrete, 5.0, 5.4, 8.4, -(hw - 2.6), 0.4, 0);
  for (let i = 0; i < 3; i++) {
    kit.rect(s, M.dark, 1.2, 1.4, 0.3, -(hw - 2.6), 1.8 + i * 1.4, hd - 0.6, { noShadow: true });
  }
  kit.rectOn(s, M.soot, 5.2, 0.2, 8.6, -(hw - 2.6), 5.8, 0);
  kit.boxOn(s, M.concrete, 3.4, 4.2, 5.0, 0.4, 0.4, -1.0);
  kit.brokenWall(s, M.burnt, 6.4, 4.0, 0.5, hw - 3.4, 0.4, hd - 0.5, 0);
  kit.brokenWall(s, M.concrete, 4.0, 2.4, 0.5, hw - 3.5, 0.4, -(hd - 0.5), 0);
  for (let i = 0; i < 3; i++) {
    slab(c, 2.2 + i * 0.3, 1.4 + i * 0.8, 0.5 - i * 0.4, 4.6 - i * 0.5, 0.35, 4.2, c.kit.rng.range(0.2, 0.55), c.kit.rng.range(-0.2, 0.2), i === 1 ? M.burnt : M.slab);
  }
  slab(c, 0.8, 2.0, 2.4, 3.2, 0.35, 2.6, -0.5, 0.15, M.burnt);
  kit.rebar(s, M.rust, 2.0, 1.0, -1.0, 2.0, 8, 0.5);
  kit.rebar(s, M.rust, -1.0, 3.6, 2.4, 1.6, 6, 0.4);
  debris(c, 2.6, 1.2, 0.65, 10, 0.3);
  debris(c, -0.4, -2.4, 0.6, 5, 0.28);
  for (let i = 0; i < 4; i++) {
    kit.rect(s, M.burnt, 1.4, 1.6, 0.2, -(hw - 0.9), 1.6 + i * 0.9, -3.6, { rot: [0, -0.2, 0.1], noShadow: true });
  }
  for (let i = 0; i < 5; i++) {
    kit.box(s, M.sandbag, 0.62, 0.24, 0.4, 4.4 + (i % 2) * 0.4, 0.45, -3.0 + i * 0.7, { rot: [0, i * 0.6, 0.08] });
  }
  kit.rect(s, M.canvas, 3.0, 0.06, 2.4, 1.4, 0.44, 2.2, { rot: [0, 0.4, 0.12], noShadow: true });
}

function ruinCrate(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 2.2 x 2.2 x 2.0 m: a burst crate, so the slats fall just outside the
  // 1.4 m base but stay inside the footprint.
  kit.rectOn(s, M.wood, 1.4, 0.12, 1.4, 0, 0, 0);
  kit.rect(s, M.wood, 1.1, 0.1, 0.7, -0.2, 0.2, 0.1, { rot: [0.1, 0.6, 0.05] });
  kit.rect(s, M.wood, 0.9, 0.09, 0.5, 0.3, 0.28, -0.3, { rot: [-0.1, -0.4, 0.1] });
  for (let i = 0; i < 5; i++) {
    const a = c.kit.rng.range(0, Math.PI * 2);
    const d = c.kit.rng.range(0.25, 0.7);
    kit.rect(s, i % 2 ? M.wood : M.dark, 0.5, 0.07, 0.16, Math.cos(a) * d, 0.11, Math.sin(a) * d, {
      rot: [c.kit.rng.range(-0.2, 0.2), a, c.kit.rng.range(-0.3, 0.3)],
    });
  }
  kit.rect(s, M.dark, 0.5, 0.3, 0.4, -0.45, 0.3, 0.45, { rot: [0.3, 0.4, 0] });
  kit.rect(s, M.soot, 1.0, 0.03, 0.8, 0, 0.14, 0, { noShadow: true });
}

function ruinBarrel(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 1.4 x 1.4 x 1.6 m: burst drum — two shell halves, a thrown lid, soot and
  // a spill, all inside a 0.7 m radius.
  kit.cyl(s, M.rust, 0.34, 0.34, 0.45, -0.18, 0.03, 0, 12);
  kit.cylC(s, M.soot, 0.34, 0.34, 0.6, 0.1, 0.34, 0.05, 12, { rot: [0, 0.4, Math.PI / 2 - 0.3] });
  kit.cylC(s, M.dark, 0.34, 0.34, 0.06, 0.28, 0.05, -0.22, 12, { rot: [0.2, 0.5, 0.1] });
  kit.cyl(s, M.rust, 0.32, 0.32, 0.45, 0.25, 0.03, 0.22, 12, { rot: [0, 0.4, -0.2] });
  kit.rect(s, M.dark, 0.5, 0.05, 0.3, -0.2, 0.06, 0.35, { rot: [0, 0.8, 0] });
  kit.oilStain(s, 0.1, 0.1, 0.55, 0.02);
  kit.rect(s, M.soot, 1.0, 0.03, 0.9, 0.1, 0.03, 0.1, { noShadow: true });
}

function ruinSandbag(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 4 x 1.4 x 1.0 m: torn parapet — one standing stub, the rest of the bags
  // scattered *along* the wall line, which is the only axis with room.
  const hw = c.w / 2;
  kit.sandbagWall(s, M.sandbag, 1.4, 2, -0.8, 0, 0.15, 0.62, 0.24, 0.3);
  for (let i = 0; i < 9; i++) {
    const x = -1.5 + i * 0.375 + c.kit.rng.range(-0.1, 0.1);
    kit.box(s, M.sandbag, 0.6, 0.22, 0.38, x, 0.11 + c.kit.rng.range(0, 0.12), c.kit.rng.range(-0.14, 0.14), {
      rot: [c.kit.rng.range(-0.2, 0.2), c.kit.rng.range(0, 3), c.kit.rng.range(-0.2, 0.2)],
    });
  }
  kit.rectOn(s, M.dirt, 2 * hw - 0.4, 0.12, 1.1, 0, 0, 0);
  kit.rect(s, M.soot, 1.6, 0.03, 0.8, 0.6, 0.15, -0.25, { noShadow: true });
  kit.rebar(s, M.rust, -1.2, 0.1, 0, 0.6, 4, 0.2);
}

function ruinWatchtower(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Two legs snapped, the deck and cabin thrown down.
  for (const sx of [-1, 1]) {
    kit.rectOn(s, M.concrete, 0.9, 0.45, 0.9, sx * 1.6, 0, 1.6);
    kit.boxOn(s, M.dark, 0.3, 2.4 + (sx > 0 ? 1.6 : 0), 0.3, sx * 1.6, 0.45, 1.6, { rot: [0.1 * sx, 0, 0.18 * sx] });
  }
  kit.rectOn(s, M.concrete, 0.9, 0.45, 0.9, -1.6, 0, -1.6);
  kit.rectOn(s, M.concrete, 0.9, 0.45, 0.9, 1.6, 0, -1.6);
  slab(c, -0.4, 0.9, -1.0, 4.4, 0.35, 4.4, 0.9, -0.25, M.burnt);
  kit.box(s, M.soot, 2.6, 2.0, 2.6, 1.2, 1.4, 0.6, { rot: [0.3, 0.5, 1.15] });
  kit.rect(s, M.glass, 1.2, 0.8, 0.1, 0.9, 1.7, 1.2, { rot: [0.3, 0.5, 1.15], noShadow: true });
  kit.rect(s, M.steel, 3.2, 0.16, 3.2, -1.8, 0.5, 1.6, { rot: [0.15, 0.2, 0.3] });
  kit.strut(s, M.steel, [-1.6, 0.5, -1.6], [0.4, 1.6, -0.4], 0.1);
  kit.rebar(s, M.rust, 0.2, 0.35, -0.2, 2.0, 6, 0.4);
  debris(c, 2.2, -1.0, 2.6, 8, 0.5);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    kit.box(s, M.sandbag, 0.62, 0.24, 0.4, Math.cos(a) * 1.9 + 0.4, 0.3, Math.sin(a) * 1.9 - 0.6, { rot: [0, a, 0.1] });
  }
  kit.rectOn(s, M.soot, 5.0, 0.04, 5.0, 0, 0.02, 0, { noShadow: true });
  kit.cyl(s, M.rust, 0.3, 0.3, 0.9, -2.8, 0.25, 0.4, 10, { rot: [Math.PI / 2, 0, 0.4] });
}

function ruinHq(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 10 x 8.5 x 11.5 m (`hw`/`hd` are its half extents on X / Z): the ruin is
  // flattened, so the height is never the binding limit — the footprint is.
  const hw = c.w / 2;
  const hd = c.d / 2;
  kit.rectOn(s, M.concrete, 2 * hw - 0.4, 0.35, 2 * hd - 0.5, 0, 0, 0);
  // Standing façade fragment + window holes, everything else flattened.
  kit.boxOn(s, M.concrete, 5.0, 5.0, 1.8, -2.0, 0.35, -(hd - 1.05));
  for (let i = 0; i < 3; i++) {
    kit.rect(s, M.soot, 1.5, 1.8, 0.3, -3.4 + i * 1.6, 2.0 + (i % 2) * 2.6, -(hd - 1.95), { noShadow: true });
  }
  kit.boxOn(s, M.concrete, 3.6, 4.2, 4.0, 2.4, 0.35, -1.6);
  kit.brokenWall(s, M.burnt, 5.0, 4.6, 0.4, -2.2, 0.35, hd - 0.4, 0);
  kit.brokenWall(s, M.concrete, 4.0, 2.8, 0.4, 2.0, 0.35, hd - 0.4, 0);
  for (let i = 0; i < 4; i++) {
    slab(c, -0.6 + i * 1.0, 1.5 + i * 0.9, 1.2 - i * 0.7, 4.0 - i * 0.5, 0.4, 3.0, c.kit.rng.range(0.15, 0.6), c.kit.rng.range(-0.25, 0.25), i % 2 ? M.burnt : M.slab);
  }
  slab(c, 1.8, 2.2, 1.8, 3.2, 0.32, 2.4, -0.5, 0.2, M.burnt);
  // Fallen mast + bent flag pole.
  kit.strut(s, M.steel, [-3.8, 0.5, -2.6], [2.0, 5.2, 2.2], 0.12);
  kit.latticeMast(s, M.steel, 2.2, 1.0, 3.0, 0.4, 3.0, 2, 0.08);
  kit.cyl(s, M.steel, 0.06, 0.09, 3.0, 2.6, 0.35, 3.0, 8, { rot: [0.2, 0, 1.05] });
  kit.rebar(s, M.rust, -1.4, 1.4, 0.4, 1.4, 9, 0.5);
  kit.rebar(s, M.rust, 3.0, 1.2, 1.0, 1.6, 6, 0.4);
  debris(c, -0.8, 0.6, 0.65, 10, 0.3);
  debris(c, 2.4, 2.0, 0.6, 5, 0.28);
  debris(c, -2.0, -2.0, 0.6, 6, 0.28);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    kit.box(s, M.sandbag, 0.62, 0.24, 0.4, Math.cos(a) * 2.2 - 1.0, 0.4, Math.sin(a) * 2.2 + 1.0, { rot: [0, a, 0.1] });
  }
  kit.rect(s, M.canvas, 3.4, 0.08, 2.4, 1.6, 0.42, 1.6, { rot: [0, 0.5, 0.1], noShadow: true });
  kit.oilStain(s, 1.6, 1.2, 1.1, 0.02);
}

function ruinGate(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 7.4 x 1.2 x 4.2 m: a thin, tall gate wall, so everything (leaves, debris,
  // sandbags, the spill) stays within ~0.6 m of the wall plane.
  const hw = c.w / 2;
  const hd = c.d / 2;
  kit.rectOn(s, M.concrete, 2 * hw - 0.2, 0.25, 2 * hd - 0.1, 0, 0, 0);
  for (const sx of [-1, 1]) {
    kit.brokenWall(s, M.concrete, 1.0, 3.8, 0.95, sx * (hw - 0.6), 0.25, 0, 0);
    slab(c, sx * (hw - 0.9), 0.5, 0, 0.9, 0.3, 0.8, sx * 0.4, 0.15, M.burnt);
  }
  // One leaf flat on the deck, the other twisted against a pillar.
  kit.rect(s, M.steel, 2.6, 0.14, 0.7, -0.6, 0.35, 0, { rot: [0, 0.2, 0.06] });
  for (let i = 0; i < 3; i++) kit.rect(s, M.dark, 0.12, 0.12, 0.6, -1.6 + i * 0.9, 0.44, 0, { rot: [0, 0.2, 0] });
  kit.rect(s, M.steel, 1.8, 1.4, 0.14, 1.6, 1.2, 0, { rot: [0.3, 0.4, 0.4] });
  kit.hazardStripes(s, M.hazard, 2.0, 0.16, 0.1, 1.4, 0.6, 0.2, 5, 0.4);
  kit.rect(s, M.dark, 0.7, 0.3, 0.2, 2.2, 0.9, 0.35, { rot: [0, 0, 0.9] });
  kit.rebar(s, M.rust, -2.0, 0.3, 0, 0.5, 6, 0.24);
  debris(c, 1.0, 0, 0.3, 9, 0.22);
  for (let i = 0; i < 5; i++) {
    kit.box(s, M.sandbag, 0.6, 0.22, 0.38, -2.0 + i * 0.8, 0.3 + (i % 2) * 0.16, -0.25, { rot: [0, i * 0.7, 0.1] });
  }
  kit.rectOn(s, M.soot, 6.0, 0.04, 1.0, 0, 0.26, 0, { noShadow: true });
}

function ruinContainer(c: RCtx): void {
  const { kit, shell: s, M } = c;
  // Authored box 6.5 x 2.8 x 2.7 m: crumpled box — two sagging side panels, a fallen roof
  // panel, torn ribs and doors blown clear, nothing past the 2.8 m depth.
  const hw = c.w / 2;
  const hd = c.d / 2;
  kit.rect(s, M.burnt, 3.0, 2.2, 0.16, -1.5, 1.15, hd - 0.9, { rot: [0.3, 0, 0.15] });
  kit.rect(s, M.rust, 2.8, 2.0, 0.16, 1.5, 1.0, -(hd - 0.9), { rot: [-0.35, 0, -0.12] });
  kit.rect(s, M.rust, 2.4, 1.8, 0.14, -(hw - 1.35), 1.05, 0.5, { rot: [0.2, 0.55, 0.25] });
  // Fallen roof panel lying across the middle.
  kit.rect(s, M.burnt, 2.6, 2.0, 0.16, 0.2, 0.45, 0.2, { rot: [1.35, 0.3, 0.1] });
  kit.rect(s, M.soot, 2.0, 0.06, 2.0, 0, 0.06, 0, { noShadow: true });
  // Blown-off door leaves, flat on the ground.
  kit.rect(s, M.rust, 1.4, 1.6, 0.1, 2.2, 0.35, 0.4, { rot: [1.4, 0.4, 0.2] });
  for (let i = 0; i < 3; i++) {
    kit.rect(s, M.dark, 0.12, 0.9, 0.12, -2.0 + i, 1.0, hd - 0.8 + i * 0.1, { rot: [0.3, i * 0.4, 0.5] });
  }
  kit.rebar(s, M.rust, 0.6, 0.4, 0.4, 0.7, 6, 0.3);
  debris(c, -0.4, 0.3, 0.5, 6, 0.28);
  kit.rect(s, M.wood, 1.2, 0.14, 0.6, 1.0, 0.12, 0.6, { rot: [0.1, 0.6, 0.05] });
}

/* ------------------------------------------------------------ dispatch */

type RBuilder = (c: RCtx) => void;

const RUINS: Readonly<Record<number, RBuilder>> = {
  [SKIND.GARAGE]: ruinGarage,
  [SKIND.WALL]: ruinWall,
  [SKIND.BUNKER]: ruinBunker,
  [SKIND.BRIDGE]: ruinBridge,
  [SKIND.TENT]: ruinTent,
  [SKIND.TURRET_TOWER]: ruinTurretTower,
  [SKIND.BUILDING]: ruinBuilding,
  [SKIND.CRATE]: ruinCrate,
  [SKIND.BARREL]: ruinBarrel,
  [SKIND.SANDBAG]: ruinSandbag,
  [SKIND.WATCHTOWER]: ruinWatchtower,
  [SKIND.HQ]: ruinHq,
  [SKIND.GATE]: ruinGate,
  [SKIND.CONTAINER]: ruinContainer,
};

/**
 * Build the destroyed variant for `kind`, or `undefined` when the kind does not break
 * apart. The node is a sibling of the intact `root` and uses the same authoring space
 * (unit box for unit-sized kinds), so the renderer can hand it the same matrix.
 */
export function buildRuin(kind: number, lib: SurfaceLibrary, team: TeamId, seed = 1): THREE.Object3D | undefined {
  const build = RUINS[kind];
  if (!build) return undefined;
  const size = sizeOf(kind);
  const unitSized = isUnitSized(kind);
  const kit = new Kit(lib, team, 3571 + kind * 6151 + (seed >>> 0) * 2246822519, [1, 1, 1]);
  const root = new THREE.Group();
  root.name = `ruin:${kind}`;
  const shell = new THREE.Group();
  if (unitSized) shell.scale.set(1 / size[0], 1 / size[2], 1 / size[1]);
  root.add(shell);
  build({ kit, shell, M: rMats(kit, team), w: size[0], h: size[2], d: size[1] });
  // JSON-safe on purpose: `clone()` stringifies `userData`, and a texture or the surface
  // library in here would be re-encoded to a PNG data URL on every clone (see StructureMeta).
  root.userData.rf = { kind, team, seed, unitSized, ruined: true };
  return root;
}

/** Kinds with a destroyed variant (mirrors `RUINED_KINDS` in kinds.ts). */
export const RUIN_KINDS: readonly number[] = Object.keys(RUINS).map(Number);
