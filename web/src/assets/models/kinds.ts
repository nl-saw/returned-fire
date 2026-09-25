/**
 * kinds.ts — id ↔ name ↔ size ↔ authoring tables for the structure and prop builders.
 *
 * The ids mirror `crates/rf-core/src/types.rs` (`skind`) and `web/src/sim/layout.ts`
 * STRUCT_KIND; the extra prop ids 100+ are ours (natural scatter the map generator may
 * place directly or that the renderer can add as dressing).
 *
 * `STRUCTURE_SIZE` is the size each model is *authored for*, in metres, as [w, d, h]
 * (x extent, z extent, height). Unit-sized models normalise their geometry into the
 * 1x1x1 box, so the map generator may pass any w/d/h in `Structure`; these numbers are
 * what the proportions look right at, and what `half`/`height` report.
 *
 * They must match the sizes rf-core's map generator actually places (`mapgen.rs`): the
 * renderer normalises by these numbers and then scales the instance by the `Structure`
 * record's w/h/d, so a disagreement stretches the model (the HQ was authored 19x15x8.4 and
 * placed 10x8.5x11.5, i.e. squeezed to half width and pushed 37% taller). `tools/structure-fit.mjs`
 * checks this against a generated map — run it after touching either side.
 */

/** Structure kinds (`crates/rf-core/src/types.rs` → `skind`). */
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

/** Extra natural-scatter prop ids owned by `props.ts` (100+ is our namespace). */
export const PROPKIND = {
  BUSH: 100,
  GRASS_TUFT: 101,
  DEAD_SHRUB: 102,
  AGAVE: 103,
  /** Loose stone scatter (3 pebbles) for beach/road edges. */
  STONES: 104,
} as const;

export type Size3 = readonly [number, number, number];

/** [w, d, h] each model is authored for, in metres. */
export const STRUCTURE_SIZE: Readonly<Record<number, Size3>> = {
  [SKIND.GARAGE]: [16, 10, 5.2],
  [SKIND.FLAG_POLE]: [1.6, 1.6, 9.4],
  [SKIND.FUEL_DEPOT]: [8.5, 6.5, 3.4],
  [SKIND.AMMO_TENT]: [8, 5.5, 3.2],
  // The generator places the pad at 0.4 m - the drivable deck. The windsock mast is
  // authored *above* that height on purpose, so the model stands taller than its box.
  [SKIND.HELIPAD]: [11, 11, 0.4],
  [SKIND.RADAR]: [6.5, 6.5, 10.6],
  [SKIND.WALL]: [7.1, 0.9, 2.6],
  [SKIND.BUNKER]: [6.5, 5.5, 2.4],
  [SKIND.BRIDGE]: [18, 8, 3.6],
  [SKIND.TENT]: [6, 5, 2.6],
  [SKIND.TURRET_TOWER]: [5, 5, 8.6],
  [SKIND.PALM]: [5, 5, 9.5],
  [SKIND.ROCK]: [2.6, 2.6, 1.9],
  [SKIND.BUILDING]: [13, 9.5, 6.5],
  [SKIND.CRATE]: [2.2, 2.2, 2.0],
  [SKIND.BARREL]: [1.4, 1.4, 1.6],
  [SKIND.SANDBAG]: [4, 1.4, 1.0],
  [SKIND.WATCHTOWER]: [4.6, 4.6, 8.8],
  [SKIND.HANGAR]: [22, 17, 8.6],
  [SKIND.ANTENNA]: [4, 4, 12.6],
  [SKIND.WRECK]: [6.5, 3.2, 2.2],
  [SKIND.HQ]: [10, 8.5, 11.5],
  [SKIND.GATE]: [7.4, 1.2, 4.2],
  [SKIND.CONTAINER]: [6.5, 2.8, 2.7],
  [SKIND.LIGHTHOUSE]: [6.5, 6.5, 15],
};

/** Fallback size for an unknown kind: a humble crate. */
export const GENERIC_SIZE: Size3 = [1.5, 1.5, 1.3];

export const PROP_SIZE: Readonly<Record<number, Size3>> = {
  [SKIND.PALM]: [5, 5, 9.5],
  [SKIND.ROCK]: [2.6, 2.6, 1.9],
  [PROPKIND.BUSH]: [1.8, 1.8, 1.1],
  [PROPKIND.GRASS_TUFT]: [1.1, 1.1, 0.7],
  [PROPKIND.DEAD_SHRUB]: [2.0, 2.0, 1.4],
  [PROPKIND.AGAVE]: [1.8, 1.8, 1.2],
  [PROPKIND.STONES]: [1.6, 1.6, 0.5],
};

