/**
 * TypeScript mirror of the flat `*View` structs in `crates/rf-core/src/types.rs`.
 * Every record is f32-only and laid out back to back, so we read the simulation's state
 * straight out of wasm linear memory with zero copying.
 *
 * Keep these strides in sync with Rust (`STRUCT_STRIDE`, `VEHICLE_STRIDE`, ...) and bump
 * `STATE_VERSION` on both sides when the layout changes.
 */

export const STATE_VERSION = 2;

export const STRIDE = {
  vehicle: 27,
  projectile: 14,
  mine: 8,
  turret: 8,
  flag: 8,
  event: 8,
  structure: 14,
  playerHud: 16,
  teamHud: 12,
} as const;

export const V = {
  ID: 0,
  KIND: 1,
  TEAM: 2,
  STATE: 3,
  X: 4,
  Y: 5,
  Z: 6,
  YAW: 7,
  TURRET_YAW: 8,
  GUN_PITCH: 9,
  SPEED: 10,
  HP: 11,
  HP_MAX: 12,
  FUEL: 13,
  FUEL_MAX: 14,
  AMMO0: 15,
  AMMO1: 16,
  MINES: 17,
  ANIM: 18,
  FLAGS: 19,
  RELOAD0: 20,
  RELOAD1: 21,
  BUILD_T: 22,
  PITCH: 23,
  ROLL: 24,
  ALT: 25,
  WRECK: 26,
} as const;

export const P = {
  ID: 0,
  KIND: 1,
  TEAM: 2,
  OWNER: 3,
  X: 4,
  Y: 5,
  Z: 6,
  VX: 7,
  VY: 8,
  VZ: 9,
  LIFE: 10,
  POWER: 11,
  SEED: 12,
} as const;

export const M = { X: 0, Y: 1, Z: 2, TEAM: 3, ARMED: 4, BLINK: 5, ID: 6 } as const;
export const T = { X: 0, Y: 1, Z: 2, YAW: 3, TEAM: 4, ALIVE: 5, STRUCT: 6, RELOAD: 7 } as const;
export const F = { X: 0, Y: 1, Z: 2, STATE: 3, TEAM: 4, CARRIER: 5, DROP_T: 6, WAVE: 7 } as const;
export const E = { KIND: 0, X: 1, Y: 2, Z: 3, A: 4, B: 5, C: 6, D: 7 } as const;
export const S = {
  X: 0,
  Y: 1,
  Z: 2,
  YAW: 3,
  W: 4,
  D: 5,
  H: 6,
  KIND: 7,
  TEAM: 8,
  HP: 9,
  HP_MAX: 10,
  FLAGS: 11,
  PHASE: 12,
  ID: 13,
} as const;
export const HUD = {
  VEHICLE_ID: 0,
  VEHICLE_KIND: 1,
  HP: 2,
  HP_MAX: 3,
  FUEL: 4,
  FUEL_MAX: 5,
  AMMO0: 6,
  AMMO0_MAX: 7,
  AMMO1: 8,
  AMMO1_MAX: 9,
  MINES: 10,
  MINE_MAX: 11,
  KILLS: 12,
  DEATHS: 13,
  FLAGS: 14,
  RESPAWN_T: 15,
  AIM_YAW: 16,
  BEARING_TO_FLAG: 17,
  STATUS: 18,
} as const;
export const TEAM = {
  READY_JEEP: 0,
  READY_TANK: 1,
  READY_HRSV: 2,
  READY_HELI: 3,
  BUILD_JEEP: 4,
  BUILD_TANK: 5,
  BUILD_HRSV: 6,
  BUILD_HELI: 7,
  SCORE: 8,
  FLAG_STATE: 9,
  TURRETS: 10,
  ENEMY_SCORE: 11,
} as const;

/* --------------------------------------------------------------- enums (Rust-side) */

export const VKIND = { NONE: 0, JEEP: 1, TANK: 2, HRSV: 3, HELI: 4, TROOP: 5, DRONE: 6, SUB: 7 } as const;
export const VSTATE = { PARKED: 0, ACTIVE: 1, WRECK: 2, BUILDING: 3 } as const;
export const VFLAG = {
  CARRYING: 1 << 0,
  IS_PLAYER: 1 << 1,
  BURNING: 1 << 2,
  IN_WATER: 1 << 3,
  BAILED: 1 << 4,
  RELOAD0: 1 << 5,
  RELOAD1: 1 << 6,
  AIRBORNE: 1 << 7,
  FLAG_IN_RANGE: 1 << 8,
  FLAG_RADAR: 1 << 9,
  HIT_FLASH: 1 << 10,
  SPAWN_GUARD: 1 << 11,
} as const;

