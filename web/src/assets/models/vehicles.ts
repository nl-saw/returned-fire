/**
 * vehicles.ts — procedural vehicle models for Returned Fire.
 *
 * Rig contract (frozen, see ../types.ts):
 *   • Metres, Y up, every vehicle faces +Z, `root` origin sits on the ground contact
 *     plane (tyres/skids/keel at y = 0).
 *   • `hull` holds the whole body, `turret` (child of root) yaws about Y, `gun` (child of
 *     turret) pitches about X with negative = up.
 *   • `muzzle`/`muzzle2` are anchored exactly at the barrel tips *and parented to the
 *     rotating part*, so the anchor sits at the barrel tip at rest (yaw 0, pitch 0) and
 *     keeps tracking after the renderer moves the turret.
 *   • Wheels/tracks spin about local X (their geometry is authored about the X axle).
 *
 * Style: sun-bleached NATO hardware — beveled volumes, proud panel lines, stowage and
 * lights; team 0 olive-drab (`camoGreen`), team 1 signal-red (`camoRed`), both tinted
 * through `lib.clone` via the shared SurfaceCache so no material is shared across teams.
 *
 * Visibility looks (`?look=N`, see ../vehicleLook.ts): the builders may attach extra
 * team-identity geometry — bold hull bands, pennants on poles, or a flat ground ring —
 * purely cosmetic; the simulation never sees it.
 */
import * as THREE from 'three';
import { Kit } from './kit';
import type { MatKey, SurfaceLibrary, TeamId, VehicleRig } from '../types';
import { TEAM_COLORS } from '../types';
import { vehicleLook } from '../vehicleLook';
import { anchor, cylAxis, group, latheArc, makeMesh, Parts, roadWheel, sphereGeo, tire, trackRun } from './vehkit';

/* --------------------------------------------------------------- materials */

interface MatSet {
  /** Team-tinted camouflage: `camoGreen` for team 0, `camoRed` for team 1. */
  camo: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  panel: THREE.MeshStandardMaterial;
  detail: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  canvas: THREE.MeshStandardMaterial;
  /** Saturated team colour for pennants/bands. */
  flag: THREE.MeshStandardMaterial;
  hazard: THREE.MeshStandardMaterial;
  /** Team-coloured painted marking (decal offset, no z-fight). */
  mark: THREE.MeshStandardMaterial;
}

const CAMO: readonly [MatKey, MatKey] = ['camoGreen', 'camoRed'];

/**
 * Materials come from the shared SurfaceCache (keyed per library + key + tint), so repeat
 * builds — every kind, both teams — reuse the same instances and never mutate the
 * library's shared materials.
 */
function materials(kit: Kit): MatSet {
  return {
    camo: kit.teamMat(CAMO[kit.team], { rough: 0.74, metal: 0.06 }),
    metal: kit.mat('vehMetal', { rough: 0.62, metal: 0.3 }),
    panel: kit.mat('metalPanel', { rough: 0.56, metal: 0.42 }),
    detail: kit.mat('vehDetail', { rough: 0.7, metal: 0.22 }),
    dark: kit.mat('metalDark', { rough: 0.46, metal: 0.6 }),
    rubber: kit.mat('rubber', { rough: 0.93, metal: 0.02 }),
    glass: kit.mat('glass', { rough: 0.07, metal: 0.45 }),
    canvas: kit.mat('canvasTent', { rough: 0.92, metal: 0.02 }),
    flag: kit.mat('vehDetail', { color: TEAM_COLORS[kit.team], rough: 0.55, metal: 0.05 }),
    hazard: kit.mat('hazard', { rough: 0.72, metal: 0.05 }),
    mark: kit.mat('vehDetail', { color: TEAM_COLORS[kit.team], decal: true }),
  };
}

/* -------------------------------------------------- visibility looks (?look=N) */

/** Look 1 — a thick team-coloured band on BOTH hull sides at once (decal-offset, no z-fight). */
function sideBands(P: Parts, M: MatSet, x: number, y: number, zc: number, len: number, h: number): void {
  for (const sx of [-1, 1]) P.rect(M.mark, 0.025, h, len, [sx * x, y, zc]);
}

/** Look 2 — a team pennant on a pole; the pole base sits at `base`, the flag hangs from the
 *  pole top and flies forward (+Z). */
function pennant(P: Parts, M: MatSet, base: readonly [number, number, number], poleH = 0.6, w = 0.5): void {
  const fh = w * 0.74; // flag height for the 1 : 0.37 : 0.74 triangle
  P.cyl(M.metal, 'y', 0.02, 0.02, poleH, [base[0], base[1] + poleH / 2, base[2]], [0, 0, 0], 5);
  P.prism(M.flag, [[0, 0], [w, w * 0.37], [0, fh]], 0.02, [base[0] + 0.01, base[1] + poleH - fh, base[2]]);
}

/** Look 3 — a flat team-coloured ring on the ground under the vehicle (unlit, so it reads as
 *  a marker at any range and in any light). Unit-radius geometry, scaled per vehicle. */
