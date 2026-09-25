//! Returned Fire — deterministic simulation core.
//!
//! The crate is compiled to `wasm32-unknown-unknown` and exposes a small `Game` object.
//! Everything the renderer needs is handed out as raw pointers into wasm linear memory
//! (see `types.rs` for the flat `*View` layouts, and `web/src/sim/layout.ts` for the
//! TypeScript mirror of these strides).

pub mod ai;
pub mod combat;
pub mod editor;
pub mod mapgen;
pub mod math;
pub mod nav;
pub mod physics;
pub mod spec;
pub mod tuning;
pub mod types;
pub mod world;

pub use math::{Vec2, Vec3};
pub use types::*;

use crate::math::v2;
use wasm_bindgen::prelude::*;
use world::{Input, World};

/// The flag set a kind carries by default: what it blocks, what can be shot, what services it
/// offers. `normalize_map` uses this to backfill structures that came in with no flags at all,
/// and the editor's base stamper uses it so a hand-placed base is flagged exactly like the
/// generator's — before, a stamped part carried only its BASE marker, which suppressed the
/// backfill and left every building of a moved base solid-less: drive-through walls, nav that
/// routed through the HQ, bullets that never hit.
pub fn kind_flags(kind: u8, h: f32, team: u8) -> u32 {
    use skind::*;
    let solid = matches!(
        kind,
        WALL | BUNKER | BUILDING | HQ | GARAGE | BRIDGE | TURRET_TOWER | ROCK
            | WATCHTOWER | HANGAR | GATE | CONTAINER | LIGHTHOUSE | CRATE | BARREL
            | ANTENNA | RADAR | FUEL_DEPOT | AMMO_TENT
    );
    let destructible = matches!(
        kind,
        WALL | BUNKER | BUILDING | HQ | GARAGE | BRIDGE | TURRET_TOWER | TENT | CRATE
            | BARREL | CONTAINER | WATCHTOWER | GATE | HANGAR | PALM | ANTENNA | RADAR
            | FUEL_DEPOT | AMMO_TENT
    );
    let mut f = 0u32;
    if solid {
        f |= sflag::SOLID;
    }
    if destructible {
        f |= sflag::DESTRUCTIBLE;
    }
    if h > 2.0 || solid {
        f |= sflag::BLOCKS_LOS;
    }
    match kind {
        FUEL_DEPOT => f |= sflag::FUEL,
        AMMO_TENT => f |= sflag::AMMO,
        HELIPAD => f |= sflag::FLAT | sflag::FUEL | sflag::AMMO | sflag::REPAIR,
        GARAGE => f |= sflag::BAY | sflag::REPAIR,
        FLAG_POLE | WRECK | SANDBAG => {}
        _ => {}
    }
    if team < 2 && matches!(kind, GARAGE | HQ | TURRET_TOWER | HELIPAD) {
        f |= sflag::BAY;
    }
    f
}

/// Fill in any structure flags / nav blocking the map generator left out, so the physics
/// and the renderer agree even if a hand-written map forgets a detail.
pub fn normalize_map(map: &mut MapData) {
    use skind::*;
    for i in 0..map.structures.len() {
        let (kind, w, d, h) = {
            let s = &map.structures[i];
            (s.kind as u8, s.w, s.d, s.h)
        };
        let s = &mut map.structures[i];
        s.id = i as f32;
        if s.hp_max <= 0.0 {
            s.hp_max = match kind {
                PALM => 40.0,
                CRATE | BARREL => 30.0,
                TENT => 120.0,
                WALL => 250.0,
                BRIDGE => 300.0,
                BUNKER => 400.0,
                TURRET_TOWER => 500.0,
                ROCK => 600.0,
                _ => 200.0,
            };
        }
        if s.hp <= 0.0 {
            s.hp = s.hp_max;
        }
        if s.flags == 0.0 {
            s.flags = kind_flags(kind, h, s.team as u8) as f32;
        }
        let _ = (w, d);
    }

    // Make sure solid footprints are not walkable.
    let cell = map.cell;
    let g = map.grid as i32;
    let solids: Vec<(Vec2, f32, f32, f32, u8)> = map
        .structures
        .iter()
        .filter(|s| s.flag(sflag::SOLID))
        .map(|s| (s.pos(), s.w, s.d, s.yaw, s.kind as u8))
        .collect();
    for (p, w, d, yaw, kind) in solids {
        if kind == skind::BRIDGE {
            continue; // bridges are the way across
        }
        // Pad by roughly the half-width of a jeep. The flow field is cell-based, so without
        // this it happily routes a 3 m vehicle through a 1 m gap beside a wall, and the
        // driver wedges there. Gates are 8 m wide, so they stay comfortably passable.
        // 0.8 m: enough to stop the flow field threading a 1 m slot beside a wall, small
        // enough that an 8 m gateway (which also carries a 1 m nav shoulder) stays drivable.
        let hw = w * 0.5 + 0.8;
        let hd = d * 0.5 + 0.8;
        let (sn, cs) = yaw.sin_cos();
        let ex = hw * cs.abs() + hd * sn.abs();
        let ez = hw * sn.abs() + hd * cs.abs();
        let x0 = (((p.x - ex) / cell).floor() as i32).clamp(0, g - 1);
        let z0 = (((p.y - ez) / cell).floor() as i32).clamp(0, g - 1);
        let x1 = (((p.x + ex) / cell).ceil() as i32).clamp(0, g - 1);
        let z1 = (((p.y + ez) / cell).ceil() as i32).clamp(0, g - 1);
        for z in z0..=z1 {
            for x in x0..=x1 {
                let i = (z * g + x) as usize;
                if map.nav[i] == terrain::ROAD {
                    continue;
                }
                let cmin = v2(x as f32 * cell, z as f32 * cell);
                let cmax = v2(cmin.x + cell, cmin.y + cell);
                if !obb_overlaps_aabb(p, w * 0.5, d * 0.5, yaw, cmin, cmax) {
                    continue;
                }
                map.nav[i] = terrain::BLOCKED;
            }
        }
    }
}

