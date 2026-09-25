/**
 * Bridge between the Rust simulation (wasm) and the renderer.
 *
 * The wasm module owns the world; we read its state directly out of linear memory every
 * frame. Object pools keep the per-frame allocation count at zero so the GC never stutters
 * during play.
 */
import init, { Game } from './pkg/rf_core.js';
import {
  E,
  F,
  HUD,
  M,
  P,
  S,
  STRIDE,
  T,
  TEAM,
  V,
  type EventView,
  type FlagView,
  type MineView,
  type PlayerHudView,
  type ProjectileView,
  type StructureView,
  type TeamHudView,
  type TurretView,
  type VehicleSpecView,
  type VehicleView,
} from './layout.js';

export interface MapBuffers {
  name: string;
  worldSize: number;
  grid: number;
  cell: number;
  waterLevel: number;
  /** (grid+1)^2 vertex heights, metres. */
  heights: Float32Array;
  /**
   * (grid+1)^2 * 4 weights: sand, dirt, rock, grass.
   *
   * An owned copy, not a view: `bindMap` re-derives views whenever wasm linear memory grows,
   * and a `DataTexture` built from a stale view uploads a zero-length buffer (the GPU keeps
   * an uninitialised splat map and the terrain blends garbage).
   */
  splat: Uint8Array;
  /** (grid+1)^2 asphalt/concrete weights. */
  road: Uint8Array;
  /** (grid+1)^2 sand variant indices: 0 dune, 1 grit, 2 coral. */
  sandVar: Uint8Array;
  /** (grid+1)^2 grass variant indices: 0 lush, 1 scrub, 2 dry. */
  grassVar: Uint8Array;
  /** (grid+1)^2 pavement shapes: 0 plain, 1 slabs, 2 strip along x, 3 strip along z. */
  pave: Uint8Array;
  /** grid^2 terrain classes for the minimap. */
  nav: Uint8Array;
  /** Live structure records (also mutated in place as they take damage). */
  structures: Float32Array;
}

export interface InputFrame {
  throttle: number;
  steer: number;
  aim: number;
  aimPitch: number;
  hasAim: boolean;
  fire0: boolean;
  fire1: boolean;
  fire1Edge: boolean;
  brake: boolean;
  ascend: boolean;
  strafe: number;
}

export const emptyInput = (): InputFrame => ({
  throttle: 0,
  steer: 0,
  aim: 0,
  aimPitch: 0,
  hasAim: false,
  fire0: false,
  fire1: false,
  fire1Edge: false,
  brake: false,
  ascend: false,
  strafe: 0,
});

export class Sim {
  readonly game: Game;
  private memory: WebAssembly.Memory;
  private buffer: ArrayBufferLike;
  private f32 = new Float32Array(0);
  private u8 = new Uint8Array(0);

  /** Pooled, reused across frames. */
  readonly vehicles: VehicleView[] = [];
  readonly projectiles: ProjectileView[] = [];
  readonly mines: MineView[] = [];
  readonly turrets: TurretView[] = [];
  readonly events: EventView[] = [];
  readonly flags: FlagView[] = [];
  readonly hud: PlayerHudView[] = [];
  readonly teamHud: TeamHudView[] = [];
  vehicleCount = 0;
  projectileCount = 0;
  mineCount = 0;
  turretCount = 0;
  eventCount = 0;
  specs: VehicleSpecView[] = [];
  mapNames: string[] = [];
  map!: MapBuffers;

  /** True when both slots are human controlled (split screen). */
  readonly twoPlayer: boolean;

  /** The raw map index this wasm world was generated from (`Game::map_index`). */
  get mapIndex(): number {
    return this.game.map_index();
  }

  /** Generator mode this world was built with: 0 = classic (procedural), 1 = mirror. */
  get mapMode(): number {
    return this.game.map_mode();
  }

  /** Battlefield size this world was built with: 0 = small (512 m), 1 = medium, 2 = big. */
  get mapSize(): number {
    return this.game.map_size();
  }

  /** The seed this world was generated from (`Game::seed`). */
  get seed(): number {
    return this.game.seed();
  }

