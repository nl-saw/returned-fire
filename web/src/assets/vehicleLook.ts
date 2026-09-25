/**
 * vehicleLook.ts — the active "visibility look" for vehicles.
 *
 * A look decides how each vehicle carries its team identity, which is a readability question
 * rather than a simulation one: the chosen value is read by the procedural vehicle builders
 * (`assets/models/vehicles.ts`) when a rig is built, and attaches extra geometry to it. The
 * simulation never sees it, so determinism is untouched — and because the value is read at build
 * time, changing it rebuilds the rigs rather than re-tinting them (`?look=N` on a fresh load, or
 * `runtime.look` in `rf.config.json`).
 *
 * Where the value comes from, in precedence order:
 *
 *   1. `?look=N`               the harness override, read in `main.ts`
 *   2. `runtime.look`          the config file (`web/public/rf.config.json`), and any change the
 *                              player stored, which is what the game ships with
 *   3. `DEFAULT_LOOK` below    used when neither is present (no config file, no parameter)
 *
 * Keep (2) and (3) in step: `rf.config.json` ships the same id as `DEFAULT_LOOK`, so a config
 * file that fails to load looks the same as one that loads.
 */

export interface VehicleLookInfo {
  id: number;
  name: string;
  detail: string;
}

/**
 * The four looks, cheapest to most explicit:
 *
 * - **0 stock** — nothing is added. The vehicles keep only the small painted marks modelled into
 *   them (`M.mark` details: a stripe here, a panel there), which is what the original game had.
 * - **1 bold bands** — a thick team-coloured band down each hull side (`sideBands`: a 2.5 cm
 *   plate, `h` tall and `len` long, mirrored at ±x, set at each hull's own half-width). Reads at
 *   a distance, and from the side only. Infantry have no hull side to stripe, so a troop gets a
 *   band round its helmet instead (same idea at 0.9 m tall).
 * - **2 pennants** — a small flag on a metal pole, planted at a per-vehicle spot chosen so the
 *   turret or rotor cannot sweep through it (the tank's engine deck, the helicopter's tail fin).
 *   Reads from any angle, and it is the only look that is visible from above. A troop wears an
 *   armband rather than carrying a flag.
 * - **3 ground rings** — a flat, unlit team-coloured ellipse on the ground under every *ground*
 *   vehicle, sized to that hull's footprint. Unlit on purpose, so it stays readable in any light
 *   and at any zoom; fliers get nothing, because a ring floating under a helicopter reads as a
 *   shadow rather than a marker. This is the default.
 *
 * `tools/look-sheet.mjs` renders the four side by side and counts the parts each look actually
 * puts in the scene, which is the quickest way to see a regression here: the counts are 0 look
 * parts for stock, one `band:` mesh per ground hull for look 1, `pennant:` meshes (plus the
 * infantry armbands, also named `band`) for look 2, and one `teamRing` per *ground* hull - never
 * a flier - for look 3.
 */
export const VEHICLE_LOOKS: readonly VehicleLookInfo[] = [
  { id: 0, name: 'stock', detail: 'original small painted marks' },
  { id: 1, name: 'bold bands', detail: 'thick team-coloured band along each hull side' },
  { id: 2, name: 'pennants', detail: 'team pennant on a pole at the top of each vehicle' },
  { id: 3, name: 'ground rings', detail: 'flat team-coloured ring under each ground vehicle (fliers keep camo + marks only)' },
];

/**
 * What the game boots with when neither the config file nor the URL says otherwise: ground rings
 * (chosen over bands and pennants after the design comparison). `tools/look-sheet.mjs` renders
 * all four side by side, and `web/public/rf.config.json` ships this same id under `runtime.look`.
 */
export const DEFAULT_LOOK = 3;

let current = DEFAULT_LOOK;

/**
 * Select a look by id. An unknown id (a typo in the config, a stale bookmark's `?look=9`) is
 * ignored rather than clamped to something arbitrary, so the look stays whatever was selected
 * before — `DEFAULT_LOOK` at boot.
 */
export function setVehicleLook(id: number): void {
  if (VEHICLE_LOOKS.some((l) => l.id === id)) current = id;
}

/** The active look id, read by the vehicle builders while they build a rig. */
export function vehicleLook(): number {
  return current;
}

/** The active look's metadata, for the config check and the look sheet. */
export function vehicleLookInfo(): VehicleLookInfo {
  return VEHICLE_LOOKS.find((l) => l.id === current) ?? VEHICLE_LOOKS[0];
}