export const SKIND = {
  NONE: 0,
  GARAGE: 1,
  FLAG_POLE: 2,
  FUEL_DEPOT: 3,
  AMMO_TENT: 4,
  HELIPAD: 5,
  RADAR: 6,
  WALL: 7,
  BUNKER: 8,
  BRIDGE: 9,
  TENT: 10,
  TURRET_TOWER: 11,
  PALM: 12,
  ROCK: 13,
  BUILDING: 14,
  CRATE: 15,
  BARREL: 16,
  SANDBAG: 17,
  WATCHTOWER: 18,
  HANGAR: 19,
  ANTENNA: 20,
  WRECK: 21,
  HQ: 22,
  GATE: 23,
  CONTAINER: 24,
  LIGHTHOUSE: 25,
} as const;

export const SFLAG = {
  DEAD: 1 << 0,
  SOLID: 1 << 1,
  DESTRUCTIBLE: 1 << 2,
  BLOCKS_LOS: 1 << 3,
  FUEL: 1 << 4,
  AMMO: 1 << 5,
  REPAIR: 1 << 6,
  BAY: 1 << 7,
  EMISSIVE: 1 << 8,
  FLAT: 1 << 9,
} as const;

export const PKIND = {
  NONE: 0,
  SHELL: 1,
  GRENADE: 2,
  ROCKET: 3,
  MISSILE: 4,
  BULLET: 5,
  HOMING: 6,
  BOMB: 7,
} as const;

export const EKIND = {
  NONE: 0,
  EXPLOSION: 1,
  BIG_EXPLOSION: 2,
  MUZZLE_FLASH: 3,
  IMPACT: 4,
  DUST: 5,
  WATER_SPLASH: 6,
  SMOKE_PUFF: 7,
  TRACER: 8,
  DEBRIS: 9,
  SHOCKWAVE: 10,
  SOUND: 11,
  NOTIFY: 12,
  FLAG_TAKEN: 13,
  FLAG_CAPTURED: 14,
  VEHICLE_DESTROYED: 15,
  SKULL: 16,
  SCORCH: 17,
} as const;

export const SFX = {
  EXPLOSION_SMALL: 1,
  EXPLOSION_BIG: 2,
  GUN_TANK: 3,
  GUN_CHAIN: 4,
  ROCKET_LAUNCH: 5,
  GRENADE_THROW: 6,
  MINE_DROP: 7,
  MINE_BLAST: 8,
  IMPACT_METAL: 9,
  IMPACT_GROUND: 10,
  IMPACT_WATER: 11,
  ENGINE_START: 12,
  HELI_LOOP: 13,
  FLAG_PICKUP: 14,
  FLAG_CAPTURE: 15,
  ALARM: 16,
  LAUGH: 17,
  DRONE_HUM: 18,
  SUB_LAUNCH: 19,
  RESUPPLY: 20,
  BUILD_DONE: 21,
  TOWER_FIRE: 22,
  BAIL_OUT: 23,
  BRIDGE_COLLAPSE: 24,
} as const;

/** Maps the Rust `sfx::*` ids onto the audio module's sound names. */
export const SFX_NAME: Record<number, string> = {
  1: 'explosionSmall',
  2: 'explosionBig',
  3: 'gunTank',
  4: 'gunChain',
  5: 'rocketLaunch',
  6: 'grenadeThrow',
  7: 'mineDrop',
  8: 'mineBlast',
  9: 'impactMetal',
  10: 'impactGround',
  11: 'impactWater',
  12: 'engineStart',
  13: 'droneHum',
  14: 'flagPickup',
  15: 'flagCapture',
  16: 'alarm',
  17: 'laugh',
  18: 'droneHum',
  19: 'subLaunch',
  20: 'resupply',
  21: 'buildDone',
  22: 'towerFire',
  23: 'bailOut',
  24: 'bridgeCollapse',
};