  /** Display names for the sizes, index-aligned with `mapSize` values. */
  static mapSizeNames(): string[] {
    return JSON.parse(Game.map_size_names_json()) as string[];
  }

  /** Display names for the generator modes, index-aligned with `mapMode` values. */
  static mapModeNames(): string[] {
    return JSON.parse(Game.map_mode_names_json()) as string[];
  }

  private constructor(game: Game, memory: WebAssembly.Memory, twoPlayer: boolean) {
    this.twoPlayer = twoPlayer;
    this.game = game;
    this.memory = memory;
    this.buffer = memory.buffer;
    // Views must exist before `sync()` can compare buffers, otherwise the very first
    // `refreshMap()` would read through a zero-length array.
    this.f32 = new Float32Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
    for (let i = 0; i < 64; i++) this.vehicles.push({} as VehicleView);
    for (let i = 0; i < 512; i++) this.projectiles.push({} as ProjectileView);
    for (let i = 0; i < 128; i++) this.mines.push({} as MineView);
    for (let i = 0; i < 64; i++) this.turrets.push({} as TurretView);
    for (let i = 0; i < 2048; i++) this.events.push({} as EventView);
    for (let i = 0; i < 2; i++) {
      this.flags.push({} as FlagView);
      this.hud.push({} as PlayerHudView);
      this.teamHud.push({} as TeamHudView);
    }
    this.specs = JSON.parse(game.specs_json()) as VehicleSpecView[];
    this.mapNames = JSON.parse(Game.map_names_json()) as string[];
    this.refreshMap();
  }

  static async load(
    seed = 1337,
    mapIndex = 0,
    twoPlayer = false,
    mapMode = 0,
    mapSize = 0,
  ): Promise<Sim> {
    const out = await init();
    const game = new Game(seed, mapIndex, mapMode, mapSize, twoPlayer);
    return new Sim(game, out.memory, twoPlayer);
  }

  /** Key the map editor parks its map under before sending the player here. */
  static readonly STORED_MAP_KEY = 'rf.editor.play';

  /**
   * Play the map the editor handed over, or `undefined` when there is none to play.
   *
   * The editor writes the same `.rfmap` bytes it would download, base64'd into local storage
   * (a 2 MB map is 2.7 MB of base64, inside the usual 5 MB budget), and navigates here. A map
   * that will not decode returns `undefined` so the caller can keep the generated world rather
   * than showing a blank screen.
   */
  static async fromStoredMap(twoPlayer: boolean): Promise<Sim | undefined> {
    const raw = localStorage.getItem(Sim.STORED_MAP_KEY);
    if (!raw) return undefined;
    try {
      const bin = atob(raw);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const out = await init();
      const game = Game.fromMap(bytes, twoPlayer);
      return new Sim(game, out.memory, twoPlayer);
    } catch (err) {
      console.warn('stored map could not be loaded; using a generated one', err);
      return undefined;
    }
  }

  /** wasm memory can grow, which detaches the old ArrayBuffer views. */
  private sync(): void {
    if (this.memory.buffer !== this.buffer) {
      this.buffer = this.memory.buffer;
      this.f32 = new Float32Array(this.buffer);
      this.u8 = new Uint8Array(this.buffer);
      // Views into the old buffer are detached; rebuild the map views too.
      if (this.map) this.bindMap();
    }
  }

  private f32At(ptr: number, len: number): Float32Array {
    return this.f32.subarray(ptr >> 2, (ptr >> 2) + len);
  }

  /** Cached wasm pointers, re-derived into views by `bindMap` on every memory growth. */
  private mapPtrs = {
    heights: 0,
    splat: 0,
    road: 0,
    sandVar: 0,
    grassVar: 0,
    pave: 0,
    nav: 0,
    structs: 0,
    structsLen: 0,
    verts: 0,
  };

