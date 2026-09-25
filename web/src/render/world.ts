/**
 * The world view: static structures, instanced scatter props, vehicles (with their turrets,
 * rotors and wheels), projectiles, mines, flags and turret pods.
 *
 * Everything is pooled or cloned from a handful of templates so the per-frame cost is a few
 * hundred matrix updates rather than a few thousand object allocations.
 */
import * as THREE from 'three';
import { isUnitSized, structureKindName } from '../assets/models/kinds.js';
import { mergeStaticMeshes } from './mergeModel.js';
import { buildStructure } from '../assets/models/structures.js';
import { buildProp } from '../assets/models/props.js';
import { vehicleRig } from '../assets/models/vehicles.js';
import type { StructureModel, SurfaceLibrary, VehicleRig } from '../assets/types.js';
import type { Sim } from '../sim/bridge.js';
import {
  FLAGSTATE,
  PKIND,
  SFLAG,
  SKIND,
  VFLAG,
  VKIND,
  VSTATE,
  type ProjectileView,
  type StructureView,
  type VehicleView,
} from '../sim/layout.js';
import type { Effects } from './effects.js';
import type { Terrain } from './terrain.js';

interface StructureInstance {
  index: number;
  kind: number;
  /** Per-instance clone (the animated kinds only); instanced records have none. */
  root?: THREE.Object3D;
  animated: THREE.Object3D[];
  ruined?: THREE.Object3D;
  dead: boolean;
  /** Instanced path (`buildStaticInstanced`): this record's bucket, region and slot in it. */
  bucket?: StaticBucket;
  slot?: number;
  /** Culling region this instance was built into (see `REGION`). */
  region?: number;
  /** This instance's world-space matrix, kept so a death or round reset can swap it back. */
  matrix?: THREE.Matrix4;
}

/** One instanced set per template submesh, for the live and the ruined variant. */
interface StaticRegionSet {
  live: { im: THREE.InstancedMesh; local: THREE.Matrix4 }[];
  ruined: { im: THREE.InstancedMesh; local: THREE.Matrix4 }[];
}

/**
 * A bucket's instances are split into spatial regions, each with its own InstancedMesh set.
 * three.js frustum-culls per mesh bounding sphere, and a single whole-map bucket would never
 * be culled (its sphere covers the entire battlefield), so every off-screen palm or wall on
 * the far side of the map would still be rasterised — in both the main and the shadow pass.
 */
interface StaticBucket {
  kind: number;
  regions: Map<number, StaticRegionSet>;
}

/** World-space edge length (metres) of one instancing culling region. */
const REGION = 512;

/** Region id for a world position on a `cols` x `cols` grid over the battlefield. */
function regionOf(x: number, z: number, cols: number): number {
  const rx = Math.min(cols - 1, Math.max(0, Math.floor(x / REGION)));
  const rz = Math.min(cols - 1, Math.max(0, Math.floor(z / REGION)));
  return rz * cols + rx;
}

/** Split structure indices into their culling regions (pool views must be current). */
function byRegion(indices: number[], structPool: StructureView[], cols: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const i of indices) {
    const s = structPool[i];
    const r = regionOf(s.x, s.z, cols);
    const list = out.get(r);
    if (list) list.push(i);
    else out.set(r, [i]);
  }
  return out;
}

/**
 * Kinds that stay on the per-instance clone path because the game animates them every frame
 * (gate leaves slide, the radar dish spins, the turret pod tracks). Everything else is static
 * once placed and goes through `buildStaticInstanced`.
 */
const ANIMATED_SINGLE_KINDS: ReadonlySet<number> = new Set([
  SKIND.TURRET_TOWER,
  SKIND.RADAR,
  SKIND.GATE,
]);

interface VehicleRigInstance {
  rig: VehicleRig;
  kind: number;
  team: number;
  active: boolean;
  /** This rig's own material clones. See `cloneRigMaterials` for why they exist. */
  paints: RigPaint[];
  /** `time` when this rig's current occupant was destroyed, or -1 while it is alive. Drives
   *  the soot ramp and is cleared when the pooled rig is handed back to a live hull. */
  wreckAt: number;
  /** A paint write left the hit-flash emissive behind, so it must be cleared even after the
   *  HIT_FLASH flag drops. */
  wasFlashed: boolean;
  /** A paint write left the wreck soot on the hull, so it must be restored when the rig is
   *  reused as a live vehicle. */
  sootApplied: boolean;
}

/** One private copy of a material that `lib.mat`/the model builders would otherwise share
 *  between every rig of the same kind and team, plus the values to restore it from. */
interface RigPaint {
  material: THREE.MeshStandardMaterial;
  color: THREE.Color;
  roughness: number;
  metalness: number;
}

export interface WorldView {
  group: THREE.Group;
  rebuild(sim: Sim, terrain: Terrain): void;
  update(dt: number, sim: Sim, time: number): void;
  /** Screen-space object list for HUD markers (world positions). */
  vehiclePosition(id: number, out: THREE.Vector3): boolean;
  dispose(): void;
}

const INSTANCED_KINDS: number[] = [
  SKIND.PALM,
  SKIND.ROCK,
  SKIND.CRATE,
  SKIND.BARREL,
  SKIND.SANDBAG,
  SKIND.CONTAINER,
  SKIND.WRECK,
];

