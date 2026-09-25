//! Shared data types: map description, structures, and the flat "view" structs that the
//! JavaScript/three.js layer reads straight out of wasm linear memory.
//!
//! IMPORTANT: every `*View` struct is `#[repr(C)]`, f32-only and must stay in sync with
//! `web/src/sim/layout.ts`. Bump `STATE_VERSION` there and here when the layout changes.

use crate::math::{clamp, lerp, Vec2};

/// Simulation tick rate (Hz). The renderer feeds fixed steps of `1.0 / TICK_HZ`.
pub const TICK_HZ: f32 = 60.0;

/// World is a square of this many metres.
///
/// 512 m with the 2 m cell size kept from the original 256 m world: four times the playable
/// area, the same terrain density (so the splat/nav data is not resampled), and a crossing
/// that takes ~25 s instead of ~12 s. The heightfield is 257x257 vertices (264 KiB), the
/// splat texture 257x257 RGBA (264 KiB) and the nav grid 256x256 cells (64 KiB).
///
/// This is the *small* map. Size is a runtime choice ([`MapSize`]); these constants remain the
/// small-map values so code that predates the choice, and the mirrored maps, are unchanged.
pub const WORLD_SIZE: f32 = 512.0;
/// Navigation grid resolution (cells per side). Cell size = WORLD_SIZE / GRID.
pub const GRID: u32 = 256;
/// Height/splat grid resolution (vertices per side).
pub const VERTS: u32 = GRID + 1;
/// Metres per cell/vertex.
pub const CELL: f32 = WORLD_SIZE / GRID as f32;
/// Sea level; terrain below this is water.
pub const WATER_LEVEL: f32 = 0.0;

/// Selectable battlefield size.
///
/// The cell size grows with the world instead of staying at 2 m: holding full detail on a
/// 2048 m map would cost 16x the terrain memory, 16x the generation time and 16x the AI
/// flow-field work per rebuild, and would need a million-vertex render mesh. Scaling the cell
/// keeps the cost profile flat-ish (4x at big, 2.25x at medium) at the price of coarser ground,
/// which is the trade the game asked for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MapSize {
    /// 512 m, 2 m cells — the original world size, and the default.
    Small,
    /// 1024 m, 2.67 m cells.
    Medium,
    /// 2048 m, 4 m cells.
    Big,
}

impl MapSize {
    /// Decode the size as it travels over the wasm boundary (0 = small, 1 = medium, 2 = big).
    pub fn from_u32(v: u32) -> MapSize {
        match v {
            1 => MapSize::Medium,
            2 => MapSize::Big,
            _ => MapSize::Small,
        }
    }

    pub fn as_u32(self) -> u32 {
        match self {
            MapSize::Small => 0,
            MapSize::Medium => 1,
            MapSize::Big => 2,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            MapSize::Small => "small",
            MapSize::Medium => "medium",
            MapSize::Big => "big",
        }
    }

    /// Display name for the menu.
    pub fn label(self) -> &'static str {
        match self {
            MapSize::Small => "SMALL",
            MapSize::Medium => "MEDIUM",
            MapSize::Big => "BIG",
        }
    }

    /// World side in metres.
    pub fn world(self) -> f32 {
        match self {
            MapSize::Small => 512.0,
            MapSize::Medium => 1024.0,
            MapSize::Big => 2048.0,
        }
    }

    /// Cells per side. Chosen so the cell size lands near 2 / 2.8 / 4 m.
    pub fn grid(self) -> u32 {
        match self {
            MapSize::Small => 256,
            MapSize::Medium => 384,
            MapSize::Big => 512,
        }
    }

    /// Vertices per side (cells + 1).
    pub fn verts(self) -> u32 {
        self.grid() + 1
    }

    /// Metres per cell/vertex.
    pub fn cell(self) -> f32 {
        self.world() / self.grid() as f32
    }

    /// The size with this grid resolution, if any. `validate` uses this instead of comparing
    /// against a single compile-time grid, which only ever described the small map.
    pub fn from_grid(grid: u32) -> Option<MapSize> {
        [MapSize::Small, MapSize::Medium, MapSize::Big]
            .into_iter()
            .find(|s| s.grid() == grid)
    }

    /// Occupancy grid resolution used for "may I put this here" tests. Half a cell per bin, so
    /// placement stays precise on a big map without a 4 m bin letting structures overlap.
    pub fn occ(self) -> usize {
        self.grid() as usize * 2
    }
}