  /** Upload the static map data (call again after `restart`). */
  refreshMap(): void {
    this.sync();
    const g = this.game;
    const grid = g.grid();
    const verts = (grid + 1) * (grid + 1);
    this.mapPtrs = {
      heights: g.heights_ptr(),
      splat: g.splat_ptr(),
      road: g.road_ptr(),
      sandVar: g.sand_var_ptr(),
      grassVar: g.grass_var_ptr(),
      pave: g.pave_ptr(),
      nav: g.nav_ptr(),
      structs: g.structures_ptr(),
      structsLen: g.structures_len(),
      verts,
    };
    this.map = {
      name: g.map_name(),
      worldSize: g.world_size(),
      grid,
      cell: g.world_size() / grid,
      waterLevel: g.water_level(),
      heights: new Float32Array(0),
      splat: new Uint8Array(0),
      road: new Uint8Array(0),
      sandVar: new Uint8Array(0),
      grassVar: new Uint8Array(0),
      pave: new Uint8Array(0),
      nav: new Uint8Array(0),
      structures: new Float32Array(0),
    };
    this.bindMap();
  }

  /**
   * (Re)create the map views against the current wasm buffer. wasm-bindgen grows linear
   * memory on demand, and growing detaches every existing ArrayBuffer view — without this
   * the terrain reads `undefined` and turns into NaN geometry.
   */
  private bindMap(): void {
    const p = this.mapPtrs;
    if (!p.verts) return;
    const grid = this.map.grid;
    this.map.heights = this.f32At(p.heights, p.verts);
    // Copied, not aliased: the renderer hands this straight to a `DataTexture`, which keeps
    // the array for the lifetime of the material. A view would be detached by the next memory
    // growth and every later upload would fail with INVALID_OPERATION (zero-length buffer).
    this.map.splat = this.u8.subarray(p.splat, p.splat + p.verts * 4).slice();
    this.map.road = this.u8.subarray(p.road, p.road + p.verts).slice();
    this.map.sandVar = this.u8.subarray(p.sandVar, p.sandVar + p.verts).slice();
    this.map.grassVar = this.u8.subarray(p.grassVar, p.grassVar + p.verts).slice();
    this.map.pave = this.u8.subarray(p.pave, p.pave + p.verts).slice();
    this.map.nav = this.u8.subarray(p.nav, p.nav + grid * grid);
    this.map.structures = this.f32At(p.structs, p.structsLen * STRIDE.structure);
  }

  get structureCount(): number {
    return this.game.structures_len();
  }

  structure(i: number, out: StructureView): StructureView {
    const b = this.map.structures;
    const o = i * STRIDE.structure;
    out.x = b[o + S.X];
    out.y = b[o + S.Y];
    out.z = b[o + S.Z];
    out.yaw = b[o + S.YAW];
    out.w = b[o + S.W];
    out.d = b[o + S.D];
    out.h = b[o + S.H];
    out.kind = b[o + S.KIND];
    out.team = b[o + S.TEAM];
    out.hp = b[o + S.HP];
    out.hpMax = b[o + S.HP_MAX];
    out.flags = b[o + S.FLAGS];
    out.phase = b[o + S.PHASE];
    out.id = b[o + S.ID];
    return out;
  }

  /** Advance the simulation and decode the new state into the pooled objects. */
  update(dt: number, inputs?: [InputFrame, InputFrame]): void {
    if (inputs) {
      for (let p = 0; p < 2; p++) {
        const i = inputs[p];
        this.game.set_input(
          p,
          i.throttle,
          i.steer,
          i.aim,
          i.aimPitch,
          i.hasAim,
          i.fire0,
          i.fire1,
          i.fire1Edge,
          i.brake,
          i.ascend,
          i.strafe,
        );
      }
    }
    this.game.update(dt);
    this.sync();
    this.decode();
  }