let unitRingGeo: THREE.BufferGeometry | null = null;
function unitRing(): THREE.BufferGeometry {
  if (!unitRingGeo) {
    unitRingGeo = new THREE.RingGeometry(0.82, 1, 40);
    unitRingGeo.rotateX(-Math.PI / 2);
  }
  return unitRingGeo;
}
function attachGroundRing(rig: VehicleRig, team: TeamId): void {
  // Elliptical so the ring hugs the footprint: a circle around a 14 m sub swallows its neighbours.
  //
  // Which axis is which matters, and this had them crossed. A rig is authored +Z forward (the
  // muzzle anchors sit at +Z, the wheels turn on an X axle), so `size[0]` - the hull's *length* -
  // runs along local Z and `size[1]`, its width, along local X. Scaling X by the half-length and
  // Z by the half-width therefore drew the ellipse sideways: measured with `tools/look-sheet.mjs`,
  // a 6.9 x 3.6 m tank wore a 7.6 m wide, 4.3 m long ring, and a 14 x 2.7 m submarine a 14.7 m
  // one across its beam and 3.7 m along its length - the long axis pointing at right angles to
  // the hull it is supposed to outline. The `0.9` floor is the same on both axes so a 0.9 m
  // infantry figure gets a circle rather than an oval.
  const halfWidth = Math.max(rig.size[1] * 0.5 + 0.35, 0.9); // local X: across the hull
  const halfLength = Math.max(rig.size[0] * 0.5 + 0.35, 0.9); // local Z: along the hull
  const mat = new THREE.MeshBasicMaterial({
    color: TEAM_COLORS[team],
    transparent: true,
    opacity: 0.8,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(unitRing(), mat);
  ring.name = 'teamRing'; // acquireRig skips shadow flags for this mesh
  ring.position.y = 0.02;
  ring.scale.set(halfWidth, 1, halfLength);
  ring.castShadow = false;
  ring.receiveShadow = false;
  rig.root.add(ring);
}

/* ------------------------------------------------------------------ helpers */

/** Road wheel group: treaded tyre + steel rim, axle along X, origin at the hub. */
function wheelGroup(
  name: string,
  r: number,
  width: number,
  lugs: number,
  M: MatSet,
  pos: readonly [number, number, number],
): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(pos[0], pos[1], pos[2]);
  g.add(makeMesh(tire(r, width, lugs, r * 0.1, 0.58), M.rubber, `${name}:tyre`));
  g.add(makeMesh(roadWheel(r * 0.58, width * 0.78, 10, 0.45), M.metal, `${name}:rim`));
  return g;
}

/* --------------------------------------------------------------------- jeep */

/**
 * M151 MUTT / Humvee-ish: open top, roll bar, spare wheel, jerry cans, driver, and a
 * pintle-mounted automatic grenade launcher on a pedestal between the front seats.
 */
export function buildJeep(lib: SurfaceLibrary, team: TeamId): VehicleRig {
  const kit = new Kit(lib, team, 1101);
  const M = materials(kit);
  const root = new THREE.Group();
  root.name = 'jeep';
  const hull = group(root, 'hull');
  const P = new Parts(kit);

  const R = 0.4; // tyre radius: hub sits at y = R so the tyre touches y = 0
  const HALF_TRACK = 0.85;
  const FRONT_Z = 1.34;
  const REAR_Z = -1.22;

  /* chassis + body tub */
  P.box(M.metal, 0.1, 0.14, 3.7, [-0.42, 0.5, -0.05], [0, 0, 0], 0.02);
  P.box(M.metal, 0.1, 0.14, 3.7, [0.42, 0.5, -0.05], [0, 0, 0], 0.02);
  P.rect(M.metal, 1.5, 0.07, 2.5, [0, 0.58, -0.3]);
  P.box(M.camo, 0.11, 0.6, 2.32, [-0.8, 0.9, -0.42], [0, 0, 0], 0.03);
  P.box(M.camo, 0.11, 0.6, 2.32, [0.8, 0.9, -0.42], [0, 0, 0], 0.03);
  P.box(M.camo, 1.7, 0.6, 0.11, [0, 0.9, -1.58], [0, 0, 0], 0.03);
  P.box(M.camo, 1.7, 0.36, 0.13, [0, 1.0, 0.72], [0, 0, 0], 0.03);
  P.box(M.camo, 1.62, 0.15, 1.16, [0, 0.99, 1.3], [0, 0, 0], 0.04);
  P.rect(M.camo, 0.14, 0.36, 1.16, [-0.79, 0.88, 1.3]);
  P.rect(M.camo, 0.14, 0.36, 1.16, [0.79, 0.88, 1.3]);
  P.rect(M.detail, 0.5, 0.03, 0.9, [0, 1.07, 1.3]); // hood rib
  P.rect(M.panel, 0.06, 0.06, 1.1, [-0.62, 1.07, 1.3]); // hood seams
  P.rect(M.panel, 0.06, 0.06, 1.1, [0.62, 1.07, 1.3]);

  /* front end: grille, headlights, bumper, brush guards */
  P.box(M.panel, 1.48, 0.44, 0.1, [0, 0.86, 1.92], [0, 0, 0], 0.03);
  for (let i = 0; i < 7; i++) P.rect(M.detail, 0.05, 0.32, 0.06, [-0.54 + i * 0.18, 0.86, 1.96]);
  P.box(M.panel, 1.88, 0.17, 0.13, [0, 0.56, 2.0], [0, 0, 0], 0.03);
  P.rect(M.metal, 0.2, 0.24, 0.1, [-0.78, 0.6, 2.02]);
  P.rect(M.metal, 0.2, 0.24, 0.1, [0.78, 0.6, 2.02]);
  for (const sx of [-1, 1]) {
    P.cyl(M.panel, 'z', 0.13, 0.13, 0.12, [sx * 0.52, 0.99, 1.9], [0, 0, 0], 10);
    P.disc(M.glass, 0.1, 10, [sx * 0.52, 0.99, 1.965]);
    for (const g of [-0.09, 0, 0.09]) P.rect(M.detail, 0.025, 0.28, 0.025, [sx * 0.52 + g, 0.99, 1.99]);
    P.rect(M.detail, 0.3, 0.025, 0.025, [sx * 0.52, 1.11, 1.99]);
  }
  /* fenders */
  P.box(M.camo, 0.31, 0.1, 1.08, [-0.86, 1.02, FRONT_Z], [0, 0, 0], 0.03);
  P.box(M.camo, 0.31, 0.1, 1.08, [0.86, 1.02, FRONT_Z], [0, 0, 0], 0.03);
  P.box(M.camo, 0.31, 0.1, 0.94, [-0.86, 1.02, REAR_Z], [0, 0, 0], 0.03);
  P.box(M.camo, 0.31, 0.1, 0.94, [0.86, 1.02, REAR_Z], [0, 0, 0], 0.03);
  P.rect(M.rubber, 0.3, 0.22, 0.03, [-0.86, 0.9, 1.9]);
  P.rect(M.rubber, 0.3, 0.22, 0.03, [0.86, 0.9, 1.9]);

  /* dashboard, wheel, seats, driver */
  P.box(M.detail, 1.5, 0.22, 0.16, [0, 1.1, 0.62], [0, 0, 0], 0.02);
  P.disc(M.glass, 0.07, 8, [-0.3, 1.13, 0.53], [0, Math.PI, 0]);
  P.disc(M.glass, 0.07, 8, [-0.12, 1.13, 0.53], [0, Math.PI, 0]);
  P.rect(M.metal, 0.3, 0.16, 0.14, [0.34, 1.12, 0.6]); // radio set
  P.cyl(M.detail, 'y', 0.02, 0.02, 0.36, [0.1, 0.78, 0.42], [0.4, 0, 0], 6);
  P.cyl(M.detail, 'z', 0.15, 0.15, 0.035, [-0.42, 1.06, 0.34], [-0.55, 0, 0], 12);
  P.cyl(M.detail, 'z', 0.03, 0.03, 0.22, [-0.42, 0.98, 0.46], [-0.55, 0, 0], 6);
  for (const sx of [-1, 1]) {
    P.box(M.canvas, 0.54, 0.12, 0.5, [sx * 0.42, 0.8, -0.3], [0, 0, 0], 0.03);
    P.box(M.canvas, 0.54, 0.54, 0.13, [sx * 0.42, 1.06, -0.56], [0.12, 0, 0], 0.03);
  }
  /* driver figure (seated, left-hand drive) */
  P.box(M.camo, 0.36, 0.24, 0.34, [-0.42, 0.84, -0.28], [0, 0, 0], 0.03);
  P.box(M.camo, 0.4, 0.5, 0.28, [-0.42, 1.26, -0.34], [0, 0, 0], 0.03); // torso
  P.rect(M.detail, 0.44, 0.34, 0.32, [-0.42, 1.26, -0.34]); // webbing
  P.rect(M.detail, 0.46, 0.1, 0.32, [-0.42, 1.08, -0.34]);
  for (const sx of [-1, 1]) {
    P.rect(M.camo, 0.11, 0.11, 0.62, [-0.42 + sx * 0.2, 1.24, 0.0], [0.55, 0, sx * 0.12]);
    P.rect(M.camo, 0.15, 0.16, 0.52, [-0.42 + sx * 0.13, 0.78, 0.02], [0.12, 0, 0]);
    P.rect(M.camo, 0.15, 0.44, 0.16, [-0.42 + sx * 0.13, 0.56, 0.26], [-0.2, 0, 0]);
    P.rect(M.detail, 0.17, 0.1, 0.28, [-0.42 + sx * 0.13, 0.36, 0.34]); // boots
  }
  P.sphere(M.camo, 0.1, [-0.42, 1.6, -0.32], 8, 5);
  P.add(sphereGeo(0.15, 8, 4), M.camo, [-0.42, 1.63, -0.33], [0, 0, 0], [1, 0.78, 1.05]);
  P.rect(M.dark, 0.2, 0.03, 0.11, [-0.42, 1.59, -0.22]); // helmet brim

  /* windshield (tilted frame + glass) */
  const th = -0.36;
  const tilt = (dy: number, dz: number): [number, number, number] => [
    0,
    1.44 + dy * Math.cos(th) - dz * Math.sin(th),
    0.64 + dy * Math.sin(th) + dz * Math.cos(th),
  ];
  P.rect(M.glass, 1.4, 0.4, 0.035, [0, 1.44, 0.64], [th, 0, 0]);
  P.rect(M.detail, 1.56, 0.07, 0.07, tilt(0.235, 0), [th, 0, 0]);
  P.rect(M.detail, 1.56, 0.07, 0.07, tilt(-0.235, 0), [th, 0, 0]);
  P.rect(M.detail, 0.07, 0.5, 0.07, [-0.765, 1.44, 0.64], [th, 0, 0]);
  P.rect(M.detail, 0.07, 0.5, 0.07, [0.765, 1.44, 0.64], [th, 0, 0]);
  P.rect(M.detail, 0.06, 0.44, 0.07, tilt(0, 0), [th, 0, 0]);

  /* roll bar + brace */
  P.tube(M.metal, [
    [-0.78, 1.05, -0.66],
    [-0.78, 1.6, -0.66],
    [-0.74, 1.79, -0.66],
    [0, 1.83, -0.66],
    [0.74, 1.79, -0.66],
    [0.78, 1.6, -0.66],
    [0.78, 1.05, -0.66],
  ], 0.045, 6, 14);
  P.tube(M.metal, [[0, 1.78, -0.7], [0, 1.5, -1.15], [0, 1.16, -1.5]], 0.035, 5, 8);

  /* stowage: jerry cans, spare wheel, tools, mirrors, exhaust */
  for (const sx of [-1, 1]) {
    P.box(M.detail, 0.2, 0.46, 0.32, [sx * 0.66, 0.98, -1.34], [0, 0, 0], 0.02);
    P.rect(M.metal, 0.04, 0.5, 0.06, [sx * 0.66, 0.98, -1.18]);
    P.rect(M.metal, 0.22, 0.04, 0.34, [sx * 0.66, 1.22, -1.34]);
  }
  P.add(tire(R, 0.26, 8, 0.04, 0.58), M.rubber, [0, 1.0, -1.74], [0, Math.PI / 2, 0]);
  P.add(roadWheel(R * 0.58, 0.22, 10, 0.45), M.metal, [0, 1.0, -1.74], [0, Math.PI / 2, 0]);
  P.rect(M.metal, 0.5, 0.5, 0.07, [0, 1.0, -1.66]);
  P.rect(M.metal, 0.9, 0.05, 0.07, [-0.5, 0.86, -1.62], [0, 0, 0.2]); // shovel
  P.rect(M.detail, 0.16, 0.26, 0.04, [-0.5, 0.76, -1.6]);
  P.cyl(M.dark, 'z', 0.05, 0.05, 0.52, [0.56, 0.42, -1.36], [0, 0, 0], 8); // exhaust
  P.disc(M.dark, 0.05, 8, [0.56, 0.42, -1.62], [Math.PI, 0, 0]);
  for (const sx of [-1, 1]) {
    P.tube(M.detail, [[sx * 0.84, 1.32, 0.5], [sx * 1.0, 1.34, 0.52]], 0.02, 5, 5);
    P.rect(M.metal, 0.05, 0.16, 0.1, [sx * 1.02, 1.34, 0.52]);
  }
  P.cyl(M.dark, 'y', 0.014, 0.014, 0.66, [0.7, 1.5, -1.46], [0.34, 0, 0], 6); // antenna
  P.cyl(M.dark, 'y', 0.01, 0.01, 0.5, [-0.7, 1.44, -1.5], [0.3, 0.2, 0], 6);

  /* team pennant + markings */
  P.cyl(M.metal, 'y', 0.018, 0.018, 0.8, [-0.88, 1.48, -1.62], [0, 0, 0], 6);
  P.prism(M.flag, [[0, 0], [0.3, 0.11], [0, 0.22]], 0.014, [-0.88, 1.62, -1.6]);
  P.rect(M.mark, 0.34, 0.02, 0.34, [-0.5, 1.07, 1.06]);
  P.rect(M.mark, 0.3, 0.2, 0.02, [0.62, 0.95, -1.63]);

  /* Weapon pedestal — the *static* half of the mount, bolted to the floor pan on the hull
     centreline between the front seats (where an M151's pedestal socket lives). Its base is
     0.28 m across so it clears both seat cushions; the tub rises past the driver's legs and
     the seat backs to the traversing bearing at the top, which the yawing `turret` group
     sits on. The weapon itself (turret -> gun -> muzzle) is built after the wheels. */
  P.rect(M.detail, 0.28, 0.05, 0.28, [0, 0.615, 0]); // floor plate
  P.cyl(M.metal, 'y', 0.075, 0.095, 0.6, [0, 0.94, 0], [0, 0, 0], 10); // pedestal tub
  P.rect(M.detail, 0.1, 0.16, 0.1, [0.1, 0.72, 0.1], [0, 0, 0.3]); // elevating crank
  P.cyl(M.detail, 'y', 0.13, 0.14, 0.07, [0, 1.275, 0], [0, 0, 0], 12); // bearing collar

  P.build(hull, 'jeep');

  /* wheels — the four road wheels the rig contract asks for */
  const wheels: THREE.Object3D[] = [];
  const at: [number, number, number][] = [
    [-HALF_TRACK, R, FRONT_Z],
    [HALF_TRACK, R, FRONT_Z],
    [-HALF_TRACK, R, REAR_Z],
    [HALF_TRACK, R, REAR_Z],
  ];
  at.forEach((p, i) => {
    const w = wheelGroup(`wheel${i}`, R, 0.28, 8, M, p);
    hull.add(w);
    wheels.push(w);
  });

  /* Pintle-mounted automatic grenade launcher (Mk 19 pattern) — the sim's jeep weapon is a
     lobbed Mk2, so a low-velocity automatic launcher suits it better than a machine gun.
     `turret` yaws about the hull centre on the pedestal bearing (which is also the axis the
     simulation rotates the muzzle point about, so the barrel tip and `combat::muzzle_pos`
     agree at every traversed angle); `gun` elevates about the trunnion. The trunnion sits at
     y = 1.77 so the barrel rides just over the windshield header (top 1.705) and stays clear
     of the driver, the roll bar, the spare wheel and the jerry cans. */
  const RING_Y = 1.31; // top of the pedestal bearing collar
  const TRUNNION_Y = 0.46; // gun pivot, turret-local (hull y = 1.77)
  const BARREL_TIP = 1.1; // gun-local z of the muzzle: hull z = 1.10, over the hood

  const turret = group(root, 'turret', [0, RING_Y, 0]);
  const T = new Parts(kit);
  T.cyl(M.metal, 'y', 0.115, 0.125, 0.07, [0, 0.035, 0], [0, 0, 0], 12); // traversing ring
  T.rect(M.detail, 0.16, 0.32, 0.15, [0, 0.21, 0.01]); // pintle post (ring -> trunnion)
  T.rect(M.metal, 0.035, 0.19, 0.2, [-0.16, TRUNNION_Y, 0.0], [0, 0, 0]); // trunnion cheek
  T.rect(M.metal, 0.035, 0.19, 0.2, [0.16, TRUNNION_Y, 0.0], [0, 0, 0]);
  T.cyl(M.dark, 'x', 0.028, 0.028, 0.37, [0, TRUNNION_Y, 0.0], [0, 0, 0], 8); // trunnion pin
  T.rect(M.dark, 0.16, 0.05, 0.05, [-0.14, 0.3, 0.04]); // traversing handle
  T.build(turret, 'pintle');

  const gun = group(turret, 'gun', [0, TRUNNION_Y, 0]);
  const G = new Parts(kit);
  /* receiver, feed and ammunition box (the box is on the gunner's side, so it cannot clip
     the driver's helmet at x = -0.42) */
  G.box(M.camo, 0.3, 0.24, 0.52, [0, -0.03, -0.18], [0, 0, 0], 0.03);
  G.rect(M.panel, 0.32, 0.045, 0.56, [0, 0.095, -0.18]); // top cover
  G.rect(M.dark, 0.09, 0.035, 0.5, [0, 0.125, -0.18]); // sight rail down the top cover
  G.rect(M.dark, 0.05, 0.09, 0.05, [0, 0.12, 0.05]); // front sight post
  G.rect(M.dark, 0.2, 0.11, 0.1, [0, -0.01, -0.47]); // rear buffer
  G.rect(M.detail, 0.07, 0.13, 0.09, [0, 0.1, -0.5]); // rear sight
  G.rect(M.detail, 0.2, 0.14, 0.24, [0.23, -0.01, -0.16]); // feed tray
  G.box(M.detail, 0.18, 0.22, 0.32, [0.29, -0.03, -0.18], [0, 0, 0], 0.03); // ammo box
  G.rect(M.metal, 0.04, 0.2, 0.28, [0.19, -0.02, -0.18]); // box bracket
  G.rect(M.detail, 0.05, 0.06, 0.2, [-0.17, -0.02, -0.12]); // charging handle
  /* barrel: perforated jacket, then the tube, muzzle drum and a top rib so the barrel still
     reads as a gun from the tilted top-down camera */
  G.cyl(M.dark, 'z', 0.055, 0.06, 0.28, [0, 0, 0.2], [0, 0, 0], 10);
  for (let i = 0; i < 3; i++) G.cyl(M.metal, 'z', 0.062, 0.062, 0.024, [0, 0, 0.13 + i * 0.09], [0, 0, 0], 10);
  G.cyl(M.metal, 'z', 0.038, 0.045, 0.66, [0, 0, 0.67], [0, 0, 0], 10);
  G.cyl(M.dark, 'z', 0.052, 0.052, 0.12, [0, 0, 1.04], [0, 0, 0], 10); // muzzle drum
  G.rect(M.dark, 0.05, 0.03, 0.5, [0, 0.048, 0.68]); // top rib
  G.build(gun, 'launcher');
  const muzzle = anchor(gun, 'muzzle', [0, 0, BARREL_TIP]);

  /* visibility looks */
  const LK = vehicleLook();
  if (LK === 1) {
    const L = new Parts(kit);
    sideBands(L, M, 0.865, 0.92, -0.35, 1.9, 0.34);
    L.build(hull, 'band');
  } else if (LK === 2) {
    const L = new Parts(kit);
    pennant(L, M, [-0.88, 1.79, -1.6], 0.7, 0.5); // on the rear roll bar
    L.build(hull, 'pennant');
  }

  return { root, hull, turret, gun, wheels, muzzle, size: [4.1, 2.0, 1.9], centerY: 0.95 };
}

/* --------------------------------------------------------------------- tank */

/** M60 Patton: 105 mm gun, cast turret, skirts, baskets, cables, smoke launchers. */
export function buildTank(lib: SurfaceLibrary, team: TeamId): VehicleRig {
  const kit = new Kit(lib, team, 2202);
  const M = materials(kit);
  const root = new THREE.Group();
  root.name = 'tank';
  const hull = group(root, 'hull');
  const P = new Parts(kit);

  const RING_Y = 1.38;
  const RING_Z = 0.05;
  const TRUNNION: [number, number, number] = [0, 0.62, 1.3]; // turret-local
  const BARREL_TIP = 2.2; // gun-local z

  /* tracks */
  for (const sx of [-1, 1]) {
    P.add(trackRun(5.3, 0.62, 0.8, 0.4, 0.1, 18), M.rubber, [sx * 1.42, 0, -0.1]);
    P.box(M.metal, 0.09, 0.22, 4.9, [sx * 1.72, 0.44, -0.1], [0, 0, 0], 0.02); // track frame
  }

  /* hull: lower sponson + sloped glacis as one extruded side profile */
  P.prism(
    M.camo,
    [
      [-2.75, 0.4],
      [2.3, 0.4],
      [2.62, 0.72],
      [2.0, 1.3],
      [-2.55, 1.3],
      [-2.8, 1.02],
    ],
    2.62,
    [0, 0, 0],
    0.04,
  );
  P.rect(M.panel, 2.4, 0.05, 1.5, [0, 1.32, -1.6]); // engine deck plate
  for (const sx of [-1, 1]) {
    P.rect(M.dark, 0.86, 0.05, 1.0, [sx * 0.62, 1.33, -1.62]);
    for (let i = 0; i < 4; i++) P.rect(M.panel, 0.8, 0.03, 0.07, [sx * 0.62, 1.36, -1.94 + i * 0.22]);
  }
  P.cyl(M.panel, 'y', 0.3, 0.3, 0.07, [-0.62, 1.3, 1.05], [0, 0, 0], 10); // driver hatch
  P.rect(M.detail, 0.16, 0.08, 0.2, [-0.62, 1.34, 1.2]);
  P.rect(M.detail, 0.1, 0.1, 0.1, [-0.3, 1.36, 1.5]); // periscopes
  P.rect(M.detail, 0.1, 0.1, 0.1, [-0.05, 1.36, 1.52]);
  P.rect(M.hazard, 0.5, 0.02, 0.5, [0.55, 1.325, 1.5]); // air-craft marking plate

  /* skirts, fenders, lights */
  for (const sx of [-1, 1]) {
    P.rect(M.panel, 0.07, 0.54, 4.9, [sx * 1.78, 0.86, -0.1]);
    for (let i = 0; i < 4; i++) P.rect(M.detail, 0.09, 0.56, 0.08, [sx * 1.76, 0.86, -2.1 + i * 1.35]);
    P.rect(M.panel, 0.5, 0.07, 0.9, [sx * 1.42, 0.86, 2.1]); // front fender
    P.rect(M.panel, 0.5, 0.07, 0.7, [sx * 1.42, 0.86, -2.3]);
    P.rect(M.rubber, 0.46, 0.3, 0.05, [sx * 1.42, 0.68, 2.5]);
    P.cyl(M.panel, 'z', 0.12, 0.12, 0.12, [sx * 0.92, 1.1, 2.35], [0, 0, 0], 10);
    P.disc(M.glass, 0.1, 10, [sx * 0.92, 1.1, 2.42]);
    for (const g of [-0.08, 0, 0.08]) P.rect(M.detail, 0.025, 0.26, 0.025, [sx * 0.92 + g, 1.1, 2.44]);
    P.rect(M.dark, 0.16, 0.12, 0.06, [sx * 1.05, 0.62, -2.72]); // tail lights
  }

  /* stowage basket, tow cables, tools */
  for (const sx of [-1, 1]) {
    P.rect(M.detail, 0.05, 0.42, 0.05, [sx * 1.05, 1.22, -2.68]);
    P.rect(M.detail, 0.05, 0.42, 0.05, [sx * 1.05, 1.22, -3.16]);
  }
  P.rect(M.detail, 2.16, 0.05, 0.05, [0, 1.44, -2.68]);
  P.rect(M.detail, 2.16, 0.05, 0.05, [0, 1.44, -3.16]);
  P.rect(M.panel, 2.1, 0.04, 0.5, [0, 1.24, -2.92]);
  P.rect(M.canvas, 0.5, 0.36, 0.9, [-0.6, 1.5, -2.92]);
  P.rect(M.canvas, 0.5, 0.36, 0.9, [0.6, 1.5, -2.92]);
  P.tube(M.dark, [
    [1.3, 1.34, 1.7],
    [1.44, 1.3, 0.4],
    [1.44, 1.28, -1.3],
    [1.28, 1.34, -2.5],
  ], 0.05, 5, 10);
  P.tube(M.dark, [
    [-1.3, 1.34, 1.7],
    [-1.44, 1.3, 0.4],
    [-1.44, 1.28, -1.3],
    [-1.28, 1.34, -2.5],
  ], 0.05, 5, 10);
  for (const sx of [-1, 1]) {
    P.rect(M.metal, 0.06, 0.1, 1.0, [sx * 1.34, 1.36, 0.9]); // pioneer tools
    P.rect(M.detail, 0.16, 0.16, 0.16, [sx * 1.34, 1.4, 1.35]);
  }

  P.build(hull, 'tank');

  /* running gear: 6 road wheels + idler + sprocket per side */
  const wheels: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const w = wheelGroup(`road${sx > 0 ? 'R' : 'L'}${i}`, 0.36, 0.3, 6, M, [sx * 1.42, 0.36, -1.95 + i * 0.74]);
      hull.add(w);
      wheels.push(w);
    }
    const idler = wheelGroup(`idler${sx > 0 ? 'R' : 'L'}`, 0.26, 0.26, 6, M, [sx * 1.42, 0.26, 2.3]);
    const sprocket = wheelGroup(`sprocket${sx > 0 ? 'R' : 'L'}`, 0.28, 0.28, 6, M, [sx * 1.42, 0.28, -2.42]);
    hull.add(idler, sprocket);
    wheels.push(idler, sprocket);
    /* sprocket teeth + return rollers */
    const TT = new Parts(kit);
    for (let i = 0; i < 8; i++) {
      // teeth sit inside the band radius so nothing pokes through the ground plane
      const a = (i / 8) * Math.PI * 2;
      TT.rect(M.metal, 0.1, 0.08, 0.08, [sx * 1.42, 0.28 + Math.cos(a) * 0.21, -2.42 + Math.sin(a) * 0.21], [a, 0, 0]);
    }
    TT.cyl(M.metal, 'x', 0.1, 0.1, 0.5, [sx * 1.42, 0.72, -1.2], [0, 0, 0], 8);
    TT.cyl(M.metal, 'x', 0.1, 0.1, 0.5, [sx * 1.42, 0.72, 0.55], [0, 0, 0], 8);
    TT.build(hull, 'runningGear');
  }

  /* turret race: fills the gap between deck and turret ring at any yaw */
  P.cyl(M.metal, 'y', 1.15, 1.2, 0.16, [0, RING_Y - 0.06, RING_Z], [0, 0, 0], 12);

  /* turret: cast frustum + mantlet, cupola, hatches, smoke, basket */
  const turret = group(root, 'turret', [0, RING_Y, RING_Z]);
  const T = new Parts(kit);
  T.frustum(M.camo, 2.5, 3.0, 1.95, 2.3, 0.8, [0, 0, -0.15], [0, 0, 0], -0.15);
  T.rect(M.panel, 1.2, 0.05, 1.4, [0, 0.81, -0.35]); // roof plate
  T.cyl(M.camo, 'z', 0.42, 0.44, 0.62, [0, 0.62, 1.3], [0, 0, 0], 10); // mantlet
  T.rect(M.detail, 0.7, 0.3, 0.1, [0, 0.62, 1.6]);
  T.cyl(M.camo, 'y', 0.4, 0.42, 0.3, [0.42, 0.8, -0.3], [0, 0, 0], 10); // cupola
  T.cyl(M.panel, 'y', 0.36, 0.36, 0.06, [0.42, 1.1, -0.3], [0.05, 0, 0.06], 10); // hatch ajar
  T.rect(M.detail, 0.1, 0.08, 0.1, [0.42, 1.02, -0.66]);
  T.rect(M.detail, 0.2, 0.12, 0.12, [0.62, 1.06, -0.12]); // periscope
  T.rect(M.detail, 0.2, 0.12, 0.12, [0.22, 1.06, -0.06]);
  T.cyl(M.camo, 'y', 0.3, 0.3, 0.07, [-0.45, 0.8, -0.1], [0, 0, 0], 10); // loader hatch
  T.rect(M.detail, 0.12, 0.06, 0.14, [-0.45, 0.84, 0.12]);
  T.rect(M.detail, 0.16, 0.1, 0.16, [-0.2, 0.84, 0.5]);
  /* cupola machine gun */
  T.rect(M.detail, 0.16, 0.2, 0.24, [0.42, 1.24, -0.5]);
  T.rect(M.metal, 0.1, 0.12, 0.5, [0.42, 1.3, -0.72]);
  T.cyl(M.dark, 'z', 0.028, 0.028, 0.8, [0.42, 1.32, -0.35], [0, 0, 0], 6);
  T.rect(M.dark, 0.16, 0.14, 0.2, [0.42, 1.26, -0.95]);
  /* smoke grenade launchers */
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      T.cyl(M.dark, 'z', 0.055, 0.055, 0.26, [sx * 0.92, 0.4, 0.5 + i * 0.17], [-0.32, 0, 0], 6);
    }
    T.rect(M.metal, 0.22, 0.16, 0.5, [sx * 0.88, 0.32, 0.62]);
  }
  /* bustle basket + antenna + team band */
  T.rect(M.detail, 2.1, 0.05, 0.05, [0, 0.5, -1.62]);
  T.rect(M.detail, 2.1, 0.05, 0.05, [0, 0.5, -2.05]);
  for (const sx of [-1, 1]) {
    T.rect(M.detail, 0.05, 0.5, 0.05, [sx * 1.02, 0.26, -1.62]);
    T.rect(M.detail, 0.05, 0.5, 0.05, [sx * 1.02, 0.26, -2.05]);
  }
  T.rect(M.canvas, 1.6, 0.3, 0.4, [0, 0.62, -1.85]);
  T.cyl(M.dark, 'y', 0.012, 0.02, 0.95, [-0.8, 0.8, -1.3], [0.3, 0, 0], 6);
  T.rect(M.mark, 0.6, 0.02, 0.6, [0, 0.83, -0.9]);
  T.rect(M.mark, 0.02, 0.22, 0.6, [1.2, 0.4, 0.4]);
  T.build(turret, 'turret');

  /* main gun: pitches about X at the trunnion */
  const gun = group(turret, 'gun', TRUNNION);
  const G = new Parts(kit);
  G.cyl(M.metal, 'z', 0.15, 0.15, 0.9, [0, 0, 0.35], [0, 0, 0], 12);
  G.cyl(M.canvas, 'z', 0.135, 0.14, 0.8, [0, 0, 1.15], [0, 0, 0], 12); // thermal sleeve
  G.cyl(M.dark, 'z', 0.08, 0.1, 0.55, [0, 0, 1.72], [0, 0, 0], 12);
  G.cyl(M.dark, 'z', 0.12, 0.12, 0.3, [0, 0, 2.05], [0, 0, 0], 12); // muzzle brake
  G.rect(M.dark, 0.26, 0.1, 0.12, [0, 0.02, 2.05]);
  G.rect(M.metal, 0.1, 0.1, 0.34, [0, -0.14, 0.5]); // recoil cylinder
  G.build(gun, 'gun');
  const muzzle = anchor(gun, 'muzzle', [0, 0, BARREL_TIP]);

  /* visibility looks */
  const LK = vehicleLook();
  if (LK === 1) {
    const L = new Parts(kit);
    sideBands(L, M, 1.32, 0.95, -0.3, 4.4, 0.42); // hull sides (face at ±1.31)
    L.build(hull, 'band');
  } else if (LK === 2) {
    const L = new Parts(kit);
    pennant(L, M, [0.7, 1.36, -2.9], 0.7, 0.5); // engine deck, clear of the turret's sweep
    L.build(hull, 'pennant');
  }

  return { root, hull, turret, gun, wheels, muzzle, size: [6.9, 3.6, 2.9], centerY: 1.45 };
}

