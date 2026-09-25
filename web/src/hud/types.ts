/**
 * Contract between the game loop and the DOM UI (HUD, minimap, menus).
 * Implemented by `hud.ts` (in-game overlay) and `menus.ts` (title / garage / round end).
 */
import type {
  FlagView,
  MineView,
  PlayerHudView,
  StructureView,
  TeamHudView,
  TurretView,
  VehicleSpecView,
  VehicleView,
} from '../sim/layout.js';

export interface Notification {
  text: string;
  sub: string;
  /** 0 = your team, 1 = enemy, -1 = neutral. */
  team: number;
  /** Seconds since it was raised (advance this yourself in the UI). */
  age: number;
  life: number;
  kind: 'flag' | 'kill' | 'warn' | 'info';
}

export interface HudFrame {
  playerIndex: number;
  hud: PlayerHudView;
  team: TeamHudView;
  vehicles: VehicleView[];
  vehicleCount: number;
  flags: FlagView[];
  turrets: TurretView[];
  turretCount: number;
  mines: MineView[];
  mineCount: number;
  map: {
    nav: Uint8Array;
    heights: Float32Array;
    grid: number;
    cell: number;
    worldSize: number;
    waterLevel: number;
  };
  structures: StructureView[];
  structureCount: number;
  matchState: number;
  roundWinner: number;
  roundTimeLeft: number;
  score: [number, number];
  roundsToWin: number;
  time: number;
  fps: number;
  /** Camera focus in world space, for the minimap. */
  camera: { x: number; z: number; yaw: number; zoom: number };
  notifications: Notification[];
  /** Big centred message (round start, "FLAG TAKEN", ...). */
  banner: { title: string; sub: string; age: number; life: number } | null;
  twoPlayer: boolean;
  showDebug: boolean;
}

export interface Hud {
  update(f: HudFrame): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface GarageState {
  specs: VehicleSpecView[];
  team: TeamHudView;
  teamId: number;
  /** Player slot being served (0 or 1). */
  playerIndex: number;
  vehicleNameFor: (kind: number) => string;
}

export interface Menus {
  showTitle(opts: {
    mapNames: string[];
    mapIndex: number;
    /** Generator mode: 0 = classic (procedural), 1 = mirror. */
    mapMode: number;
    /** Battlefield size: 0 = small, 1 = medium, 2 = big. */
    mapSize: number;
    /** The seed the current world was built from (shown in the SEED field). */
    seed: number;
    /** Random play: roll a new seed and sector on START. */
    randomPlay: boolean;
    onMapChange: (index: number) => void;
    onModeChange: (mode: number) => void;
    onSizeChange: (size: number) => void;
    onSeedChange: (seed: number) => void;
    onRandomPlayChange: (on: boolean) => void;
    onStart: (twoPlayer: boolean) => void;
    onSettings?: () => void;
  }): void;
  hideTitle(): void;
  showGarage(state: GarageState, onPick: (kind: number) => void): void;
  hideGarage(): void;
  showRoundEnd(state: {
    winner: number;
    score: [number, number];
    matchOver: boolean;
    youWon: boolean;
    onContinue: () => void;
  }): void;
  hideRoundEnd(): void;
  /**
   * Start the settings column from the values actually in force (config file, then any URL
   * override). Called once at boot; does not dispatch `rf:settings`, so it cannot loop back into
   * the game as a player change.
   */
  applyInitial(settings: {
    quality: 'low' | 'medium' | 'high';
    master: number;
    music: number;
    cpu: 'easy' | 'medium' | 'hard';
    sandbox: boolean;
    allies: boolean;
  }): void;
  /** Full-screen load/boot progress. */
  showLoading(progress: number, label: string): void;
  hideLoading(): void;
  /** Corner toast used for "settings applied" style messages. */
  toast(text: string): void;
  dispose(): void;
}

export function createHud(_container: HTMLElement): Hud {
  throw new Error('not implemented');
}

export function createMenus(_container: HTMLElement): Menus {
  throw new Error('not implemented');
}