  private decode(): void {
    const g = this.game;

    // ---- vehicles
    let n = g.vehicles_len();
    if (n > this.vehicles.length) {
      for (let i = this.vehicles.length; i < n + 16; i++) this.vehicles.push({} as VehicleView);
    }
    const vb = this.f32At(g.vehicles_ptr(), n * STRIDE.vehicle);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE.vehicle;
      const v = this.vehicles[i];
      v.id = vb[o + V.ID];
      v.kind = vb[o + V.KIND];
      v.team = vb[o + V.TEAM];
      v.state = vb[o + V.STATE];
      v.x = vb[o + V.X];
      v.y = vb[o + V.Y];
      v.z = vb[o + V.Z];
      v.yaw = vb[o + V.YAW];
      v.turretYaw = vb[o + V.TURRET_YAW];
      v.gunPitch = vb[o + V.GUN_PITCH];
      v.speed = vb[o + V.SPEED];
      v.hp = vb[o + V.HP];
      v.hpMax = vb[o + V.HP_MAX];
      v.fuel = vb[o + V.FUEL];
      v.fuelMax = vb[o + V.FUEL_MAX];
      v.ammo0 = vb[o + V.AMMO0];
      v.ammo1 = vb[o + V.AMMO1];
      v.mines = vb[o + V.MINES];
      v.anim = vb[o + V.ANIM];
      v.flags = vb[o + V.FLAGS];
      v.reload0 = vb[o + V.RELOAD0];
      v.reload1 = vb[o + V.RELOAD1];
      v.buildT = vb[o + V.BUILD_T];
      v.pitch = vb[o + V.PITCH];
      v.roll = vb[o + V.ROLL];
      v.alt = vb[o + V.ALT];
      // Seconds left before this wreck is culled (0 while it is alive). The renderer tapers
      // the soot column and the burn-in with it, so a wreck that is about to disappear stops
      // smoking before it vanishes instead of being deleted mid-puff.
      v.wreck = vb[o + V.WRECK];
    }
    this.vehicleCount = n;

