/**
 * Tactical minimap.
 *
 * Drawn entirely from the raw frame data (`map.nav` terrain classes, structure records,
 * vehicle/flag transforms) — no renderer cooperation required.
 *
 * Cost control:
 *  - the static terrain layer is rasterised once per map content identity into an
 *    offscreen canvas (keyed by grid size + a cheap sampling checksum of `nav`) and then
 *    blitted on every redraw;
 *  - the dynamic overlay repaints at most 20 fps (`MIN_INTERVAL_MS`);
 *  - the backing store is DPR aware but capped at 2x;
 *  - no allocation in `update()` after warm-up (canvases, the grid ImageData and all
 *    colours are created once).
 */
import type { HudFrame } from './types.js';
import {
  FLAGSTATE,
  SFLAG,
  SKIND,
  VFLAG,
  VKIND,
  VSTATE,
  type FlagView,
  type StructureView,
  type VehicleView,
} from '../sim/layout.js';

/* Terrain classes, mirrored from `crates/rf-core/src/types.rs` (`mod terrain`). */
const T_DEEP = 0;
const T_SHALLOW = 1;
const T_SAND = 2;
const T_GROUND = 3;
const T_ROAD = 4;
const T_ROCK = 5;
const T_BLOCKED = 6;

/**
 * Terrain ramp. The whole world is drawn into an 82 px square (164 px of backing store), so
 * on the 512 m world a 2 m cell is well under a pixel: the only thing that reads at that size
 * is strong value separation between water and land. These are deliberately brighter and more
 * saturated than the 3D palette, and the coastline gets a warm rim on top of it.
 *
 * Blip sizes are in *screen* pixels and are scaled by `world / BASE_WORLD` (see `markScale`),
 * otherwise the same triangle would cover twice as much ground on the bigger map.
 */
const NAV_RGB: Array<readonly [number, number, number]> = [];
NAV_RGB[T_DEEP] = [26, 62, 92];
NAV_RGB[T_SHALLOW] = [58, 136, 168];
NAV_RGB[T_SAND] = [216, 198, 152];
NAV_RGB[T_GROUND] = [108, 134, 78];
NAV_RGB[T_ROAD] = [186, 181, 170];
NAV_RGB[T_ROCK] = [158, 149, 132];
NAV_RGB[T_BLOCKED] = [74, 76, 82];

const TEAM_FILL = ['#7fc45c', '#f26a4e'] as const; // brightened 0x4f7a3a / 0xb8402e
const TEAM_EDGE = ['#c9f0a8', '#ffb09a'] as const;

/* Pre-quantised pulse colours: the draw loop must not build rgba() strings. */
const PULSE_STEPS = 8;

/**
 * The map is drawn **turned**: world `-x` is right and `-z` is down, so walking north moves
 * your blip *down* the minimap and walking east moves it *left*. That is the orientation the
 * editor's overview was put into (`web/src/editor/minimap.ts`, where it is the default), and
 * the reader is the authority on which way their own map faces.
 *
 * The turn is one canvas transform around every map-space layer — the terrain blit, the
 * structures, the mines, the vehicles, the flags and the camera cone — rather than a mirrored
 * image, so no layer can end up pointing the wrong way relative to another. The compass tick
 * follows the map's north, which the turn puts at the bottom edge, while its label stays
 * upright type.
 */
const FLIPPED = true;
const pulseRamp = (r: number, g: number, b: number, hi: number, lo: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < PULSE_STEPS; i++) out.push(`rgba(${r},${g},${b},${(hi - (i / (PULSE_STEPS - 1)) * (hi - lo)).toFixed(2)})`);
  return out;
};
const PULSE_CARRIED = pulseRamp(255, 120, 96, 0.75, 0.3);
const PULSE_EXPOSED = pulseRamp(255, 196, 96, 0.7, 0.3);
const PULSE_SELF = pulseRamp(255, 255, 255, 0.74, 0.32);

