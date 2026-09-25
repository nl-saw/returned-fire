# Architecture

```
┌────────────────────────────── browser ──────────────────────────────┐
│  three.js renderer (WebGL2)          DOM UI (HUD, minimap, menus)   │
│  scene · terrain · water · world ·   glass bottom bar · garage ·    │
│  effects/vfx · camera                notifications · banner         │
│        ▲                                    ▲                       │
│        │  flat f32 views (zero copy)        │  HudFrame             │
│        └──────────────┬─────────────────────┘                       │
│                 src/sim/bridge.ts  (wasm memory views, pools)       │
│                       ▲                                             │
│         control packets (12 f32 per player per frame)               │
└───────────────────────┼─────────────────────────────────────────────┘
                        │  WebAssembly
┌───────────────────────┴─────────────────────────────────────────────┐
│  rf-core (Rust)                                                      │
│  world.rs    entities, fixed 60 Hz loop, CTF rules, garage, resupply │
│  physics.rs  arcade driving, terrain following, collisions, weapons  │
│  combat.rs   projectiles, splash, mines, structure destruction       │
│  ai.rs       drivers, gunners, turret towers, drones, troops, sub    │
│  nav.rs      flow-field pathfinding on the nav grid                  │
│  mapgen.rs   procedural islands, bases, bridges, props, validation   │
│  spec.rs     vehicle + weapon tuning tables (compiled-in defaults)   │
│  tuning.rs   those tables as runtime data, for the config file       │
│  types.rs    the `*View` structs shared with TypeScript              │
└─────────────────────────────────────────────────────────────────────┘
```

## Why a Rust simulation and a JavaScript renderer

The simulation is authoritative and headless: it has no idea a renderer exists, which is
what makes `cargo test` able to drive whole matches on generated maps in a few hundred
milliseconds. The renderer never simulates anything — it reads state and draws it.

### The bridge

`types.rs` defines `#[repr(C)]`, f32-only view structs (`VehicleView`, `ProjectileView`,
`MineView`, `TurretView`, `FlagView`, `EventView`, `Structure`, `PlayerHud`, `TeamHud`) and
a stride for each. `lib.rs` hands out raw pointers to those arrays; `web/src/sim/bridge.ts`
wraps them in `Float32Array` views and decodes each record into pooled objects.

Two rules make this safe:

1. **Strides are duplicated on both sides** (`VEHICLE_STRIDE = 26` in Rust,
   `STRIDE.vehicle = 26` in `layout.ts`). Changing one without the other silently corrupts
   everything, so bump `STATE_VERSION` on both sides when you touch a view struct.
2. **wasm memory grows, and growth detaches every view.** `Sim.sync()` compares
   `memory.buffer` against the cached buffer on every frame and rebuilds *all* views,
   including the map buffers, when it changes. Skipping this is a classic NaN-everywhere bug.

### Events, not polling

The simulation pushes transient things (explosions, muzzle flashes, tracers, splashes,
sound cues, notifications) into a flat `Vec<EventView>` that is cleared every frame and read
by the renderer's effects system and the HUD. That keeps the per-frame payload tiny and lets
VFX and audio stay completely decoupled from simulation entities.

## Map generation

`mapgen::generate_sized(seed, index, mode, size)` builds a `MapData`: a heightfield
(257x257 on a small battlefield, 513x513 on a big one), per-vertex blend weights
(sand / dirt / rock / grass), an asphalt mask, per-vertex *sand* and *grass* variant indices,
a pavement-shape mask, a navigation grid and a list of structures. Everything is authored once for team 0 and mirrored 180° about the world
centre, so the map is exactly symmetric and both teams get identical terrain.

`validate()` proves the map is playable: buffer sizes, flag stands on land, a land path from
each spawn to the enemy flag, no solid overlaps, no terrain spikes, symmetry, determinism.

Bridges are `SOLID` structures *and* drivable surfaces: `World::bridge_deck()` raises the
ground height under a deck, `resolve_vehicle_collisions` skips bridges so vehicles drive
over them instead of bouncing off, and when a bridge is destroyed its footprint becomes
dynamically blocked so pathfinding routes around the gap.

## The map editor

`web/src/editor/` is a second page over the same wasm module: `EditorSim` wraps the Rust
`EditorMap` (which owns a `MapData` you can paint), the scene is the game's own terrain and
camera rig, and the toolbar is the only editor-specific UI.

