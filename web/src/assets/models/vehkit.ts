/**
 * vehkit.ts — vehicle-specific geometry kit.
 *
 * The shared `kit.ts` (structure/prop kit) owns beveled blocks, metric UV baking, the
 * material cache and the team tint. This file adds only what wheels, tracks, hull
 * profiles and merged bodies need, and reuses the shared generators everywhere else so
 * vehicles and structures speak the same language:
 *
 *   • `solidFromFaces` — explicit face soup with automatic outward winding (kills a
 *     whole class of inverted/black faces).
 *   • `frustum` / `prism` — cast turrets, cabs, sloped armour and hull side profiles.
 *   • `tire` / `roadWheel` — wheels whose axle is local X, so `rotation.x` spins them.
 *   • `trackRun` — a continuous band following a rounded-rect spline plus tread pads.
 *   • `tubeRun` — tow cables, roll bars, aerials, rails.
 *   • `Parts` — collects static detail and merges it per material at `build()` time, so
 *     a whole vehicle body is one draw call per material instead of one per greeble.
 *
 * Everything is non-indexed with metric UVs and cached module-wide; geometries handed
 * out here are immutable and safe to share between rigs.
 */
import * as THREE from 'three';
import { bakeMetricUV, cachedGeometry, rectGeometry } from './kit';
import type { Kit, V3 } from './kit';

const TAU = Math.PI * 2;
const ONE: V3 = [1, 1, 1];
const ZERO: V3 = [0, 0, 0];

type Face = V3[];

/* ------------------------------------------------------------------- solids */

function newell(pts: Face): THREE.Vector3 {
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n.x += (a[1] - b[1]) * (a[2] + b[2]);
    n.y += (a[2] - b[2]) * (a[0] + b[0]);
    n.z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Flat-shaded solid from a face soup; faces pointing back at `center` are flipped. */
export function solidFromFaces(faces: Face[], center: V3 = ZERO): THREE.BufferGeometry {
  const c = new THREE.Vector3(center[0], center[1], center[2]);
  const pos: number[] = [];
  const mid = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const f of faces) {
    if (f.length < 3) continue;
    const n = newell(f);
    mid.set(0, 0, 0);
    for (const q of f) mid.add(p.set(q[0], q[1], q[2]));
    mid.multiplyScalar(1 / f.length).sub(c);
    const flip = n.dot(mid) < 0;
    const pts = flip ? [...f].reverse() : f;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[0];
      const b = pts[i];
      const d = pts[i + 1];
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return bakeMetricUV(g, ONE);
}

/** Tapered box: bottom `bw`×`bd` at y = 0, top `tw`×`td` at y = `h`. 12 tris. */
export function frustum(bw: number, bd: number, tw: number, td: number, h: number, shiftZ = 0): THREE.BufferGeometry {
  return cachedGeometry(`vf:${bw}|${bd}|${tw}|${td}|${h}|${shiftZ}`, () => {
    const b = (sx: number, sz: number): V3 => [(sx * bw) / 2, 0, (sz * bd) / 2];
    const t = (sx: number, sz: number): V3 => [(sx * tw) / 2, h, (sz * td) / 2 + shiftZ];
    return solidFromFaces(
      [
        [b(-1, -1), b(1, -1), b(1, 1), b(-1, 1)],
        [t(-1, -1), t(1, -1), t(1, 1), t(-1, 1)],
        [b(-1, -1), b(1, -1), t(1, -1), t(-1, -1)],
        [b(-1, 1), b(1, 1), t(1, 1), t(-1, 1)],
        [b(-1, -1), b(-1, 1), t(-1, 1), t(-1, -1)],
        [b(1, -1), b(1, 1), t(1, 1), t(1, -1)],
      ],
      [0, h / 2, shiftZ / 2],
    );
  });
}

/** Cylinder along a canonical axis; `rTop` is at the +axis end. Metre UVs. */
export function cylAxis(
  axis: 'x' | 'y' | 'z',
  rTop: number,
  rBot: number,
  len: number,
  seg = 12,
  open = false,
): THREE.BufferGeometry {
  return cachedGeometry(`vc:${axis}|${rTop}|${rBot}|${len}|${seg}|${open ? 1 : 0}`, () => {
    const g = bakeMetricUV(new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open), ONE);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    return g;
  });
}