export const NOTIFY = {
  FLAG_TAKEN: 1,
  FLAG_DROPPED: 2,
  FLAG_CAPTURED: 3,
  FLAG_RETURNED: 4,
  FLAG_EXPOSED: 5,
  VEHICLE_LOST: 6,
  OUT_OF_BOUNDS: 7,
  LOW_FUEL: 8,
  NO_AMMO: 9,
  ROUND_WON: 10,
  ROUND_LOST: 11,
  TOWER_DOWN: 12,
  BRIDGE_DOWN: 13,
  DRONES_IN: 14,
} as const;

export const FLAGSTATE = { HOME: 0, CARRIED: 1, DROPPED: 2, EXPOSED: 3, CAPTURED: 4 } as const;
export const MATCHSTATE = { PLAYING: 0, ROUND_OVER: 1, MATCH_OVER: 2 } as const;

/* ------------------------------------------------------------------- record types */

export interface VehicleView {
  id: number;
  kind: number;
  team: number;
  state: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  turretYaw: number;
  gunPitch: number;
  speed: number;
  hp: number;
  hpMax: number;
  fuel: number;
  fuelMax: number;
  ammo0: number;
  ammo1: number;
  mines: number;
  anim: number;
  flags: number;
  reload0: number;
  reload1: number;
  buildT: number;
  pitch: number;
  roll: number;
  alt: number;
  /** Seconds left before this wreck is culled (0 for a live vehicle); tapers the soot
   *  column in `render/effects.ts`. Decoded by `sim/bridge.ts` from `V.WRECK`. Optional
   *  only so hand-built preview fixtures need not carry it; fall back to the nominal
   *  `WRECK_TIME` when it is absent. */
  wreck?: number;
}

export interface ProjectileView {
  id: number;
  kind: number;
  team: number;
  owner: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  power: number;
  seed: number;
}

export interface MineView {
  x: number;
  y: number;
  z: number;
  team: number;
  armed: number;
  blink: number;
  id: number;
}

export interface TurretView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  team: number;
  alive: number;
  structId: number;
  reload: number;
}

export interface FlagView {
  x: number;
  y: number;
  z: number;
  state: number;
  team: number;
  carrier: number;
  dropT: number;
  wave: number;
}

export interface EventView {
  kind: number;
  x: number;
  y: number;
  z: number;
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface StructureView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  h: number;
  kind: number;
  team: number;
  hp: number;
  hpMax: number;
  flags: number;
  phase: number;
  id: number;
}

export interface PlayerHudView {
  vehicleId: number;
  vehicleKind: number;
  hp: number;
  hpMax: number;
  fuel: number;
  fuelMax: number;
  ammo0: number;
  ammo0Max: number;
  ammo1: number;
  ammo1Max: number;
  mines: number;
  mineMax: number;
  kills: number;
  deaths: number;
  flags: number;
  respawnT: number;
  aimYaw: number;
  bearingToFlag: number;
  status: number;
}

export interface TeamHudView {
  readyJeep: number;
  readyTank: number;
  readyHrsv: number;
  readyHeli: number;
  buildJeep: number;
  buildTank: number;
  buildHrsv: number;
  buildHeli: number;
  score: number;
  flagState: number;
  turrets: number;
  enemyScore: number;
}

export interface WeaponSpecView2 {
  name: string;
  damage: number;
  splash: number;
  cooldown: number;
  kind: number;
  range: number;
  homing: boolean;
  /** Indirect fire (a thrown grenade): the arc is solved at launch, so the muzzle never
   *  swings with elevation and the weapon cannot intercept an aircraft. The MLRS round is no
   *  longer lobbed — it is a heat-seeker that flies on the sight line plus a launch climb.
   *  Optional like `muzzleUp` because preview fixtures build weapon specs by hand. */
  lobbed?: boolean;
  /** Muzzle height above the hull centre, in metres (aiming must compensate for it). */
  muzzleUp?: number;
}

export interface VehicleSpecView {
  kind: number;
  name: string;
  hp: number;
  speed: number;
  accel: number;
  fuel: number;
  ammo0: number;
  ammo1: number;
  mines: number;
  build: number;
  flag: boolean;
  flying: boolean;
  amphibious: boolean;
  length: number;
  width: number;
  height: number;
  /** Target acquisition radius, metres — what the debug range overlay draws in green. */
  sight: number;
  w0: WeaponSpecView2;
  w1: WeaponSpecView2;
}