/// Bump when the wasm <-> JS ABI changes.
pub const STATE_VERSION: u32 = 2;

// ---------------------------------------------------------------------------
// Terrain classes (nav grid cells)
// ---------------------------------------------------------------------------
pub mod terrain {
    pub const DEEP_WATER: u8 = 0;
    pub const SHALLOW_WATER: u8 = 1;
    pub const SAND: u8 = 2;
    pub const GROUND: u8 = 3;
    pub const ROAD: u8 = 4;
    pub const ROCK: u8 = 5;
    pub const BLOCKED: u8 = 6;

    #[inline]
    pub fn is_water(t: u8) -> bool {
        t <= SHALLOW_WATER
    }
    #[inline]
    pub fn is_land(t: u8) -> bool {
        t >= SAND && t <= ROAD
    }
    #[inline]
    pub fn passable_land(t: u8) -> bool {
        t >= SAND && t <= ROAD
    }
}

// ---------------------------------------------------------------------------
// Structure kinds (must match web/src/sim/layout.ts STRUCT_KIND)
// ---------------------------------------------------------------------------
pub mod skind {
    pub const NONE: u8 = 0;
    pub const GARAGE: u8 = 1;
    pub const FLAG_POLE: u8 = 2;
    pub const FUEL_DEPOT: u8 = 3;
    pub const AMMO_TENT: u8 = 4;
    pub const HELIPAD: u8 = 5;
    pub const RADAR: u8 = 6;
    pub const WALL: u8 = 7;
    pub const BUNKER: u8 = 8;
    pub const BRIDGE: u8 = 9;
    pub const TENT: u8 = 10;
    pub const TURRET_TOWER: u8 = 11;
    pub const PALM: u8 = 12;
    pub const ROCK: u8 = 13;
    pub const BUILDING: u8 = 14;
    pub const CRATE: u8 = 15;
    pub const BARREL: u8 = 16;
    pub const SANDBAG: u8 = 17;
    pub const WATCHTOWER: u8 = 18;
    pub const HANGAR: u8 = 19;
    pub const ANTENNA: u8 = 20;
    pub const WRECK: u8 = 21;
    pub const HQ: u8 = 22;
    pub const GATE: u8 = 23;
    pub const CONTAINER: u8 = 24;
    pub const LIGHTHOUSE: u8 = 25;
}

pub mod sflag {
    /// Structure is destroyed / removed (renderer hides or swaps to rubble).
    pub const DEAD: u32 = 1 << 0;
    /// Acts as a solid collider for vehicles.
    pub const SOLID: u32 = 1 << 1;
    /// Can be damaged by weapons.
    pub const DESTRUCTIBLE: u32 = 1 << 2;
    /// Blocks line of sight for AI/turrets.
    pub const BLOCKS_LOS: u32 = 1 << 3;
    /// Supply point: refuels land vehicles.
    pub const FUEL: u32 = 1 << 4;
    /// Supply point: rearms.
    pub const AMMO: u32 = 1 << 5;
    /// Supply point: repairs.
    pub const REPAIR: u32 = 1 << 6;
    /// Vehicle spawn bay for `team`.
    pub const BAY: u32 = 1 << 7;
    /// Emits light at night / blinking.
    pub const EMISSIVE: u32 = 1 << 8;
    /// Renderer should draw it lying flat on the ground (decals, pads).
    pub const FLAT: u32 = 1 << 9;
    /// Part of a team's main base complex.
    ///
    /// The editor moves a base as **one asset**: it removes the complex and rebuilds it. Marking
    /// the parts is what makes that exact — the blueprint the editor stamps and the perimeter the
    /// generator builds are not the same list of structures, so removing them by position leaves
    /// pieces of the old base standing.
    pub const BASE: u32 = 1 << 10;
}