The two ends of an edit are worth knowing. On the Rust side a *stroke* is the unit of undo: it
snapshots the layers, the ops paint, and closing it keeps only the rectangle that changed
(heights as f32 bytes, weights as u8) plus any structure-list or base change — then rebuilds the
nav grid through `rasterize_nav`, the same function the generator calls. A `.rfmap` is magic,
version, a readable JSON header, then the layers; `Game::fromMap` decodes it into the same
`World` a generated map builds, which is what "play this map" does.

Placement has one rule worth writing down, because it is the only tool that produces a *joint*
rather than a thing: **a wall is joined by a piece's end.** Pieces are 7.72 m and their origin is
their centre, so *contact* is arithmetic — two centres one segment apart along a shared run, or half
a segment apart across it — and `snap_wall` computes it rather than searching a lattice. It takes
the wall list and a cursor and returns `Option<(position, yaw)>`: the cursor is projected into the
nearest wall's own frame (nearest measured to the wall as a *barrier*, so at a corner the piece
beside the cursor wins over the one whose centre is closer), the yaw rounds to that wall's axis or
90° from it, and the joint follows from the direction the piece is turned: in line it continues the
run one segment along, square and past an end it butts onto that end half a segment out, square over
the body it crosses at the nearest piece boundary.

`None` means the snap *declines* — no spot near the cursor both joins something and is clear of
every wall — and the caller places the wall freely where the cursor is. That is the one failure mode
worth designing out: a snap that stacks a wall inside the wall it was meant to extend. Snapping is
also opt-out altogether: `preview(kind, x, z, yaw, snap: false)` — shift in the UI — returns the
cursor untouched. `preview` and `place` share the call, so the ghost cannot disagree with the
result.

**A perimeter is a stockade, and its collision boxes are its models.** The front and back runs go
corner to corner and the side runs stop half a wall short, so no piece is placed twice at a corner.
Each run is filled with equal pieces sized to the band they occupy, and `stamp_parts` uses *that*
size — not the palette's wall entry (7.6 x 0.9 x 2.6, which is the generator's wall). Using the
palette's size for both put the boxes somewhere the models were not, which is how "the walls no
longer block vehicles" happens. One gate, on the front run: the rear sally port read as a second
entrance and usually had a building in front of it.

**A perimeter is filled, not pitched.** The generator fills each solid band of a base's perimeter
with equal pieces sized to that band (`min(8 m, band/n)`), so consecutive pieces butt together and
the corners meet. The editor's blueprint does the same, with the same gate and sally-port openings,
because a fixed pitch leaves a gap half a model wide at one end of every run — which is what "the
walls do not meet" looks like, and it was the second bug in the round that produced this note.

**A base is moved by identity, not by geometry.** Every structure carries `sflag::BASE` when it is
generated inside a base's own footprint, and the editor records the ids of the parts it stamps
(`base_ids`). `move_base` removes the complex by those, then rebuilds the blueprint — so an island's
base, a town's walls 30 m away and the other team's base 65 m away are all left alone. `MapData`
carries `base_anchor` (the anchor and yaw each complex was *built* at) because deriving it from the
spawn and flag pads is possible in principle and wrong in practice: measured on the shipped layouts
the inference lands 100 m out, which is how "move base" used to leave the old base standing. That
field is written where a base is *placed* and nowhere else — in particular not by `sync_pads`, whose
call from the constructor used to overwrite the generator's anchors with the editor's, so every
later removal looked in the wrong place.

Moving a base rebuilds **both** complexes. Their perimeters are rectangles at each anchor's own
angle, positioned relative to each other, so moving one and leaving the other puts the two lattices
out of step — and a wall of one crossing a wall of the other is exactly what that looks like.

Three things the second round of work settled, each of which the code now relies on:

* **Placement is one function.** `can_place` answers whether a kind fits at a point, and the ghost's
  tint, the refusal and the move tool all read it. A preview that decides for itself whether a spot
  is good is a preview that lies.
* **A brush edit is local, and the renderer knows it.** `Terrain.updateFromMap(map, rect)` and
  `GroundMaterial.updateMasks(map, rect)` walk only the rectangle an edit touched: a full pass over
  a `?size=big` battlefield is 263k vertices of trigonometry and half-float conversion, 48 ms
  measured, and a brush dab touches a few thousand. The editor unions a frame's dabs into one rect,
  and falls back to a full pass when the change was structural rather than painted.