/* ---------------------------------------------------------------- HRSV/MLRS */

/** M270 MLRS: armoured cab, elevating 12-cell pod, rear spade, tracks. */
export function buildHrsv(lib: SurfaceLibrary, team: TeamId): VehicleRig {
  const kit = new Kit(lib, team, 3303);
  const M = materials(kit);
  const root = new THREE.Group();
  root.name = 'hrsv';
  const hull = group(root, 'hull');
  const P = new Parts(kit);

  const POD_Y = 1.42; // turntable base
  const POD_Z = -1.35;

  for (const sx of [-1, 1]) {
    P.add(trackRun(5.9, 0.6, 0.74, 0.34, 0.1, 20), M.rubber, [sx * 1.22, 0, -0.05]);
    P.box(M.metal, 0.08, 0.2, 5.5, [sx * 1.48, 0.42, -0.05], [0, 0, 0], 0.02);
  }

  /* hull: boxy chassis with a sloped nose */
  P.prism(
    M.camo,
    [
      [-3.35, 0.38],
      [2.95, 0.38],
      [3.3, 0.75],
      [3.05, 1.35],
      [-3.35, 1.35],
    ],
    2.52,
    [0, 0, 0],
    0.04,
  );
  P.rect(M.panel, 2.3, 0.06, 1.7, [0, 1.38, 0.6]); // engine deck
  for (let i = 0; i < 4; i++) {
    P.rect(M.dark, 0.9, 0.05, 0.06, [-0.6, 1.4, 0.15 + i * 0.22]);
    P.rect(M.dark, 0.9, 0.05, 0.06, [0.6, 1.4, 0.15 + i * 0.22]);
  }
  for (const sx of [-1, 1]) {
    P.cyl(M.dark, 'y', 0.1, 0.11, 0.42, [sx * 1.05, 1.35, 1.35], [0, 0, 0], 8); // exhaust stacks
    P.rect(M.metal, 0.42, 0.4, 0.9, [sx * 1.05, 1.05, -0.1]); // stowage boxes
    P.rect(M.panel, 0.5, 0.07, 1.0, [sx * 1.22, 0.8, 2.2]);
    P.rect(M.rubber, 0.46, 0.28, 0.05, [sx * 1.22, 0.62, 2.6]);
    P.cyl(M.panel, 'z', 0.13, 0.13, 0.12, [sx * 0.95, 1.05, 3.32], [0, 0, 0], 10);
    P.disc(M.glass, 0.11, 10, [sx * 0.95, 1.05, 3.39]);
  }

  /* armoured cab with glazing */
  P.frustum(M.camo, 2.5, 1.85, 2.4, 1.6, 1.45, [0, 1.3, 2.45], [0, 0, 0], -0.06);
  P.rect(M.panel, 2.44, 0.09, 1.62, [0, 2.77, 2.42]);
  P.cyl(M.camo, 'y', 0.3, 0.3, 0.1, [-0.55, 2.78, 2.4], [0, 0, 0], 10);
  P.rect(M.detail, 0.22, 0.1, 0.24, [-0.55, 2.84, 2.6]);
  P.rect(M.detail, 0.3, 0.12, 0.16, [0.5, 2.84, 2.7]);
  P.rect(M.glass, 1.05, 0.68, 0.05, [-0.62, 2.32, 3.3], [-0.2, 0, 0]);
  P.rect(M.glass, 1.05, 0.68, 0.05, [0.62, 2.32, 3.3], [-0.2, 0, 0]);
  P.rect(M.detail, 0.1, 0.7, 0.08, [0, 2.32, 3.32], [-0.2, 0, 0]);
  for (const sx of [-1, 1]) {
    P.rect(M.glass, 0.05, 0.6, 0.95, [sx * 1.21, 2.3, 2.35]);
    P.rect(M.detail, 0.05, 0.68, 1.05, [sx * 1.24, 2.3, 2.35]);
    P.rect(M.mark, 0.03, 0.5, 0.7, [sx * 1.25, 1.85, 2.35]);
    P.rect(M.detail, 0.05, 0.12, 0.3, [sx * 1.28, 1.95, 2.0]);
  }
  P.box(M.panel, 2.68, 0.34, 0.2, [0, 0.98, 3.42], [0, 0, 0], 0.04);
  P.rect(M.metal, 0.5, 0.18, 0.06, [-0.7, 1.05, 3.5]);
  P.rect(M.metal, 0.5, 0.18, 0.06, [0.7, 1.05, 3.5]);
  for (const sx of [-1, 1]) {
    P.tube(M.detail, [[sx * 1.24, 2.6, 3.0], [sx * 1.5, 2.62, 3.05]], 0.022, 5, 5);
    P.rect(M.metal, 0.05, 0.2, 0.12, [sx * 1.52, 2.62, 3.05]);
  }

  /* rear spade + mine dispenser + lights */
  P.rect(M.panel, 2.4, 0.95, 0.14, [0, 0.48, -3.5], [0.26, 0, 0]);
  for (const sx of [-1, 1]) P.cyl(M.metal, 'y', 0.07, 0.07, 0.6, [sx * 0.7, 1.0, -3.3], [0.3, 0, 0], 6);
  P.rect(M.camo, 1.1, 0.4, 0.5, [0, 1.05, -3.5]);
  P.rect(M.detail, 0.24, 0.2, 0.1, [-0.95, 0.75, -3.42]);
  P.rect(M.detail, 0.24, 0.2, 0.1, [0.95, 0.75, -3.42]);
  P.cyl(M.dark, 'y', 0.012, 0.02, 0.9, [-1.1, 1.4, -3.0], [-0.25, 0, 0], 6);
  P.cyl(M.dark, 'y', 0.012, 0.02, 0.8, [1.1, 1.4, -3.0], [-0.25, 0, 0], 6);

  P.build(hull, 'hrsv');

  /* running gear: 5 road wheels + idler + sprocket per side */
  const wheels: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const w = wheelGroup(`road${sx > 0 ? 'R' : 'L'}${i}`, 0.33, 0.28, 6, M, [sx * 1.22, 0.33, 1.95 - i * 0.95]);
      hull.add(w);
      wheels.push(w);
    }
    const idler = wheelGroup(`idler${sx > 0 ? 'R' : 'L'}`, 0.24, 0.24, 6, M, [sx * 1.22, 0.24, 2.72]);
    const sprocket = wheelGroup(`sprocket${sx > 0 ? 'R' : 'L'}`, 0.26, 0.26, 6, M, [sx * 1.22, 0.26, -2.82]);
    hull.add(idler, sprocket);
    wheels.push(idler, sprocket);
    P.cyl(M.metal, 'x', 0.09, 0.09, 0.44, [sx * 1.22, 0.66, 0.5], [0, 0, 0], 8);
    P.cyl(M.metal, 'x', 0.09, 0.09, 0.44, [sx * 1.22, 0.66, -1.4], [0, 0, 0], 8);
  }

  /* launcher: turntable -> elevating pod with two 6-cell clusters */
  const turret = group(root, 'turret', [0, POD_Y, POD_Z]);
  const T = new Parts(kit);
  T.cyl(M.metal, 'y', 0.95, 1.05, 0.24, [0, -0.12, 0], [0, 0, 0], 12);
  T.rect(M.panel, 0.2, 0.5, 0.22, [-0.8, 0.25, 0]);
  T.rect(M.panel, 0.2, 0.5, 0.22, [0.8, 0.25, 0]);
  T.rect(M.detail, 0.5, 0.16, 0.7, [0, 0.42, 0.1]);
  T.build(turret, 'turretBase');

  const gun = group(turret, 'gun', [0, 0.45, 0]);
  const G = new Parts(kit);
  const HUB: [number, number, number] = [0, 0.5, -0.05];
  G.box(M.camo, 2.95, 1.0, 2.45, HUB, [0, 0, 0], 0.05);
  G.rect(M.panel, 3.0, 0.06, 2.5, [HUB[0], HUB[1] + 0.52, HUB[2]]);
  G.rect(M.panel, 3.0, 0.06, 2.5, [HUB[0], HUB[1] - 0.52, HUB[2]]);
  G.rect(M.hazard, 2.98, 0.16, 0.3, [HUB[0], HUB[1] + 0.4, -1.2]);
  for (const cx of [-1, 1]) {
    for (const dx of [-0.36, 0, 0.36]) {
      for (const dy of [-0.19, 0.19]) {
        const p: [number, number, number] = [cx * 0.72 + dx, HUB[1] + dy, HUB[2]];
        G.cyl(M.dark, 'z', 0.155, 0.155, 2.6, p, [0, 0, 0], 8, false);
        G.disc(M.dark, 0.13, 8, [p[0], p[1], p[2] + 1.26]);
      }
    }
    G.rect(M.metal, 0.1, 0.9, 2.5, [cx * 1.1, HUB[1], HUB[2]]); // side rails
  }
  G.rect(M.metal, 2.95, 0.1, 0.14, [0, HUB[1] + 0.5, 1.16]);
  G.rect(M.metal, 2.95, 0.1, 0.14, [0, HUB[1] - 0.5, 1.16]);
  G.build(gun, 'pod');

  const muzzle = anchor(gun, 'muzzle', [-0.72, HUB[1], HUB[2] + 1.3]);
  const muzzle2 = anchor(gun, 'muzzle2', [0.72, HUB[1], HUB[2] + 1.3]);
  gun.rotation.x = -0.13; // parked elevation: the pod visibly points up-forward

  /* visibility looks */
  const LK = vehicleLook();
  if (LK === 1) {
    const L = new Parts(kit);
    sideBands(L, M, 1.27, 0.95, 0, 5.4, 0.45); // hull sides (face at ±1.26)
    L.build(hull, 'band');
  } else if (LK === 2) {
    const L = new Parts(kit);
    pennant(L, M, [0.9, 2.8, 2.2], 0.6, 0.5); // cab roof, clear of the launcher's sweep
    L.build(hull, 'pennant');
  }

  return { root, hull, turret, gun, wheels, muzzle, muzzle2, size: [7.0, 3.2, 3.1], centerY: 1.55 };
}