/// A static or destructible world object. `repr(C)` so the renderer can read it directly.
#[derive(Clone, Copy, Debug)]
#[repr(C)]
pub struct Structure {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub w: f32,
    pub d: f32,
    pub h: f32,
    pub kind: f32,
    pub team: f32,
    pub hp: f32,
    pub hp_max: f32,
    pub flags: f32,
    pub phase: f32,
    pub id: f32,
}

pub const STRUCT_STRIDE: usize = 14;

impl Structure {
    pub fn new(kind: u8, team: u8, pos: Vec2, y: f32, yaw: f32, w: f32, d: f32, h: f32) -> Structure {
        Structure {
            x: pos.x,
            y,
            z: pos.y,
            yaw,
            w,
            d,
            h,
            kind: kind as f32,
            team: team as f32,
            hp: 100.0,
            hp_max: 100.0,
            flags: 0.0,
            phase: 0.0,
            id: 0.0,
        }
    }
    #[inline]
    pub fn pos(&self) -> Vec2 {
        Vec2 {
            x: self.x,
            y: self.z,
        }
    }
    #[inline]
    pub fn flag(&self, f: u32) -> bool {
        (self.flags as u32) & f != 0
    }
    #[inline]
    pub fn set_flag(&mut self, f: u32, on: bool) {
        let mut v = self.flags as u32;
        if on {
            v |= f;
        } else {
            v &= !f;
        }
        self.flags = v as f32;
    }
    #[inline]
    pub fn alive(&self) -> bool {
        !self.flag(sflag::DEAD)
    }
    #[inline]
    pub fn solid(&self) -> bool {
        self.flag(sflag::SOLID) && self.alive()
    }
}

/// Everything the renderer needs to build the map. Generated by `mapgen`, uploaded once.
#[derive(Clone, Debug)]
pub struct MapData {
    pub name: String,
    pub world_size: f32,
    pub grid: u32,
    pub cell: f32,
    /// (grid+1)^2 vertex heights, row-major (z * VERTS + x)
    pub heights: Vec<f32>,
    /// (grid+1)^2 * 4 bytes: [sand, dirt, rock, grass] weights
    pub splat: Vec<u8>,
    /// (grid+1)^2 bytes: asphalt/concrete weight
    pub road: Vec<u8>,
    /// (grid+1)^2 bytes: which sand the `splat` sand weight is — 0 = dune, 1 = grit,
    /// 2 = coral. One index rather than three weights: the renderer lerps between the two
    /// variants either side of it, so a gradual change is still a gradual change of ground,
    /// and the map stays two bytes per vertex instead of eight.
    pub sand_var: Vec<u8>,
    /// (grid+1)^2 bytes: which grass — 0 = lush, 1 = scrub, 2 = dry.
    pub grass_var: Vec<u8>,
    /// (grid+1)^2 bytes: how the `road` mask is surfaced — 0 = plain concrete/asphalt,
    /// 1 = square slabs, 2 = slab strip laid along x, 3 = slab strip laid along z.
    pub pave: Vec<u8>,
    /// grid*grid terrain classes (row-major z * GRID + x)
    pub nav: Vec<u8>,
    pub structures: Vec<Structure>,
    /// Team start pads (0 = green/NATO, 1 = signal red).
    pub spawn: [Vec2; 2],
    pub flag_home: [Vec2; 2],
    /// Each team's main base, as the anchor it was built around and the yaw it was built at.
    ///
    /// The editor moves a base as one asset, which means it has to know where the complex *is*.
    /// Deriving that from the spawn and flag pads is possible in principle and wrong in practice:
    /// measured on the shipped layouts the inference lands 100 m out, so every move left the old
    /// base standing. The generator knows the answer, so it hands it over.
    pub base_anchor: [(Vec2, f32); 2],
    pub water_level: f32,
}

impl MapData {
    #[inline]
    pub fn vert_index(&self, ix: u32, iz: u32) -> usize {
        (iz * (self.grid + 1) + ix) as usize
    }

