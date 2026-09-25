/**
 * Range overlay: a green circle per vehicle for how far it can *see*, and a red one for how far
 * it can *shoot*.
 *
 * A dev view, toggled from the console (`rfRanges()`), for questions the numbers in a spec table
 * do not answer: which hulls can actually see each other, where a stand-off sits relative to a
 * gun, why a jeep drove past a tank without firing (it was outside `sight`, not out of range).
 *
 * Drawn as two `LineSegments`, one per colour, with every circle's vertices written into a pooled
 * buffer each update: one draw call each, no per-vehicle objects, and nothing allocated per frame
 * after the first. `depthTest` is off so the rings read through terrain and buildings - a debug
 * view that hides behind a hill is worse than useless - and the radii come from the same spec the
 * simulation uses, through the bridge, so the picture cannot drift from the behaviour.
 */
import * as THREE from 'three';
import { VSTATE, type VehicleSpecView } from '../sim/layout.js';

/** Segments per circle. Enough for a 190 m radius to look round at normal zoom. */
const SEGMENTS = 72;
/** Vehicles the pooled buffers are sized for; more simply stops being drawn. */
const MAX_VEHICLES = 96;
/** Layer colours: view, reach, and the towers' own (they are neither a hull's sight nor a gun). */
const VIEW_COLOR = 0x46d05a;
const ATTACK_COLOR = 0xff4d3d;
const TOWER_COLOR = 0xb46cff;
/** Height above the hull's ground point, to keep the ring off the terrain surface. */
const LIFT = 0.35;

export interface RangeVehicle {
  kind: number;
  /** `VSTATE`: a wreck is still in the vehicle list, and must not draw a ring. */
  state: number;
  x: number;
  y: number;
  z: number;
}

export interface RangeTurret {
  x: number;
  y: number;
  z: number;
  alive: number;
}

export interface RangeFrame {
  vehicles: ArrayLike<RangeVehicle>;
  vehicleCount: number;
  specs: VehicleSpecView[];
  turrets: ArrayLike<RangeTurret>;
  turretCount: number;
  /** A tower's reach (`Game::tower_range`), the same constant its fire control uses. */
  towerRange: number;
}

export interface RangeOverlay {
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  /** Redraw for this frame. Cheap no-op when disabled. */
  update(frame: RangeFrame): void;
  dispose(): void;
}

function ringGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const verts = new Float32Array(SEGMENTS * 2 * 3);
  for (let i = 0; i < SEGMENTS; i++) {
    const a0 = (i / SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
    const o = i * 6;
    verts[o + 0] = Math.cos(a0);
    verts[o + 1] = 0;
    verts[o + 2] = Math.sin(a0);
    verts[o + 3] = Math.cos(a1);
    verts[o + 4] = 0;
    verts[o + 5] = Math.sin(a1);
  }
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  return g;
}

function lineLayer(color: number, scene: THREE.Scene): { lines: THREE.LineSegments; position: THREE.BufferAttribute } {
  const geo = ringGeometry();
  // Stretch the pooled buffer to the vehicle cap in one go; `setDrawRange` decides how much of it
  // is live, so no circle is ever drawn for a slot that has no vehicle.
  const position = new THREE.BufferAttribute(new Float32Array(MAX_VEHICLES * SEGMENTS * 2 * 3), 3);
  geo.setAttribute('position', position);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false; // circles move every frame; the bounding sphere would lie
  lines.renderOrder = 900;
  lines.visible = false;
  lines.name = color === VIEW_COLOR ? 'range:view' : color === ATTACK_COLOR ? 'range:attack' : 'range:tower';
  scene.add(lines);
  return { lines, position };
}

export function createRangeOverlay(scene: THREE.Scene): RangeOverlay {
  // One ring geometry per layer, shared by every circle: only the pooled buffer is written.
  const view = lineLayer(VIEW_COLOR, scene);
  const attack = lineLayer(ATTACK_COLOR, scene);
  const tower = lineLayer(TOWER_COLOR, scene);
  const layers = [view, attack, tower];
  const unit = ringGeometry();
  const unitPos = unit.getAttribute('position') as THREE.BufferAttribute;
  let on = false;

  /** Copy one circle into a layer's buffer at `slot`, scaled to `radius`. */
  const write = (layer: { position: THREE.BufferAttribute }, slot: number, x: number, y: number, z: number, radius: number): void => {
    const base = slot * SEGMENTS * 2;
    const out = layer.position.array as Float32Array;
    const src = unitPos.array as Float32Array;
    for (let i = 0; i < SEGMENTS * 2; i++) {
      const s = i * 3;
      const o = (base + i) * 3;
      out[o + 0] = x + src[s + 0] * radius;
      out[o + 1] = y;
      out[o + 2] = z + src[s + 2] * radius;
    }
  };

  return {
    get enabled() {
      return on;
    },
    setEnabled(next: boolean) {
      on = next;
      for (const layer of layers) {
        layer.lines.visible = on;
        // Collapse the draw ranges so a stale frame cannot flash on the next toggle.
        if (!on) layer.lines.geometry.setDrawRange(0, 0);
      }
    },
    update(frame) {
      if (!on) return;
      const { vehicles, vehicleCount, specs, turrets, turretCount, towerRange } = frame;
      const n = Math.min(vehicleCount, MAX_VEHICLES);
      let drawn = 0;
      for (let i = 0; i < n; i++) {
        const v = vehicles[i];
        // A wreck is still in the list and has no ranges worth drawing - and after a battle
        // there are a lot of them, which is the "noise" this view was making.
        if (v.state === VSTATE.WRECK) continue;
        const spec = specs.find((s) => s.kind === v.kind);
        if (!spec) continue;
        const y = v.y + LIFT;
        // View: the same `sight` the AI's target acquisition uses.
        write(view, drawn, v.x, y, v.z, spec.sight);
        // Attack: the longest reach it has, which is what "can it hit me from here" means. A
        // helicopter's rockets outrange its chin gun; a jeep's grenade is its only weapon.
        const reach = Math.max(spec.w0?.range ?? 0, spec.w1?.range ?? 0);
        write(attack, drawn, v.x, y, v.z, reach > 0 ? reach : spec.sight);
        drawn++;
      }
      // Towers get their own colour, and their own buffer: a tower is not a hull, its ring means
      // a different thing (this ground is covered), and purple keeps it legible next to the
      // green/red pair. A tower has no separate sight radius - it acquires exactly as far as its
      // missile flies - so one ring is the whole story.
      const tn = Math.min(turretCount, MAX_VEHICLES);
      let towersDrawn = 0;
      for (let i = 0; i < tn; i++) {
        const t = turrets[i];
        if (!t.alive) continue;
        write(tower, towersDrawn, t.x, t.y + LIFT, t.z, towerRange);
        towersDrawn++;
      }
      for (const layer of layers) {
        layer.position.needsUpdate = true;
      }
      view.lines.geometry.setDrawRange(0, drawn * SEGMENTS * 2);
      attack.lines.geometry.setDrawRange(0, drawn * SEGMENTS * 2);
      tower.lines.geometry.setDrawRange(0, towersDrawn * SEGMENTS * 2);
    },
    dispose() {
      for (const layer of [view, attack]) {
        scene.remove(layer.lines);
        layer.lines.geometry.dispose();
        (layer.lines.material as THREE.Material).dispose();
      }
      unit.dispose();
    },
  };
}
