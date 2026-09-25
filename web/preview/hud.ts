/**
 * HUD preview harness.
 *
 * Renders the real HUD (`src/hud/hud.ts`) and the real menus (`src/hud/menus.ts`) over a
 * procedurally painted desert stand-in for the WebGL view, driven by synthetic but
 * plausible frame data: two islands, bases, roads, turret towers, all four vehicle
 * kinds, mines, both flags and a notification feed.
 *
 * Variants (hash or query string both work):
 *   ?title=1        title screen
 *   ?garage=1       garage / vehicle select (mixed ready + rebuilding cards)
 *   ?roundend=1     round-end overlay        (+ &match=1 for the match-over variant)
 *   ?loading=1      boot progress screen
 *   ?dead=1         destroyed / respawn card + skull taunt
 *   ?skull=1        skull taunt only
 *   ?flags=all      draw all five flag states at once instead of cycling them
 *   ?notify=0       hide the notification feed
 *   ?banner=0       hide the round banner
 *   ?dbg=1          show the debug chip
 */
import { createHud } from '../src/hud/hud.js';
import { createMenus } from '../src/hud/menus.js';
import type { GarageState, HudFrame, Notification } from '../src/hud/types.js';
import {
  FLAGSTATE,
  SFLAG,
  SKIND,
  VFLAG,
  VKIND,
  type FlagView,
  type MineView,
  type StructureView,
  type VehicleSpecView,
  type VehicleView,
} from '../src/sim/layout.js';

/* ------------------------------------------------------------------ query flags */

const params = new URLSearchParams(location.search.length > 1 ? location.search.slice(1) : location.hash.replace(/^#/, ''));
const flagOn = (name: string): boolean => params.get(name) === '1' || params.get(name) === '';
const variant = {
  title: flagOn('title'),
  garage: flagOn('garage'),
  roundEnd: flagOn('roundend'),
  loading: flagOn('loading'),
  dead: flagOn('dead'),
  skull: flagOn('skull'),
  allFlags: params.get('flags') === 'all',
  notify: params.get('notify') !== '0',
  banner: params.get('banner') !== '0',
  match: flagOn('match'),
  dbg: flagOn('dbg'),
  /** Clock exercise: `elapsed` (default) counts up from `t0`, `inter` shows the countdown. */
  inter: flagOn('inter'),
  t0: Number(params.get('t0') ?? 0),
  veh: params.get('veh') ?? 'jeep',
};

/* Per-vehicle loadout so a screenshot can prove the weapon rows: a jeep has grenades and
   nothing else, the MLRS carries mines, only the helicopter has a rocket pod. */
const LOADOUT_PREVIEW: Record<string, { kind: number; a0: number; a1: number; mines: number }> = {
  jeep: { kind: VKIND.JEEP, a0: 16, a1: 0, mines: 0 },
  tank: { kind: VKIND.TANK, a0: 150, a1: 0, mines: 0 },
  hrsv: { kind: VKIND.HRSV, a0: 100, a1: 0, mines: 10 },
  heli: { kind: VKIND.HELI, a0: 100, a1: 50, mines: 0 },
};

/* ------------------------------------------------------------------ procedural map */

const GRID = 128;
const WORLD = 512;
const CELL = WORLD / GRID;
const WATER_LEVEL = 0;

const T_DEEP = 0;
const T_SHALLOW = 1;
const T_SAND = 2;
const T_GROUND = 3;
const T_ROAD = 4;
const T_ROCK = 5;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed: number, size: number): (x: number, y: number) => number {
  const r = rng(seed);
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x: number, y: number): number => {
    const fx = x * size;
    const fy = y * size;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const xa = ((x0 % size) + size) % size;
    const ya = ((y0 % size) + size) % size;
    const xb = (xa + 1) % size;
    const yb = (ya + 1) % size;
    const i00 = ya * size + xa;
    const i10 = ya * size + xb;
    const i01 = yb * size + xa;
    const i11 = yb * size + xb;
    return (g[i00] * (1 - sx) + g[i10] * sx) * (1 - sy) + (g[i01] * (1 - sx) + g[i11] * sx) * sy;
  };
}