    // ---- projectiles
    n = g.projectiles_len();
    if (n > this.projectiles.length) {
      for (let i = this.projectiles.length; i < n + 32; i++) this.projectiles.push({} as ProjectileView);
    }
    const pb = this.f32At(g.projectiles_ptr(), n * STRIDE.projectile);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE.projectile;
      const p = this.projectiles[i];
      p.id = pb[o + P.ID];
      p.kind = pb[o + P.KIND];
      p.team = pb[o + P.TEAM];
      p.owner = pb[o + P.OWNER];
      p.x = pb[o + P.X];
      p.y = pb[o + P.Y];
      p.z = pb[o + P.Z];
      p.vx = pb[o + P.VX];
      p.vy = pb[o + P.VY];
      p.vz = pb[o + P.VZ];
      p.life = pb[o + P.LIFE];
      p.power = pb[o + P.POWER];
      p.seed = pb[o + P.SEED];
    }
    this.projectileCount = n;

    // ---- mines
    n = g.mines_len();
    // Grown like the vehicles and projectiles, and this one mattered. A hull carries `mine_max`
    // (ten for an HRSV) and resupply refills it, so a long match keeps laying mines; the field
    // passes 128, which is all this pool held. The decode then read `this.mines[i]` as
    // `undefined` and threw - and because that throw happens inside `update`, the whole rest of
    // the frame went with it: no camera, no world sync, no effects, no draw, no HUD. The game
    // looked frozen solid (a still picture, music still playing from the audio thread) and came
    // back on its own once enough mines detonated to drop under the old size.
    if (n > this.mines.length) {
      for (let i = this.mines.length; i < n + 16; i++) this.mines.push({} as MineView);
    }
    const mb = this.f32At(g.mines_ptr(), n * STRIDE.mine);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE.mine;
      const m = this.mines[i];
      m.x = mb[o + M.X];
      m.y = mb[o + M.Y];
      m.z = mb[o + M.Z];
      m.team = mb[o + M.TEAM];
      m.armed = mb[o + M.ARMED];
      m.blink = mb[o + M.BLINK];
      m.id = mb[o + M.ID];
    }
    this.mineCount = n;

    // ---- turrets
    n = g.turrets_len();
    // The same guard for the same reason: the count follows the map's turret towers today, but a
    // short pool here would fail exactly as the mines did - inside `update`, taking the frame.
    if (n > this.turrets.length) {
      for (let i = this.turrets.length; i < n + 8; i++) this.turrets.push({} as TurretView);
    }
    const tb = this.f32At(g.turrets_ptr(), n * STRIDE.turret);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE.turret;
      const t = this.turrets[i];
      t.x = tb[o + T.X];
      t.y = tb[o + T.Y];
      t.z = tb[o + T.Z];
      t.yaw = tb[o + T.YAW];
      t.team = tb[o + T.TEAM];
      t.alive = tb[o + T.ALIVE];
      t.structId = tb[o + T.STRUCT];
      t.reload = tb[o + T.RELOAD];
    }
    this.turretCount = n;

    // ---- flags
    const fb = this.f32At(g.flags_ptr(), 2 * STRIDE.flag);
    for (let i = 0; i < 2; i++) {
      const o = i * STRIDE.flag;
      const f = this.flags[i];
      f.x = fb[o + F.X];
      f.y = fb[o + F.Y];
      f.z = fb[o + F.Z];
      f.state = fb[o + F.STATE];
      f.team = fb[o + F.TEAM];
      f.carrier = fb[o + F.CARRIER];
      f.dropT = fb[o + F.DROP_T];
      f.wave = fb[o + F.WAVE];
    }

    // ---- events (fresh each frame)
    n = g.events_len();
    if (n > this.events.length) {
      for (let i = this.events.length; i < n + 64; i++) this.events.push({} as EventView);
    }
    const eb = this.f32At(g.events_ptr(), n * STRIDE.event);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE.event;
      const e = this.events[i];
      e.kind = eb[o + E.KIND];
      e.x = eb[o + E.X];
      e.y = eb[o + E.Y];
      e.z = eb[o + E.Z];
      e.a = eb[o + E.A];
      e.b = eb[o + E.B];
      e.c = eb[o + E.C];
      e.d = eb[o + E.D];
    }
    this.eventCount = n;

    // ---- HUD
    const hb = this.f32At(g.hud_ptr(), 2 * STRIDE.playerHud);
    for (let i = 0; i < 2; i++) {
      const o = i * STRIDE.playerHud;
      const h = this.hud[i];
      h.vehicleId = hb[o + HUD.VEHICLE_ID];
      h.vehicleKind = hb[o + HUD.VEHICLE_KIND];
      h.hp = hb[o + HUD.HP];
      h.hpMax = hb[o + HUD.HP_MAX];
      h.fuel = hb[o + HUD.FUEL];
      h.fuelMax = hb[o + HUD.FUEL_MAX];
      h.ammo0 = hb[o + HUD.AMMO0];
      h.ammo0Max = hb[o + HUD.AMMO0_MAX];
      h.ammo1 = hb[o + HUD.AMMO1];
      h.ammo1Max = hb[o + HUD.AMMO1_MAX];
      h.mines = hb[o + HUD.MINES];
      h.mineMax = hb[o + HUD.MINE_MAX];
      h.kills = hb[o + HUD.KILLS];
      h.deaths = hb[o + HUD.DEATHS];
      h.flags = hb[o + HUD.FLAGS];
      h.respawnT = hb[o + HUD.RESPAWN_T];
      h.aimYaw = hb[o + HUD.AIM_YAW];
      h.bearingToFlag = hb[o + HUD.BEARING_TO_FLAG];
      h.status = hb[o + HUD.STATUS];
    }
    const thb = this.f32At(g.team_hud_ptr(), 2 * STRIDE.teamHud);
    for (let i = 0; i < 2; i++) {
      const o = i * STRIDE.teamHud;
      const t = this.teamHud[i];
      t.readyJeep = thb[o + TEAM.READY_JEEP];
      t.readyTank = thb[o + TEAM.READY_TANK];
      t.readyHrsv = thb[o + TEAM.READY_HRSV];
      t.readyHeli = thb[o + TEAM.READY_HELI];
      t.buildJeep = thb[o + TEAM.BUILD_JEEP];
      t.buildTank = thb[o + TEAM.BUILD_TANK];
      t.buildHrsv = thb[o + TEAM.BUILD_HRSV];
      t.buildHeli = thb[o + TEAM.BUILD_HELI];
      t.score = thb[o + TEAM.SCORE];
      t.flagState = thb[o + TEAM.FLAG_STATE];
      t.turrets = thb[o + TEAM.TURRETS];
      t.enemyScore = thb[o + TEAM.ENEMY_SCORE];
    }
  }

  requestVehicle(player: number, kind: number): void {
    this.game.request_vehicle(player, kind);
  }

  /**
   * Player-facing match options: CPU force level, the practice range and the CPU-allies toggle
   * (field a tank + jeep AI garrison on every human team). Applied to the live wasm world, so
   * it also affects the match the title screen is already built on. Options are carried across
   * `restart` by the core; a fresh `Sim.load` needs them re-applied.
   */
  /**
   * Per-team ceiling on concurrent CPU hulls: `0` leaves the difficulty rules in charge
   * (2 / 3 / 6, and 2 for CPU allies). A stress test raises it — `?maxveh=24` or the console.
   */
  setVehicleCap(cap: number): void {
    this.game.set_vehicle_cap(Math.max(0, Math.round(cap)));
  }

  vehicleCap(): number {
    return this.game.vehicle_cap();
  }

  /** A defence tower's reach, for the debug range overlay. */
  towerRange(): number {
    return this.game.tower_range();
  }

  /** The dotted name of every tuning slot, in `setTuning` order (see `rf-core::tuning`). */
  tuningLayout(): string[] {
    return this.game.tuning_layout();
  }

  /** Install config tuning overrides: a `NaN` (or missing) slot keeps the compiled-in value. */
  setTuning(values: Float32Array): void {
    // The binding takes the `Float32Array` straight through (wasm-bindgen copies it in), so the
    // 416-slot layout never becomes a JS number array on the way.
    this.game.set_tuning(values);
  }

  /** The tuning in force, in `tuningLayout` order - for the harness to check what it set. */
  tuningValues(): Float32Array {
    return this.game.tuning_values();
  }

  setOptions(difficulty: number, sandbox: boolean, cpuAllies: boolean): void {
    // `set_options` is new in rf-core; the committed bindings predate it, so call through a
    // narrow cast until the next `scripts/build-wasm.sh` regenerates `pkg/` (the parent runs
    // that rebuild). Typing it here keeps `pnpm typecheck` green in the meantime.
    (this.game as unknown as { set_options(d: number, s: boolean, a: boolean): void }).set_options(
      difficulty,
      sandbox,
      cpuAllies,
    );
  }

  /**
   * Hand a human slot's hull over to the simulation AI (attract/demo mode). The core then
   * drives it through `think_vehicle` exactly like any CPU driver — real navigation, real
   * targeting, no blind autopilot — and the anti-camping drones ignore that slot. Carried
   * across `restart` by the core; a fresh `Sim.load` needs it re-applied.
   */
  setCpuDriven(slot: number, on: boolean): void {
    this.game.set_cpu_driven(slot, on);
  }

  restart(seed: number, mapIndex: number, mapMode = 0, mapSize = 0): void {
    this.game.restart(seed, mapIndex, mapMode, mapSize);
    this.refreshMap();
  }

  nextRound(): void {
    this.game.force_next_round();
  }

  /** Console/test seam: end the round as a win for the player's team (real round-over flow). */
  roundWin(): void {
    this.game.force_round_win();
  }

  /** Console/test seam: end the round as a loss for the player's team. */
  roundLose(): void {
    this.game.force_round_lose();
  }

  /** Team defended by a player slot (single player: the human always defends team 0). */
  playerTeam(player: number): number {
    if (this.twoPlayer) return player;
    return player === 0 ? 0 : 1;
  }

  get time(): number {
    return this.game.time();
  }
  get matchState(): number {
    return this.game.state();
  }
  get roundWinner(): number {
    return this.game.round_winner();
  }
  get roundTimeLeft(): number {
    return this.game.round_time_left();
  }
  score(team: number): number {
    return this.game.score(team);
  }
  get terrainRev(): number {
    return this.game.terrain_rev();
  }
}
