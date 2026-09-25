/**
 * Frozen asset-layer contract shared by the procedural texture library, the procedural
 * model builders and the renderer. Keep implementations on their side of this fence.
 */
import type * as THREE from 'three';

/* ------------------------------------------------------------------ textures */

export type MatKey =
  // terrain surfaces (tileable, used by the splat-blended ground shader)
  | 'sand'
  | 'sandWet'
  | 'dirt'
  | 'rock'
  | 'grass'
  | 'asphalt'
  | 'concrete'
  | 'concreteWorn'
  // paintable ground variants: two more stops on the sand and grass ramps, and the two pavement
  // shapes (single square slabs, and a line-up of long slabs for roads and aprons)
  | 'sandGrit'
  | 'sandCoral'
  | 'grassLush'
  | 'grassDry'
  | 'paveTiles'
  | 'paveStrip'
  // structures
  | 'metalPanel'
  | 'metalPainted'
  | 'metalDark'
  | 'rust'
  | 'canvasTent'
  | 'wood'
  | 'glass'
  | 'sandbag'
  | 'rubber'
  | 'helipad'
  | 'hazard'
  // vehicles
  | 'camoGreen'
  | 'camoRed'
  | 'vehMetal'
  | 'vehDetail'
  // fx
  | 'smoke'
  | 'scorch';

export interface SurfaceMaps {
  /** sRGB base colour. */
  map: THREE.Texture;
  /** tangent-space normal map (linear). */
  normalMap: THREE.Texture;
  /** roughness in G, metalness in B (linear). */
  roughnessMap?: THREE.Texture;
  /** ambient occlusion in R (linear). */
  aoMap?: THREE.Texture;
  /** Suggested world tiling in metres for one texture repeat. */
  worldScale: number;
}