const ISLANDS = [
  { x: 0.24, z: 0.63, r: 0.32, h: 40 }, // green base island (west)
  { x: 0.79, z: 0.36, r: 0.31, h: 39 }, // tan base island (east)
  { x: 0.52, z: 0.5, r: 0.12, h: 18 }, // contested centre
  { x: 0.2, z: 0.2, r: 0.11, h: 13 }, // northern rocks
  { x: 0.86, z: 0.8, r: 0.11, h: 13 },
];

const ROADS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [0.1, 0.7],
    [0.24, 0.62],
    [0.36, 0.68],
  ],
  [
    [0.16, 0.55],
    [0.26, 0.5],
    [0.34, 0.58],
  ],
  [
    [0.66, 0.3],
    [0.78, 0.37],
    [0.9, 0.3],
  ],
  [
    [0.86, 0.46],
    [0.78, 0.52],
    [0.68, 0.44],
  ],
  [
    [0.3, 0.56],
    [0.42, 0.5],
    [0.52, 0.5],
    [0.64, 0.46],
  ],
];

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const len = vx * vx + vz * vz;
  let t = len > 0 ? (wx * vx + wz * vz) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t;
  const dz = wz - vz * t;
  return Math.sqrt(dx * dx + dz * dz);
}

function buildMap(): { nav: Uint8Array; heights: Float32Array } {
  const hs = GRID + 1;
  const heights = new Float32Array(hs * hs);
  const n1 = makeNoise(7, 24);
  const n2 = makeNoise(23, 48);
  const n3 = makeNoise(91, 96);

  for (let z = 0; z < hs; z++) {
    for (let x = 0; x < hs; x++) {
      const u = x / GRID;
      const v = z / GRID;
      let h = -9;
      for (const is of ISLANDS) {
        const d = Math.sqrt((u - is.x) * (u - is.x) + (v - is.z) * (v - is.z)) / is.r;
        const k = d < 1 ? 1 - d : 0; // falloff must stop at the island edge, not invert
        const bump = k * k * is.h - 6;
        if (bump > h) h = bump;
      }
      h += (n1(u, v) - 0.5) * 3.4 + (n2(u, v) - 0.5) * 1.6 + (n3(u, v) - 0.5) * 0.7;
      heights[z * hs + x] = h;
    }
  }

  const nav = new Uint8Array(GRID * GRID);
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const h =
        (heights[z * hs + x] + heights[z * hs + x + 1] + heights[(z + 1) * hs + x] + heights[(z + 1) * hs + x + 1]) * 0.25;
      let t = T_ROCK;
      if (h < -3) t = T_DEEP;
      else if (h < 0.3) t = T_SHALLOW;
      else if (h < 1.8) t = T_SAND;
      else if (h < 19) t = T_GROUND;
      nav[z * GRID + x] = t;
    }
  }

  /* carve roads */
  const u = (x: number): number => (x + 0.5) / GRID;
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const t = nav[z * GRID + x];
      if (t !== T_SAND && t !== T_GROUND) continue;
      const px = u(x);
      const pz = u(z);
      for (const road of ROADS) {
        let hit = false;
        for (let i = 0; i < road.length - 1 && !hit; i++) {
          if (segDist(px, pz, road[i][0], road[i][1], road[i + 1][0], road[i + 1][1]) < 0.009) hit = true;
        }
        if (hit) {
          nav[z * GRID + x] = T_ROAD;
          break;
        }
      }
    }
  }
  return { nav, heights };
}

const map = buildMap();

/* ------------------------------------------------------------------ structures */

const structures: StructureView[] = [];
function addStruct(kind: number, x: number, z: number, team: number, w: number, d: number, h: number, flags: number): void {
  structures.push({
    x,
    y: 0,
    z,
    yaw: 0,
    w,
    d,
    h,
    kind,
    team,
    hp: 100,
    hpMax: 100,
    flags,
    phase: 1,
    id: structures.length + 1,
  });
}

const SOLID = SFLAG.SOLID | SFLAG.DESTRUCTIBLE | SFLAG.BLOCKS_LOS;
const BASE0 = { x: 0.24 * WORLD, z: 0.63 * WORLD };
const BASE1 = { x: 0.79 * WORLD, z: 0.36 * WORLD };