    /// Bilinear height sample in world space.
    pub fn height_at(&self, x: f32, z: f32) -> f32 {
        let g = self.grid as f32;
        let fx = clamp(x / self.cell, 0.0, g);
        let fz = clamp(z / self.cell, 0.0, g);
        let ix = fx.floor() as u32;
        let iz = fz.floor() as u32;
        let ix1 = (ix + 1).min(self.grid);
        let iz1 = (iz + 1).min(self.grid);
        let tx = fx - ix as f32;
        let tz = fz - iz as f32;
        let h00 = self.heights[self.vert_index(ix, iz)];
        let h10 = self.heights[self.vert_index(ix1, iz)];
        let h01 = self.heights[self.vert_index(ix, iz1)];
        let h11 = self.heights[self.vert_index(ix1, iz1)];
        lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz)
    }

    /// Terrain class at a world position (nearest cell).
    pub fn nav_at(&self, x: f32, z: f32) -> u8 {
        let g = self.grid as i32;
        let cx = clamp((x / self.cell).floor(), 0.0, (g - 1) as f32) as i32;
        let cz = clamp((z / self.cell).floor(), 0.0, (g - 1) as f32) as i32;
        self.nav[(cz * g + cx) as usize]
    }

    pub fn set_nav(&mut self, x: f32, z: f32, v: u8) {
        let g = self.grid as i32;
        let cx = clamp((x / self.cell).floor(), 0.0, (g - 1) as f32) as i32;
        let cz = clamp((z / self.cell).floor(), 0.0, (g - 1) as f32) as i32;
        self.nav[(cz * g + cx) as usize] = v;
    }

    pub fn is_water_at(&self, x: f32, z: f32) -> bool {
        self.height_at(x, z) <= self.water_level
    }

    /// Approximate surface normal, used for vehicle pitch/roll and slope drag.
    pub fn slope_at(&self, x: f32, z: f32) -> Vec2 {
        let d = self.cell;
        let hx = self.height_at(x + d, z) - self.height_at(x - d, z);
        let hz = self.height_at(x, z + d) - self.height_at(x, z - d);
        Vec2 {
            x: hx / (2.0 * d),
            y: hz / (2.0 * d),
        }
    }
}

// ---------------------------------------------------------------------------
// Live entity views (read by the renderer every frame)
// ---------------------------------------------------------------------------

pub mod vkind {
    pub const NONE: u8 = 0;
    pub const JEEP: u8 = 1;
    pub const TANK: u8 = 2;
    pub const HRSV: u8 = 3;
    pub const HELI: u8 = 4;
    pub const TROOP: u8 = 5;
    pub const DRONE: u8 = 6;
    pub const SUBMARINE: u8 = 7;    /// Number of hull kinds including `NONE`, so tuning tables can be indexed by kind.
    pub const COUNT: usize = 8;
    /// Config-file names, in `vkind` order (`vehicles.tank.hp`).
    pub const KEYS: [&str; COUNT] = [
        "none", "jeep", "tank", "hrsv", "heli", "troop", "drone", "submarine",
    ];
}

pub mod vstate {
    /// Parked in the garage, ready to be taken.
    pub const PARKED: f32 = 0.0;
    /// Being driven / active in the world.
    pub const ACTIVE: f32 = 1.0;
    /// Burning wreck (still rendered for a while).
    pub const WRECK: f32 = 2.0;
    /// Under construction at the base (build timer running).
    pub const BUILDING: f32 = 3.0;
}

pub mod vflag {
    pub const CARRYING_FLAG: u32 = 1 << 0;
    pub const IS_PLAYER: u32 = 1 << 1;
    pub const BURNING: u32 = 1 << 2;
    pub const IN_WATER: u32 = 1 << 3;
    pub const DRIVER_BAILED: u32 = 1 << 4; // also the one-shot flag for the bail-out
    pub const RELOADING0: u32 = 1 << 5;
    pub const RELOADING1: u32 = 1 << 6;
    pub const AIRBORNE: u32 = 1 << 7;
    pub const FLAG_IN_RANGE: u32 = 1 << 8;
    /// Jeep dashboard "enemy flag is this way" indicator (0..1 bearing in `gun_pitch`).
    pub const FLAG_RADAR: u32 = 1 << 9;
    pub const HIT_FLASH: u32 = 1 << 10;
    /// Spawn protection is active (renderer draws a shield shimmer).
    pub const SPAWN_GUARD: u32 = 1 << 11;
    /// Currently taking on fuel / ammunition from a depot.
    pub const RESUPPLYING: u32 = 1 << 12;
}