/* --------------------------------------------------------------------- heli */

/** AH-1 Cobra: tandem canopy, stub wings with rocket pods, chin gun, skids. */
export function buildHeli(lib: SurfaceLibrary, team: TeamId): VehicleRig {
  const kit = new Kit(lib, team, 4404);
  const M = materials(kit);
  const root = new THREE.Group();
  root.name = 'heli';
  const hull = group(root, 'hull');
  const P = new Parts(kit);

  const CHIN: [number, number, number] = [0, 0.86, 3.05];

  /* skids + struts */
  for (const sx of [-1, 1]) {
    P.tube(M.metal, [
      [sx * 0.74, 0.05, -0.95],
      [sx * 0.74, 0.05, 0.4],
      [sx * 0.74, 0.06, 1.5],
      [sx * 0.72, 0.26, 1.95],
    ], 0.05, 6, 12);
    P.tube(M.detail, [[sx * 0.74, 0.05, 0.75], [sx * 0.42, 0.66, 0.6]], 0.035, 5, 5);
    P.tube(M.detail, [[sx * 0.74, 0.05, -0.35], [sx * 0.42, 0.66, -0.2]], 0.035, 5, 5);
    P.rect(M.detail, 0.14, 0.03, 0.4, [sx * 0.74, 0.02, 0.0]);
  }

  /* narrow forward fuselage (prism side profile) + engine deck */
  P.prism(
    M.camo,
    [
      [4.06, 0.86],
      [3.7, 0.52],
      [2.5, 0.44],
      // Rear edge tucks into the main hull box (which ends at z=1.25): leaving it at z=1.7
      // left a 0.45 m open seam between cockpit and fuselage that read as a missing part.
      [1.2, 0.58],
      [1.2, 1.2],
      [2.6, 1.16],
      [3.66, 0.96],
    ],
    0.9,
    [0, 0, 0],
    0.03,
  );
  P.box(M.camo, 1.16, 0.96, 2.4, [0, 1.14, 0.05], [0, 0, 0], 0.07);
  P.rect(M.panel, 1.2, 0.1, 1.9, [0, 1.64, 0.05]);
  P.rect(M.dark, 0.7, 0.1, 0.6, [0, 1.68, 0.5]); // intake
  P.rect(M.metal, 0.9, 0.14, 0.5, [0, 1.7, -0.45]);
  for (const sx of [-1, 1]) {
    P.cyl(M.dark, 'z', 0.11, 0.13, 0.4, [sx * 0.5, 1.34, -1.2], [0.32, 0, 0], 8);
    P.rect(M.detail, 0.26, 0.3, 0.5, [sx * 0.62, 1.3, -0.95], [0, 0, 0.1]);
  }

  /* tail boom, fin, stabilisers */
  P.add(cylAxis('z', 0.3, 0.17, 2.95, 10, false), M.camo, [0, 1.2, -2.5]);
  P.rect(M.panel, 0.3, 0.06, 2.4, [0, 1.42, -2.5]);
  P.taper(M.camo, 0.14, 1.08, 1.05, 0.5, 0.3, [0, 1.3, -3.72]);
  P.rect(M.metal, 0.1, 0.1, 1.0, [0.16, 1.2, -3.85], [0, 0, 0]);
  for (const sx of [-1, 1]) {
    P.taper(M.camo, 0.9, 0.06, 0.38, 0.75, 0.8, [sx * 0.62, 1.24, -3.3]);
  }
  P.rect(M.flag, 0.16, 0.3, 0.42, [0, 1.75, -3.78]); // team band on the fin
  P.rect(M.dark, 0.12, 0.12, 0.14, [0, 1.02, -3.95]); // tail skid

  /* canopy: glass panels in a frame, tandem two-seat */
  P.rect(M.glass, 0.72, 0.5, 0.04, [0, 1.06, 3.32], [-0.66, 0, 0]);
  P.rect(M.metal, 0.84, 0.07, 0.07, [0, 1.25, 3.16], [-0.66, 0, 0]); // windscreen header
  for (const sx of [-1, 1]) {
    P.rect(M.glass, 0.04, 0.42, 0.92, [sx * 0.4, 1.32, 2.82], [0, 0, -sx * 0.16]);
    P.rect(M.glass, 0.04, 0.4, 0.86, [sx * 0.39, 1.58, 1.95], [0, 0, -sx * 0.16]);
    P.rect(M.metal, 0.05, 0.46, 0.06, [sx * 0.42, 1.34, 3.26], [-0.34, 0, 0]);
    P.rect(M.metal, 0.05, 0.46, 0.06, [sx * 0.42, 1.34, 2.38]);
    P.rect(M.metal, 0.05, 0.44, 0.06, [sx * 0.42, 1.6, 1.52]);
    P.rect(M.metal, 0.04, 0.04, 1.0, [sx * 0.4, 1.53, 2.82], [0, 0, -sx * 0.16]);
    P.rect(M.metal, 0.04, 0.04, 0.94, [sx * 0.39, 1.78, 1.95], [0, 0, -sx * 0.16]);
  }
  P.rect(M.glass, 0.78, 0.04, 0.88, [0, 1.52, 2.82]);
  P.rect(M.glass, 0.76, 0.04, 0.86, [0, 1.77, 1.95]);
  P.rect(M.metal, 0.06, 0.06, 1.5, [0, 1.53, 2.6]); // canopy spine
  P.rect(M.metal, 0.9, 0.1, 0.1, [0, 1.2, 3.42], [-0.62, 0, 0]);
  P.rect(M.detail, 0.88, 0.08, 0.9, [0, 1.14, 1.9]); // cockpit sill

  /* stub wings, pylons, rocket pods, wingtip fairings */
  for (const sx of [-1, 1]) {
    P.taper(M.camo, 0.6, 0.17, 0.78, 0.75, 0.82, [sx * 0.78, 1.1, 0.55], [0, 0, -sx * 0.07]);
    P.rect(M.metal, 0.2, 0.3, 0.24, [sx * 0.86, 0.95, 0.5]);
    P.cyl(M.detail, 'z', 0.19, 0.19, 1.05, [sx * 0.9, 0.98, 0.5], [0, 0, 0], 10);
    P.disc(M.dark, 0.175, 10, [sx * 0.9, 0.98, 1.04]);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      P.disc(M.dark, 0.05, 6, [sx * 0.9 + Math.cos(a) * 0.095, 0.98 + Math.sin(a) * 0.095, 1.06]);
    }
    P.disc(M.dark, 0.05, 6, [sx * 0.9, 0.98, 1.06]);
  }
  P.cyl(M.metal, 'z', 0.13, 0.16, 0.5, [0, 1.05, 0.2], [0, 0, 0], 8); // ammo bay

  /* transmission fairing + skid shoes */
  P.taper(M.camo, 0.72, 0.36, 1.25, 0.68, 0.66, [0, 1.62, 0.35]);
  P.rect(M.detail, 0.2, 0.05, 0.24, [-0.74, 0.03, 0.75]);
  P.rect(M.detail, 0.2, 0.05, 0.24, [0.74, 0.03, 0.75]);
  P.rect(M.detail, 0.2, 0.05, 0.24, [-0.74, 0.03, -0.35]);
  P.rect(M.detail, 0.2, 0.05, 0.24, [0.74, 0.03, -0.35]);

  /* rotor mast (static) + main rotor (spins about Y) */
  P.cyl(M.metal, 'y', 0.09, 0.12, 0.42, [0, 1.6, 0.35], [0, 0, 0], 8);
  P.rect(M.detail, 0.5, 0.16, 0.7, [0, 1.68, 0.35]);
  const rotorMain = group(hull, 'rotorMain', [0, 2.04, 0.35]);
  rotorMain.add(makeMesh(kit.gTaper(0.36, 0.18, 0.36, 0.62, 0.62), M.detail, 'rotorHub'));
  for (const sx of [-1, 1]) {
    const grip = makeMesh(kit.gBox(0.34, 0.12, 0.18, 0.03), M.metal, `grip${sx}`);
    grip.position.set(sx * 0.3, 0, 0);
    rotorMain.add(grip);
    const blade = makeMesh(kit.gTaper(3.0, 0.06, 0.44, 0.86, 0.7), M.dark, `blade${sx}`);
    blade.position.set(sx * 1.78, 0.03, 0);
    blade.rotation.z = -sx * 0.03;
    rotorMain.add(blade);
  }

  /* tail rotor (spins about X) */
  const rotorTail = group(hull, 'rotorTail', [0.17, 1.62, -3.8]);
  rotorTail.add(makeMesh(cylAxis('x', 0.09, 0.09, 0.14, 8, false), M.detail, 'tailHub'));
  for (const sy of [-1, 1]) {
    const blade = makeMesh(kit.gTaper(0.1, 0.62, 0.15, 0.8, 0.7), M.dark, `tailBlade${sy}`);
    blade.position.set(0, sy * 0.31, 0); // long axis Y: rotation.x sweeps the disc
    rotorTail.add(blade);
  }

  /* chin gun turret */
  const turret = group(root, 'turret', CHIN);
  const T = new Parts(kit);
  T.cyl(M.camo, 'y', 0.2, 0.24, 0.14, [0, -0.07, 0], [0, 0, 0], 10);
  T.rect(M.detail, 0.32, 0.2, 0.3, [0, 0.04, 0.02]);
  T.tube(M.detail, [[0, -0.04, 0], [0, -0.3, -0.1]], 0.05, 5, 5);
  T.build(turret, 'chinMount');
  const gun = group(turret, 'gun', [0, 0.02, 0.1]);
  const G = new Parts(kit);
  G.rect(M.detail, 0.28, 0.24, 0.44, [0, -0.05, 0.16]);
  G.cyl(M.metal, 'z', 0.06, 0.07, 0.16, [0, -0.05, 0.44], [0, 0, 0], 8);
  for (const a of [0, 1, 2]) {
    const ang = (a / 3) * Math.PI * 2 + Math.PI / 6;
    G.cyl(M.dark, 'z', 0.035, 0.035, 0.72, [Math.cos(ang) * 0.05, -0.05 + Math.sin(ang) * 0.05, 0.62], [0, 0, 0], 6);
  }
  G.rect(M.dark, 0.2, 0.1, 0.16, [0, -0.05, 0.9]);
  G.build(gun, 'chinGun');
  const muzzle = anchor(gun, 'muzzle', [0, -0.05, 0.98]);
  const muzzle2 = anchor(hull, 'muzzle2', [0.9, 0.98, 1.03]); // right rocket pod

  /* lights + aerials + panel lines */
  P.disc(M.glass, 0.06, 8, [0, 0.72, 3.95], [0, 0, 0]);
  P.cyl(M.dark, 'z', 0.012, 0.012, 0.3, [0, 0.86, 4.1], [0, 0, 0], 6);
  P.cyl(M.dark, 'y', 0.012, 0.012, 0.5, [0, 1.3, -1.6], [0.3, 0, 0], 6);
  P.cyl(M.dark, 'y', 0.012, 0.012, 0.4, [0, 0.6, 3.0], [-0.4, 0, 0], 6);
  P.rect(M.panel, 0.96, 0.03, 0.06, [0, 0.63, 2.0]);
  P.rect(M.mark, 0.02, 0.2, 0.5, [0.6, 1.2, -1.9]);
  P.build(hull, 'heli');

  /* visibility looks */
  const LK = vehicleLook();
  if (LK === 1) {
    const L = new Parts(kit);
    sideBands(L, M, 0.59, 1.14, 0.05, 2.3, 0.5); // main hull box (face at ±0.58)
    L.build(hull, 'band');
  } else if (LK === 2) {
    const L = new Parts(kit);
    pennant(L, M, [0, 1.84, -3.72], 0.56, 0.45); // top of the tail fin
    L.build(hull, 'pennant');
  }

  return { root, hull, turret, gun, rotorMain, rotorTail, wheels: [], muzzle, muzzle2, size: [8.4, 2.2, 2.6], centerY: 1.3 };
}