function buildBase(bx: number, bz: number, team: number, flip: number): void {
  addStruct(SKIND.GARAGE, bx - 22 * flip, bz + 6 * flip, team, 26, 18, 8, SOLID);
  addStruct(SKIND.HANGAR, bx - 8 * flip, bz + 40 * flip, team, 30, 22, 11, SOLID);
  addStruct(SKIND.HELIPAD, bx + 22 * flip, bz + 36 * flip, team, 22, 22, 1, SFLAG.FLAT);
  addStruct(SKIND.FLAG_POLE, bx, bz, team, 3, 3, 12, SFLAG.DESTRUCTIBLE);
  addStruct(SKIND.FUEL_DEPOT, bx + 30 * flip, bz - 6 * flip, team, 12, 12, 7, SOLID | SFLAG.FUEL);
  addStruct(SKIND.AMMO_TENT, bx + 8 * flip, bz - 26 * flip, team, 14, 10, 5, SOLID | SFLAG.AMMO);
  addStruct(SKIND.RADAR, bx - 40 * flip, bz - 20 * flip, team, 10, 10, 14, SOLID);
  addStruct(SKIND.TURRET_TOWER, bx - 26 * flip, bz - 46 * flip, team, 8, 8, 12, SOLID | SFLAG.DESTRUCTIBLE);
  addStruct(SKIND.TURRET_TOWER, bx + 46 * flip, bz + 18 * flip, team, 8, 8, 12, SOLID | SFLAG.DESTRUCTIBLE);
  addStruct(SKIND.WATCHTOWER, bx + 54 * flip, bz - 34 * flip, team, 7, 7, 15, SOLID);
  addStruct(SKIND.BUNKER, bx - 52 * flip, bz + 30 * flip, team, 16, 12, 6, SOLID);
  addStruct(SKIND.TENT, bx - 4 * flip, bz - 48 * flip, team, 12, 9, 4, SOLID);
  addStruct(SKIND.CONTAINER, bx + 40 * flip, bz + 44 * flip, team, 12, 5, 5, SOLID);
  for (let i = 0; i < 4; i++) {
    addStruct(SKIND.WALL, bx - 60 * flip + i * 26 * flip, bz - 62 * flip, team, 22, 5, 4, SOLID);
  }
}

buildBase(BASE0.x, BASE0.z, 0, 1);
buildBase(BASE1.x, BASE1.z, 1, -1);
addStruct(SKIND.LIGHTHOUSE, 0.5 * WORLD, 0.5 * WORLD, -1, 9, 9, 26, SOLID);
addStruct(SKIND.ROCK, 0.2 * WORLD, 0.2 * WORLD, -1, 20, 18, 12, SOLID);
addStruct(SKIND.BRIDGE, 0.42 * WORLD, 0.5 * WORLD, -1, 40, 14, 3, SFLAG.SOLID | SFLAG.FLAT);
const structureCount = structures.length;

/* ------------------------------------------------------------------ dynamic entities */

function mkVehicle(
  id: number,
  kind: number,
  team: number,
  x: number,
  z: number,
  yaw: number,
  flags: number,
  hp: number,
): VehicleView {
  return {
    id,
    kind,
    team,
    state: 1,
    x,
    y: 1,
    z,
    yaw,
    turretYaw: yaw,
    gunPitch: 0,
    speed: kind === VKIND.JEEP ? 18 : 11,
    hp,
    hpMax: kind === VKIND.TANK ? 200 : kind === VKIND.HELI ? 90 : kind === VKIND.HRSV ? 110 : 70,
    fuel: 62,
    fuelMax: 100,
    ammo0: kind === VKIND.HRSV ? 6 : 24,
    ammo1: 6,
    mines: 3,
    anim: 0,
    flags,
    reload0: 0,
    reload1: 0,
    buildT: 0,
    pitch: 0,
    roll: 0,
    alt: kind === VKIND.HELI ? 22 : 0,
  };
}

/* player (jeep, carrying the enemy flag) + the rest of the player's team + the enemy */
const player = mkVehicle(1, VKIND.JEEP, 0, 372, 232, 2.6, VFLAG.IS_PLAYER | VFLAG.CARRYING, 68);
const vehicles: VehicleView[] = [
  player,
  mkVehicle(2, VKIND.TANK, 0, 214, 292, 0.5, 0, 180),
  mkVehicle(3, VKIND.HRSV, 0, 156, 344, 1.2, 0, 104),
  mkVehicle(4, VKIND.HELI, 0, 268, 246, 3.4, VFLAG.AIRBORNE, 88),
  mkVehicle(5, VKIND.JEEP, 1, 344, 214, -1.9, 0, 62),
  mkVehicle(6, VKIND.TANK, 1, 402, 176, -2.4, 0, 172),
  mkVehicle(7, VKIND.HELI, 1, 300, 150, 1.9, VFLAG.AIRBORNE, 80),
  mkVehicle(8, VKIND.HRSV, 1, 0.72 * WORLD, 0.44 * WORLD, -0.6, 0, 96),
];