/// One vehicle as seen by the renderer. 27 floats.
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct VehicleView {
    pub id: f32,
    pub kind: f32,
    pub team: f32,
    pub state: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub turret_yaw: f32,
    pub gun_pitch: f32,
    pub speed: f32,
    pub hp: f32,
    pub hp_max: f32,
    pub fuel: f32,
    pub fuel_max: f32,
    pub ammo0: f32,
    pub ammo1: f32,
    pub mines: f32,
    pub anim: f32,
    pub flags: f32,
    pub reload0: f32,
    pub reload1: f32,
    pub build_t: f32,
    /// Nose attitude, radians: positive is nose-DOWN about the hull's own +X axis, matching
    /// three.js `rotateX(+pitch)` (`R_x(a)` tips local +Z towards -Y for a > 0).
    pub pitch: f32,
    /// Roll about the hull's own +X axis, radians, right-handed: positive RAISES the hull's
    /// local +X end, matching three.js `rotateZ(+roll)`. Note `Vec2::perp(fwd)` is the
    /// negated local +X axis, so `physics.rs` negates the terrain gradient it projects there.
    pub roll: f32,
    pub _pad: f32,
    /// Seconds left before a wreck is culled (0 for a live vehicle). The renderer tapers
    /// its soot column with this, so it must not be folded back into the padding.
    pub wreck: f32,
}

pub const VEHICLE_STRIDE: usize = 27;

pub mod pkind {
    pub const NONE: u8 = 0;
    pub const SHELL: u8 = 1;
    pub const GRENADE: u8 = 2;
    pub const ROCKET: u8 = 3;
    pub const MISSILE: u8 = 4;
    pub const BULLET: u8 = 5;
    pub const HOMING: u8 = 6;
    pub const BOMB: u8 = 7;
}

#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct ProjectileView {
    pub id: f32,
    pub kind: f32,
    pub team: f32,
    pub owner: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub life: f32,
    pub power: f32,
    pub seed: f32,
    pub _pad: f32,
}

pub const PROJECTILE_STRIDE: usize = 14;

#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct MineView {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub team: f32,
    pub armed: f32,
    pub blink: f32,
    pub id: f32,
    pub _pad: f32,
}

pub const MINE_STRIDE: usize = 8;

/// A missile turret tower's live state (the map structure holds hp/team/dimensions).
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct TurretView {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub team: f32,
    pub alive: f32,
    pub struct_id: f32,
    pub reload: f32,
}

pub const TURRET_STRIDE: usize = 8;

/// A flag's live state.
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct FlagView {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub state: f32,
    pub team: f32,
    pub carrier: f32,
    pub drop_t: f32,
    pub wave: f32,
}

pub const FLAG_STRIDE: usize = 8;

pub mod ekind {
    pub const NONE: u8 = 0;
    pub const EXPLOSION: u8 = 1;
    pub const BIG_EXPLOSION: u8 = 2;
    pub const MUZZLE_FLASH: u8 = 3;
    pub const IMPACT: u8 = 4;
    pub const DUST: u8 = 5;
    pub const WATER_SPLASH: u8 = 6;
    pub const SMOKE_PUFF: u8 = 7;
    pub const TRACER: u8 = 8;
    pub const DEBRIS: u8 = 9;
    pub const SHOCKWAVE: u8 = 10;
    pub const SOUND: u8 = 11;
    pub const NOTIFY: u8 = 12;
    pub const FLAG_TAKEN: u8 = 13;
    pub const FLAG_CAPTURED: u8 = 14;
    pub const VEHICLE_DESTROYED: u8 = 15;
    pub const SKULL: u8 = 16;
    pub const SCORCH: u8 = 17;
}

/// One transient effect / sound cue produced by the simulation this frame.
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct EventView {
    pub kind: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
}

pub const EVENT_STRIDE: usize = 8;

