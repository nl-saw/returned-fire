/**
 * kit.ts — shared low-poly kit used by the procedural structure, prop and vehicle builders.
 *
 * Conventions
 *  - Metres, Y up, `y = 0` is the ground contact plane (root origin sits on the ground).
 *  - Geometry is cached module-wide and keyed by shape *and* UV scale, so repeated calls
 *    share the same `BufferGeometry` (cheap to feed an `InstancedMesh`) and never
 *    re-tessellate. Never mutate a geometry returned from here — treat it as immutable.
 *  - Materials are cached per surface key + tint via `SurfaceCache`. We only ever go
 *    through `lib.clone()`, so the texture library's shared materials are never mutated.
 *  - UVs are baked in METRES at build time: one uv unit == one metre of the expected final
 *    size. The surface library should therefore tile with `repeat = 1 / worldScale` on the
 *    shared texture; a uniform 0..1 face uv would look stretched on a 22 m hangar.
 *  - Everything is flat-shaded: chamfered blocks + faceted normals are what gives the
 *    "modern low-poly" read. No image assets, no outlines.
 */

import * as THREE from 'three';
import { TEAM_COLORS } from '../types';
import type { MatKey, SurfaceLibrary, TeamId } from '../types';

/* --------------------------------------------------------------------- rng */

export interface Rng {
  (): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  /** -1 or +1. */
  sign(): number;
  /** True with probability p. */
  chance(p: number): boolean;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed: number): Rng {
  const f = mulberry32(seed) as Rng;
  f.range = (lo: number, hi: number): number => lo + (hi - lo) * f();
  f.int = (lo: number, hi: number): number => Math.min(hi, Math.floor(lo + (hi - lo + 1) * f()));
  f.pick = <T>(items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(f() * items.length))];
  f.sign = (): number => (f() < 0.5 ? -1 : 1);
  f.chance = (p: number): boolean => f() < p;
  return f;
}

/* ------------------------------------------------------------------- maths */

export type V3 = readonly [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ---------------------------------------------------------------- geometry */

const geoCache = new Map<string, THREE.BufferGeometry>();

export function cachedGeometry(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = geoCache.get(key);
  if (hit) return hit;
  const g = build();
  geoCache.set(key, g);
  return g;
}

export function disposeGeometryCache(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
}

/**
 * Per-triangle planar UV bake in metres: every triangle is projected on its dominant
 * axis and scaled by the model's metre-per-unit factors. Cheap, seam-free enough for
 * low-poly blocks and it keeps texture density constant across wildly different sizes.
 */
export function bakeMetricUV(geo: THREE.BufferGeometry, s: V3): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let t = 0; t < pos.count; t += 3) {
    const ax = pos.getX(t);
    const ay = pos.getY(t);
    const az = pos.getZ(t);
    const bx = pos.getX(t + 1);
    const by = pos.getY(t + 1);
    const bz = pos.getZ(t + 1);
    const cx = pos.getX(t + 2);
    const cy = pos.getY(t + 2);
    const cz = pos.getZ(t + 2);
    const n = cross(
      [bx - ax, by - ay, bz - az],
      [cx - ax, cy - ay, cz - az],
    );
    const nx = Math.abs(n[0]);
    const ny = Math.abs(n[1]);
    const nz = Math.abs(n[2]);
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      let u: number;
      let v: number;
      if (nx >= ny && nx >= nz) {
        u = z * s[2];
        v = y * s[1];
      } else if (ny >= nz) {
        u = x * s[0];
        v = z * s[2];
      } else {
        u = x * s[0];
        v = y * s[1];
      }
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (g !== geo) {
    geo.dispose();
    return g;
  }
  return g;
}

function pushTri(out: number[], a: V3, b: V3, c: V3): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/** Triangle with a guaranteed outward winding with respect to `n`. */
function pushTriOut(out: number[], a: V3, b: V3, c: V3, n: V3): void {
  if (dot(cross(sub(b, a), sub(c, a)), n) < 0) pushTri(out, a, c, b);
  else pushTri(out, a, b, c);
}

function quad(out: number[], a: V3, b: V3, c: V3, d: V3, n: V3): void {
  if (dot(cross(sub(b, a), sub(c, a)), n) < 0) {
    pushTri(out, a, d, c);
    pushTri(out, a, c, b);
  } else {
    pushTri(out, a, b, c);
    pushTri(out, a, c, d);
  }
}

