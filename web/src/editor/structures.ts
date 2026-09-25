/**
 * Structure meshes for the editor.
 *
 * The game's `WorldView` builds these too, but it is wired to a live `Sim` (vehicles,
 * projectiles, damage, flags, animations). The editor has none of that: a structure here is a
 * static placement, and the only thing that changes is the list. So this is the small half of
 * `WorldView` — one template per kind, instanced for the scattered props — and it rebuilds when
 * the list changes rather than every frame.
 */
import * as THREE from 'three';
import { buildProp } from '../assets/models/props.js';
import { buildStructure } from '../assets/models/structures.js';
import { isUnitSized } from '../assets/models/kinds.js';
import type { StructureModel, SurfaceLibrary } from '../assets/types.js';
import type { StructureView } from '../sim/layout.js';

/** Kinds the game draws as instanced scatter; the editor matches it so a map looks the same. */
const INSTANCED = [12, 13, 15, 16, 17, 24, 21];

export interface EditorStructures {
  group: THREE.Group;
  /** Rebuild from the map's current structure list. */
  rebuild(list: StructureView[], count: number): void;
  /** A translucent copy of a structure, for the placement preview. */
  ghost(kind: number, team: number, ok: boolean): THREE.Object3D;
  dispose(): void;
}

/**
 * The placement ghost: a translucent copy of the model that would be placed.
 *
 * It matters for the two things you cannot judge from a palette button: how big the thing is
 * against the ground you are standing on, and which way round it will face. The tint says whether
 * the spot is usable (on the map, on dry ground) before the click.
 */
export function createGhost(lib: SurfaceLibrary): EditorStructures['ghost'] {
  const cache = new Map<string, THREE.Object3D>();
  return (kind: number, team: number, ok: boolean): THREE.Object3D => {
    const key = `${kind}:${team}:${ok ? 1 : 0}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const model = INSTANCED.includes(kind) ? buildProp(kind, lib, 1) : buildStructure(kind, lib, team === 1 ? 1 : 0, 1);
    const root = model.root.clone(true) as THREE.Object3D;
    const mat = new THREE.MeshBasicMaterial({
      color: ok ? 0x9fe07a : 0xe07a5a,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = mat;
        m.renderOrder = 6;
      }
    });
    cache.set(key, root);
    return root;
  };
}

/** The mesh inside a model root, for the kinds that are instanced. */
function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  if ((root as THREE.Mesh).isMesh) return root as THREE.Mesh;
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

export function createEditorStructures(lib: SurfaceLibrary): EditorStructures {
  const group = new THREE.Group();
  group.name = 'editor-structures';
  const templates = new Map<string, StructureModel>();
  const singles: THREE.Object3D[] = [];
  let instanced: THREE.InstancedMesh[] = [];

  const templateFor = (kind: number, team: number, seed: number): StructureModel => {
    const key = `${kind}:${team}:${seed}`;
    let t = templates.get(key);
    if (!t) {
      t = INSTANCED.includes(kind) ? buildProp(kind, lib, seed) : buildStructure(kind, lib, team === 1 ? 1 : 0, seed);
      templates.set(key, t);
    }
    return t;
  };

  const clear = (): void => {
    for (const o of singles) group.remove(o);
    singles.length = 0;
    for (const im of instanced) {
      group.remove(im);
      im.dispose();
    }
    instanced = [];
  };

  const rebuild = (list: StructureView[], count: number): void => {
    clear();
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const s = list[i];
      const kind = s.kind | 0;
      if (INSTANCED.includes(kind)) {
        const variant = Math.abs(Math.floor(s.x * 13 + s.z * 7)) % 3;
        const key = `${kind}:${variant}`;
        const b = buckets.get(key);
        if (b) b.push(i);
        else buckets.set(key, [i]);
        continue;
      }
      const team = s.team | 0;
      const variant = Math.abs(Math.floor(s.x * 3 + s.z * 5)) % 3;
      const root = templateFor(kind, team, variant + 1).root.clone(true) as THREE.Object3D;
      root.position.set(s.x, s.y, s.z);
      // Map yaw is CCW in (x, z); three.js yaw is CW.
      root.rotation.y = -s.yaw;
      if (isUnitSized(kind)) root.scale.set(s.w, s.h, s.d);
      group.add(root);
      singles.push(root);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const [key, ids] of buckets) {
      const [kindStr, variantStr] = key.split(':');
      const kind = Number(kindStr);
      const variant = Number(variantStr);
      const model = templateFor(kind, 0, variant + 1);
      const mesh = firstMesh(model.root);
      if (!mesh) continue;
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material as THREE.Material, ids.length);
      im.castShadow = true;
      im.receiveShadow = true;
      for (let k = 0; k < ids.length; k++) {
        const s = list[ids[k]];
        pos.set(s.x, s.y, s.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -s.yaw);
        scl.set(1, 1, 1);
        m.compose(pos, q, scl);
        im.setMatrixAt(k, m);
      }
      im.instanceMatrix.needsUpdate = true;
      group.add(im);
      instanced.push(im);
    }
  };

  return {
    group,
    rebuild,
    ghost: createGhost(lib),
    dispose() {
      clear();
      for (const t of templates.values()) t.root.parent?.remove(t.root);
      templates.clear();
    },
  };
}