/* one wreck, so the destroyed state is exercised on the minimap too */
const wreck = mkVehicle(9, VKIND.TANK, 1, 300, 300, 1.1, 0, 0);
wreck.state = 2;
vehicles.push(wreck);
const vehicleCount = vehicles.length;

const FLAG_CYCLE: ReadonlyArray<readonly [number, number]> = [
  [FLAGSTATE.HOME, FLAGSTATE.CARRIED],
  [FLAGSTATE.CARRIED, FLAGSTATE.DROPPED],
  [FLAGSTATE.EXPOSED, FLAGSTATE.HOME],
  [FLAGSTATE.DROPPED, FLAGSTATE.EXPOSED],
  [FLAGSTATE.CAPTURED, FLAGSTATE.CARRIED],
];

const flags: FlagView[] = [
  { x: BASE0.x, y: 0, z: BASE0.z, state: FLAGSTATE.HOME, team: 0, carrier: 0, dropT: 0, wave: 0 },
  { x: player.x, y: 0, z: player.z, state: FLAGSTATE.CARRIED, team: 1, carrier: player.id, dropT: 0, wave: 0 },
];
if (variant.allFlags) {
  flags.length = 0;
  flags.push(
    { x: BASE0.x, y: 0, z: BASE0.z, state: FLAGSTATE.HOME, team: 0, carrier: 0, dropT: 0, wave: 0 },
    { x: BASE0.x + 40, y: 0, z: BASE0.z + 30, state: FLAGSTATE.CARRIED, team: 0, carrier: 2, dropT: 0, wave: 0 },
    { x: BASE0.x + 80, y: 0, z: BASE0.z - 20, state: FLAGSTATE.DROPPED, team: 0, carrier: 0, dropT: 3, wave: 0 },
    { x: BASE1.x, y: 0, z: BASE1.z, state: FLAGSTATE.EXPOSED, team: 1, carrier: 0, dropT: 1, wave: 0 },
    { x: BASE1.x - 70, y: 0, z: BASE1.z + 40, state: FLAGSTATE.CAPTURED, team: 1, carrier: 0, dropT: 0, wave: 0 },
  );
}

const mines: MineView[] = [
  { x: BASE0.x + 30, y: 0, z: BASE0.z + 30, team: 0, armed: 1, blink: 0, id: 1 },
  { x: BASE0.x + 52, y: 0, z: BASE0.z + 18, team: 0, armed: 1, blink: 0, id: 2 },
  { x: 0.44 * WORLD, y: 0, z: 0.52 * WORLD, team: 1, armed: 1, blink: 0, id: 3 },
  { x: 0.47 * WORLD, y: 0, z: 0.57 * WORLD, team: 1, armed: 0, blink: 0, id: 4 },
  { x: BASE1.x - 26, y: 0, z: BASE1.z + 46, team: 0, armed: 1, blink: 0, id: 5 },
];

const notifications: Notification[] = [
  { text: 'ENEMY FLAG TAKEN', sub: 'M151 MUTT', team: 0, age: 0.4, life: 14, kind: 'flag' },
  { text: 'YOU DESTROYED A TANK', sub: '+1 KILL', team: 0, age: 2.6, life: 14, kind: 'kill' },
  { text: 'FUEL CRITICAL', sub: '42%', team: -1, age: 5.1, life: 14, kind: 'warn' },
  { text: 'TOWER DESTROYED', sub: 'SECTOR 4', team: 1, age: 7.4, life: 14, kind: 'info' },
];
if (!variant.notify) notifications.length = 0;

/* ------------------------------------------------------------------ frame assembly */

const mapInfo = {
  nav: map.nav,
  heights: map.heights,
  grid: GRID,
  cell: CELL,
  worldSize: WORLD,
  waterLevel: WATER_LEVEL,
};