/// Separating-axis test between a rotated rectangle and an axis-aligned cell. Blocking only
/// the cells a footprint really crosses keeps nav tidy (a 0.9 m wall blocks a 2 m band, not
/// the 8 m AABB band a naive test would produce).
fn obb_overlaps_aabb(center: Vec2, hw: f32, hd: f32, yaw: f32, cmin: Vec2, cmax: Vec2) -> bool {
    let (s, c) = yaw.sin_cos();
    let axes = [v2(c, s), v2(-s, c), v2(1.0, 0.0), v2(0.0, 1.0)];
    let cbox = v2((cmin.x + cmax.x) * 0.5, (cmin.y + cmax.y) * 0.5);
    let bhw = (cmax.x - cmin.x) * 0.5;
    let bhd = (cmax.y - cmin.y) * 0.5;
    let d = cbox - center;
    for a in axes.iter() {
        let dist = d.dot(*a).abs();
        let ra = hw * a.dot(axes[0]).abs() + hd * a.dot(axes[1]).abs();
        let rb = bhw * a.x.abs() + bhd * a.y.abs();
        if dist > ra + rb {
            return false;
        }
    }
    true
}

/// The whole game: owns the world, the fixed-step accumulator and the JS-facing buffers.
#[wasm_bindgen]
pub struct Game {
    world: World,
    inputs: [Input; 2],
    accum: f32,
    events: Vec<EventView>,
    specs_json: String,
    seed: u32,
    map_index: u32,
    map_mode: u32,
    map_size: u32,
    players: [i32; 2],
    /// CPU-driven player slots (attract/demo mode). Mirrored on the world and carried across
    /// `restart`, which rebuilds it.
    cpu_driven: [bool; 2],
}