export interface SurfaceLibrary {
  /** Raw maps, ready for custom shaders. */
  readonly surfaces: Record<MatKey, SurfaceMaps>;
  /**
   * Shared, cached MeshStandardMaterial for a key. Do not mutate the returned
   * material; use `clone()` for per-instance tweaks.
   */
  mat(key: MatKey, overrides?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial;
  /** A fresh material instance that is safe to mutate (e.g. team tinting). */
  clone(key: MatKey, overrides?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial;
  /** Cheap unlit material for far-away/instanced doodads. */
  unlit(key: MatKey, color?: number): THREE.MeshBasicMaterial;
  dispose(): void;
}

export interface SurfaceLibraryOptions {
  /** Renderer max anisotropy (usually `renderer.capabilities.getMaxAnisotropy()`). */
  anisotropy?: number;
  /** Texture resolution for the base pass. Default 512. */
  size?: number;
  /** Emit normal/roughness/AO maps (default true). */
  full?: boolean;
}

export function createSurfaceLibrary(_opts?: SurfaceLibraryOptions): SurfaceLibrary {
  throw new Error('not implemented');
}

/** Equirectangular sky used for `scene.background` + PMREM environment light. */
export interface SkyOptions {
  sunAzimuth?: number;
  sunElevation?: number;
  turbidity?: number;
  haze?: number;
  exposure?: number;
}
export function createSkyTexture(_opts?: SkyOptions): THREE.Texture {
  throw new Error('not implemented');
}

/* -------------------------------------------------------------------- models */

export type TeamId = 0 | 1;

/** Team palette shared by models + HUD (green/NATO vs signal red). */
export const TEAM_COLORS: readonly [number, number] = [0x4f7a3a, 0xb8402e];

export interface VehicleRig {
  /** Root node; origin sits on the ground contact point, +Z is forward. */
  root: THREE.Group;
  /** Child that yaws with the hull; only needed when `root` is a wrapper. */
  hull: THREE.Object3D;
  /** Rotates about local Y (tank/HRSV turret, tower pod). */
  turret?: THREE.Object3D;
  /** Pitches about local X (gun barrel). */
  gun?: THREE.Object3D;
  /** Spins about local Y (main rotor). */
  rotorMain?: THREE.Object3D;
  /** Spins about local X (tail rotor). */
  rotorTail?: THREE.Object3D;
  /** Spin about local X (wheels/tracks). */
  wheels: THREE.Object3D[];
  /** Empty anchored at the muzzle; used for flashes and tracer origins. */
  muzzle: THREE.Object3D;
  /** Empty anchored at the secondary muzzle. */
  muzzle2?: THREE.Object3D;
  /** Bounding size in metres: [length, width, height]. */
  size: [number, number, number];
  /** Y offset of the collision centre above the ground. */
  centerY: number;
}

export interface StructureModel {
  root: THREE.Object3D;
  /** Rotating parts (radar dish, gate, hangar doors, windmill...). */
  animated?: THREE.Object3D[];
  /** Collision half extents [x, z] if it is solid. */
  half: [number, number];
  height: number;
  /** Optional destroyed-state node; `root` is replaced visually when hp hits 0. */
  ruined?: THREE.Object3D;
}

/* --------------------------------------------------------------------- audio */

export type SfxName =
  | 'explosionSmall'
  | 'explosionBig'
  | 'gunTank'
  | 'gunChain'
  | 'rocketLaunch'
  | 'grenadeThrow'
  | 'mineDrop'
  | 'mineBlast'
  | 'impactMetal'
  | 'impactGround'
  | 'impactWater'
  | 'engineStart'
  | 'flagPickup'
  | 'flagCapture'
  | 'alarm'
  | 'laugh'
  | 'droneHum'
  | 'subLaunch'
  | 'resupply'
  | 'buildDone'
  | 'towerFire'
  | 'bailOut'
  | 'bridgeCollapse'
  | 'uiClick'
  | 'uiHover';

export type EngineKind = 'none' | 'jeep' | 'tank' | 'hrsv' | 'heli' | 'drone';
export type ThemeName =
  | 'jeep'
  | 'tank'
  | 'hrsv'
  | 'heli'
  | 'flag'
  | 'victory'
  | 'defeat'
  | 'title';

export interface GameAudio {
  /** Must be called from a user gesture. */
  resume(): Promise<void>;
  setMasterVolume(v: number): void;
  setMusicVolume(v: number): void;
  /** The volumes in force, so the settings panel can start from the config file. */
  masterVolume(): number;
  musicVolume(): number;
  /** Listener pose for stereo/HRTF panning. */
  setListener(pos: { x: number; y: number; z: number }, yaw: number): void;
  /** Fire-and-forget positional one-shot. */
  play(name: SfxName, pos?: { x: number; y: number; z: number }, opts?: { gain?: number; rate?: number }): void;
  /** Continuous engine loop driven every frame (0..1 load/throttle). */
  setEngine(kind: EngineKind, load: number, throttle: number): void;
  /** Looping rotor/track/drone loops that should follow the whole pack. */
  setLoop(name: 'rotor' | 'tracks' | 'drone' | null, load: number): void;
  /** Cross-fade to a classical theme (public-domain melodies, synthesised). */
  playTheme(theme: ThemeName | null, opts?: { fade?: number }): void;
  /** One-shot sting that does not loop (flag events, skull laugh...). */
  sting(theme: ThemeName): void;
  suspend(): void;
  dispose(): void;
  /** Dev-only: how many times a music track has been started (optional for fixtures). */
  readonly musicStarts?: number;
  /** Dev-only: URL of the recording currently sounding (null = synthesised theme or silence). */
  readonly mp3Active?: string | null;
  /** Dev-only: playback state of the live recording, if any. */
  readonly mp3State?: { url: string; paused: boolean; readyState: number; time: number } | null;
}

export function createGameAudio(): GameAudio {
  throw new Error('not implemented');
}

/* ------------------------------------------------------------------ helpers */

export function expectOk<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}