const frame: HudFrame = {
  playerIndex: 0,
  hud: {
    vehicleId: player.id,
    vehicleKind: VKIND.JEEP,
    hp: 52,
    hpMax: 70,
    fuel: 42,
    fuelMax: 100,
    ammo0: 24,
    ammo0Max: 150,
    ammo1: 6,
    ammo1Max: 0,
    mines: 3,
    mineMax: 10,
    kills: 5,
    deaths: 2,
    flags: 1,
    respawnT: 0,
    aimYaw: 2.4,
    bearingToFlag: 0.8,
    status: 1,
  },
  team: {
    readyJeep: 1,
    readyTank: 1,
    readyHrsv: 0.42,
    readyHeli: 0.86,
    buildJeep: 0,
    buildTank: 0,
    buildHrsv: 0.6,
    buildHeli: 0.2,
    score: 2,
    flagState: FLAGSTATE.CARRIED,
    turrets: 4,
    enemyScore: 1,
  },
  vehicles,
  vehicleCount,
  flags,
  turrets: [
    { x: BASE0.x - 26, y: 0, z: BASE0.z - 46, yaw: 0.4, team: 0, alive: 1, structId: 8, reload: 0 },
    { x: BASE0.x + 46, y: 0, z: BASE0.z + 18, yaw: 1.4, team: 0, alive: 1, structId: 9, reload: 0 },
    { x: BASE1.x + 26, y: 0, z: BASE1.z + 46, yaw: 2.4, team: 1, alive: 1, structId: 25, reload: 0 },
    { x: BASE1.x - 46, y: 0, z: BASE1.z - 18, yaw: 3.4, team: 1, alive: 0, structId: 26, reload: 0 },
  ],
  turretCount: 4,
  mines,
  mineCount: mines.length,
  map: mapInfo,
  structures,
  structureCount,
  matchState: 0,
  roundWinner: -1,
  roundTimeLeft: 214,
  score: [2, 1],
  roundsToWin: 3,
  time: 0,
  fps: 60,
  camera: { x: 300, z: 250, yaw: 0.65, zoom: 1 },
  notifications,
  banner: variant.banner ? { title: 'ROUND 1', sub: 'CAPTURE THE ENEMY FLAG', age: 0, life: 16 } : null,
  twoPlayer: false,
  showDebug: variant.dbg,
};

/* ------------------------------------------------------------------ background scene */

const view = document.getElementById('view') as HTMLCanvasElement;
const vctx = view.getContext('2d');
/* The backdrop is painted once per resize into an offscreen canvas and blitted each
   frame: the preview only needs a plausible game view behind the glass, and software
   rasterisers are far too slow to rebuild those gradients 60 times a second. */
const scene = document.createElement('canvas');
const sctx = scene.getContext('2d');
let sw = 0;
let sh = 0;

function dunePath(c: CanvasRenderingContext2D, yBase: number, amp: number, phase: number, step: number): void {
  c.beginPath();
  c.moveTo(0, sh);
  for (let x = 0; x <= sw; x += step) {
    const y = yBase + Math.sin(x * 0.004 + phase) * amp + Math.sin(x * 0.011 + phase * 2.3) * amp * 0.4;
    c.lineTo(x, y);
  }
  c.lineTo(sw, sh);
  c.closePath();
}