#[wasm_bindgen]
impl Game {
    /// `players[i] >= 0` marks player slot `i` as human controlled (0 = single player,
    /// `[0, 1]` = two players on one machine).
    ///
    /// `map_mode` selects the generator: `0` = classic (procedural, unmirrored — the default)
    /// and `1` = mirror (the authored, half-mirrored maps). Any other value decodes as classic.
    ///
    /// `map_size` selects the battlefield size: `0` = small (512 m, the default), `1` = medium
    /// (1024 m) and `2` = big (2048 m). It rides here rather than on `set_options` because the
    /// world's dimensions are fixed when it is built — the nav grid, the occupancy grid and the
    /// flow fields are all sized from it.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, map_index: u32, map_mode: u32, map_size: u32, two_player: bool) -> Game {
        let players = if two_player { [0, 1] } else { [0, -1] };
        let size = crate::types::MapSize::from_u32(map_size);
        let mut map = mapgen::generate_sized(seed, map_index, mapgen::MapMode::from_u32(map_mode), size);
        normalize_map(&mut map);
        let mut w = World::new_with_map(seed, map, players);
        w.sync_views();
        Game {
            world: w,
            inputs: [Input::default(); 2],
            accum: 0.0,
            events: Vec::with_capacity(4096),
            specs_json: build_specs_json(),
            seed,
            map_index,
            map_mode: mapgen::MapMode::from_u32(map_mode).as_u32(),
            map_size: size.as_u32(),
            players,
            cpu_driven: [false, false],
        }
    }

    /// Play an edited map: the `.rfmap` the map editor writes, decoded straight into a world.
    ///
    /// An edited map is a `MapData` like any other, so this is the generator path with the map
    /// swapped out — same normalisation, same `World`, same everything downstream. `map_index`,
    /// `map_mode` and `map_size` are reported from the file's header so the HUD and a restart
    /// behave as they do for a generated map.
    #[wasm_bindgen(js_name = fromMap)]
    pub fn from_map(bytes: &[u8], two_player: bool) -> Result<Game, JsValue> {
        let ed = editor::EditorMap::from_bytes(bytes).map_err(|e| JsValue::from_str(&e))?;
        let players = if two_player { [0, 1] } else { [0, -1] };
        let seed = ed.seed();
        let map_mode = ed.mode().as_u32();
        let map_size = ed.size().as_u32();
        let mut map = ed.into_map();
        normalize_map(&mut map);
        let mut w = World::new_with_map(seed, map, players);
        w.sync_views();
        Ok(Game {
            world: w,
            inputs: [Input::default(); 2],
            accum: 0.0,
            events: Vec::with_capacity(4096),
            specs_json: build_specs_json(),
            seed,
            map_index: 0,
            map_mode,
            map_size,
            players,
            cpu_driven: [false, false],
        })
    }

    /// Per-player control package. Call once per rendered frame before `update`.
    #[allow(clippy::too_many_arguments)]
    pub fn set_input(
        &mut self,
        player: usize,
        throttle: f32,
        steer: f32,
        aim: f32,
        aim_pitch: f32,
        has_aim: bool,
        fire0: bool,
        fire1: bool,
        fire1_edge: bool,
        brake: bool,
        ascend: bool,
        strafe: f32,
    ) {
        if player >= 2 {
            return;
        }
        self.inputs[player] = Input {
            throttle,
            steer,
            aim,
            aim_pitch,
            has_aim,
            fire0,
            fire1,
            fire1_edge,
            brake,
            ascend,
            strafe,
        };
    }

    /// Advance the simulation by `dt` seconds using a fixed 60 Hz timestep.
    pub fn update(&mut self, dt: f32) {
        self.events.clear();
        let step = 1.0 / TICK_HZ;
        self.accum += dt.clamp(0.0, 0.25);
        let mut steps = 0;
        while self.accum >= step && steps < 12 {
            self.world.step(step, &self.inputs);
            if self.events.len() < 16384 {
                self.events.extend_from_slice(&self.world.events);
            }
            self.accum -= step;
            steps += 1;
        }
        if steps == 12 {
            self.accum = 0.0;
        }
        // Events are consumed once per frame by the renderer; keep the tail if we overflow.
        if self.events.len() > 16384 {
            let keep = self.events.len() - 16384;
            self.events.drain(0..keep);
        }
    }

    /// The seed this world was built from: a generated map's, or an edited map's header.
    pub fn seed(&self) -> u32 {
        self.seed
    }

    /// Ask the garage for a vehicle (`kind` = 1 jeep, 2 tank, 3 HRSV, 4 helicopter).
    pub fn request_vehicle(&mut self, player: usize, kind: u32) {
        self.world.request_vehicle(player, kind as u8);
    }

    /// Restart the match on a (possibly different) map, generator mode and/or size.
    pub fn restart(&mut self, seed: u32, map_index: u32, map_mode: u32, map_size: u32) {
        let mode = mapgen::MapMode::from_u32(map_mode);
        let size = crate::types::MapSize::from_u32(map_size);
        let mut map = mapgen::generate_sized(seed, map_index, mode, size);
        normalize_map(&mut map);
        // `restart` rebuilds the `World`, which would drop the player's CPU FORCE / range /
        // allies choices with it, so carry them across the swap — along with any CPU-driven
        // slots (demo mode must survive a round restart). Re-applying `cpu_allies` re-fields
        // the ally garrison on the fresh world.
        let (difficulty, sandbox, cpu_allies) =
            (self.world.difficulty as u32, self.world.sandbox, self.world.cpu_allies);
        let vehicle_cap = self.world.vehicle_cap;
        let cpu_driven = self.cpu_driven;
        self.world = World::new_with_map(seed, map, self.players);
        self.world.set_options(difficulty, sandbox, cpu_allies);
        self.world.set_vehicle_cap(vehicle_cap);
        self.world.cpu_driven = cpu_driven;
        self.world.sync_views();
        self.seed = seed;
        self.map_index = map_index;
        self.map_mode = mode.as_u32();
        self.map_size = size.as_u32();
    }

    /// Player-facing match options: CPU force level (`0` easy, `1` medium, `2` hard), the
    /// test/practice range flag and the CPU-allies toggle (field a tank + jeep AI garrison on
    /// every human team, kept topped up by the commander's independent supply line). Applied to
    /// the live world, so it works on the simulation the title screen is already built on, not
    /// just on the next match.
    ///
    /// `Game::new` takes only the seed, map and mode (the boot path should not have to know
    /// these options), so this is the one entry point; callers apply it again after
    /// `restart`/`load`.
    /// The dotted name of every tuning slot, in the order `set_tuning` reads them - the game's
    /// config file writes exactly these keys (`rules.rounds_to_win`, `weapons.tank_shell.life`,
    /// `vehicles.tank.hp`), so the file's names and this array cannot drift.
    pub fn tuning_layout(&self) -> Vec<String> {
        crate::tuning::Tuning::layout()
    }

    /// Install the config file's tuning overrides: a flat array matching `tuning_layout`, where
    /// a `NaN` (or missing) slot keeps the compiled-in default. Safe to call on a live world -
    /// hulls already in the field are re-issued their specs - and safe to call twice.
    pub fn set_tuning(&mut self, values: Vec<f32>) {
        self.world.apply_tuning(&values);
    }

    /// The tuning currently in force, in `tuning_layout` order. For the harness: it can check
    /// that what it wrote to the config file is what the simulation is actually running.
    pub fn tuning_values(&self) -> Vec<f32> {
        self.world.tuning.values()
    }

    pub fn set_options(&mut self, difficulty: u32, sandbox: bool, cpu_allies: bool) {
        self.world.set_options(difficulty, sandbox, cpu_allies);
    }

    /// CPU-drive a player slot: the simulation's own AI flies that hull instead of taking
    /// human input. Attract/demo mode uses this so the "player" vehicle navigates, targets and
    /// fights like any other driver (no blind sine-wave autopilot, no friendly fire). Carried
    /// across `restart`. (CPU-controlled *allies* are a different thing: they never own a slot
    /// — see `set_options`'s `cpu_allies`.)
    pub fn set_cpu_driven(&mut self, slot: usize, on: bool) {
        if slot >= 2 {
            return;
        }
        self.cpu_driven[slot] = on;
        self.world.set_cpu_driven(slot, on);
    }

    /// Skip to the next round (used by the "next round" button).
    pub fn force_next_round(&mut self) {
        self.world.round_over_t = 0.0;
        self.world.new_round();
    }

    /// Per-team ceiling on concurrent CPU hulls: `0` means "the rules" (2 / 3 / 6 by
    /// difficulty, 2 for CPU allies). A stress test raises it — `?maxveh=24` in the browser,
    /// `set_vehicle_cap` from the console. Clamped to `world::MAX_VEHICLE_CAP`.
    ///
    /// A cap also relaxes the commander's yard rule (two hulls at home count as busy rather than
    /// one), because at a field of sixteen someone is always rotating back to refuel and the
    /// strict rule held the force at garrison size. Reinforcements are still paced by
    /// `CPU_SPAWN_DELAY` — one field vehicle a team every three seconds — so a cap fills as a
    /// steady stream, and what it settles at is what the fight can sustain.
    pub fn set_vehicle_cap(&mut self, cap: u32) {
        self.world.set_vehicle_cap(cap as usize);
    }

    /// How far a defence tower reaches, in metres — `weapon::TOWER_MISSILE.range`, the constant
    /// its fire control acquires and shoots with. The debug range overlay draws it; a tower has
    /// no separate sight radius, so one ring says everything about it.
    pub fn tower_range(&self) -> f32 {
        self.world.tuning.weapons[crate::spec::wkind::TOWER_MISSILE].range
    }

    /// The cap in force: `0` when the difficulty rules are deciding the field strength.
    pub fn vehicle_cap(&self) -> u32 {
        self.world.vehicle_cap as u32
    }

    /// Console/test seam: end the current round as a *win* for the player's team, through the
    /// real round-over flow (score, notification, sting, and a match win once the score
    /// completes). With no human team on the field — attract mode — the win goes to team 0.
    pub fn force_round_win(&mut self) {
        self.world.force_round_for(self.human_team());
    }

    /// Console/test seam: the same, as a *loss* for the player's team.
    pub fn force_round_lose(&mut self) {
        self.world.force_round_for(1 - self.human_team());
    }

    /// The team the human player is on, or team 0 when nobody is playing (attract mode).
    fn human_team(&self) -> u8 {
        self.players
            .iter()
            .find(|t| **t >= 0)
            .map(|t| (*t as u8).min(1))
            .unwrap_or(0)
    }

    /// Test seam: destroy the vehicle at slot `index` through the real kill path (explosion,
    /// WRECK state, wreck culling). No gameplay code calls this — it exists so the headless
    /// renderer harness (`tools/rotor-freeze.mjs`) can kill a hull without waiting for combat.
    /// Out-of-range is a no-op, so a stale index can never panic the page.
    pub fn debug_kill_vehicle(&mut self, index: usize) {
        if index < self.world.vehicles.len() {
            self.world.kill_vehicle(index, -1);
        }
    }

    /// Test seam: damage the structure at slot `index` through the real damage path (hp loss,
    /// rubble, events, and the DEAD flag + explosion when it drops to zero). No gameplay code
    /// calls this — it exists so the headless renderer harness can destroy a wall or building
    /// without waiting for combat. Out-of-range or already-dead targets are a no-op.
    pub fn debug_damage_structure(&mut self, index: usize, dmg: f32) {
        crate::combat::damage_structure(&mut self.world, index, dmg, 0);
    }

    /// The first non-finite kinematic event seen by the vehicle physics, as a flat float
    /// array `[id, kind, team, player, px, pz, y, vx, vy, fwd_speed, yaw, steer_in,
    /// throttle_in, pre_poisoned]` — or `None` while every hull is finite. The position is
    /// the one a tick earlier, so it shows where the hull was when it went bad.
    pub fn nan_debug(&self) -> Option<Vec<f32>> {
        self.world.nan_debug.map(|h| {
            vec![
                h.id as f32,
                h.kind as f32,
                h.team as f32,
                h.player as f32,
                h.px,
                h.pz,
                h.y,
                h.vx,
                h.vy,
                h.fwd_speed,
                h.yaw,
                h.steer_in,
                h.throttle_in,
                f32::from(h.pre_poisoned),
            ]
        })
    }

    // ---------------------------------------------------------------- pointers
    pub fn vehicles_ptr(&self) -> *const f32 {
        self.world.vviews.as_ptr() as *const f32
    }
    pub fn vehicles_len(&self) -> usize {
        self.world.vviews.len()
    }
    pub fn projectiles_ptr(&self) -> *const f32 {
        self.world.pviews.as_ptr() as *const f32
    }
    pub fn projectiles_len(&self) -> usize {
        self.world.pviews.len()
    }
    pub fn mines_ptr(&self) -> *const f32 {
        self.world.mviews.as_ptr() as *const f32
    }
    pub fn mines_len(&self) -> usize {
        self.world.mviews.len()
    }
    pub fn turrets_ptr(&self) -> *const f32 {
        self.world.tviews.as_ptr() as *const f32
    }
    pub fn turrets_len(&self) -> usize {
        self.world.tviews.len()
    }
    pub fn flags_ptr(&self) -> *const f32 {
        self.world.fviews.as_ptr() as *const f32
    }
    pub fn structures_ptr(&self) -> *const f32 {
        self.world.map.structures.as_ptr() as *const f32
    }
    pub fn structures_len(&self) -> usize {
        self.world.map.structures.len()
    }
    pub fn heights_ptr(&self) -> *const f32 {
        self.world.map.heights.as_ptr() as *const f32
    }
    pub fn splat_ptr(&self) -> *const u8 {
        self.world.map.splat.as_ptr()
    }
    pub fn road_ptr(&self) -> *const u8 {
        self.world.map.road.as_ptr()
    }
    /// Which sand each vertex's sand weight is (0 dune / 1 grit / 2 coral).
    pub fn sand_var_ptr(&self) -> *const u8 {
        self.world.map.sand_var.as_ptr()
    }
    /// Which grass each vertex's grass weight is (0 lush / 1 scrub / 2 dry).
    pub fn grass_var_ptr(&self) -> *const u8 {
        self.world.map.grass_var.as_ptr()
    }
    /// Pavement shape per vertex (0 plain / 1 slabs / 2 strip along x / 3 strip along z).
    pub fn pave_ptr(&self) -> *const u8 {
        self.world.map.pave.as_ptr()
    }
    pub fn nav_ptr(&self) -> *const u8 {
        self.world.map.nav.as_ptr()
    }
    pub fn events_ptr(&self) -> *const f32 {
        self.events.as_ptr() as *const f32
    }
    pub fn events_len(&self) -> usize {
        self.events.len()
    }
    pub fn hud_ptr(&self) -> *const f32 {
        self.world.player_hud.as_ptr() as *const f32
    }
    pub fn team_hud_ptr(&self) -> *const f32 {
        self.world.team_hud.as_ptr() as *const f32
    }

    // ------------------------------------------------------------------ scalars
    pub fn time(&self) -> f32 {
        self.world.time
    }
    pub fn tick(&self) -> u32 {
        self.world.tick
    }
    pub fn world_size(&self) -> f32 {
        self.world.map.world_size
    }
    pub fn grid(&self) -> u32 {
        self.world.map.grid
    }
    pub fn water_level(&self) -> f32 {
        self.world.map.water_level
    }
    pub fn map_name(&self) -> String {
        self.world.map.name.clone()
    }
    /// The raw map index this world was generated from (as passed to `new`/`restart`, not
    /// wrapped). The JS side compares it with its own selection to detect a stale sim —
    /// e.g. the title screen changed the map after boot, so `start` must rebuild the world.
    pub fn map_index(&self) -> u32 {
        self.map_index
    }
    /// The generator mode this world was built with (`0` classic, `1` mirror).
    pub fn map_mode(&self) -> u32 {
        self.map_mode
    }
    /// The battlefield size this world was built with (`0` small, `1` medium, `2` big).
    pub fn map_size(&self) -> u32 {
        self.map_size
    }
    /// Display names for the sizes, index-aligned with [`Self::map_size`] values.
    pub fn map_size_names_json() -> String {
        let names: Vec<String> = [crate::types::MapSize::Small, crate::types::MapSize::Medium, crate::types::MapSize::Big]
            .iter()
            .map(|s| format!("\"{}\"", s.name()))
            .collect();
        format!("[{}]", names.join(","))
    }
    pub fn map_count() -> u32 {
        mapgen::map_names().len() as u32
    }
    /// Display names for the generator modes, index-aligned with [`Self::map_mode`] values.
    pub fn map_mode_names_json() -> String {
        let names: Vec<String> = [mapgen::MapMode::Classic, mapgen::MapMode::Mirror]
            .iter()
            .map(|m| format!("\"{}\"", m.name()))
            .collect();
        format!("[{}]", names.join(","))
    }
    pub fn map_names_json() -> String {
        let names: Vec<String> = mapgen::map_names()
            .iter()
            .map(|n| format!("\"{}\"", n))
            .collect();
        format!("[{}]", names.join(","))
    }
    pub fn state(&self) -> f32 {
        self.world.state
    }
    pub fn round_winner(&self) -> i32 {
        self.world.round_winner
    }
    pub fn score(&self, team: usize) -> f32 {
        *self.world.score.get(team).unwrap_or(&0.0)
    }
    pub fn rounds_to_win(&self) -> f32 {
        self.world.rounds
    }
    pub fn round_time_left(&self) -> f32 {
        self.world.round_over_t
    }
    pub fn terrain_rev(&self) -> u32 {
        self.world.terrain_rev
    }
    pub fn state_version() -> u32 {
        STATE_VERSION
    }
    /// Vehicle / weapon tuning for the garage UI (JSON, built once).
    pub fn specs_json(&self) -> String {
        self.specs_json.clone()
    }

    /// Debug helper: build a full world (used by the native sanity tests).
    pub fn build_world(seed: u32, index: u32) -> f32 {
        let mut map = mapgen::generate(seed, index);
        normalize_map(&mut map);
        let _ = World::new_with_map(seed, map, [0, -1]);
        0.0
    }
}