* **A reseed is an undo step.** `Edit` carries an optional pair of whole islands, so "new island" is
  a step like any other and a discarded island (with the work that was on it) comes back. Islands
  are the only history entry that is allowed to change the map's size.

The **overview** (`web/src/editor/minimap.ts`) is drawn *turned* — world `-x` right, `-z` down —
because that is how the player reads it; `project()` and a single canvas transform carry the turn,
so the ground, the marks, the camera footprint and the cursor cannot disagree, and `turn` gives the
world's own axes back. It draws the same `nav` grid the pathfinder routes on,
which is the point of it: a lane that looks open and is not drivable is invisible until a vehicle
wedges in it, and the overlay makes it a colour. Ground and structures are one image per edit; the
camera footprint and cursor are strokes per frame.

On the render side an edit is *in place*: `Terrain.updateFromMap` re-walks the mesh heights,
vertex colours, normals and the sea's depth half-floats, and `GroundMaterial.updateMasks` copies
the new splat / variant / road bytes into the live textures. No geometry, material or shader is
rebuilt, which is what makes painting a big battlefield interactive.

## Rendering notes

- **Ground**: `terrainMaterial.ts` injects splat-blended albedo and roughness into a
  `MeshStandardMaterial` so the terrain keeps three.js' shadow/IBL/tonemapping pipeline while
  every material tiles at its own real-world scale. Macro relief comes from the heightfield
  geometry normals; micro relief from a tiled detail normal. Sand and grass are **three-stop
  ramps**: the map stores one variant index per vertex and the shader lerps between the two
  materials either side of it (two fetches, not three). Pavement is the road mask's level plus a
  shape — plain concrete, square slabs, or a slab strip laid along the road, which swaps its UV
  axes rather than rotating them so the mip derivatives stay valid.
- **Sea**: a custom shader with a depth map baked from the heightfield, two scrolling wave
  normals, fresnel sky reflection, a narrow broken foam band and a tight sun glint.
- **Draw calls**: structure templates are merged per material once (`mergeModel.ts`) and
  cloned; palms, rocks, crates, barrels, sandbags, containers and wrecks are instanced. This
  took a full map from ~10.7k meshes to ~1.9k.
- **Camera**: fixed compass heading by default (readable, like the original), with optional
  chase rotation, zoom, a small velocity look-ahead and explosion shake.
- **Effects**: pooled instanced particles, decals, debris and recycled point lights, driven
  entirely by the simulation's event stream.

## Audio

`web/src/audio/*` synthesises everything with WebAudio — 25 SFX recipes, five engine voices
and eight public-domain classical themes (one per vehicle, plus flag/victory/defeat/title),
recreating the original's licensed-soundtrack concept without shipping a single audio file.
It also runs an offline render + pitch-detection self-check (`tools/audio-report.mjs`).

## Testing

`crates/rf-core/tests/common/mod.rs` is shared scaffolding — a map through the editor's own save
format, and a round the game's AI plays by itself. It exists because `editor_play.rs` needs both and
because getting the *baseline* wrong is easy: `mapgen::generate` defaults to mirror mode while the
editor opens in classic, so a comparison taken from the generator is a comparison of two different
islands. Every baseline in that file comes through `EditorMap` for that reason.

`tools/terrain-cost.mjs` measures the ground refresh per battlefield size, splitting the wasm op,
the bridge's re-read and the mesh/texture pass — and it checks that a region update leaves the mesh
byte-for-byte as a full one does.


| Suite | What it proves |
| --- | --- |
| `crates/rf-core/tests/sim_logic.rs` | physics, weapons, mines, bridges, spawn protection on a synthetic map |
| `crates/rf-core/tests/sim_smoke.rs` | generated-map stability over 3600 ticks, a scripted flag capture, wreck/rebuild, turret engagement |
| `mapgen::tests` | determinism, symmetry, structural invariants, walkability |
| `tools/capture.mjs` | headless WebGL capture: renders one frame on demand and reports `rfProbe()`/`rfStats()` |
| `tools/audio-report.mjs` | offline audio metrics + melody pitch verification |