pub mod sfx {
    pub const EXPLOSION_SMALL: f32 = 1.0;
    pub const EXPLOSION_BIG: f32 = 2.0;
    pub const GUN_TANK: f32 = 3.0;
    pub const GUN_CHAIN: f32 = 4.0;
    pub const ROCKET_LAUNCH: f32 = 5.0;
    pub const GRENADE_THROW: f32 = 6.0;
    pub const MINE_DROP: f32 = 7.0;
    pub const MINE_BLAST: f32 = 8.0;
    pub const IMPACT_METAL: f32 = 9.0;
    pub const IMPACT_GROUND: f32 = 10.0;
    pub const IMPACT_WATER: f32 = 11.0;
    pub const ENGINE_START: f32 = 12.0;
    pub const HELI_LOOP: f32 = 13.0;
    pub const FLAG_PICKUP: f32 = 14.0;
    pub const FLAG_CAPTURE: f32 = 15.0;
    pub const ALARM: f32 = 16.0;
    pub const LAUGH: f32 = 17.0;
    pub const DRONE_HUM: f32 = 18.0;
    pub const SUB_LAUNCH: f32 = 19.0;
    pub const RESUPPLY: f32 = 20.0;
    pub const BUILD_DONE: f32 = 21.0;
    pub const TOWER_FIRE: f32 = 22.0;
    pub const BAIL_OUT: f32 = 23.0;
    pub const BRIDGE_COLLAPSE: f32 = 24.0;
}

pub mod notify {
    pub const FLAG_TAKEN: f32 = 1.0;
    pub const FLAG_DROPPED: f32 = 2.0;
    pub const FLAG_CAPTURED: f32 = 3.0;
    pub const FLAG_RETURNED: f32 = 4.0;
    pub const FLAG_EXPOSED: f32 = 5.0;
    pub const VEHICLE_LOST: f32 = 6.0;
    pub const OUT_OF_BOUNDS: f32 = 7.0;
    pub const LOW_FUEL: f32 = 8.0;
    pub const NO_AMMO: f32 = 9.0;
    pub const ROUND_WON: f32 = 10.0;
    pub const ROUND_LOST: f32 = 11.0;
    pub const TOWER_DOWN: f32 = 12.0;
    pub const BRIDGE_DOWN: f32 = 13.0;
    pub const DRONES_IN: f32 = 14.0;
}

/// Per-player HUD block (19 floats each), mirrored out of the sim.
///
/// Counts come with their capacities, and every one of them comes from the sim: the panel used
/// to learn a magazine size from "the fullest it had ever seen" and fall back to a generic 24
/// when no vehicle was live, which left a jeep's sixteen grenades reading two-thirds full for the
/// rest of the match - "the HUD isn't updating correctly".
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct PlayerHud {
    pub vehicle_id: f32,
    pub vehicle_kind: f32,
    pub hp: f32,
    pub hp_max: f32,
    pub fuel: f32,
    pub fuel_max: f32,
    pub ammo0: f32,
    pub ammo0_max: f32,
    pub ammo1: f32,
    pub ammo1_max: f32,
    pub mines: f32,
    pub mine_max: f32,
    pub kills: f32,
    pub deaths: f32,
    pub flags: f32,
    pub respawn_t: f32,
    pub aim_yaw: f32,
    pub bearing_to_flag: f32,
    pub status: f32,
}

pub const HUD_STRIDE: usize = 19;

/// Garage slot availability + build progress for one team (12 floats).
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct TeamHud {
    pub ready_jeep: f32,
    pub ready_tank: f32,
    pub ready_hrsv: f32,
    pub ready_heli: f32,
    pub build_jeep: f32,
    pub build_tank: f32,
    pub build_hrsv: f32,
    pub build_heli: f32,
    pub score: f32,
    pub flag_state: f32,
    pub turrets_alive: f32,
    pub _pad: f32,
}

pub const TEAM_STRIDE: usize = 12;

pub mod flagstate {
    pub const HOME: f32 = 0.0;
    pub const CARRIED: f32 = 1.0;
    pub const DROPPED: f32 = 2.0;
    pub const EXPOSED: f32 = 3.0;
    pub const CAPTURED: f32 = 4.0;
}

pub mod matchstate {
    pub const PLAYING: f32 = 0.0;
    pub const ROUND_OVER: f32 = 1.0;
    pub const MATCH_OVER: f32 = 2.0;
}