fn build_specs_json() -> String {
    use spec::{vehicle, VehicleSpec, WeaponSpec};
    fn wk(w: &WeaponSpec) -> String {
        format!(
            "{{\"name\":\"{}\",\"damage\":{},\"splash\":{},\"cooldown\":{},\"ammo\":0,\"kind\":{},\"range\":{},\"homing\":{},\"lobbed\":{},\"muzzleUp\":{}}}",
            w.name, w.damage, w.splash, w.cooldown, w.pkind, w.range, w.homing, w.lobbed, w.muzzle_up
        )
    }
    fn vk(v: &VehicleSpec) -> String {
        format!(
            "{{\"kind\":{},\"name\":\"{}\",\"hp\":{},\"speed\":{},\"accel\":{},\"fuel\":{},\"ammo0\":{},\"ammo1\":{},\"mines\":{},\"build\":{},\"flag\":{},\"flying\":{},\"amphibious\":{},\"length\":{},\"width\":{},\"height\":{},\"sight\":{},\"w0\":{},\"w1\":{}}}",
            v.kind,
            v.name,
            v.hp,
            v.speed,
            v.accel,
            v.fuel_time,
            v.ammo0_max,
            v.ammo1_max,
            v.mine_max,
            v.build_time,
            v.can_carry_flag,
            v.flying,
            v.amphibious,
            v.length,
            v.width,
            v.height,
            v.sight,
            wk(&v.weapon0),
            wk(&v.weapon1)
        )
    }
    format!(
        "[{},{},{},{}]",
        vk(&vehicle::JEEP),
        vk(&vehicle::TANK),
        vk(&vehicle::HRSV),
        vk(&vehicle::HELI)
    )
}