const NAMES: Readonly<Record<number, string>> = {
  [SKIND.NONE]: 'none',
  [SKIND.GARAGE]: 'garage',
  [SKIND.FLAG_POLE]: 'flagPole',
  [SKIND.FUEL_DEPOT]: 'fuelDepot',
  [SKIND.AMMO_TENT]: 'ammoTent',
  [SKIND.HELIPAD]: 'helipad',
  [SKIND.RADAR]: 'radar',
  [SKIND.WALL]: 'wall',
  [SKIND.BUNKER]: 'bunker',
  [SKIND.BRIDGE]: 'bridge',
  [SKIND.TENT]: 'tent',
  [SKIND.TURRET_TOWER]: 'turretTower',
  [SKIND.PALM]: 'palm',
  [SKIND.ROCK]: 'rock',
  [SKIND.BUILDING]: 'building',
  [SKIND.CRATE]: 'crate',
  [SKIND.BARREL]: 'barrel',
  [SKIND.SANDBAG]: 'sandbag',
  [SKIND.WATCHTOWER]: 'watchtower',
  [SKIND.HANGAR]: 'hangar',
  [SKIND.ANTENNA]: 'antenna',
  [SKIND.WRECK]: 'wreck',
  [SKIND.HQ]: 'hq',
  [SKIND.GATE]: 'gate',
  [SKIND.CONTAINER]: 'container',
  [SKIND.LIGHTHOUSE]: 'lighthouse',
  [PROPKIND.BUSH]: 'bush',
  [PROPKIND.GRASS_TUFT]: 'grassTuft',
  [PROPKIND.DEAD_SHRUB]: 'deadShrub',
  [PROPKIND.AGAVE]: 'agave',
  [PROPKIND.STONES]: 'stones',
};

/** Stable lowercase name for an id (unknown ids report `crate(fallback)`). */
export function structureKindName(kind: number): string {
  return NAMES[kind] ?? 'crate(fallback)';
}

/** Same table, for the natural-scatter ids. */
export function propKindName(kind: number): string {
  return NAMES[kind] ?? 'prop(fallback)';
}

/**
 * Kinds authored *true scale* — the renderer must NOT apply the instance w/d/h scale to
 * these, only `yaw` (+ position). Everything else is authored inside the 1x1x1 box and
 * is meant to be scaled non-uniformly to the `Structure` record's w/d/h.
 */
const TRUE_SCALE = new Set<number>([
  SKIND.FLAG_POLE,
  SKIND.RADAR,
  SKIND.TURRET_TOWER,
  SKIND.PALM,
  SKIND.ROCK,
  SKIND.WATCHTOWER,
  SKIND.ANTENNA,
  SKIND.LIGHTHOUSE,
  PROPKIND.BUSH,
  PROPKIND.GRASS_TUFT,
  PROPKIND.DEAD_SHRUB,
  PROPKIND.AGAVE,
  PROPKIND.STONES,
]);

/**
 * Kinds that must NOT be scaled by the map's w/d/h (see `isUnitSized`). Exported as data
 * so renderers can use it directly instead of hardcoding an exception list.
 */
export const TRUE_SCALE_KINDS: readonly number[] = [...TRUE_SCALE];

/**
 * `true` when the geometry lives in the unit box (span x/z ∈ [-0.5, 0.5], y ∈ [0, 1]) and
 * the renderer should scale it by (w, h, d).
 *
 * `false` for things that must never stretch — palms, rocks, flags, dishes, towers — which
 * are authored at true metres and should get `yaw` only.
 */
export function isUnitSized(kind: number): boolean {
  return !TRUE_SCALE.has(kind);
}

/** Authored [w, d, h] for a structure/prop id (crate-sized fallback for unknown ids). */
export function sizeOf(kind: number): Size3 {
  return STRUCTURE_SIZE[kind] ?? PROP_SIZE[kind] ?? GENERIC_SIZE;
}

/** Kinds that ship a destroyed variant node (`model.ruined`). */
export const RUINED_KINDS: readonly number[] = [
  SKIND.GARAGE,
  SKIND.WALL,
  SKIND.BUNKER,
  SKIND.BRIDGE,
  SKIND.TENT,
  SKIND.TURRET_TOWER,
  SKIND.BUILDING,
  SKIND.CRATE,
  SKIND.BARREL,
  SKIND.SANDBAG,
  SKIND.WATCHTOWER,
  SKIND.HQ,
  SKIND.GATE,
  SKIND.CONTAINER,
];

/** Prop ids this module can build (`buildProp`), plus the structure palm/rock ids. */
export const PROP_KINDS: readonly number[] = [
  SKIND.PALM,
  SKIND.ROCK,
  PROPKIND.BUSH,
  PROPKIND.GRASS_TUFT,
  PROPKIND.DEAD_SHRUB,
  PROPKIND.AGAVE,
  PROPKIND.STONES,
];
