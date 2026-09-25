/**
 * Draw-call reduction for static models.
 *
 * A structure template is authored as dozens of small meshes (panels, ladders, rails...),
 * and every placed instance clones all of them: with ~240 structures on a map that is tens of
 * thousands of draw calls per frame. Merging each template's static meshes per material
 * collapses that to a handful, while nodes the game animates (turret pods, gates, radar
 * dishes, rotors) are preserved untouched.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Merge every static mesh of `root` that shares a material. `keep` nodes are left alone. */
export function mergeStaticMeshes(root: THREE.Object3D, keep: THREE.Object3D[] = []): number {
  root.updateMatrixWorld(true);
  const keepSet = new Set<THREE.Object3D>();
  for (const k of keep) {
    k.traverse((o) => keepSet.add(o));
  }

  const groups = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (keepSet.has(m)) return;
    // Skip anything parented under a preserved node (the whole animated subtree).
    let p: THREE.Object3D | null = m;
    while (p && p !== root) {
      if (keepSet.has(p)) return;
      p = p.parent;
    }
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!mat) return;
    const g = m.geometry.clone();
    // Express the geometry in root space so the merged mesh needs no extra transform.
    const local = new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld);
    g.applyMatrix4(local);
    // Merging requires an identical attribute set; drop anything exotic.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const count = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    let entry = groups.get(mat);
    if (!entry) {
      entry = { geos: [], meshes: [] };
      groups.set(mat, entry);
    }
    entry.geos.push(g);
    entry.meshes.push(m);
  });

  let merged = 0;
  for (const [mat, entry] of groups) {
    if (entry.geos.length < 2) {
      for (const g of entry.geos) g.dispose();
      continue;
    }
    let geo: THREE.BufferGeometry | null = null;
    try {
      geo = mergeGeometries(entry.geos, false);
    } catch {
      geo = null;
    }
    for (const g of entry.geos) g.dispose();
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = '__merged';
    // The merged mesh lives in root space; insert it at the root's top level.
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    for (const m of entry.meshes) m.removeFromParent();
    merged += entry.meshes.length - 1;
  }
  return merged;
}