/* -------------------------------------------------------------------- troop */

/** 1.8 m infantryman: helmet, webbing, rifle. ~330 tris. */
export function buildTroop(lib: SurfaceLibrary, team: TeamId): VehicleRig {
  const kit = new Kit(lib, team, 5505);
  const M = materials(kit);
  const root = new THREE.Group();
  root.name = 'troop';
  const hull = group(root, 'hull');
  const P = new Parts(kit);

  for (const sx of [-1, 1]) {
    P.rect(M.dark, 0.12, 0.1, 0.28, [sx * 0.11, 0.05, 0.03]); // boots
    P.rect(M.camo, 0.13, 0.66, 0.16, [sx * 0.11, 0.43, 0.0]); // legs
    P.rect(M.camo, 0.1, 0.44, 0.12, [sx * 0.24, 1.16, -0.02], [0, 0, -sx * 0.08]); // upper arms
    P.rect(M.camo, 0.1, 0.3, 0.12, [sx * 0.2, 1.02, 0.16], [-0.9, 0, 0]); // forearms
    P.rect(M.detail, 0.11, 0.1, 0.16, [sx * 0.1, 0.86, 0.02]); // pouches
  }
  P.rect(M.camo, 0.32, 0.16, 0.22, [0, 0.8, 0]); // hips
  P.frustum(M.camo, 0.34, 0.23, 0.42, 0.26, 0.54, [0, 0.86, 0]); // torso
  P.rect(M.detail, 0.36, 0.12, 0.28, [0, 1.06, 0]); // belt kit
  P.rect(M.detail, 0.08, 0.4, 0.28, [0.14, 1.24, -0.06], [0, 0, 0.12]); // sling
  P.rect(M.camo, 0.14, 0.14, 0.14, [0, 1.45, 0]); // neck
  P.add(sphereGeo(0.105, 8, 5), M.camo, [0, 1.6, 0.01]);
  P.add(sphereGeo(0.145, 8, 4), M.camo, [0, 1.63, -0.01], [0, 0, 0], [1, 0.8, 1.06]);
  P.rect(M.detail, 0.24, 0.05, 0.12, [0, 1.6, 0.12]); // brim
  /* rifle held across the chest, muzzle forward-up */
  P.rect(M.dark, 0.06, 0.1, 0.42, [0.19, 1.16, 0.22], [-0.16, 0, 0]);
  P.rect(M.dark, 0.05, 0.06, 0.2, [0.19, 1.1, -0.04], [-0.16, 0, 0]);
  P.rect(M.dark, 0.045, 0.16, 0.1, [0.19, 1.02, 0.16], [0.2, 0, 0]);
  P.cyl(M.dark, 'z', 0.014, 0.014, 0.34, [0.19, 1.2, 0.58], [-0.16, 0, 0], 6);
  P.rect(M.dark, 0.04, 0.06, 0.3, [0.19, 1.24, 0.3], [-0.16, 0, 0]);
  P.rect(M.mark, 0.02, 0.12, 0.02, [-0.13, 1.28, -0.02]); // team patch
  P.build(hull, 'troop');

  /* visibility looks (the figure is small, so the marks go on head and arm) */
  const LK = vehicleLook();
  if (LK === 1) {
    const L = new Parts(kit);
    L.rect(M.mark, 0.3, 0.05, 0.3, [0, 1.735, -0.01]); // helmet band
    L.build(hull, 'band');
  } else if (LK === 2) {
    const L = new Parts(kit);
    L.rect(M.mark, 0.03, 0.1, 0.14, [0.295, 1.22, -0.02]); // right armband
    L.build(hull, 'band');
  }

  const muzzle = anchor(hull, 'muzzle', [0.19, 1.23, 0.75]);
  return { root, hull, wheels: [], muzzle, size: [0.9, 0.9, 1.8], centerY: 0.9 };
}

