/**
 * Game shell: boots the wasm simulation, wires input to the fixed-step loop, drives the
 * renderer, the HUD, the menus and the audio, and glues the round flow together.
 */
import * as THREE from 'three';
import { createGameAudio, type GameAudio, type SfxName } from './audio/audio.js';
import { createSurfaceLibrary } from './assets/textures/library.js';
import { setVehicleLook, vehicleLook, vehicleLookInfo, VEHICLE_LOOKS } from './assets/vehicleLook.js';
import { createHud } from './hud/hud.js';
import { createMenus } from './hud/menus.js';
import {
  applyQualityClass,
  config,
  configFromFile,
  overrides,
  patchConfig,
  defaultConfig,
  loadConfig,
  resetOverrides,
  setOverrides,
  tuningValues,
  type GameConfig,
  type PlayerSettings,
} from './config.js';
import type { HudFrame, Notification } from './hud/types.js';
import { createCameraRig, type CameraRig } from './render/camera.js';
import { createEffects, type Effects } from './render/effects.js';
import { clamp } from './render/math.js';
import { createGameScene, type GameScene, type Quality } from './render/scene.js';
import { createTerrain, type Terrain } from './render/terrain.js';
import { createRangeOverlay } from './render/ranges.js';
import { createWorldView, type WorldView } from './render/world.js';
import { emptyInput, Sim, type InputFrame } from './sim/bridge.js';
import {
  EKIND,
  MATCHSTATE,
  NOTIFY,
  SFX_NAME,
  VFLAG,
  VKIND,
  VSTATE,
  type StructureView,
  type VehicleView,
} from './sim/layout.js';

/* ------------------------------------------------------------------ input */

const KEY_FIRE_ALT = new Set(['Space']);
/**
 * Seconds of "no hull" the music will ride through before it is retired. Long enough to cover a
 * death, the garage pick and the respawn into the same vehicle (so the track is not restarted
 * from the top), short enough that sitting in a menu does not leave it playing indefinitely.
 */
const THEME_IDLE_HOLD = 12;
const KEY_ASCEND = new Set(['ControlLeft', 'ControlRight']);

class InputState {
  keys = new Set<string>();
  mouseNdc = new THREE.Vector2(0, 0);
  mouseDown = [false, false, false];
  fire1Edge = false;
  wheel = 0;
  mouseInside = false;
  pointerLocked = false;
  private firstGesture = false;

  attach(el: HTMLElement, onGesture: () => void): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      onGesture();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    // Browsers only unlock audio from a gesture on the page, and our menus are DOM elements
    // that sit above the canvas - so listen at the window level too, otherwise a player who
    // only ever clicks buttons would never hear anything.
    window.addEventListener('mousedown', () => onGesture(), { capture: true });
    window.addEventListener('touchstart', () => onGesture(), { capture: true, passive: true });
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      this.mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      this.mouseInside = true;
      if (!this.firstGesture) {
        this.firstGesture = true;
        onGesture();
      }
    });
    el.addEventListener('mouseleave', () => (this.mouseInside = false));
    el.addEventListener('mousedown', (e) => {
      this.mouseDown[e.button] = true;
      if (e.button === 2) this.fire1Edge = true;
      e.preventDefault();
      onGesture();
    });
    window.addEventListener('mouseup', (e) => (this.mouseDown[e.button] = false));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        this.wheel += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }
  axis(neg: string[], pos: string[]): number {
    let v = 0;
    for (const k of neg) if (this.down(k)) v -= 1;
    for (const k of pos) if (this.down(k)) v += 1;
    return clamp(v, -1, 1);
  }
  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }
}

/* ------------------------------------------------------------------- game */

type Phase = 'boot' | 'title' | 'garage' | 'playing' | 'roundend';

class Game {
  private gs: GameScene;
  private sim!: Sim;
  private terrain!: Terrain;
  private world!: WorldView;
  private fx!: Effects;
  private rig!: CameraRig;
  private rig2: CameraRig | null = null;
  private audio: GameAudio;
  private hud = createHud(document.getElementById('ui') as HTMLElement);
  private menus = createMenus(document.getElementById('ui') as HTMLElement);
  private input = new InputState();
  private quality: Quality = 'high';
  private phase: Phase = 'boot';
  private mapIndex = 0;
  /** Generator mode: 0 = classic (procedural islands, the default), 1 = mirror. */
  private mapMode = 0;
  /** Battlefield size: 0 = small (512 m), 1 = medium (1024 m), 2 = big (2048 m). */
  private mapSize = 0;
  private seed = 1337;
  /** Random play (title screen): roll a new seed and sector on every START. */
  private randomPlay = false;
  private twoPlayer = false;
  private playerIndex = 0;
  private mapNames: string[] = [];
  /** `?auto&look=x,z`: park the camera on a world point so a capture can inspect any spot. */
  private freeLook: THREE.Vector3 | null = null;
  private notifications: Notification[] = [];
  private banner: HudFrame['banner'] = null;
  private structPool: StructureView[] = [];
  private structSnapshot: StructureView[] = [];
  private structTimer = 0;
  private last = performance.now();
  private fps = 60;
  private time = 0;
  private muted = false;
  private prevFire1 = false;
  private prevFire1P2 = false;
  private groundAim = new THREE.Vector3();
  /** Cursor ray + the aircraft point it picked; reused, see `pickAirTarget`. */
  private aimRay = new THREE.Raycaster();
  private airAim = new THREE.Vector3();
  /** Aircraft id the aim is currently laid on, or -1 for a ground aim (see `probe`). */
  private airPickId = -1;
  private lastAimPitch = 0;
  private focus = new THREE.Vector3();
  private currentTheme: string | null = null;
  /**
   * Seconds the player has been without a hull (dead, in the garage, between rounds).
   *
   * The theme is chosen per *hull*, so the moment a player died `updateAudio(null)` stopped the
   * music and the respawn started the same track again from the top — heard as "the music keeps
   * restarting". A track now rides through a gap this long before it is retired, which covers a
   * death, the garage pick and the respawn.
   */
  private themeIdleT = 0;
  /** Dev log of theme transitions and how many times a track has been (re)started. */
  private themeLog: string[] = [];
  private themeStarts = 0;
  private garageOpenFor = -1;
  /** True between asking the garage for a hull and that hull appearing in the world. */
  private vehicleRequested = false;
  /**
   * True from the moment a match starts until every human has picked a first vehicle. The
   * world is held still while it is set: the enemy AI must not play a match the player has
   * not deployed into yet.
   */
  private awaitingFirstPick = false;
  /**
   * Set when the garage panel was just closed by Escape. The closing keydown reaches
   * InputState *after* the close handler runs (menus' listener is registered first), so the
   * next frame's poll would see Escape held and immediately reopen the cancelled panel —
   * this flag swallows exactly that one stale read.
   */
  private escapeSwallow = false;
  private disposed = false;
  private showDebug = false;
  private frames = 0;
  private maxFrames = 0;
  /**
   * Per-phase frame cost accumulators in ms (profiling hook, read via `rfProfile()`).
   * Indexes: 0 input, 1 sim (wasm step + decode), 2 cameras, 3 terrain, 4 world, 5 fx,
   * 6 misc (audio/flow/ui timers), 7 draw (renderer), 8 hud. Always on; the cost is a few
   * `performance.now()` reads per frame.
   */
  private perfAcc = new Float64Array(9);
  private perfFrames = 0;
  /** Minimum wall-clock gap between processed frames in ms; 0 = uncapped (see `?fps=`). */
  private frameGap = 1000 / 60;
  /** Deadline for the next processed frame; 0 until the loop has scheduled one. */
  private nextFrameAt = 0;
  private demo = false;
  /**
   * Attract mode: the vehicle kinds re-fielded for each human slot when its CPU-driven hull
   * dies or a round restarts (there is no one to click the garage). Slot-aligned, like
   * `vehicle2` in the boot query.
   */
  private demoVehicleKind: [number, number] = [VKIND.JEEP, VKIND.TANK];
  /** CPU FORCE: 0 easy / 1 medium / 2 hard. Defaults to medium per the report. */
  private cpu: 'easy' | 'medium' | 'hard' = 'medium';
  /** Practice range: no enemy units and no defence towers (see `World::sandbox`). */
  private sandbox = false;
  /** CPU allies: a tank + jeep AI garrison fights on the player's team (see `World::cpu_allies`). */
  private allies = false;
  /**
   * Per-team ceiling on concurrent CPU hulls (`?maxveh=N`), `0` for the difficulty rules.
   * A stress dial: `?maxveh=24&cpu=hard` fills both sides far past the 2 / 3 / 6 the rules ask
   * for. While a cap is set the commander's yard rule also relaxes (two hulls at home count as
   * busy, not one), so a sixteen-hull force is not held at garrison size by one hull refuelling.
   * Reinforcements always come one every three seconds a team (`CPU_SPAWN_DELAY`) — no batches on
   * the pad — so the field settles where the fighting can sustain it. Console:
   * `set_vehicle_cap(n)`.
   */
  private vehicleCap = 0;
  /**
   * Range overlay (`rfRanges()`): a green circle per vehicle for `sight` and a red one for the
   * longest weapon reach. Lazily created on first use so the normal path pays nothing.
   */
  private ranges: ReturnType<typeof createRangeOverlay> | null = null;
  /**
   * Death cam: the wreck of the player's own hull, and how long the camera keeps watching it
   * before the respawn (garage panel, or the demo's re-field) is allowed to happen.
   *
   * A hull that dies does not vanish: it burns as a wreck for several seconds, and the moment of
   * the kill is the most interesting thing on the screen. Snapping the camera to the base and
   * throwing the panel up in the same frame skips it.
   */
  private deathWreck = -1; // vehicle id, -1 when not watching one
  private deathT = 0;
  /** Seconds the camera holds a dead hull before the respawn is offered. */
  private static readonly DEATH_CAM = 3.0;
  /**
   * Player one's strafe value for the frame built this tick, mirrored for `probe()` so a
   * harness can prove `Z`/`C` reaches the helicopter. Recomputed every frame, read on demand.
   */
  private lastStrafe = 0;
  /** Persistent practice-range badge in the #ui overlay (created once, toggled on change). */
  private sandboxEl: HTMLDivElement;

  /** The config file's settings, already merged with the player's stored changes. */
  private cfg: GameConfig;