export function createWorldView(lib: SurfaceLibrary, fx: Effects): WorldView {
  const group = new THREE.Group();
  group.name = 'world';
  const structures: StructureInstance[] = [];
  const cleanups: (() => void)[] = [];
  const templates = new Map<string, StructureModel>();
  const instancedGroups: THREE.InstancedMesh[] = [];
  const structPool: StructureView[] = [];
  // Scratch objects so the per-frame path allocates nothing.
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler();
  const tmpScale = new THREE.Vector3();
  const tmpMat = new THREE.Matrix4();

  const rigs: VehicleRigInstance[] = [];
  /** Set once the (kind, team) rig pool has been pre-built during the first map build. */
  let prewarmed = false;
  const projMeshes: THREE.Object3D[] = [];
  const PROJ_AXIS = new THREE.Vector3(0, 1, 0);
  const projAim = new THREE.Vector3();
  /**
   * The minefield is two instanced draws - bodies and LEDs - for the whole field. It used to
   * build a `Group` with two `Mesh`es per mine and keep them for the rest of the match, so a
   * long match ended up with hundreds of scene objects and two draw calls each.
   */
  let mineBody: THREE.InstancedMesh | null = null;
  let mineLed: THREE.InstancedMesh | null = null;
  /** Instances the pool was built for; `InstancedMesh` capacity is fixed at construction. */
  let mineCap = 0;
  const mineColor = new THREE.Color();
  const flagMeshes: { pole: THREE.Object3D | null; cloth: THREE.Object3D; team: number }[] = [];

  // ---- shared geometry for the small stuff -----------------------------------
  // A soft ring under the player's own vehicle: at a 50 m camera distance the player must
  // never have to hunt for their own ride.
  const markerGeo = new THREE.RingGeometry(2.6, 3.5, 44);
  markerGeo.rotateX(-Math.PI / 2);
  const markerMat = new THREE.MeshBasicMaterial({
    color: 0x8ff0d8,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const markers: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(markerGeo, markerMat.clone());
    m.visible = false;
    m.renderOrder = 3;
    group.add(m);
    markers.push(m);
  }

  const mineGeo = new THREE.CylinderGeometry(0.45, 0.55, 0.22, 10);
  const mineMat = new THREE.MeshStandardMaterial({ color: 0x2b2f26, roughness: 0.75, metalness: 0.35 });
  const ledGeo = new THREE.SphereGeometry(0.11, 6, 5);
  // White, because the LED's colour now arrives per instance (`setColorAt`) and instance colour
  // *multiplies* the material's. It used to be the red itself and then be overwritten per mine
  // through the shared material - which is why every LED in the field blinked as one.
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // ---- projectiles -------------------------------------------------------------
  // Every body is modelled along +Y, so one `setFromUnitVectors` aligns it with the flight
  // path for all kinds. Sizes are real metres: a 120 mm shell is ~0.7 m long and a 20 mm round
  // is invisible, so the chain gun's round *is* its tracer — a short unlit streak that the
  // bloom pass picks up.
  const capsule = (r: number, len: number, seg: number): THREE.BufferGeometry =>
    new THREE.CapsuleGeometry(r, len, seg, 8);
  interface ProjectileArt {
    geo: THREE.BufferGeometry;
    mat: THREE.Material;
    /**
     * Unlit element on the tail: an exhaust `flame` for powered rounds (never for a shell or a
     * grenade) or a `tracer` dot, which is what makes a 0.7 m shell legible in flight.
     */
    flame?: { r: number; h: number; y: number };
    tracer?: { r: number; y: number };
  }
  const projMat = new THREE.MeshStandardMaterial({ color: 0x6b6f63, roughness: 0.5, metalness: 0.7 });
  const projTracerMat = new THREE.MeshBasicMaterial({ color: 0xffd489, toneMapped: false });
  const projFlameMat = new THREE.MeshBasicMaterial({
    color: 0xffb347,
    toneMapped: false,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Cone with its base at +Y (against the tail of the body) and its tip trailing at -Y.
  const flameGeo = new THREE.ConeGeometry(1, 1, 8, 1, true);
  flameGeo.rotateX(Math.PI);
  const tracerGeo = new THREE.SphereGeometry(1, 8, 6);
  const PROJ_ART: Record<number, ProjectileArt> = {
    // 120 mm shell: 0.7 m of shell with the tracer element of a real round on its base.
    [PKIND.SHELL]: { geo: capsule(0.1, 0.5, 3), mat: projMat, tracer: { r: 0.09, y: -0.42 } },
    // Mk2 grenade: a dark ball, nothing glowing — you see the arc, not the body.
    [PKIND.GRENADE]: { geo: new THREE.SphereGeometry(0.11, 10, 7), mat: projMat },
    // 20 mm tracer: 2.5 m of unlit streak, and no exhaust — it is a bullet, not a rocket.
    [PKIND.BULLET]: { geo: capsule(0.06, 2.4, 2), mat: projTracerMat },
    // 70 mm rocket: 1.1 m of motor plus a plume.
    [PKIND.ROCKET]: { geo: capsule(0.13, 0.85, 3), mat: projMat, flame: { r: 0.14, h: 1.5, y: -1.31 } },
    [PKIND.MISSILE]: { geo: capsule(0.14, 1.2, 3), mat: projMat, flame: { r: 0.15, h: 1.6, y: -1.55 } },
    [PKIND.HOMING]: { geo: capsule(0.19, 1.6, 4), mat: projMat, flame: { r: 0.2, h: 1.8, y: -1.9 } },
    [PKIND.BOMB]: { geo: capsule(0.2, 1.2, 3), mat: projMat },
  };

  function templateFor(kind: number, team: number, seed: number): StructureModel {
    const key = `${kind}:${team}:${seed}`;
    let t = templates.get(key);
    if (!t) {
      if (INSTANCED_KINDS.includes(kind)) {
        t = buildProp(kind, lib, seed);
      } else {
        t = buildStructure(kind, lib, team === 1 ? 1 : 0, seed);
      }
      // Name the animated nodes so clones can find them again.
      t.animated?.forEach((node, i) => {
        node.name = `__anim${i}`;
      });
      if (t.ruined) t.ruined.name = '__ruined';
      t.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      if (t.ruined) {
        t.ruined.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
      }
      // Collapse the authored part list into a few meshes: the map has hundreds of these.
      mergeStaticMeshes(t.root, t.animated ?? []);
      if (t.ruined) mergeStaticMeshes(t.ruined, []);
      templates.set(key, t);
    }
    return t;
  }

  function rebuild(sim: Sim, terrain: Terrain): void {
    // Clear previous map.
    for (const s of structures) if (s.root) group.remove(s.root);
    structures.length = 0;
    for (const im of instancedGroups) {
      group.remove(im);
      im.dispose();
    }
    instancedGroups.length = 0;
    for (const c of cleanups) c();
    cleanups.length = 0;
    for (const f of flagMeshes) {
      group.remove(f.cloth);
      if (f.pole) group.remove(f.pole);
    }
    flagMeshes.length = 0;

    const count = sim.structureCount;
    while (structPool.length < count) structPool.push({} as StructureView);

    // Bucket the instanced kinds so each variant becomes one InstancedMesh set. The static
    // singletons (walls, buildings, garages, bridges...) get the same treatment per
    // (kind, team, variant): cloned, each of their ~10 material-merged submeshes was its own
    // draw call, so a base ring of fifty walls cost five hundred. A bucket is one InstancedMesh
    // per template submesh no matter how many instances it holds. Only the kinds the game
    // animates every frame (gate leaves, radar dish, turret pods) keep their private clones —
    // there are a dozen of them at most.
    const buckets = new Map<string, number[]>();
    const staticBuckets = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const s = sim.structure(i, structPool[i]);
      const kind = s.kind | 0;
      if (INSTANCED_KINDS.includes(kind)) {
        const variant = Math.abs(Math.floor(s.x * 13 + s.z * 7)) % 3;
        const key = `${kind}:${variant}`;
        const list = buckets.get(key);
        if (list) list.push(i);
        else buckets.set(key, [i]);
      } else if (!ANIMATED_SINGLE_KINDS.has(kind)) {
        const variant = Math.abs(Math.floor(s.x * 3 + s.z * 5)) % 3;
        const key = `${kind}:${s.team | 0}:${variant}`;
        const list = staticBuckets.get(key);
        if (list) list.push(i);
        else staticBuckets.set(key, [i]);
      } else {
        placeSingle(s, i, terrain);
      }
    }

    // Culling regions: a `cols` x `cols` grid of REGION-metre cells over the battlefield.
    const cols = Math.max(1, Math.ceil(sim.map.worldSize / REGION));
    for (const [key, list] of buckets) {
      const [kindStr, variantStr] = key.split(':');
      const kind = Number(kindStr);
      const variant = Number(variantStr);
      const model = templateFor(kind, 0, variant + 1);
      buildInstanced(model.root, kind, variant, list, terrain, cols);
    }
    for (const [key, list] of staticBuckets) {
      const [kindStr, teamStr, variantStr] = key.split(':');
      buildStaticInstanced(Number(kindStr), Number(teamStr), Number(variantStr) + 1, list, terrain, cols);
    }

    // Pre-build one rig per (kind, team) so the first vehicle of a kind never pays model
    // construction mid-frame: the builders cache geometry module-wide, but the object graph
    // and per-rig material clones still cost a few milliseconds each — visible as a hitch on
    // the frame a troop or helicopter first appears. Doing it here folds that cost into the
    // already-heavy map build. The rigs sit in the pool inactive (invisible) until claimed.
    if (!prewarmed) {
      prewarmed = true;
      for (const kind of [VKIND.JEEP, VKIND.TANK, VKIND.HRSV, VKIND.HELI, VKIND.TROOP, VKIND.DRONE, VKIND.SUB]) {
        for (const team of [0, 1]) {
          const built = acquireRig(kind, team);
          group.add(built.rig.root);
          rigs.push({
            rig: built.rig,
            paints: built.paints,
            kind,
            team,
            active: false,
            wreckAt: -1,
            wasFlashed: false,
            sootApplied: false,
          });
        }
      }
    }

    // Flag poles get a cloth the game can move around.
    for (let team = 0; team < 2; team++) {
      const cloth = makeFlagCloth(team);
      group.add(cloth);
      flagMeshes.push({ pole: null, cloth, team });
    }
  }

  function placeSingle(s: StructureView, index: number, terrain: Terrain): void {
    const kind = s.kind | 0;
    const team = s.team | 0;
    const variant = Math.abs(Math.floor(s.x * 3 + s.z * 5)) % 3;
    const tmpl = templateFor(kind, team, variant + 1);
    const root = tmpl.root.clone(true) as THREE.Object3D;
    root.position.set(s.x, s.y, s.z);
    // Map yaw rotates CCW in (x, z); three.js yaw is CW, hence the negation.
    root.rotation.y = -s.yaw;
    // Unit-sized models are stretched to the map's footprint; true-scale kinds (radar,
    // turret towers, palms, lighthouse...) keep their authored size and only take the yaw.
    if (isUnitSized(kind)) root.scale.set(s.w, s.h, s.d);
    group.add(root);

    let ruined: THREE.Object3D | undefined;
    if (tmpl.ruined) {
      ruined = tmpl.ruined.clone(true) as THREE.Object3D;
      ruined.position.copy(root.position);
      ruined.rotation.copy(root.rotation);
      ruined.scale.copy(root.scale);
      ruined.visible = false;
      group.add(ruined);
    }
    const animated: THREE.Object3D[] = [];
    (tmpl.animated ?? []).forEach((_node, i) => {
      const found = root.getObjectByName(`__anim${i}`);
      if (found) animated.push(found);
    });
    structures.push({ index, kind, root, animated, ruined, dead: false });
    void terrain;
  }

  /**
   * Cheap instancing for the hundreds of palms, rocks and crates: every mesh inside the
   * template becomes one InstancedMesh sharing the same geometry + material.
   *
   * Instances are split into spatial regions (`REGION`-metre cells), each with its own
   * InstancedMesh set and bounding sphere, so three.js frustum culling drops whole off-screen
   * regions for free. A single whole-map bucket would never be culled — its sphere covers the
   * entire battlefield — and on a big map that keeps ~15k palms and rocks rasterised even when
   * the camera sits at one base (in both the main and the shadow pass).
   */
  function buildInstanced(
    template: THREE.Object3D,
    kind: number,
    variant: number,
    indices: number[],
    terrain: Terrain,
    cols: number,
  ): void {
    const meshes: { geo: THREE.BufferGeometry; mat: THREE.Material; matrix: THREE.Matrix4 }[] = [];
    void tmpMat;
    template.updateMatrixWorld(true);
    template.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const mesh = m as THREE.Mesh;
      meshes.push({
        geo: mesh.geometry as THREE.BufferGeometry,
        mat: (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material,
        matrix: mesh.matrixWorld.clone(),
      });
    });
    if (!meshes.length) return;

    const outer = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    for (const [region, rIndices] of byRegion(indices, structPool, cols)) {
      const per = meshes.map((m) => {
        const im = new THREE.InstancedMesh(m.geo, m.mat, rIndices.length);
        im.castShadow = true;
        im.receiveShadow = true;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Named: every instanced mesh used to be anonymous, so a stray slab in `rfScene`
        // could only be described as "(anon) Mesh" (see the dev hooks in `main.ts`).
        im.name = `scatter:${structureKindName(kind)}:${variant}:r${region}`;
        im.userData.kind = kind;
        im.userData.variant = variant;
        im.userData.region = region;
        group.add(im);
        instancedGroups.push(im);
        return { im, local: m.matrix };
      });
      for (let i = 0; i < rIndices.length; i++) {
        const s = structPool[rIndices[i]];
        const unit = isUnitSized(kind);
        outer.compose(
          tmpPos.set(s.x, s.y, s.z),
          tmpQuat.setFromEuler(tmpEuler.set(0, -s.yaw, 0)),
          unit ? tmpScale.set(s.w, s.h, s.d) : tmpScale.set(1, 1, 1),
        );
        for (const p of per) {
          world.multiplyMatrices(outer, p.local);
          p.im.setMatrixAt(i, world);
        }
      }
      for (const p of per) {
        p.im.instanceMatrix.needsUpdate = true;
        p.im.computeBoundingSphere();
      }
    }
    void terrain;
  }

  /** A degenerate matrix hides one instance without removing it from its set. */
  const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

  /**
   * Instanced rendering for the static singletons (walls, buildings, garages, bridges...).
   *
   * Every instance of one (kind, team, variant) shares the template's submeshes through an
   * InstancedMesh, so a base ring of fifty walls costs as many draw calls as a single wall.
   * A destroyed structure is not removed from its set: its live instances are scaled to zero
   * and its ruined ones (built alongside, hidden at first) take the place, which keeps a
   * death — or a round reset reviving everything — to a handful of matrix writes.
   *
   * Instances are split into spatial regions (`REGION`-metre cells), each with its own set
   * and bounding sphere, so frustum culling drops whole off-screen regions (on a big map the
   * enemy base's walls are never in view). A region's sphere is computed once from its full
   * instance set; deaths only shrink what it covers, so the cached value stays conservative.
   */
  function buildStaticInstanced(
    kind: number,
    team: number,
    variant: number,
    indices: number[],
    terrain: Terrain,
    cols: number,
  ): void {
    const tmpl = templateFor(kind, team, variant);
    const collect = (root: THREE.Object3D): { geo: THREE.BufferGeometry; mat: THREE.Material; local: THREE.Matrix4 }[] => {
      root.updateMatrixWorld(true);
      const out: { geo: THREE.BufferGeometry; mat: THREE.Material; local: THREE.Matrix4 }[] = [];
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.geometry) return;
        out.push({
          geo: m.geometry as THREE.BufferGeometry,
          mat: (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material,
          local: m.matrixWorld.clone(),
        });
      });
      return out;
    };
    const liveSrc = collect(tmpl.root);
    if (!liveSrc.length) return;
    const ruinedSrc = tmpl.ruined ? collect(tmpl.ruined) : [];

    const bucket: StaticBucket = { kind, regions: new Map() };
    const outer = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    for (const [region, rIndices] of byRegion(indices, structPool, cols)) {
      const make = (
        src: typeof liveSrc,
        part: 'live' | 'ruined',
      ): { im: THREE.InstancedMesh; local: THREE.Matrix4 }[] =>
        src.map((m) => {
          const im = new THREE.InstancedMesh(m.geo, m.mat, rIndices.length);
          im.castShadow = true;
          im.receiveShadow = true;
          im.name = `struct:${structureKindName(kind)}:t${team}:${part}:r${region}`;
          group.add(im);
          instancedGroups.push(im);
          return { im, local: m.local };
        });
      const live = make(liveSrc, 'live');
      const ruined = make(ruinedSrc, 'ruined');

      const outers: THREE.Matrix4[] = new Array(rIndices.length);
      for (let i = 0; i < rIndices.length; i++) {
        const s = structPool[rIndices[i]];
        const unit = isUnitSized(kind);
        outer.compose(
          tmpPos.set(s.x, s.y, s.z),
          tmpQuat.setFromEuler(tmpEuler.set(0, -s.yaw, 0)),
          unit ? tmpScale.set(s.w, s.h, s.d) : tmpScale.set(1, 1, 1),
        );
        outers[i] = outer.clone();
        for (const p of live) {
          world.multiplyMatrices(outer, p.local);
          p.im.setMatrixAt(i, world);
        }
        for (const p of ruined) p.im.setMatrixAt(i, HIDDEN_MATRIX);
      }
      for (const p of [...live, ...ruined]) {
        p.im.instanceMatrix.needsUpdate = true;
        p.im.computeBoundingSphere();
      }
      // The ruined set has just measured a sphere over instances that are *all* degenerate, and
      // `computeBoundingSphere()` over those is not a conservative bound at all: it is a
      // zero-radius sphere sitting at the world origin (measured: `centre (0, 0, 0) radius 0.0`).
      // three.js culls against exactly that, per pass — so the ruins were dropped from the colour
      // pass whenever the origin was off screen, while the sun's shadow box, a different frustum,
      // could still contain it and draw them into the shadow map. That is the reported ghost:
      // a destroyed building shading the ground while nothing of it is on screen. Measured with
      // `tools/ghost-shadow.mjs` on a razed base: 0 px of rubble drawn, 425 px of ground shaded
      // by it. Place every instance once to measure where they can actually be, then hide them
      // again. Deaths only ever move an instance onto a spot the live set already covers, so the
      // bound stays conservative for the rest of the match.
      for (let i = 0; i < rIndices.length; i++) {
        for (const p of ruined) {
          world.multiplyMatrices(outers[i], p.local);
          p.im.setMatrixAt(i, world);
        }
      }
      for (const p of ruined) {
        p.im.instanceMatrix.needsUpdate = true;
        p.im.computeBoundingSphere();
        for (let i = 0; i < rIndices.length; i++) p.im.setMatrixAt(i, HIDDEN_MATRIX);
        p.im.instanceMatrix.needsUpdate = true;
      }

      bucket.regions.set(region, { live, ruined });
      for (let i = 0; i < rIndices.length; i++) {
        structures.push({
          index: rIndices[i],
          kind,
          animated: [],
          dead: false,
          bucket,
          slot: i,
          region,
          matrix: outers[i],
        });
      }
    }
    void terrain;
  }

  /** Swap one instanced record between its live and ruined instances (death or round reset). */
  function setBucketDead(s: StructureInstance, dead: boolean): void {
    const b = s.bucket as StaticBucket;
    const rs = b.regions.get(s.region as number);
    if (!rs) return;
    const m = s.matrix as THREE.Matrix4;
    const slot = s.slot as number;
    // Every part is placed at `outer * part.local`, exactly as the build does. The local
    // matrix is not decoration: a unit-sized model is authored at the size the *generator*
    // expects and then carried in a shell scaled by the inverse of that size, so the instance
    // scale `(w, h, d)` lands on a model that is one unit across. Writing the bare outer
    // matrix here — which is what this did — dropped that inverse for every part that has one,
    // and the part came out `w * h` too big: a garage panel 136 m long, a fuel-depot slab
    // 65 m across. It only ever showed after a structure had died and been revived (a round
    // end), because that is the only other writer of these matrices — the "weird rectangle on
    // the base after a round finishes" report.
    const world = new THREE.Matrix4();
    const put = (parts: { im: THREE.InstancedMesh; local: THREE.Matrix4 }[], matrix: THREE.Matrix4) => {
      for (const p of parts) {
        world.multiplyMatrices(matrix, p.local);
        p.im.setMatrixAt(slot, world);
        p.im.instanceMatrix.needsUpdate = true;
      }
    };
    put(rs.live, dead ? HIDDEN_MATRIX : m);
    put(rs.ruined, dead ? m : HIDDEN_MATRIX);
  }

  function makeFlagCloth(team: number): THREE.Object3D {
    const g = new THREE.PlaneGeometry(1.8, 1.15, 8, 4);
    g.translate(0.9, 0, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: team === 0 ? 0x3f6b34 : 0xa83226, // team 1 flies red (matches camoRed)
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.name = `flag_${team}`;
    return mesh;
  }

  // ---- vehicles ---------------------------------------------------------------
  /** Seconds the wreck soot ramp takes to reach full black. */
  const WRECK_SOOT_TIME = 1.25;
  /** Near-black soot the burnt hull fades to. */
  const SOOT_COLOR = new THREE.Color(0x0a0a0a);

  /**
   * Give one rig its own copies of every material it uses.
   *
   * `SurfaceLibrary.mat` (and the model builders through it) returns a *shared, cached*
   * `MeshStandardMaterial` whose own contract says not to mutate it. Building a rig from that
   * library therefore handed the exact same material instance to every rig of a kind+team, and
   * `syncRig` mutating `material.emissive` for a hit flash lit up every vehicle of that kind —
   * live and wrecked alike. That is the reported "I hit one and they all lit up". Each rig now
   * gets private clones, made once here at acquire time and never per frame. Geometry is still
   * shared; only the material instances are per rig.
   */
  function cloneRigMaterials(rig: VehicleRig): RigPaint[] {
    const paints: RigPaint[] = [];
    const seen = new Map<THREE.Material, THREE.Material>();
    rig.root.traverse((o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material) return;
      const list = Array.isArray(m.material) ? m.material : [m.material];
      for (let i = 0; i < list.length; i++) {
        let copy = seen.get(list[i]);
        if (!copy) {
          copy = list[i].clone();
          seen.set(list[i], copy);
          if ((copy as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            const std = copy as THREE.MeshStandardMaterial;
            paints.push({
              material: std,
              color: std.color.clone(),
              roughness: std.roughness,
              metalness: std.metalness,
            });
          }
        }
        list[i] = copy;
      }
      // Re-assign so an array material keeps its array identity (and a single material is
      // not left wrapped in a one-element array).
      m.material = Array.isArray(m.material) ? list : list[0];
    });
    return paints;
  }

  /** Build a fresh rig. Geometry allocation is cached inside the model module, so this is
   *  cheap; rigs are then pooled per (kind, team) and reused. Materials are cloned per rig
   *  (`cloneRigMaterials`) so a hit flash or a burn is private to this hull. */
  function acquireRig(kind: number, team: number): { rig: VehicleRig; paints: RigPaint[] } {
    const name =
      kind === VKIND.JEEP
        ? 'jeep'
        : kind === VKIND.TANK
          ? 'tank'
          : kind === VKIND.HRSV
            ? 'hrsv'
            : kind === VKIND.HELI
              ? 'heli'
              : kind === VKIND.TROOP
                ? 'troop'
                : kind === VKIND.DRONE
                  ? 'drone'
                  : 'sub';
    let rig: VehicleRig;
    try {
      rig = vehicleRig(name, lib, team === 1 ? 1 : 0);
    } catch (err) {
      console.warn(`vehicle model "${name}" unavailable`, err);
      rig = fallbackRig(lib, kind === VKIND.TANK ? 6 : 3);
    }
    rig.root.traverse((o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      // The look-3 ground ring is a flat decal: it must not cast or receive shadows.
      if (m.isMesh && m.name !== 'teamRing') {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return { rig, paints: cloneRigMaterials(rig) };
  }

  function fallbackRig(lib: SurfaceLibrary, size: number): VehicleRig {
    const root = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(size * 0.5, size * 0.28, size),
      lib.mat('vehMetal'),
    );
    body.position.y = size * 0.16;
    root.add(body);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, size * 0.2, size * 0.6);
    root.add(muzzle);
    return {
      root,
      hull: body,
      wheels: [],
      muzzle,
      size: [size, size * 0.5, size * 0.3],
      centerY: size * 0.16,
    };
  }

  /**
   * Gun elevation to *show* for a vehicle kind, which is not always the simulation's own.
   *
   * The jeep's launcher stands on a pedestal in the middle of an M151 cockpit, behind the
   * windshield glass: with the simulation's own elevation range (-0.5 rad) the barrel swings
   * down through the pane on any target closer than about 11 m. The simulation still fires on
   * its own `gunPitch`, so this only limits the model — and it moves the muzzle anchor closer to
   * where the round is really spawned, because a lobbed weapon's muzzle does not swing with
   * elevation at all (`combat::muzzle_pos`).
   */
  function visualGunPitch(kind: number, pitch: number): number {
    return Math.max(pitch, kind === VKIND.JEEP ? -0.05 : -2);
  }

  function syncRig(slot: VehicleRigInstance, v: VehicleView, time: number): void {
    const rig = slot.rig;
    const root = rig.root;
    root.userData.vehicleId = v.id;
    // `VehicleView.y` is the hull's real world height: rf-core already folds the hover altitude
    // into it (`physics.rs` eases a flying vehicle's `y` toward `ground + alt`). Adding `alt`
    // again here drew the helicopter and the drone 2 x their altitude — 14 m above the height
    // their own shells, muzzle flashes and tracers spawn at (`center_y() + muzzle_up`), which is
    // exactly the reported "the gun fires from below the aircraft". Every other reader of the
    // view — the camera target, the player markers, a carried flag — uses `v.y` as it stands.
    root.position.set(v.x, v.y, v.z);
    root.rotation.set(0, v.yaw, 0);
    // Slope-follow: pitch and roll come straight from the simulation.
    root.rotateX(v.pitch);
    root.rotateZ(v.roll);
    if (rig.turret) {
      rig.turret.rotation.y = v.turretYaw - v.yaw;
      if (rig.gun) {
        rig.gun.rotation.x = -visualGunPitch(v.kind, v.gunPitch);
      }
    } else if (rig.gun) {
      rig.gun.rotation.x = -visualGunPitch(v.kind, v.gunPitch);
    }
    const speed = v.speed;
    for (const w of rig.wheels) {
      w.rotation.x = (v.anim % 1000) * 0.5;
    }
    // Rotors spin only while the airframe is alive. The angles are absolute (`time * spin`),
    // so stopping the writes freezes the blades at their last position on the kill frame —
    // a crashed heli or drone must not keep whirring as it tumbles down. A pooled rig that
    // later serves a fresh vehicle resumes from the current `time`, so nothing goes stale.
    if (v.state !== VSTATE.WRECK) {
      if (rig.rotorMain) {
        const spin = v.kind === VKIND.DRONE ? 42 : 26;
        rig.rotorMain.rotation.y = time * spin;
        rig.rotorMain.rotation.x = Math.sin(time * 3.1) * 0.02;
      }
      if (rig.rotorTail) {
        rig.rotorTail.rotation.x = time * 60;
      }
    }
    // Damage state: sink and tilt a wreck, lean into acceleration when alive.
    if (v.state === VSTATE.WRECK) {
      root.rotateZ(0.06);
      root.position.y -= 0.35;
    } else {
      root.rotateX(-Math.min(0.06, speed * 0.002));
    }
    // Hit flash and wreck soot: written onto this rig's own material clones (see
    // `cloneRigMaterials`), never the shared library materials.
    const flash = (v.flags & VFLAG.HIT_FLASH) !== 0 ? Math.min(1, v.hp > 0 ? 1 : 0.6) : 0;
    applyPaint(slot, v, time, flash);
  }

  /**
   * Tint one rig's private materials for the hit flash and the burnt-wreck look.
   *
   * The soot ramps in over `WRECK_SOOT_TIME` so a kill reads as "burning" rather than
   * snapping black. Everything is written from the values saved on `slot.paints`, which is
   * also what restores a pooled rig the frame it is handed back to a live hull. A wreck
   * forces emissive to zero, so the blackened hull cannot keep glowing from an older flash.
   */
  function applyPaint(slot: VehicleRigInstance, v: VehicleView, time: number, flash: number): void {
    const wrecked = v.state === VSTATE.WRECK;
    if (!wrecked) slot.wreckAt = -1;
    else if (slot.wreckAt < 0) slot.wreckAt = time;
    const burn = slot.wreckAt < 0 ? 0 : Math.min(1, (time - slot.wreckAt) / WRECK_SOOT_TIME);
    const flashOn = flash > 0;
    // The common case is a live, unflashed hull: touch nothing.
    if (burn <= 0 && !flashOn && !slot.wasFlashed && !slot.sootApplied) return;
    slot.wasFlashed = flashOn;
    const soot = burn * burn; // ease-in: the hull chars fastest right after the blast
    slot.sootApplied = soot > 0;
    const fr = flash * 0.55;
    const fg = flash * 0.12;
    const fb = flash * 0.05;
    for (const p of slot.paints) {
      if (soot > 0) {
        p.material.color.copy(p.color).lerp(SOOT_COLOR, soot);
        p.material.roughness = p.roughness + (0.97 - p.roughness) * soot;
        p.material.metalness = p.metalness * (1 - soot);
      } else {
        // Back to the model's own paint: this is the frame a pooled rig is reused live.
        p.material.color.copy(p.color);
        p.material.roughness = p.roughness;
        p.material.metalness = p.metalness;
      }
      p.material.emissive.setRGB(fr, fg, fb);
    }
  }

  function updateMarkers(sim: Sim, time: number): void {
    for (let i = 0; i < markers.length; i++) {
      markers[i].visible = false;
    }
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      if ((v.flags & VFLAG.IS_PLAYER) === 0 || v.state !== VSTATE.ACTIVE) continue;
      const slot = Math.round(v.buildT) - 1;
      if (slot < 0 || slot >= markers.length) continue;
      const m = markers[slot];
      m.visible = true;
      const pulse = 0.85 + 0.15 * Math.sin(time * 2.4);
      m.position.set(v.x, v.y + 0.12, v.z);
      m.scale.setScalar(pulse);
      (m.material as THREE.MeshBasicMaterial).opacity =
        (v.flags & VFLAG.SPAWN_GUARD) !== 0 ? 0.9 : 0.5;
    }
  }

  function updateVehicles(sim: Sim, time: number, dt: number): void {
    // Mark all rigs unused, then claim the ones we need this frame.
    for (const r of rigs) r.active = false;
    for (let i = 0; i < sim.vehicleCount; i++) {
      const v = sim.vehicles[i];
      let slot = rigs.find((r) => !r.active && r.kind === v.kind && r.team === v.team);
      if (!slot) {
        const built = acquireRig(v.kind, v.team);
        group.add(built.rig.root);
        slot = {
          rig: built.rig,
          paints: built.paints,
          kind: v.kind,
          team: v.team,
          active: true,
          wreckAt: -1,
          wasFlashed: false,
          sootApplied: false,
        };
        rigs.push(slot);
      }
      slot.active = true;
      syncRig(slot, v, time);
      // A surviving wreck keeps making black soot, tapering as its `wreck` clock runs out.
      // rf-core refuses the BURNING flag to drones (`world.rs::sync_views`); the kind test
      // states the same rule here so the emit path is skipped entirely for a drone.
      if (v.state === VSTATE.WRECK && (v.flags & VFLAG.BURNING) !== 0 && v.kind !== VKIND.DRONE) {
        fx.trackWreck(v, dt);
      }
      // Carry the flag visually.
      if (v.flags & VFLAG.CARRYING) {
        const f = flagMeshes.find((fm) => fm.team !== v.team);
        if (f) {
          f.cloth.visible = true;
          f.cloth.position.set(v.x, v.y + 2.4, v.z);
          f.cloth.rotation.set(0, v.yaw + Math.PI / 2, 0.35);
          f.cloth.scale.setScalar(0.9);
        }
      }
    }
    for (const r of rigs) {
      if (!r.active) r.rig.root.visible = false;
      else r.rig.root.visible = true;
    }
  }

  /** Point a pooled projectile at the right body and tail element for its kind. Only runs when
   *  the kind changes (pool slots are reused across kinds), so the steady state is two writes. */
  function dressProjectile(mesh: THREE.Mesh, kind: number): void {
    const art = PROJ_ART[kind] ?? PROJ_ART[PKIND.SHELL];
    mesh.geometry = art.geo;
    mesh.material = art.mat;
    const tail = mesh.children[0] as THREE.Mesh | undefined;
    if (!tail) return;
    if (art.flame) {
      tail.visible = true;
      tail.geometry = flameGeo;
      tail.material = projFlameMat;
      tail.position.set(0, art.flame.y, 0);
      tail.scale.set(art.flame.r, art.flame.h, art.flame.r);
    } else if (art.tracer) {
      tail.visible = true;
      tail.geometry = tracerGeo;
      tail.material = projTracerMat;
      tail.position.set(0, art.tracer.y, 0);
      tail.scale.setScalar(art.tracer.r);
    } else {
      tail.visible = false;
    }
  }

  function updateProjectiles(sim: Sim, dt: number): void {
    for (let i = 0; i < sim.projectileCount; i++) {
      const p = sim.projectiles[i];
      const kind = p.kind | 0;
      let mesh = projMeshes[i] as THREE.Mesh | undefined;
      if (!mesh) {
        mesh = new THREE.Mesh(PROJ_ART[PKIND.SHELL].geo, projMat);
        const tail = new THREE.Mesh(flameGeo, projFlameMat);
        tail.visible = false;
        mesh.add(tail);
        group.add(mesh);
        projMeshes[i] = mesh;
      }
      if (mesh.userData.kind !== kind) {
        mesh.userData.kind = kind;
        dressProjectile(mesh, kind);
      }
      mesh.visible = true;
      mesh.position.set(p.x, p.y, p.z);
      // Align the body with the flight path. A round falling straight down, or climbing at the
      // camera, is seen end-on and reads as the dot it is — no crosswise geometry either way.
      const speed = Math.hypot(p.vx, p.vy, p.vz);
      if (speed > 1e-4) {
        projAim.set(p.vx / speed, p.vy / speed, p.vz / speed);
        mesh.quaternion.setFromUnitVectors(PROJ_AXIS, projAim);
      }
      // Hand every round's heading to the effects system, not just the powered ones: it needs
      // the direction to point the muzzle flash down the barrel. Only rockets, missiles and
      // homing rounds also get the smoke trail (see `Effects.trackProjectile`).
      fx.trackProjectile(p as ProjectileView, dt);
    }
    for (let i = sim.projectileCount; i < projMeshes.length; i++) {
      if (projMeshes[i]) projMeshes[i].visible = false;
    }
  }

  /**
   * Deterministic 0..1 hash of a mine's id, for its blink offset and rate. The id - not the
   * array slot - is what makes the pattern stable: slots shift down when a mine detonates, so a
   * slot-keyed phase made every survivor after the hole jump to a new point in its cycle.
   */
  function mineHash01(n: number): number {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /** (Re)build both instanced draws at `cap` instances. Matrices are rewritten every frame. */
  function buildMineField(cap: number): void {
    if (mineBody) {
      group.remove(mineBody);
      mineBody.dispose();
    }
    if (mineLed) {
      group.remove(mineLed);
      mineLed.dispose();
    }
    mineBody = new THREE.InstancedMesh(mineGeo, mineMat, cap);
    mineBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Instances carry their own world positions while the mesh itself sits at the origin, so a
    // bounding sphere taken from the geometry would cull the whole field the moment the camera
    // turned away from (0, 0, 0). The debris pool drops culling for the same reason.
    mineBody.frustumCulled = false;
    mineBody.count = 0;
    group.add(mineBody);

    mineLed = new THREE.InstancedMesh(ledGeo, ledMat, cap);
    mineLed.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mineLed.frustumCulled = false;
    mineLed.count = 0;
    // Seeded up front: `instanceColor` must exist before the first draw, because whether it does
    // is part of the program's cache key - creating it later would recompile the material.
    for (let i = 0; i < cap; i++) mineLed.setColorAt(i, mineColor.setRGB(1, 1, 1));
    if (mineLed.instanceColor) mineLed.instanceColor.setUsage(THREE.DynamicDrawUsage);
    group.add(mineLed);
  }

  function updateMines(sim: Sim, time: number): void {
    const n = sim.mineCount;
    if (n > mineCap) {
      let cap = Math.max(256, mineCap * 2);
      while (cap < n + 16) cap *= 2;
      buildMineField(cap);
      mineCap = cap;
    }
    const body = mineBody;
    const led = mineLed;
    if (!body || !led) return;

    for (let i = 0; i < n; i++) {
      const m = sim.mines[i];
      tmpMat.makeTranslation(m.x, m.y + 0.12, m.z);
      body.setMatrixAt(i, tmpMat);
      // The LED rides on top of the hull, and an unarmed mine shows nothing: with one draw for
      // the whole field there is no per-instance `visible`, so a collapsed matrix is how an
      // instance is dropped.
      if (m.armed > 0.5) {
        tmpMat.makeTranslation(m.x, m.y + 0.28, m.z);
        // Its own rate as well as its own phase, so the field drifts in and out of step like
        // real indicator lamps rather than pulsing as one rigid pattern.
        const rate = 4.2 + mineHash01(m.id + 57.0) * 1.6;
        const phase = mineHash01(m.id) * Math.PI * 2;
        const blink = (Math.sin(time * rate + phase) + 1) * 0.5;
        led.setColorAt(i, mineColor.setRGB(1, 0.15 + blink * 0.5, 0.1));
      } else {
        tmpMat.makeScale(0, 0, 0);
      }
      led.setMatrixAt(i, tmpMat);
    }
    // `count` is the whole visibility story for a pooled instanced draw: raising it past the
    // last live mine would leave a stale hull behind, so it is always written.
    body.count = n;
    led.count = n;
    body.instanceMatrix.needsUpdate = true;
    led.instanceMatrix.needsUpdate = true;
    if (led.instanceColor) led.instanceColor.needsUpdate = true;
  }

  function updateFlags(sim: Sim, time: number): void {
    for (let i = 0; i < 2; i++) {
      const f = sim.flags[i];
      const fm = flagMeshes.find((x) => x.team === i);
      if (!fm) continue;
      if (f.state === FLAGSTATE.CARRIED) {
        // Position is driven by the carrying vehicle in updateVehicles.
        continue;
      }
      const carried = sim.vehicles.some(
        (v, idx) => idx < sim.vehicleCount && (v.flags & VFLAG.CARRYING) !== 0 && v.team !== i,
      );
      if (carried) continue;
      fm.cloth.visible = true;
      const bob = f.state === FLAGSTATE.DROPPED ? Math.sin(time * 3) * 0.05 - 1.2 : 0;
      fm.cloth.position.set(f.x, f.y + 3.4 + bob, f.z);
      fm.cloth.rotation.set(0, Math.sin(time * 1.3 + i) * 0.25, 0.15);
      fm.cloth.scale.setScalar(f.state === FLAGSTATE.DROPPED ? 0.7 : 1);
    }
  }

  function updateStructures(sim: Sim, dt: number): void {
    for (const s of structures) {
      const view = sim.structure(s.index, structPool[s.index]);
      const dead = (view.flags & SFLAG.DEAD) !== 0;
      if (dead !== s.dead) {
        s.dead = dead;
        if (s.bucket) {
          setBucketDead(s, dead);
        } else if (s.root) {
          // Clone path (the animated kinds): root always exists here.
          s.root.visible = !dead;
          if (s.ruined) s.ruined.visible = dead;
        }
      }
      if (s.kind === SKIND.TURRET_TOWER && s.animated.length) {
        const t = sim.turrets.find((tt) => (tt.structId | 0) === s.index);
        // Turret yaw is world-space; the pod lives inside the rotated structure.
        if (t) s.animated[0].rotation.y = -(t.yaw + view.yaw);
      }
      if (s.kind === SKIND.RADAR && s.animated.length) {
        s.animated[0].rotation.y += 0.006;
      }
      if (s.kind === SKIND.GATE && s.animated.length) {
        // A gate slides its two leaves open for its OWN team's land vehicles — a friendly
        // jeep, tank or MLRS in the gateway or on the approach — and shuts again once the
        // area is clear. The helicopter, the drone, troops and a wreck never open it, and
        // the enemy's gate stays shut (it is `sim.vehicles[i].team` against the structure's
        // team, so two gates on one base work independently). All state lives on the node's
        // own `userData`, which every clone gets a private copy of.
        const damaged = view.hp < view.hpMax * 0.4;
        if (damaged) {
          // The original damage reaction: the leaves twist where they stand and stay shut.
          for (const a of s.animated) a.rotation.y *= 0.94;
        }
        let want = 0;
        if (!damaged) {
          const cos = Math.cos(view.yaw);
          const sin = Math.sin(view.yaw);
          const reachX = view.w * 0.5 + 2.5; // across the opening, either side of the jambs
          const reachZ = 13; // along the wall normal: in the gateway or on the approach
          for (let i = 0; i < sim.vehicleCount; i++) {
            const v = sim.vehicles[i];
            if ((v.team | 0) !== (view.team | 0)) continue;
            if (v.kind !== VKIND.JEEP && v.kind !== VKIND.TANK && v.kind !== VKIND.HRSV) continue;
            if (v.state === VSTATE.WRECK || v.state === VSTATE.BUILDING) continue;
            const dx = v.x - view.x;
            const dz = v.z - view.z;
            // Structure yaw rotates CCW in (x, z): `w` runs along (cos, sin), `d` across it.
            const lx = dx * cos + dz * sin;
            const lz = -dx * sin + dz * cos;
            if (Math.abs(lx) <= reachX && Math.abs(lz) <= reachZ) {
              want = 1;
              break;
            }
          }
        }
        // GATE is a clone-path kind, so its root always exists.
        const ud = (s.root as THREE.Object3D).userData as { rfGateOpen?: number };
        const was = ud.rfGateOpen ?? 0;
        // ~1 s of travel, then eased on the displacement so the leaves never snap.
        const step = dt / 0.9;
        const now = want > was ? Math.min(want, was + step) : Math.max(want, was - step);
        ud.rfGateOpen = now;
        const eased = now * now * (3 - 2 * now);
        for (const a of s.animated) {
          const hint = a.userData.rfAnim as { axis?: 'x' | 'y' | 'z'; travel?: number } | undefined;
          const own = a.userData as { rfLeafBase?: number };
          if (own.rfLeafBase === undefined) own.rfLeafBase = a.position[hint?.axis ?? 'x'];
          a.position[hint?.axis ?? 'x'] = own.rfLeafBase + (hint?.travel ?? 0) * eased;
        }
      }
    }
  }

  return {
    group,
    rebuild,
    update(dt, sim, time) {
      updateStructures(sim, dt);
      updateMarkers(sim, time);
      updateVehicles(sim, time, dt);
      updateProjectiles(sim, dt);
      updateMines(sim, time);
      updateFlags(sim, time);
    },
    vehiclePosition(id, out) {
      for (let i = 0; i < rigs.length; i++) {
        const r = rigs[i];
        if (r.rig.root.userData.vehicleId === id) {
          out.copy(r.rig.root.position);
          return true;
        }
      }
      return false;
    },
    dispose() {
      for (const im of instancedGroups) im.dispose();
      for (const c of cleanups) c();
      // These clones are ours; the surface library only tracks the materials it built.
      for (const r of rigs) for (const p of r.paints) p.material.dispose();
      templates.clear();
      projMeshes.length = 0;
      mineBody?.dispose();
      mineLed?.dispose();
      mineBody = null;
      mineLed = null;
      mineCap = 0;
      group.clear();
    },
  };
}

export { structureKindName };