/** Prism: side profile in the (z, y) plane, extruded symmetrically along X. */
export function prism(
  profile: readonly (readonly [number, number])[],
  width: number,
  bevel = 0.03,
): THREE.BufferGeometry {
  const key = `vp:${profile.map((q) => `${q[0]},${q[1]}`).join(';')}|${width}|${bevel}`;
  return cachedGeometry(key, () => {
    const shape = new THREE.Shape(profile.map((q) => new THREE.Vector2(q[0], q[1])));
    const b = Math.min(bevel, width * 0.3);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(0.001, width - b * 2),
      bevelEnabled: b > 0.002,
      bevelSize: b,
      bevelThickness: b,
      bevelSegments: 1,
      steps: 1,
      curveSegments: 2,
    });
    g.rotateY(-Math.PI / 2); // shape x -> +Z, extrusion -> X
    g.computeBoundingBox();
    const bb = g.boundingBox as THREE.Box3;
    g.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
    return bakeMetricUV(g, ONE);
  });
}

/** Swept tube through a polyline (tow cables, roll bars, aerials, rails). */
export function tubeRun(points: readonly V3[], radius: number, radial = 6, tubular = 12): THREE.BufferGeometry {
  const key = `vt:${points.map((q) => q.join(',')).join(';')}|${radius}|${radial}|${tubular}`;
  return cachedGeometry(key, () => {
    const curve = new THREE.CatmullRomCurve3(
      points.map((q) => new THREE.Vector3(q[0], q[1], q[2])),
      false,
      'catmullrom',
      0,
    );
    const len = curve.getLength();
    const g = new THREE.TubeGeometry(curve, tubular, radius, radial, false);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * TAU * radius);
    return g;
  });
}

/**
 * Lathe (surface of revolution) around Y, optionally only an arc of it — used for the
 * submarine hull, where `phiStart = 0..PI` is the *bottom* half once the geometry is laid
 * along Z with `rot: [PI/2, 0, 0]`.
 */
export function latheArc(
  profile: readonly (readonly [number, number])[],
  seg = 12,
  phiStart = 0,
  phiLength = Math.PI * 2,
): THREE.BufferGeometry {
  const key = `vlathe:${profile.map((q) => `${q[0]},${q[1]}`).join(';')}|${seg}|${phiStart}|${phiLength}`;
  return cachedGeometry(key, () => {
    const pts = profile.map((q) => new THREE.Vector2(q[0], q[1]));
    return bakeMetricUV(new THREE.LatheGeometry(pts, seg, phiStart, phiLength), ONE);
  });
}

export function sphereGeo(r: number, wSeg = 8, hSeg = 5): THREE.BufferGeometry {
  return cachedGeometry(`vs:${r}|${wSeg}|${hSeg}`, () => {
    const g = new THREE.SphereGeometry(r, wSeg, hSeg);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * TAU * r, uv.getY(i) * Math.PI * r);
    return g;
  });
}