  constructor(private canvas: HTMLCanvasElement, cfg: GameConfig = defaultConfig()) {
    this.cfg = cfg;
    const params = new URLSearchParams(location.search);
    // The config file is the baseline for everything below; the URL parameters further down are
    // the harness override, and the settings column writes back through `setOverrides`.
    this.quality = cfg.video.quality;
    this.cpu = cfg.match.cpu;
    this.sandbox = cfg.match.sandbox;
    this.allies = cfg.match.allies;
    this.vehicleCap = cfg.match.maxveh;
    this.mapIndex = cfg.match.map >= 0 ? cfg.match.map : 0;
    this.mapMode = cfg.match.mode === 'mirror' ? 1 : 0;
    this.mapSize = cfg.match.size === 'medium' ? 1 : cfg.match.size === 'big' ? 2 : 0;
    this.seed = cfg.match.seed || this.seed;
    this.randomPlay = cfg.match.randomPlay;
    this.demoVehicleKind = [cfg.match.vehicle, cfg.match.vehicle2];
    this.frameGap = cfg.runtime.fps > 0 ? 1000 / cfg.runtime.fps : 0;
    // The team-identity look (see `assets/vehicleLook.ts`) is read when a vehicle rig is built,
    // so it has to be set before the world view builds any — hence here rather than in `boot`.
    // `setVehicleLook` ignores an id it does not know, leaving the module's `DEFAULT_LOOK`.
    setVehicleLook(cfg.runtime.look);
    // The screenshot harness renders offscreen; keeping the drawing buffer alive lets us
    // grab a PNG with canvas.toDataURL() without waiting on the compositor (SwiftShader is
    // far too slow for compositor-timed screenshots).
    this.gs = createGameScene(canvas, this.quality, params.has('capture') || params.has('auto'));
    this.audio = createGameAudio();
    this.audio.setMasterVolume(cfg.audio.master);
    this.audio.setMusicVolume(cfg.audio.music);
    this.rig = createCameraRig(this.gs.camera);
    this.input.attach(canvas, () => void this.audio.resume());
    // `?cpu=easy|medium|hard`, `?sandbox=1` and `?allies=1` are the harness entry points for
    // the three match options. The menu control reflects the same URL (menus.ts reads it too).
    const cpuParam = params.get('cpu');
    this.cpu = cpuParam === 'easy' || cpuParam === 'hard' ? cpuParam : this.cpu;
    if (params.has('sandbox')) this.sandbox = params.get('sandbox') === '1' || params.get('sandbox') === 'true';
    if (params.has('allies')) this.allies = params.get('allies') === '1' || params.get('allies') === 'true';
    this.vehicleCap = Math.max(0, Math.round(Number(params.get('maxveh') ?? this.vehicleCap) || 0));
    // `?look=N` overrides the config file's `runtime.look` (same precedence as every other
    // setting: file, then stored player change, then the URL). It only changes what the model
    // builders emit, so setting it here — before any rig is built — is enough.
    if (params.has('look')) setVehicleLook(Number(params.get('look')));
    // `?mode=mirror` selects the older half-mirrored generator; anything else (including no
    // parameter) is the procedural classic maps. `?seed=` picks the island, and only `mirror`
    // makes the seed less meaningful — classic islands are entirely seed-driven.
    const modeParam = params.get('mode');
    if (modeParam !== null) this.mapMode = modeParam === 'mirror' ? 1 : 0;
    // `?size=small|medium|big` picks the battlefield size. The world's dimensions are fixed when
    // it is built, so this only takes effect on a load/restart — `start` rebuilds when it differs
    // from the boot world's size.
    const sizeParam = (params.get('size') ?? '').toLowerCase();
    if (sizeParam) this.mapSize = sizeParam === 'medium' ? 1 : sizeParam === 'big' ? 2 : 0;
    const seedParam = Number(params.get('seed'));
    if (Number.isFinite(seedParam) && seedParam !== 0 && params.has('seed')) this.seed = seedParam | 0;
    // Persistent range badge: built once, toggled only when the option changes, so there is no
    // per-frame DOM work. The toast alone is easy to miss once the player is driving.
    this.sandboxEl = document.createElement('div');
    this.sandboxEl.className = 'rf-sandbox-badge';
    this.sandboxEl.textContent = 'PRACTICE RANGE — NO ENEMY UNITS';
    (document.getElementById('ui') as HTMLElement).appendChild(this.sandboxEl);
    this.syncSandboxBadge();
    // Show the values that are actually in force - config file, then any URL override - so the
    // panel cannot disagree with the match it is describing. Changes made in the panel are
    // written back through `setOverrides`, which is what makes them survive a reload.
    this.menus.applyInitial({
      quality: this.quality,
      master: this.audio.masterVolume(),
      music: this.audio.musicVolume(),
      cpu: this.cpu,
      sandbox: this.sandbox,
      allies: this.allies,
    });
  }

  /** 0 easy / 1 medium / 2 hard, matching `World::difficulty`. */
  private cpuIndex(): number {
    return this.cpu === 'easy' ? 0 : this.cpu === 'hard' ? 2 : 1;
  }

  /**
   * Push the match options into the simulation. Called after **every** `Sim.load` and from
   * `start`, because `Sim.load` builds a fresh `Game` whose world defaults to medium/no-range;
   * the core carries the options across `restart` itself.
   */
  private applyOptions(): void {
    this.sim.setOptions(this.cpuIndex(), this.sandbox, this.allies);
    // Re-applied on every match start for the same reason the options are: a start that had to
    // rebuild the sim (`Sim.load`) would otherwise drop the stress-test cap with the old world.
    this.sim.setVehicleCap(this.vehicleCap);
    this.syncSandboxBadge();
  }

  /**
   * Install the config file's tuning overrides into the simulation.
   *
   * The layout (the name of every slot, in order) is published by the engine, so this side never
   * keeps its own copy of the field order: the config's dotted keys are mapped onto that array,
   * and anything the file does not mention stays `NaN`, which the engine reads as "keep the
   * compiled-in default". Safe to call on a live world - the engine re-issues the specs of hulls
   * already in the field - so `rfConfigSet` can change a number and watch it take effect.
   */
  private applyTuning(): void {
    const layout = this.sim.tuningLayout();
    this.sim.setTuning(tuningValues(layout));
    applyQualityClass(config().video.quality);
  }

  /**
   * Push the whole config into everything that reads it: renderer quality, mixer volumes, match
   * options and the simulation's tuning. Used by the dev hooks, which exist so a setting can be
   * changed and watched without a reload (`rfConfigSet('tuning.weapons.heli_cannon.life', 6)`).
   */
  private applyConfig(): void {
    this.quality = this.cfg.video.quality;
    this.setQuality(this.quality);
    this.audio.setMasterVolume(this.cfg.audio.master);
    this.audio.setMusicVolume(this.cfg.audio.music);
    this.cpu = this.cfg.match.cpu;
    this.sandbox = this.cfg.match.sandbox;
    this.allies = this.cfg.match.allies;
    this.vehicleCap = this.cfg.match.maxveh;
    this.applyTuning();
    this.applyOptions();
    this.menus.applyInitial({
      quality: this.quality,
      master: this.cfg.audio.master,
      music: this.cfg.audio.music,
      cpu: this.cpu,
      sandbox: this.sandbox,
      allies: this.allies,
    });
  }

  /** The vehicles and turrets the range overlay draws. */
  private rangeFrame() {
    return {
      vehicles: this.sim.vehicles,
      vehicleCount: this.sim.vehicleCount,
      specs: this.sim.specs,
      turrets: this.sim.turrets,
      turretCount: this.sim.turretCount,
      towerRange: this.sim.towerRange(),
    };
  }

  /** Toggle (or set) the debug range overlay, drawing it immediately. */
  private toggleRanges(on?: boolean): boolean {
    if (!this.ranges) this.ranges = createRangeOverlay(this.gs.scene);
    this.ranges.setEnabled(on ?? !this.ranges.enabled);
    this.ranges.update(this.rangeFrame());
    return this.ranges.enabled;
  }

  private syncSandboxBadge(): void {
    this.sandboxEl.classList.toggle('is-on', this.sandbox);
  }