const MIN_INTERVAL_MS = 50; // 20 fps ceiling
const CHECK_INTERVAL_MS = 400; // how often the terrain checksum is re-verified
/** World size the blip sizes below were authored against. */
const BASE_WORLD = 256;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Structure dot colour by kind — towers red, logistics amber, garages cyan, walls grey. */
function structureColor(kind: number): string | null {
  switch (kind) {
    case SKIND.GARAGE:
    case SKIND.HANGAR:
    case SKIND.HELIPAD:
    case SKIND.HQ:
      return '#5fc9e8';
    case SKIND.FUEL_DEPOT:
    case SKIND.AMMO_TENT:
      return '#e8b262';
    case SKIND.TURRET_TOWER:
    case SKIND.WATCHTOWER:
    case SKIND.BUNKER:
      return '#f06a52';
    case SKIND.WALL:
    case SKIND.SANDBAG:
    case SKIND.GATE:
      return '#8e97a1';
    case SKIND.FLAG_POLE:
      return '#e8f0f8';
    case SKIND.RADAR:
    case SKIND.ANTENNA:
    case SKIND.LIGHTHOUSE:
    case SKIND.BRIDGE:
      return '#9fb0bd';
    case SKIND.TENT:
    case SKIND.BUILDING:
      return '#7f8a94';
    default:
      /* crates, barrels, containers, palms, rocks: clutter at 80 px, not drawn */
      return null;
  }
}

const wallish = (kind: number): boolean =>
  kind === SKIND.WALL || kind === SKIND.SANDBAG || kind === SKIND.GATE;

export interface Minimap {
  /** Wrapper element (canvas + glass flood + corner ticks). */
  readonly el: HTMLDivElement;
  /** CSS pixel size; the backing store follows with `min(2, dpr)`. */
  setSize(cssPx: number): void;
  update(f: HudFrame): void;
  dispose(): void;
}