/* -------------------------------------------------------------------- drone */

/** ~2.6 m quad-rotor UAV with camera ball and underslung gun pod. */
export function buildDrone(lib: SurfaceLibrary, team: TeamId): VehicleRig {
  const kit = new Kit(lib, team, 6606);
  const M = materials(kit);
  const root = new THREE.Group();
  root.name = 'drone';
  const hull = group(root, 'hull');
  const P = new Parts(kit);

  /* body, avionics, skids */
  P.box(M.camo, 0.5, 0.26, 0.64, [0, 0.55, 0], [0, 0, 0], 0.04);
  P.rect(M.panel, 0.44, 0.05, 0.56, [0, 0.7, 0]);
  P.rect(M.detail, 0.3, 0.1, 0.2, [0, 0.74, -0.12]);
  P.cyl(M.dark, 'y', 0.012, 0.012, 0.34, [0.16, 0.86, -0.2], [0.2, 0, 0], 6);
  P.cyl(M.dark, 'y', 0.012, 0.012, 0.3, [-0.16, 0.84, -0.2], [0.2, 0, 0], 6);
  for (const sx of [-1, 1]) {
    P.rect(M.metal, 0.05, 0.05, 0.95, [sx * 0.22, 0.025, 0]);
    P.rect(M.detail, 0.04, 0.34, 0.04, [sx * 0.22, 0.2, 0.32], [0, 0, sx * 0.3]);
    P.rect(M.detail, 0.04, 0.34, 0.04, [sx * 0.22, 0.2, -0.32], [0, 0, sx * 0.3]);
  }

  /* arms + motor pods + props */
  const rotors: THREE.Object3D[] = [];
  const corners: [number, number, number][] = [
    [1, 1, -Math.PI / 4],
    [1, -1, Math.PI / 4],
    [-1, 1, (-3 * Math.PI) / 4],
    [-1, -1, (3 * Math.PI) / 4],
  ];
  corners.forEach(([sx, sz, yaw], i) => {
    P.rect(M.metal, 0.86, 0.09, 0.14, [sx * 0.46, 0.6, sz * 0.46], [0, yaw, 0]);
    P.rect(M.dark, 0.2, 0.06, 0.12, [sx * 0.3, 0.6, sz * 0.3], [0, yaw, 0]);
    P.cyl(M.detail, 'y', 0.075, 0.085, 0.17, [sx * 0.92, 0.68, sz * 0.92], [0, 0, 0], 8);
    P.cyl(M.metal, 'y', 0.03, 0.03, 0.12, [sx * 0.92, 0.8, sz * 0.92], [0, 0, 0], 6);
    const r = group(hull, `rotor${i}`, [sx * 0.92, 0.78, sz * 0.92]);
    r.add(makeMesh(cylAxis('y', 0.05, 0.05, 0.05, 8, false), M.detail, `hub${i}`));
    for (const b of [-1, 1]) {
      const blade = makeMesh(kit.gTaper(0.4, 0.02, 0.1, 0.7, 0.7), M.dark, `blade${i}_${b}`);
      blade.position.set(b * 0.2, 0, 0);
      r.add(blade);
    }
    rotors.push(r);
  });

  /* camera ball + gimbal */
  P.sphere(M.detail, 0.14, [0, 0.4, 0.34], 8, 5);
  P.rect(M.metal, 0.1, 0.16, 0.1, [0, 0.5, 0.34]);
  P.disc(M.glass, 0.075, 8, [0, 0.4, 0.472]);
  P.rect(M.hazard, 0.3, 0.02, 0.06, [0, 0.68, 0.22]);

  P.build(hull, 'drone');

  /* visibility looks */
  const LK = vehicleLook();
  if (LK === 1) {
    const L = new Parts(kit);
    sideBands(L, M, 0.26, 0.55, 0, 0.6, 0.18); // body sides (face at ±0.25)
    L.build(hull, 'band');
  } else if (LK === 2) {
    const L = new Parts(kit);
    pennant(L, M, [0, 0.7, -0.1], 0.34, 0.3); // top of the body
    L.build(hull, 'pennant');
  }

  /* underslung gun pod on a small turret */
  const turret = group(root, 'turret', [0, 0.4, 0.45]);
  const T = new Parts(kit);
  T.cyl(M.metal, 'y', 0.09, 0.1, 0.08, [0, -0.04, 0], [0, 0, 0], 8);
  T.rect(M.detail, 0.16, 0.14, 0.26, [0, 0.02, 0.06]);
  T.build(turret, 'gunMount');
  const gun = group(turret, 'gun', [0, 0.0, 0.12]);
  const G = new Parts(kit);
  G.rect(M.metal, 0.17, 0.17, 0.34, [0, 0, 0.08]);
  G.cyl(M.dark, 'z', 0.025, 0.03, 0.44, [0, -0.03, 0.44], [0, 0, 0], 6);
  G.rect(M.dark, 0.1, 0.08, 0.16, [0, -0.03, 0.68]);
  G.build(gun, 'gunPod');
  const muzzle = anchor(gun, 'muzzle', [0, -0.03, 0.76]);

  /* rotorMain is the front-right prop (spins about Y); `rotors` exposes all four. */
  const rig: VehicleRig & { rotors: THREE.Object3D[] } = {
    root,
    hull,
    turret,
    gun,
    rotorMain: rotors[0],
    wheels: [],
    muzzle,
    size: [2.6, 2.6, 1.0],
    centerY: 0.5,
    rotors,
  };
  return rig;
}

