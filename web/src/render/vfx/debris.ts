/**
 * Debris pool — arcing chunks of metal and dirt that bounce off the terrain, settle and
 * fade. One `InstancedMesh` draw call, `MeshStandardMaterial` so chunks are lit (and shaded)
 * by the scene's real sun instead of a hand-rolled term.
 */
import * as THREE from 'three';
import { clamp, makeRng } from './rand.js';

/** Deterministic tumble/orientation so a given spawn always looks the same. */
const rnd = makeRng(0x5eed1);

export interface DebrisSpawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  size: number;
  /** Radians/second of tumble. */
  spin: number;
  life: number;
  groundY: number;
  bounce: number;
  /** Instance tint (multiplies the material map). */
  color: THREE.Color;
}

export class DebrisPool {
  readonly mesh: THREE.InstancedMesh;
  count = 0;
  private cap: number;
  private limit: number;
  private cursor = 0;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly rx: Float32Array;
  private readonly ry: Float32Array;
  private readonly rz: Float32Array;
  private readonly wx: Float32Array;
  private readonly wy: Float32Array;
  private readonly wz: Float32Array;
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly sz: Float32Array;
  private readonly age: Float32Array;
  private readonly ttl: Float32Array;
  private readonly gy: Float32Array;
  private readonly bounce: Float32Array;
  private readonly settled: Uint8Array;

  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  constructor(capacity: number, material: THREE.Material) {
    const cap = Math.max(1, capacity | 0);
    this.cap = cap;
    this.limit = cap;
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.rx = new Float32Array(cap);
    this.ry = new Float32Array(cap);
    this.rz = new Float32Array(cap);
    this.wx = new Float32Array(cap);
    this.wy = new Float32Array(cap);
    this.wz = new Float32Array(cap);
    this.sx = new Float32Array(cap);
    this.sy = new Float32Array(cap);
    this.sz = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.ttl = new Float32Array(cap);
    this.gy = new Float32Array(cap);
    this.bounce = new Float32Array(cap);
    this.settled = new Uint8Array(cap);
    for (let i = 0; i < cap; i++) this.ttl[i] = 1;

    const geo = new THREE.DodecahedronGeometry(0.5, 0);
    this.mesh = new THREE.InstancedMesh(geo, material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.name = 'vfx-debris';
    // Seed every instance with a colour so instanceColor exists from frame one.
    for (let i = 0; i < cap; i++) this.mesh.setColorAt(i, this.color.setRGB(1, 1, 1));
    if (this.mesh.instanceColor) this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  setLimit(n: number): void {
    this.limit = clamp(n | 0, 4, this.cap);
    if (this.count > this.limit) this.count = this.limit;
  }

  setShadows(on: boolean): void {
    this.mesh.castShadow = on;
  }

  spawn(d: DebrisSpawn): number {
    let slot: number;
    if (this.count < this.limit) {
      slot = this.count++;
    } else {
      slot = this.cursor % this.limit;
      this.cursor = (slot + 1) % this.limit;
    }
    this.px[slot] = d.x;
    this.py[slot] = d.y;
    this.pz[slot] = d.z;
    this.vx[slot] = d.vx;
    this.vy[slot] = d.vy;
    this.vz[slot] = d.vz;
    this.rx[slot] = rnd() * 6.283;
    this.ry[slot] = rnd() * 6.283;
    this.rz[slot] = rnd() * 6.283;
    const spin = d.spin;
    this.wx[slot] = (rnd() - 0.5) * spin * 2;
    this.wy[slot] = (rnd() - 0.5) * spin * 2;
    this.wz[slot] = (rnd() - 0.5) * spin * 2;
    this.sx[slot] = d.size * (0.7 + rnd() * 0.6);
    this.sy[slot] = d.size * (0.5 + rnd() * 0.7);
    this.sz[slot] = d.size * (0.7 + rnd() * 0.6);
    this.age[slot] = 0;
    this.ttl[slot] = Math.max(0.5, d.life);
    this.gy[slot] = d.groundY;
    this.bounce[slot] = d.bounce;
    this.settled[slot] = 0;
    this.mesh.setColorAt(slot, d.color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return slot;
  }

  private swapRemove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.px[i] = this.px[last];
      this.py[i] = this.py[last];
      this.pz[i] = this.pz[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.rx[i] = this.rx[last];
      this.ry[i] = this.ry[last];
      this.rz[i] = this.rz[last];
      this.wx[i] = this.wx[last];
      this.wy[i] = this.wy[last];
      this.wz[i] = this.wz[last];
      this.sx[i] = this.sx[last];
      this.sy[i] = this.sy[last];
      this.sz[i] = this.sz[last];
      this.age[i] = this.age[last];
      this.ttl[i] = this.ttl[last];
      this.gy[i] = this.gy[last];
      this.bounce[i] = this.bounce[last];
      this.settled[i] = this.settled[last];
      if (this.mesh.instanceColor) {
        this.color.fromBufferAttribute(this.mesh.instanceColor, last);
        this.mesh.setColorAt(i, this.color);
        this.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      const a = this.age[i] + dt;
      this.age[i] = a;
      if (a >= this.ttl[i]) {
        this.swapRemove(i);
        continue;
      }
      const t = a / this.ttl[i];
      // Shrink away over the last quarter of life so nothing pops.
      const shrink = t > 0.75 ? (1 - t) * 4 : 1;

      if (this.settled[i] === 0) {
        let vx = this.vx[i];
        let vy = this.vy[i];
        let vz = this.vz[i];
        vy -= 17 * dt;
        const drag = 1 - 0.35 * dt;
        vx *= drag;
        vy *= drag;
        vz *= drag;
        let x = this.px[i] + vx * dt;
        let y = this.py[i] + vy * dt;
        let z = this.pz[i] + vz * dt;
        const floor = this.gy[i] + this.sy[i] * 0.35;
        if (y < floor) {
          y = floor;
          if (vy < 0) vy = -vy * this.bounce[i];
          vx *= 0.62;
          vz *= 0.62;
          this.wx[i] *= 0.5;
          this.wy[i] *= 0.5;
          this.wz[i] *= 0.5;
          if (vy < 0.6 && vx * vx + vz * vz < 0.5) {
            this.settled[i] = 1;
            vy = 0;
            vx = 0;
            vz = 0;
          }
        }
        this.px[i] = x;
        this.py[i] = y;
        this.pz[i] = z;
        this.vx[i] = vx;
        this.vy[i] = vy;
        this.vz[i] = vz;
        this.rx[i] += this.wx[i] * dt;
        this.ry[i] += this.wy[i] * dt;
        this.rz[i] += this.wz[i] * dt;
        if (this.settled[i] === 0 && vx * vx + vz * vz > 4) {
          // Rolling chunks flatten out a little as they slow down.
          this.rz[i] *= 0.995;
        }
      }

      const d = this.dummy;
      d.position.set(this.px[i], this.py[i] - (1 - shrink) * this.sy[i] * 0.5, this.pz[i]);
      d.rotation.set(this.rx[i], this.ry[i], this.rz[i]);
      d.scale.set(this.sx[i] * shrink, this.sy[i] * shrink, this.sz[i] * shrink);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
      i++;
    }

    if (this.count === 0) {
      this.mesh.visible = false;
      this.mesh.count = 0;
      return;
    }
    this.mesh.visible = true;
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