function finish(out: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

/** Chamfered box: 6 faces + 12 edge bevels + 8 corner triangles = 44 tris. */
export function bevelBoxGeometry(w: number, h: number, d: number, bevel = 0.06): THREE.BufferGeometry {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const c = Math.max(0, Math.min(bevel, Math.min(hx, hy, hz) * 0.42));
  const out: number[] = [];
  const ax = hx - c;
  const ay = hy - c;
  const az = hz - c;
  const n = (x: number, y: number, z: number): V3 => [x, y, z];
  if (c <= 1e-6) {
    quad(out, [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz], n(1, 0, 0));
    quad(out, [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz], n(-1, 0, 0));
    quad(out, [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz], n(0, 1, 0));
    quad(out, [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], n(0, -1, 0));
    quad(out, [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], n(0, 0, 1));
    quad(out, [hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], n(0, 0, -1));
    return finish(out);
  }
  quad(out, [hx, -ay, -az], [hx, ay, -az], [hx, ay, az], [hx, -ay, az], n(1, 0, 0));
  quad(out, [-hx, -ay, az], [-hx, ay, az], [-hx, ay, -az], [-hx, -ay, -az], n(-1, 0, 0));
  quad(out, [-ax, hy, az], [ax, hy, az], [ax, hy, -az], [-ax, hy, -az], n(0, 1, 0));
  quad(out, [-ax, -hy, -az], [ax, -hy, -az], [ax, -hy, az], [-ax, -hy, az], n(0, -1, 0));
  quad(out, [-ax, -ay, hz], [ax, -ay, hz], [ax, ay, hz], [-ax, ay, hz], n(0, 0, 1));
  quad(out, [ax, -ay, -hz], [-ax, -ay, -hz], [-ax, ay, -hz], [ax, ay, -hz], n(0, 0, -1));
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      quad(
        out,
        [-ax, sy * hy, sz * az],
        [ax, sy * hy, sz * az],
        [ax, sy * ay, sz * hz],
        [-ax, sy * ay, sz * hz],
        n(0, sy, sz),
      );
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      quad(
        out,
        [sx * hx, -ay, sz * az],
        [sx * hx, ay, sz * az],
        [sx * ax, ay, sz * hz],
        [sx * ax, -ay, sz * hz],
        n(sx, 0, sz),
      );
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      quad(
        out,
        [sx * hx, sy * ay, -az],
        [sx * hx, sy * ay, az],
        [sx * ax, sy * hy, az],
        [sx * ax, sy * hy, -az],
        n(sx, sy, 0),
      );
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pushTriOut(
          out,
          [sx * hx, sy * ay, sz * az],
          [sx * ax, sy * hy, sz * az],
          [sx * ax, sy * ay, sz * hz],
          n(sx, sy, sz),
        );
      }
    }
  }
  return finish(out);
}