/* --------------------------------------------------------------- submarine */

/** ~14 m surfaced submarine: hull, sail, dive planes, rotating missile launcher. */
export function buildSubmarine(lib: SurfaceLibrary, team: TeamId): VehicleRig {
  const kit = new Kit(lib, team, 7707);
  const M = materials(kit);
  const root = new THREE.Group();
  root.name = 'sub';
  const hull = group(root, 'hull');
  const P = new Parts(kit);

  const CL = 1.15; // hull centreline
  const profile: [number, number][] = [
    [0.04, -7.0],
    [0.34, -6.3],
    [0.72, -5.3],
    [1.0, -3.4],
    [1.05, 0.4],
    [1.02, 2.4],
    [0.88, 4.0],
    [0.6, 5.4],
    [0.24, 6.5],
    [0.04, 7.0],
  ];
  /* hull: grey steel with a camo upper band so the team reads from the air */
  P.add(kit.gLathe(profile, 12), M.metal, [0, CL, 0], [Math.PI / 2, 0, 0]);
  const upper = profile.map(([r, z]) => [r * 1.014, z] as [number, number]);
  P.add(latheArc(upper, 12, Math.PI), M.camo, [0, CL, 0], [Math.PI / 2, 0, 0]);
  P.cyl(M.dark, 'z', 1.07, 1.07, 0.1, [0, CL, 0], [0, 0, 0], 12); // waterline break
  /* keel blocks — the ground contact plane */
  for (const z of [3.4, 1.2, -1.2, -3.4]) P.rect(M.dark, 0.5, 0.12, 1.6, [0, 0.06, z]);

  /* sail with periscopes and masts */
  P.frustum(M.camo, 0.64, 1.95, 0.46, 1.4, 0.8, [0, 2.02, 1.1], [0, 0, 0], -0.05);
  P.cyl(M.metal, 'z', 0.32, 0.32, 1.4, [0, 2.84, 1.1], [0, 0, 0], 8);
  P.rect(M.glass, 0.3, 0.16, 0.16, [0, 2.62, 2.02]);
  P.cyl(M.dark, 'y', 0.035, 0.035, 0.3, [0, 2.98, 0.75], [0, 0, 0], 6);
  P.cyl(M.dark, 'y', 0.025, 0.025, 0.42, [0, 3.0, 1.15], [0, 0, 0], 6);
  P.cyl(M.dark, 'y', 0.03, 0.03, 0.24, [0, 2.95, 1.5], [0, 0, 0], 6);
  P.rect(M.mark, 0.03, 0.26, 0.9, [0.24, 2.4, 1.1]);
  P.rect(M.mark, 0.03, 0.26, 0.9, [-0.24, 2.4, 1.1]);
  P.rect(M.flag, 0.14, 0.34, 0.5, [0, 2.6, -5.0]);

  /* bow: dive planes, sonar, torpedo doors, anchor */
  for (const sx of [-1, 1]) {
    P.taper(M.camo, 0.42, 0.07, 0.55, 0.7, 0.8, [sx * 1.13, CL, 3.6]);
    P.taper(M.camo, 0.4, 0.07, 0.5, 0.7, 0.8, [sx * 1.02, CL, -5.2]);
    P.rect(M.dark, 0.06, 0.3, 1.5, [sx * 1.0, CL, 4.4]);
  }
  P.rect(M.dark, 0.1, 0.34, 1.6, [0, CL, -5.3]);
  P.rect(M.dark, 0.12, 1.3, 0.5, [0, CL + 0.5, -5.6]);
  P.rect(M.dark, 0.12, 1.0, 0.5, [0, CL - 0.5, -5.6]);
  P.sphere(M.detail, 0.26, [0, 0.45, 5.2], 8, 5);
  P.rect(M.metal, 0.3, 0.4, 0.12, [0, 1.5, 6.2]);
  for (let i = 0; i < 2; i++) P.rect(M.dark, 0.06, 0.5, 0.16, [0.4, CL - 0.1, 3.0 + i * 1.1]);

  /* propeller + rudder */
  P.cyl(M.dark, 'z', 0.14, 0.2, 0.36, [0, CL, -6.6], [0, 0, 0], 8);
  for (let i = 0; i < 4; i++) {
    P.rect(M.dark, 0.07, 0.62, 0.2, [0, CL + 0.42, -6.68], [(i * Math.PI) / 2, 0, 0]);
  }

  /* deck: hatches, bollards, rail, snorkel */
  for (const z of [4.6, 3.2, -1.0, -2.6, -4.2]) {
    const rr = hullRadius(profile, z);
    P.cyl(M.metal, 'y', 0.17, 0.18, 0.05, [0, CL + rr - 0.03, z], [0, 0, 0], 8);
    P.rect(M.detail, 0.1, 0.04, 0.3, [0, CL + rr + 0.005, z]);
  }
  for (const sx of [-1, 1]) {
    for (const z of [2.6, -1.6, -3.2]) {
      P.cyl(M.metal, 'y', 0.05, 0.06, 0.16, [sx * 0.42, CL + hullRadius(profile, z) - 0.05, z], [0, 0, 0], 6);
    }
    P.tube(M.metal, [
      [sx * 0.5, CL + 0.95, 3.0],
      [sx * 0.5, CL + 1.02, 0.5],
      [sx * 0.5, CL + 1.0, -2.0],
    ], 0.025, 4, 6);
  }
  P.cyl(M.detail, 'x', 0.06, 0.06, 1.6, [0, CL + 1.0, 0.3], [0, 0, 0], 6);
  P.build(hull, 'sub');

  /* visibility looks */
  const LK = vehicleLook();
  if (LK === 1) {
    const L = new Parts(kit);
    sideBands(L, M, 0.99, 1.5, 0, 3.6, 0.3); // midships only: the hull curves in toward the ends
    L.build(hull, 'band');
  } else if (LK === 2) {
    const L = new Parts(kit);
    pennant(L, M, [0, 3.0, 0.7], 0.6, 0.5); // top of the sail masts
    L.build(hull, 'pennant');
  }

  /* missile launcher aft of the sail: yaws, elevates, two tubes */
  const turret = group(root, 'turret', [0, 2.16, -1.3]);
  const T = new Parts(kit);
  T.cyl(M.metal, 'y', 0.44, 0.5, 0.2, [0, -0.1, 0], [0, 0, 0], 10);
  T.rect(M.detail, 0.3, 0.24, 0.4, [0, 0.22, -0.1]);
  T.build(turret, 'launcherBase');
  const gun = group(turret, 'gun', [0, 0.24, 0]);
  const G = new Parts(kit);
  G.box(M.camo, 0.86, 0.5, 1.1, [0, 0.1, 0], [0, 0, 0], 0.04);
  for (const sx of [-1, 1]) {
    G.cyl(M.dark, 'z', 0.17, 0.17, 1.25, [sx * 0.22, 0.12, 0.1], [0, 0, 0], 10);
    G.disc(M.dark, 0.145, 10, [sx * 0.22, 0.12, 0.74]);
  }
  G.rect(M.mark, 0.88, 0.1, 0.1, [0, 0.34, 0.55]);
  G.build(gun, 'launcher');
  const muzzle = anchor(gun, 'muzzle', [-0.22, 0.12, 0.74]);
  const muzzle2 = anchor(gun, 'muzzle2', [0.22, 0.12, 0.74]);
  gun.rotation.x = -0.14;

  return { root, hull, turret, gun, wheels: [], muzzle, muzzle2, size: [14, 3, 3], centerY: 1.5 };
}