function paintScene(c: CanvasRenderingContext2D): void {
  const horizon = sh * 0.42;
  const sky = c.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#080f18');
  sky.addColorStop(0.5, '#1a2733');
  sky.addColorStop(0.85, '#4a4136');
  sky.addColorStop(1, '#6d5738');
  c.fillStyle = sky;
  c.fillRect(0, 0, sw, horizon + 2);

  const sx = sw * 0.68;
  const sy = horizon * 0.42;
  const glow = c.createRadialGradient(sx, sy, 0, sx, sy, sh * 0.3);
  glow.addColorStop(0, 'rgba(255,214,150,0.34)');
  glow.addColorStop(0.22, 'rgba(255,178,104,0.12)');
  glow.addColorStop(1, 'rgba(255,170,90,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, sw, horizon + 2);

  const layers: ReadonlyArray<readonly [number, number, number, string]> = [
    [horizon - 6, 12, 0.6, '#2b2b23'],
    [horizon + 10, 16, 2.1, '#3a3322'],
    [horizon + 34, 20, 4.4, '#4a3f27'],
  ];
  for (const [y, amp, ph, col] of layers) {
    dunePath(c, y, amp, ph, 16);
    c.fillStyle = col;
    c.fill();
  }

  const sand = c.createLinearGradient(0, horizon, 0, sh);
  sand.addColorStop(0, '#6d5636');
  sand.addColorStop(0.3, '#57452a');
  sand.addColorStop(1, '#241c10');
  c.fillStyle = sand;
  c.fillRect(0, horizon, sw, sh - horizon);

  /* perspective tracks — the tilted top-down chase camera */
  c.save();
  c.beginPath();
  c.rect(0, horizon, sw, sh - horizon);
  c.clip();
  c.strokeStyle = 'rgba(20,14,6,0.34)';
  c.lineWidth = 1;
  for (let i = -6; i <= 6; i++) {
    c.beginPath();
    c.moveTo(sw * 0.5 + i * sw * 0.03, horizon);
    c.lineTo(sw * 0.5 + i * sw * 0.42, sh);
    c.stroke();
  }
  for (let i = 0; i < 9; i++) {
    const y = horizon + 20 + Math.pow(i / 8, 2.1) * (sh - horizon - 20);
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(sw, y);
    c.stroke();
  }
  /* standing structures, so the glass has something to blur */
  const blocks: ReadonlyArray<readonly [number, number, number, number, string]> = [
    [0.12, 0.62, 0.1, 0.06, 'rgba(18,16,13,0.92)'],
    [0.3, 0.74, 0.07, 0.05, 'rgba(24,20,15,0.92)'],
    [0.62, 0.66, 0.09, 0.045, 'rgba(20,18,14,0.9)'],
    [0.82, 0.8, 0.12, 0.07, 'rgba(16,14,12,0.92)'],
  ];
  for (const [bx, by, bw, bh, col] of blocks) {
    c.fillStyle = col;
    c.fillRect(sw * bx, sh * by, sw * bw, sh * bh);
    c.fillStyle = 'rgba(255,226,180,0.12)';
    c.fillRect(sw * bx, sh * by, sw * bw, 1.5);
  }
  c.restore();
}

function resizeScene(): void {
  if (!vctx || !sctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  sw = view.clientWidth;
  sh = view.clientHeight;
  for (const cv of [view, scene]) {
    cv.width = Math.max(2, Math.round(sw * dpr));
    cv.height = Math.max(2, Math.round(sh * dpr));
  }
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintScene(sctx);
}

let dustX = 0;
function blitScene(t: number): void {
  if (!vctx) return;
  /* two cheap moving dust veils keep the frame visibly live without rebuilding gradients */
  vctx.drawImage(scene, 0, 0, sw, sh);
  dustX = (dustX + 1.6) % (sw + 400);
  const g = vctx.createLinearGradient(dustX - 400, 0, dustX, 0);
  g.addColorStop(0, 'rgba(226,196,148,0)');
  g.addColorStop(0.5, 'rgba(226,196,148,0.04)');
  g.addColorStop(1, 'rgba(226,196,148,0)');
  vctx.fillStyle = g;
  vctx.fillRect(dustX - 400, sh * 0.4, 400, sh * 0.6);
  vctx.fillStyle = 'rgba(255,240,210,0.02)';
  vctx.fillRect(0, sh * 0.4 + Math.sin(t * 0.7) * 8, sw, 3);
}

/* ------------------------------------------------------------------ ui boot */

const ui = document.getElementById('ui') as HTMLElement;
const hud = createHud(ui);
const menus = createMenus(ui);
hud.setVisible(!variant.title && !variant.garage && !variant.loading);

const mapNames = ['Rocky Cape', 'Two Rivers', 'Archipelago', 'Dust Bowl', 'Iron Atoll', 'Last Light'];
let mapIndex = 2;
let mapMode = 0;
let mapSize = 0;

if (variant.title) {
  menus.showTitle({
    mapNames,
    mapIndex,
    mapMode,
    mapSize,
    onMapChange: (i) => {
      mapIndex = i;
    },
    onModeChange: (m) => {
      mapMode = m;
    },
    onSizeChange: (s) => {
      mapSize = s;
    },
    seed: 1337,
    randomPlay: false,
    onSeedChange: () => undefined,
    onRandomPlayChange: () => undefined,
    onStart: (twoPlayer) => {
      menus.toast(twoPlayer ? 'TWO PLAYER DEPLOYMENT' : 'SINGLE PLAYER DEPLOYMENT');
      menus.hideTitle();
      hud.setVisible(true);
    },
    onSettings: () => undefined,
  });
}

if (variant.garage) {
  const specs: VehicleSpecView[] = [
    {
      kind: VKIND.JEEP,
      name: 'M151 MUTT',
      hp: 70,
      speed: 26,
      accel: 12,
      fuel: 100,
      ammo0: 40,
      ammo1: 6,
      mines: 3,
      build: 6,
      flag: true,
      flying: false,
      amphibious: false,
      length: 3.4,
      width: 1.8,
      height: 1.4,
      sight: 58.0,
      w0: { name: '20mm', damage: 6, splash: 1, cooldown: 0.1, kind: 5, range: 90, homing: false },
      w1: { name: 'Mk2', damage: 40, splash: 5, cooldown: 1.2, kind: 2, range: 40, homing: false },
    },
    {
      kind: VKIND.TANK,
      name: 'M60 Patton',
      hp: 200,
      speed: 14,
      accel: 6,
      fuel: 100,
      ammo0: 20,
      ammo1: 4,
      mines: 2,
      build: 14,
      flag: false,
      flying: false,
      amphibious: false,
      length: 6.4,
      width: 3.2,
      height: 2.6,
      sight: 72.0,
      w0: { name: '120mm', damage: 55, splash: 6, cooldown: 2.4, kind: 1, range: 140, homing: false },
      w1: { name: '20mm', damage: 5, splash: 0.5, cooldown: 0.09, kind: 5, range: 80, homing: false },
    },
    {
      kind: VKIND.HRSV,
      name: 'M270 MLRS',
      hp: 110,
      speed: 16,
      accel: 7,
      fuel: 90,
      ammo0: 8,
      ammo1: 2,
      mines: 2,
      build: 18,
      flag: false,
      flying: false,
      amphibious: false,
      length: 6.8,
      width: 2.9,
      height: 3.1,
      sight: 80.0,
      w0: { name: 'MLRS', damage: 34, splash: 7, cooldown: 1.6, kind: 3, range: 200, homing: false },
      w1: { name: 'SAM', damage: 30, splash: 3, cooldown: 3.2, kind: 4, range: 120, homing: true },
    },
    {
      kind: VKIND.HELI,
      name: 'AH-1 Cobra',
      hp: 90,
      speed: 30,
      accel: 14,
      fuel: 70,
      ammo0: 24,
      ammo1: 8,
      mines: 0,
      build: 22,
      flag: true,
      flying: true,
      amphibious: false,
      length: 13.6,
      width: 3.2,
      height: 3.4,
      sight: 92.0,
      w0: { name: 'Mk2', damage: 34, splash: 4, cooldown: 0.7, kind: 2, range: 70, homing: false },
      w1: { name: '70mm', damage: 22, splash: 4, cooldown: 0.6, kind: 3, range: 150, homing: false },
    },
  ];
  const gstate: GarageState = {
    specs,
    team: { ...frame.team, readyJeep: 1, readyTank: 1, readyHrsv: 0.42, readyHeli: 0.86 },
    teamId: 0,
    playerIndex: 0,
    vehicleNameFor: (kind: number) => specs.find((s) => s.kind === kind)?.name ?? String(kind),
  };
  menus.showGarage(gstate, (kind) => menus.toast(`BAY ${kind} ROLLING OUT`));
}

if (variant.roundEnd) {
  menus.showRoundEnd({
    winner: 0,
    score: [2, 1],
    matchOver: variant.match,
    youWon: !variant.match,
    onContinue: () => {
      menus.hideRoundEnd();
      menus.toast('DEPLOYING ROUND 3');
    },
  });
}

if (variant.loading) {
  menus.showLoading(0.62, 'Generating terrain…');
} else {
  menus.hideLoading();
}

if (variant.dead) {
  frame.hud.status = 0;
  frame.hud.respawnT = 7.4;
  frame.team.readyHrsv = 0.42;
  frame.team.readyHeli = 0.68;
}
if (variant.skull) {
  /* repeat it: a screenshot lands ~1.8 s in, the flash lasts 1.6 s */
  for (const at of [900, 3400, 5900, 8400]) {
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('rf:skull')), at);
  }
}