export function discGeo(r: number, seg = 10): THREE.BufferGeometry {
  return cachedGeometry(`vd:${r}|${seg}`, () => {
    const pos: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * TAU;
      const a1 = ((i + 1) / seg) * TAU;
      pos.push(0, 0, 0, r * Math.cos(a0), r * Math.sin(a0), 0, r * Math.cos(a1), r * Math.sin(a1), 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return bakeMetricUV(g, ONE);
  });
}

/* ------------------------------------------------------------------- wheels */

/**
 * Tyre around the local X axle: a corrugated band with two sidewalls (the alternating
 * radius reads as tread lugs) — origin is the hub centre, so the rig sits on y = 0 when
 * the hub is at y = r. Use an even `lugs` count so a full-radius lug lands exactly at the
 * bottom of the wheel (odd counts leave the tyre resting in a groove, floating the rig).
 */
export function tire(r: number, width: number, lugs = 8, tread = 0.04, rimFrac = 0.58): THREE.BufferGeometry {
  return cachedGeometry(`vtire:${r}|${width}|${lugs}|${tread}|${rimFrac}`, () => {
    const n = lugs * 2;
    const rimR = r * rimFrac;
    const hw = width / 2;
    const rad = (i: number): number => (i % 2 === 0 ? r : r - tread);
    const outer = (i: number, side: number): V3 => {
      const a = ((i % n) / n) * TAU;
      const rr = rad(i % n);
      return [side * hw, rr * Math.cos(a), rr * Math.sin(a)];
    };
    const inner = (i: number, side: number): V3 => {
      const a = ((i % n) / n) * TAU;
      return [side * hw, rimR * Math.cos(a), rimR * Math.sin(a)];
    };
    const faces: Face[] = [];
    for (let i = 0; i < n; i++) {
      const j = i + 1;
      faces.push([outer(i, -1), outer(j, -1), outer(j, 1), outer(i, 1)]);
      faces.push([outer(i, -1), outer(j, -1), inner(j, -1), inner(i, -1)]);
      faces.push([outer(i, 1), outer(j, 1), inner(j, 1), inner(i, 1)]);
    }
    return solidFromFaces(faces, ZERO);
  });
}

/** Road wheel / idler / sprocket disc with a hub cap; axle along X. */
export function roadWheel(r: number, width: number, seg = 10, hub = 0.42): THREE.BufferGeometry {
  return cachedGeometry(`vroad:${r}|${width}|${seg}|${hub}`, () => {
    const disc = cylAxis('x', r, r, width, seg, false);
    const cap = cylAxis('x', r * hub, r * hub, width * 1.25, Math.max(6, seg - 4), false);
    return mergeGeometries([disc, cap]);
  });
}

/* -------------------------------------------------------------------- track */

const TRACK_SAMPLES = 6;

function roundedTrackPath(len: number, height: number, corner: number): { z: number; y: number }[] {
  const pts: { z: number; y: number }[] = [];
  const r = Math.min(corner, height / 2 - 0.001);
  const zf = len / 2 - r;
  const arc = (cz: number, cy: number, a0: number, a1: number): void => {
    for (let i = 0; i < TRACK_SAMPLES; i++) {
      const a = a0 + ((a1 - a0) * i) / TRACK_SAMPLES;
      pts.push({ z: cz + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  };
  for (let i = 0; i < TRACK_SAMPLES; i++) pts.push({ z: -zf + (2 * zf * i) / TRACK_SAMPLES, y: 0 });
  arc(zf, r, -Math.PI / 2, Math.PI / 2);
  for (let i = 0; i < TRACK_SAMPLES; i++) pts.push({ z: zf - (2 * zf * i) / TRACK_SAMPLES, y: height });
  arc(-zf, height - r, Math.PI / 2, (3 * Math.PI) / 2);
  return pts;
}

/** Outward unit normal of the track path, in the (z, y) plane. */
function trackNormal(p: { z: number; y: number }, height: number, corner: number, len: number): [number, number] {
  const r = Math.min(corner, height / 2 - 0.001);
  const zf = len / 2 - r;
  if (Math.abs(p.y) < 1e-4) return [0, -1];
  if (Math.abs(p.y - height) < 1e-4) return [0, 1];
  const cz = p.z > 0 ? zf : -zf;
  const cy = p.z > 0 ? r : height - r;
  const dz = p.z - cz;
  const dy = p.y - cy;
  const l = Math.hypot(dz, dy) || 1;
  return [dz / l, dy / l];
}

/**
 * Continuous track band built from a rounded-rect spline, with chunky tread pads.
 * Origin: band centre at ground level (y = 0 is the bottom of the track).
 */
export function trackRun(
  len: number,
  width: number,
  height: number,
  corner: number,
  thickness = 0.1,
  pads = 18,
): THREE.BufferGeometry {
  return cachedGeometry(`vtrack:${len}|${width}|${height}|${corner}|${thickness}|${pads}`, () => {
    const path = roundedTrackPath(len, height, corner);
    const n = path.length;
    const hw = width / 2;
    const at = (i: number, inset: number, side: number): V3 => {
      const p = path[((i % n) + n) % n];
      const nrm = trackNormal(p, height, corner, len);
      return [side * hw, p.y - nrm[1] * inset, p.z - nrm[0] * inset];
    };
    const faces: Face[] = [];
    for (let i = 0; i < n; i++) {
      const j = i + 1;
      faces.push([at(i, 0, -1), at(j, 0, -1), at(j, 0, 1), at(i, 0, 1)]);
      faces.push([at(i, thickness, -1), at(j, thickness, -1), at(j, thickness, 1), at(i, thickness, 1)]);
      faces.push([at(i, 0, -1), at(i, thickness, -1), at(j, thickness, -1), at(j, 0, -1)]);
      faces.push([at(i, 0, 1), at(i, thickness, 1), at(j, thickness, 1), at(j, 0, 1)]);
    }
    const band = solidFromFaces(faces, [0, height / 2, 0]);
    const padGeo = bakeMetricUV(rectGeometry(width * 0.9, 0.055, 0.16), ONE);
    const padList: THREE.BufferGeometry[] = [band];
    const step = n / pads;
    for (let k = 0; k < pads; k++) {
      const p = path[Math.min(n - 1, Math.floor(k * step))];
      const nrm = trackNormal(p, height, corner, len);
      const g = padGeo.clone();
      g.applyMatrix4(
        new THREE.Matrix4().compose(
          // Seat the pad inside the band so only ~2 mm stands proud: the band's outer
          // surface stays the ground contact plane (y = 0).
          new THREE.Vector3(0, p.y - nrm[1] * 0.0255, p.z - nrm[0] * 0.0255),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.atan2(nrm[0], nrm[1]), 0, 0)),
          new THREE.Vector3(1, 1, 1),
        ),
      );
      padList.push(g);
    }
    return mergeGeometries(padList);
  });
}

/* -------------------------------------------------------------------- merge */

/** Minimal position/normal/uv merge; all inputs must be non-indexed. */
export function mergeGeometries(list: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (list.length === 0) return new THREE.BufferGeometry();
  if (list.length === 1) return list[0];
  let total = 0;
  for (const g of list) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of list) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const nn = g.getAttribute('normal') as THREE.BufferAttribute;
    const t = g.getAttribute('uv') as THREE.BufferAttribute;
    pos.set(p.array as Float32Array, o * 3);
    nor.set(nn.array as Float32Array, o * 3);
    uv.set(t.array as Float32Array, o * 2);
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

/* --------------------------------------------------------------------- parts */

/**
 * Collects static detail in vehicle-local space and merges it per material on `build()`
 * so a whole hull costs one draw call per material. Geometry is taken from the shared
 * `Kit` caches, so nothing is re-tessellated per rig.
 */
export class Parts {
  private readonly groups = new Map<THREE.Material, THREE.BufferGeometry[]>();

  constructor(private readonly kit: Kit) {}

  add(geo: THREE.BufferGeometry, mat: THREE.Material, pos: V3 = ZERO, rot: V3 = ZERO, scale: V3 = ONE): void {
    const g = geo.clone();
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(pos[0], pos[1], pos[2]),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])),
        new THREE.Vector3(scale[0], scale[1], scale[2]),
      ),
    );
    let list = this.groups.get(mat);
    if (!list) {
      list = [];
      this.groups.set(mat, list);
    }
    list.push(g);
  }

  /** Beveled box (44 tris) — main volumes. */
  box(mat: THREE.Material, w: number, h: number, d: number, pos: V3 = ZERO, rot: V3 = ZERO, bevel = 0.05): void {
    this.add(this.kit.gBox(w, h, d, bevel), mat, pos, rot);
  }

  /** Plain box (12 tris) — greebles, panel lines, frames. */
  rect(mat: THREE.Material, w: number, h: number, d: number, pos: V3 = ZERO, rot: V3 = ZERO): void {
    this.add(this.kit.gRect(w, h, d), mat, pos, rot);
  }

  taper(
    mat: THREE.Material,
    w: number,
    h: number,
    d: number,
    topX: number,
    topZ: number,
    pos: V3 = ZERO,
    rot: V3 = ZERO,
  ): void {
    this.add(this.kit.gTaper(w, h, d, topX, topZ), mat, pos, rot);
  }

  frustum(
    mat: THREE.Material,
    bw: number,
    bd: number,
    tw: number,
    td: number,
    h: number,
    pos: V3 = ZERO,
    rot: V3 = ZERO,
    shiftZ = 0,
  ): void {
    this.add(frustum(bw, bd, tw, td, h, shiftZ), mat, pos, rot);
  }

  cyl(
    mat: THREE.Material,
    axis: 'x' | 'y' | 'z',
    rTop: number,
    rBot: number,
    len: number,
    pos: V3 = ZERO,
    rot: V3 = ZERO,
    seg = 12,
    open = false,
  ): void {
    this.add(cylAxis(axis, rTop, rBot, len, seg, open), mat, pos, rot);
  }

  prism(mat: THREE.Material, profile: readonly (readonly [number, number])[], width: number, pos: V3 = ZERO, bevel = 0.03): void {
    this.add(prism(profile, width, bevel), mat, pos);
  }

  sphere(mat: THREE.Material, r: number, pos: V3, wSeg = 8, hSeg = 5): void {
    this.add(sphereGeo(r, wSeg, hSeg), mat, pos);
  }

  tube(mat: THREE.Material, points: readonly V3[], radius: number, radial = 6, tubular = 12): void {
    this.add(tubeRun(points, radius, radial, tubular), mat);
  }

  disc(mat: THREE.Material, r: number, seg: number, pos: V3, rot: V3 = ZERO): void {
    this.add(discGeo(r, seg), mat, pos, rot);
  }

  build(parent: THREE.Object3D, name = 'body'): void {
    let i = 0;
    for (const [mat, list] of this.groups) {
      const mesh = new THREE.Mesh(mergeGeometries(list), mat);
      mesh.name = `${name}:${mat.name || i}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      i++;
    }
    this.groups.clear();
  }
}

/** Animated mesh: shares cached geometry and is never transformed in place. */
export function makeMesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Empty anchor (muzzle points, pivots, camera helpers). */
export function anchor(parent: THREE.Object3D, name: string, pos: V3 = ZERO): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(pos[0], pos[1], pos[2]);
  parent.add(o);
  return o;
}

export function group(parent: THREE.Object3D, name: string, pos: V3 = ZERO): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(pos[0], pos[1], pos[2]);
  parent.add(g);
  return g;
}

/** Number of triangles under `root` (verification + budget checks). */
export function countTris(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry as THREE.BufferGeometry;
    const idx = geo.getIndex();
    const pos = geo.getAttribute('position');
    if (pos) tris += (idx ? idx.count : pos.count) / 3;
  });
  return Math.round(tris);
}