/** Hull radius of the submarine profile at a given station. */
function hullRadius(profile: readonly [number, number][], z: number): number {
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (z >= a[1] && z <= b[1]) {
      const t = (z - a[1]) / Math.max(1e-4, b[1] - a[1]);
      return a[0] + (b[0] - a[0]) * t;
    }
  }
  return 0.2;
}

/* ------------------------------------------------------------------- factory */

export type VehicleKind = 'jeep' | 'tank' | 'hrsv' | 'heli' | 'troop' | 'drone' | 'sub';

export function vehicleRig(kind: VehicleKind, lib: SurfaceLibrary, team: TeamId): VehicleRig {
  let rig: VehicleRig;
  switch (kind) {
    case 'jeep':
      rig = buildJeep(lib, team);
      break;
    case 'tank':
      rig = buildTank(lib, team);
      break;
    case 'hrsv':
      rig = buildHrsv(lib, team);
      break;
    case 'heli':
      rig = buildHeli(lib, team);
      break;
    case 'troop':
      rig = buildTroop(lib, team);
      break;
    case 'drone':
      rig = buildDrone(lib, team);
      break;
    case 'sub':
      rig = buildSubmarine(lib, team);
      break;
  }
  // Look 3: ground rings — but flying vehicles cruise 11-14 m above the terrain, so a ring
  // parented to their root would float in mid-air; they keep only the red camo + marks.
  if (vehicleLook() === 3 && kind !== 'heli' && kind !== 'drone') attachGroundRing(rig, team);
  return rig;
}