// ---------------------------------------------------------------------------
// Map editor
// ---------------------------------------------------------------------------

/// The map editor, as the web app sees it.
///
/// The same shape as [`Game`]: the wasm side owns the map and the browser reads its layers
/// through pointers. The difference is that this one is *writable* — the editor paints the
/// heightfield, the ground weights, the pavement and the structures, and asks for the derived
/// nav grid to be rebuilt at the end of each stroke.
#[wasm_bindgen]
pub struct Editor {
    inner: editor::EditorMap,
    /// The editor's clipboard, held here rather than in JS: it is a rectangle of layer bytes and a
    /// structure list, which is exactly the shape Rust already has.
    clip: Option<editor::Clipboard>,
}

#[wasm_bindgen]
impl Editor {
    /// A fresh battlefield from a seed: `mode` 0 = classic, 1 = mirror; `size` 0 = small.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, index: u32, mode: u32, size: u32) -> Editor {
        let mode = match mode {
            1 => mapgen::MapMode::Mirror,
            _ => mapgen::MapMode::Classic,
        };
        let size = match size {
            1 => types::MapSize::Medium,
            2 => types::MapSize::Big,
            _ => types::MapSize::Small,
        };
        Editor {
            inner: editor::EditorMap::new(seed, index, mode, size),
            clip: None,
        }
    }

    /// Reopen a `.rfmap`.
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<Editor, JsValue> {
        editor::EditorMap::from_bytes(bytes)
            .map(|inner| Editor { inner, clip: None })
            .map_err(|e| JsValue::from_str(&e))
    }

    /// Serialise to the `.rfmap` format.
    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.inner.to_bytes()
    }

    // -- what the renderer needs ------------------------------------------

    pub fn world_size(&self) -> f32 {
        self.inner.map().world_size
    }
    pub fn grid(&self) -> u32 {
        self.inner.map().grid
    }
    pub fn cell(&self) -> f32 {
        self.inner.map().cell
    }
    pub fn water_level(&self) -> f32 {
        self.inner.map().water_level
    }
    pub fn map_name(&self) -> String {
        self.inner.map().name.clone()
    }
    pub fn seed(&self) -> u32 {
        self.inner.seed()
    }
    pub fn mode(&self) -> u32 {
        self.inner.mode() as u32
    }
    pub fn size_index(&self) -> u32 {
        self.inner.size() as u32
    }
    pub fn structure_count(&self) -> u32 {
        self.inner.map().structures.len() as u32
    }
    /// Base anchor (what the base-start tool sets), for the overlay's crosshair.
    pub fn base_x(&self, team: u32) -> f32 {
        self.inner.base(team as usize).0.x
    }
    pub fn base_z(&self, team: u32) -> f32 {
        self.inner.base(team as usize).0.y
    }
    pub fn base_yaw(&self, team: u32) -> f32 {
        let f = self.inner.base(team as usize).1;
        f.y.atan2(f.x)
    }

    pub fn heights_ptr(&self) -> *const f32 {
        self.inner.map().heights.as_ptr()
    }
    pub fn splat_ptr(&self) -> *const u8 {
        self.inner.map().splat.as_ptr()
    }
    pub fn road_ptr(&self) -> *const u8 {
        self.inner.map().road.as_ptr()
    }
    pub fn sand_var_ptr(&self) -> *const u8 {
        self.inner.map().sand_var.as_ptr()
    }
    pub fn grass_var_ptr(&self) -> *const u8 {
        self.inner.map().grass_var.as_ptr()
    }
    pub fn pave_ptr(&self) -> *const u8 {
        self.inner.map().pave.as_ptr()
    }
    pub fn nav_ptr(&self) -> *const u8 {
        self.inner.map().nav.as_ptr()
    }
    pub fn structures_ptr(&self) -> *const f32 {
        self.inner.map().structures.as_ptr() as *const f32
    }

    /// The palette: kind, name and size of everything the editor can place, as JSON.
    pub fn catalog_json() -> String {
        let mut out = String::from("[");
        for (i, c) in editor::CATALOG.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"kind\":{},\"name\":\"{}\",\"w\":{},\"d\":{},\"h\":{}}}",
                c.kind, c.name, c.w, c.d, c.h
            ));
        }
        out.push(']');
        out
    }

    // -- strokes ----------------------------------------------------------

    /// Open an undo step. Everything until `end_stroke` is one step.
    #[wasm_bindgen(js_name = beginStroke)]
    pub fn begin_stroke(&mut self, label: &str) {
        self.inner.begin_stroke(label);
    }
    /// Close the step and refresh the derived nav grid.
    #[wasm_bindgen(js_name = endStroke)]
    pub fn end_stroke(&mut self) {
        self.inner.end_stroke();
    }

    // -- terrain and paint -------------------------------------------------

    pub fn raise(&mut self, x: f32, z: f32, radius: f32, amount: f32, hard: f32) {
        self.inner.raise(x, z, radius, amount, hard);
    }
    /// Paint the ground towards a target height: below the waterline carves sea, above it raises
    /// land, and a flat target makes a pad.
    pub fn level(&mut self, x: f32, z: f32, radius: f32, target: f32, amount: f32, hard: f32) {
        self.inner.level(x, z, radius, target, amount, hard);
    }
    pub fn smooth(&mut self, x: f32, z: f32, radius: f32, amount: f32, hard: f32) {
        self.inner.smooth(x, z, radius, amount, hard);
    }
    /// `channel`: 0 sand, 1 dirt, 2 rock, 3 grass.
    #[wasm_bindgen(js_name = paintSplat)]
    pub fn paint_splat(&mut self, channel: u32, x: f32, z: f32, radius: f32, amount: f32, hard: f32) {
        self.inner.paint_splat(channel as usize, x, z, radius, amount, hard);
    }
    /// `family`: 0 sand, 1 grass; `variant`: 0..2 along that ramp.
    #[wasm_bindgen(js_name = paintVariant)]
    pub fn paint_variant(
        &mut self,
        family: u32,
        variant: u32,
        x: f32,
        z: f32,
        radius: f32,
        amount: f32,
        hard: f32,
    ) {
        self.inner
            .paint_variant(family as usize, variant as u8, x, z, radius, amount, hard);
    }
    /// `level` 0..255 of pavement, `pave` 0 plain / 1 slabs / 2 strip along x / 3 along z.
    #[wasm_bindgen(js_name = paintPave)]
    pub fn paint_pave(&mut self, x: f32, z: f32, radius: f32, level: u32, pave: u32, amount: f32, hard: f32) {
        self.inner
            .paint_pave(x, z, radius, level as u8, pave as u8, amount, hard);
    }
    /// Lay pavement along a polyline (`[x, z, x, z, ...]`).
    #[wasm_bindgen(js_name = roadStroke)]
    pub fn road_stroke(&mut self, pts: &[f32], half_width: f32, pave: u32, erase: bool) {
        self.inner.road_stroke(pts, half_width, pave as u8, erase);
    }

    // -- structures --------------------------------------------------------

    /// Place a structure. `snap` aligns walls to the nearest existing wall's lattice.
    pub fn place(&mut self, kind: u32, team: u32, x: f32, z: f32, yaw: f32, snap: bool) -> bool {
        self.inner.place(kind as u8, team as u8, x, z, yaw, snap)
    }

    /// Where a placement would land after snapping: `[x, z, yaw]`, for the editor's ghost.
    pub fn preview(&self, kind: u32, x: f32, z: f32, yaw: f32, snap: bool) -> Vec<f32> {
        let (p, a) = self.inner.preview(kind as u8, x, z, yaw, snap);
        vec![p.x, p.y, a]
    }

    /// Can this structure stand here? `0` yes, otherwise why not — the ghost's tint, and what a
    /// checked placement refuses on. Returns `[block, seat height]`.
    #[wasm_bindgen(js_name = canPlace)]
    pub fn can_place(&self, kind: u32, x: f32, z: f32, yaw: f32) -> Vec<f32> {
        match self.inner.can_place(kind as u8, x, z, yaw) {
            Ok(y) => vec![0.0, y],
            Err(b) => vec![b as u32 as f32, 0.0],
        }
    }

    /// Place only if the spot is good: returns 0 on success, otherwise the block reason. The editor
    /// uses this for everything the player places by hand, so an occupied spot is refused rather
    /// than silently written over.
    #[wasm_bindgen(js_name = placeChecked)]
    pub fn place_checked(&mut self, kind: u32, team: u32, x: f32, z: f32, yaw: f32, snap: bool) -> u32 {
        self.inner.place_checked(kind as u8, team as u8, x, z, yaw, snap) as u32
    }

    /// Move a team's base to a point: the old complex comes out first, and both bases are rebuilt
    /// so their perimeters stay in step. Does nothing for a team that cannot own a base.
    #[wasm_bindgen(js_name = moveBase)]
    pub fn move_base(&mut self, team: u32, x: f32, z: f32, yaw: f32) {
        self.inner.move_base(team as usize, x, z, yaw);
    }

    /// A team's base anchor, as `[x, z]`.
    #[wasm_bindgen(js_name = basePos)]
    pub fn base_pos(&self, team: u32) -> Vec<f32> {
        let (anchor, _) = self.inner.base(team.min(1) as usize);
        vec![anchor.x, anchor.y]
    }

    /// May this team own a main base? The two playing teams only; neutral is scenery.
    #[wasm_bindgen(js_name = teamCanOwnBase)]
    pub fn team_can_own_base(team: u32) -> bool {
        editor::team_can_own_base(team as u8)
    }

    /// The structure under a point, or -1. What the select tool picks up.
    pub fn pick(&self, x: f32, z: f32) -> i32 {
        self.inner.pick(x, z)
    }

    /// One structure's `[x, z, yaw, w, d, h, kind, team]`, or an empty vec for a stale index.
    #[wasm_bindgen(js_name = structureAt)]
    pub fn structure_at(&self, index: i32) -> Vec<f32> {
        match self.inner.structure_at(index) {
            Some(v) => v.to_vec(),
            None => Vec::new(),
        }
    }

    /// Move a structure: 0 on success, otherwise why not.
    #[wasm_bindgen(js_name = moveStructure)]
    pub fn move_structure(&mut self, index: i32, x: f32, z: f32, yaw: f32) -> u32 {
        self.inner.move_structure(index, x, z, yaw) as u32
    }

    /// Turn a structure a quarter turn in place: 0 on success.
    #[wasm_bindgen(js_name = rotateStructure)]
    pub fn rotate_structure(&mut self, index: i32, quarter: i32) -> u32 {
        self.inner.rotate_structure(index, quarter) as u32
    }

    /// Scatter scenery through the brush: returns how many props it placed.
    pub fn scatter(&mut self, group: u32, x: f32, z: f32, radius: f32, density: f32, seed: u32) -> u32 {
        self.inner.scatter(group as usize, x, z, radius, density, seed)
    }

    /// Copy a rectangle of the map into the editor's clipboard. Returns how many structures it
    /// carries.
    #[wasm_bindgen(js_name = copyRect)]
    pub fn copy_rect(&mut self, x0: f32, z0: f32, x1: f32, z1: f32, cx: f32, cz: f32) -> u32 {
        let clip = self.inner.copy_rect(x0, z0, x1, z1, math::v2(cx, cz));
        let n = clip.len() as u32;
        self.clip = Some(clip);
        n
    }

    /// Debug: `[paved cells, first paved x, first paved z, its value]` in the clipboard.
    #[wasm_bindgen(js_name = clipInfo)]
    pub fn clip_info(&self) -> Vec<f32> {
        match &self.clip {
            Some(c) => {
                let f = c.first_paved();
                vec![c.paved_cells() as f32, f[0], f[1], f[2]]
            }
            None => vec![],
        }
    }

    /// Is there anything to paste?
    #[wasm_bindgen(js_name = hasClip)]
    pub fn has_clip(&self) -> bool {
        self.clip.as_ref().map(|c| !c.is_empty()).unwrap_or(false)
    }

    /// Paste the clipboard with its top-left corner at (x, z). Returns how many structures landed.
    #[wasm_bindgen(js_name = pasteRect)]
    pub fn paste_rect(&mut self, x: f32, z: f32) -> u32 {
        match self.clip.clone() {
            Some(c) => self.inner.paste_rect(&c, x, z),
            None => 0,
        }
    }

    /// Scatter group names, for the palette.
    #[wasm_bindgen(js_name = scatterNames)]
    pub fn scatter_names(&self) -> String {
        let names: Vec<String> = (0..crate::editor::EditorMap::scatter_count())
            .map(|i| crate::editor::EditorMap::scatter_name(i).to_string())
            .collect();
        format!("[{}]", names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(","))
    }

    /// Paint a whole ground material in one dab: family 0 sand, 1 grass, 2 dirt, 3 rock, with the
    /// ramp variant for sand and grass.
    #[wasm_bindgen(js_name = paintMaterial)]
    pub fn paint_material(&mut self, family: u32, variant: u32, x: f32, z: f32, radius: f32, amount: f32, hard: f32) {
        self.inner
            .paint_material(family as usize, variant as u8, x, z, radius, amount, hard);
    }
    /// Remove what the brush covers: pavement (`pavement`), structures (`structures`), or both.
    pub fn erase(&mut self, x: f32, z: f32, radius: f32, pavement: bool, structures: bool) -> u32 {
        self.inner.erase(x, z, radius, pavement, structures)
    }
    #[wasm_bindgen(js_name = setBase)]
    pub fn set_base(&mut self, team: u32, x: f32, z: f32, yaw: f32) {
        self.inner.set_base(team as usize, x, z, yaw);
    }
    #[wasm_bindgen(js_name = stampBase)]
    pub fn stamp_base(&mut self, team: u32, x: f32, z: f32, yaw: f32) {
        self.inner.stamp_base(team as usize, x, z, yaw);
    }

    // -- history and derived data ------------------------------------------

    pub fn undo(&mut self) -> bool {
        self.inner.undo()
    }
    pub fn redo(&mut self) -> bool {
        self.inner.redo()
    }
    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.inner.can_undo()
    }
    #[wasm_bindgen(js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.inner.can_redo()
    }
    #[wasm_bindgen(js_name = historyLen)]
    pub fn history_len(&self) -> u32 {
        self.inner.history_len()
    }
    #[wasm_bindgen(js_name = undoLabel)]
    pub fn undo_label(&self) -> String {
        self.inner.undo_label()
    }
    #[wasm_bindgen(js_name = redoLabel)]
    pub fn redo_label(&self) -> String {
        self.inner.redo_label()
    }
    /// Empty when the map is playable, otherwise the reason (shown in the editor, not enforced).
    pub fn validate(&self) -> String {
        self.inner.validate().err().unwrap_or_default()
    }
    /// Regenerate in place from a new seed, keeping size and mode.
    pub fn reseed(&mut self, seed: u32, index: u32) {
        self.inner.reseed(seed, index);
    }
    /// Rebuild the derived nav grid (after painting layers directly, or on load).
    pub fn rebuild(&mut self) {
        self.inner.rebuild();
    }
}