/* ------------------------------------------------------------------ loop */

const live = params.get('live') === '1';
let wakeUntil = performance.now() + 1600;
const wake = (): void => {
  wakeUntil = performance.now() + 4000;
};
window.addEventListener('pointermove', wake, { passive: true });
window.addEventListener('pointerdown', wake, { passive: true });
window.addEventListener('keydown', wake);

const t0 = performance.now();
let frameNo = 0;
let cycleIdx = 0;
let lastCycle = 0;
let fps = 60;
let lastFrame = performance.now();

function loop(): void {
  const now = performance.now();
  const t = (now - t0) / 1000;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  frameNo++;
  if (frameNo % 12 === 0) fps = 1 / Math.max(0.0001, dt);
  frame.time = t + variant.t0;
  frame.fps = fps;

  /* drift the vehicles so the minimap triangles and the map are visibly live */
  const orbit = (v: VehicleView, cx: number, cz: number, r: number, spd: number, ph: number): void => {
    const a = t * spd + ph;
    v.x = cx + Math.cos(a) * r;
    v.z = cz + Math.sin(a) * r;
    v.yaw = Math.atan2(-Math.sin(a), Math.cos(a));
  };
  orbit(player, 330, 250, 52, 0.2, 0.4);
  orbit(vehicles[1], 200, 300, 34, -0.15, 1.1);
  orbit(vehicles[2], 118, 322, 40, 0.12, 2.4);
  orbit(vehicles[3], 300, 214, 66, 0.22, 0.9);
  orbit(vehicles[4], 372, 226, 30, -0.19, 3.1);
  orbit(vehicles[5], 404, 186, 34, 0.14, 0.2);
  orbit(vehicles[6], 268, 132, 58, -0.17, 2.0);

  /* the carried flag rides its carrier */
  if (!variant.allFlags) {
    flags[1].x = player.x;
    flags[1].z = player.z;
    if (!variant.dead && now - lastCycle > 2400) {
      lastCycle = now;
      cycleIdx = (cycleIdx + 1) % FLAG_CYCLE.length;
      flags[0].state = FLAG_CYCLE[cycleIdx][0];
      flags[1].state = FLAG_CYCLE[cycleIdx][1];
    }
  }

  if (variant.inter) {
    /* Inter-round: the clock becomes a countdown and the hairline fills. */
    frame.matchState = 1;
    frame.roundTimeLeft = Math.max(0.4, 12 - ((t * 1.6) % 12));
  } else {
    frame.matchState = 0;
    frame.roundTimeLeft = 0;
  }

  if (variant.dead) {
    frame.hud.respawnT = Math.max(0, frame.hud.respawnT - dt);
    frame.team.readyHrsv = Math.min(1, frame.team.readyHrsv + dt * 0.05);
  }

  /* The backdrop is decoration. Repainting it every frame would force Chromium to
     re-snapshot and re-blur the glass on every frame, which is ruinous on software
     rasterisers (headless screenshots run on SwiftShader). It animates for the first
     moment and whenever the pointer/keyboard is used, then holds still — `?live=1`
     keeps it running continuously. */
  if (live || frameNo < 8 || now < wakeUntil) {
    if (frameNo % 2 === 0 || frameNo < 8) blitScene(t);
  }
  const lo = LOADOUT_PREVIEW[variant.veh] ?? LOADOUT_PREVIEW.jeep;
  /* Keep the rig consistent with the loadout so the silhouette, name and weapon rows agree
     (in the real game `setVehKind` reads the live vehicle). */
  player.kind = lo.kind;
  frame.hud.vehicleKind = lo.kind;
  frame.hud.ammo0 = lo.a0;
  frame.hud.ammo1 = lo.a1;
  frame.hud.mines = lo.mines;
  hud.update(frame);
  if (variant.loading) {
    menus.showLoading(Math.min(1, 0.62 + t * 0.05), t > 3 ? 'Placing turret towers…' : 'Generating terrain…');
  }
  requestAnimationFrame(loop);
}

resizeScene();
window.addEventListener('resize', resizeScene);
requestAnimationFrame(loop);

/* two frames of grace so the CSS land and the first canvas blit is done */
requestAnimationFrame(() => requestAnimationFrame(() => {
  window.__READY__ = true;
}));

declare global {
  interface Window {
    __READY__?: boolean;
    /** Debug hook: raw terrain classes + heights, used by the screenshot probes. */
    __PV__?: { nav: Uint8Array; heights: Float32Array; grid: number };
  }
}
window.__PV__ = { nav: map.nav, heights: map.heights, grid: GRID };