export function createMinimap(cssSize = 82): Minimap {
  const el = document.createElement('div');
  el.className = 'rf-map';
  el.innerHTML = '<canvas class="rf-map-cv"></canvas><span class="rf-map-glass"></span>';
  const cv = el.querySelector('canvas') as HTMLCanvasElement;
  const ctx = cv.getContext('2d');

  /* Offscreen terrain layer (final resolution) + 1px-per-cell staging canvas. */
  const layer = document.createElement('canvas');
  const lctx = layer.getContext('2d');
  const tiny = document.createElement('canvas');
  const tctx = tiny.getContext('2d');

  let css = Math.max(24, cssSize);
  let dpr = 1;
  let px = 0; // backing store size
  let img: ImageData | null = null;
  let world = 1; // world size of the last frame, shared by the draw helpers
  let markScale = 1; // world / BASE_WORLD: keeps blips the same *ground* size

  let terrainKey = '';
  let terrainSum = -1;
  let lastCheck = -1e9;
  let lastDraw = -1e9;
  let disposed = false;

  function setSize(next: number): void {
    css = Math.max(24, next);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    px = Math.max(24, Math.round(css * dpr));
    el.style.width = `${css}px`;
    el.style.height = `${css}px`;
    cv.width = px;
    cv.height = px;
    cv.style.width = `${css}px`;
    cv.style.height = `${css}px`;
    layer.width = px;
    layer.height = px;
    terrainSum = -1; // force a rebuild at the new resolution
  }

  function checksum(nav: Uint8Array): number {
    let s = 0;
    /* Strided sampling keeps this ~O(grid) even on 512² maps. */
    for (let i = 0; i < nav.length; i += 61) s = (s * 31 + nav[i]) | 0;
    return s + nav.length * 7;
  }

  function buildTerrain(f: HudFrame): void {
    const g = f.map.grid | 0;
    if (g <= 1 || g > 1024 || !tctx || !lctx) return;
    if (tiny.width !== g || tiny.height !== g) {
      tiny.width = g;
      tiny.height = g;
      img = null;
    }
    if (!img || img.width !== g || img.height !== g) img = tctx.createImageData(g, g);

    const nav = f.map.nav;
    const heights = f.map.heights;
    const hs = g + 1;
    const hasH = heights.length >= hs * hs;
    const data = img.data;
    const wl = f.map.waterLevel;

    for (let z = 0; z < g; z++) {
      const row = z * g;
      const hrow = z * hs;
      for (let x = 0; x < g; x++) {
        const t = nav[row + x];
        const c = NAV_RGB[t < 7 ? t : T_BLOCKED];
        let shade = 1;
        if (hasH) {
          const h = heights[hrow + x];
          if (t <= T_SHALLOW) {
            shade = 1 - clamp((wl - h) / 18, 0, 1) * 0.42;
          } else {
            const hx = heights[hrow + x + 1] - h;
            const hz = heights[hrow + hs + x] - h;
            shade = clamp(1 + (hx + hz) * 0.018, 0.94, 1.06) * (1 + clamp((h - wl) / 60, 0, 0.13));
          }
        }
        let r = c[0] * shade;
        let gg = c[1] * shade;
        let b = c[2] * shade;
        /* One-cell bright rim wherever land meets water: at 80 px the coastline is what
           makes an island readable, not the fill colour. */
        const up = z > 0 ? nav[row - g + x] : T_DEEP;
        const dn = z < g - 1 ? nav[row + g + x] : T_DEEP;
        const lf = x > 0 ? nav[row + x - 1] : T_DEEP;
        const rt = x < g - 1 ? nav[row + x + 1] : T_DEEP;
        const coast = up <= T_SHALLOW || dn <= T_SHALLOW || lf <= T_SHALLOW || rt <= T_SHALLOW;
        if (t > T_SHALLOW && coast) {
          /* Warm beach rim: the shape of the island is the map's most important read. */
          r = r * 0.5 + 240 * 0.5;
          gg = gg * 0.5 + 224 * 0.5;
          b = b * 0.5 + 178 * 0.5;
        } else if (t <= T_SHALLOW && !coast) {
          /* Shallow water just off the beach: a bright turquoise halo. */
          r = r * 0.62 + 92 * 0.38;
          gg = gg * 0.62 + 196 * 0.38;
          b = b * 0.62 + 214 * 0.38;
        }
        const o = (row + x) << 2;
        data[o] = r;
        data[o + 1] = gg;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    tctx.putImageData(img, 0, 0);

    lctx.clearRect(0, 0, px, px);
    lctx.imageSmoothingEnabled = true;
    lctx.imageSmoothingQuality = 'high';
    lctx.drawImage(tiny, 0, 0, g, g, 0, 0, px, px);

    /* Depth vignette so the map reads as a lens rather than a decal. */
    const grd = lctx.createRadialGradient(px * 0.5, px * 0.48, px * 0.5, px * 0.5, px * 0.5, px * 0.92);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.14)');
    lctx.fillStyle = grd;
    lctx.fillRect(0, 0, px, px);
  }

  function drawVehicle(v: VehicleView, self: boolean, time: number): void {
    if (!ctx) return;
    const s = px / world;
    const x = v.x * s;
    const y = v.z * s;
    const r = (self ? 3.7 : 2.9) * dpr * markScale;

    if (v.state === VSTATE.WRECK) {
      ctx.fillStyle = 'rgba(38,36,34,0.9)';
      ctx.fillRect(x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4);
      ctx.strokeStyle = 'rgba(150,146,140,0.5)';
      ctx.lineWidth = dpr;
      ctx.strokeRect(x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4);
      return;
    }

    const team = v.team === 1 ? 1 : 0;
    const airborne = (v.flags & VFLAG.AIRBORNE) !== 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI - v.yaw);
    ctx.beginPath();
    if (v.kind === VKIND.HELI) {
      /* Rotor cross reads as "air" at a glance. */
      ctx.moveTo(0, -r * 1.55);
      ctx.lineTo(r * 0.85, 0);
      ctx.lineTo(0, r * 1.55);
      ctx.lineTo(-r * 0.85, 0);
    } else {
      ctx.moveTo(0, -r * 1.45);
      ctx.lineTo(r * 0.95, r * 1.05);
      ctx.lineTo(0, r * 0.5);
      ctx.lineTo(-r * 0.95, r * 1.05);
    }
    ctx.closePath();
    ctx.globalAlpha = v.state === VSTATE.BUILDING ? 0.45 : airborne ? 0.88 : 1;
    ctx.fillStyle = TEAM_FILL[team];
    ctx.fill();
    ctx.lineWidth = dpr;
    ctx.strokeStyle = self ? '#ffffff' : 'rgba(6,10,12,0.85)';
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;

    if (self) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 4.4);
      ctx.beginPath();
      ctx.arc(x, y, (5.2 + pulse * 1.3) * dpr * markScale, 0, Math.PI * 2);
      ctx.strokeStyle = PULSE_SELF[(pulse * (PULSE_STEPS - 1)) | 0];
      ctx.lineWidth = 1.3 * dpr;
      ctx.stroke();
    }
  }

  function drawStructure(s: StructureView): void {
    if (!ctx) return;
    if ((s.flags & SFLAG.DEAD) !== 0 && s.kind !== SKIND.WRECK) return;
    const w = px / world;
    const x = s.x * w;
    const y = s.z * w;
    const c = structureColor(s.kind);
    if (c === null) return;
    if (wallish(s.kind) && s.w > 0.5) {
      const lw = Math.max(1, s.w * w);
      const ld = Math.max(1, s.d * w);
      ctx.globalAlpha = 0.38;
      ctx.fillStyle = c;
      ctx.fillRect(x - lw * 0.5, y - ld * 0.5, lw, ld);
      ctx.globalAlpha = 1;
      return;
    }
    /* Bases get a filled, outlined block so "where is home" never needs a second look. */
    const base = s.kind === SKIND.GARAGE || s.kind === SKIND.HQ || s.kind === SKIND.HELIPAD;
    if (base) {
      const r = 2.4 * dpr * markScale;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = TEAM_FILL[s.team === 1 ? 1 : 0];
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.lineWidth = dpr;
      ctx.strokeStyle = '#eaf6ff';
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
      return;
    }
    const r =
      (s.kind === SKIND.TURRET_TOWER || s.kind === SKIND.WATCHTOWER ? 1.7 : 1.3) * dpr * markScale;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = c;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  function drawFlag(fl: FlagView, time: number): void {
    if (!ctx) return;
    if (fl.state === FLAGSTATE.CAPTURED) return;
    const w = px / world;
    const x = fl.x * w;
    const y = fl.z * w;
    const team = fl.team === 1 ? 1 : 0;
    const carried = fl.state === FLAGSTATE.CARRIED;
    const dropped = fl.state === FLAGSTATE.DROPPED;
    const exposed = fl.state === FLAGSTATE.EXPOSED;
    const base = 3.1 * dpr * markScale;

    if (carried || exposed) {
      const pulse = 0.5 + 0.5 * Math.sin(time * (carried ? 7 : 5));
      ctx.beginPath();
      ctx.arc(x, y, base + (2.6 + pulse * 3.6) * dpr * markScale, 0, Math.PI * 2);
      ctx.strokeStyle = (carried ? PULSE_CARRIED : PULSE_EXPOSED)[(pulse * (PULSE_STEPS - 1)) | 0];
      ctx.lineWidth = 1.6 * dpr;
      ctx.stroke();
    }

    ctx.beginPath();
    if (dropped) {
      /* Hollow diamond = on the ground, up for grabs. */
      ctx.moveTo(x, y - base);
      ctx.lineTo(x + base, y);
      ctx.lineTo(x, y + base);
      ctx.lineTo(x - base, y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(10,14,18,0.85)';
      ctx.fill();
      ctx.strokeStyle = TEAM_EDGE[team];
    } else {
      ctx.arc(x, y, base * 0.82, 0, Math.PI * 2);
      ctx.fillStyle = TEAM_FILL[team];
      ctx.fill();
      ctx.strokeStyle = carried ? '#ffffff' : 'rgba(8,12,14,0.9)';
    }
    ctx.lineWidth = 1.4 * dpr;
    ctx.stroke();

    /* Pennant, so a flag never reads as just another dot. */
    ctx.beginPath();
    ctx.moveTo(x, y - base * 0.7);
    ctx.lineTo(x + base * 1.7, y - base * 1.5);
    ctx.lineTo(x, y - base * 2.1);
    ctx.closePath();
    ctx.fillStyle = TEAM_FILL[team];
    ctx.fill();
  }

  function drawCamera(f: HudFrame): void {
    if (!ctx) return;
    const w = px / world;
    const x = f.camera.x * w;
    const y = f.camera.z * w;
    const half = clamp(Math.atan2(0.72, Math.max(0.35, f.camera.zoom)), 0.3, 0.95);
    // The cone radius is the ground the camera covers (the frame sees roughly
    // `1.2 * BASE_DISTANCE * zoom` metres along the view axis), clamped so it can never
    // swallow the map at full zoom-out or vanish when zoomed in.
    const z = clamp(f.camera.zoom || 1, 0.25, 8);
    const coneR = clamp((72 * z * px) / world, px * 0.09, px * 0.42);
    const a = Math.PI - f.camera.yaw - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, coneR, a - half, a + half);
    ctx.closePath();
    ctx.fillStyle = 'rgba(140,232,255,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,236,255,0.38)';
    ctx.lineWidth = dpr;
    ctx.stroke();
  }

  function update(f: HudFrame): void {
    if (disposed || !ctx || px <= 0) return;
    world = f.map.worldSize || 1;
    // Blips are symbolic, not to scale: the map is always drawn into the same 82 px box, so
    // on a bigger world a fixed-pixel blip covers more ground. Growing them with the square
    // root of the area keeps a jeep visible against a map that now packs 4x the terrain into
    // the same box, without doubling the size of everything the way a linear factor would.
    markScale = clamp(Math.sqrt(world / BASE_WORLD), 0.75, 2);

    const now = performance.now();
    if (now - lastCheck > CHECK_INTERVAL_MS) {
      lastCheck = now;
      const key = `${f.map.grid}:${f.map.nav.length}`;
      const sum = checksum(f.map.nav);
      if (key !== terrainKey || sum !== terrainSum) {
        terrainKey = key;
        terrainSum = sum;
        buildTerrain(f);
      }
    }

    if (now - lastDraw < MIN_INTERVAL_MS) return;
    lastDraw = now;

    ctx.clearRect(0, 0, px, px);
    // Every layer below is in map space, so the turn is one transform around all of them: the
    // terrain blit, the structures, the mines, the vehicles, the flags and the camera cone.
    ctx.save();
    if (FLIPPED) {
      ctx.translate(px, px);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(layer, 0, 0);

    const nStruct = Math.min(f.structureCount, f.structures.length);
    for (let i = 0; i < nStruct; i++) drawStructure(f.structures[i]);

    const nMine = Math.min(f.mineCount, f.mines.length);
    const ms = px / world;
    for (let i = 0; i < nMine; i++) {
      const m = f.mines[i];
      const r = 1.5 * dpr * markScale;
      ctx.fillStyle = m.armed !== 0 ? 'rgba(255,186,86,0.8)' : 'rgba(255,140,90,0.5)';
      ctx.fillRect(m.x * ms - r, m.z * ms - r, r * 2, r * 2);
    }

    const selfId = f.hud.vehicleId;
    const nVeh = Math.min(f.vehicleCount, f.vehicles.length);
    for (let i = 0; i < nVeh; i++) {
      const v = f.vehicles[i];
      if (v.kind === VKIND.NONE || v.kind === VKIND.TROOP) continue;
      drawVehicle(v, v.id === selfId || (v.flags & VFLAG.IS_PLAYER) !== 0, f.time);
    }

    const nFlag = Math.min(8, f.flags.length);
    for (let i = 0; i < nFlag; i++) drawFlag(f.flags[i], f.time);

    drawCamera(f);
    ctx.restore();

    // The compass is screen space, so it is drawn after the turn — but it points at the map's
    // north, which the turn has moved to the bottom edge. The label stays upright.
    drawCompass();
  }

  /**
   * North-up tick. The map never rotates (the camera cone does), so a single fixed marker
   * is enough to keep the player oriented. With the map turned, north is the bottom edge.
   */
  function drawCompass(): void {
    if (!ctx) return;
    const cx = px * 0.5;
    const s0 = 4.2 * dpr;
    // The tick sits on whichever edge the map's north ended up on and points at it; the label
    // goes just inside, which keeps it on the map in both orientations.
    const dir = FLIPPED ? -1 : 1;
    const edge = FLIPPED ? px - 1.5 * dpr : 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, edge);
    ctx.lineTo(cx + s0 * 0.62, edge + dir * s0);
    ctx.lineTo(cx - s0 * 0.62, edge + dir * s0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(232, 245, 255, 0.85)';
    ctx.fill();
    ctx.font = `600 ${Math.round(7.5 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(232, 245, 255, 0.62)';
    ctx.fillText('N', cx, edge + dir * (s0 + 1.5 * dpr));
  }

  function dispose(): void {
    disposed = true;
    el.remove();
  }

  setSize(css);
  return { el, setSize, update, dispose };
}
