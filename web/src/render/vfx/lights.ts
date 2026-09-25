/**
 * Recycled point-light pool.
 *
 * Point lights are the most expensive thing the VFX layer touches: every extra one recompiles
 * every material in the scene, so the pool is created once (never added or removed at runtime)
 * and driven purely by intensity. Explosions have priority over muzzle flashes, and a request
 * that cannot win a slot is simply dropped.
 */
import * as THREE from 'three';

export class LightPool {
  readonly lights: THREE.PointLight[] = [];
  private readonly age: Float32Array;
  private readonly ttl: Float32Array;
  private readonly peak: Float32Array;
  private readonly prio: Float32Array;
  private readonly count: number;

  constructor(scene: THREE.Scene, count: number, distance = 46) {
    this.count = Math.max(0, count | 0);
    this.age = new Float32Array(this.count);
    this.ttl = new Float32Array(this.count);
    this.peak = new Float32Array(this.count);
    this.prio = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const l = new THREE.PointLight(0xffb070, 0, distance, 2);
      l.castShadow = false;
      l.intensity = 0;
      l.name = `vfx-light-${i}`;
      this.lights.push(l);
      scene.add(l);
      this.ttl[i] = 0;
    }
  }

  /**
   * Ask for a flash. `priority` 2 = explosion (may steal any slot), 1 = muzzle flash (only
   * steals an idle slot). Returns the slot or -1.
   */
  request(x: number, y: number, z: number, intensity: number, life: number, priority: number, colorHex: number): number {
    if (this.count === 0) return -1;
    let slot = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.ttl[i] <= 0 || this.age[i] >= this.ttl[i]) {
        slot = i;
        break;
      }
      const t = this.age[i] / this.ttl[i];
      // Score: how "spent" the slot is, weighted by how much brighter it currently is.
      const score = t + this.prio[i] * 0.35;
      if (score < bestScore) {
        bestScore = score;
        slot = i;
      }
    }
    if (slot < 0) return -1;
    const cur = this.ttl[slot] > 0 ? this.age[slot] / this.ttl[slot] : 1;
    if (cur < 1 && priority <= this.prio[slot] && cur < 0.45) return -1;
    this.age[slot] = 0;
    this.ttl[slot] = Math.max(0.02, life);
    this.peak[slot] = intensity;
    this.prio[slot] = priority;
    const l = this.lights[slot];
    l.position.set(x, y, z);
    l.color.setHex(colorHex, THREE.SRGBColorSpace);
    l.intensity = intensity;
    return slot;
  }

  /** Move an active flash (used while a fireball rises). */
  move(slot: number, x: number, y: number, z: number): void {
    if (slot < 0 || slot >= this.count) return;
    this.lights[slot].position.set(x, y, z);
  }

  update(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      if (this.ttl[i] <= 0) continue;
      const a = this.age[i] + dt;
      this.age[i] = a;
      const t = a / this.ttl[i];
      const l = this.lights[i];
      if (t >= 1) {
        l.intensity = 0;
        continue;
      }
      // Fast attack, exponential-ish decay: reads like burning fuel.
      const fade = Math.pow(1 - t, 2.2);
      l.intensity = this.peak[i] * fade;
    }
  }

  dispose(scene: THREE.Scene): void {
    for (const l of this.lights) scene.remove(l);
    this.lights.length = 0;
  }
}