  async boot(): Promise<void> {
    this.menus.showLoading(0.05, 'forging terrain shaders');
    const bar = document.getElementById('bootbar');
    if (bar) bar.style.width = '10%';
    const bootParams = new URLSearchParams(location.search);
    const lib = createSurfaceLibrary({
      anisotropy: this.gs.renderer.capabilities.getMaxAnisotropy(),
      size: Number(bootParams.get('texsize') ?? (this.quality === 'high' ? 512 : 256)),
    });
    this.menus.showLoading(0.35, 'waking the simulation');
    if (bar) bar.style.width = '35%';
    this.sim = await Sim.load(this.seed, this.mapIndex, false, this.mapMode, this.mapSize);
    this.applyTuning();
    this.applyOptions();
    // `?map=play`: a map made in the editor (which parks the bytes in local storage and sends the
    // player here). A map that will not decode leaves the generated world in place.
    if (bootParams.get('map') === 'play') {
      const edited = await Sim.fromStoredMap(false);
      if (edited) {
        this.sim = edited;
        this.applyTuning();
        this.applyOptions();
        this.seed = edited.game.seed();
        this.mapSize = edited.mapSize;
        this.mapMode = edited.mapMode;
      }
    }
    this.mapNames = this.sim.mapNames;
    this.menus.showLoading(0.6, 'building the battlefield');
    if (bar) bar.style.width = '60%';
    this.libRef = lib;
    this.fx = createEffects(this.gs.scene, lib, {
      quality: this.quality,
      // Decals and debris need to sit on the ground; the terrain owns the sampler.
      terrainHeight: (x, z) => this.terrain?.heightAt(x, z) ?? 0,
    });
    this.buildMap();
    this.menus.showLoading(0.9, 'briefing');
    if (bar) bar.style.width = '90%';
    this.showTitleScreen();
    this.phase = 'title';
    this.menus.hideLoading();
    // Headless/screenshot harness entry point: ?auto=1&vehicle=2&map=1&warmup=8&quality=high
    const q = new URLSearchParams(location.search);
    if (q.has('auto')) {
      // Through `setQuality` rather than `gs.setQuality`, so the stylesheet's quality class
      // follows the harness override too (it is what drops the expensive glass on "low").
      this.setQuality((q.get('quality') as Quality) ?? this.quality);
      // `?map=play` is not an index: the world is already the edited map, and re-loading by index
      // here would throw it away (`Number('play')` is NaN, which is "not zero" and so looked like
      // a request for a different sector).
      const playingEdited = q.get('map') === 'play';
      const idxParam = Number(q.get('map') ?? this.mapIndex);
      if (!playingEdited) {
        this.mapIndex = Number.isFinite(idxParam) ? idxParam | 0 : this.mapIndex;
      }
      this.seed = Number(q.get('seed') ?? this.seed);
      if (!playingEdited && this.mapIndex !== 0) {
        this.sim = await Sim.load(this.seed, this.mapIndex, false, this.mapMode, this.mapSize);
        this.applyOptions();
        this.buildMap();
      }
      this.menus.hideTitle();
      this.phase = 'playing';
      // Auto mode skips the menu: cancel the title theme parked by `showTitleScreen` so a
      // gesture before the hull spawns does not start menu music in a headless harness.
      this.audio.playTheme(null);
      this.demo = q.has('demo');
      if (this.demo) {
        // Attract mode: hand the human slot(s) to the sim AI. The core drives those hulls
        // through its normal vehicle AI from here on — and skips anti-camping drones for
        // them, since a driver is not camping. Re-applied after every Sim.load below.
        this.demoVehicleKind = [
          Number(q.get('vehicle') ?? VKIND.JEEP),
          Number(q.get('vehicle2') ?? VKIND.TANK),
        ];
      }
      const applyDemoCpu = (): void => {
        if (!this.demo) return;
        this.sim.setCpuDriven(0, true);
        if (q.has('two')) this.sim.setCpuDriven(1, true);
      };
      applyDemoCpu();
      // `?look=x,z` parks the capture camera; the bare `?look=N` form is the vehicle visibility
      // look (parsed in the constructor), so the camera form must be the one with a comma.
      const look = q.get('look');
      if (look && look.includes(',')) {
        const [lx, lz] = look.split(',').map(Number);
        this.freeLook = new THREE.Vector3(lx, 0, lz);
      }
      this.sim.requestVehicle(0, Number(q.get('vehicle') ?? VKIND.JEEP));
      const warm = Number(q.get('warmup') ?? 0);
      if (warm > 0) {
        // Demo or not, the sim now owns the controls: plain steps so a capture lands
        // mid-action on the CPU driver's own terms.
        for (let i = 0; i < warm * 60; i++) this.sim.update(1 / 60);
      }
      if (q.has('debug')) this.showDebug = true;
      if (q.has('two')) {
        this.twoPlayer = true;
        this.rig2 = createCameraRig(new THREE.PerspectiveCamera(46, 16 / 9, 0.6, 1200));
        this.sim = await Sim.load(this.seed, this.mapIndex, true, this.mapMode, this.mapSize);
        this.applyOptions();
        this.buildMap();
        applyDemoCpu(); // fresh Game instance: the cpu_driven flags must be re-applied
        this.sim.requestVehicle(0, Number(q.get('vehicle') ?? VKIND.JEEP));
        this.sim.requestVehicle(1, Number(q.get('vehicle2') ?? VKIND.TANK));
        const warm2 = Number(q.get('warmup') ?? 0);
        for (let i = 0; i < warm2 * 60; i++) this.sim.update(1 / 60);
      }
      const dump = [];
      for (let i = 0; i < this.sim.vehicleCount; i++) {
        const v = this.sim.vehicles[i];
        dump.push(
          `#${v.id} kind${v.kind} team${v.team} slot${v.buildT} st${v.state} hp${Math.round(v.hp)} ` +
            `@${Math.round(v.x)},${Math.round(v.z)}`,
        );
      }
      console.log(
        `[boot] auto started: map=${this.sim.map.name} vehicles=${this.sim.vehicleCount} ` +
          `playerKind=${this.sim.hud[0].vehicleKind} status=${this.sim.hud[0].status} phase=${this.phase}\n  ` +
          dump.join('\n  '),
      );
    }
    this.maxFrames = q.has('maxframes') ? Number(q.get('maxframes')) : 0;
    // Render-rate cap. The simulation is fixed-step at 60 Hz, so on a display that refreshes
    // faster than that the extra frames draw an unchanged world a second time — cost with no
    // new information, and on a software rasteriser that cost decides whether it is playable.
    // Absent, empty or unparseable -> 60; an explicit `?fps=0` removes the cap.
    const rawFps = q.get('fps');
    if (rawFps !== null && rawFps.trim() !== '') {
      // Only an explicit `?fps=` overrides the config file; without one the constructor's value
      // (from `runtime.fps`) stands.
      const parsedFps = Number(rawFps);
      this.frameGap = Number.isFinite(parsedFps) && parsedFps > 0 ? 1000 / parsedFps : 0;
    }
    // Synchronous frame capture for the headless harness.
    (window as unknown as { rfCapture: () => string }).rfCapture = () => {
      this.gs.render();
      return this.canvas.toDataURL('image/png');
    };
    (window as unknown as { rfProbe: () => unknown }).rfProbe = () => this.probe();
    // Advance the game by `frames` fixed 1/60 s steps with no rendering: software WebGL runs
    // this scene at well under 1 fps, so a wall-clock wait advances the simulation by almost
    // nothing and any check that depends on a round's flight time (does a shot at an aircraft
    // connect?) becomes a coin flip. Input is re-read every step, so the harness can hold the
    // fire button and re-aim between chunks exactly as the frame loop does.
    (window as unknown as { rfStep: (frames?: number, dt?: number) => void }).rfStep = (frames = 1, dt = 1 / 60) => {
      for (let i = 0; i < frames; i++) {
        this.time += dt;
        this.handleGlobalKeys();
        const inputs = this.buildInputs(dt);
        if (this.phase === 'playing' || this.phase === 'garage' || this.phase === 'roundend') {
          this.sim.update(this.awaitingFirstPick ? 0 : dt, inputs);
          this.consumeEvents();
        }
        const pv = this.playerVehicle();
      if (!pv && this.deathT <= 0) this.startDeathCam(this.playerIndex);
      this.updateCameras(dt, this.cameraTarget(pv, dt));
      }
    };
    // Render one frame and report what it cost (used by the capture harness).
    (window as unknown as { rfStats: () => unknown }).rfStats = () => {
      // With the composer active every internal pass calls renderer.render(), and each of
      // those auto-resets renderer.info — so a plain render() + read reports only the last
      // bloom quad, not the frame. Accumulate across all passes instead.
      const r = this.gs.renderer;
      const autoReset = r.info.autoReset;
      r.info.autoReset = false;
      r.info.reset();
      this.gs.render();
      const info = r.info;
      r.info.autoReset = autoReset;
      return {
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        textures: info.memory.textures,
        geometries: info.memory.geometries,
        meshCount: this.gs.scene.children.length,
      };
    };
    // Every mesh bigger than `minMetres` in world space, biggest first: name, parent, world
    // size, position, instance count. A stray slab — "there is a rectangle on the ground that
    // should not be there" — shows up here with the object that carries it, which the
    // name/triangle census cannot say (a unit quad scaled to 200 m triangles the same as a
    // unit quad).
    (window as unknown as { rfScene: (minMetres?: number) => unknown }).rfScene = (minMetres = 8) => {
      this.gs.scene.updateMatrixWorld(true);
      const rows: Array<Record<string, unknown>> = [];
      this.gs.scene.traverse((o) => {
        const m = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number; instanceMatrix?: THREE.InstancedBufferAttribute };
        if (!m.isMesh || !m.geometry) return;
        const g = m.geometry as THREE.BufferGeometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        if (!bb) return;
        const geo = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
        const e = m.matrixWorld.elements;
        const own = [Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])];
        // The *largest instance*, not the mesh's own scale: an InstancedMesh whose geometry is a
        // unit quad can carry one instance scaled to a hundred metres, and measuring the mesh
        // alone reports 1 m — which is exactly how a stray slab hides from this dump.
        // The *largest instance* by volume, with its own per-axis scale: an InstancedMesh whose
        // geometry is a unit quad can carry one instance scaled to a hundred metres, and
        // measuring the mesh alone reports 1 m. Scaling every axis by the largest single axis
        // (the first version of this hook) invents sizes for non-uniform instances — a
        // helicopter pad's 4.7 m mast read as a 130 m column.
        let instScale = [1, 1, 1];
        let biggest = -1;
        let biggestVol = 0;
        if (m.isInstancedMesh && m.instanceMatrix) {
          const a = m.instanceMatrix.array;
          const n = m.count ?? 0;
          for (let k = 0; k < n; k++) {
            const b = k * 16;
            const sc = [
              Math.hypot(a[b], a[b + 1], a[b + 2]),
              Math.hypot(a[b + 4], a[b + 5], a[b + 6]),
              Math.hypot(a[b + 8], a[b + 9], a[b + 10]),
            ];
            const vol = Math.max(sc[0] * geo[0], 1e-4) * Math.max(sc[1] * geo[1], 1e-4) * Math.max(sc[2] * geo[2], 1e-4);
            if (vol > biggestVol) {
              biggestVol = vol;
              biggest = k;
              instScale = sc;
            }
          }
        }
        const size = geo.map((v, i) => v * own[i] * instScale[i]);
        if (Math.max(size[0], size[1], size[2]) < minMetres) return;
        let at = [e[12], e[13], e[14]];
        if (biggest >= 0 && m.instanceMatrix) {
          const b = biggest * 16;
          const a = m.instanceMatrix.array;
          at = [a[b + 12], a[b + 13], a[b + 14]];
        }
        rows.push({
          name: m.name || '(anon)',
          parent: m.parent?.name || m.parent?.type || '?',
          instances: m.isInstancedMesh ? (m.count ?? 0) : 1,
          maxInstanceScale: Math.round(Math.max(...instScale) * 100) / 100,
          size: size.map((v) => Math.round(v * 10) / 10),
          at: at.map((v) => Math.round(v * 10) / 10),
          visible: m.visible,
        });
      });
      rows.sort((a, b) => Math.max(...(b.size as number[])) - Math.max(...(a.size as number[])));
      return rows.slice(0, 60);
    };
    // Round-flow seams for the console and the harnesses. `force_round_win` / `force_round_lose`
    // take the *real* path — score, notification, sting, and a match win once the score
    // completes — so the round-end flow can be watched without waiting for a flag run;
    // `force_next_round` skips straight to a fresh round.
    // Stress dial: the per-team ceiling on concurrent CPU hulls, live. `set_vehicle_cap(0)`
    // hands the field strength back to the difficulty rules.
    (window as unknown as { set_vehicle_cap: (n: number) => number }).set_vehicle_cap = (n: number) => {
      this.vehicleCap = Math.max(0, Math.round(n));
      this.sim.setVehicleCap(this.vehicleCap);
      return this.sim.vehicleCap();
    };
    (window as unknown as { vehicle_cap: () => number }).vehicle_cap = () => this.sim.vehicleCap();
    (window as unknown as { force_round_win: () => void }).force_round_win = () => this.sim.roundWin();
    (window as unknown as { force_round_lose: () => void }).force_round_lose = () => this.sim.roundLose();
    (window as unknown as { force_next_round: () => void }).force_next_round = () => this.sim.nextRound();
    // The config file, live: read it, change one setting by path (`rfConfigSet('audio.music',
    // 0.2)`, `rfConfigSet('tuning.vehicles.tank.hp', 900)`), or drop the player's stored changes
    // and go back to what the file ships. Anything changed here is stored exactly as a change
    // made in the settings column would be, so it survives a reload.
    // The team-identity look in force, and the catalogue it came from: a harness can check that
    // `runtime.look` reached the model builders rather than only the config object.
    (window as unknown as { rfLook: () => unknown }).rfLook = () => ({
      id: vehicleLook(),
      info: vehicleLookInfo(),
      all: VEHICLE_LOOKS,
    });
    (window as unknown as { rfConfig: () => unknown }).rfConfig = () => ({
      ...config(),
      file: configFromFile(),
      changed: overrides(),
      effective: {
        cpu: this.cpu,
        sandbox: this.sandbox,
        allies: this.allies,
        vehicleCap: this.vehicleCap,
        frameGap: this.frameGap,
        quality: this.quality,
        look: vehicleLook(),
      },
    });
    (window as unknown as { rfConfigSet: (path: string, value: unknown) => unknown }).rfConfigSet = (
      path: string,
      value: unknown,
    ) => {
      this.cfg = patchConfig(
        path.split('.').filter((p) => p.length > 0),
        value,
      );
      this.applyConfig();
      return { path, value, tuning: this.sim.tuningValues() };
    };
    (window as unknown as { rfConfigReset: () => unknown }).rfConfigReset = () => {
      this.cfg = resetOverrides();
      this.applyConfig();
      return { changed: overrides() };
    };
    // F5 toggles the range overlay. Bound here rather than in the input controller because it is
    // a debug view, not a control: it works from the menus too. `preventDefault` is the point -
    // F5 is the browser's reload, and a reload would take the overlay (and the match) with it.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F5' || e.repeat) return;
      e.preventDefault();
      if (!this.ranges) this.ranges = createRangeOverlay(this.gs.scene);
      this.toggleRanges();
    });
    // Range overlay: green = how far each hull can see (`sight`), red = how far it can shoot
    // (its longest weapon). Both come from the spec the simulation itself uses, so the picture
    // cannot disagree with the behaviour. `rfRanges()` toggles, `rfRanges(false)` clears.
    (window as unknown as { rfRanges: (on?: boolean) => boolean }).rfRanges = (on?: boolean) => {
      if (!this.ranges) this.ranges = createRangeOverlay(this.gs.scene);
      return this.toggleRanges(on);
    };
    // What is on screen under a pixel? Raycast from the camera and name the object (and, for
    // an instanced mesh, which instance), so "there is a slab on the ground that should not be
    // there" can be traced to the thing drawing it. Defaults to the centre of the screen; pass
    // viewport pixels to aim at a specific spot.
    (window as unknown as { rfPick: (x?: number, y?: number) => unknown }).rfPick = (x?: number, y?: number) => {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      const px = (x ?? w * 0.5) / w;
      const py = (y ?? h * 0.5) / h;
      const ndc = new THREE.Vector2(px * 2 - 1, -(py * 2 - 1));
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.gs.camera);
      const hits = ray.intersectObjects(this.gs.scene.children, true);
      return hits.slice(0, 6).map((hit) => {
        const o = hit.object as THREE.Object3D & { isInstancedMesh?: boolean; count?: number; instanceId?: number };
        const m = o as unknown as THREE.Mesh;
        const mat = Array.isArray(m.material) ? m.material[0] : (m.material as THREE.Material | undefined);
        return {
          name: o.name || '(anon)',
          parent: o.parent?.name || o.parent?.type || '?',
          grandparent: o.parent?.parent?.name || o.parent?.parent?.type || '?',
          material: mat?.name || mat?.type || '?',
          instanced: !!o.isInstancedMesh,
          instanceId: o.isInstancedMesh ? (hit.instanceId ?? null) : null,
          instances: o.isInstancedMesh ? (o.count ?? 0) : 1,
          distance: Math.round(hit.distance * 10) / 10,
          at: [hit.point.x, hit.point.y, hit.point.z].map((v) => Math.round(v * 10) / 10),
          objectAt: [o.matrixWorld.elements[12], o.matrixWorld.elements[13], o.matrixWorld.elements[14]].map(
            (v) => Math.round(v * 10) / 10,
          ),
        };
      });
    };
    // Scene census: attribute mesh count and triangle count by object name (falling back to
    // class), so a draw-call or triangle budget can be traced to its source without a GPU
    // profiler. Instanced meshes are counted once per instance for triangles.
    (window as unknown as { rfCensus: () => unknown }).rfCensus = () => {
      const byName: Record<string, { meshes: number; tris: number }> = {};
      this.gs.scene.traverse((o) => {
        const m = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
        if (!m.isMesh || !m.geometry) return;
        const g = m.geometry as THREE.BufferGeometry;
        const pos = g.getAttribute('position');
        if (!pos) return;
        let tris = (g.index ? g.index.count : pos.count) / 3;
        // `InstancedMesh.count` is the live instance count — there is no `instanceCount`
        // property, so reading one silently counted every bucket as a single instance.
        if (m.isInstancedMesh) tris *= Math.max(1, m.count ?? 0);
        const key = m.name || m.type;
        const e = (byName[key] ??= { meshes: 0, tris: 0 });
        e.meshes++;
        e.tris += tris;
      });
      return Object.entries(byName)
        .map(([k, v]) => ({ name: k, meshes: v.meshes, tris: Math.round(v.tris) }))
        .sort((a, b) => b.tris - a.tris || b.meshes - a.meshes);
    };
    // Per-phase frame cost since the last reset (see `perfAcc`): the dev hook for finding out
    // where a frame goes. Averages over every processed frame, in ms per phase.
    const perfNames = ['input', 'sim', 'cameras', 'terrain', 'world', 'fx', 'misc', 'draw', 'hud'] as const;
    (window as unknown as { rfProfile: () => unknown }).rfProfile = () => {
      const n = Math.max(1, this.perfFrames);
      const phases: Record<string, number> = {};
      let total = 0;
      for (let i = 0; i < perfNames.length; i++) {
        const ms = this.perfAcc[i] / n;
        phases[perfNames[i]] = Number(ms.toFixed(3));
        total += ms;
      }
      return { frames: this.perfFrames, totalMs: Number(total.toFixed(3)), phases };
    };
    (window as unknown as { rfProfileReset: () => void }).rfProfileReset = () => {
      this.perfAcc.fill(0);
      this.perfFrames = 0;
    };
    document.getElementById('boot')?.classList.add('hidden');
    window.addEventListener('rf:settings', (e) => {
      const detail =
        (
          e as CustomEvent<{
            quality?: Quality;
            master?: number;
            music?: number;
            cpu?: 'easy' | 'medium' | 'hard';
            sandbox?: boolean;
            allies?: boolean;
          }>
        ).detail ?? {};
      // Store the player's choice first: the config file is only a default, and a value the
      // player set in this panel is what should come back after a reload.
      setOverrides({
        quality: detail.quality,
        master: detail.master,
        music: detail.music,
        cpu: detail.cpu,
        sandbox: detail.sandbox,
        allies: detail.allies,
      } as PlayerSettings);
      if (detail.quality) this.setQuality(detail.quality);
      if (typeof detail.master === 'number') this.audio.setMasterVolume(detail.master);
      if (typeof detail.music === 'number') this.audio.setMusicVolume(detail.music);
      // The menu always sends the whole detail, so decide the toast by what actually changed.
      const cpuChanged = detail.cpu !== undefined && detail.cpu !== this.cpu;
      const sandboxChanged = typeof detail.sandbox === 'boolean' && detail.sandbox !== this.sandbox;
      const alliesChanged = typeof detail.allies === 'boolean' && detail.allies !== this.allies;
      if (detail.cpu) this.cpu = detail.cpu;
      if (typeof detail.sandbox === 'boolean') this.sandbox = detail.sandbox;
      if (typeof detail.allies === 'boolean') this.allies = detail.allies;
      // Cheap and idempotent: sets fields and rebuilds the range's force once, not per frame.
      this.applyOptions();
      if (sandboxChanged) {
        this.menus.toast(this.sandbox ? 'practice range: ON' : 'practice range: OFF');
      } else if (alliesChanged) {
        this.menus.toast(this.allies ? 'CPU allies: ON' : 'CPU allies: OFF');
      } else if (cpuChanged) {
        this.menus.toast(`CPU force: ${this.cpu.toUpperCase()}`);
      } else {
        this.menus.toast('settings applied');
      }
    });
    // "Esc closes the garage" comes from menus.ts (the ✕ button dispatches the same event).
    // Cancel semantics: a hull in the field means resume driving it; with nobody deployed yet
    // the match never started, so cancel goes back to the title screen. Either way the panel
    // must not silently reopen on the next frame — see `escapeSwallow`.
    window.addEventListener('rf:garage-close', () => {
      if (this.phase !== 'garage') return;
      this.escapeSwallow = true;
      this.input.keys.delete('Escape');
      if (this.playerVehicle()) {
        // A hull is in the field: cancel means back to driving it. Release the first-pick
        // hold as well, so a two-player start where only one hull deployed still runs.
        this.awaitingFirstPick = false;
        this.phase = 'playing';
        this.garageOpenFor = -1;
      } else {
        this.phase = 'title';
        this.garageOpenFor = -1;
        this.showTitleScreen();
      }
    });
    window.__READY__ = true;
    requestAnimationFrame(this.frame);
  }

  private buildMap(): void {
    // The craters belong to the island being replaced.
    this.fx?.clearDecals();
    this.terrain?.dispose();
    this.world?.dispose();
    this.gs.scene.remove(this.terrain?.group);
    this.gs.scene.remove(this.world?.group);
    const bakeParam = Number(new URLSearchParams(location.search).get('bake') ?? 0);
    this.terrain = createTerrain(
      this.sim.map,
      this.gs,
      this.surfaceLibFor(),
      this.quality,
      bakeParam > 0 ? bakeParam : undefined,
    );
    this.gs.scene.add(this.terrain.group);
    this.world = createWorldView(this.surfaceLibFor(), this.fx);
    this.world.rebuild(this.sim, this.terrain);
    this.gs.scene.add(this.world.group);
  }

  private libRef: ReturnType<typeof createSurfaceLibrary> | null = null;
  private surfaceLibFor(): ReturnType<typeof createSurfaceLibrary> {
    if (!this.libRef) throw new Error('surface library not ready');
    return this.libRef;
  }

  /** Show (or re-show) the title screen with the current map selection. */
  private showTitleScreen(): void {
    this.menus.showTitle({
      mapNames: this.mapNames,
      mapIndex: this.mapIndex,
      mapMode: this.mapMode,
      mapSize: this.mapSize,
      onMapChange: (i: number) => {
        this.mapIndex = i;
      },
      onModeChange: (m: number) => {
        // `start` rebuilds the sim when this differs from the boot world's mode, so the
        // selection takes effect without a reload.
        this.mapMode = m;
      },
      onSizeChange: (s: number) => {
        this.mapSize = s;
      },
      seed: this.seed,
      randomPlay: this.randomPlay,
      onSeedChange: (s: number) => {
        // Takes effect on START: `start` rebuilds the sim when the seed differs from the
        // world it is holding.
        this.seed = s;
      },
      onRandomPlayChange: (on: boolean) => {
        this.randomPlay = on;
      },
      onStart: (two: boolean) => void this.start(two),
    });
    // Title screen rides Dies Irae. Before the first user gesture the audio context does not
    // exist yet, so this parks the theme as pending and `resume()` starts it on the first
    // click or key press; while a vehicle is driving, `updateAudio` owns the theme instead.
    this.audio.playTheme('title');
  }

  private async start(two: boolean): Promise<void> {
    this.twoPlayer = two;
    this.playerIndex = 0;
    // Nobody is in the field yet, so the match clock stays stopped until the garage is done.
    this.awaitingFirstPick = true;
    if (this.randomPlay) {
      // Random play: roll a fresh island and sector for this match. The title screen comes
      // back up with these values later, so what was played is what gets displayed.
      this.seed = 1 + Math.floor(Math.random() * 0xffffffff);
      if (this.mapNames.length > 1) this.mapIndex = Math.floor(Math.random() * this.mapNames.length);
    }
    this.menus.hideTitle();
    if (
      two ||
      this.sim.mapIndex !== this.mapIndex ||
      this.sim.mapMode !== this.mapMode ||
      this.sim.mapSize !== this.mapSize ||
      this.sim.seed !== this.seed
    ) {
      // Two heads, one screen: rebuild the world with both player slots human. A single-player
      // start also rebuilds when the title screen changed the map or the generator mode — the
      // boot sim still holds the old battlefield, so without this every map choice silently
      // fell back to it.
      this.sim = await Sim.load(this.seed, this.mapIndex, two, this.mapMode, this.mapSize);
      this.buildMap();
      if (two) this.rig2 = createCameraRig(new THREE.PerspectiveCamera(46, 16 / 9, 0.6, 1200));
    }
    // Dev log: which island the match actually runs on (the capture harness asserts on it).
    console.log(
      `[game] start: map=${this.sim.map.name} seed=${this.sim.seed} mode=${this.sim.mapMode} size=${this.sim.mapSize} two=${two}`,
    );
    // Always re-apply on start: a two-player start built a fresh world above, and the title
    // screen may have changed the options since boot.
    this.applyOptions();
    this.phase = 'garage';
    this.openGarage(0);
  }

  private openGarage(player: number): void {
    // The garage cards read `teamHud[player].ready*`, which is a decode of the wasm view
    // buffer: on a cold start no `sim.update()` has run yet, so the pooled decoder objects
    // are still empty and every card would come up locked. One `update(0)` decodes the
    // current state without advancing a single tick.
    if (this.awaitingFirstPick) this.sim.update(0, [emptyInput(), emptyInput()]);
    this.garageOpenFor = player;
    this.menus.showGarage(
      {
        specs: this.sim.specs,
        team: this.sim.teamHud[player],
        teamId: this.sim.playerTeam(player),
        playerIndex: player,
        vehicleNameFor: (kind: number) => this.sim.specs.find((s) => s.kind === kind)?.name ?? '—',
      },
      (kind: number) => this.pickVehicle(player, kind),
    );
  }

  private pickVehicle(player: number, kind: number): void {
    this.sim.requestVehicle(player, kind);
    this.vehicleRequested = true;
    this.menus.hideGarage();
    this.garageOpenFor = -1;
    this.phase = 'playing';
    if (this.twoPlayer && player === 0) {
      // Player two picks right after player one.
      this.phase = 'garage';
      this.openGarage(1);
    } else {
      // Last human to deploy: the world may run from here on.
      this.awaitingFirstPick = false;
    }
  }

  /* --------------------------------------------------------------- frame */

  private frame = (now: number): void => {
    if (this.disposed) return;
    // Render-rate cap (see `?fps=`): drop frames that arrive before the deadline. `this.last`
    // is deliberately left alone on a skipped frame, so the next processed frame's `dt` still
    // covers the whole elapsed interval and the simulation keeps real time rather than running
    // in slow motion. The gate uses a deadline instead of "time since the last frame" so the
    // average rate is right on any refresh rate, not just integer multiples of 60.
    if (this.frameGap > 0) {
      if (this.nextFrameAt === 0) this.nextFrameAt = now;
      if (now < this.nextFrameAt) {
        // Keep the loop alive, and keep honouring `?maxframes` so parking still works.
        if (this.maxFrames === 0 || this.frames < this.maxFrames) requestAnimationFrame(this.frame);
        return;
      }
      // Advance the deadline, resyncing if we are already a full interval behind: a
      // backgrounded tab or a frame that overran the gap must not bank credit and then
      // burst through several uncapped frames to spend it.
      this.nextFrameAt += this.frameGap;
      if (this.nextFrameAt <= now) this.nextFrameAt = now + this.frameGap;
    }
    this.frames++;
    // `?maxframes=N` parks the loop so a software rasteriser can be captured reliably.
    if (this.maxFrames === 0 || this.frames < this.maxFrames) requestAnimationFrame(this.frame);
    const dtRaw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(0.1, Math.max(0.0001, dtRaw));
    this.fps = this.fps * 0.9 + (1 / dt) * 0.1;
    this.time += dt;

    // Per-phase cost accounting for `rfProfile()` (see the field comment for the indexes).
    const t0 = performance.now();
    this.handleGlobalKeys();
    const inputs = this.buildInputs(dt);
    this.perfAcc[0] += performance.now() - t0;
    let t1 = performance.now();
    if (this.phase === 'playing' || this.phase === 'garage' || this.phase === 'roundend') {
      if (this.awaitingFirstPick) {
        // The player has not deployed yet: move the world by nothing (`update(0)` runs no
        // fixed steps), but still decode the wasm views every frame so the garage cards and
        // the HUD read live state. `sync()` is private to the bridge, so `update(0)` is the
        // public decode-only path.
        this.sim.update(0, inputs);
      } else {
        this.sim.update(dt, inputs);
      }
      this.consumeEvents();
    }
    // The garage's readiness/rebuild state changes while it is open (a hull being rebuilt
    // ticks up a percent at a time), so re-read it into the existing card nodes every frame.
    if (this.garageOpenFor >= 0) this.menus.updateGarage();
    this.perfAcc[1] += performance.now() - t1;

    const pv = this.playerVehicle();
    // Watch the wreck for a moment before offering the respawn (see `deathWreck`).
    if (!pv && this.deathT <= 0) this.startDeathCam(this.playerIndex);
    t1 = performance.now();
    this.updateCameras(dt, this.cameraTarget(pv, dt));
    this.perfAcc[2] += performance.now() - t1;
    t1 = performance.now();
    this.terrain.update(this.time, this.gs.camera.position);
    this.perfAcc[3] += performance.now() - t1;
    t1 = performance.now();
    this.world.update(dt, this.sim, this.time);
    this.ranges?.update(this.rangeFrame());
    this.perfAcc[4] += performance.now() - t1;
    t1 = performance.now();
    this.fx.update(dt, this.gs.camera);
    this.perfAcc[5] += performance.now() - t1;
    t1 = performance.now();
    this.updateAudio(pv, dt);
    this.updateFlow();
    this.tickUiTimers(dt);
    this.perfAcc[6] += performance.now() - t1;
    t1 = performance.now();
    this.draw();
    this.perfAcc[7] += performance.now() - t1;
    t1 = performance.now();
    this.hud.update(this.hudFrame());
    this.perfAcc[8] += performance.now() - t1;
    this.perfFrames++;
  };

  private handleGlobalKeys(): void {
    if (this.input.down('Escape')) {
      const swallow = this.escapeSwallow;
      this.escapeSwallow = false;
      this.input.keys.delete('Escape');
      // A just-cancelled garage must not be reopened by the same Escape that closed it.
      if (!swallow && this.phase === 'playing') {
        this.phase = 'garage';
        this.openGarage(this.playerIndex);
      }
    } else {
      this.escapeSwallow = false;
    }
    if (this.input.down('KeyM')) {
      this.muted = !this.muted;
      // Unmute restores the master the config is carrying (the settings column and the config
      // file both write it), not a hard-coded 0.9: that constant predates the config and would
      // jump the volume to a value the player never chose.
      this.audio.setMasterVolume(this.muted ? 0 : config().audio.master);
      this.menus.toast(this.muted ? 'audio muted' : 'audio on');
      this.input.keys.delete('KeyM');
    }
    if (this.input.down('Tab')) {
      this.rig.setMode(this.rig.mode === 'fixed' ? 'tilt' : 'fixed');
      this.input.keys.delete('Tab');
    }
    // Picking a vehicle is deliberately NOT handled here any more: the garage panel owns the
    // 1-4 keys (menus.ts `onKey`) and applies its own "is this hull available" guard, so a
    // click and a digit run through exactly the same path. This loop used to pick straight
    // from a duplicated kind table, which bypassed the guard and left the card visuals behind.
  }

  /** The simulation stores the owning player slot (0 = AI, 1/2 = player index+1) in `buildT`. */
  private playerVehicle(): VehicleView | null {
    return this.playerVehicleOf(this.playerIndex);
  }

  private buildInputs(dt: number): [InputFrame, InputFrame] {
    const a = emptyInput();
    const b = emptyInput();
    const v = this.playerVehicle();
    this.lastStrafe = 0;
    const wheel = this.input.consumeWheel();
    if (wheel !== 0) this.rig.zoomBy(wheel * 0.0009);

    if (this.phase !== 'playing' && this.phase !== 'roundend') return [a, b];

    if (this.demo) {
      // Attract/demo mode: the hull is CPU-driven (`setCpuDriven` at boot), so the sim's own
      // AI drives it — real navigation and targeting, no blind autopilot. The old sine-wave
      // pilot fired through its own base and rode the theatre clamp along the map edge.
      return [a, b];
    }

    const heli = v?.kind === VKIND.HELI;
    // Helicopter strafe moved off Q/E to Z/C: Q/E now rotate the camera in *every* vehicle,
    // cockpit included, which is the reported "cannot look around from the helicopter" fix.
    const strafeKey = heli ? this.input.axis(['KeyZ'], ['KeyC']) : 0;
    const camKeys = this.input.axis(['KeyQ'], ['KeyE']);
    if (camKeys !== 0) this.rig.rotateBy(camKeys * dt * 1.6);
    this.lastStrafe = strafeKey;

    // One keyboard, two players: in split screen the left half (WASD, F, Space, Z/C strafe,
    // Q/E camera, ShiftLeft, ControlLeft) is player one's and the right half (arrows, Enter,
    // Slash, ./ , [/] camera, ShiftRight, ControlRight) is player two's. Solo, the arrows stay
    // the documented alias for WASD and player one keeps both Shift/Ctrl keys.
    const p1 = this.twoPlayer
      ? { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'] }
      : {
          up: ['KeyW', 'ArrowUp'],
          down: ['KeyS', 'ArrowDown'],
          left: ['KeyA', 'ArrowLeft'],
          right: ['KeyD', 'ArrowRight'],
        };

    a.throttle = this.input.axis(p1.down, p1.up);
    // Steering sign: rf-core integrates `v.yaw += steer * turn * ...` and the heading is
    // `(sin yaw, cos yaw)`, so a POSITIVE steer yaws the hull from +Z towards +X. The camera
    // holds a fixed north-up heading (camera.ts eases `rig.yaw` back to 0), and a north-up
    // camera puts world +X on the LEFT of the screen - therefore positive steer = turn left,
    // and the left key has to send +1, i.e. it goes in the second (`pos`) list. (The `steer`
    // doc comment in rf-core/src/world.rs, "-1 = left, +1 = right", describes the opposite
    // convention and is wrong for this camera; the AI in ai.rs uses `steer = heading_error`,
    // which is this same convention, and it drives correctly.)
    a.steer = this.input.axis(p1.right, p1.left);
    a.brake = this.input.down('ShiftLeft') || (!this.twoPlayer && this.input.down('ShiftRight'));
    a.ascend = this.twoPlayer
      ? this.input.down('ControlLeft')
      : [...KEY_ASCEND].some((k) => this.input.down(k));
    a.strafe = strafeKey;
    a.fire0 = this.input.mouseDown[0] || this.input.down('KeyF');
    const fire1 = this.input.mouseDown[2] || [...KEY_FIRE_ALT].some((k) => this.input.down(k));
    a.fire1 = fire1;
    a.fire1Edge = fire1 && !this.prevFire1;
    this.prevFire1 = fire1;

    // Mouse aim: the cursor picks what the turret is laid at.
    //
    // For everything on the ground that is the terrain point under the cursor. An aircraft is
    // not on the ground, and the cursor ray through it lands far *behind* it, so the sight line
    // built from that point points down and the shot passes underneath: with a 58 deg camera
    // every cursor ray goes downwards, so there is no way to aim up at an aircraft at all.
    // Measured in the browser before this, a helicopter crossing the crosshair took no hits.
    // So test the cursor ray against enemy aircraft first and, if it goes through one, lay the
    // gun straight at it; `physics.rs::aim_target` then leads the shot and solves the arc.
    if (v && this.input.mouseInside) {
      this.rig.groundPoint(this.input.mouseNdc, (x, z) => this.terrain.heightAt(x, z), this.groundAim);
      const air = this.pickAirTarget(v);
      const tgtX = air ? air.x : this.groundAim.x;
      const tgtZ = air ? air.z : this.groundAim.z;
      const tgtY = air ? air.y : this.groundAim.y;
      const yaw = Math.atan2(tgtX - v.x, tgtZ - v.z);
      a.aim = yaw;
      a.hasAim = true;
      // A pilot has to hit a moving aircraft, not the patch of dirt under it, so the ground
      // path keeps its 6 m floor (which stops a cursor on the hull from producing a wild
      // elevation) while an aircraft is aimed at its true bearing, however close the pass.
      const horiz = Math.max(0.5, Math.hypot(tgtX - v.x, tgtZ - v.z));
      const dist = air ? horiz : Math.max(6, horiz);
      // Aim from the muzzle, not the hull centre: the gun sits above the hull and ignoring
      // that makes flat shots sail over small targets. The target is the crosshair's ground
      // point itself. It used to aim 0.45 m ABOVE it, which is a range error on any shallow
      // shot: the sight line then only reaches the terrain 0.45 m of drop later, ~16 m further
      // out for a 100 m tank shot. The simulation turns this sight line into a launch
      // elevation (physics.rs: `aimed_launch_pitch` for guns, `lobbed_launch` for grenades and
      // MLRS rockets), so what the crosshair sits on is what the round lands on.
      const spec = this.sim.specs.find((sp) => sp.kind === v.kind);
      const muzzleY = v.y + (spec ? spec.height * 0.5 : 1.2) + (spec?.w0.muzzleUp ?? 0);
      a.aimPitch = clamp(Math.atan2(tgtY - muzzleY, dist), -0.4, 1.05);
      this.lastAimPitch = a.aimPitch;
    }
    if (this.twoPlayer) this.buildPlayerTwoInput(b, dt);
    return [a, b];
  }

  /**
   * Player two's split-screen controls. Before this existed `buildInputs` handed the
   * simulation a zeroed input frame for slot two, so in `?two=1` the second vehicle was
   * simply undrivable. The keys sit on the right of the keyboard, mirroring player one, and
   * they follow the same steering sign as player one: key-left sends +1, and +1 yaws the
   * hull to the left on screen (see the convention note in `buildInputs`). Player two's
   * viewport is a second rig with the same fixed north-up heading, so the sign is identical.
   */
  private buildPlayerTwoInput(b: InputFrame, dt: number): void {
    const v2 = this.playerVehicleOf(1);
    const heli = v2?.kind === VKIND.HELI;
    // `,`/`.` stay player two's helicopter strafe (the mirror of player one's Z/C).
    const strafe = this.input.axis(['Period'], ['Comma']);
    // Player two needs a camera-rotate pair of its own now that Q/E belong to player one:
    // `[`/`]`. The sign mapping matches player one's (first key = -1, second = +1), so both
    // players rotate their own view the same direction with the same handedness.
    const camKeys = this.input.axis(['BracketLeft'], ['BracketRight']);
    if (camKeys !== 0 && this.rig2) this.rig2.rotateBy(camKeys * dt * 1.6);
    b.throttle = this.input.axis(['ArrowDown'], ['ArrowUp']);
    b.steer = this.input.axis(['ArrowRight'], ['ArrowLeft']);
    b.brake = this.input.down('ShiftRight');
    b.ascend = this.input.down('ControlRight');
    // Unlike the old code, player two's strafe is no longer overloaded onto the camera keys:
    // a helicopter strafes with `,`/`.`, and the camera is always `[`/`]` (above).
    if (heli) b.strafe = strafe;
    b.fire0 = this.input.down('Enter');
    const fire1 = this.input.down('Slash');
    b.fire1 = fire1;
    b.fire1Edge = fire1 && !this.prevFire1P2;
    this.prevFire1P2 = fire1;
  }

  /**
   * The enemy aircraft the cursor is pointing at, if any, as a world point at its centre.
   *
   * The cursor ray is tested against each live enemy aircraft as a vertical cylinder (a couple
   * of metres of airframe, so the cursor does not have to be pixel-perfect) and the nearest win.
   * Aiming at aircraft is otherwise impossible: this camera looks down at 58 deg, so every
   * cursor ray goes downwards and a sight line built from the terrain point under an aircraft
   * points at the ground behind it (see the note in `buildInputs`).
   *
   * The aircraft only wins if the ray reaches it BEFORE the terrain point the cursor is on, so
   * a cursor on a hill still aims at the hill and not at an aircraft behind it, and a cursor on
   * an aircraft in the open aims at the aircraft. There is deliberately no weapon-range gate
   * here: the gun lays on what the player points at and the round's own reach decides whether it
   * gets there (the alternative — silently ignoring an aircraft because it is 20 m past the
   * grenade's 62 m — is exactly the "I cannot aim at aircraft" complaint).
   */
  private pickAirTarget(self: VehicleView): THREE.Vector3 | null {
    // A lobbed weapon cannot intercept an aircraft: rf-core solves no air intercept for one (its
    // arc is solved at launch from the sight line, and leading its traverse would swing the
    // turret far off that line). Picking an aircraft for the jeep would hijack the crosshair, and
    // with it the player's ground aim, for a shot that cannot connect, so those vehicles keep
    // aiming at the terrain.
    const mySpec = this.sim.specs.find((sp) => sp.kind === self.kind);
    this.airPickId = -1;
    if (mySpec?.w0.lobbed) return null;
    // The rig is updated later in the frame than the inputs, so the camera's world matrix is
    // recomposed here from last frame's transform: one frame of lag on the pick, which is
    // imperceptible, and it guarantees the matrix is valid on the very first frame.
    this.rig.camera.updateMatrixWorld();
    this.aimRay.setFromCamera(this.input.mouseNdc, this.rig.camera);
    const o = this.aimRay.ray.origin;
    const d = this.aimRay.ray.direction;
    // An aircraft only wins if the cursor ray reaches it before the terrain point under the
    // cursor does (see the method comment), so start the search from that distance.
    let bestT = this.groundAim.distanceTo(this.rig.camera.position);
    let found = false;
    for (let i = 0; i < this.sim.vehicleCount; i++) {
      const t = this.sim.vehicles[i];
      if (t.id === self.id || t.team === self.team || t.hp <= 0) continue;
      // AIRBORNE is the simulation's own answer to "is this in the air": set for a helicopter
      // under way and for the recon drones the AI sends after a player who camps. Do NOT test
      // the spec's `flying` flag instead - `specs_json` only covers the four garage hulls, so a
      // drone has no spec at all and was silently never picked, which is precisely the case this
      // aiming fix exists for (drones are what strafe a static player).
      if ((t.flags & VFLAG.AIRBORNE) === 0) continue;
      const spec = this.sim.specs.find((sp) => sp.kind === t.kind);
      // A deliberately generous volume: 2 m of aircraft either side of its centre and a 3 m
      // radius, so a 22 m/s drone 170 m out can be held under a mouse cursor at all. Fitted
      // tightly to the drone's 1 m hull the cursor had to stay inside 0.6 m, which no player can
      // hold: measured, a drone dead centre under the cursor missed by 0.3 m of altitude.
      const h = Math.max(spec?.height ?? 1.2, 2.0);
      const cy = t.y + h * 0.5;
      // Vertical cylinder. The height band has to be tested at the ray's CLOSEST APPROACH to the
      // axis, not where the ray crosses the cylinder's side: this camera looks down at 58 deg,
      // so a side crossing is metres of altitude above the axis for a 3 m radius, and every
      // aircraft was rejected by the height test (a drone dead centre under the cursor came back
      // with no pick at all). Clamping the closest approach into the circle's entry and exit
      // parameters is the exact "does this ray pass through the cylinder" test.
      const r = Math.max(3.0, (spec?.width ?? 3.2) * 0.8);
      const dx = o.x - t.x;
      const dz = o.z - t.z;
      const a = d.x * d.x + d.z * d.z;
      let tNear: number;
      if (a < 1e-6) {
        // Cursor ray straight down: only a ray already over the aircraft can reach it.
        if (dx * dx + dz * dz > r * r) continue;
        tNear = 0;
      } else {
        const b = 2 * (dx * d.x + dz * d.z);
        const c = dx * dx + dz * dz - r * r;
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        const t0 = (-b - sq) / (2 * a);
        const t1 = (-b + sq) / (2 * a);
        if (t1 < 0 || t0 > bestT) continue;
        tNear = clamp(-(dx * d.x + dz * d.z) / a, Math.max(t0, 0), t1);
      }
      if (tNear >= bestT) continue;
      const y = o.y + d.y * tNear;
      if (y < cy - h || y > cy + h) continue;
      bestT = tNear;
      found = true;
      this.airPickId = t.id;
      this.airAim.set(t.x, cy, t.z);
    }
    return found ? this.airAim : null;
  }

  /**
   * The hull the camera should be looking at: the live one, or - for `DEATH_CAM` seconds after it
   * dies - the wreck it left behind.
   */
  private cameraTarget(pv: VehicleView | null, dt: number): VehicleView | null {
    if (pv) {
      this.deathWreck = -1;
      this.deathT = 0;
      return pv;
    }
    if (this.deathT > 0) {
      this.deathT = Math.max(0, this.deathT - dt);
      const wreck = this.vehicleById(this.deathWreck);
      if (wreck) return wreck;
      // Culled mid-watch: nothing left to follow.
      this.deathT = 0;
      this.deathWreck = -1;
      return null;
    }
    return null;
  }

  /** Find the wreck the player's slot just left, and start the death cam on it. */
  private startDeathCam(slotIndex: number): void {
    const slot = slotIndex + 1;
    // The *newest* wreck for this slot, not the first one in the list. A dead slot is re-fielded
    // well before its last wreck stops burning (`WRECK_TIME` 14 s against a rebuild of 60 % of
    // the hull's build time, 7.2 s for a helicopter, and the demo re-fields the moment this cam
    // expires), so two wrecks of the same slot routinely coexist. Vehicles are appended in spawn
    // order and never reordered, so the stale wreck comes first: picking the head of the list
    // was the reported "the camera watches the old wreck" after a hull died twice in quick
    // succession. Ids are handed out by the core in spawn order and never reused, so the highest
    // one is the hull the player just lost.
    let newest = -1;
    for (let i = 0; i < this.sim.vehicleCount; i++) {
      const v = this.sim.vehicles[i];
      if (v.state === VSTATE.WRECK && Math.round(v.buildT) === slot && v.id > newest) {
        newest = v.id;
      }
    }
    if (newest < 0) return;
    // Never re-arm on the wreck we have just finished watching. The respawn waits for this
    // timer, so a wreck that outlives it (they burn for a while) would restart the three
    // seconds every frame and keep the player dead until the corpse was culled.
    if (newest === this.deathWreck) return;
    this.deathWreck = newest;
    this.deathT = Game.DEATH_CAM;
  }

  private vehicleById(id: number): VehicleView | null {
    if (id < 0) return null;
    for (let i = 0; i < this.sim.vehicleCount; i++) {
      const v = this.sim.vehicles[i];
      if (v.id === id && v.state === VSTATE.WRECK) return v;
    }
    return null;
  }

  private updateCameras(dt: number, pv: VehicleView | null): void {
    const team = this.sim.playerTeam(this.playerIndex);
    const target = this.focus;
    if (this.freeLook) {
      // Harness only: hold the framing over a fixed world point, with no vehicle to follow.
      const y = this.terrain?.heightAt(this.freeLook.x, this.freeLook.z) ?? 0;
      target.set(this.freeLook.x, (Number.isFinite(y) ? y : 0) + 2.0, this.freeLook.z);
      this.rig.update(dt, target, 0, 0, 1);
    } else if (pv) {
      const y = Number.isFinite(pv.y) ? pv.y : (this.terrain?.heightAt(pv.x, pv.z) ?? 0);
      target.set(pv.x, (Number.isFinite(y) ? y : 0) + 2.0, pv.z);
      this.rig.update(dt, target, pv.yaw, pv.speed, this.camScaleFor(pv.kind));
    } else {
      const base = this.basePosition(team);
      target.set(base.x, base.y, base.z);
      this.rig.update(dt, target, 0.7, 0, 1.15);
    }
    if (this.rig2 && this.twoPlayer) {
      const v2 = this.playerVehicleOf(1);
      if (v2) {
        target.set(v2.x, v2.y + 2.0, v2.z);
        this.rig2.update(dt, target, v2.yaw, v2.speed, this.camScaleFor(v2.kind));
      }
    }
    // Split screen halves the viewport, so each camera needs a half-width aspect ratio.
    const w = this.canvas.clientWidth;
    const h = Math.max(1, this.canvas.clientHeight);
    const aspect = this.twoPlayer ? w / 2 / h : w / h;
    if (this.gs.camera.aspect !== aspect) {
      this.gs.camera.aspect = aspect;
      this.gs.camera.updateProjectionMatrix();
      if (this.rig2) {
        this.rig2.camera.aspect = aspect;
        this.rig2.camera.updateProjectionMatrix();
      }
    }
  }

  private camScaleFor(kind: number): number {
    return kind === VKIND.JEEP ? 0.84 : kind === VKIND.TANK ? 1.02 : kind === VKIND.HRSV ? 1.1 : 1.16;
  }

  private basePosition(team: number): THREE.Vector3 {
    // Before the first sync the flag views can still be blank, and a single NaN here used to
    // poison the camera rig for the whole match (the lerp cannot recover), which showed up as
    // a black screen in a normal game. Fall back to the map centre and the terrain height.
    const f = this.sim.flags[team];
    const out = new THREE.Vector3(f.x, 0, f.z);
    if (!Number.isFinite(out.x) || !Number.isFinite(out.z)) {
      const half = this.sim.map.worldSize * 0.5;
      out.set(half, 0, half);
    }
    const ground = Number.isFinite(f.y) ? f.y : (this.terrain?.heightAt(out.x, out.z) ?? 0);
    out.y = (Number.isFinite(ground) ? ground : 0) + 3;
    return out;
  }

  private playerVehicleOf(index: number): VehicleView | null {
    const slot = index + 1;
    for (let i = 0; i < this.sim.vehicleCount; i++) {
      const v = this.sim.vehicles[i];
      if (v.state === 1 && Math.round(v.buildT) === slot) return v;
    }
    return null;
  }

  private consumeEvents(): void {
    for (let i = 0; i < this.sim.eventCount; i++) {
      const e = this.sim.events[i];
      const kind = e.kind | 0;
      if (kind === EKIND.SOUND) {
        const name = SFX_NAME[e.a | 0];
        if (name) this.audio.play(name as SfxName, { x: e.x, y: e.y, z: e.z }, { gain: e.b });
      } else if (kind === EKIND.NOTIFY) {
        this.pushNotification(e.a | 0, e.b | 0);
      } else if (kind === EKIND.SKULL) {
        this.banner = { title: 'K.I.A.', sub: 'the skull is laughing at you', age: 0, life: 2.2 };
      } else {
        this.fx.spawn(e);
        if ((kind === EKIND.BIG_EXPLOSION || kind === EKIND.EXPLOSION) && this.gs.camera) {
          const d = Math.hypot(e.x - this.gs.camera.position.x, e.z - this.gs.camera.position.z);
          if (d < 90) this.rig.shake(clamp(1.6 * e.a * (1 - d / 90) * 0.35, 0, 0.9));
        }
      }
    }
  }

  private pushNotification(id: number, team: number): void {
    const pt = this.sim.playerTeam(this.playerIndex);
    const mine = team === pt;
    const mk = (text: string, sub: string, kind: Notification['kind']): void => {
      this.notifications.push({ text, sub, team: mine ? 0 : 1, age: 0, life: 5.5, kind });
      if (this.notifications.length > 6) this.notifications.shift();
    };
    switch (id) {
      case NOTIFY.FLAG_TAKEN:
        if (mine) this.setBanner('ENEMY FLAG TAKEN', 'get it home — your flag must be up');
        mk(mine ? 'ENEMY FLAG TAKEN' : 'YOUR FLAG TAKEN', mine ? 'return it to your base' : 'intercept the jeep', 'flag');
        break;
      case NOTIFY.FLAG_DROPPED:
        mk('FLAG DROPPED', 'it will return home shortly', 'flag');
        break;
      case NOTIFY.FLAG_CAPTURED:
        this.setBanner(mine ? 'FLAG CAPTURED' : 'FLAG LOST', mine ? 'round won' : 'round lost');
        mk(mine ? 'FLAG CAPTURED' : 'FLAG LOST', '', 'flag');
        break;
      case NOTIFY.FLAG_RETURNED:
        mk('FLAG RETURNED', 'back on its stand', 'info');
        break;
      case NOTIFY.VEHICLE_LOST:
        mk('VEHICLE DESTROYED', 'pick a new ride', 'warn');
        break;
      case NOTIFY.OUT_OF_BOUNDS:
        this.setBanner('LEAVING THE OPERATION AREA', 'submarine inbound');
        mk('OUT OF BOUNDS', 'return to the map', 'warn');
        break;
      case NOTIFY.DRONES_IN:
        this.setBanner('ENEMY DRONES INBOUND', 'they have spotted your position');
        mk('DRONES INBOUND', 'break camp and move', 'warn');
        break;
      case NOTIFY.LOW_FUEL:
        mk('FUEL CRITICAL', 'find a fuel depot', 'warn');
        break;
      case NOTIFY.NO_AMMO:
        mk('OUT OF AMMUNITION', 'resupply at the ammo tent', 'warn');
        break;
      case NOTIFY.TOWER_DOWN:
        mk('TURRET DESTROYED', '', 'info');
        break;
      case NOTIFY.BRIDGE_DOWN:
        mk('BRIDGE DOWN', 'crossing destroyed', 'info');
        break;
      case NOTIFY.ROUND_WON:
        this.setBanner('ROUND WON', 'regroup at base');
        break;
      case NOTIFY.ROUND_LOST:
        this.setBanner('ROUND LOST', 'they got your flag');
        break;
      default:
        break;
    }
  }

  private setBanner(title: string, sub: string): void {
    this.banner = { title, sub, age: 0, life: 3.4 };
  }

  private updateAudio(pv: VehicleView | null, dt: number): void {
    if (!pv) {
      this.audio.setEngine('none', 0, 0);
      // Let the track ride through a death: only retire it once there has been no hull for a
      // while, so respawning into the same vehicle does not restart the music (see `themeIdleT`).
      this.themeIdleT += dt;
      if (this.currentTheme !== null && this.themeIdleT > THEME_IDLE_HOLD) {
        this.audio.playTheme(null);
        this.currentTheme = null;
      }
      return;
    }
    this.themeIdleT = 0;
    const load = clamp(Math.abs(pv.speed) / 30 + (pv.hp < pv.hpMax * 0.5 ? 0.15 : 0), 0, 1);
    const kind = pv.kind;
    this.audio.setEngine(
      kind === VKIND.JEEP
        ? 'jeep'
        : kind === VKIND.TANK
          ? 'tank'
          : kind === VKIND.HRSV
            ? 'hrsv'
            : kind === VKIND.HELI
              ? 'heli'
              : 'none',
      load,
      clamp(Math.abs(pv.speed) / 20, 0, 1),
    );
    this.audio.setLoop(kind === VKIND.HELI ? 'rotor' : kind === VKIND.TANK || kind === VKIND.HRSV ? 'tracks' : null, load);
    const carrying = (pv.flags & 1) !== 0;
    const theme = carrying
      ? 'flag'
      : kind === VKIND.JEEP
        ? 'jeep'
        : kind === VKIND.TANK
          ? 'tank'
          : kind === VKIND.HRSV
            ? 'hrsv'
            : kind === VKIND.HELI
              ? 'heli'
              : null;
    if (theme !== this.currentTheme) {
      // Dev log: the player reports the music restarting "all the time, in the very same
      // vehicle", which the theme selection alone does not explain. Record what changed.
      this.themeLog.push(
        `${this.time.toFixed(1)}s ${this.currentTheme}->${theme} kind=${pv.kind} flags=${pv.flags} phase=${this.phase}`,
      );
      if (this.themeLog.length > 32) this.themeLog.shift();
      this.themeStarts++;
      this.audio.playTheme(theme as never);
      this.currentTheme = theme;
    }
  }

  private updateFlow(): void {
    const st = this.sim.matchState;
    if (st !== MATCHSTATE.PLAYING && this.phase === 'playing') {
      this.vehicleRequested = false;
      this.phase = 'roundend';
      // The round is decided: the ground from it goes with it. This is also the headless
      // harness's path, so a captured frame never shows the last round's craters.
      this.fx.clearDecals();
      this.menus.showRoundEnd({
        winner: this.sim.roundWinner,
        score: [this.sim.score(0), this.sim.score(1)],
        matchOver: st === MATCHSTATE.MATCH_OVER,
        youWon: this.sim.roundWinner === this.sim.playerTeam(this.playerIndex),
        onContinue: () => {
          this.menus.hideRoundEnd();
          this.phase = 'garage';
          this.openGarage(this.playerIndex);
        },
      });
      this.audio.sting(this.sim.roundWinner === this.sim.playerTeam(this.playerIndex) ? 'victory' : 'defeat');
    }
    if (st === MATCHSTATE.PLAYING && this.phase === 'roundend') {
      this.menus.hideRoundEnd();
      this.phase = 'playing';
    }
    // Attract mode has no one to click the garage: re-field each CPU-driven slot's hull as
    // soon as it is gone (mid-round death or a round restart) so the demo driver keeps
    // fighting for the whole session. The request resolves once the garage has a parked
    // hull, which is immediate on a fresh round and one build-time after a death.
    // Re-request every frame while the slot is empty rather than once per death: `new_round`
    // clears the core's pending requests, and a whole round end can happen between two frames
    // of this pass (the headless harness advances sim in chunks that never run it) — a
    // one-shot "already queued" flag then stayed set forever and starved the slot until the
    // next observed round transition. Re-requesting is idempotent: the core only spawns when
    // parked stock exists, and there is no live hull to retire (that is the guard above).
    if (this.demo && this.phase === 'playing' && this.deathT <= 0) {
      const slots = this.twoPlayer ? 2 : 1;
      for (let p = 0; p < slots; p++) {
        if (!this.playerVehicleOf(p)) {
          this.sim.requestVehicle(p, this.demoVehicleKind[p]);
        }
      }
    }
    // Auto-open the garage the moment the player has no ride - but not until the death cam has
    // had its three seconds: a panel over the wreck in the same frame skips the one moment the
    // fight is still interesting.
    const hasRide = this.playerVehicle() !== null;
    if (hasRide) {
      this.vehicleRequested = false;
    } else if (this.deathT > 0) {
      // Watching the wreck. Nothing to do until it is over.
    } else if (!this.demo && this.phase === 'playing' && !this.vehicleRequested) {
      // No ride and nothing on order: open the garage. A pending request resolves on the
      // first tick of the new round, so we must not reopen the panel while waiting for it.
      this.phase = 'garage';
      this.openGarage(this.playerIndex);
    }
  }

  private draw(): void {
    if (this.twoPlayer && this.rig2) {
      // Split screen: two viewports, no post-processing (the composer renders full-frame).
      const r = this.gs.renderer;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      r.setScissorTest(true);
      r.setViewport(0, h / 2, w, h / 2);
      r.setScissor(0, h / 2, w, h / 2);
      r.render(this.gs.scene, this.gs.camera);
      r.setViewport(0, 0, w, h / 2);
      r.setScissor(0, 0, w, h / 2);
      r.render(this.gs.scene, this.rig2.camera);
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
    } else {
      this.gs.render();
    }
  }

  private hudFrame(): HudFrame {
    const h = this.sim.hud[this.playerIndex];
    const t = this.sim.teamHud[this.playerIndex];
    this.refreshStructures();
    return {
      playerIndex: this.playerIndex,
      hud: h,
      team: t,
      vehicles: this.sim.vehicles,
      vehicleCount: this.sim.vehicleCount,
      flags: this.sim.flags,
      turrets: this.sim.turrets,
      turretCount: this.sim.turretCount,
      mines: this.sim.mines,
      mineCount: this.sim.mineCount,
      map: {
        nav: this.sim.map.nav,
        heights: this.sim.map.heights,
        grid: this.sim.map.grid,
        cell: this.sim.map.cell,
        worldSize: this.sim.map.worldSize,
        waterLevel: this.sim.map.waterLevel,
      },
      structures: this.structSnapshot,
      structureCount: this.structSnapshot.length,
      matchState: this.sim.matchState,
      roundWinner: this.sim.roundWinner,
      roundTimeLeft: this.sim.roundTimeLeft,
      score: [this.sim.score(0), this.sim.score(1)],
      roundsToWin: 3,
      time: this.time,
      fps: this.fps,
      camera: { x: this.gs.camera.position.x, z: this.gs.camera.position.z, yaw: this.rig.yaw, zoom: this.rig.zoom },
      notifications: this.notifications,
      banner: this.banner,
      twoPlayer: this.twoPlayer,
      showDebug: this.showDebug,
    };
  }

  private tickUiTimers(dt: number): void {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      this.notifications[i].age += dt;
      if (this.notifications[i].age > this.notifications[i].life) this.notifications.splice(i, 1);
    }
    if (this.banner) {
      this.banner.age += dt;
      if (this.banner.age > this.banner.life) this.banner = null;
    }
  }

  /** Diagnostics for the screenshot harness: find NaN geometry and report scene stats. */
  /** Alive heavy-class hulls (jeep/tank/HRSV/heli) on a team — troops, drones and wrecks don't count. */
  private teamHullCount(team: number): number {
    const heavy: number[] = [VKIND.JEEP, VKIND.TANK, VKIND.HRSV, VKIND.HELI];
    let n = 0;
    for (let i = 0; i < this.sim.vehicleCount; i++) {
      const v = this.sim.vehicles[i];
      if (v.hp > 0 && v.team === team && heavy.includes(v.kind)) n++;
    }
    return n;
  }

  private probe(): unknown {
    const bad: string[] = [];
    let meshes = 0;
    let tris = 0;
    this.gs.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      meshes++;
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position');
      if (pos) {
        tris += (g.index ? g.index.count : pos.count) / 3;
        for (let i = 0; i < pos.count * 3; i++) {
          if (!Number.isFinite(pos.array[i] as number)) {
            bad.push(`${m.name || m.type} @ ${o.parent?.name ?? '?'} (${g.type})`);
            break;
          }
        }
      }
    });
    const info = this.gs.renderer.info;
    // Live aircraft and where they are on screen: the harness drives the real mouse onto an
    // aircraft with this, which is how "the player can actually shoot at aircraft" is checked
    // end to end (see `pickAirTarget`). `airPick` is the aircraft the aim is currently on, or
    // -1 for a ground aim.
    const airTargets: unknown[] = [];
    for (let i = 0; i < this.sim.vehicleCount; i++) {
      const t = this.sim.vehicles[i];
      const spec = this.sim.specs.find((sp) => sp.kind === t.kind);
      if ((t.flags & VFLAG.AIRBORNE) === 0 || t.hp <= 0) continue;
      const p = new THREE.Vector3(t.x, t.y + (spec?.height ?? 1.2) * 0.5, t.z).project(this.rig.camera);
      airTargets.push({
        id: t.id,
        team: t.team,
        hp: Math.round(t.hp),
        y: Number(t.y.toFixed(2)),
        ndc: [Number(p.x.toFixed(3)), Number(p.y.toFixed(3))],
      });
    }
    return {
      phase: this.phase,
      mapName: this.sim.map.name,
      vehicles: this.sim.vehicleCount,
      structures: this.sim.structureCount,
      turrets: this.sim.turretCount,
      meshes,
      triangles: Math.round(tris),
      drawCalls: info.render.calls,
      programs: info.programs?.length ?? 0,
      badGeometry: bad.slice(0, 12),
      camera: this.gs.camera.position.toArray().map((v) => Math.round(v)),
      heightsLen: this.sim.map.heights.length,
      heightsNaN: (() => {
        let n = 0;
        for (let i = 0; i < this.sim.map.heights.length; i++) {
          if (!Number.isFinite(this.sim.map.heights[i])) n++;
        }
        return n;
      })(),
      heightsSample: Array.from(this.sim.map.heights.slice(0, 4)).map((v) => Math.round(v * 100) / 100),
      fps: Math.round(this.fps),
      // Render-rate cap in effect (0 = uncapped) and how many frames were actually processed,
      // so a harness can prove `?fps=` gates the loop instead of just being parsed.
      frameGapMs: Math.round(this.frameGap),
      frames: this.frames,
      mapMode: this.sim.mapMode,
      mapSize: this.sim.mapSize,
      hudStatus: this.sim.hud[0].status,
      vehicleKind: this.sim.hud[0].vehicleKind,
      airTargets,
      playerTeam: this.sim.playerTeam(this.playerIndex),
      airPick: this.airPickId,
      aimPitch: Number(this.lastAimPitch.toFixed(3)),
      decals: this.fx.stats().decals,
      // Player-facing options and input, read on demand only (no per-frame work): a harness
      // uses these to falsify the option wiring and the helicopter key change.
      strafe: this.lastStrafe,
      camMode: this.rig.mode,
      camYaw: Number(this.rig.yaw.toFixed(4)),
      camElevation: Number(this.rig.elevation.toFixed(4)),
      cpu: this.cpu,
      sandbox: this.sandbox,
      allies: this.allies,
      // Alive heavy-class hulls per team (the kinds a commander fields): on the title screen,
      // before the player deploys, team 0's count is exactly the CPU-allies garrison, so a
      // harness can prove `?allies=1` fields real vehicles and not just the option flag.
      teamHulls: [this.teamHullCount(0), this.teamHullCount(1)],
      // The music resting on the last theme it started: a harness can prove the track survives
      // a death instead of being stopped and restarted from the top.
      theme: this.currentTheme,
      themeIdle: Number(this.themeIdleT.toFixed(2)),
      themeStarts: this.themeStarts,
      // The audio engine's own count of tracks started. The game-side count above proves the
      // *selection* is stable; this one proves nothing inside the engine restarts it.
      musicStarts: this.audio.musicStarts ?? -1,
      // Which recording is actually sounding (null = synthesised fallback or silence), and
      // its element state — a harness uses these to prove the MP3 layer leads when present.
      mp3: this.audio.mp3Active ?? null,
      mp3State: this.audio.mp3State ?? null,
      themeLog: this.themeLog.slice(-10),
    };
  }

  private refreshStructures(): void {
    this.structTimer -= 1;
    const n = this.sim.structureCount;
    if (this.structTimer > 0 && this.structSnapshot.length === n) return;
    this.structTimer = 30;
    while (this.structPool.length < n) this.structPool.push({} as StructureView);
    this.structSnapshot.length = 0;
    for (let i = 0; i < n; i++) this.structSnapshot.push(this.sim.structure(i, this.structPool[i]));
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.gs.setQuality(q);
    this.fx.setQuality(q);
    // The stylesheet keys off `<html>` (it drops the expensive glass on "low"), so the class has
    // to follow whichever path set the quality - the config file, the settings column, or a URL
    // override - and not just the config's own value.
    applyQualityClass(q);
  }

  onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gs.setSize(w, h);
    if (this.rig2) {
      this.rig2.camera.aspect = w / 2 / h;
      this.rig2.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.world?.dispose();
    this.terrain?.dispose();
    this.gs.dispose();
    this.menus.dispose();
    this.hud.dispose();
    this.audio.dispose();
  }
}

/* ------------------------------------------------------------------- boot */

declare global {
  interface Window {
    __READY__?: boolean;
    rfGame?: unknown;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  // The config file has to be read before the game is built: the renderer is created at the
  // configured quality, and rebuilding it later would cost the whole surface library.
  const cfg = await loadConfig();
  const game = new Game(canvas, cfg);
  window.rfGame = game;
  window.addEventListener('resize', () => game.onResize());
  game.onResize();
  await game.boot();
}

void main().catch((err) => {
  console.error(err);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = `<div class="boot-inner"><h1>FAULT</h1><pre>${String(err)}</pre></div>`;
  }
});

export { Game };