/** Plain box, 12 tris — for greebles, frames, stripes and other cheap detail. */
export function rectGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const out: number[] = [];
  quad(out, [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz], [1, 0, 0]);
  quad(out, [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz], [-1, 0, 0]);
  quad(out, [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz], [0, 1, 0]);
  quad(out, [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [0, -1, 0]);
  quad(out, [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [0, 0, 1]);
  quad(out, [hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [0, 0, -1]);
  return finish(out);
}

/** Box with a scaled top face (bunkers, plinths, tapered towers). 12 tris. */
export function taperBoxGeometry(w: number, h: number, d: number, topX: number, topZ: number): THREE.BufferGeometry {
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const tx = hx * topX;
  const tz = hz * topZ;
  const out: number[] = [];
  quad(out, [-hx, -hy, hz], [hx, -hy, hz], [tx, hy, tz], [-tx, hy, tz], [0, 0, 1]);
  quad(out, [hx, -hy, -hz], [-hx, -hy, -hz], [-tx, hy, -tz], [tx, hy, -tz], [0, 0, -1]);
  quad(out, [hx, -hy, hz], [hx, -hy, -hz], [tx, hy, -tz], [tx, hy, tz], [1, 0, 0]);
  quad(out, [-hx, -hy, -hz], [-hx, -hy, hz], [-tx, hy, tz], [-tx, hy, -tz], [-1, 0, 0]);
  quad(out, [-tx, hy, tz], [tx, hy, tz], [tx, hy, -tz], [-tx, hy, -tz], [0, 1, 0]);
  quad(out, [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [0, -1, 0]);
  return finish(out);
}

/** Ridge tent / quonset prism: trapezoid cross-section in Z-Y, extruded along X. 12 tris. */
export function ridgeGeometry(w: number, h: number, d: number, ridgeFrac = 0.22): THREE.BufferGeometry {
  const hx = w / 2;
  const hz = d / 2;
  const tz = (d * ridgeFrac) / 2;
  const out: number[] = [];
  quad(out, [-hx, 0, hz], [hx, 0, hz], [hx, h, tz], [-hx, h, tz], [0, 0.4, 1]);
  quad(out, [hx, 0, -hz], [-hx, 0, -hz], [-hx, h, -tz], [hx, h, -tz], [0, 0.4, -1]);
  quad(out, [-hx, h, -tz], [hx, h, -tz], [hx, h, tz], [-hx, h, tz], [0, 1, 0]);
  quad(out, [-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz], [0, -1, 0]);
  quad(out, [hx, 0, hz], [hx, 0, -hz], [hx, h, -tz], [hx, h, tz], [1, 0, 0]);
  quad(out, [-hx, 0, -hz], [-hx, 0, hz], [-hx, h, tz], [-hx, h, -tz], [-1, 0, 0]);
  return finish(out);
}

/** Half-cylinder shell (hangar roof), axis along X, open at the bottom. */
export function shellGeometry(w: number, r: number, seg = 10, thickness = 0): THREE.BufferGeometry {
  const out: number[] = [];
  const hx = w / 2;
  const inner = Math.max(0.01, r - thickness);
  const pt = (i: number, rad: number): readonly [number, number] => {
    const a = (i / seg) * Math.PI;
    return [Math.cos(a) * rad, Math.sin(a) * rad];
  };
  for (let i = 0; i < seg; i++) {
    const [z0, y0] = pt(i, r);
    const [z1, y1] = pt(i + 1, r);
    quad(
      out,
      [-hx, y0, z0],
      [hx, y0, z0],
      [hx, y1, z1],
      [-hx, y1, z1],
      [0, (y0 + y1) / 2, (z0 + z1) / 2],
    );
    if (thickness > 0) {
      const [iz0, iy0] = pt(i, inner);
      const [iz1, iy1] = pt(i + 1, inner);
      quad(
        out,
        [-hx, iy0, iz0],
        [-hx, iy1, iz1],
        [hx, iy1, iz1],
        [hx, iy0, iz0],
        [0, -(iy0 + iy1) / 2, -(iz0 + iz1) / 2],
      );
      quad(out, [-hx, iy0, iz0], [hx, iy0, iz0], [hx, y0, z0], [-hx, y0, z0], [0, -1, 0.4]);
      quad(out, [hx, iy1, iz1], [-hx, iy1, iz1], [-hx, y1, z1], [hx, y1, z1], [0, 1, 0.4]);
    }
  }
  if (thickness <= 0) {
    quad(out, [-hx, 0, -r], [hx, 0, -r], [hx, 0, r], [-hx, 0, r], [0, -1, 0]);
  }
  return finish(out);
}

/* --------------------------------------------------------------- materials */

export interface MatOpts {
  /** Use the flat key colour instead of a team tint. */
  color?: number | null;
  /** Faceted normals (default true). */
  flat?: boolean;
  /** Painted-on decal: polygon offset, no shadow casting. */
  decal?: boolean;
  side?: THREE.Side;
  rough?: number;
  metal?: number;
  emissive?: number;
  emissiveIntensity?: number;
  opacity?: number;
  /** Unlit-ish look for far LODs / netting. */
  basic?: boolean;
}

const libCaches = new WeakMap<SurfaceLibrary, SurfaceCache>();

export class SurfaceCache {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();

  constructor(private readonly lib: SurfaceLibrary) {}

  get(key: MatKey, opts: MatOpts = {}): THREE.MeshStandardMaterial {
    const flat = opts.flat !== false;
    const id = [
      key,
      opts.color ?? -1,
      flat ? 1 : 0,
      opts.decal ? 1 : 0,
      opts.side ?? THREE.FrontSide,
      opts.rough ?? -1,
      opts.metal ?? -1,
      opts.emissive ?? -1,
      opts.emissiveIntensity ?? -1,
      opts.opacity ?? -1,
    ].join('|');
    const hit = this.cache.get(id);
    if (hit) return hit;
    const params: THREE.MeshStandardMaterialParameters = { flatShading: flat };
    if (opts.color !== undefined && opts.color !== null) params.color = opts.color;
    if (opts.side !== undefined) params.side = opts.side;
    if (opts.rough !== undefined) params.roughness = opts.rough;
    if (opts.metal !== undefined) params.metalness = opts.metal;
    if (opts.emissive !== undefined) params.emissive = opts.emissive;
    if (opts.emissiveIntensity !== undefined) params.emissiveIntensity = opts.emissiveIntensity;
    if (opts.opacity !== undefined) {
      params.opacity = opts.opacity;
      params.transparent = true;
    }
    if (opts.decal) {
      params.polygonOffset = true;
      params.polygonOffsetFactor = -2;
      params.polygonOffsetUnits = -2;
    }
    const m = this.lib.clone(key, params);
    this.cache.set(id, m);
    return m;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}

export function surfacesFor(lib: SurfaceLibrary): SurfaceCache {
  let c = libCaches.get(lib);
  if (!c) {
    c = new SurfaceCache(lib);
    libCaches.set(lib, c);
  }
  return c;
}

/**
 * Team tint is a *lightened* mix of `TEAM_COLORS` (which are the saturated HUD colours)
 * so the procedural surface maps still read through: olive-drab for team 0, signal red
 * for team 1.
 */
export function teamTint(team: TeamId, mix = 0.46): number {
  const base = new THREE.Color(TEAM_COLORS[team] ?? TEAM_COLORS[0]);
  const white = new THREE.Color(0xffffff);
  return base.lerp(white, mix).getHex();
}

const IDENTITY: V3 = [1, 1, 1];

/* ---------------------------------------------------------------- the kit */

export interface PartOptions {
  rot?: V3;
  scale?: V3;
  name?: string;
  cast?: boolean;
  receive?: boolean;
  noShadow?: boolean;
}

/**
 * Authoring helper bound to one model build: holds the surface library, the team, the
 * deterministic rng and the metre-per-local-unit UV factors of the model being built.
 */
export class Kit {
  readonly cache: SurfaceCache;
  readonly rng: Rng;
  /** Metres per local unit on each axis — used to bake metric UVs. */
  readonly uv: V3;
  readonly team: TeamId;

  constructor(
    readonly lib: SurfaceLibrary,
    team: TeamId,
    seed: number,
    uv: V3 = IDENTITY,
  ) {
    this.team = team;
    this.cache = surfacesFor(lib);
    this.rng = makeRng(seed);
    this.uv = uv;
  }

  /* ---- materials */

  mat(key: MatKey, opts: MatOpts = {}): THREE.MeshStandardMaterial {
    return this.cache.get(key, opts);
  }

  /** Team-tinted structural material (olive / red). */
  teamMat(key: MatKey, opts: MatOpts = {}): THREE.MeshStandardMaterial {
    return this.cache.get(key, { ...opts, color: opts.color ?? teamTint(this.team) });
  }

  /* ---- geometry (cached per shape + uv scale) */

  private key(shape: string): string {
    return `${shape}@${this.uv[0]},${this.uv[1]},${this.uv[2]}`;
  }

  gBox(w: number, h: number, d: number, bevel = 0.06): THREE.BufferGeometry {
    const b = Math.min(bevel, Math.max(0.004, Math.min(w, h, d) * 0.2));
    return cachedGeometry(this.key(`bx:${w.toFixed(4)},${h.toFixed(4)},${d.toFixed(4)},${b.toFixed(4)}`), () =>
      bakeMetricUV(bevelBoxGeometry(w, h, d, b), this.uv),
    );
  }

  gTaper(w: number, h: number, d: number, topX: number, topZ: number): THREE.BufferGeometry {
    return cachedGeometry(this.key(`tp:${w.toFixed(4)},${h.toFixed(4)},${d.toFixed(4)},${topX},${topZ}`), () =>
      bakeMetricUV(taperBoxGeometry(w, h, d, topX, topZ), this.uv),
    );
  }

  /** Plain un-beveled box (12 tris) — panel lines, frames, stripes, bolts. */
  gRect(w: number, h: number, d: number): THREE.BufferGeometry {
    return cachedGeometry(this.key(`rc:${w.toFixed(4)},${h.toFixed(4)},${d.toFixed(4)}`), () =>
      bakeMetricUV(rectGeometry(w, h, d), this.uv),
    );
  }

  gRidge(w: number, h: number, d: number, ridgeFrac = 0.22): THREE.BufferGeometry {
    return cachedGeometry(this.key(`rg:${w.toFixed(4)},${h.toFixed(4)},${d.toFixed(4)},${ridgeFrac}`), () =>
      bakeMetricUV(ridgeGeometry(w, h, d, ridgeFrac), this.uv),
    );
  }

  gShell(w: number, r: number, seg = 10, thickness = 0): THREE.BufferGeometry {
    return cachedGeometry(this.key(`sh:${w.toFixed(4)},${r.toFixed(4)},${seg},${thickness}`), () =>
      bakeMetricUV(shellGeometry(w, r, seg, thickness), this.uv),
    );
  }

  gCyl(rTop: number, rBot: number, h: number, seg = 10, open = false): THREE.BufferGeometry {
    return cachedGeometry(this.key(`cy:${rTop},${rBot},${h},${seg},${open ? 1 : 0}`), () =>
      bakeMetricUV(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open), this.uv),
    );
  }

  gIco(r: number, detail = 1): THREE.BufferGeometry {
    return cachedGeometry(this.key(`ic:${r},${detail}`), () => bakeMetricUV(new THREE.IcosahedronGeometry(r, detail), this.uv));
  }

  gLathe(profile: readonly (readonly [number, number])[], seg = 12): THREE.BufferGeometry {
    const k = profile.map((p) => `${p[0]},${p[1]}`).join(';');
    return cachedGeometry(this.key(`la:${k},${seg}`), () => {
      const pts = profile.map((p) => new THREE.Vector2(p[0], p[1]));
      return bakeMetricUV(new THREE.LatheGeometry(pts, seg), this.uv);
    });
  }

  gPlane(w: number, h: number, sw = 1, sh = 1): THREE.BufferGeometry {
    return cachedGeometry(this.key(`pl:${w},${h},${sw},${sh}`), () =>
      bakeMetricUV(new THREE.PlaneGeometry(w, h, sw, sh), this.uv),
    );
  }

  /* ---- meshes */

  /** Beveled box centred on (x, y, z). */
  box(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gBox(w, h, d), mat, x, y, z, o);
  }

  /** Beveled box whose base sits at `y`. */
  boxOn(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gBox(w, h, d), mat, x, y + h / 2, z, o);
  }

  /** Plain box centred on (x, y, z). Cheap detail geometry. */
  rect(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gRect(w, h, d), mat, x, y, z, o);
  }

  /** Plain box whose base sits at `y`. */
  rectOn(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gRect(w, h, d), mat, x, y + h / 2, z, o);
  }

  taperOn(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, topX: number, topZ: number, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gTaper(w, h, d, topX, topZ), mat, x, y + h / 2, z, o);
  }

  ridgeOn(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, ridgeFrac: number, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gRidge(w, h, d, ridgeFrac), mat, x, y, z, o);
  }

  /** Cylinder with its base at `y`. */
  cyl(parent: THREE.Object3D, mat: THREE.Material, rTop: number, rBot: number, h: number, x = 0, y = 0, z = 0, seg = 10, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gCyl(rTop, rBot, h, seg), mat, x, y + h / 2, z, o);
  }

  /** Cylinder with its CENTRE at (x, y, z) — the one to use for rotated (horizontal) cylinders. */
  cylC(parent: THREE.Object3D, mat: THREE.Material, rTop: number, rBot: number, h: number, x = 0, y = 0, z = 0, seg = 10, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gCyl(rTop, rBot, h, seg), mat, x, y, z, o);
  }

  ico(parent: THREE.Object3D, mat: THREE.Material, r: number, detail: number, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gIco(r, detail), mat, x, y, z, o);
  }

  lathe(parent: THREE.Object3D, mat: THREE.Material, profile: readonly (readonly [number, number])[], seg: number, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.mesh(parent, this.gLathe(profile, seg), mat, x, y, z, o);
  }

  /** Thin strut/brace/cable between two local points. */
  strut(parent: THREE.Object3D, mat: THREE.Material, a: V3, b: V3, t: number, o: PartOptions = {}): THREE.Mesh {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    const mesh = this.mesh(
      parent,
      this.gRect(1, 1, 1),
      mat,
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
      (a[2] + b[2]) / 2,
      o,
    );
    mesh.scale.set(t, Math.max(len, 1e-4), t);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
  }

  mesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (o.rot) m.rotation.set(o.rot[0], o.rot[1], o.rot[2]);
    if (o.scale) m.scale.set(o.scale[0], o.scale[1], o.scale[2]);
    if (o.name) m.name = o.name;
    const shadow = o.noShadow !== true && o.cast !== false;
    m.castShadow = shadow;
    m.receiveShadow = o.receive !== false;
    parent.add(m);
    return m;
  }

  group(parent: THREE.Object3D, x = 0, y = 0, z = 0, name?: string): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    if (name) g.name = name;
    parent.add(g);
    return g;
  }

  /* ---- composite details ------------------------------------------- */

  /** Blinking hazard beacon on a short stalk. */
  beacon(parent: THREE.Object3D, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Group {
    const g = this.group(parent, x, y, z);
    this.cyl(g, this.cache.get('metalDark'), 0.04, 0.06, 0.22, 0, 0, 0, 6);
    this.ico(g, mat, 0.11, 1, 0, 0.3, 0);
    return g;
  }

  /** Painted stripe run: alternating hazard blocks along X. */
  hazardStripes(parent: THREE.Object3D, mat: THREE.Material, len: number, w: number, t: number, x: number, y: number, z: number, count = 6, yaw = 0): THREE.Group {
    const g = this.group(parent, x, y, z);
    g.rotation.y = yaw;
    const step = len / count;
    for (let i = 0; i < count; i++) {
      if (i % 2 === 1) continue;
      this.rect(g, mat, step * 0.92, t, w, -len / 2 + step * (i + 0.5), 0, 0, { noShadow: true });
    }
    return g;
  }

  /** Guard rail: two rails + posts, running along X. */
  rail(parent: THREE.Object3D, mat: THREE.Material, len: number, x: number, yBase: number, z: number, h = 0.95, yaw = 0, posts = 4): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    g.rotation.y = yaw;
    this.rect(g, mat, len, 0.06, 0.05, 0, h, 0);
    this.rect(g, mat, len, 0.05, 0.04, 0, h * 0.55, 0);
    for (let i = 0; i <= posts; i++) {
      const px = -len / 2 + (len * i) / posts;
      this.rect(g, mat, 0.07, h, 0.07, px, h / 2, 0);
    }
    return g;
  }

  /** Ladder with stringers + rungs; climbs +Y at (x, z), facing +Z. */
  ladder(parent: THREE.Object3D, mat: THREE.Material, h: number, x: number, yBase: number, z: number, w = 0.42, yaw = 0): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    g.rotation.y = yaw;
    this.rect(g, mat, 0.05, h, 0.05, -w / 2, h / 2, 0);
    this.rect(g, mat, 0.05, h, 0.05, w / 2, h / 2, 0);
    const rungs = Math.max(2, Math.floor(h / 0.3));
    for (let i = 1; i < rungs; i++) {
      this.rect(g, mat, w, 0.035, 0.035, 0, (h * i) / rungs, 0);
    }
    return g;
  }

  /** Ladder safety cage hoops. */
  ladderCage(parent: THREE.Object3D, mat: THREE.Material, h: number, x: number, yBase: number, z: number, r = 0.36, yaw = 0): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    g.rotation.y = yaw;
    const hoops = Math.max(2, Math.floor(h / 0.9));
    for (let i = 1; i <= hoops; i++) {
      const y = (h * i) / (hoops + 1);
      const segments = 7;
      for (let s = 0; s < segments; s++) {
        const a0 = Math.PI * (0.15 + (0.7 * s) / segments);
        const a1 = Math.PI * (0.15 + (0.7 * (s + 1)) / segments);
        this.strut(
          g,
          mat,
          [Math.cos(a0) * r - r, y, Math.sin(a0) * r],
          [Math.cos(a1) * r - r, y, Math.sin(a1) * r],
          0.03,
        );
      }
      if (i < hoops) {
        this.strut(g, mat, [-2 * r, y, r], [-2 * r, y + h / (hoops + 1), r], 0.03);
        this.strut(g, mat, [0, y, r], [0, y + h / (hoops + 1), r], 0.03);
      }
    }
    return g;
  }

  /** Four-legged lattice mast with X bracing and a top plate. */
  latticeMast(parent: THREE.Object3D, mat: THREE.Material, h: number, spread: number, x: number, yBase: number, z: number, segments = 4, leg = 0.09): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    const s = spread / 2;
    const corners: V3[] = [
      [-s, 0, -s],
      [s, 0, -s],
      [s, 0, s],
      [-s, 0, s],
    ];
    for (const c of corners) {
      this.box(g, mat, leg, h, leg, c[0], h / 2, c[2]);
    }
    for (let i = 0; i < segments; i++) {
      const y0 = (h * i) / segments;
      const y1 = (h * (i + 1)) / segments;
      for (let c = 0; c < 4; c++) {
        const a = corners[c];
        const b = corners[(c + 1) % 4];
        this.rect(g, mat, 0.05, 0.05, Math.hypot(b[0] - a[0], b[2] - a[2]), (a[0] + b[0]) / 2, y1 - 0.04, (a[2] + b[2]) / 2, {
          rot: [0, Math.atan2(b[0] - a[0], b[2] - a[2]), 0],
        });
      }
      const flip = i % 2 === 0;
      for (let c = 0; c < 4; c++) {
        const a = corners[c];
        const b = corners[(c + 1) % 4];
        const from: V3 = flip ? [a[0], y0, a[2]] : [b[0], y0, b[2]];
        const to: V3 = flip ? [b[0], y1, b[2]] : [a[0], y1, a[2]];
        this.strut(g, mat, from, to, 0.035);
      }
    }
    return g;
  }

  /** Sandbag wall: jittered stacked bags, `rows` high, running along X. */
  sandbagWall(parent: THREE.Object3D, mat: THREE.Material, len: number, rows: number, x: number, yBase: number, z: number, bagW = 0.62, bagH = 0.24, bagD = 0.4, yaw = 0): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    g.rotation.y = yaw;
    const get = (i: number, row: number) => {
      const t = (i + (row % 2 ? 0.5 : 0)) * bagW;
      const jx = (this.rng() - 0.5) * bagW * 0.08;
      const jz = (this.rng() - 0.5) * bagD * 0.2;
      const jr = (this.rng() - 0.5) * 0.22;
      const y = row * bagH * 0.88 + bagH / 2;
      return { x: -len / 2 + t + jx, y, z: jz, r: jr };
    };
    const perRow = Math.ceil(len / bagW);
    for (let row = 0; row < rows; row++) {
      for (let i = 0; i < perRow; i++) {
        const p = get(i, row);
        if (p.x > len / 2 + bagW * 0.2) continue;
        this.rect(g, mat, bagW * 1.06, bagH, bagD, p.x, p.y, p.z, {
          rot: [0, p.r, (this.rng() - 0.5) * 0.12],
        });
      }
    }
    return g;
  }

  /** Curved sandbag parapet (sangar) around a circle. */
  sandbagRing(parent: THREE.Object3D, mat: THREE.Material, radius: number, rows: number, x: number, yBase: number, z: number, bagW = 0.66, bagH = 0.25): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    const around = Math.max(6, Math.round((2 * Math.PI * radius) / bagW));
    for (let row = 0; row < rows; row++) {
      const r = radius - row * 0.06;
      for (let i = 0; i < around; i++) {
        const a = ((i + (row % 2 ? 0.5 : 0)) / around) * Math.PI * 2;
        this.rect(
          g,
          mat,
          bagW * 1.08,
          bagH,
          bagW * 0.62,
          Math.cos(a) * r + (this.rng() - 0.5) * 0.06,
          row * bagH * 0.85 + bagH / 2,
          Math.sin(a) * r + (this.rng() - 0.5) * 0.06,
          { rot: [0, -a + (this.rng() - 0.5) * 0.4, (this.rng() - 0.5) * 0.15] },
        );
      }
    }
    return g;
  }

  /** Camo netting: low-poly sagging sheet on poles. Geometry is per-call (random sag). */
  net(parent: THREE.Object3D, mat: THREE.Material, w: number, d: number, x: number, y: number, z: number, sag = 0.35, poles = true): THREE.Group {
    const g = this.group(parent, x, y, z);
    const nx = Math.max(2, Math.round(w / 1.6));
    const nz = Math.max(2, Math.round(d / 1.6));
    const geo = bakeMetricUV(new THREE.PlaneGeometry(w, d, nx, nz), this.uv);
    const sheet = this.mesh(g, geo, mat, 0, 0, 0, { rot: [-Math.PI / 2, 0, 0], noShadow: false });
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const pz = pos.getY(i);
      const fade = Math.cos((px / w) * Math.PI) * Math.cos((pz / d) * Math.PI);
      pos.setZ(i, sag * (1 - Math.max(0, fade)) + (this.rng() - 0.5) * 0.05);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    sheet.receiveShadow = true;
    if (poles) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          this.cyl(g, this.cache.get('metalDark'), 0.045, 0.055, 0.6, (sx * w) / 2, sag * 0.6, (sz * d) / 2, 6);
        }
      }
    }
    return g;
  }

  /** Irregular dark disc painted on the ground (oil / fuel spill). Per-call geometry. */
  oilStain(parent: THREE.Object3D, x: number, z: number, r: number, y = 0.012, yaw = 0): THREE.Mesh {
    const seg = 9;
    const pos: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const rr = r * (0.72 + this.rng() * 0.5);
      const r1 = r * (0.72 + this.rng() * 0.5);
      pushTriOut(
        pos,
        [0, 0, 0],
        [Math.cos(a0) * rr, 0, Math.sin(a0) * rr],
        [Math.cos(a1) * r1, 0, Math.sin(a1) * r1],
        [0, 1, 0],
      );
    }
    const geo = bakeMetricUV(finish(pos), this.uv);
    return this.mesh(parent, geo, this.cache.get('scorch', { decal: true, rough: 0.95, metal: 0 }), x, y, z, {
      rot: [0, yaw, 0],
      noShadow: true,
      receive: true,
    });
  }

  /** Twisted rebar / cable bundle poking out of rubble. */
  rebar(parent: THREE.Object3D, mat: THREE.Material, x: number, yBase: number, z: number, len: number, count = 4, spread = 0.16): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + this.rng() * 0.6;
      const tilt = 0.25 + this.rng() * 0.7;
      const l = len * (0.6 + this.rng() * 0.6);
      this.strut(
        g,
        mat,
        [Math.cos(a) * spread * 0.4, 0, Math.sin(a) * spread * 0.4],
        [Math.cos(a) * l * Math.sin(tilt), l * Math.cos(tilt), Math.sin(a) * l * Math.sin(tilt)],
        0.028,
      );
    }
    return g;
  }

  /** Loose rubble pile of faceted chunks. */
  rubble(parent: THREE.Object3D, mat: THREE.Material, r: number, x: number, yBase: number, z: number, count = 12): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    for (let i = 0; i < count; i++) {
      const a = this.rng() * Math.PI * 2;
      const d = Math.sqrt(this.rng()) * r;
      const s = r * (0.1 + this.rng() * 0.22);
      const m = this.ico(g, mat, s, 0, Math.cos(a) * d, s * (0.5 + this.rng() * 0.4), Math.sin(a) * d, {
        rot: [this.rng() * 3, this.rng() * 3, this.rng() * 3],
        scale: [1, 0.6 + this.rng() * 0.4, 0.8 + this.rng() * 0.5],
      });
      m.castShadow = true;
    }
    return g;
  }

  /** Broken wall stub: a few jagged slabs of decreasing height. */
  brokenWall(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x: number, yBase: number, z: number, yaw = 0): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    g.rotation.y = yaw;
    const chunks = Math.max(3, Math.round(w / 0.9));
    for (let i = 0; i < chunks; i++) {
      const cw = w / chunks;
      const cx = -w / 2 + cw * (i + 0.5);
      const hh = h * (0.25 + this.rng() * 0.75);
      this.rectOn(g, mat, cw * 0.98, hh, d, cx, 0, (this.rng() - 0.5) * d * 0.25, {
        rot: [0, (this.rng() - 0.5) * 0.25, (this.rng() - 0.5) * 0.05],
      });
    }
    return g;
  }

  /** Stack of tyres. */
  tyreStack(parent: THREE.Object3D, mat: THREE.Material, r: number, count: number, x: number, yBase: number, z: number): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    for (let i = 0; i < count; i++) {
      this.cyl(g, mat, r, r, r * 0.42, (this.rng() - 0.5) * 0.08, i * r * 0.42, (this.rng() - 0.5) * 0.08, 10);
    }
    return g;
  }

  /** Cable drum, lying on its side. */
  cableDrum(parent: THREE.Object3D, mat: THREE.Material, r: number, x: number, yBase: number, z: number, yaw = 0): THREE.Group {
    const g = this.group(parent, x, yBase + r, z);
    g.rotation.set(0, yaw, Math.PI / 2);
    this.cyl(g, mat, r, r, r * 1.1, 0, -r * 0.55, 0, 10);
    this.cyl(g, mat, r * 0.82, r * 0.82, r * 1.2, 0, -r * 0.6, 0, 10);
    return g;
  }

  /** Wall-mounted AC / chiller unit with fan grille + pipes. */
  aircon(parent: THREE.Object3D, mat: THREE.Material, dark: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0): THREE.Group {
    const g = this.group(parent, x, y, z);
    g.rotation.y = yaw;
    this.rect(g, mat, w, h, d, 0, 0, 0);
    this.rect(g, dark, w * 0.7, h * 0.62, d * 0.12, 0, 0, d / 2);
    this.rect(g, dark, w * 0.08, h * 0.4, d * 0.1, 0, 0, d / 2 + d * 0.06);
    this.rect(g, dark, w * 0.9, h * 0.06, d * 0.1, 0, -h * 0.4, d / 2 + d * 0.05);
    return g;
  }

  /** Flat roof hatch: rim + lid + hinge. */
  roofHatch(parent: THREE.Object3D, mat: THREE.Material, dark: THREE.Material, r: number, x: number, y: number, z: number): THREE.Group {
    const g = this.group(parent, x, y, z);
    this.cyl(g, dark, r, r, 0.1, 0, 0, 0, 10);
    this.cyl(g, mat, r * 0.9, r * 0.9, 0.08, 0, 0.1, 0, 10);
    this.rect(g, mat, r * 0.5, 0.05, 0.09, 0, 0.2, -r * 0.5);
    return g;
  }

  /** Floodlight on a short mast, aimed along +Z. */
  floodlight(parent: THREE.Object3D, mat: THREE.Material, dark: THREE.Material, x: number, yBase: number, z: number, h = 2.4, yaw = 0): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    g.rotation.y = yaw;
    this.cyl(g, dark, 0.07, 0.09, h, 0, 0, 0, 8);
    this.rect(g, mat, 0.46, 0.3, 0.3, 0, h + 0.12, 0.06, { rot: [0.35, 0, 0] });
    this.rect(g, dark, 0.5, 0.1, 0.34, 0, h - 0.02, 0, { rot: [0.35, 0, 0] });
    this.box(
      g,
      this.cache.get('metalPainted', { color: 0xf2ead2, emissive: 0xfff0c0, emissiveIntensity: 0.6, rough: 0.4 }),
      0.4,
      0.22,
      0.04,
      0,
      h + 0.16,
      0.2,
      { rot: [0.35, 0, 0], noShadow: true },
    );
    return g;
  }

  /** Painted warning sign: post + board with a hazard band. */
  sign(parent: THREE.Object3D, board: THREE.Material, post: THREE.Material, hazard: THREE.Material, x: number, yBase: number, z: number, w = 0.7, h = 0.5, yaw = 0): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    g.rotation.y = yaw;
    this.rect(g, post, 0.06, 1.1, 0.06, 0, 0.55, 0);
    this.rect(g, board, w, h, 0.05, 0, 1.28, 0.03);
    this.rect(g, hazard, w * 0.94, h * 0.22, 0.02, 0, 1.15, 0.06, { noShadow: true });
    return g;
  }

  /** Wooden crate with slat frame + stencil block. */
  crate(parent: THREE.Object3D, mat: THREE.Material, dark: THREE.Material, s: number, x: number, yBase: number, z: number, yaw = 0, stretch: V3 = [1, 1, 1]): THREE.Group {
    const g = this.group(parent, x, yBase, z);
    g.rotation.y = yaw;
    const w = s * stretch[0];
    const h = s * 0.9 * stretch[1];
    const d = s * stretch[2];
    this.boxOn(g, mat, w, h, d, 0, 0, 0);
    const t = s * 0.09;
    for (const sy of [0.18, 0.82]) {
      this.rect(g, dark, w * 1.01, t, d * 1.01, 0, h * sy, 0);
    }
    for (const sx of [-0.42, 0.42]) {
      this.rect(g, dark, t, h * 0.96, d * 1.01, w * sx, h / 2, 0);
    }
    this.rect(g, dark, w * 0.3, h * 0.22, 0.01, w * 0.12, h * 0.55, d / 2 + 0.006, { noShadow: true });
    return g;
  }

  /** Ridge tent of canvas over a frame, with a rolled entrance flap at +X. */
  tentBody(parent: THREE.Object3D, canvas: THREE.Material, frame: THREE.Material, w: number, h: number, d: number, ridgeFrac = 0.24): THREE.Group {
    const g = new THREE.Group();
    parent.add(g);
    this.ridgeOn(g, canvas, w, h, d, ridgeFrac, 0, 0, 0);
    this.ridgeOn(g, frame, w * 0.995, h * 0.99, d * 0.94, ridgeFrac, 0, 0.02, 0, { scale: [0.99, 0.97, 0.9] });
    this.rect(g, frame, 0.08, h, 0.08, -w / 2 + 0.06, h / 2, 0);
    this.rect(g, frame, 0.08, h, 0.08, w / 2 - 0.06, h / 2, 0);
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        this.strut(g, frame, [sx * w * 0.46, 0, sz * d * 0.46], [sx * w * 0.72, 0, sz * d * 0.72], 0.03);
      }
    }
    this.cylC(g, canvas, d * 0.1, d * 0.1, h * 0.55, w / 2 - 0.02, h * 0.28, 0, 8, { rot: [0, 0, Math.PI / 2] });
    return g;
  }

  /**
   * Painted chevron / arrow marking lying on the ground, pointing +X.
   */
  groundArrow(parent: THREE.Object3D, mat: THREE.Material, len: number, w: number, x: number, y: number, z: number, yaw = 0): THREE.Group {
    const g = this.group(parent, x, y, z);
    g.rotation.y = yaw;
    this.box(g, mat, len * 0.62, 0.02, w, -len * 0.19, 0, 0, { noShadow: true });
    this.box(g, mat, len * 0.2, 0.02, w * 1.6, len * 0.12, 0, 0, { noShadow: true });
    this.box(g, mat, len * 0.2, 0.02, w * 0.9, len * 0.3, 0, 0, { noShadow: true, rot: [0, 0.5, 0] });
    this.box(g, mat, len * 0.2, 0.02, w * 0.9, len * 0.3, 0, 0, { noShadow: true, rot: [0, -0.5, 0] });
    return g;
  }
}

/* ------------------------------------------------------------- utilities */

/** Triangle count of a built model (used by the previews + budget checks). */
export function countTriangles(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry;
    const index = geo.getIndex();
    const pos = geo.getAttribute('position');
    if (!pos) return;
    tris += (index ? index.count : pos.count) / 3;
  });
  return Math.round(tris);
}

/** Deep-clone-free scene attach helper that mirrors a structure instance (see previews). */
export function syncTransform(from: THREE.Object3D, to: THREE.Object3D): void {
  to.position.copy(from.position);
  to.quaternion.copy(from.quaternion);
  to.scale.copy(from.scale);
}
