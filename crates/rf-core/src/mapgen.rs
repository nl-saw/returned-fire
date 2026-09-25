//! Procedural battlefield generation.
//!
//! `generate(seed, index)` builds a complete [`MapData`]: a heightfield in metres, a 4-channel
//! splat map, an asphalt mask, a nav grid, the structures, the spawn pads and the flag homes.
//!
//! # How it is built
//!
//! Everything is authored as *team-0 half* primitives - metaballs, capsule landmasses, hills,
//! water carves, crossings, roads and props - which are then mirrored through the world centre
//! `(x, z) -> (WORLD_SIZE - x, WORLD_SIZE - z)`, swapping team 0 <-> team 1. Heights, splat,
//! road and nav are made *bit-exactly* symmetric by evaluating the canonical half of each grid
//! and copying it into the mirrored entry, so both teams always get identical terrain.
//!
//! Connectivity is structural rather than accidental. Every map authors *protected routes*
//! (spawn -> enemy flag): a route is sampled at less than one cell spacing, the containing cell
//! plus its 4-neighbours are stamped `terrain::ROAD`, and those cells are excluded from every
//! structure footprint. Water on a route only ever happens across a bridge deck (also `ROAD`)
//! or a ford (raised to real land), so a land BFS from spawn to the enemy flag cannot fail.
//!
//! # Conventions the renderer / physics must know
//!
//! * `Structure.y` is the **bottom** of the box: it occupies `[y, y + h]`.
//! * `yaw` rotates the footprint counter-clockwise in the `(x, z)` plane: the `w` axis is
//!   `(cos yaw, sin yaw)`, the `d` axis is `(-sin yaw, cos yaw)`. In three.js use
//!   `mesh.rotation.y = -yaw` for a mesh whose local +X is `w` and local +Z is `d`.
//! * A bridge is a run of `skind::BRIDGE` deck pieces (one piece is 15.4 m x 7 m x 0.9 m,
//!   16 m pitch) laid end to end across the channel, `SOLID | DESTRUCTIBLE`, hp 300.
//!   **The drivable surface is `y + h`** (~1.4 m above sea level). The water under and beside
//!   a deck is shallow (-0.45 m), so amphibious vehicles can also ford at the narrows.
//! * `skind::GATE` marks the *opening* in the base wall (an arch frame). It is deliberately
//!   **not** `SOLID` so vehicles drive through it; the wall run leaves an 8 m gap there.
//! * `skind::HELIPAD` and `skind::FLAG_POLE` are `FLAT` and not `SOLID`: they never block nav.
//! * Unused kinds: `skind::HANGAR` and `skind::NONE` never appear. `skind::SANDBAG` is used
//!   only as cover around the base bunkers.
//! * The base apron (44 m radius) is painted at road value 250, so it is all `ROAD` in nav;
//!   structures inside it are still blocked, precisely, by their oriented footprints.

use crate::math::{clamp, lerp, smoothstep, v2, Noise, Rng, Vec2};
use crate::types::{skind, sflag, terrain, MapData, MapSize, Structure};
use core::f32::consts::{FRAC_PI_2, FRAC_PI_4, PI};


/// The four plans below are authored on the original 256 m design grid: `self.map_scale` maps them
/// onto the shipping [`WORLD_SIZE`]. Land radii additionally grow with `LAND_GROWTH`, because
/// scaling positions and radii by the same factor just makes the same island four times
/// bigger and leaves exactly as much empty ocean around it — the complaint this scale-up
/// exists to answer. Water features grow with `WATER_GROWTH` so a channel is never pinched
/// shut by the land growing into it, and roads widen slightly so they still read as roads.
const DESIGN_SIZE: f32 = 256.0;
const LAND_GROWTH: f32 = 1.30;
const WATER_GROWTH: f32 = 0.85;
const ROAD_GROWTH: f32 = 1.25;
/// Hill peaks are trimmed when their radii grow, so the relief stays inside the same height
/// budget instead of stacking up where the wider hills overlap.
const HILL_PEAK_TRIM: f32 = 0.95;
/// Dry land margin kept around the world edge; the heightfield blends to open water there.
/// Absolute metres, not a fraction: on a bigger world the same rim is a much smaller share of
/// the map (13 m of a 256 m world was 19 % of it in deep water alone).
const EDGE_M: f32 = 10.0;
/// Where the outskirts of the island start, as a fraction of the theatre's half-width from its
/// centre: boulder candidates past this radius ramp up to full weight at the map border.
const SCATTER_EDGE: f32 = 0.45;
/// Clear ground a scattered rock reserves around itself, in metres. Rocks are 2-6 m boulders
/// in a solid, LOS-blocking collision box; packed at the occupancy default they read as one
/// wall of stone rather than as scattered cover.
const SCATTER_SPACING: f32 = 3.0;
/// Height the world edge blends down to (open water, deeper than the shallow class).
const EDGE_DEPTH: f32 = -3.0;

/// Base-local layout constants (x = right of the enemy axis, z = towards the enemy).
const GARAGE_LX: f32 = -6.0;
const GARAGE_LZ: f32 = -11.0;
const GARAGE_W: f32 = 16.0;
const GARAGE_D: f32 = 10.0;
const SPAWN_LX: f32 = -6.0;
const SPAWN_LZ: f32 = -0.5;
const FLAG_LX: f32 = 6.0;
const FLAG_LZ: f32 = 6.0;
pub(crate) const GATE_LX: f32 = -6.0;
/// Half extents of the walled perimeter (these are the wall *centreline* extents).
pub(crate) const BASE_HX: f32 = 24.0;
pub(crate) const BASE_HZ: f32 = 19.0;
/// Perimeter wall cross section, height and the longest single segment.
const WALL_THICK: f32 = 0.9;
const WALL_HALF: f32 = WALL_THICK * 0.5;
const WALL_H: f32 = 2.6;
const WALL_MAX_SEG: f32 = 8.0;
/// How far asphalt is kept away from water, in metres.
///
/// A road that runs along the shoreline, or stops dead at the waterline, reads as pavement
/// floating in the sea. Only a bridge crosses water — on its own deck mesh — so a road that is
/// not feeding a bridge keeps this much dry ground between itself and the water. Bridge
/// abutments are exempt, since the approach road has to reach the deck.
const ROAD_WATER_SETBACK: f32 = 11.0;

/// Nav shoulder blocked by the wall pieces either side of a gateway.
const GATE_SHOULDER: f32 = 1.0;
/// Ground kept clear on either side of the lane from a base's spawn bay to its flag, in metres.
///
/// Measured from the structure's own half extent, so the clear strip is this wide on both sides.
/// A big map's nav grid is 4 m a cell and the flag sits 14 m from the spawn: one 6.5 x 5.5 m
/// bunker on that strip rounds up to a blocked cell and leaves a 4-connected path nowhere to go.
const SPAWN_LANE_CLEAR: f32 = 6.0;
/// A nav cell within this distance of two different solid structures at once is pinched
/// between them: no vehicle fits, so it is blocked instead of tempting the flow field.
const NAV_SQUEEZE: f32 = 2.0;
/// How far a solid footprint is grown before it blocks nav cells.
///
/// A cell is blocked when its *centre* falls inside the grown footprint, so with the old
/// -0.25 m shrink a 0.9 m wall centred on a cell boundary blocked nothing at all: the flow
/// field saw the perimeter as open, drove vehicles straight at it and wedged them there
/// (the AI's gateway problem, and the audit driver giving up 20 m from its spawn on Coral
/// Rim). Half a cell of growth guarantees a thin wall blocks the row of cells it crosses
/// while still leaving a 6.5 m channel through an 8 m gateway.
const NAV_SHOULDER: f32 = 0.75;
/// Width of a gateway opening, and of the gate frame that fills it.
const GATE_OPEN: f32 = 8.0;
const GATE_FRAME: f32 = 7.4;
/// Base-local position of the front gate — the opening in the enemy-facing wall run. Spawned
/// hulls point at its world position so they can drive straight out of the base, and the AI's
/// exit corridor steers at it while a hull is still inside the perimeter.
pub(crate) const GATE_LOCAL: Vec2 = v2(GATE_LX, BASE_HZ);
/// Local x of the rear sally port.
const SALLY_LX: f32 = 9.0;
/// Radius of the fully flattened base pad, and of the soft blend ring outside it.
const PAD_R: f32 = 33.0;
const PAD_BLEND: f32 = 54.0;

/// Flag bits most solid buildings carry.
const B_SOLID: u32 = sflag::SOLID | sflag::DESTRUCTIBLE | sflag::BLOCKS_LOS;
/// Wall / cover bits.
const B_WALL: u32 = sflag::SOLID | sflag::DESTRUCTIBLE | sflag::BLOCKS_LOS;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Human readable map names, index-aligned with [`generate`].
pub fn map_names() -> &'static [&'static str] {
    &["Twin Atolls", "Coral Rim", "Iron Strait", "Shattered Keys"]
}

/// Which generator produces a map.
///
/// `Classic` is the primary, faithful-to-the-original mode: a fully procedural island built
/// from the seed, with no mirror symmetry and both teams placed independently. `Mirror` is
/// the earlier generator, where team 0's half is authored and reflected through the world
/// centre so both teams get byte-identical terrain.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MapMode {
    Classic,
    Mirror,
}

impl MapMode {
    /// Decode the mode as it travels over the wasm boundary (0 = classic, 1 = mirror).
    pub fn from_u32(v: u32) -> MapMode {
        if v == 1 {
            MapMode::Mirror
        } else {
            MapMode::Classic
        }
    }

    pub fn as_u32(self) -> u32 {
        match self {
            MapMode::Classic => 0,
            MapMode::Mirror => 1,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            MapMode::Classic => "classic",
            MapMode::Mirror => "mirror",
        }
    }

    /// Does this mode reflect team 0's half to make team 1?
    pub fn mirrors(self) -> bool {
        self == MapMode::Mirror
    }
}

/// Build the battlefield for `seed` / `index`; `index` wraps modulo [`map_names`].
///
/// Kept at two arguments and mirroring semantics so the existing tests and audits that predate
/// [`MapMode`] still exercise exactly what they did before.
pub fn generate(seed: u32, index: u32) -> MapData {
    generate_mode(seed, index, MapMode::Mirror)
}

/// Build the battlefield for `seed` / `index` in an explicit [`MapMode`].
pub fn generate_mode(seed: u32, index: u32, mode: MapMode) -> MapData {
    generate_sized(seed, index, mode, MapSize::Small)
}

/// Build the battlefield for `seed` / `index` in an explicit [`MapMode`] and [`MapSize`].
pub fn generate_sized(seed: u32, index: u32, mode: MapMode, size: MapSize) -> MapData {
    let idx = (index as usize) % map_names().len();
    let mut g = Gen::new(seed, idx, mode, size);
    g.build();
    g.finish()
}

/// Test seam: [`generate`], plus the set of height vertices
/// [`Gen::grade_protected_lanes`] lifted out of the water. `MapData` carries no such field -
/// the game never needs it - but the invariant it guards (no asphalt on a causeway) is only
/// checkable against it, so the generator hands it to the unit tests directly.
#[cfg(test)]
pub(crate) fn generate_with_lift_mask(seed: u32, index: u32) -> (MapData, Vec<bool>) {
    let idx = (index as usize) % map_names().len();
    let mut g = Gen::new(seed, idx, MapMode::Mirror, MapSize::Small);
    g.build();
    let lifted = g.lifted.clone();
    (g.finish(), lifted)
}

/// Test seam: the plan's road polyline ends *after* `build`, so a test can check that the
/// build-time trim left nothing standing where the asphalt scrub will cut.
#[cfg(test)]
pub(crate) fn generate_with_road_ends(seed: u32, index: u32, mode: MapMode) -> (MapData, Vec<Vec2>) {
    let idx = (index as usize) % map_names().len();
    let mut g = Gen::new(seed, idx, mode, MapSize::Small);
    g.build();
    let mut ends: Vec<Vec2> = Vec::new();
    for rd in g.plan.roads.iter() {
        if let Some(a) = rd.pts.first() {
            ends.push(*a);
        }
        if let Some(b) = rd.pts.last() {
            ends.push(*b);
        }
    }
    (g.finish(), ends)
}

/// Cheap post-condition check used by tests + the game: both bases can reach the enemy flag
/// on foot / over bridge decks, and no solid structure sits on a spawn pad.
pub fn validate(map: &MapData) -> Result<(), String> {
    let world = map.world_size;
    let Some(size) = MapSize::from_grid(map.grid) else {
        return Err(format!("grid is {}, which is not a selectable map size", map.grid));
    };
    if (map.world_size - size.world()).abs() > 0.001 {
        return Err(format!(
            "world size {} does not match grid {} ({} m)",
            map.world_size,
            map.grid,
            size.world()
        ));
    }
    let g = map.grid as usize;
    let v = size.verts() as usize;
    if map.heights.len() != v * v {
        return Err(format!("heights len {} != {}", map.heights.len(), v * v));
    }
    if map.splat.len() != v * v * 4 {
        return Err(format!("splat len {} != {}", map.splat.len(), v * v * 4));
    }
    if map.road.len() != v * v {
        return Err(format!("road len {} != {}", map.road.len(), v * v));
    }
    for (name, len) in [
        ("sand_var", map.sand_var.len()),
        ("grass_var", map.grass_var.len()),
        ("pave", map.pave.len()),
    ] {
        if len != v * v {
            return Err(format!("{name} len {len} != {}", v * v));
        }
    }
    if map.nav.len() != g * g {
        return Err(format!("nav len {} != {}", map.nav.len(), g * g));
    }
    for (i, t) in map.nav.iter().enumerate() {
        if *t > terrain::BLOCKED {
            return Err(format!("nav[{}] = {} is not a terrain class", i, t));
        }
    }
    for team in 0..2 {
        let sp = map.spawn[team];
        let fh = map.flag_home[team];
        for p in [sp, fh] {
            if p.x < 0.0 || p.y < 0.0 || p.x > world || p.y > world {
                return Err(format!("team {} anchor is outside the world", team));
            }
        }
        if map.height_at(sp.x, sp.y) < 0.2 {
            return Err(format!("team {} spawn pad is under water", team));
        }
        if map.height_at(fh.x, fh.y) < 0.2 {
            return Err(format!("team {} flag home is under water", team));
        }
        if !terrain::passable_land(map.nav_at(sp.x, sp.y)) {
            return Err(format!("team {} spawn pad is not drivable", team));
        }
        if !terrain::passable_land(map.nav_at(fh.x, fh.y)) {
            return Err(format!("team {} flag home is not drivable", team));
        }
        if !land_path_exists(map, sp, fh) {
            return Err(format!("team {} cannot reach its own flag", team));
        }
        if !land_path_exists(map, sp, map.flag_home[1 - team]) {
            return Err(format!("team {} cannot reach the enemy flag", team));
        }
    }
    for team in 0..2 {
        let sp = map.spawn[team];
        for s in map.structures.iter() {
            if s.solid() && obb_dist(sp, s) < 3.5 {
                return Err(format!(
                    "team {} spawn pad overlaps structure {}",
                    team, s.id
                ));
            }
        }
    }
    for (i, s) in map.structures.iter().enumerate() {
        if s.id != i as f32 {
            return Err(format!("structure {} has id {}", i, s.id));
        }
        if s.hp_max <= 0.0 || s.hp <= 0.0 {
            return Err(format!("structure {} has no hp", i));
        }
        if !obb_inside_world(s, world) {
            return Err(format!("structure {} sticks out of the world", i));
        }
        if s.kind as u8 == skind::BRIDGE && !(s.flag(sflag::SOLID) && s.flag(sflag::DESTRUCTIBLE)) {
            return Err(format!("bridge deck {} is not solid+destructible", i));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/// Mirror a *world* point through the world centre (swaps the two teams).
fn mir(p: Vec2, w: f32) -> Vec2 {
    v2(w - p.x, w - p.y)
}

/// Mirror an *authored* point through the design-grid centre. The plans are written on the
/// 256 m design grid (see [`DESIGN_SIZE`]) and mirrored there; because a mirror and a uniform
/// scale about the centre commute, scaling afterwards keeps the 180 degree symmetry exact.
fn mir_d(p: Vec2) -> Vec2 {
    v2(DESIGN_SIZE - p.x, DESIGN_SIZE - p.y)
}

#[inline]
fn ctr() -> Vec2 {
    v2(DESIGN_SIZE * 0.5, DESIGN_SIZE * 0.5)
}

/// Distance from `p` to segment `a..b`.
fn seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let l2 = ab.len_sq();
    if l2 < 1e-6 {
        return p.dist(a);
    }
    let t = clamp((p - a).dot(ab) / l2, 0.0, 1.0);
    p.dist(a + ab * t)
}

/// Rotate `p` into the local frame of a box at `c` with `yaw` (w axis = +x, d axis = +z).
pub(crate) fn to_local(p: Vec2, c: Vec2, yaw: f32) -> Vec2 {
    let d = p - c;
    let (s, cs) = yaw.sin_cos();
    v2(d.x * cs + d.y * s, -d.x * s + d.y * cs)
}

pub(crate) fn from_local(l: Vec2, c: Vec2, yaw: f32) -> Vec2 {
    let (s, cs) = yaw.sin_cos();
    c + v2(l.x * cs - l.y * s, l.x * s + l.y * cs)
}

/// Signed distance from a point to a rotated rectangle (negative inside).
pub(crate) fn obb_sd(p: Vec2, c: Vec2, yaw: f32, hw: f32, hd: f32) -> f32 {
    let l = to_local(p, c, yaw);
    let dx = l.x.abs() - hw;
    let dz = l.y.abs() - hd;
    let ox = dx.max(0.0);
    let oz = dz.max(0.0);
    let outside = (ox * ox + oz * oz).sqrt();
    outside + dx.max(dz).min(0.0)
}

/// Distance from a point to a structure footprint (0 when inside).
fn obb_dist(p: Vec2, s: &Structure) -> f32 {
    obb_sd(p, s.pos(), s.yaw, s.w * 0.5, s.d * 0.5).max(0.0)
}

/// True when an intact bridge deck covers `q`.
///
/// The 0.6 m tolerance is exactly `World::bridge_deck`'s, so `cell_passable` and
/// `in_water` cannot disagree about whether a hull at `q` is standing on a deck.
fn deck_covers(bridges: &[Structure], q: Vec2) -> bool {
    bridges.iter().any(|s| s.dist_to(q) <= 0.6)
}

/// Corner points of a structure footprint.
fn obb_corners(s: &Structure) -> [Vec2; 4] {
    let p = s.pos();
    [
        from_local(v2(-s.w * 0.5, -s.d * 0.5), p, s.yaw),
        from_local(v2(s.w * 0.5, -s.d * 0.5), p, s.yaw),
        from_local(v2(s.w * 0.5, s.d * 0.5), p, s.yaw),
        from_local(v2(-s.w * 0.5, s.d * 0.5), p, s.yaw),
    ]
}

fn obb_inside_world(s: &Structure, w: f32) -> bool {
    obb_corners(s)
        .iter()
        .all(|c| c.x >= 0.0 && c.y >= 0.0 && c.x <= w && c.y <= w)
}

// ---------------------------------------------------------------------------
// Height profile
// ---------------------------------------------------------------------------

/// Land profile: mask value -> height in metres. Monotone, C1, sea level at 0.
///
/// The open sea bed is only 2.8 m down and the shelf is wide, so the water between the
/// islands reads as turquoise shallows; the *deep* water on a map comes from the authored
/// channels (`Carve`), which are the only places the sea floor drops away. The old profile
/// fell to -8.5 m within a few metres of the sand, which is what made every map look like one
/// island dropped in an ocean no matter how much land was authored.
fn profile(s: f32) -> f32 {
    let s = clamp(s, 0.0, 1.0);
    let mut h = lerp(-2.8, -0.55, smoothstep(0.03, 0.30, s)); // open sea -> shelf edge
    h = lerp(h, -0.26, smoothstep(0.30, 0.46, s)); // wide turquoise shelf
    h = lerp(h, 0.30, smoothstep(0.46, 0.56, s)); // beach 0.2 .. 1.2 m
    h = lerp(h, 3.1, smoothstep(0.56, 0.96, s)); // inland plain 1.5 .. 6 m
    h
}

// ---------------------------------------------------------------------------
// Plan primitives (authored per map, mirrored automatically)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Feat {
    a: Vec2,
    b: Vec2,
    r: f32,
}

impl Feat {
    fn blob(p: Vec2, r: f32) -> Feat {
        Feat { a: p, b: p, r }
    }
    fn caps(a: Vec2, b: Vec2, r: f32) -> Feat {
        Feat { a, b, r }
    }
    fn mask(&self, p: Vec2) -> f32 {
        let d = seg_dist(p, self.a, self.b) / self.r;
        if d >= 1.0 {
            0.0
        } else {
            1.0 - smoothstep(0.0, 1.0, d)
        }
    }
    fn mirrored(&self) -> Feat {
        Feat {
            a: mir_d(self.a),
            b: mir_d(self.b),
            r: self.r,
        }
    }
    fn self_mir(&self) -> bool {
        self.a.dist(mir_d(self.a)) < 0.75 && self.b.dist(mir_d(self.b)) < 0.75
    }
}

#[derive(Clone, Copy)]
struct Hill {
    a: Vec2,
    b: Vec2,
    r: f32,
    peak: f32,
    /// 0..1: how much of the splat reads as rock.
    rock: f32,
    /// Ridged-multifractal modulation on top of the smooth bump.
    ridge: f32,
}

impl Hill {
    fn peak(p: Vec2, r: f32, peak: f32, rock: f32) -> Hill {
        Hill {
            a: p,
            b: p,
            r,
            peak,
            rock,
            ridge: 0.35,
        }
    }
    fn ridge(a: Vec2, b: Vec2, r: f32, peak: f32, rock: f32, ridge: f32) -> Hill {
        Hill {
            a,
            b,
            r,
            peak,
            rock,
            ridge,
        }
    }
    fn mirrored(&self) -> Hill {
        Hill {
            a: mir_d(self.a),
            b: mir_d(self.b),
            r: self.r,
            peak: self.peak,
            rock: self.rock,
            ridge: self.ridge,
        }
    }
    fn self_mir(&self) -> bool {
        self.a.dist(mir_d(self.a)) < 0.75 && self.b.dist(mir_d(self.b)) < 0.75
    }
}

#[derive(Clone, Copy)]
struct Carve {
    a: Vec2,
    b: Vec2,
    r: f32,
    depth: f32,
}

impl Carve {
    fn line(a: Vec2, b: Vec2, r: f32, depth: f32) -> Carve {
        Carve { a, b, r, depth }
    }
    fn blob(p: Vec2, r: f32, depth: f32) -> Carve {
        Carve { a: p, b: p, r, depth }
    }
    fn mirrored(&self) -> Carve {
        Carve {
            a: mir_d(self.a),
            b: mir_d(self.b),
            r: self.r,
            depth: self.depth,
        }
    }
    fn self_mir(&self) -> bool {
        self.a.dist(mir_d(self.a)) < 0.75 && self.b.dist(mir_d(self.b)) < 0.75
    }
}

#[derive(Clone, Copy, PartialEq)]
enum CrossKind {
    Bridge,
    Ford,
}

#[derive(Clone, Copy)]
struct Cross {
    p: Vec2,
    dir: Vec2,
    kind: CrossKind,
    /// Ford only: half length of the raised sandbar.
    half: f32,
}

impl Cross {
    fn bridge(p: Vec2, dir: Vec2) -> Cross {
        Cross {
            p,
            dir: dir.norm(),
            kind: CrossKind::Bridge,
            half: 0.0,
        }
    }
    fn ford(p: Vec2, dir: Vec2, half: f32) -> Cross {
        Cross {
            p,
            dir: dir.norm(),
            kind: CrossKind::Ford,
            half,
        }
    }
    fn mirrored(&self) -> Cross {
        Cross {
            p: mir_d(self.p),
            dir: -self.dir,
            kind: self.kind,
            half: self.half,
        }
    }
    fn self_mir(&self) -> bool {
        self.p.dist(mir_d(self.p)) < 0.75
    }
}

#[derive(Clone, Copy)]
enum RoadKind {
    /// Wide paved base apron / ring road.
    Paved,
    /// Narrow asphalt road.
    Road,
    /// Dirt track.
    Track,
}

#[derive(Clone)]
struct Road {
    pts: Vec<Vec2>,
    width: f32,
    kind: RoadKind,
}

impl Road {
    fn new(pts: Vec<Vec2>, width: f32, kind: RoadKind) -> Road {
        Road { pts, width, kind }
    }
    fn mirrored(&self) -> Road {
        Road {
            pts: self.pts.iter().map(|p| mir_d(*p)).collect(),
            width: self.width,
            kind: self.kind,
        }
    }
}

#[derive(Clone, Copy)]
struct Prop {
    p: Vec2,
    kind: u8,
    yaw: f32,
    team: u8,
}

/// Base complex: centre, unit vector towards the enemy (the gate faces this way) and owner.
#[derive(Clone, Copy)]
struct BaseDef {
    c: Vec2,
    fwd: Vec2,
    team: u8,
}

impl BaseDef {
    fn loc(&self, lx: f32, lz: f32) -> Vec2 {
        let right = v2(self.fwd.y, -self.fwd.x);
        self.c + right * lx + self.fwd * lz
    }
    /// World yaw for a local yaw (0 = width along the base's right axis).
    fn yaw(&self, la: f32) -> f32 {
        self.fwd.angle() - FRAC_PI_2 + la
    }
    fn mirrored(&self) -> BaseDef {
        BaseDef {
            c: mir_d(self.c),
            fwd: -self.fwd,
            team: 1 - self.team,
        }
    }
}

/// Layout helper for one base complex. All coordinates are base-local: x to the right of the
/// enemy axis, z towards the enemy. `lane` keeps the spawn -> gate driveway clear, `plaza`
/// keeps the flag stand clear, `spawn_lane` reserves the strip between the spawn bay and the flag
/// (0 disables it, for the authored mirror layouts whose bunkers are placed deliberately).
struct BaseCtx {
    bd: BaseDef,
    lane: (f32, f32, f32, f32),
    plaza: (f32, f32),
    spawn_lane: f32,
}

impl BaseCtx {
    /// `mode`: 0 = must be inside the walls, 1 = must be outside them, 2 = anywhere.
    fn fits(&self, lx: f32, lz: f32, w: f32, d: f32, mode: u8) -> bool {
        let hw = w * 0.5;
        let hd = d * 0.5;
        let inside = lx.abs() + hw <= BASE_HX - 0.4 && lz.abs() + hd <= BASE_HZ - 0.4;
        if mode == 0 && !inside {
            return false;
        }
        if mode == 1 && inside {
            return false;
        }
        let (l0, z0, l1, z1) = self.lane;
        if lx + hw > l0 && lx - hw < l1 && lz + hd > z0 && lz - hd < z1 {
            return false;
        }
        let (pl, pz) = self.plaza;
        if (lx - pl).abs() < hw.max(5.0) && (lz - pz).abs() < hd.max(5.0) {
            return false;
        }
        // Spawn pad: nothing solid may sit on it (validate checks this too).
        if (lx - SPAWN_LX).abs() < hw + 4.5 && (lz - SPAWN_LZ).abs() < hd + 4.5 {
            return false;
        }
        // The strip *between* the spawn bay and the flag. The two ends are each kept clear above,
        // and that was not enough: the flag is 14 m from the spawn, a big map's nav grid is 4 m a
        // cell, and a bunker dropped on that strip seals the flag off from the spawn — the one
        // thing `land_path_exists` insists on ("team 0 cannot reach its own flag"). Keep a
        // corridor wide enough that the blocked cell would have somewhere to go.
        if self.spawn_lane > 0.0 {
            let (dx, dz) = (pl - SPAWN_LX, pz - SPAWN_LZ);
            let t =
                (((lx - SPAWN_LX) * dx + (lz - SPAWN_LZ) * dz) / (dx * dx + dz * dz)).clamp(0.0, 1.0);
            let clear = hw.max(hd) + self.spawn_lane;
            if (lx - (SPAWN_LX + dx * t)).hypot(lz - (SPAWN_LZ + dz * t)) < clear {
                return false;
            }
        }
        true
    }
}

/// One navigation route node: a waypoint or a crossing reference.
#[derive(Clone, Copy)]
enum Node {
    P(Vec2),
    X(usize),
}

#[derive(Clone)]
struct Route {
    nodes: Vec<Node>,
}

impl Route {
    fn mirrored(&self) -> Route {
        Route {
            nodes: self
                .nodes
                .iter()
                .map(|n| match n {
                    Node::P(p) => Node::P(mir_d(*p)),
                    Node::X(i) => Node::X(*i),
                })
                .collect(),
        }
    }
    fn self_mir(&self) -> bool {
        self.nodes.iter().all(|n| match n {
            Node::P(p) => p.dist(mir_d(*p)) < 0.75,
            Node::X(_) => false,
        })
    }
}

struct Plan {
    /// Whether primitives added here are automatically mirrored through the world centre.
    ///
    /// The mirrored maps author team 0's half only and rely on this; the procedural
    /// ("classic") maps place both teams explicitly and set it false. Every `feat`/`hill`/
    /// `carve`/`road`/`zone`/`cross`/`route`/`set_bases` below consults it, so a plan cannot
    /// half-mirror by accident.
    mirror: bool,
    feats: Vec<Feat>,
    hills: Vec<Hill>,
    carves: Vec<Carve>,
    crosses: Vec<Cross>,
    cross_mirror: Vec<usize>,
    roads: Vec<Road>,
    props: Vec<Prop>,
    zones: Vec<(Vec2, f32)>,
    /// Explicit grass patches (world point, radius). The splat already grows grass from slope
    /// and height, but that only ever appears on hillsides; these force green ground where the
    /// layout wants a field or a clearing regardless of the terrain's own opinion.
    grass_patches: Vec<(Vec2, f32)>,
    routes: Vec<Route>,
    bases: [BaseDef; 2],
    spawn: [Vec2; 2],
    flag: [Vec2; 2],
    edge: f32,
    palms: u32,
    rocks: u32,
}

impl Plan {
    /// An empty plan. `mirror = true` is the authored-map behaviour: primitives are
    /// duplicated through the world centre and team 1 is the image of team 0.
    fn new() -> Plan {
        Plan::with_mode(true)
    }

    /// Seed variation for the hand-authored mirror plans. The skeleton (bases, roads, routes,
    /// crossings) stays put; the landmasses, hills and carves wander — positions jittered by a
    /// fraction of their own radius, radii scaled — so each seed is a different island that
    /// still reads as its map.
    ///
    /// Mirror pairs are stored consecutively (`Plan::feat`/`hill`/`carve` push the mirror copy
    /// right after the original) and must stay *exact* mirrors of each other: the pipeline
    /// assumes 180 degree symmetry throughout, and `enforce_symmetry` re-copies the canonical
    /// half's heights *after* scatter. An asymmetric plan would leave props on the mirror half
    /// seated against terrain that no longer matches what was there at placement time (measured
    /// up to 0.9 m of float). So each pair is jittered as one: move/scale the original, then
    /// re-derive its partner from it. A self-mirrored primitive keeps its centre — moving it
    /// would break its own symmetry — but still scales. Peaks are not scaled either: the height
    /// budget is tight at both ends (a landmark hill must stay >= 14 m, nothing may pass 30 m).
    fn jitter(&mut self, rng: &mut Rng) {
        let mut i = 0;
        while i < self.feats.len() {
            let single = self.feats[i].self_mir();
            let f = &mut self.feats[i];
            if !single {
                let j = f.r * 0.12;
                f.a = v2(f.a.x + rng.range(-j, j), f.a.y + rng.range(-j, j));
                f.b = v2(f.b.x + rng.range(-j, j), f.b.y + rng.range(-j, j));
            }
            f.r *= rng.range(0.88, 1.15);
            if !single {
                self.feats[i + 1] = f.mirrored();
                i += 2;
            } else {
                i += 1;
            }
        }
        let mut i = 0;
        while i < self.hills.len() {
            let single = self.hills[i].self_mir();
            let h = &mut self.hills[i];
            if !single {
                // Hills add their bumps; two that wander onto each other stack past the 30 m
                // height budget. They therefore wander less than landmasses do.
                let j = h.r * 0.12;
                h.a = v2(h.a.x + rng.range(-j, j), h.a.y + rng.range(-j, j));
                h.b = v2(h.b.x + rng.range(-j, j), h.b.y + rng.range(-j, j));
            }
            h.r *= rng.range(0.85, 1.2);
            if !single {
                self.hills[i + 1] = h.mirrored();
                i += 2;
            } else {
                i += 1;
            }
        }
        let mut i = 0;
        while i < self.carves.len() {
            let single = self.carves[i].self_mir();
            let c = &mut self.carves[i];
            if !single {
                // Carves are the most dangerous primitives to move: a deep pool that wanders
                // onto a route crossing leaves the channel too deep to ford and no bridge is
                // rebuilt there. They wander less than landmasses and never deepen much.
                let j = c.r * 0.08;
                c.a = v2(c.a.x + rng.range(-j, j), c.a.y + rng.range(-j, j));
                c.b = v2(c.b.x + rng.range(-j, j), c.b.y + rng.range(-j, j));
            }
            c.r *= rng.range(0.92, 1.1);
            c.depth *= rng.range(0.9, 1.1);
            if !single {
                self.carves[i + 1] = c.mirrored();
                i += 2;
            } else {
                i += 1;
            }
        }
    }

    /// An empty plan that does not mirror anything: the caller places both teams itself.
    fn unmirrored() -> Plan {
        Plan::with_mode(false)
    }

    fn with_mode(mirror: bool) -> Plan {
        let d = BaseDef {
            c: ctr(),
            fwd: v2(1.0, 0.0),
            team: 0,
        };
        Plan {
            mirror,
            feats: Vec::new(),
            hills: Vec::new(),
            carves: Vec::new(),
            crosses: Vec::new(),
            cross_mirror: Vec::new(),
            roads: Vec::new(),
            props: Vec::new(),
            zones: Vec::new(),
            grass_patches: Vec::new(),
            routes: Vec::new(),
            bases: [d, d.mirrored()],
            spawn: [Vec2::ZERO; 2],
            flag: [Vec2::ZERO; 2],
            edge: 13.0,
            palms: 42,
            rocks: 28,
        }
    }

    /// Delete road branches that dead-end, trimming each back to the last junction.
    ///
    /// Every road is split into straight runs first. A run's end is *attached* where another
    /// run's end touches it (a shared corner or a T-junction), where two runs cross, or at a
    /// protected terminus — the two base gates, where a road is supposed to stop. A run is then
    /// trimmed back to its outermost attachment, and the whole pass repeats because trimming one
    /// run can orphan the next. A run with no attachment at all is removed outright.
    ///
    /// This is what keeps the network honest. The filters that hold streets off water and stop
    /// parallel roads running together leave stubs and slivers behind, and a road that stops in
    /// mid-air reads as a mistake no matter how good the reason was.
    ///
    /// `on_land` answers "would pavement be allowed to stay here?", so the two callers can ask
    /// it of the plan's own estimate (`plan_height` + `WATER_SLACK`, before the island exists)
    /// and of the finished height field plus the asphalt scrub's clearance (just before the
    /// roads are stamped). The second is what keeps a road from being stamped and then cut.
    fn prune_road_dead_ends(&mut self, protect: &[Vec2], on_land: &dyn Fn(Vec2) -> bool) {
        const EPS: f32 = 0.75;

        #[derive(Clone, Copy)]
        struct Run {
            a: Vec2,
            b: Vec2,
            w: f32,
            kind: RoadKind,
        }

        let mut runs: Vec<Run> = Vec::new();
        for r in &self.roads {
            for seg in r.pts.windows(2) {
                if seg[0].dist(seg[1]) > EPS {
                    runs.push(Run {
                        a: seg[0],
                        b: seg[1],
                        w: r.width,
                        kind: r.kind,
                    });
                }
            }
        }
        if runs.is_empty() {
            return;
        }

        for _ in 0..16 {
            let mut changed = false;
            let mut keep: Vec<Run> = Vec::with_capacity(runs.len());
            #[allow(clippy::needless_range_loop)]
            for (i, r) in runs.iter().enumerate() {
                let d = r.a.dist(r.b);
                let dir = (r.b - r.a) / d;
                let perp = v2(-dir.y, dir.x);
                // Where this run is joined by anything else, as a distance along it.
                // Water is a non-attachment. `scrub_lifted_road` clears the asphalt within the
                // setback of water, so a run reaching the shore is cut short whatever we do
                // here; treating the waterline as an end means the branch is pruned back to its
                // last junction instead of being left as a stub that stops in the sea.
                let dry = |t: f32| on_land(r.a + dir * t.clamp(0.0, d));
                let mut land_lo = 0.0f32;
                while land_lo <= d && !dry(land_lo) {
                    land_lo += 4.0;
                }
                let mut land_hi = d;
                while land_hi >= 0.0 && !dry(land_hi) {
                    land_hi -= 4.0;
                }
                if land_hi <= land_lo {
                    changed = true; // entirely off dry ground: nothing to keep
                    continue;
                }
                let mut ts: Vec<f32> = Vec::new();
                let push = |q: Vec2, ts: &mut Vec<f32>| {
                    if (q - r.a).dot(perp).abs() > EPS {
                        return;
                    }
                    let t = (q - r.a).dot(dir);
                    if t > -EPS && t < d + EPS {
                        ts.push(t.clamp(0.0, d));
                    }
                };
                for (j, o) in runs.iter().enumerate() {
                    if i == j {
                        continue;
                    }
                    push(o.a, &mut ts);
                    push(o.b, &mut ts);
                    // Interior crossings: both runs axis-aligned, so this is a simple box test.
                    let ra_h = (r.a.y - r.b.y).abs() < EPS;
                    let oa_h = (o.a.y - o.b.y).abs() < EPS;
                    if ra_h != oa_h {
                        let (h, v) = if ra_h { (r, o) } else { (o, r) };
                        // The horizontal's y within the vertical's span, and the vertical's x
                        // within the horizontal's span.
                        let hy0 = h.a.y;
                        let (hx0, hx1) = (h.a.x.min(h.b.x), h.a.x.max(h.b.x));
                        let (vy0, vy1) = (v.a.y.min(v.b.y), v.a.y.max(v.b.y));
                        let y = hy0;
                        let inside_x = v.a.x >= hx0 - EPS && v.a.x <= hx1 + EPS;
                        let inside_y = y >= vy0 - EPS && y <= vy1 + EPS;
                        if inside_x && inside_y {
                            push(v2(v.a.x, y), &mut ts);
                        }
                    }
                }
                for q in protect {
                    push(*q, &mut ts);
                }
                let prot_a = protect.iter().any(|p| p.dist(r.a) < EPS);
                let prot_b = protect.iter().any(|p| p.dist(r.b) < EPS);
                if ts.is_empty() {
                    if prot_a || prot_b {
                        keep.push(*r); // a base driveway: a road is meant to stop here
                    } else {
                        changed = true; // floating stub
                    }
                    continue;
                }
                let anchored_lo =
                    if prot_a { 0.0 } else { ts.iter().cloned().fold(f32::MAX, f32::min) };
                let anchored_hi =
                    if prot_b { d } else { ts.iter().cloned().fold(f32::MIN, f32::max) };
                // Never keep a stretch that runs into water, even where it is anchored.
                let lo = anchored_lo.max(land_lo);
                let hi = anchored_hi.min(land_hi);
                if lo > EPS || hi < d - EPS {
                    changed = true;
                    if hi - lo <= EPS * 2.0 {
                        continue; // trimmed away entirely
                    }
                    keep.push(Run {
                        a: r.a + dir * lo,
                        b: r.a + dir * hi,
                        w: r.w,
                        kind: r.kind,
                    });
                } else {
                    keep.push(*r);
                }
            }
            runs = keep;
            if !changed {
                break;
            }
        }

        self.roads = runs
            .into_iter()
            .map(|r| Road::new(vec![r.a, r.b], r.w, r.kind))
            .collect();
    }

    fn set_bases(&mut self, b0: BaseDef) {
        let b1 = b0.mirrored();
        self.bases = [b0, b1];
        self.sync_anchors();
    }

    /// Place both bases explicitly (unmirrored plans only). Each keeps its own `team`.
    fn set_bases_pair(&mut self, b0: BaseDef, b1: BaseDef) {
        self.bases = [b0, b1];
        self.sync_anchors();
    }

    fn sync_anchors(&mut self) {
        for t in 0..2 {
            self.spawn[t] = self.bases[t].loc(SPAWN_LX, SPAWN_LZ);
            self.flag[t] = self.bases[t].loc(FLAG_LX, FLAG_LZ);
        }
    }

    fn feat(&mut self, f: Feat) {
        self.feats.push(f);
        if self.mirror && !f.self_mir() {
            self.feats.push(f.mirrored());
        }
    }
    fn hill(&mut self, h: Hill) {
        self.hills.push(h);
        if self.mirror && !h.self_mir() {
            self.hills.push(h.mirrored());
        }
    }
    fn carve(&mut self, c: Carve) {
        self.carves.push(c);
        if self.mirror && !c.self_mir() {
            self.carves.push(c.mirrored());
        }
    }
    fn road(&mut self, r: Road) {
        self.roads.push(r.clone());
        if self.mirror {
            self.roads.push(r.mirrored());
        }
    }
    /// Props are authored once; `Gen::put_sym` mirrors them (so both teams get one) in
    /// mirrored plans, and places them as authored otherwise.
    fn prop(&mut self, p: Prop) {
        self.props.push(p);
    }
    fn zone(&mut self, p: Vec2, r: f32) {
        self.zones.push((p, r));
        if self.mirror && p.dist(mir_d(p)) > 0.75 {
            self.zones.push((mir_d(p), r));
        }
    }
    /// A patch of forced grass, mirrored the same way the other primitives are.
    fn grass(&mut self, p: Vec2, r: f32) {
        self.grass_patches.push((p, r));
        if self.mirror && p.dist(mir_d(p)) > 0.75 {
            self.grass_patches.push((mir_d(p), r));
        }
    }
    /// Register a crossing and its mirror (or just itself when it is on the centre, or when
    /// this plan does not mirror).
    fn cross(&mut self, c: Cross) -> usize {
        let i = self.crosses.len();
        self.crosses.push(c);
        self.cross_mirror.push(i);
        if !self.mirror || c.self_mir() {
            return i;
        }
        let j = self.crosses.len();
        self.crosses.push(c.mirrored());
        self.cross_mirror[i] = j;
        self.cross_mirror.push(i);
        i
    }
    fn route(&mut self, r: Route) {
        if !self.mirror {
            self.routes.push(r);
            return;
        }
        let m = r.mirrored();
        self.routes.push(r);
        if !m.self_mir() {
            self.routes.push(m);
        }
    }

    /// Map an authored (design-grid) plan onto the shipping world.
    ///
    /// Every plan above is written in 256 m coordinates and mirrored through the *design*
    /// centre; because the mirror and a uniform scale about the centre commute, scaling here
    /// (after `plan_map` has authored and mirrored everything) keeps the 180 degree symmetry
    /// exact. Base complexes keep their real-world footprint: only their position scales, so
    /// a garage, a gateway and a wall run are the same size on both worlds.
    fn scale_to_world(&mut self, map_scale: f32, prop_growth: f32) {
        let kp = map_scale;
        let kl = map_scale * LAND_GROWTH;
        let kw = map_scale * WATER_GROWTH;
        let pt = |p: Vec2| v2(p.x * kp, p.y * kp);

        for f in self.feats.iter_mut() {
            f.a = pt(f.a);
            f.b = pt(f.b);
            f.r *= kl;
        }
        for h in self.hills.iter_mut() {
            h.a = pt(h.a);
            h.b = pt(h.b);
            h.r *= kl;
            // Wider hills overlap more where they meet, and overlapping hills sum: without
            // this the same authored peaks stack past the 30 m the terrain tests budget for.
            h.peak *= HILL_PEAK_TRIM;
        }
        for c in self.carves.iter_mut() {
            c.a = pt(c.a);
            c.b = pt(c.b);
            c.r *= kw;
        }
        for c in self.crosses.iter_mut() {
            c.p = pt(c.p);
            c.half *= kw;
        }
        for r in self.roads.iter_mut() {
            for p in r.pts.iter_mut() {
                *p = pt(*p);
            }
            r.width *= ROAD_GROWTH;
        }
        for p in self.props.iter_mut() {
            p.p = pt(p.p);
        }
        for z in self.zones.iter_mut() {
            z.0 = pt(z.0);
        }
        for g in self.grass_patches.iter_mut() {
            g.0 = pt(g.0);
            g.1 *= kl;
        }
        for r in self.routes.iter_mut() {
            for n in r.nodes.iter_mut() {
                if let Node::P(p) = n {
                    *p = pt(*p);
                }
            }
        }
        for b in self.bases.iter_mut() {
            b.c = pt(b.c);
        }
        for t in 0..2 {
            self.spawn[t] = self.bases[t].loc(SPAWN_LX, SPAWN_LZ);
            self.flag[t] = self.bases[t].loc(FLAG_LX, FLAG_LZ);
        }
        self.palms = (self.palms as f32 * prop_growth).round() as u32;
        self.rocks = (self.rocks as f32 * prop_growth).round() as u32;
        self.edge = EDGE_M;
    }
}

// ---------------------------------------------------------------------------
// The four maps
// ---------------------------------------------------------------------------

fn plan_map(idx: usize, p: &mut Plan, size: MapSize, s: u32) {
    match idx {
        0 => plan_twin_atolls(p),
        1 => plan_coral_rim(p),
        2 => plan_iron_strait(p),
        _ => plan_shattered_keys(p),
    }
    // Jitter in *design space*: `mirrored()`/`self_mir()` are anchored to the design grid, so
    // the pair bookkeeping only holds before `scale_to_world`. A dedicated stream: the main
    // `rng` in Gen::new keeps its historical draw order for the downstream pipeline stages.
    let mut jr = Rng::new(s ^ 0x6666_6666);
    p.jitter(&mut jr);
    p.scale_to_world(scale_of(size), growth_of(size));
}

// ---------------------------------------------------------------------------
// The procedural ("classic") maps
// ---------------------------------------------------------------------------
//
// Everything below authors a whole battlefield from the seed instead of a hand-written plan,
// in the same 256 m design space the four maps above use, so `scale_to_world` and the entire
// `Gen::build` pipeline (heights, routes, crossings, nav, props, validation) are reused
// unchanged. Nothing here mirrors: both teams are placed explicitly, so the two halves of the
// island can be as different as the original game's were.
//
// Shape of an island, in order:
//   1. a main landmass spine plus satellites, so the coast is irregular rather than one blob
//   2. a channel or bay carved through it (the water that makes bridges worth having)
//   3. hills, kept off the base pads and town sites
//   4. two bases at opposed points, each with its own randomly chosen enclosure style
//   5. one or more Manhattan street grids with buildings in the blocks
//   6. orthogonal connector roads joining the bases and the grids
//   7. one protected route per team, running gate -> roads -> crossing -> enemy gate
//
// The landmass is authored first, so every later step can reason about where land *is*: the
// generators below place towns and bases against the same geometry that will become terrain.

/// A strictly axis-aligned connector between two points: two 90 degree turns via a split.
fn manhattan_path(a: Vec2, b: Vec2, rng: &mut Rng) -> Vec<Vec2> {
    let f = rng.range(0.35, 0.65);
    if rng.f32() < 0.5 {
        let mx = lerp(a.x, b.x, f);
        vec![a, v2(mx, a.y), v2(mx, b.y), b]
    } else {
        let mz = lerp(a.y, b.y, f);
        vec![a, v2(a.x, mz), v2(b.x, mz), b]
    }
}

/// A `nx` x `nz` block street grid centred on `c`, every segment axis-aligned.
///
/// `c` lands on a grid *intersection* because the line counts are odd, which is what lets the
/// spine be one of these streets: the through-road already runs along `x = c.x` or `y = c.y`, so
/// the coincident grid line is skipped rather than stamped twice. That is how two roads end up
/// next to each other in the same direction — a grid centred a half block off the road that runs
/// through it — and skipping the duplicate is the fix, not filtering afterwards.
///
/// The grid is drawn whole. Dropping individual lines leaves the perpendicular streets with a
/// free end, which is a dead end, and pruning those away deletes the town.
fn town_grid(
    c: Vec2,
    nx: u32,
    nz: u32,
    pitch: f32,
    width: f32,
    spine: &[Vec2],
    p: &mut Plan,
) {
    let hw = nx as f32 * pitch * 0.5;
    let hh = nz as f32 * pitch * 0.5;
    /// A grid line this close to a spine segment is the same street.
    const SAME: f32 = 1.0;
    let coincides = |a: Vec2, b: Vec2| -> bool {
        spine.windows(2).any(|w| {
            let (c0, c1) = (w[0], w[1]);
            let horiz = (a.y - b.y).abs() < 0.01;
            let o_horiz = (c0.y - c1.y).abs() < 0.01;
            if horiz != o_horiz {
                return false;
            }
            if horiz {
                (a.y - c0.y).abs() < SAME
            } else {
                (a.x - c0.x).abs() < SAME
            }
        })
    };
    for i in 0..=nx {
        let x = c.x - hw + i as f32 * pitch;
        let (a, b) = (v2(x, c.y - hh), v2(x, c.y + hh));
        if coincides(a, b) {
            continue;
        }
        p.road(Road::new(vec![a, b], width, RoadKind::Road));
    }
    for j in 0..=nz {
        let z = c.y - hh + j as f32 * pitch;
        let (a, b) = (v2(c.x - hw, z), v2(c.x + hw, z));
        if coincides(a, b) {
            continue;
        }
        p.road(Road::new(vec![a, b], width, RoadKind::Road));
    }
}

/// Buildings in the blocks of a street grid: one structure per block with probability
/// `fill`, plus occasional wrecks and tents for the lived-in look the originals had.
///
/// Blocks are filled on a fixed inset rather than a jittered one. Jitter made the block
/// interiors ragged and the resulting layout read as a mess rather than as a grid.
fn town_blocks(c: Vec2, nx: u32, nz: u32, pitch: f32, fill: f32, team: u8, rng: &mut Rng, p: &mut Plan) {
    let hw = nx as f32 * pitch * 0.5;
    let hh = nz as f32 * pitch * 0.5;
    for i in 0..nx {
        for j in 0..nz {
            if rng.f32() > fill {
                continue;
            }
            let bx = c.x - hw + (i as f32 + 0.5) * pitch;
            let bz = c.y - hh + (j as f32 + 0.5) * pitch;
            let roll = rng.f32();
            let (kind, yaw) = if roll < 0.62 {
                (skind::BUILDING, 0.0)
            } else if roll < 0.78 {
                (skind::TENT, 0.0)
            } else if roll < 0.88 {
                (skind::WRECK, rng.range(0.0, PI))
            } else {
                (skind::ANTENNA, 0.0)
            };
            p.prop(Prop {
                p: v2(bx, bz),
                kind,
                yaw,
                team,
            });
        }
    }
}

/// How well a whole `nx` x `nz` town fits at `c`: the water clearance of its tightest block, or
/// `None` if any block is on water, within the sea's reach, or inside a base pad.
///
/// Every block is checked, not just the centre. The grid is drawn and filled whole, so a block
/// whose ground is water is a missing building and a hole in the street grid, and a block inside a
/// base pad is rejected at placement for the same reason. Each block centre is held to the rule
/// the road itself is routed by — on land by the plan's own height, and clear of water by the
/// terrain's domain warp (`slack` design units, since the warp is applied after the plan).
#[allow(clippy::too_many_arguments)]
fn town_fit_score(
    feats: &[Feat],
    carves: &[Carve],
    c: Vec2,
    nx: u32,
    nz: u32,
    pitch: f32,
    slack: f32,
    pads: &[Vec2],
    pad_zone: f32,
) -> Option<f32> {
    let margin = pitch * 0.5 + slack;
    let mut worst = f32::MAX;
    for i in 0..nx {
        for j in 0..nz {
            let p = v2(
                c.x + (i as f32 + 0.5 - nx as f32 * 0.5) * pitch,
                c.y + (j as f32 + 0.5 - nz as f32 * 0.5) * pitch,
            );
            if plan_height(feats, carves, p) < 0.6 {
                return None;
            }
            let room = water_dist(feats, carves, p, margin + 4.0);
            if room < margin {
                return None;
            }
            worst = worst.min(room);
            if pads.iter().any(|a| a.dist(p) < pad_zone) {
                return None;
            }
        }
    }
    (worst < f32::MAX).then_some(worst)
}

/// A point at fraction `t` (0..1) along a polyline by arc length, with the direction of the
/// segment it lands on.
///
/// Used to hang settlements and crossings off the road: the road is the only thing that knows
/// where it goes, so anything that needs to sit *on* it asks the path rather than picking a
/// position of its own and being joined to the road by a spur.
fn along_path(pts: &[Vec2], t: f32) -> (Vec2, Vec2) {
    let total: f32 = pts.windows(2).map(|w| w[0].dist(w[1])).sum();
    let mut want = total * t.clamp(0.0, 1.0);
    for w in pts.windows(2) {
        let d = w[0].dist(w[1]);
        if d < 1e-3 {
            continue;
        }
        if want <= d {
            let dir = (w[1] - w[0]).norm();
            return (w[0] + dir * want, dir);
        }
        want -= d;
    }
    let last = pts[pts.len().saturating_sub(1)];
    let prev = pts[pts.len().saturating_sub(2)];
    (last, (last - prev).norm())
}

/// Find ground for a settlement: on solid land, clear of the coast by `margin` design units,
/// and away from everything in `avoid`. `None` when no candidate is found, so callers skip it
/// rather than dropping a town into the sea.
#[allow(clippy::too_many_arguments)]
fn inland_site(
    feats: &[Feat],
    carves: &[Carve],
    rng: &mut Rng,
    c: Vec2,
    min_r: f32,
    max_r: f32,
    margin: f32,
    avoid: &[Vec2],
    clear: f32,
) -> Option<Vec2> {
    for _ in 0..160 {
        let ang = rng.range(0.0, core::f32::consts::TAU);
        let q = ring_pt(c, ang, rng.range(min_r, max_r), 14.0, rng);
        if plan_height(feats, carves, q) < 0.6 {
            continue;
        }
        if water_dist(feats, carves, q, margin + 4.0) < margin {
            continue;
        }
        if avoid.iter().any(|a| a.dist(q) < clear) {
            continue;
        }
        return Some(q);
    }
    None
}

/// Pick a point at radius `r` from `c` along `ang`, jittered along both axes.
fn ring_pt(c: Vec2, ang: f32, r: f32, jitter: f32, rng: &mut Rng) -> Vec2 {
    v2(
        c.x + ang.cos() * r + rng.sym() * jitter,
        c.y + ang.sin() * r + rng.sym() * jitter,
    )
}

/// Design-grid (256 m) to world scale for a map size.
fn scale_of(size: MapSize) -> f32 {
    size.world() / DESIGN_SIZE
}

/// Scatter budget: grows with the *area* of a half map (authored once, then mirrored).
fn growth_of(size: MapSize) -> f32 {
    let s = scale_of(size);
    s * s * 0.90
}

/// Linear growth of a battlefield over the small map: 1, 2 or 4.
fn linear_of(size: MapSize) -> f32 {
    scale_of(size) / scale_of(MapSize::Small)
}

/// A length in **metres**, as design units for a map size (the inverse of `scale_of`).
///
/// Anything the plan states in design units is scaled with the island by [`Plan::scale_to_world`].
/// That is right for the island, the hills and the bays, and wrong for anything that describes an
/// *object*: a building is 13 m, a road is 8 m wide and a car is 8 m long on every battlefield, so
/// block pitch, building spacing and reserved corridors have to be written as lengths. Authored
/// in design units they were multiplied by up to 8: the classic town's 26-32 unit pitch became
/// 229 m between streets on a big map, with the same four sheds in it.
fn to_design(metres: f32, size: MapSize) -> f32 {
    metres / scale_of(size)
}

/// City block pitch, in metres: the small map's 26-32 design units, on every battlefield.
///
/// A block has to fit the buildings in it, so it is a length like they are. The draw itself is
/// unchanged from when the pitch was authored in design units (`to_design` divides by 2 on small),
/// so the small map's blocks are the size they always were; what changed is that they no longer
/// grow with the world.
const TOWN_PITCH_M: (f32, f32) = (52.0, 64.0);

/// Blocks across a town, per axis: always the small map's 2 x 2.
const TOWN_BLOCKS: u32 = 2;

/// Towns on the island: one on small, two on medium, four on big.
///
/// A bigger battlefield gets *more* towns spread along the road, not bigger blocks: the island is
/// the thing that grew. They are placed on equal arcs of the spine, which is what keeps them
/// apart without a separation test to tune.
fn town_count(size: MapSize) -> u32 {
    linear_of(size).round().max(1.0) as u32
}

/// Reserved no-build corridor either side of the through road, in metres.
///
/// A structure dropped on the road blocks the nav cell under it, and `route_mask` cannot protect
/// an occupied cell, so the protected lane is severed. As a length it stays a lane: at 7 design
/// units it was a 112 m wide reservation on a big map, which left the whole roadside bare.
const ROAD_CORRIDOR_M: f32 = 14.0;

/// The base pad reservation, in metres. The pad itself is a real-world size (`PAD_BLEND`), so its
/// reserved zone is one too; a town block inside it is rejected at placement and leaves a hole.
const BASE_PAD_ZONE_M: f32 = 56.0;

/// Buildings in one roadside hamlet: spacing, lateral offset and minimum distance between two
/// hamlets, all in metres.
const HAMLET_STEP_M: f32 = 18.0;
const HAMLET_SIDE_M: (f32, f32) = (16.0, 22.0);
const HAMLET_GAP_M: f32 = 92.0;

/// How close two parallel streets may run, in design units.
///
/// This is a *block*, not a lane: the point is that the ground between two parallel roads has to
/// be wide enough to be a block. A small gap (the first attempt used 9 units, ~18 m) still let
/// two roads run 25 m apart with an unusable sliver between them, which is what "two roads close
/// together in the same direction" looks like. The town's own pitch is 26-32 units, so a grid
/// still survives this.
const MIN_ROAD_GAP: f32 = 22.0;

/// Extra clearance kept from water, in design units.
///
/// `plan_height` is the plan's own estimate and has no domain warp, while the generated terrain
/// displaces every sample by up to 15 units before evaluating the mask. A road that clears the
/// estimated waterline by a few units can therefore still be standing in real water once the warp
/// is applied — which is why roads kept reaching the shoreline and being cut there, leaving the
/// stub the prune was supposed to have removed. Everything that holds roads off water adds this.
const WATER_SLACK: f32 = 18.0;

/// How bad a candidate path is: water samples cost 1, a stretch running alongside a road that
/// already exists costs 1000 so it is only ever chosen when there is no alternative.
fn path_cost(feats: &[Feat], carves: &[Carve], pts: &[Vec2], margin: f32, avoid: &[Vec2]) -> u32 {
    let mut bad = 0;
    for w in pts.windows(2) {
        if runs_alongside(w[0], w[1], avoid, MIN_ROAD_GAP) {
            bad += 1000;
        }
        let d = w[0].dist(w[1]);
        let steps = ((d / 7.0).ceil() as u32).max(1);
        for k in 0..=steps {
            let p = w[0] + (w[1] - w[0]) * (k as f32 / steps as f32);
            if plan_height(feats, carves, p) < 0.6
                || water_dist(feats, carves, p, margin + WATER_SLACK + 4.0) < margin + WATER_SLACK
            {
                bad += 1;
            }
        }
    }
    bad
}

/// An orthogonal path between `a` and `b` that stays clear of water and does not run alongside
/// `avoid`, or the best of the candidates if none is perfect. The road is routed to somewhere it
/// can actually go instead of being drawn across a bay and left unconnected.
fn manhattan_on_land(
    feats: &[Feat],
    carves: &[Carve],
    a: Vec2,
    b: Vec2,
    margin: f32,
    avoid: &[Vec2],
    rng: &mut Rng,
) -> Vec<Vec2> {
    let mut best = manhattan_path(a, b, rng);
    let mut best_cost = path_cost(feats, carves, &best, margin, avoid);
    for _ in 0..23 {
        if best_cost == 0 {
            break;
        }
        let cand = manhattan_path(a, b, rng);
        let cost = path_cost(feats, carves, &cand, margin, avoid);
        if cost < best_cost {
            best = cand;
            best_cost = cost;
        }
    }
    best
}

/// True when `a..b` runs parallel to one of `others` within `gap`, and the two overlap along
/// their shared axis — i.e. two roads side by side rather than two roads crossing.
fn runs_alongside(a: Vec2, b: Vec2, others: &[Vec2], gap: f32) -> bool {
    let horiz = (a.y - b.y).abs() < 0.01;
    let vert = (a.x - b.x).abs() < 0.01;
    if !horiz && !vert {
        return false;
    }
    for w in others.windows(2) {
        let (c, d) = (w[0], w[1]);
        if horiz && (c.y - d.y).abs() < 0.01 && (a.y - c.y).abs() < gap {
            let (l0, h0) = (a.x.min(b.x), a.x.max(b.x));
            let (l1, h1) = (c.x.min(d.x), c.x.max(d.x));
            if l0 < h1 && l1 < h0 {
                return true;
            }
        }
        if vert && (c.x - d.x).abs() < 0.01 && (a.x - c.x).abs() < gap {
            let (l0, h0) = (a.y.min(b.y), a.y.max(b.y));
            let (l1, h1) = (c.y.min(d.y), c.y.max(d.y));
            if l0 < h1 && l1 < h0 {
                return true;
            }
        }
    }
    false
}

/// The plan's own land mask, evaluated the way `terrain_at` will combine the land features
/// (the soft-max product) but without hills, noise or carves.
///
/// 1.0 is deep inland, ~0.46 is the beach, 0 is open sea. Authoring code uses this to place
/// towns, grids and bases on ground that will actually be there, instead of placing them and
/// hoping the terrain generator agrees.
fn plan_land(feats: &[Feat], p: Vec2) -> f32 {
    let mut inv = 1.0f32;
    for f in feats {
        inv *= 1.0 - f.mask(p);
    }
    1.0 - inv
}

/// Height the plan implies at `p`, before hills, noise and the domain warp.
///
/// This is `terrain_at`'s water behaviour without the decoration: the land mask through
/// [`profile`], with every carve applied as a `min` exactly as the generator applies them. It
/// exists because the land mask alone cannot see a lake — the bays, the lake and the inlets are
/// *carves*, so authoring code that only tested the mask happily drew roads and towns across
/// open water.
fn plan_height(feats: &[Feat], carves: &[Carve], p: Vec2) -> f32 {
    let mut h = profile(plan_land(feats, p));
    for c in carves {
        let d = seg_dist(p, c.a, c.b) / c.r;
        if d >= 1.0 {
            continue;
        }
        let t = smoothstep(0.35, 1.0, d);
        h = h.min(lerp(c.depth, h, t));
    }
    h
}

/// How far `p` is from water, in design units, marching in 16 directions.
///
/// Water is anything the plan's own height estimate puts at or below the waterline, so this sees
/// the carved lakes and bays as well as the open sea. Approximate by construction: fixed
/// increments, stopping at the first water it meets.
fn water_dist(feats: &[Feat], carves: &[Carve], p: Vec2, max: f32) -> f32 {
    let mut best = max;
    for k in 0..16 {
        let a = k as f32 / 16.0 * core::f32::consts::TAU;
        let d = v2(a.cos(), a.sin());
        let mut t = 0.0f32;
        while t < max {
            t += 4.0;
            if plan_height(feats, carves, p + d * t) < 0.25 {
                break;
            }
        }
        best = best.min(t);
    }
    best
}

/// The procedural island. `idx` selects a stable variant; `seed` drives every random choice.
fn plan_proc(seed: u32, idx: usize, p: &mut Plan, size: MapSize) {
    let mut rng = Rng::new(
        seed.wrapping_mul(0x9E37_79B9)
            ^ (idx as u32).wrapping_mul(0x85EB_CA6B)
            ^ 0x4F1B_BCDA,
    );
    let c = v2(128.0, 128.0);
    // The island's long axis: bases sit at either end of it, so this also sets the
    // direction the two bases face each other along.
    let axis = rng.range(0.0, PI);
    let dir = v2(axis.cos(), axis.sin());
    let side = v2(-dir.y, dir.x);

    // --- 1. landmass ------------------------------------------------------
    // The island is a *wandering chain* of capsules rather than one elongated blob: each
    // segment turns by a random amount and runs a random length, so two seeds produce genuinely
    // different silhouettes. Satellites, peninsulas and inlets then break up the outline
    // further. This is where island variety comes from — a channel cutting the map in half was
    // doing that job before, and it made every island look the same.
    //
    // Radii are design-space and large on purpose: `profile` only calls a point land where the
    // combined mask passes ~0.46, roughly the inner 55 % of a feature's radius, so a feature
    // has to be authored about twice the size of the land it should produce.
    let segs = 3 + rng.below(3); // 3..5
    let mut node = c - dir * rng.range(38.0, 58.0);
    let mut fwd = v2(axis.cos(), axis.sin());
    let mut chain = vec![node];
    for _ in 0..segs {
        let a = fwd.angle() + rng.range(-0.85, 0.85);
        fwd = v2(a.cos(), a.sin());
        node += fwd * rng.range(40.0, 62.0);
        chain.push(node);
    }
    for w in chain.windows(2) {
        p.feat(Feat::caps(w[0], w[1], rng.range(96.0, 118.0)));
    }
    // Blobs at the joints, so the chain reads as one landmass rather than a row of sausages.
    for q in &chain {
        p.feat(Feat::blob(*q, rng.range(82.0, 102.0)));
    }

    let n_sat = 5 + rng.below(3); // 5..7
    for k in 0..n_sat {
        let ang = rng.range(0.0, core::f32::consts::TAU) + k as f32 * 0.7;
        let d = rng.range(52.0, 88.0);
        let r = rng.range(64.0, 92.0);
        p.feat(Feat::blob(ring_pt(c, ang, d, 12.0, &mut rng), r));
    }

    // Peninsulas: short capsules pointing out from a chain node. These are what give an island
    // a recognisable shape (a hook, a spit, a claw) instead of a circle with bumps.
    for _ in 0..(1 + rng.below(3)) {
        let base = chain[rng.below(chain.len() as u32) as usize];
        let a = rng.range(0.0, core::f32::consts::TAU);
        let d = v2(a.cos(), a.sin());
        let len = rng.range(30.0, 62.0);
        p.feat(Feat::caps(base + d * 20.0, base + d * (20.0 + len), rng.range(30.0, 48.0)));
    }

    // Outlying islets, so the silhouette is not a single closed shape.
    for _ in 0..(1 + rng.below(3)) {
        let ang = rng.range(0.0, core::f32::consts::TAU);
        p.feat(Feat::blob(
            ring_pt(c, ang, rng.range(98.0, 120.0), 8.0, &mut rng),
            rng.range(14.0, 26.0),
        ));
    }

    // Inlets: short carves biting in from beyond the coast, so the shoreline gains coves and
    // bays without ever cutting the island in two.
    for _ in 0..(1 + rng.below(3)) {
        let ang = rng.range(0.0, core::f32::consts::TAU);
        let d = v2(ang.cos(), ang.sin());
        let outer = c + d * 132.0;
        let inner = c + d * rng.range(58.0, 88.0);
        p.carve(Carve::line(outer, inner, rng.range(9.0, 15.0), -2.8));
    }

    // --- 2. water ---------------------------------------------------------
    // Only silhouette here: bays, an inlet lake. The channel that splits an island is authored
    // later, across the road (see step 6), so that the bridge lands on the road rather than
    // somewhere beside it.
    // A bay biting into one flank, so the coastline is never a smooth oval.
    p.carve(Carve::blob(
        ring_pt(c, axis + core::f32::consts::FRAC_PI_2, rng.range(40.0, 62.0), 12.0, &mut rng),
        rng.range(15.0, 24.0),
        -2.4,
    ));
    // A second bay on the opposite flank, so the coastline is never a smooth oval. Kept out
    // along the flank (perpendicular to the base-to-base axis) so it bites the coast rather
    // than cutting the corridor the land route uses.
    let perp = |q: Vec2| ((q - c).x * side.x + (q - c).y * side.y).abs();
    p.carve(Carve::blob(
        ring_pt(c, axis - core::f32::consts::FRAC_PI_2, rng.range(48.0, 70.0), 10.0, &mut rng),
        rng.range(12.0, 18.0),
        -2.2,
    ));
    // A lake: pure silhouette, and on an island with no channel it is what keeps the interior
    // from being featureless. Never placed on the corridor between the two bases, or the
    // island would be split by water with no bridge to cross it.
    for _ in 0..6 {
        let q = ring_pt(c, rng.range(0.0, core::f32::consts::TAU), rng.range(30.0, 52.0), 10.0, &mut rng);
        if perp(q) < 40.0 {
            continue;
        }
        p.carve(Carve::blob(q, rng.range(8.0, 13.0), -1.4));
        break;
    }

    // --- 3. hills ---------------------------------------------------------
    // Kept a good distance from the two base anchors (computed below) so a pad is never
    // asked to flatten a mountain, and off the island's middle where the grids go.
    let hills_n = 2 + rng.below(2);
    for _ in 0..hills_n {
        let ang = rng.range(0.0, core::f32::consts::TAU);
        let q = ring_pt(c, ang, rng.range(58.0, 86.0), 8.0, &mut rng);
        if q.dist(c) < 40.0 {
            continue; // keep the centre flat for towns
        }
        let r = rng.range(20.0, 30.0);
        let peak = rng.range(6.0, 13.0);
        let rock = rng.range(0.5, 1.0);
        if rng.f32() < 0.35 {
            let a = ring_pt(c, ang, rng.range(52.0, 74.0), 6.0, &mut rng);
            p.hill(Hill::ridge(a, q, r, peak, rock, rng.range(0.6, 0.95)));
        } else {
            p.hill(Hill::peak(q, r, peak, rock));
        }
    }

    // --- 4. the two bases -------------------------------------------------
    // Snapshot the land and water the plan has authored so far: every placement below — bases,
    // the road, the town, the country buildings — is tested against it, so it has to be taken
    // before any of them.
    let feats = p.feats.clone();
    let carves = p.carves.clone();
    // Opposed across the island, facing each other.
    //
    // The anchor has to be on ground that will still be dry once the carves are applied: the
    // land mask cannot see a bay, so a base placed by the mask alone ended up straddling one
    // with water inside its own walls. The pad is `PAD_BLEND` (54 m) across and the base complex
    // reaches ~30 m from the anchor, so the anchor needs real land around it, not a strip between
    // two inlets — a base squeezed onto one gets walls and gates that never place, and a flag the
    // spawn cannot reach.
    //
    // The search *walks out to the coast first* and then places the base a little inside it. It
    // used to start at a fixed 50-70 units and stop at the first offset with pad room, i.e. as
    // close to the middle as the pad allowed: the two gates came out 57 design units apart on
    // every seed, so the whole road network — and every town on it — was crammed into the middle
    // of the island with the rest of the land empty, and a bigger battlefield only spread that
    // little cluster further apart.
    let pad_room = to_design(64.0, size);
    // Stay this far inside the world box, in design units: the base's spawn and flag pads sit
    // ~25 m off the anchor, and a base pushed against the edge has anchors outside the world.
    let keep = to_design(58.0, size);
    let pick_anchor = |rng: &mut Rng, sign: f32| -> Vec2 {
        let mut edge = 20.0f32;
        for k in 0..120 {
            let r = 20.0 + k as f32 * 2.0;
            if plan_height(&feats, &carves, c + dir * (r * sign)) < 0.6 {
                break;
            }
            edge = r;
        }
        let want = (edge * 0.6).max(30.0);
        let mut best = c;
        let mut best_room = -1.0f32;
        for k in 0..24 {
            // Walk *inwards* from `want + 24`: the base belongs near the island's end, so the
            // first offset from the outside that has pad room is the one to take. Walking outwards
            // instead stops at the first offset with room, which is the innermost one.
            let r = want + 24.0 - k as f32 * 2.0;
            let q = c + dir * (r * sign) + side * rng.range(-10.0, 10.0);
            if q.x < keep || q.y < keep || q.x > DESIGN_SIZE - keep || q.y > DESIGN_SIZE - keep {
                continue;
            }
            if plan_height(&feats, &carves, q) < 0.6 {
                continue;
            }
            let room = water_dist(&feats, &carves, q, pad_room + 4.0);
            if room > best_room {
                best_room = room;
                best = q;
            }
            if room >= pad_room {
                break;
            }
        }
        best
    };
    let anchor0 = pick_anchor(&mut rng, 1.0);
    let anchor1 = pick_anchor(&mut rng, -1.0);
    // `fwd` is the base's "towards the enemy" axis (`loc` uses it for +z).
    let fwd0 = (anchor1 - anchor0).norm();
    let b0 = BaseDef { c: anchor0, fwd: fwd0, team: 0 };
    let b1 = BaseDef { c: anchor1, fwd: -fwd0, team: 1 };
    p.set_bases_pair(b0, b1);
    // Main bases are always fully walled. A `Partial`/`Open` base was tried here and it was a
    // misreading: the "some enclosed, others just roads with buildings" note was about the
    // secondary settlements, not about the two main bases, which are the layouts the AI and the
    // capture flow are tuned against.

    // --- 5. the road, and the settlements on it ---------------------------
    // Exactly one road runs from gate to gate; every other road is a street inside a town grid on
    // it. A bigger battlefield gets more towns along that road, not bigger ones.
    //
    // There are deliberately no connector roads and no free-standing grids. Stamping grids
    // wherever they fit and then joining each one to its nearest neighbour is what produced the
    // roads that "make no sense": lines that led nowhere, spurs that dead-ended, and grids that
    // overlapped each other.
    let pitch = to_design(rng.range(TOWN_PITCH_M.0, TOWN_PITCH_M.1), size);
    let road_w = rng.range(6.0, 7.0);
    let gate0 = b0.loc(GATE_LX, 19.0);
    let gate1 = b1.loc(GATE_LX, 19.0);

    // ONE road runs from gate to gate. The towns sit *on* that road, so there is no second leg
    // to end up alongside the first: two roughly parallel east-west roads through the middle of
    // the map were the two halves of the spine, each routed independently to a town between
    // them.
    let spine = manhattan_on_land(&feats, &carves, gate0, gate1, 6.0, &[], &mut rng);

    // Towns, on equal arcs of the spine so they come out spread along the road rather than bunched
    // where the room happens to be best. A town is the same 2 x 2 grid of the same 57 m blocks on
    // every battlefield; an arc with no room for one simply has no town.
    //
    // The site is scored by how well the *whole grid* fits, not by how much room the centre point
    // has: the earlier "the centre must be `half the grid + 9` from water" was an estimate of
    // exactly what the per-block check now measures, and on a 512 m island it rejected every
    // sample, so the single site it ever accepted was the flat, inland base pad — which is why the
    // town used to be built on top of a base, with the blocks the pad zone rejected missing from
    // the grid.
    let towns = town_count(size);
    let pad_zone = to_design(BASE_PAD_ZONE_M, size);
    // The terrain's domain warp, in design units, so the block checks below clear it.
    let warp = to_design(15.0, size);
    let mut sites: Vec<(Vec2, u32, u32)> = Vec::new();
    for t in 0..towns {
        let mid = (t as f32 + 0.5) / towns as f32;
        let span = 0.4 / towns as f32;
        let mut best: Option<(Vec2, f32)> = None;
        for k in 0..=24 {
            let (q, _) = along_path(&spine, mid - span + 2.0 * span * k as f32 / 24.0);
            let Some(score) = town_fit_score(
                &feats,
                &carves,
                q,
                TOWN_BLOCKS,
                TOWN_BLOCKS,
                pitch,
                warp,
                &[anchor0, anchor1],
                pad_zone,
            ) else {
                continue;
            };
            if best.map_or(true, |(_, b)| score > b) {
                best = Some((q, score));
            }
        }
        if let Some((q, _)) = best {
            sites.push((q, TOWN_BLOCKS, TOWN_BLOCKS));
        }
    }
    p.road(Road::new(spine.clone(), road_w, RoadKind::Road));
    // Reserve the road corridor. Without this a town block or a country building can be placed
    // *on* the road, and a solid structure blocks the nav cell it stands on — which severs the
    // protected lane and makes the enemy flag unreachable. `route_mask` refuses to protect a
    // cell a structure occupies, so the lane cannot simply punch through it either.
    let corridor = to_design(ROAD_CORRIDOR_M, size);
    for w in spine.windows(2) {
        let d = w[0].dist(w[1]);
        let steps = (d / 10.0).ceil().max(1.0) as u32;
        let dir = (w[1] - w[0]).norm();
        for k in 0..=steps {
            p.zone(w[0] + dir * (d * k as f32 / steps as f32), corridor);
        }
    }

    // Each town: a compact block grid with a building in *every* block, with the spine as one of
    // its streets. A grid only exists because there are buildings inside it.
    for (site, nx, nz) in &sites {
        town_grid(*site, *nx, *nz, pitch, road_w, &spine, p);
        town_blocks(*site, *nx, *nz, pitch, 1.0, 2, &mut rng, p);
    }

    // Buildings out in the country sit *beside* the main road rather than at the end of a spur.
    // A spur to a handful of buildings is a dead end by definition, and the prune below would
    // delete it again; putting them on the road means they are served without any road having to
    // stop in mid-air.
    //
    // Every distance here is a length in metres. In design units the hamlet spacing was 9 units
    // (18 m on small, 72 m on a big map, where a "hamlet" is no longer a group of buildings), and
    // the 46 unit separation from the towns was 92 m on small but 368 m on big — which rejected
    // every candidate on every map, so the roadside buildings had never been placed at all.
    let mut clusters: Vec<Vec2> = vec![gate0, gate1];
    clusters.extend(sites.iter().map(|t| t.0));
    // The attempt budget grows with the map, so a big island's road is settled all the way along
    // it. An attempt a town or gate is too close to is dropped rather than retried.
    let want = (3 + rng.below(3)) as f32;
    let hamlets = (want * linear_of(size)).round() as u32;
    for _ in 0..hamlets {
        let (q, d) = along_path(&spine, rng.range(0.14, 0.86));
        if clusters.iter().any(|s| s.dist(q) < to_design(HAMLET_GAP_M, size)) {
            continue;
        }
        let n = v2(-d.y, d.x);
        let count = 1 + rng.below(3);
        let spots: Vec<Vec2> = (0..count)
            .map(|i| {
                let along = (i as f32 - (count as f32 - 1.0) * 0.5) * to_design(HAMLET_STEP_M, size);
                let sd = if i % 2 == 0 { 1.0 } else { -1.0 };
                let side = to_design(rng.range(HAMLET_SIDE_M.0, HAMLET_SIDE_M.1), size);
                q + d * along + n * (sd * side)
            })
            .collect();
        if !spots.iter().all(|p| plan_height(&feats, &carves, *p) >= 0.6) {
            continue;
        }
        for sp in spots {
            p.prop(Prop {
                p: sp,
                kind: if rng.f32() < 0.7 { skind::BUILDING } else { skind::TENT },
                yaw: d.angle(),
                team: 2,
            });
        }
        clusters.push(q);
    }

    // Nothing may dead-end: trim every branch back to the last junction, protecting the two
    // base gates where the road is supposed to stop. This is the *estimate* pass, run before
    // the island exists; `Gen::trim_roads_to_dry_ground` repeats it against the finished
    // terrain, which is what the asphalt scrub actually cuts with.
    let clear = 6.0 + WATER_SLACK;
    p.prune_road_dead_ends(&[gate0, gate1], &|q: Vec2| {
        plan_height(&feats, &carves, q) >= 0.6
            && water_dist(&feats, &carves, q, clear + 4.0) >= clear
    });

    // --- 6. no splitting channel on procedural islands ---------------------
    // Classic islands are never cut in two. Island variety comes from the silhouette (step 1),
    // the bays, the lake and the inlets, so a channel is not needed for that; and a channel is
    // the one feature that can make the enemy flag genuinely unreachable. `tried` it at ~25 %
    // of islands and it broke `validate` on some seeds: `stamp_deck_route` marks deck cells
    // padded by 1.45 m while `build_nav` only honours a cell the deck covers within 0.6 m, so
    // padded cells the deck does not cover stay water and the protected lane is severed there.
    // Bridges therefore only appear on the authored (mirror) maps, where the deck geometry and
    // the routes were fitted to each other by hand.

    // --- 7. the protected lanes -------------------------------------------
    // The lanes follow the road *exactly*, vertex for vertex, so the brightest pavement on the
    // map is the road itself. Joining sparse nodes with straight lines is what painted diagonal
    // roads across the island: `build_routes` connects consecutive nodes with a single straight
    // segment, and routes are stamped at level 255 over an 7 m width, wider and brighter than
    // any authored road.
    let approach = |b: &BaseDef| b.loc(GATE_LX, 19.0);
    let ap0 = approach(&b0);
    let ap1 = approach(&b1);

    let mut nodes0: Vec<Node> = vec![Node::P(p.spawn[0]), Node::P(ap0)];
    for q in &spine {
        nodes0.push(Node::P(*q));
    }
    nodes0.push(Node::P(p.flag[1]));
    p.route(Route { nodes: nodes0 });

    // The enemy's lane runs the same road the other way, so both teams use one sensible route
    // instead of a second road existing just to make the map symmetric.
    let mut nodes1: Vec<Node> = vec![Node::P(p.spawn[1]), Node::P(ap1)];
    for q in spine.iter().rev() {
        nodes1.push(Node::P(*q));
    }
    nodes1.push(Node::P(p.flag[0]));
    p.route(Route { nodes: nodes1 });

    // --- 8. reserved plazas and interest -----------------------------------
    // Plazas are clear ground around a pad, so they are lengths like the pads: 6/7 design units
    // was 24/28 m on small and 48/56 m on a big map.
    for pt in [p.spawn[0], p.spawn[1]] {
        p.zone(pt, to_design(12.0, size));
    }
    for pt in [p.flag[0], p.flag[1]] {
        p.zone(pt, to_design(14.0, size));
    }
    // Keep the two base pads clear of the block scatters. The pad is a real-world size
    // (`PAD_BLEND`), so its reservation is `BASE_PAD_ZONE_M` and not 34 design units, which on a
    // big map reserved 272 m around each base.
    p.zone(anchor0, pad_zone);
    p.zone(anchor1, pad_zone);

    // Grass patches: fields and clearings between the settlements, which also break up the
    // mostly sandy read of the interior. These are large on purpose — small ones were lost
    // under the sand and the maps showed no grass at all.
    for _ in 0..(6 + rng.below(5)) {
        let Some(q) = inland_site(&feats, &carves, &mut rng, c, 20.0, 96.0, 10.0, &clusters, 22.0) else {
            continue;
        };
        let r = rng.range(26.0, 46.0);
        p.grass(q, r);
        clusters.push(q);
    }

    // A few landmarks, placed on land away from the settlements.
    let landmarks = 3 + rng.below(3);
    for _ in 0..landmarks {
        let Some(q) = inland_site(&feats, &carves, &mut rng, c, 30.0, 96.0, 12.0, &clusters, 24.0) else {
            continue;
        };
        clusters.push(q);
        let roll = rng.f32();
        let kind = if roll < 0.3 {
            skind::LIGHTHOUSE
        } else if roll < 0.55 {
            skind::ANTENNA
        } else if roll < 0.8 {
            skind::TURRET_TOWER
        } else {
            skind::BUILDING
        };
        p.prop(Prop {
            p: q,
            kind,
            yaw: rng.range(0.0, PI),
            team: 2,
        });
    }

    // Scatter budget: the mirrored maps get theirs doubled by the mirror; here the whole map
    // is scanned, so ask for roughly twice as many to reach a similar density.
    p.palms = (rng.range(34.0, 52.0)) as u32;
    p.rocks = (rng.range(24.0, 40.0)) as u32;
    p.scale_to_world(scale_of(size), growth_of(size));
}

fn d45() -> Vec2 {
    v2(FRAC_PI_4.cos(), FRAC_PI_4.sin())
}

/// 0 - Twin Atolls: two big islands behind a diagonal strait, three bridges and two fords.
///
/// Team 0's base sits on the strait headland at (95, 95), team 1's at (161, 161).
fn plan_twin_atolls(p: &mut Plan) {
    let b0 = BaseDef {
        c: v2(95.0, 95.0),
        fwd: d45(),
        team: 0,
    };
    p.set_bases(b0);

    // --- landmasses -------------------------------------------------------
    // Long capsule parallel to the strait: the north-east coast runs straight along the
    // channel instead of bulging into it.
    p.feat(Feat::caps(v2(10.0, 160.0), v2(160.0, 10.0), 112.0));
    p.feat(Feat::blob(v2(24.0, 118.0), 74.0)); // western headland
    p.feat(Feat::blob(v2(148.0, 44.0), 34.0)); // spit to the south-east

    // --- water ------------------------------------------------------------
    p.carve(Carve::line(v2(292.0, -36.0), v2(-36.0, 292.0), 14.0, -4.4)); // the strait
    p.carve(Carve::blob(v2(96.0, 160.0), 22.0, -2.6)); // deeper pool mid-channel
    p.carve(Carve::blob(v2(80.0, 30.0), 22.0, -1.5)); // sheltered bay (shelf water)
    p.carve(Carve::blob(v2(14.0, 148.0), 19.0, -1.3)); // inlet by the headland

    // --- hills (kept well clear of the two base pads) ---------------------
    p.hill(Hill::peak(v2(56.0, 56.0), 34.0, 15.0, 0.9)); // landmark hill
    p.hill(Hill::ridge(
        v2(14.0, 96.0),
        v2(96.0, 14.0),
        28.0,
        11.0,
        0.8,
        0.9,
    ));
    p.hill(Hill::peak(v2(140.0, 60.0), 24.0, 7.0, 1.0)); // bluff over the strait

    // --- crossings: two bridges and a ford (all mirrored) -----------------
    let dn = d45(); // perpendicular to the strait
    let c_mid = p.cross(Cross::bridge(ctr(), dn));
    let c_se = p.cross(Cross::bridge(v2(160.0, 96.0), dn));
    let _f_se = p.cross(Cross::ford(v2(202.2, 53.8), dn, 20.0));

    // --- roads ------------------------------------------------------------
    p.road(Road::new(
        vec![b0.loc(-6.0, 19.0), v2(126.0, 104.0), v2(146.0, 92.0)],
        10.0,
        RoadKind::Road,
    ));
    p.road(Road::new(
        vec![b0.loc(-6.0, 19.0), v2(74.0, 128.0), v2(118.0, 168.0)],
        7.0,
        RoadKind::Track,
    ));

    // --- routes (spawn -> enemy flag) ------------------------------------
    let sp0 = p.spawn[0];
    let fg1 = p.flag[1];
    let gate0 = b0.loc(-6.0, 19.0);
    let gate1 = p.bases[1].loc(-6.0, 19.0);
    p.route(Route {
        nodes: vec![
            Node::P(sp0),
            Node::P(gate0),
            Node::P(v2(126.0, 104.0)),
            Node::P(v2(146.0, 92.0)),
            Node::X(c_se),
            Node::P(v2(178.0, 110.0)),
            Node::P(v2(170.0, 140.0)),
            Node::P(gate1),
            Node::P(fg1),
        ],
    });
    p.route(Route {
        nodes: vec![
            Node::P(sp0),
            Node::P(gate0),
            Node::P(v2(112.0, 112.0)),
            Node::X(c_mid),
            Node::P(v2(146.0, 146.0)),
            Node::P(v2(152.0, 158.0)),
            Node::P(gate1),
            Node::P(fg1),
        ],
    });
    // --- reserved plazas -------------------------------------------------
    p.zone(p.spawn[0], 6.0);
    p.zone(p.flag[0], 7.0);

    // --- neutral interest ------------------------------------------------
    p.prop(Prop {
        p: v2(40.0, 124.0),
        kind: skind::LIGHTHOUSE,
        yaw: 0.4,
        team: 0,
    });
    p.prop(Prop {
        p: v2(70.0, 56.0),
        kind: skind::ANTENNA,
        yaw: 0.0,
        team: 0,
    });
    p.prop(Prop {
        p: v2(152.0, 72.0),
        kind: skind::TURRET_TOWER,
        yaw: 0.8,
        team: 0,
    });
    p.prop(Prop {
        p: v2(60.0, 150.0),
        kind: skind::BUILDING,
        yaw: 0.35,
        team: 0,
    });
    p.prop(Prop {
        p: v2(38.0, 150.0),
        kind: skind::TENT,
        yaw: 0.2,
        team: 0,
    });
    p.prop(Prop {
        p: v2(150.0, 34.0),
        kind: skind::WRECK,
        yaw: 1.1,
        team: 0,
    });
}

/// 1 - Coral Rim: a ring island around a lagoon, cut twice by a tidal channel, with a ring
/// road, two cut bridges and a sandbar causeway straight across the lagoon.
///
/// Team 0's base is on the south-west of the rim at (89, 89), team 1's at (167, 167).
fn plan_coral_rim(p: &mut Plan) {
    let b0 = BaseDef {
        c: v2(89.1, 89.1),
        fwd: d45(),
        team: 0,
    };
    p.set_bases(b0);

    // --- ring of land -----------------------------------------------------
    // Eight tangent capsules at radius 55; four are authored, four are mirror images.
    let r = 55.0f32;
    let half = 26.0f32;
    for k in 0..4 {
        let a = (k as f32) * FRAC_PI_4;
        let c = ctr() + v2(a.cos(), a.sin()) * r;
        let t = v2(-a.sin(), a.cos());
        p.feat(Feat::caps(c - t * half, c + t * half, 72.0));
    }

    // --- outer reef keys in the corners -----------------------------------
    // The ring alone leaves the four corners of the square world as open water; two small
    // keys (mirrored into four) turn them into low coral islands with a channel between them
    // and the rim, so the zoomed-out frame is ring + keys instead of ring + empty sea.
    p.feat(Feat::blob(v2(30.0, 30.0), 52.0));
    p.feat(Feat::blob(v2(22.0, 232.0), 40.0));

    // --- the lagoon at the heart of the ring ------------------------------
    // The ring is thick enough that the land growth would otherwise fill its middle; the
    // lagoon is what makes this "Coral Rim" rather than "a ring road on a plain". The tidal
    // channel below runs straight through it, and the authored lagoon ford raises a sandbar
    // causeway across it, so the lagoon is both the map's landmark and a shortcut.
    p.carve(Carve::blob(ctr(), 38.0, -2.2));

    // --- the tidal channel through the middle -----------------------------
    p.carve(Carve::line(v2(28.0, 228.0), v2(228.0, 28.0), 14.0, -4.8));

    // --- hills on the rim, clear of the bases -----------------------------
    p.hill(Hill::peak(v2(128.0, 200.0), 28.0, 15.0, 0.85)); // landmark hill on the rim
    p.hill(Hill::peak(v2(34.0, 92.0), 24.0, 8.0, 0.7));

    // --- crossings --------------------------------------------------------
    let dn = d45();
    let c_se = p.cross(Cross::bridge(v2(166.9, 89.1), dn));
    let f_mid = p.cross(Cross::ford(ctr(), dn, 22.0));

    // --- ring road + spurs ------------------------------------------------
    let mut ring: Vec<Vec2> = Vec::new();
    for k in 0..40 {
        let a = (k as f32) / 40.0 * core::f32::consts::TAU;
        ring.push(ctr() + v2(a.cos(), a.sin()) * r);
    }
    ring.push(ring[0]);
    p.road(Road::new(ring, 12.0, RoadKind::Paved));
    p.road(Road::new(
        vec![b0.loc(-6.0, 19.0), v2(76.0, 76.0), v2(80.0, 128.0)],
        9.0,
        RoadKind::Road,
    ));

    // --- routes -----------------------------------------------------------
    let arc = |from: f32, to: f32, n: u32| -> Vec<Vec2> {
        (0..=n)
            .map(|k| {
                let a = lerp(from, to, k as f32 / n as f32);
                ctr() + v2(a.cos(), a.sin()) * r
            })
            .collect()
    };
    let sp0 = p.spawn[0];
    let fg1 = p.flag[1];
    let gate0 = b0.loc(-6.0, 19.0);
    let gate1 = p.bases[1].loc(-6.0, 19.0);

    // Route A: around the rim, over the south-east cut bridge.
    let mut nodes_a = vec![Node::P(sp0), Node::P(gate0)];
    for q in arc(3.93, 5.50, 8) {
        nodes_a.push(Node::P(q));
    }
    nodes_a.push(Node::X(c_se));
    for q in arc(5.50, 7.07, 8) {
        nodes_a.push(Node::P(q));
    }
    nodes_a.push(Node::P(gate1));
    nodes_a.push(Node::P(fg1));
    p.route(Route { nodes: nodes_a });

    // Route B: straight over the lagoon causeway.
    let mut nodes_b = vec![Node::P(sp0), Node::P(gate0)];
    for q in arc(3.93, PI + FRAC_PI_4, 6) {
        nodes_b.push(Node::P(q));
    }
    nodes_b.push(Node::X(f_mid));
    nodes_b.push(Node::P(gate1));
    nodes_b.push(Node::P(fg1));
    p.route(Route { nodes: nodes_b });

    // --- reserved plazas --------------------------------------------------
    p.zone(p.spawn[0], 6.0);
    p.zone(p.flag[0], 7.0);

    // --- neutral interest -------------------------------------------------
    p.prop(Prop {
        p: v2(128.0, 208.0),
        kind: skind::LIGHTHOUSE,
        yaw: 0.0,
        team: 0,
    });
    p.prop(Prop {
        p: v2(46.0, 98.0),
        kind: skind::ANTENNA,
        yaw: 0.0,
        team: 0,
    });
    p.prop(Prop {
        p: v2(60.0, 160.0),
        kind: skind::TURRET_TOWER,
        yaw: 0.8,
        team: 0,
    });
    p.prop(Prop {
        p: v2(66.0, 74.0),
        kind: skind::TENT,
        yaw: 0.3,
        team: 0,
    });
    p.prop(Prop {
        p: v2(100.0, 200.0),
        kind: skind::BUILDING,
        yaw: 0.6,
        team: 0,
    });
    p.prop(Prop {
        p: v2(56.0, 142.0),
        kind: skind::WRECK,
        yaw: 1.9,
        team: 0,
    });
}

/// 2 - Iron Strait: one straight north-south river splitting a round island, west and east
/// bases, two bridges and a central ford.
///
/// Team 0's base is on the west bank at (52, 128), team 1's on the east bank at (204, 128).
fn plan_iron_strait(p: &mut Plan) {
    let b0 = BaseDef {
        c: v2(52.0, 128.0),
        fwd: v2(1.0, 0.0),
        team: 0,
    };
    p.set_bases(b0);

    // --- one round island -------------------------------------------------
    p.feat(Feat::blob(ctr(), 250.0));
    p.feat(Feat::blob(v2(40.0, 74.0), 56.0)); // headland behind the NATO base
    p.feat(Feat::blob(v2(30.0, 150.0), 44.0)); // dune field on the west coast
    p.carve(Carve::blob(v2(28.0, 208.0), 26.0, -1.5)); // bay on the south-west coast
    p.carve(Carve::blob(v2(120.0, 22.0), 26.0, -1.4)); // bay on the north coast

    // --- the river --------------------------------------------------------
    p.carve(Carve::line(v2(128.0, -40.0), v2(128.0, 296.0), 14.0, -5.0));

    // --- hills ------------------------------------------------------------
    p.hill(Hill::peak(v2(100.0, 205.0), 40.0, 17.0, 0.85));
    p.hill(Hill::ridge(
        v2(70.0, 40.0),
        v2(150.0, 40.0),
        30.0,
        12.0,
        0.8,
        0.85,
    ));
    p.hill(Hill::peak(v2(160.0, 212.0), 34.0, 9.0, 0.6));

    // --- crossings --------------------------------------------------------
    let c_s = p.cross(Cross::bridge(v2(128.0, 190.0), v2(1.0, 0.0)));
    let f_mid = p.cross(Cross::ford(ctr(), v2(1.0, 0.0), 16.0));

    // --- roads ------------------------------------------------------------
    p.road(Road::new(
        vec![b0.loc(-6.0, 19.0), v2(92.0, 152.0), v2(112.0, 176.0)],
        10.0,
        RoadKind::Road,
    ));
    p.road(Road::new(
        vec![b0.loc(-6.0, 19.0), v2(96.0, 132.0), v2(112.0, 126.0)],
        9.0,
        RoadKind::Road,
    ));
    p.road(Road::new(
        vec![v2(60.0, 96.0), v2(96.0, 74.0), v2(150.0, 52.0)],
        7.0,
        RoadKind::Track,
    ));

    // --- routes -----------------------------------------------------------
    let sp0 = p.spawn[0];
    let fg1 = p.flag[1];
    let gate0 = b0.loc(-6.0, 19.0);
    let gate1 = p.bases[1].loc(-6.0, 19.0);
    p.route(Route {
        nodes: vec![
            Node::P(sp0),
            Node::P(gate0),
            Node::P(v2(92.0, 152.0)),
            Node::P(v2(112.0, 176.0)),
            Node::X(c_s),
            Node::P(v2(148.0, 184.0)),
            Node::P(v2(172.0, 152.0)),
            Node::P(gate1),
            Node::P(fg1),
        ],
    });
    p.route(Route {
        nodes: vec![
            Node::P(sp0),
            Node::P(gate0),
            Node::P(v2(96.0, 128.0)),
            Node::X(f_mid),
            Node::P(v2(168.0, 126.0)),
            Node::P(gate1),
            Node::P(fg1),
        ],
    });

    // --- reserved plazas --------------------------------------------------
    p.zone(p.spawn[0], 6.0);
    p.zone(p.flag[0], 7.0);

    // --- neutral interest -------------------------------------------------
    p.prop(Prop {
        p: v2(30.0, 84.0),
        kind: skind::LIGHTHOUSE,
        yaw: 1.2,
        team: 0,
    });
    p.prop(Prop {
        p: v2(60.0, 60.0),
        kind: skind::ANTENNA,
        yaw: 0.0,
        team: 0,
    });
    p.prop(Prop {
        p: v2(112.0, 148.0),
        kind: skind::TURRET_TOWER,
        yaw: -1.4,
        team: 0,
    });
    p.prop(Prop {
        p: v2(96.0, 172.0),
        kind: skind::TENT,
        yaw: 0.1,
        team: 0,
    });
    p.prop(Prop {
        p: v2(90.0, 44.0),
        kind: skind::BUILDING,
        yaw: -0.4,
        team: 0,
    });
    p.prop(Prop {
        p: v2(60.0, 168.0),
        kind: skind::WRECK,
        yaw: 2.1,
        team: 0,
    });
}

/// 3 - Shattered Keys: four corner keys cut apart by a cross of channels, two bridges and
/// two causeways.
///
/// Team 0's base is on the origin-corner key at (48, 48), team 1's at (208, 208).
fn plan_shattered_keys(p: &mut Plan) {
    let b0 = BaseDef {
        c: v2(48.0, 48.0),
        fwd: d45(),
        team: 0,
    };
    p.set_bases(b0);

    // --- four keys --------------------------------------------------------
    p.feat(Feat::blob(v2(52.0, 52.0), 158.0));
    p.feat(Feat::blob(v2(52.0, 200.0), 158.0));
    p.feat(Feat::blob(v2(12.0, 108.0), 46.0)); // western spit

    // --- the channel cross ------------------------------------------------
    p.carve(Carve::line(v2(128.0, -30.0), v2(128.0, 286.0), 13.0, -3.7));
    p.carve(Carve::line(v2(-30.0, 128.0), v2(286.0, 128.0), 13.0, -3.7));
    // Shallow lagoons bitten out of the keys: turquoise water over pale sand, and a place an
    // amphibious jeep can cut a corner that a tank has to drive around. Mirrored into four.
    p.carve(Carve::blob(v2(88.0, 30.0), 26.0, -1.15));
    p.carve(Carve::blob(v2(30.0, 88.0), 26.0, -1.15));

    // --- hills: rocky headlands either side of each key -------------------
    p.hill(Hill::peak(v2(24.0, 92.0), 22.0, 16.0, 0.9)); // landmark headland
    p.hill(Hill::peak(v2(86.0, 98.0), 22.0, 13.0, 0.9));

    // --- crossings --------------------------------------------------------
    let c_n = p.cross(Cross::bridge(v2(128.0, 52.0), v2(1.0, 0.0)));
    let f_w = p.cross(Cross::ford(v2(52.0, 128.0), v2(0.0, 1.0), 16.0));
    let f_w_mirror = p.cross_mirror[f_w];

    // --- roads ------------------------------------------------------------
    p.road(Road::new(
        vec![b0.loc(-6.0, 19.0), v2(92.0, 58.0), v2(112.0, 54.0)],
        10.0,
        RoadKind::Road,
    ));
    p.road(Road::new(
        vec![b0.loc(-6.0, 19.0), v2(66.0, 96.0), v2(58.0, 110.0)],
        9.0,
        RoadKind::Road,
    ));
    // --- routes -----------------------------------------------------------
    let sp0 = p.spawn[0];
    let fg1 = p.flag[1];
    let gate0 = b0.loc(-6.0, 19.0);
    let gate1 = p.bases[1].loc(-6.0, 19.0);
    p.route(Route {
        nodes: vec![
            Node::P(sp0),
            Node::P(gate0),
            Node::P(v2(92.0, 58.0)),
            Node::X(c_n),
            Node::P(v2(150.0, 58.0)),
            Node::P(v2(186.0, 62.0)),
            Node::X(f_w_mirror),
            Node::P(v2(200.0, 160.0)),
            Node::P(gate1),
            Node::P(fg1),
        ],
    });
    p.route(Route {
        nodes: vec![
            Node::P(sp0),
            Node::P(gate0),
            Node::P(v2(60.0, 96.0)),
            Node::X(f_w),
            Node::P(v2(70.0, 168.0)),
            Node::P(v2(112.0, 186.0)),
            Node::P(gate1),
            Node::P(fg1),
        ],
    });

    // --- reserved plazas --------------------------------------------------
    p.zone(p.spawn[0], 6.0);
    p.zone(p.flag[0], 7.0);
    p.zone(v2(52.0, 200.0), 12.0); // neutral camp key

    // --- neutral interest -------------------------------------------------
    p.prop(Prop {
        p: v2(96.0, 26.0),
        kind: skind::LIGHTHOUSE,
        yaw: 0.9,
        team: 0,
    });
    p.prop(Prop {
        p: v2(28.0, 196.0),
        kind: skind::ANTENNA,
        yaw: 0.0,
        team: 0,
    });
    p.prop(Prop {
        p: v2(112.0, 40.0),
        kind: skind::TURRET_TOWER,
        yaw: 0.0,
        team: 0,
    });
    p.prop(Prop {
        p: v2(66.0, 176.0),
        kind: skind::TENT,
        yaw: 0.4,
        team: 0,
    });
    p.prop(Prop {
        p: v2(40.0, 172.0),
        kind: skind::TENT,
        yaw: 2.2,
        team: 0,
    });
    p.prop(Prop {
        p: v2(24.0, 182.0),
        kind: skind::BUILDING,
        yaw: 0.2,
        team: 0,
    });
    p.prop(Prop {
        p: v2(156.0, 44.0),
        kind: skind::WRECK,
        yaw: 1.6,
        team: 0,
    });
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/// Route sample semantics.
const R_LAND: u8 = 0;
const R_BRIDGE: u8 = 1;
const R_FORD: u8 = 2;

#[derive(Clone)]
struct RouteLine {
    pts: Vec<Vec2>,
    kind: Vec<u8>,
}

/// A crossing with its abutments resolved against the finished heightfield.
#[derive(Clone, Copy)]
struct Resolved {
    a: Vec2,
    b: Vec2,
    /// Authored centre of the crossing (kept so the span can be re-measured on the final
    /// height field without drifting off-axis when one side's march falls short).
    p: Vec2,
    /// Authored crossing axis (unit).
    dir: Vec2,
    kind: CrossKind,
    pieces: u32,
}

struct Gen {
    idx: usize,
    /// Runtime world dimensions for the selected [`MapSize`]. These replaced the compile-time
    /// `W`/`V`/`GG`/`CELL` consts so a map can be small, medium or big.
    w: f32,
    v: usize,
    gg: usize,
    cell: f32,
    occ_n: usize,
    occ_m: f32,
    h: Vec<f32>,
    rocky: Vec<f32>,
    splat: Vec<u8>,
    road: Vec<u8>,
    /// Which of the three sands / three grasses each vertex's sand and grass weight *are*, and
    /// how its pavement is surfaced. See `MapData`.
    sand_var: Vec<u8>,
    grass_var: Vec<u8>,
    pave: Vec<u8>,
    /// Height vertices `grade_protected_lanes` raised from below the waterline to dry land.
    /// The asphalt mask is suppressed there so a lane lifted out of the sea reads as the
    /// sandbar the geometry makes it instead of a grey strip of highway standing in water.
    lifted: Vec<bool>,
    nav: Vec<u8>,
    /// Protected route cells (never blocked, always ROAD).
    route: Vec<u8>,
    occ: Vec<u8>,
    structs: Vec<Structure>,
    plan: Plan,
    crossings: Vec<Resolved>,
    routes: Vec<RouteLine>,
    /// Reserved plazas are ignored while the authored base complex is placed.
    zone_check: bool,
    shape: Noise,
    detail: Noise,
    warp: Noise,
    grain: Noise,
    rng: Rng,
}

/// Rasterise the nav grid: terrain class per cell, then structure footprints, then pinches.
///
/// Lifted out of `Gen::build_nav` so the map editor can rebuild a grid for a map it has just
/// painted. There is exactly one definition of what is drivable, and it is this one — a second
/// copy in the editor would drift from the game's the first time either changed.
///
/// `v` is the heightfield stride (grid + 1) and `gg` the nav grid size. `route` may be all zeros
/// (an edited map has no protected lanes); `world` is the battlefield side in metres.
#[allow(clippy::too_many_arguments)]
pub(crate) fn rasterize_nav(
    nav: &mut [u8],
    heights: &[f32],
    road: &[u8],
    route: &[u8],
    structs: &[Structure],
    v: usize,
    gg: usize,
    cell: f32,
    world: f32,
) {
    /// Height at a heightfield vertex.
    #[inline]
    fn vh(heights: &[f32], v: usize, ix: usize, iz: usize) -> f32 {
        heights[iz * v + ix]
    }
    let vh = |ix: usize, iz: usize| vh(heights, v, ix, iz);
        // Decks placed earlier this pass (`place_crossings` runs before `build_nav`); used to
        // decide whether a below-water route cell has something to drive on.
        let bridges: Vec<Structure> = structs
            .iter()
            .filter(|s| s.kind as u8 == skind::BRIDGE)
            .cloned()
            .collect();
        for cz in 0..gg {
            for cx in 0..gg {
                let h00 = vh(cx, cz);
                let h10 = vh(cx + 1, cz);
                let h01 = vh(cx, cz + 1);
                let h11 = vh(cx + 1, cz + 1);
                let h = (h00 + h10 + h01 + h11) * 0.25;
                let sx = ((h10 + h11) - (h00 + h01)) * 0.5 / cell;
                let sz = ((h01 + h11) - (h00 + h10)) * 0.5 / cell;
                let slope = (sx * sx + sz * sz).sqrt();
                let road = ((road[cz * v + cx] as u32
                    + road[cz * v + cx + 1] as u32
                    + road[(cz + 1) * v + cx] as u32
                    + road[(cz + 1) * v + cx + 1] as u32)
                    / 4) as u8;
                let i = cz * gg + cx;
                let mut t = if h < -0.6 {
                    terrain::DEEP_WATER
                } else if h < 0.05 {
                    terrain::SHALLOW_WATER
                } else if slope > 1.15 || (h > 15.0 && slope > 0.6) {
                    terrain::ROCK
                } else if road > 150 {
                    terrain::ROAD
                } else if h < 1.2 {
                    terrain::SAND
                } else {
                    terrain::GROUND
                };
                if route[i] != 0 {
                    // A protected lane is drivable only where there is something to drive on.
                    // `route_mask` stamps road polylines before the crossings are placed, and
                    // an authored route can run straight across a channel. The old
                    // unconditional promotion to ROAD rasterised that open water as a road,
                    // so `cell_passable` let LAND flow fields route non-amphibious hulls into
                    // the sea - and physics shoves those straight back out (see the
                    // "blocked by the sea" branch), which is why the AI picked the water
                    // shortcut over the intact bridge beside it. Keep the water class unless
                    // an intact deck actually spans the cell, so the nav grid agrees with
                    // `World::bridge_deck`/`in_water` about what a land vehicle can cross.
                    let q = v2((cx as f32 + 0.5) * cell, (cz as f32 + 0.5) * cell);
                    if !terrain::is_water(t) || deck_covers(&bridges, q) {
                        t = terrain::ROAD; // deck, causeway or approach road
                    }
                }
                nav[i] = t;
            }
        }
        // Structure footprints block the grid (except bridges and FLAT decals). The pieces
        // flanking a gateway block a shoulder as well, so the drivable channel through a
        // gate is narrower than its 8 m opening and traffic keeps to the middle of it: a
        // flow field that hugs the jamb wedges a jeep there.
        let gates: Vec<Vec2> = structs
            .iter()
            .filter(|g| g.kind as u8 == skind::GATE)
            .map(|g| g.pos())
            .collect();
        for s in structs {
            if !s.flag(sflag::SOLID) || s.flag(sflag::FLAT) || s.kind as u8 == skind::BRIDGE {
                continue;
            }
            let jambs = s.kind as u8 == skind::WALL
                && gates.iter().any(|g| g.dist(s.pos()) < 9.0);
            let shoulder = if jambs { GATE_SHOULDER } else { NAV_SHOULDER };
            let hw = (s.w * 0.5 + shoulder).max(0.2);
            let hd = (s.d * 0.5 + shoulder).max(0.2);
            let (sn, cs) = s.yaw.sin_cos();
            let ex = hw * cs.abs() + hd * sn.abs();
            let ez = hw * sn.abs() + hd * cs.abs();
            let c = s.pos();
            let x0 = ((c.x - ex) / cell).floor().max(0.0) as i32;
            let x1 = ((c.x + ex) / cell).ceil().min((gg - 1) as f32) as i32;
            let z0 = ((c.y - ez) / cell).floor().max(0.0) as i32;
            let z1 = ((c.y + ez) / cell).ceil().min((gg - 1) as f32) as i32;
            for cz in z0..=z1 {
                for cx in x0..=x1 {
                    let i = cz as usize * gg + cx as usize;
                    if route[i] != 0 {
                        continue; // never seal a protected lane
                    }
                    if !terrain::is_land(nav[i]) {
                        continue;
                    }
                    let q = v2((cx as f32 + 0.5) * cell, (cz as f32 + 0.5) * cell);
                    if obb_sd(q, c, s.yaw, hw, hd) <= 0.0 {
                        nav[i] = terrain::BLOCKED;
                    }
                }
            }
        }
        // A cell pinched between two solid structures is not a road, it is a trap: the flow
        // field will route a vehicle into a 3 m slot between two huts and it cannot get out.
        // Such a cell is within NAV_SQUEEZE of two different structures at once.
        //
        // Naively this is O(cells x structures): 65k cells against ~250 solid structures is
        // 16M oriented-box tests, and it dominated generation once the world grew. Bucket the
        // blockers on a coarse grid instead, so each cell only tests the handful within
        // NAV_SQUEEZE of it.
        let blockers: Vec<&Structure> = structs
            .iter()
            .filter(|s| {
                s.flag(sflag::SOLID) && !s.flag(sflag::FLAT) && s.kind as u8 != skind::BRIDGE
            })
            .collect();
        const BK: f32 = 8.0;
        let bn = (world / BK).ceil() as usize + 1;
        let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); bn * bn];
        for (bi, s) in blockers.iter().enumerate() {
            let c = s.pos();
            let r = s.w.max(s.d) * 0.5 + NAV_SQUEEZE;
            let x0 = ((c.x - r) / BK).floor().max(0.0) as usize;
            let x1 = (((c.x + r) / BK).floor().max(0.0) as usize).min(bn - 1);
            let z0 = ((c.y - r) / BK).floor().max(0.0) as usize;
            let z1 = (((c.y + r) / BK).floor().max(0.0) as usize).min(bn - 1);
            for bz in z0..=z1 {
                for bx in x0..=x1 {
                    buckets[bz * bn + bx].push(bi as u32);
                }
            }
        }
        for cz in 0..gg {
            for cx in 0..gg {
                let i = cz * gg + cx;
                if route[i] != 0 || !terrain::is_land(nav[i]) {
                    continue;
                }
                let q = v2((cx as f32 + 0.5) * cell, (cz as f32 + 0.5) * cell);
                let bx = ((q.x / BK) as usize).min(bn - 1);
                let bz = ((q.y / BK) as usize).min(bn - 1);
                let mut touches = 0;
                for bi in &buckets[bz * bn + bx] {
                    let s = blockers[*bi as usize];
                    if obb_sd(q, s.pos(), s.yaw, s.w * 0.5, s.d * 0.5) <= NAV_SQUEEZE {
                        touches += 1;
                        if touches >= 2 {
                            break;
                        }
                    }
                }
                if touches >= 2 {
                    nav[i] = terrain::BLOCKED;
                }
            }
        }
}

impl Gen {
    fn new(seed: u32, idx: usize, mode: MapMode, size: MapSize) -> Gen {
        let s = seed
            .wrapping_mul(0x9E37_79B9)
            .wrapping_add((idx as u32).wrapping_mul(0x85EB_CA6B))
            ^ 0x5F37_5A11;
        let mut plan = if mode.mirrors() {
            Plan::new()
        } else {
            Plan::unmirrored()
        };
        match mode {
            MapMode::Mirror => plan_map(idx, &mut plan, size, s),
            // Seeded from the *raw* seed (not the index-mixed `s`) so that two different map
            // indices under the same seed are genuinely different islands rather than the
            // same island in a different order.
            MapMode::Classic => plan_proc(seed, idx, &mut plan, size),
        }
        Gen {
            idx,
            w: size.world(),
            v: size.verts() as usize,
            gg: size.grid() as usize,
            cell: size.cell(),
            occ_n: size.occ(),
            occ_m: size.world() / size.occ() as f32,
            h: vec![0.0; size.verts() as usize * size.verts() as usize],
            rocky: vec![0.0; size.verts() as usize * size.verts() as usize],
            splat: vec![0u8; size.verts() as usize * size.verts() as usize * 4],
            road: vec![0u8; size.verts() as usize * size.verts() as usize],
            sand_var: vec![1u8; size.verts() as usize * size.verts() as usize],
            grass_var: vec![1u8; size.verts() as usize * size.verts() as usize],
            pave: vec![0u8; size.verts() as usize * size.verts() as usize],
            lifted: vec![false; size.verts() as usize * size.verts() as usize],
            nav: vec![0u8; size.grid() as usize * size.grid() as usize],
            route: vec![0u8; size.grid() as usize * size.grid() as usize],
            occ: vec![0u8; size.occ() * size.occ()],
            structs: Vec::with_capacity(720),
            plan,
            crossings: Vec::new(),
            routes: Vec::new(),
            zone_check: true,
            shape: Noise::new(s ^ 0x1111_1111),
            detail: Noise::new(s ^ 0x2222_2222),
            warp: Noise::new(s ^ 0x3333_3333),
            grain: Noise::new(s ^ 0x4444_4444),
            rng: Rng::new(s ^ 0x7777_7777),
        }
    }

    // -- sampling ---------------------------------------------------------

    #[inline]
    fn vh(&self, ix: usize, iz: usize) -> f32 {
        self.h[iz * self.v + ix]
    }

    fn h_at(&self, x: f32, z: f32) -> f32 {
        let g = (self.v - 1) as f32;
        let fx = clamp(x / self.cell, 0.0, g);
        let fz = clamp(z / self.cell, 0.0, g);
        let ix = fx.floor() as usize;
        let iz = fz.floor() as usize;
        let ix1 = (ix + 1).min(self.v - 1);
        let iz1 = (iz + 1).min(self.v - 1);
        let tx = fx - ix as f32;
        let tz = fz - iz as f32;
        lerp(
            lerp(self.vh(ix, iz), self.vh(ix1, iz), tx),
            lerp(self.vh(ix, iz1), self.vh(ix1, iz1), tx),
            tz,
        )
    }

    fn slope_at(&self, x: f32, z: f32) -> f32 {
        let d = self.cell;
        let hx = self.h_at(x + d, z) - self.h_at(x - d, z);
        let hz = self.h_at(x, z + d) - self.h_at(x, z - d);
        (hx * hx + hz * hz).sqrt() / (2.0 * d)
    }

    // -- pipeline ---------------------------------------------------------

    fn build(&mut self) {
        self.build_heights();
        self.smooth(2);
        self.limit_slopes(1.5, 3);
        self.carve_pass();
        self.smooth(1);
        self.limit_slopes(1.5, 3);
        self.base_pads();
        self.resolve_crossings();
        self.build_routes();
        self.grade_routes();
        self.limit_slopes(1.45, 4);
        // Heights are final now: re-measure the crossings, cut the abutment embankments,
        // then re-measure once more (the ramps move the waterline) and re-lay the routes so
        // both the deck chain and its approach roads follow the real shore.
        self.resolve_crossings_final();
        self.grade_abutments();
        self.limit_slopes(1.5, 2);
        self.resolve_crossings_final();
        self.grade_abutments();
        self.limit_slopes(1.5, 2);
        self.resolve_crossings_final();
        self.routes.clear();
        self.build_routes();
        // The island exists now: drop any road the asphalt scrub would have cut at the
        // shoreline, back to its last junction, before it is stamped at all.
        self.trim_roads_to_dry_ground();
        self.stamp_roads();
        // Bases and crossings go down before the route is reserved, so the authored base
        // complex is never rejected by its own driveway.
        self.place_crossings();
        self.place_base(0);
        self.place_base(1);
        self.route_mask();
        self.stamp_deck_route();
        self.grade_protected_lanes();
        // Heights are final now: snap the mirror before anything seats on the ground, so props
        // rest on the terrain that actually ships (see `enforce_symmetry_heights`).
        if self.plan.mirror {
            self.enforce_symmetry_heights();
        }
        self.mark_route_occ();
        self.mark_road_occ();
        self.place_props();
        self.scatter();
        self.build_nav();
        self.scrub_lifted_road();
        self.build_splat();
        // Only mirrored plans need their fields re-copied onto themselves: an unmirrored plan
        // built each cell from its own sample and forcing the mirror here would destroy it.
        if self.plan.mirror {
            self.enforce_symmetry();
        }
        self.assign_ids();
    }

    /// Terrain field: domain-warped island mask -> profile -> hills -> noise -> water.
    fn build_heights(&mut self) {
        let mut rocky = vec![0.0f32; self.v * self.v];
        for iz in 0..self.v {
            for ix in 0..self.v {
                let i = iz * self.v + ix;
                // Only evaluate the canonical half; the mirror copy follows below.
                let (jx, jz) = (self.v - 1 - ix, self.v - 1 - iz);
                if jz * self.v + jx < i {
                    continue;
                }
                let x = ix as f32 * self.cell;
                let z = iz as f32 * self.cell;
                let (h, rk) = self.terrain_at(x, z);
                self.h[i] = h;
                rocky[i] = rk;
            }
        }
        for iz in 0..self.v {
            for ix in 0..self.v {
                let i = iz * self.v + ix;
                let (jx, jz) = (self.v - 1 - ix, self.v - 1 - iz);
                let j = jz * self.v + jx;
                if j < i {
                    self.h[i] = self.h[j];
                    rocky[i] = rocky[j];
                }
            }
        }
        // Softly compress peaks above SOFT_CAP: an authored plan can sit right at the hard 30 m
        // budget (Iron Strait is ~29.5 before jitter), so without this a hill that wanders onto
        // higher base terrain would push the map over it. The compression keeps the landmark's
        // shape, and the smooth/limit_slopes stages that follow blend the result in.
        const SOFT_CAP: f32 = 28.0;
        for h in self.h.iter_mut() {
            if *h > SOFT_CAP {
                *h = SOFT_CAP + (*h - SOFT_CAP) * 0.45;
            }
        }
        self.rocky = rocky;
    }

    fn terrain_at(&self, x: f32, z: f32) -> (f32, f32) {
        // Domain warp so coastlines and ridges wander instead of looking like circles.
        let w1 = self.warp.fbm(x * 0.0085, z * 0.0085, 3, 2.0, 0.5);
        let w2 = self
            .warp
            .fbm(x * 0.0085 + 41.0, z * 0.0085 - 27.0, 3, 2.0, 0.5);
        let wx = x + w1 * 15.0;
        let wz = z + w2 * 15.0;

        let mut inv = 1.0f32;
        for f in &self.plan.feats {
            inv *= 1.0 - f.mask(v2(wx, wz));
        }
        let s0 = 1.0 - inv;
        // Seed variation: the plan fixes the skeleton (bases, roads, crossings) and the seed
        // reshapes the land itself. A low-frequency field wanders the coastline band by a good
        // fraction of the shelf width, so two seeds over the same plan are different islands —
        // different shores, inlets and lagoons — rather than the same island in different grass.
        // The fade keeps open sea open and deep land dry: base pads, spawn points and the wet
        // world rim must never be at the seed's mercy.
        let coast = self.shape.fbm(x * 0.0045 + 17.3, z * 0.0045 - 9.1, 3, 2.0, 0.5);
        let t = ((s0 - 0.5).abs() - 0.22).clamp(0.0, 0.28);
        let fade = 1.0 - smoothstep(0.0, 0.28, t);
        // Land-adding wander is damped on high ground: profile's inland ramp would amplify it
        // past the height budget. Water-adding wander stays — it only ever opens a lagoon or
        // inlet, which is exactly the per-seed variation this exists for.
        let up = if coast > 0.0 { 1.0 - smoothstep(0.55, 0.72, s0) } else { 1.0 };
        let s = (s0 + coast * 0.30 * fade * up).clamp(0.0, 1.0);
        let mut h = profile(s);
        let mut rock = 0.0f32;

        // Wide, early ramp: hills and noise must fade out before the beach, otherwise the
        // mask gradient itself shows up as an unwalkable slope near the coast.
        let land_f = smoothstep(0.15, 0.48, s);
        if land_f > 0.0 {
            for hill in &self.plan.hills {
                let d = seg_dist(v2(x, z), hill.a, hill.b) / hill.r;
                if d >= 1.0 {
                    continue;
                }
                let sh = 1.0 - smoothstep(0.0, 1.0, d);
                let mut a = hill.peak * sh * land_f;
                if hill.ridge > 0.0 {
                    // Gentle ridged modulation: enough to read as rock, not enough to
                    // punch a spike through the walkability budget.
                    let rg = self.detail.ridged(x * 0.030, z * 0.030, 3);
                    a *= 1.0 + hill.ridge * (rg - 0.5) * 0.5;
                }
                h += a.max(0.0);
                rock += hill.rock * sh * land_f;
            }
            // Regional character: some stretches of coast are low scrub, others rolling.
            let region = self.shape.fbm(x * 0.006, z * 0.006, 2, 2.0, 0.5);
            h += region * 1.7 * smoothstep(0.60, 0.86, s);
            h += self.detail.fbm(x * 0.021, z * 0.021, 4, 2.0, 0.5) * 1.4 * land_f;
            h += self
                .detail
                .fbm(x * 0.0072 + 9.0, z * 0.0072 - 3.0, 3, 2.0, 0.5)
                * 2.0
                * land_f;
        }

        for c in &self.plan.carves {
            let d = seg_dist(v2(x, z), c.a, c.b) / c.r;
            if d >= 1.0 {
                continue;
            }
            let t = smoothstep(0.35, 1.0, d);
            h = h.min(lerp(c.depth, h, t));
        }

        // Keep the world edges wet: nobody drives around the outside of the map.
        let e = x.min(z).min(self.w - x).min(self.w - z);
        let edge = self.plan.edge;
        h = lerp(EDGE_DEPTH, h, smoothstep(edge * 0.3, edge, e));
        (h, clamp(rock, 0.0, 1.0))
    }

    /// Second carve pass, after the first smoothing, so channels stay open.
    fn carve_pass(&mut self) {
        let carves = self.plan.carves.clone();
        for iz in 0..self.v {
            for ix in 0..self.v {
                let p = v2(ix as f32 * self.cell, iz as f32 * self.cell);
                let i = iz * self.v + ix;
                for c in &carves {
                    let d = seg_dist(p, c.a, c.b) / c.r;
                    if d >= 1.0 {
                        continue;
                    }
                    let t = smoothstep(0.30, 1.0, d);
                    self.h[i] = self.h[i].min(lerp(c.depth, self.h[i], t));
                }
            }
        }
    }

    fn smooth(&mut self, passes: u32) {
        let mut tmp = self.h.clone();
        for _ in 0..passes {
            for iz in 0..self.v {
                for ix in 0..self.v {
                    let mut sum = 0.0;
                    let mut wsum = 0.0;
                    for dz in -1i32..=1 {
                        for dx in -1i32..=1 {
                            let nx = ix as i32 + dx;
                            let nz = iz as i32 + dz;
                            if nx < 0 || nz < 0 || nx >= self.v as i32 || nz >= self.v as i32 {
                                continue;
                            }
                            let wgt = if dx == 0 && dz == 0 {
                                4.0
                            } else if dx == 0 || dz == 0 {
                                2.0
                            } else {
                                1.0
                            };
                            sum += self.h[nz as usize * self.v + nx as usize] * wgt;
                            wsum += wgt;
                        }
                    }
                    tmp[iz * self.v + ix] = sum / wsum;
                }
            }
            core::mem::swap(&mut self.h, &mut tmp);
        }
    }

    /// Cap neighbour height differences (keeps `slope_at` walkable, removes 1-vertex spikes).
    fn limit_slopes(&mut self, cap: f32, iters: u32) {
        for _ in 0..iters {
            for iz in 0..self.v {
                for ix in 0..self.v - 1 {
                    let i = iz * self.v + ix;
                    let j = i + 1;
                    if self.h[i].min(self.h[j]) < 0.25 {
                        continue; // leave the sea bed alone
                    }
                    let d = self.h[j] - self.h[i];
                    if d > cap {
                        let e = (d - cap) * 0.5;
                        self.h[i] += e;
                        self.h[j] -= e;
                    } else if d < -cap {
                        let e = (d + cap) * 0.5;
                        self.h[i] += e;
                        self.h[j] -= e;
                    }
                }
            }
            for ix in 0..self.v {
                for iz in 0..self.v - 1 {
                    let i = iz * self.v + ix;
                    let j = i + self.v;
                    if self.h[i].min(self.h[j]) < 0.25 {
                        continue;
                    }
                    let d = self.h[j] - self.h[i];
                    if d > cap {
                        let e = (d - cap) * 0.5;
                        self.h[i] += e;
                        self.h[j] -= e;
                    } else if d < -cap {
                        let e = (d + cap) * 0.5;
                        self.h[i] += e;
                        self.h[j] -= e;
                    }
                }
            }
            // Explicit spike removal: a vertex far above all four neighbours is a bug.
            let snapshot = self.h.clone();
            for iz in 1..self.v - 1 {
                for ix in 1..self.v - 1 {
                    let i = iz * self.v + ix;
                    let mn = snapshot[i - 1]
                        .min(snapshot[i + 1])
                        .min(snapshot[i - self.v])
                        .min(snapshot[i + self.v]);
                    if snapshot[i] > mn + 3.0 {
                        self.h[i] = mn + 2.0;
                    }
                }
            }
        }
    }

    /// March outwards from each crossing until we hit real land: that is the bridge span.
    fn resolve_crossings(&mut self) {
        for ci in 0..self.plan.crosses.len() {
            let c = self.plan.crosses[ci];
            let mut res = Resolved {
                a: c.p - c.dir * 14.0,
                b: c.p + c.dir * 14.0,
                p: c.p,
                dir: c.dir.norm(),
                kind: c.kind,
                pieces: 2,
            };
            if c.kind == CrossKind::Bridge {
                let mut a = c.p - c.dir * 8.0;
                let mut b = c.p + c.dir * 8.0;
                let mut s = 1.0f32;
                while s <= 90.0 {
                    let p = c.p - c.dir * s;
                    if self.h_at(p.x, p.y) >= 0.55 {
                        a = p;
                        break;
                    }
                    s += 0.5;
                }
                let mut s = 1.0f32;
                while s <= 90.0 {
                    let p = c.p + c.dir * s;
                    if self.h_at(p.x, p.y) >= 0.55 {
                        b = p;
                        break;
                    }
                    s += 0.5;
                }
                // Overlap the abutments so the deck meets the road on both shores.
                let a = a - c.dir * 3.0;
                let b = b + c.dir * 3.0;
                res.a = a;
                res.b = b;
                res.pieces = 2; // one run of two pieces, stretched to the measured span
            } else {
                let half = c.half.max(8.0);
                res.a = c.p - c.dir * half;
                res.b = c.p + c.dir * half;
            }
            self.crossings.push(res);
        }
    }

    /// Re-measure every bridge span on the *finished* height field.
    ///
    /// `resolve_crossings` runs before the routes are graded and stamped, and grading moves
    /// the shoreline; measuring early and building late is exactly how a deck run ends up
    /// hanging over water. This pass walks the crossing axis outwards from the authored
    /// centre until it finds genuinely dry ground on both sides, then extends a few metres
    /// inland so the deck lands on the approach road.
    fn resolve_crossings_final(&mut self) {
        /// Height above which a cell counts as dry land rather than a wet shelf.
        const DRY: f32 = 0.55;
        /// How far the deck reaches inland past the waterline at each end.
        const OVERLAP: f32 = 4.0;
        const MAX_MARCH: f32 = 150.0;

        for ci in 0..self.crossings.len() {
            let mut c = self.crossings[ci];
            if c.kind != CrossKind::Bridge {
                continue;
            }
            let axis = c.dir.norm();
            // Walk outwards and stop at a shore a vehicle can actually use: dry, low and
            // gentle. The first dry cell can be the top of a cliff, and landing a deck there
            // buries it in the hillside.
            let perp = axis.perp();
            let edge = |me: &Self, sign: f32| -> f32 {
                let mut first_dry: Option<f32> = None;
                let mut s = 1.0f32;
                while s <= MAX_MARCH {
                    let p = c.p + axis * (sign * s);
                    if p.x < 2.0 || p.y < 2.0 || p.x > self.w - 2.0 || p.y > self.w - 2.0 {
                        return first_dry.unwrap_or((s - 0.5).max(1.0));
                    }
                    let h = me.h_at(p.x, p.y);
                    if h >= DRY {
                        let first = *first_dry.get_or_insert(s);
                        // The deck end needs a flat berth: the audit samples cells 2.2 m to
                        // either side of the deck centreline, and a channel can run *alongside*
                        // the approach (invisible to an axis-only walk), leaving the end on a
                        // shelf that drops into deep water two metres over. Require both sides
                        // dry before accepting a shore.
                        let berth = me.h_at((p + perp * 2.5).x, (p + perp * 2.5).y) >= 0.3
                            && me.h_at((p - perp * 2.5).x, (p - perp * 2.5).y) >= 0.3;
                        if berth && me.slope_at(p.x, p.y) <= 0.75 && h <= 3.2 {
                            return s;
                        }
                        // Allow a short climb past the shoreline to reach a shelf, but do
                        // not chase a cliff inland forever.
                        if s - first > 26.0 {
                            return first;
                        }
                    }
                    s += 0.5;
                }
                first_dry.unwrap_or((MAX_MARCH * 0.5).max(1.0))
            };
            let lo = edge(self, -1.0);
            let hi = edge(self, 1.0);
            c.a = c.p - axis * (lo + OVERLAP);
            c.b = c.p + axis * (hi + OVERLAP);
            self.crossings[ci] = c;
        }
    }

    /// Cut a gentle approach apron into the shore at both ends of every bridge.
    ///
    /// The span is measured at the waterline, but the shore there is often a steep bank;
    /// without an embankment the deck would either end on an unwalkable ROCK cell or bury
    /// itself in a hillside. Only land at or above the waterline is touched, so a bridge can
    /// never turn into a land crossing.
    fn grade_abutments(&mut self) {
        /// Height the approach settles at, just under the 1.4 m deck surface.
        const RAMP_H: f32 = 1.25;
        /// Full-strength cutting around the abutment: everything within this radius is
        /// brought down to the approach height, so the deck lands in a graded notch instead
        /// of burying itself in the bank.
        const R_CUT: f32 = 6.5;
        /// Outer blend ring: feathers the cutting back into the natural bank.
        const R: f32 = 12.0;
        /// Deepest cut the cutting may make.
        const MAX_CUT: f32 = 9.0;
        /// Land above this is a hill, not a riverbank: leave it alone (the landmark hills are
        /// authored above 14 m, so this protects them).
        const MAX_TOUCH: f32 = 11.0;
        let ends: Vec<Vec2> = self
            .crossings
            .iter()
            .filter(|c| c.kind == CrossKind::Bridge)
            .flat_map(|c| [c.a, c.b])
            .collect();
        for end in ends {
            let i0 = ((end.x - R) / self.cell).floor().max(0.0) as i32;
            let i1 = ((end.x + R) / self.cell).ceil().min((self.v - 1) as f32) as i32;
            let j0 = ((end.y - R) / self.cell).floor().max(0.0) as i32;
            let j1 = ((end.y + R) / self.cell).ceil().min((self.v - 1) as f32) as i32;
            for iz in j0..=j1 {
                for ix in i0..=i1 {
                    let p = v2(ix as f32 * self.cell, iz as f32 * self.cell);
                    let d = p.dist(end);
                    if d > R {
                        continue;
                    }
                    let i = iz as usize * self.v + ix as usize;
                    let cur = self.h[i];
                    // Never touch the channel: filling it would make the bridge redundant.
                    if cur < -0.05 {
                        continue;
                    }
                    if cur > MAX_TOUCH {
                        continue;
                    }
                    let t = if d <= R_CUT {
                        0.97
                    } else {
                        (1.0 - smoothstep(R_CUT, R, d)) * 0.97
                    };
                    let blended = lerp(cur, RAMP_H, t).max(cur - MAX_CUT);
                    let hi = cur.max(RAMP_H);
                    self.h[i] = blended.clamp(0.45, hi);
                }
            }
        }
    }

    fn crossing_line(&self, ci: usize) -> Vec<Vec2> {
        let c = self.crossings[ci];
        let len = c.a.dist(c.b);
        let n = (len / (self.cell * 0.75)).ceil().max(1.0) as u32;
        (0..=n)
            .map(|k| c.a.lerp(c.b, k as f32 / n as f32))
            .collect()
    }

    /// Expand the authored node lists into dense polylines with per-sample semantics.
    fn build_routes(&mut self) {
        let plan_routes = self.plan.routes.clone();
        for r in &plan_routes {
            let mut pts: Vec<Vec2> = Vec::new();
            let mut kind: Vec<u8> = Vec::new();
            let mut prev: Option<Vec2> = None;
            for n in &r.nodes {
                match n {
                    Node::P(p) => {
                        if let Some(q) = prev {
                            push_line(&mut pts, &mut kind, q, *p, R_LAND);
                        } else {
                            pts.push(*p);
                            kind.push(R_LAND);
                        }
                        prev = Some(*p);
                    }
                    Node::X(i) => {
                        let line = self.crossing_line(*i);
                        let k = if self.crossings[*i].kind == CrossKind::Bridge {
                            R_BRIDGE
                        } else {
                            R_FORD
                        };
                        if let Some(q) = prev {
                            if let Some(first) = line.first() {
                                push_line(&mut pts, &mut kind, q, *first, R_LAND);
                                // the crossing's own first sample replaces the joint
                                pts.pop();
                                kind.pop();
                            }
                        }
                        for p in line.iter() {
                            pts.push(*p);
                            kind.push(k);
                        }
                        prev = line.last().cloned();
                    }
                }
            }
            self.routes.push(RouteLine { pts, kind });
        }
    }

    /// Flat coastal pads under the two bases: a full flatten in the middle, a soft blend
    /// ring outside. Shallow water is reclaimed so every slot on the pad is buildable.
    fn base_pads(&mut self) {
        for t in 0..2 {
            let b = self.plan.bases[t];
            let target = clamp(self.h_at(b.c.x, b.c.y), 1.4, 4.0);
            for iz in 0..self.v {
                for ix in 0..self.v {
                    let p = v2(ix as f32 * self.cell, iz as f32 * self.cell);
                    let d = p.dist(b.c);
                    if d > PAD_BLEND {
                        continue;
                    }
                    let i = iz * self.v + ix;
                    let w = 1.0 - smoothstep(PAD_R, PAD_BLEND, d);
                    if self.h[i] < 0.6 {
                        // Only reclaim the waterline; a deep channel keeps its bed, so the
                        // pad never grows a wall between itself and the sea.
                        if self.h[i] > -0.8 {
                            self.h[i] = lerp(self.h[i], 0.6, w);
                        }
                    } else {
                        self.h[i] = lerp(self.h[i], target, w);
                    }
                }
            }
        }
    }

    /// Shallow shelves at every crossing, then grade + lift the land parts of the routes.
    fn grade_routes(&mut self) {
        // 1) shoals first, so raising a ford cannot be undone
        for ci in 0..self.crossings.len() {
            let c = self.crossings[ci];
            let mid = c.a.lerp(c.b, 0.5);
            let dir = (c.b - c.a).norm();
            let (r, depth) = match c.kind {
                CrossKind::Bridge => (15.0f32, -0.45f32),
                CrossKind::Ford => (19.0, -0.50),
            };
            // The shoal exists to keep the water *under and beside* a deck shallow, so an
            // amphibious vehicle can ford at the narrows. It must never touch dry land:
            // scooping the shore is what drowned the bridge abutments (and left deck runs
            // ending over open water) before.
            let len = c.a.dist(c.b) * 0.5 + 4.0;
            let a = mid - dir * len;
            let b = mid + dir * len;
            for iz in 0..self.v {
                for ix in 0..self.v {
                    let p = v2(ix as f32 * self.cell, iz as f32 * self.cell);
                    let d = seg_dist(p, a, b) / r;
                    if d >= 1.0 {
                        continue;
                    }
                    let i = iz * self.v + ix;
                    if self.h[i] >= 0.55 {
                        continue;
                    }
                    let t = smoothstep(0.45, 1.0, d);
                    self.h[i] = self.h[i].min(lerp(depth, self.h[i], t));
                }
            }
        }
        // 2) grade and lift the routes
        for ri in 0..self.routes.len() {
            let n = self.routes[ri].pts.len();
            let mut ref_h: Vec<f32> = (0..n)
                .map(|i| {
                    let p = self.routes[ri].pts[i];
                    self.h_at(p.x, p.y)
                })
                .collect();
            let src = ref_h.clone();
            for i in 0..n {
                let lo = i.saturating_sub(3);
                let hi = (i + 3).min(n - 1);
                let mut sum = 0.0;
                let mut c = 0.0;
                for j in lo..=hi {
                    if self.routes[ri].kind[j] == R_BRIDGE {
                        continue;
                    }
                    sum += src[j];
                    c += 1.0;
                }
                if c > 0.0 {
                    ref_h[i] = sum / c;
                }
            }
            for i in 0..n {
                let k = self.routes[ri].kind[i];
                if k == R_BRIDGE {
                    continue;
                }
                let p = self.routes[ri].pts[i];
                let target = if k == R_FORD {
                    ref_h[i].max(0.62)
                } else {
                    ref_h[i].max(0.45)
                };
                let radius = if k == R_FORD { 4.5 } else { 3.2 };
                stamp_height(self, p, radius, target);
            }
        }
    }

    fn stamp_roads(&mut self) {
        for t in 0..2 {
            let c = self.plan.bases[t].c;
            self.paint_disc(c, 22.0, 250);
        }
        let roads = self.plan.roads.clone();
        for rd in &roads {
            let level = match rd.kind {
                RoadKind::Paved => 246,
                RoadKind::Road => 232,
                RoadKind::Track => 120,
            };
            for w in rd.pts.windows(2) {
                self.paint_road(w[0], w[1], rd.width * 0.5, level);
            }
        }
        // Routes last and brightest: these are the guaranteed lanes.
        let routes = self.routes.clone();
        for r in &routes {
            for i in 0..r.pts.len().saturating_sub(1) {
                let k0 = r.kind[i];
                let k1 = r.kind[i + 1];
                let (lvl, hw) = if k0 == R_BRIDGE || k1 == R_BRIDGE {
                    (255u8, 3.5f32)
                } else if k0 == R_FORD || k1 == R_FORD {
                    (150, 2.5)
                } else {
                    (255, 3.5)
                };
                self.paint_road(r.pts[i], r.pts[i + 1], hw, lvl);
            }
        }
    }

    /// Protected route cells: every sample plus its 4-neighbours (4-connected by construction).
    ///
    /// A cell that a solid structure occupies is **not** protected. The authored base
    /// complexes go down before the routes are reserved (so a base is never rejected by its
    /// own driveway), and on Coral Rim the ring route is authored straight across a base:
    /// stamping the lane regardless turned the perimeter wall into a passable hole in the
    /// nav grid, so the flow field drove the AI into a wall it could not collide through
    /// (measured: the audit driver wedged 20 m from its spawn). Letting the wall win means
    /// the field routes *around* the base, and if a route really has no alternative,
    /// `validate()` reports it instead of quietly building a trap.
    fn route_mask(&mut self) {
        // Cells covered by a solid, non-bridge structure.
        let mut solid = vec![false; self.gg * self.gg];
        let structs = self.structs.clone();
        for s in &structs {
            if !s.flag(sflag::SOLID) || s.flag(sflag::FLAT) || s.kind as u8 == skind::BRIDGE {
                continue;
            }
            // Same grown footprint `build_nav` uses to block cells, so "covered by a solid"
            // here and "blocked" there cannot disagree.
            let (sn, cs) = s.yaw.sin_cos();
            let hw = s.w * 0.5 + NAV_SHOULDER;
            let hd = s.d * 0.5 + NAV_SHOULDER;
            let ex = hw * cs.abs() + hd * sn.abs();
            let ez = hw * sn.abs() + hd * cs.abs();
            let c = s.pos();
            let x0 = ((c.x - ex) / self.cell).floor().max(0.0) as i32;
            let x1 = ((c.x + ex) / self.cell).ceil().min((self.gg - 1) as f32) as i32;
            let z0 = ((c.y - ez) / self.cell).floor().max(0.0) as i32;
            let z1 = ((c.y + ez) / self.cell).ceil().min((self.gg - 1) as f32) as i32;
            for cz in z0..=z1 {
                for cx in x0..=x1 {
                    let q = v2((cx as f32 + 0.5) * self.cell, (cz as f32 + 0.5) * self.cell);
                    if obb_sd(q, c, s.yaw, hw, hd) <= 0.0 {
                        solid[cz as usize * self.gg + cx as usize] = true;
                    }
                }
            }
        }
        for ri in 0..self.routes.len() {
            let n = self.routes[ri].pts.len();
            for k in 0..n {
                let p = self.routes[ri].pts[k];
                let cx = clamp((p.x / self.cell).floor(), 0.0, (self.gg - 1) as f32) as i32;
                let cz = clamp((p.y / self.cell).floor(), 0.0, (self.gg - 1) as f32) as i32;
                for (dx, dz) in [(0i32, 0i32), (1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let x = cx + dx;
                    let z = cz + dz;
                    if x < 0 || z < 0 || x >= self.gg as i32 || z >= self.gg as i32 {
                        continue;
                    }
                    let i = z as usize * self.gg + x as usize;
                    if solid[i] {
                        continue; // a wall is a wall, even where a route was drawn over it
                    }
                    self.route[i] = 1;
                }
            }
        }
        // Gate exit corridors: a short drivable lane running outward from each base's front
        // gate and rear sally port. Scattered props just outside an opening used to stamp a
        // shoulder + squeeze chain across it (measured: seed 7 Classic sealed both gates, the
        // LAND flow field never left either compound, and every ground vehicle HOLDed at base
        // for the whole match). Protected lanes promote to ROAD where there is land, reserve
        // their surroundings against later prop placement, and can never be re-sealed by
        // footprints or the squeeze rule.
        const HW: f32 = 4.0;
        const LEN: f32 = 22.0;
        for t in 0..2usize {
            let bd = &self.plan.bases[t];
            let anchor = bd.c;
            let yaw = bd.fwd.angle() - FRAC_PI_2;
            // The base's local axes in world space, matching `from_local`'s rotation exactly.
            // (Subtracting two from_local points gives the diagonal between them, not an axis
            // - the gate sits off the anchor, so that mis-shapes the lane into a slanted patch
            // through the compound instead of a lane running out of the opening.)
            let ax = v2(yaw.cos(), yaw.sin()); // local +x
            let ay = v2(-yaw.sin(), yaw.cos()); // local +y (front-gate outward)
            for (local, outward) in [(GATE_LOCAL, 1.0f32), (v2(SALLY_LX, -BASE_HZ), -1.0)] {
                let g = from_local(local, anchor, yaw);
                let out = ay * outward;
                let side = ax;
                let r = LEN + HW;
                let x0 = ((g.x - r) / self.cell).floor().max(0.0) as i32;
                let x1 = ((g.x + r) / self.cell).ceil().min((self.gg - 1) as f32) as i32;
                let z0 = ((g.y - r) / self.cell).floor().max(0.0) as i32;
                let z1 = ((g.y + r) / self.cell).ceil().min((self.gg - 1) as f32) as i32;
                for cz in z0..=z1 {
                    for cx in x0..=x1 {
                        let q = v2((cx as f32 + 0.5) * self.cell, (cz as f32 + 0.5) * self.cell);
                        let d = q - g;
                        if d.dot(out) < -4.0 || d.dot(out) > LEN || d.dot(side).abs() > HW {
                            continue;
                        }
                        let i = cz as usize * self.gg + cx as usize;
                        if solid[i] {
                            continue; // a wall is a wall, even where a corridor was drawn over it
                        }
                        self.route[i] = 1;
                    }
                }
            }
        }
    }

    /// Reserve the protected lanes (plus a metre of shoulder) for later placements.
    fn mark_route_occ(&mut self) {
        for cz in 0..self.gg {
            for cx in 0..self.gg {
                if self.route[cz * self.gg + cx] == 0 {
                    continue;
                }
                let p = v2((cx as f32 + 0.5) * self.cell, (cz as f32 + 0.5) * self.cell);
                let oi = ((p.x / self.occ_m) as i32).clamp(0, self.occ_n as i32 - 1) as usize;
                let oj = ((p.y / self.occ_m) as i32).clamp(0, self.occ_n as i32 - 1) as usize;
                for dz in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let x = oi as i32 + dx;
                        let y = oj as i32 + dz;
                        if x < 0 || y < 0 || x >= self.occ_n as i32 || y >= self.occ_n as i32 {
                            continue;
                        }
                        self.occ[y as usize * self.occ_n + x as usize] = 1;
                    }
                }
            }
        }
    }

    fn paint_disc(&mut self, c: Vec2, r: f32, level: u8) {
        let i0 = ((c.x - r) / self.cell).floor().max(0.0) as i32;
        let i1 = ((c.x + r) / self.cell).ceil().min((self.v - 1) as f32) as i32;
        let j0 = ((c.y - r) / self.cell).floor().max(0.0) as i32;
        let j1 = ((c.y + r) / self.cell).ceil().min((self.v - 1) as f32) as i32;
        for iz in j0..=j1 {
            for ix in i0..=i1 {
                let p = v2(ix as f32 * self.cell, iz as f32 * self.cell);
                let d = p.dist(c);
                if d > r + 4.0 {
                    continue;
                }
                let v = if d <= r {
                    level as f32
                } else {
                    lerp(level as f32, 0.0, smoothstep(r, r + 4.0, d))
                };
                let i = iz as usize * self.v + ix as usize;
                if v > self.road[i] as f32 {
                    self.road[i] = v as u8;
                }
            }
        }
    }

    fn paint_road(&mut self, a: Vec2, b: Vec2, hw: f32, level: u8) {
        let minx = a.x.min(b.x) - hw - 3.0;
        let maxx = a.x.max(b.x) + hw + 3.0;
        let minz = a.y.min(b.y) - hw - 3.0;
        let maxz = a.y.max(b.y) + hw + 3.0;
        let i0 = (minx / self.cell).floor().max(0.0) as i32;
        let i1 = (maxx / self.cell).ceil().min((self.v - 1) as f32) as i32;
        let j0 = (minz / self.cell).floor().max(0.0) as i32;
        let j1 = (maxz / self.cell).ceil().min((self.v - 1) as f32) as i32;
        for iz in j0..=j1 {
            for ix in i0..=i1 {
                let p = v2(ix as f32 * self.cell, iz as f32 * self.cell);
                let d = seg_dist(p, a, b);
                if d > hw + 3.0 {
                    continue;
                }
                let v = if d <= hw {
                    level as f32
                } else {
                    lerp(level as f32, 0.0, smoothstep(hw, hw + 3.0, d))
                };
                let i = iz as usize * self.v + ix as usize;
                if v > self.road[i] as f32 {
                    self.road[i] = v as u8;
                }
            }
        }
    }

    // -- structures -------------------------------------------------------

    fn occ_pt(&self, i: usize, j: usize) -> Vec2 {
        v2((i as f32 + 0.5) * self.occ_m, (j as f32 + 0.5) * self.occ_m)
    }

    fn occ_rect_ok(&self, p: Vec2, yaw: f32, hw: f32, hd: f32) -> bool {
        let (s, c) = yaw.sin_cos();
        let ex = hw * c.abs() + hd * s.abs();
        let ez = hw * s.abs() + hd * c.abs();
        let i0 = ((p.x - ex) / self.occ_m).floor().max(0.0) as i32;
        let i1 = ((p.x + ex) / self.occ_m).ceil().min((self.occ_n - 1) as f32) as i32;
        let j0 = ((p.y - ez) / self.occ_m).floor().max(0.0) as i32;
        let j1 = ((p.y + ez) / self.occ_m).ceil().min((self.occ_n - 1) as f32) as i32;
        for j in j0..=j1 {
            for i in i0..=i1 {
                if self.occ[j as usize * self.occ_n + i as usize] == 0 {
                    continue;
                }
                let q = self.occ_pt(i as usize, j as usize);
                if obb_sd(q, p, yaw, hw, hd) <= 0.0 {
                    return false;
                }
            }
        }
        true
    }

    fn occ_mark(&mut self, p: Vec2, yaw: f32, hw: f32, hd: f32) {
        let (s, c) = yaw.sin_cos();
        let ex = hw * c.abs() + hd * s.abs();
        let ez = hw * s.abs() + hd * c.abs();
        let i0 = ((p.x - ex) / self.occ_m).floor().max(0.0) as i32;
        let i1 = ((p.x + ex) / self.occ_m).ceil().min((self.occ_n - 1) as f32) as i32;
        let j0 = ((p.y - ez) / self.occ_m).floor().max(0.0) as i32;
        let j1 = ((p.y + ez) / self.occ_m).ceil().min((self.occ_n - 1) as f32) as i32;
        for j in j0..=j1 {
            for i in i0..=i1 {
                let q = self.occ_pt(i as usize, j as usize);
                if obb_sd(q, p, yaw, hw, hd) <= 0.0 {
                    self.occ[j as usize * self.occ_n + i as usize] = 1;
                }
            }
        }
    }

    fn can_place(&self, p: Vec2, yaw: f32, w: f32, d: f32, margin: f32, need_land: bool) -> bool {
        let hw = w * 0.5 + margin;
        let hd = d * 0.5 + margin;
        for corner in [v2(-hw, -hd), v2(hw, -hd), v2(hw, hd), v2(-hw, hd)] {
            let q = from_local(corner, p, yaw);
            if q.x < 1.0 || q.y < 1.0 || q.x > self.w - 1.0 || q.y > self.w - 1.0 {
                return false;
            }
        }
        if !self.occ_rect_ok(p, yaw, hw, hd) {
            return false;
        }
        // Reserved plazas (spawn pads, flag plazas, camp islets).
        if self.zone_check {
            for (z, r) in &self.plan.zones {
                if obb_sd(*z, p, yaw, hw, hd) < *r {
                    return false;
                }
            }
        }
        if need_land {
            for (lx, lz) in [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd), (0.0, 0.0)] {
                let q = from_local(v2(lx, lz), p, yaw);
                if self.h_at(q.x, q.y) < 0.28 {
                    return false;
                }
            }
        }
        true
    }

    /// Seat height for a scattered prop whose mesh touches the ground over a ring of radius
    /// `r` around `p` (see [`prop_contact_radius`]).
    ///
    /// The **lowest** sample is where a rigid prop actually rests: seating on the highest, as
    /// the nav footprint path does, guarantees the downhill side floats. `SINK` drops it a few
    /// centimetres so the downhill edge *intersects* the ground rather than only touching it.
    /// The ring is 8 samples at 45 deg so it is invariant under the world-centre reflection
    /// `enforce_symmetry` uses - the two mirrored placements evaluate the same sample pattern.
    fn prop_seat_y(&self, p: Vec2, r: f32) -> f32 {
        /// The downhill edge would otherwise be tangent to a bilinear facet and read as
        /// floating again; a few centimetres of burial is invisible on a boulder.
        const SINK: f32 = 0.04;
        let mut low = self.h_at(p.x, p.y);
        for k in 0..8 {
            let a = k as f32 * core::f32::consts::TAU / 8.0;
            low = low.min(self.h_at(p.x + a.cos() * r, p.y + a.sin() * r));
        }
        low - SINK
    }

    #[allow(clippy::too_many_arguments)]
    fn put_at(
        &mut self,
        kind: u8,
        team: u8,
        p: Vec2,
        yaw: f32,
        w: f32,
        d: f32,
        h: f32,
        flags: u32,
        margin: f32,
    ) -> bool {
        let need_land = kind != skind::BRIDGE;
        if !self.can_place(p, yaw, w, d, margin, need_land) {
            return false;
        }
        let y = if kind == skind::BRIDGE {
            // The drivable surface is y + h; keep it just above the waterline.
            (self.h_at(p.x, p.y).max(0.0) + 0.5).max(0.55)
        } else if prop_contact_radius(kind) > 0.0 {
            // A scattered prop is a true-scale authored mesh (boulder ~1-1.3 m across, palm
            // trunk ~0.3 m) sitting in a nav collision box up to 6 m across plus margin. Seat
            // it on the ground its *mesh* touches, not on the highest corner of the box: that
            // corner is metres uphill of a 1 m stone, so the downhill side hangs in the air
            // (measured p50 1.08 / max 5.73 m on Iron Strait before this).
            self.prop_seat_y(p, prop_contact_radius(kind))
        } else {
            // Authored buildings (and walls/bunkers, whose aprons are graded flat) keep the
            // footprint seat. For the few large authored props on raw ground this can still
            // leave the downhill side up to the footprint relief in the air (BUILDING / TENT /
            // ANTENNA measured ~1.4 m on Iron Strait), but the coarse terrain resolution would
            // bury a 13 m building metres into a slope if it were seated on the ring minimum
            // like a boulder, which reads far worse than the float. The scattered kinds above
            // are the ones the report is about.
            let probe = Structure::new(kind, team, p, 0.0, yaw, w, d, h);
            let corners = obb_corners(&probe);
            let mut top = self.h_at(p.x, p.y);
            for q in corners.iter() {
                top = top.max(self.h_at(q.x, q.y));
            }
            top.max(0.30)
        };
        let mut s = Structure::new(kind, team, p, y, yaw, w, d, h);
        s.hp_max = hp_for(kind);
        s.hp = s.hp_max;
        s.flags = flags as f32;
        self.occ_mark(p, yaw, w * 0.5 + margin, d * 0.5 + margin);
        self.structs.push(s);
        true
    }

    /// Place a bridge deck unconditionally.
    ///
    /// Bridges are load-bearing infrastructure: unlike scenery they may not be silently
    /// dropped when the occupancy sweep is busy, and they use one constant deck height so a
    /// vehicle never steps between neighbouring pieces.
    #[allow(clippy::too_many_arguments)]
    fn force_bridge(&mut self, p: Vec2, yaw: f32, w: f32, d: f32, flags: u32, team: u8) {
        const DECK_Y: f32 = 0.5; // drivable surface = y + h = 1.4 m
        let probe = Structure::new(skind::BRIDGE, team, p, DECK_Y, yaw, w, d, 0.9);
        // Anything solid that would sit on the deck has to go.
        let mut i = 0;
        while i < self.structs.len() {
            let s = self.structs[i];
            let blocks = s.flag(sflag::SOLID)
                && !s.flag(sflag::FLAT)
                && s.kind as u8 != skind::BRIDGE
                && probe.dist_to(s.pos()) < 0.5
                && s.dist_to(p) < 0.5;
            if blocks {
                self.structs.remove(i);
                continue;
            }
            i += 1;
        }
        let mut s = Structure::new(skind::BRIDGE, team, p, DECK_Y, yaw, w, d, 0.9);
        s.hp_max = hp_for(skind::BRIDGE);
        s.hp = s.hp_max;
        s.flags = flags as f32;
        self.structs.push(s);
        // Reserve the deck and its shoulders so base buildings are never placed on the
        // roadway (they are laid out after the crossings).
        self.occ_mark(p, yaw, w * 0.5 + 2.0, d * 0.5 + 2.0);
    }

    /// Force the protected-lane mask over every deck footprint (plus a shoulder), so the
    /// deck corridor is always `ROAD` in the nav grid no matter where the approach road sits.
    fn stamp_deck_route(&mut self) {
        let decks: Vec<Structure> = self
            .structs
            .iter()
            .filter(|s| s.kind as u8 == skind::BRIDGE)
            .cloned()
            .collect();
        for s in decks {
            let c = s.pos();
            // Pad by half a cell diagonal so a cell the deck only partially covers is still
            // marked drivable - testing cell centres alone leaves a walkable-looking gap at
            // the very end of the run.
            let hw = s.w * 0.5 + 1.45;
            let hd = s.d * 0.5 + 1.45;
            let (sn, cs) = s.yaw.sin_cos();
            let ex = hw * cs.abs() + hd * sn.abs();
            let ez = hw * sn.abs() + hd * cs.abs();
            let x0 = ((c.x - ex) / self.cell).floor().max(0.0) as i32;
            let x1 = ((c.x + ex) / self.cell).ceil().min((self.gg - 1) as f32) as i32;
            let z0 = ((c.y - ez) / self.cell).floor().max(0.0) as i32;
            let z1 = ((c.y + ez) / self.cell).ceil().min((self.gg - 1) as f32) as i32;
            for cz in z0..=z1 {
                for cx in x0..=x1 {
                    let q = v2((cx as f32 + 0.5) * self.cell, (cz as f32 + 0.5) * self.cell);
                    if obb_sd(q, c, s.yaw, hw, hd) <= 0.0 {
                        self.route[cz as usize * self.gg + cx as usize] = 1;
                    }
                }
            }
        }
    }

    /// Finish grading the protected lanes once the crossings are final.
    ///
    /// The contract in this module's header is that water on a route only ever happens across
    /// a bridge deck. `grade_routes` tries to honour it, but it runs *before*
    /// `resolve_crossings_final` re-measures and re-lays the crossings and before the last
    /// `limit_slopes`, so what it leaves is not always real land. Measured on map 3
    /// "Shattered Keys": the west ford is above water for a few cells at each abutment and
    /// SHALLOW water in the middle (h as low as -1.5 m) for a 14 m stretch. Rasterised
    /// naively that lane is still `ROAD`, so the LAND flow field offers a non-amphibious hull
    /// a route it cannot physically drive - physics shoves it back out of the water - and the
    /// AI never takes the intact bridge beside it.
    ///
    /// Lift every protected-lane cell still at or below the waterline to a drivable shelf
    /// here. Cells a deck spans are left alone: the deck is the crossing there, and filling
    /// its channel would both make it decorative and leave a drivable lane through its
    /// footprint after it is destroyed. `grade_routes`' `stamp_height` smooths the shelf into
    /// the water so the lane has drivable banks rather than a wall.
    fn grade_protected_lanes(&mut self) {
        /// Drivable shelf for a lane that has to cross water: above `WATER_LEVEL`, below the
        /// sand/road classification boundary, matching `grade_routes`' own ford target.
        const LANE_H: f32 = 0.6;
        /// `build_nav`'s dry/water split: a vertex at or below this is SHALLOW_WATER and never
        /// `LAND`-passable, however drivable it looks.
        const WET: f32 = 0.05;
        // Which vertices this pass turns from water into land, sampled before anything is
        // stamped. The causeway it leaves behind must not be painted as asphalt (see
        // `lifted`), and "was wet, is now dry" is exactly that set - including the soft
        // stamped banks, not just the lane cores.
        let wet: Vec<bool> = self.h.iter().map(|h| *h <= WET).collect();
        // The same 1.45 m shoulder `stamp_deck_route` marks as the crossing.
        let decks: Vec<Structure> = self
            .structs
            .iter()
            .filter(|s| s.kind as u8 == skind::BRIDGE)
            .cloned()
            .collect();
        // Keep a full deck-width berth clear. `combat::block_footprint` marks every deck cell
        // within `cell * 0.75` when the deck dies, and `route_mask` claims a shoulder beyond
        // that; if any of those cells were graded to land, a raised bypass would survive the
        // bridge's destruction and the map would stay crossable over the gap. Measured
        // uncovered route-water cells sit up to 3.6 m off a deck, so 4.5 m (deck half-width
        // plus a metre) clears the block footprint and the shoulder with margin.
        let deck_near = |p: Vec2| decks.iter().any(|s| s.dist_to(p) <= 4.5);
        // `build_nav` classifies h < 0.05 as SHALLOW_WATER (never LAND-passable), so that -
        // not `WATER_LEVEL` - is the height a lane has to clear. A cell sitting a centimetre
        // above the waterline is still a "wet sandbar" the field refuses and a crudely-driven
        // hull beaches on.
        let low = |g: &Gen, cx: i32, cz: i32| {
            let p = v2((cx as f32 + 0.5) * self.cell, (cz as f32 + 0.5) * self.cell);
            g.h_at(p.x, p.y) < 0.05 && !deck_near(p)
        };
        // Mark the lane cells and one cell either side: a one-cell (2 m) corridor is not
        // drivable by a 3.6 m-wide tank, and a crude field-follower will beach on its edge
        // (measured on map 3 at (124,70): a 1-cell causeway row, the tank one cell off it in
        // the shallows and permanently wedged). The neighbours are the same corridor
        // `route_mask` already claims with its 4-neighbour stamp.
        let mut lane = vec![false; self.gg * self.gg];
        for cz in 0..self.gg as i32 {
            for cx in 0..self.gg as i32 {
                if self.route[cz as usize * self.gg + cx as usize] == 0 || !low(self, cx, cz) {
                    continue;
                }
                for (dx, dz) in [(0i32, 0i32), (1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, nz) = (cx + dx, cz + dz);
                    if nx < 0 || nz < 0 || nx >= self.gg as i32 || nz >= self.gg as i32 {
                        continue;
                    }
                    if low(self, nx, nz) {
                        lane[nz as usize * self.gg + nx as usize] = true;
                    }
                }
            }
        }
        // Designed fords get their whole crossing line so the sandbar is continuous across
        // the channel even where the route mask is only one cell wide.
        let ford_lines: Vec<Vec<Vec2>> = (0..self.crossings.len())
            .filter(|ci| self.crossings[*ci].kind == CrossKind::Ford)
            .map(|ci| self.crossing_line(ci))
            .collect();
        // Smooth the shelf into the water first (drivable banks, not a wall)...
        for cz in 0..self.gg as i32 {
            for cx in 0..self.gg as i32 {
                if lane[cz as usize * self.gg + cx as usize] {
                    let p = v2((cx as f32 + 0.5) * self.cell, (cz as f32 + 0.5) * self.cell);
                    stamp_height(self, p, 3.5, LANE_H);
                }
            }
        }
        for line in &ford_lines {
            for p in line {
                stamp_height(self, *p, 4.5, LANE_H);
                // Wide dry approach: the per-point grade above only reaches ~4-6 m off the
                // crossing line, but a field-follower approaches a ford up to ~10 m off it
                // (measured on map 2 seed 1: the garrison tank's approach ran 9 m south of the
                // strait crossing and stalled in a 7 cm water film the LAND field calls
                // impassable, while its zero-field fallback steered it straight into the
                // channel). Jittered shorelines wander by a couple of metres, so the off-lane
                // approach must be guaranteed dry, not merely graded. Raise-only (never shaves
                // the banks) and iterated, because one smoothstep-falloff pass leaves edge
                // cells below the 0.05 wet threshold.
                stamp_ford_approach(self, *p, LANE_H);
            }
        }
        // ...then guarantee the lane itself clears the shallow-water classification. The
        // soft stamp alone can leave an edge cell at h = -0.1 after one pass, which the nav
        // grid still calls water.
        for cz in 0..self.gg as i32 {
            for cx in 0..self.gg as i32 {
                if !lane[cz as usize * self.gg + cx as usize] {
                    continue;
                }
                for (vx, vz) in [(cx, cz), (cx + 1, cz), (cx, cz + 1), (cx + 1, cz + 1)] {
                    let i = vz as usize * self.v + vx as usize;
                    if self.h[i] < LANE_H {
                        self.h[i] = LANE_H;
                    }
                }
            }
        }
        // Symmetrise as it is recorded. `enforce_symmetry` runs later and copies the canonical
        // half of every field onto its mirror, so a pair that disagreed would come out of the
        // scrub paved on one side of the map and bare on the other. The route mask is
        // rasterised, so a handful of pairs really do disagree by a cell - but the terrain
        // they describe is mirror-identical (the height field is already symmetric here), so
        // a pair counts as lifted when either half is.
        for iz in 0..self.v {
            for ix in 0..self.v {
                let i = iz * self.v + ix;
                if !(wet[i] && self.h[i] > WET) {
                    continue;
                }
                let j = (self.v - 1 - iz) * self.v + (self.v - 1 - ix);
                self.lifted[i] = true;
                self.lifted[j] = true;
            }
        }
    }

    /// Keep asphalt off the lanes [`Gen::grade_protected_lanes`] lifted out of the water.
    ///
    /// A lane raised from below the waterline to a 0.6 m shelf is a *ford*: the sandbar the
    /// `grade_routes` comment already describes. It keeps the route mask, so it was painted
    /// at the route's 255 asphalt level, and a bright grey strip standing in the sea reads as
    /// a stone causeway - exactly the artefact this exists to remove.
    ///
    /// The mask is cleared *here*, and not where the lift happens, because every reader
    /// between those two points wants the old answer: `mark_road_occ` keeps structures off
    /// asphalt (stop reserving the lane and a scattered boulder can seal the only dry way
    /// across the strait), `on_road` keeps scatter off it, and `build_nav` reads it as its
    /// `ROAD` class - the cheap, protected lane the AI should prefer. Only what the surface
    /// shader bakes changes.
    /// Clear the asphalt mask wherever pavement would otherwise stand in — or within a short
    /// walk of — water.
    ///
    /// Three cases:
    /// * a *lifted* lane, which `grade_protected_lanes` raised out of the water so a route can
    ///   cross a ford: the geometry is now a sandbar and should read as one;
    /// * any road vertex below the waterline, which is a road polyline running into the sea;
    /// * any road vertex within [`ROAD_WATER_SETBACK`] of water, because a road hugging the
    ///   shoreline looks wrong even when it is technically on dry ground. A bridge approach is
    ///   exempt, since a road *has* to reach the abutment to use the deck.
    ///
    /// The mask is read by occupancy and by `build_nav` (both of which run *before* this), so
    /// cleared lanes are still reserved, still structure-free and still preferred routes; only
    /// the visual mask changes.
    /// Distance from every terrain vertex to the nearest water vertex, in metres. See
    /// [`water_clearance_of`].
    fn water_clearance(&self) -> Vec<f32> {
        water_clearance_of(&self.h, self.v, self.cell)
    }

    /// Trim the plan's roads against the terrain that actually ships.
    ///
    /// The plan-level prune runs before the island exists and has to *estimate* the waterline
    /// (`plan_height` plus `WATER_SLACK` for the domain warp). Whatever it gets wrong, the
    /// asphalt scrub then cuts for real — and a road cut at the shoreline is a road that stops
    /// in the middle of nowhere, which is the reported "dead ends are back". Trimming here,
    /// against the final height field and the scrub's own criterion, means the polyline ends
    /// where the pavement ends: back at its last junction.
    fn trim_roads_to_dry_ground(&mut self) {
        /// A road leading onto a bridge has to be able to reach the abutment.
        const APPROACH: f32 = 15.0;
        let clear = self.water_clearance();
        let n = self.v;
        let cell = self.cell;
        let approaches: Vec<Vec2> = self
            .crossings
            .iter()
            .flat_map(|c| [c.a, c.b])
            .collect();
        let mut protect: Vec<Vec2> = Vec::new();
        for t in 0..2usize {
            protect.push(self.plan.bases[t].loc(GATE_LOCAL.x, GATE_LOCAL.y));
        }
        protect.extend(approaches.iter().copied());
        let h = self.h.clone();
        let on_land = move |p: Vec2| {
            let ix = ((p.x / cell).floor() as i32).clamp(0, n as i32 - 1) as usize;
            let iz = ((p.y / cell).floor() as i32).clamp(0, n as i32 - 1) as usize;
            let i = iz * n + ix;
            if approaches.iter().any(|a| a.dist(p) <= APPROACH) {
                return true; // dry land by a bridge may reach the abutment
            }
            h[i] >= 0.05 && clear[i] >= ROAD_WATER_SETBACK
        };
        self.plan.prune_road_dead_ends(&protect, &on_land);
    }

    fn scrub_lifted_road(&mut self) {
        /// A little above `build_nav`'s 0.05 water threshold: below this the vertex is water.
        const WATER: f32 = 0.05;
        /// A road leading onto a bridge has to be able to reach the abutment.
        const APPROACH: f32 = 15.0;

        let n = self.v;
        let dist = self.water_clearance();

        // Bridge abutments: the resolved spans' land ends, where pavement is allowed to come
        // right up to the water so a road can actually use the deck.
        let approaches: Vec<Vec2> = self
            .crossings
            .iter()
            .flat_map(|c| [c.a, c.b])
            .collect();

        for iz in 0..n {
            for ix in 0..n {
                let i = iz * n + ix;
                if self.lifted[i] {
                    self.road[i] = 0;
                    continue;
                }
                // Water is never paved, with no exception: the deck is a structure mesh and
                // carries its own surface, so the ground beneath it stays water. Exempting the
                // whole abutment radius instead of just its land side left a concrete strip in
                // the channel under every deck.
                if self.h[i] < WATER {
                    self.road[i] = 0;
                    continue;
                }
                if dist[i] >= ROAD_WATER_SETBACK {
                    continue;
                }
                let p = v2(ix as f32 * self.cell, iz as f32 * self.cell);
                if approaches.iter().any(|a| a.dist(p) <= APPROACH) {
                    continue; // dry land by a bridge may reach the abutment
                }
                self.road[i] = 0;
            }
        }
    }

    /// Place a piece and its mirror image (same kind, opposite team).
    ///
    /// In an unmirrored (procedural) plan there is no image to place: the piece goes down once
    /// exactly as authored, keeping its own team.
    #[allow(clippy::too_many_arguments)]
    fn put_sym(
        &mut self,
        kind: u8,
        team: u8,
        p: Vec2,
        yaw: f32,
        w: f32,
        d: f32,
        h: f32,
        flags: u32,
        margin: f32,
    ) -> bool {
        if !self.plan.mirror {
            return self.put_at(kind, team, p, yaw, w, d, h, flags, margin);
        }
        let p2 = mir(p, self.w);
        let yaw2 = yaw + PI;
        if p.dist(p2) < 0.75 {
            return self.put_at(kind, team, p, yaw, w, d, h, flags, margin);
        }
        let need_land = kind != skind::BRIDGE;
        if !self.can_place(p, yaw, w, d, margin, need_land)
            || !self.can_place(p2, yaw2, w, d, margin, need_land)
        {
            return false;
        }
        let a = self.put_at(kind, team, p, yaw, w, d, h, flags, margin);
        let b = self.put_at(kind, team_other(team), p2, yaw2, w, d, h, flags, margin);
        a && b
    }

    fn place_crossings(&mut self) {
        let n = self.crossings.len();
        for ci in 0..n {
            let c = self.crossings[ci];
            if c.kind != CrossKind::Bridge {
                continue;
            }
            let axis = (c.b - c.a).norm();
            let yaw = axis.angle();
            let span = c.a.dist(c.b).max(12.0);
            // A contiguous chain: pieces abut exactly (plus a small visual overlap), so the
            // run can never contain a gap a vehicle would fall through.
            let pieces = ((span / 20.0).ceil() as u32).clamp(2, 6);
            let per = span / pieces as f32;
            let mut p = c.a + axis * (per * 0.5);
            for _ in 0..pieces {
                // Mirrored plans split decks between the two teams along the anti-diagonal;
                // an unmirrored plan has no such axis, so its decks stay neutral.
                let team = if !self.plan.mirror || p.dist(mir(p, self.w)) < 6.0 {
                    2
                } else if p.x + p.y <= self.w {
                    0
                } else {
                    1
                };
                let flags = sflag::SOLID | sflag::DESTRUCTIBLE | sflag::BLOCKS_LOS;
                self.force_bridge(p, yaw, per + 0.4, 7.0, flags, team);
                p += axis * per;
            }
        }
    }

    fn base_try(
        &mut self,
        ctx: &BaseCtx,
        lx: f32,
        lz: f32,
        w: f32,
        d: f32,
        h: f32,
        kind: u8,
        flags: u32,
        margin: f32,
    ) -> bool {
        let p = ctx.bd.loc(lx, lz);
        let yaw = ctx.bd.yaw(0.0);
        self.put_at(kind, ctx.bd.team, p, yaw, w, d, h, flags, margin)
    }

    /// Try the preferred slots, then a deterministic sweep of the pad, so a mandatory
    /// building always lands somewhere sensible on the flat base pad.
    #[allow(clippy::too_many_arguments)]
    fn base_place(
        &mut self,
        ctx: &BaseCtx,
        kind: u8,
        w: f32,
        d: f32,
        h: f32,
        flags: u32,
        margin: f32,
        prefer: &[(f32, f32)],
        mode: u8,
    ) -> Option<Vec2> {
        for (lx, lz) in prefer {
            if ctx.fits(*lx, *lz, w, d, mode)
                && self.base_try(ctx, *lx, *lz, w, d, h, kind, flags, margin)
            {
                return Some(v2(*lx, *lz));
            }
        }
        let (rx, rz) = if mode == 1 {
            (BASE_HX + 14.0, BASE_HZ + 12.0)
        } else {
            (BASE_HX - 1.0, BASE_HZ - 1.0)
        };
        let mut lz = -rz;
        while lz <= rz {
            let mut lx = -rx;
            while lx <= rx {
                if ctx.fits(lx, lz, w, d, mode)
                    && self.base_try(ctx, lx, lz, w, d, h, kind, flags, margin)
                {
                    return Some(v2(lx, lz));
                }
                lx += 3.0;
            }
            lz += 3.0;
        }
        None
    }

    fn place_base(&mut self, t: usize) {
        self.zone_check = false;
        let bd = self.plan.bases[t];
        let team = bd.team;
        let ctx = BaseCtx {
            bd,
            // The driveway is deliberately wider than the vehicle that uses it: the flow
            // field is a coarse 2 m grid and a car that drifts a few metres off the lane
            // used to clip a bunker and wedge inside its own base (measured: the naive
            // audit driver gave up 12 m from the spawn on Coral Rim). Keeping the middle of
            // the apron clear is what makes a base drivable for the AI as well as a player.
            lane: (
                SPAWN_LX - 5.5,
                SPAWN_LZ - 3.0,
                SPAWN_LX + 7.5,
                BASE_HZ + 4.0,
            ),
            plaza: (FLAG_LX, FLAG_LZ),
            // A procedural plan lays its base structures on whatever ground the island gave it, so
            // a slot that fits on one island lands on the spawn -> flag strip on another. The
            // authored mirror layouts were fitted by hand and their bunkers are deliberate, and
            // they pass the reachability check on their own, so they keep their layouts.
            spawn_lane: if self.plan.mirror { 0.0 } else { SPAWN_LANE_CLEAR },
        };

        // Garage: wide open bay facing the enemy, spawn pad right outside the door.
        self.base_place(
            &ctx,
            skind::GARAGE,
            GARAGE_W,
            GARAGE_D,
            5.2,
            B_SOLID | sflag::BAY | sflag::REPAIR,
            0.7,
            &[
                (GARAGE_LX, GARAGE_LZ),
                (GARAGE_LX, GARAGE_LZ + 2.5),
                (GARAGE_LX - 3.0, GARAGE_LZ),
                (GARAGE_LX + 3.0, GARAGE_LZ),
                (-1.0, -12.0),
            ],
            0,
        );
        // Helipad: the biggest pad in the base, so it gets its pick of the ground.
        self.base_place(
            &ctx,
            skind::HELIPAD,
            11.0,
            11.0,
            0.4,
            // No `DESTRUCTIBLE`: a helipad is a floor marking, and `kind_flags` - the table the
            // editor stamps from and `normalize_map` backfills with - has never listed it. The
            // flag was inert (a FLAT structure is invisible to every damage path, which reach
            // structures only through the solid-only grid and re-check `solid()`), but it read as
            // though a pad could be blown up, and it disagreed with the same pad on an edited map.
            sflag::FLAT | sflag::FUEL | sflag::AMMO | sflag::REPAIR,
            0.4,
            &[(17.0, 6.0), (17.0, -6.0), (-17.0, 4.0), (0.0, 14.0)],
            0,
        );
        // Control tower.
        self.base_place(
            &ctx,
            skind::HQ,
            10.0,
            8.5,
            11.5,
            B_SOLID | sflag::EMISSIVE,
            0.7,
            &[(12.5, -11.0), (13.0, -7.0), (14.0, 4.0), (-16.0, -11.0)],
            0,
        );
        // Flag pole: FLAT and not solid, so vehicles can drive onto the stand. Placed at the
        // exact flag home the plan advertises.
        self.put_at(
            skind::FLAG_POLE,
            team,
            bd.loc(FLAG_LX, FLAG_LZ),
            bd.yaw(0.0),
            1.3,
            1.3,
            15.0,
            // Same reasoning as the helipad below: flat, and not in `kind_flags`' destructible
            // list, so the flag could never be acted on.
            sflag::EMISSIVE | sflag::FLAT,
            0.4,
        );
        // Fuel dump and ammo tent.
        self.base_place(
            &ctx,
            skind::FUEL_DEPOT,
            8.5,
            6.5,
            3.4,
            B_SOLID | sflag::FUEL,
            0.7,
            &[(-16.0, -2.0), (-16.0, 3.0), (-15.0, -6.0), (17.0, -6.0)],
            0,
        );
        self.base_place(
            &ctx,
            skind::AMMO_TENT,
            8.0,
            5.5,
            3.2,
            B_SOLID | sflag::AMMO,
            0.7,
            &[(15.0, 12.0), (-15.0, 12.0), (16.0, 5.0), (-16.0, 8.0)],
            0,
        );
        // Watchtower and radar.
        self.base_place(
            &ctx,
            skind::WATCHTOWER,
            5.0,
            5.0,
            9.5,
            B_SOLID | sflag::EMISSIVE,
            0.6,
            &[(-17.0, 8.0), (17.0, -12.0), (-17.0, -12.0)],
            0,
        );
        self.base_place(
            &ctx,
            skind::RADAR,
            6.5,
            6.5,
            9.0,
            B_SOLID | sflag::EMISSIVE,
            0.6,
            &[(-14.0, -13.0), (17.0, -3.0), (-16.0, 13.0)],
            0,
        );
        // Bunkers covering the approaches.
        for (k, prefer) in [
            (0usize, [(-18.0f32, 13.0f32), (-18.0, 6.0), (-19.0, 0.0)]),
            (1, [(18.0, 13.0), (18.0, 3.0), (19.0, -6.0)]),
            (2, [(6.0, -14.0), (-2.0, 14.0), (10.0, 14.0)]),
        ] {
            let _ = k;
            self.base_place(
                &ctx,
                skind::BUNKER,
                6.5,
                5.5,
                2.4,
                B_SOLID,
                0.6,
                &prefer,
                0,
            );
        }
        // Turret towers watching the gate and the flanks (outside the walls).
        // Flank emplacements first: they stand on open ground, so a tower always has a
        // clear line of fire to anything closing on it (the gate pair comes next).
        for prefer in [
            [(30.0, -2.0), (30.0, -10.0), (30.0, 8.0)],
            [(-15.0f32, 24.0f32), (-15.0, 22.0), (-10.0, 24.0)],
            [(2.0, 24.0), (6.0, 23.0), (-2.0, 24.0)],
        ] {
            self.base_place(
                &ctx,
                skind::TURRET_TOWER,
                3.2,
                3.2,
                4.5,
                B_SOLID,
                0.8,
                &prefer,
                1,
            );
        }
        // A store tent per base.
        self.base_place(
            &ctx,
            skind::TENT,
            6.0,
            5.0,
            2.6,
            B_SOLID,
            0.5,
            &[(-17.0, 14.0), (17.0, 14.0), (-17.0, -16.0), (20.0, -14.0)],
            0,
        );
        // Sandbag nests, then a few doodads.
        for prefer in [[(-19.0f32, 9.0f32), (-18.0, 4.0)], [(19.0, -1.0), (18.0, -9.0)]] {
            self.base_place(
                &ctx,
                skind::SANDBAG,
                4.0,
                1.4,
                1.0,
                sflag::SOLID | sflag::DESTRUCTIBLE,
                0.3,
                &prefer,
                0,
            );
        }
        for (kind, w, d, h, prefer) in [
            (
                skind::CRATE,
                2.2f32,
                2.2f32,
                2.0f32,
                [(-3.0f32, -6.0f32), (3.0, -8.0), (-10.0, 14.0)],
            ),
            (
                skind::CRATE,
                2.2,
                2.2,
                2.0,
                [(-1.0, -6.5), (4.0, -9.0), (-12.0, 14.0)],
            ),
            (
                skind::BARREL,
                1.4,
                1.4,
                1.6,
                [(-19.0, -4.0), (8.0, -14.0), (-5.0, 14.0)],
            ),
            (
                skind::BARREL,
                1.4,
                1.4,
                1.6,
                [(-19.0, -2.5), (7.0, -13.0), (-8.0, 14.5)],
            ),
            (
                skind::CONTAINER,
                6.5,
                2.8,
                2.7,
                [(20.0, 8.0), (-20.0, -8.0), (20.0, -12.0)],
            ),
        ] {
            self.base_place(&ctx, kind, w, d, h, B_WALL, 0.5, &prefer, 0);
        }
        // Perimeter last, exactly where the wall line used to be built: the base layout
        // above (and therefore every behaviour that depends on it) is unchanged.
        self.build_perimeter(t);
        self.zone_check = true;
    }

    /// Height of the flat pad a base stands on (the pads are levelled before placement).
    fn pad_height(&self, t: usize) -> f32 {
        let c = self.plan.bases[t].c;
        clamp(self.h_at(c.x, c.y), 0.6, 6.0)
    }

    /// Place a perimeter piece unconditionally.
    ///
    /// `put_at_y` refuses a piece whose footprint clashes with something already placed, and the
    /// perimeter ignored its result — so one overlapping bunker silently left a **hole in the
    /// base wall**, visible in game. The perimeter is not optional: it goes down regardless and
    /// reserves its footprint. Only the world edge can still refuse a piece.
    #[allow(clippy::too_many_arguments)]
    fn force_wall_at_y(
        &mut self,
        kind: u8,
        team: u8,
        p: Vec2,
        yaw: f32,
        w: f32,
        d: f32,
        h: f32,
        flags: u32,
        y: f32,
    ) {
        let (hw, hd) = (w * 0.5, d * 0.5);
        for corner in [v2(-hw, -hd), v2(hw, -hd), v2(hw, hd), v2(-hw, hd)] {
            let q = from_local(corner, p, yaw);
            if q.x < 1.0 || q.y < 1.0 || q.x > self.w - 1.0 || q.y > self.w - 1.0 {
                return;
            }
        }
        let mut s = Structure::new(kind, team, p, y, yaw, w, d, h);
        s.hp_max = hp_for(kind);
        s.hp = s.hp_max;
        s.flags = flags as f32;
        self.occ_mark(p, yaw, hw, hd);
        self.structs.push(s);
    }

    /// Tile one straight local-space run with wall segments that share endpoints exactly.
    ///
    /// The band is divided into `n` *equal* segments, so segment `k` ends exactly where
    /// segment `k+1` starts: no gap, no overlap, one yaw and one ground line for the whole
    /// run. `gaps` are openings in metres measured from `a` along the run.
    fn wall_run_local(&mut self, t: usize, a: Vec2, b: Vec2, gaps: &[(f32, f32)], y: f32) {
        let bd = self.plan.bases[t];
        let d = b - a;
        let len = d.len();
        if len < 1e-3 {
            return;
        }
        let dir = d / len;
        let yaw = bd.yaw(dir.angle());

        // Solid bands between the openings.
        let mut bands: Vec<(f32, f32)> = Vec::new();
        let mut cursor = 0.0f32;
        let mut sorted: Vec<(f32, f32)> = gaps.to_vec();
        sorted.sort_by(|x, z| x.0.partial_cmp(&z.0).unwrap_or(core::cmp::Ordering::Equal));
        for (g0, g1) in sorted {
            if g0 > cursor {
                bands.push((cursor, g0.min(len)));
            }
            cursor = cursor.max(g1);
        }
        if cursor < len {
            bands.push((cursor, len));
        }

        for (b0, b1) in bands {
            let blen = b1 - b0;
            if blen < 0.30 {
                continue; // a sliver next to an opening is not a wall
            }
            let n = (blen / WALL_MAX_SEG).ceil().max(1.0) as u32;
            let seg = blen / n as f32;
            for k in 0..n {
                let mid = b0 + (k as f32 + 0.5) * seg;
                let c = a + dir * mid;
                self.force_wall_at_y(
                    skind::WALL,
                    bd.team,
                    bd.loc(c.x, c.y),
                    yaw,
                    seg,
                    WALL_THICK,
                    WALL_H,
                    B_WALL,
                    y,
                );
            }
        }
    }

    /// One base perimeter: a rectangle of four straight runs plus a square corner post at each
    /// corner. The runs stop half a wall thickness short of the corner point and the post fills
    /// that square, so the band is continuous with neither a gap nor an overlap, and both runs
    /// of a corner butt into the same post. One `y` for the whole perimeter means neighbouring
    /// segments cannot step vertically.
    fn build_perimeter(&mut self, t: usize) {
        let bd = self.plan.bases[t];
        let y = self.pad_height(t);
        let (hx, hz, h) = (BASE_HX, BASE_HZ, WALL_HALF);
        let post = |g: &mut Gen, lx: f32, lz: f32, la: f32| {
            g.force_wall_at_y(
                skind::WALL,
                bd.team,
                bd.loc(lx, lz),
                bd.yaw(la),
                WALL_THICK,
                WALL_THICK,
                WALL_H,
                B_WALL,
                y,
            );
        };

        // Front (+z, facing the enemy): full width, with the main gate.
        let a = v2(-hx + h, hz);
        let b = v2(hx - h, hz);
        let gap = |lx: f32, a: Vec2, b: Vec2| -> (f32, f32) {
            let d = (b - a).norm();
            let s = |p: Vec2| (p - a).dot(d);
            (
                s(v2(lx - GATE_OPEN * 0.5, a.y)).min(s(v2(lx + GATE_OPEN * 0.5, a.y))),
                s(v2(lx - GATE_OPEN * 0.5, a.y)).max(s(v2(lx + GATE_OPEN * 0.5, a.y))),
            )
        };
        self.wall_run_local(t, a, b, &[gap(GATE_LX, a, b)], y);
        post(self, -hx, hz, 0.0);
        post(self, hx, hz, 0.0);

        // Back (-z): full width, with a rear sally port.
        let a = v2(hx - h, -hz);
        let b = v2(-hx + h, -hz);
        let d = (b - a).norm();
        let s_of = |p: Vec2| (p - a).dot(d);
        let g0 = s_of(v2(SALLY_LX + GATE_OPEN * 0.5, a.y));
        let g1 = s_of(v2(SALLY_LX - GATE_OPEN * 0.5, a.y));
        self.wall_run_local(t, a, b, &[(g0.min(g1), g0.max(g1))], y);

        // Sides: inset by half a thickness at both ends so the corner posts fill the corners.
        self.wall_run_local(t, v2(-hx, -hz + h), v2(-hx, hz - h), &[], y);
        self.wall_run_local(t, v2(hx, hz - h), v2(hx, -hz + h), &[], y);

        // The two back corner posts; the front pair is already up, shared with the front run.
        for lx in [-hx, hx] {
            post(self, lx, -hz, PI);
        }

        // Gate frames (not solid: vehicles drive through the openings), on the same ground line.
        for lx in [GATE_LX, SALLY_LX] {
            let lz = if lx == GATE_LX { hz } else { -hz };
            self.force_wall_at_y(
                skind::GATE,
                bd.team,
                bd.loc(lx, lz),
                bd.yaw(0.0),
                GATE_FRAME,
                1.2,
                4.2,
                sflag::DESTRUCTIBLE | sflag::BLOCKS_LOS | sflag::EMISSIVE,
                y,
            );
        }
    }

    /// Place a mirrored prop at (or very near) its authored position.
    #[allow(clippy::too_many_arguments)]
    fn prop_sym(
        &mut self,
        p: Vec2,
        team: u8,
        yaw: f32,
        kind: u8,
        w: f32,
        d: f32,
        h: f32,
        flags: u32,
        margin: f32,
    ) -> bool {
        for ring in 0..3 {
            let step = ring as f32 * 4.0;
            for (dx, dz) in [
                (0.0f32, 0.0f32),
                (1.0, 0.0),
                (-1.0, 0.0),
                (0.0, 1.0),
                (0.0, -1.0),
                (0.7, 0.7),
                (-0.7, 0.7),
                (0.7, -0.7),
                (-0.7, -0.7),
                (1.0, 0.5),
                (-1.0, -0.5),
            ] {
                let q = p + v2(dx * step, dz * step);
                if q.x < 4.0 || q.y < 4.0 || q.x > self.w - 4.0 || q.y > self.w - 4.0 {
                    continue;
                }
                if self.put_sym(kind, team, q, yaw, w, d, h, flags, margin) {
                    return true;
                }
            }
        }
        false
    }

    fn place_props(&mut self) {
        let props = self.plan.props.clone();
        for pr in props {
            let (w, d, h, flags, margin) = match pr.kind {
                skind::LIGHTHOUSE => (9.0, 9.0, 21.0, B_SOLID | sflag::EMISSIVE, 1.0),
                skind::ANTENNA => (4.5, 4.5, 17.0, B_SOLID | sflag::EMISSIVE, 1.0),
                skind::TURRET_TOWER => (3.2, 3.2, 4.5, B_SOLID, 0.8),
                skind::TENT => (5.5, 4.2, 2.5, B_SOLID, 0.6),
                skind::BUILDING => (13.0, 9.5, 6.5, B_SOLID, 1.0),
                skind::WRECK => (6.5, 3.2, 2.2, B_SOLID, 0.6),
                _ => (3.0, 3.0, 2.5, B_WALL, 0.5),
            };
            self.prop_sym(pr.p, pr.team, pr.yaw, pr.kind, w, d, h, flags, margin);
        }
    }

    /// Palms along the beaches, boulders over the island's outskirts - mirrored, so both
    /// halves stay identical.
    ///
    /// Palms are placed as the sweep passes them. Rocks are not: the sweep starts at the
    /// top-left corner, so filling the quota as it went put the whole population in the first
    /// ridge the terrain gate accepted and left the rest of the island bare (see the density
    /// dump in `examples/rocks` — two mirrored bands and nothing between them, nearest
    /// neighbour p50 6.4 m between 2-6 m boulders, and on Coral Rim only 7 % of them within
    /// 40 m of a map edge). Candidates are collected instead, weighted towards the outskirts,
    /// shuffled, and then placed with real spacing between them, so the same count of rocks
    /// follows the island rather than the sweep order.
    fn scatter(&mut self) {
        let mut palms = 0u32;
        let step = 4.0f32;
        let mut sites: Vec<(Vec2, f32)> = Vec::new();
        let mut z = 2.0f32;
        while z < self.w - 2.0 {
            let mut x = 2.0f32;
            while x < self.w - 2.0 {
                let jx = x + self.rng.range(-2.0, 2.0);
                let jz = z + self.rng.range(-2.0, 2.0);
                x += step;
                if self.plan.mirror && jx + jz > self.w + 2.0 {
                    continue; // scan the canonical half only: the mirror covers the rest
                }
                let p = v2(jx, jz);
                let h = self.h_at(p.x, p.y);
                let slope = self.slope_at(p.x, p.y);
                let roll = self.rng.f32();
                if palms < self.plan.palms
                    && roll < 0.50
                    && h > 0.35
                    && h < 3.0
                    && slope < 0.60
                    && self.near_water(p, 18.0)
                    && !self.on_road(p)
                {
                    let yaw = self.rng.range(0.0, PI);
                    let hgt = self.rng.range(5.0, 9.0);
                    if self.put_sym(
                        skind::PALM,
                        0,
                        p,
                        yaw,
                        1.6,
                        1.6,
                        hgt,
                        sflag::SOLID | sflag::DESTRUCTIBLE | sflag::BLOCKS_LOS,
                        0.45,
                    ) {
                        palms += 1;
                        continue;
                    }
                }
                // Boulder ground: any dry ground, with the steeper and higher parts of the
                // island preferred. The old gate demanded a ridge (`slope > 0.30 || h > 2.6`),
                // which is what herded every rock onto the same few features.
                if roll >= 0.60
                    && h > 0.45
                    && (slope > 0.14 || h > 1.8)
                    && !self.on_road(p)
                {
                    // Weight by distance from the middle of the theatre, not by distance to the
                    // map border: the border is open water on every authored map (the island's
                    // own land sits p50 86 m from it), so "the edge of the map" for a boulder is
                    // the island's outskirts. `r` is 0 at the centre and 1 at the border; the
                    // ramp starts just outside the middle so the outer half of the island takes
                    // most of the population while the interior keeps some cover.
                    let r = p.dist(v2(self.w * 0.5, self.w * 0.5)) / (self.w * 0.5);
                    let edge = ((r - SCATTER_EDGE) / (1.0 - SCATTER_EDGE)).clamp(0.0, 1.0);
                    // Steeper, higher ground keeps a little pull of its own, so the interior is
                    // not stripped of boulders entirely.
                    let inland = ((slope - 0.14) * 1.2 + (h - 1.8) * 0.08).clamp(0.0, 0.45);
                    sites.push((p, edge * 0.85 + inland * 0.15));
                }
            }
            z += step;
        }

        // Ticket each candidate by its weight, shuffle deterministically, and take the quota
        // with spacing. Duplicate tickets are harmless: the first one to land reserves the
        // ground through the occupancy grid and the rest fail `can_place`.
        let mut pool: Vec<Vec2> = Vec::with_capacity(sites.len() * 2);
        for (p, weight) in sites.iter() {
            let tickets = 1 + (weight.clamp(0.0, 1.0) * 3.0) as usize;
            for _ in 0..tickets {
                pool.push(*p);
            }
        }
        for i in (1..pool.len()).rev() {
            let j = self.rng.below((i + 1) as u32) as usize;
            pool.swap(i, j);
        }
        let mut rocks = 0u32;
        for p in pool {
            if rocks >= self.plan.rocks {
                break;
            }
            let size = self.rng.range(2.2, 6.0);
            let yaw = self.rng.range(0.0, PI);
            let d2 = size * self.rng.range(0.75, 1.1);
            let h2 = size * self.rng.range(0.5, 0.9);
            if self.put_sym(
                skind::ROCK,
                0,
                p,
                yaw,
                size,
                d2,
                h2,
                sflag::SOLID | sflag::BLOCKS_LOS,
                SCATTER_SPACING,
            ) {
                rocks += 1;
            }
        }
    }

    fn near_water(&self, p: Vec2, r: f32) -> bool {
        for k in 0..8 {
            let a = k as f32 / 8.0 * core::f32::consts::TAU;
            let q = p + v2(a.cos(), a.sin()) * r;
            if q.x < 0.0 || q.y < 0.0 || q.x > self.w || q.y > self.w {
                return true;
            }
            if self.h_at(q.x, q.y) <= 0.05 {
                return true;
            }
        }
        false
    }

    /// True when the position is on (or right next to) asphalt, so roads stay clear.
    fn on_road(&self, p: Vec2) -> bool {
        let i = clamp((p.x / self.cell).round(), 0.0, (self.v - 1) as f32) as usize;
        let j = clamp((p.y / self.cell).round(), 0.0, (self.v - 1) as f32) as usize;
        self.road[j * self.v + i] > 60
    }

    /// Reserve road cells so later structures cannot be dropped on top of them.
    fn mark_road_occ(&mut self) {
        for j in 0..self.v {
            for i in 0..self.v {
                let k = j * self.v + i;
                if self.road[k] < 60 {
                    continue;
                }
                let p = v2(i as f32 * self.cell, j as f32 * self.cell);
                let oi = ((p.x / self.occ_m) as i32).clamp(0, self.occ_n as i32 - 1) as usize;
                let oj = ((p.y / self.occ_m) as i32).clamp(0, self.occ_n as i32 - 1) as usize;
                for dz in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let xx = oi as i32 + dx;
                        let yy = oj as i32 + dz;
                        if xx < 0 || yy < 0 || xx >= self.occ_n as i32 || yy >= self.occ_n as i32 {
                            continue;
                        }
                        self.occ[yy as usize * self.occ_n + xx as usize] = 1;
                    }
                }
            }
        }
    }

    fn assign_ids(&mut self) {
        for (i, s) in self.structs.iter_mut().enumerate() {
            s.id = i as f32;
        }
    }

    // -- nav / splat ------------------------------------------------------

    fn build_nav(&mut self) {
        rasterize_nav(
            &mut self.nav,
            &self.h,
            &self.road,
            &self.route,
            &self.structs,
            self.v,
            self.gg,
            self.cell,
            self.w,
        );
    }

    fn build_splat(&mut self) {
        for iz in 0..self.v {
            for ix in 0..self.v {
                let i = iz * self.v + ix;
                let h = self.h[i];
                let x = ix as f32 * self.cell;
                let z = iz as f32 * self.cell;
                let slope = self.slope_at(x, z);
                let rocky = self.rocky[i];
                let road = self.road[i] as f32 / 255.0;
                let n = self.grain.fbm(x * 0.06, z * 0.06, 3, 2.0, 0.5) * 0.5 + 0.5;

                let beach = 1.0 - smoothstep(0.9, 2.6, h);
                let mut sand = 0.18 + 0.82 * beach * (0.75 + 0.35 * n);
                let mut rock = clamp((slope - 0.40) / 0.55, 0.0, 1.0) * 0.95
                    + rocky * 0.75
                    + smoothstep(9.0, 16.0, h) * 0.45;
                let mut grass = (1.0 - clamp(slope / 0.55, 0.0, 1.0))
                    * smoothstep(1.1, 3.0, h)
                    * (0.35 + 0.65 * n)
                    * 0.95;
                let mut dirt = 0.6 + 0.25 * (1.0 - n);
                if h < 0.05 {
                    sand = 1.0;
                    rock = 0.22;
                    grass = 0.0;
                    dirt = 0.05;
                }
                // Explicit grass patches, so green ground can appear on flat terrain too.
                if !self.plan.grass_patches.is_empty() {
                    let mut patch = 0.0f32;
                    for (c, r) in &self.plan.grass_patches {
                        let d = v2(x, z).dist(*c) / r.max(1.0);
                        if d < 1.0 {
                            patch = patch.max(1.0 - smoothstep(0.45, 1.0, d));
                        }
                    }
                    if patch > 0.0 {
                        grass = grass.max(patch * 0.9);
                        // A patch is a meadow, not a cliff: it claims ground from sand.
                        sand *= 1.0 - 0.7 * patch;
                        rock *= 1.0 - 0.6 * patch;
                    }
                }
                // Asphalt / concrete flattens the vegetation.
                grass *= 1.0 - road;
                dirt *= 1.0 - 0.55 * road;
                sand *= 1.0 - 0.65 * road;
                // Rock has to give way almost completely under pavement. At the old 0.45 the
                // rock channel still carried over half its weight on stony ground, so a road
                // crossing a hillside came out as bare rock with a road-shaped tint -- which
                // is exactly why the roads read as rock rather than as concrete.
                rock *= 1.0 - 0.92 * road;
                let sum = sand + dirt + rock + grass;
                let k = if sum > 1e-4 { 255.0 / sum } else { 0.0 };
                let mut q = [
                    (sand * k).round(),
                    (dirt * k).round(),
                    (rock * k).round(),
                    (grass * k).round(),
                ];
                fix_quad(&mut q);
                let o = i * 4;
                self.splat[o] = q[0].clamp(0.0, 255.0) as u8;
                self.splat[o + 1] = q[1].clamp(0.0, 255.0) as u8;
                self.splat[o + 2] = q[2].clamp(0.0, 255.0) as u8;
                self.splat[o + 3] = q[3].clamp(0.0, 255.0) as u8;

                // Which sand and which grass, as one index each (see `MapData`). Both follow the
                // ground rather than a coin flip, so the ramps read as the island changing:
                // sand goes reef-flat coral -> wind-sorted dune -> inland grit as it climbs away
                // from the water, and grass goes lush -> scrub -> straw with height and slope.
                // A slow noise field breaks the bands up, or the variants would come out as
                // contour lines around the island.
                let band = self.grain.fbm(x * 0.014, z * 0.014, 3, 2.0, 0.5) * 0.5 + 0.5;
                let band2 = self.grain.fbm(x * 0.009 + 31.0, z * 0.009 - 17.0, 3, 2.0, 0.5) * 0.5 + 0.5;
                let climb = clamp((h - 1.2) / 5.0, 0.0, 1.0) + (band - 0.5) * 0.45;
                let sv = if climb < 0.5 { 2.0 - 4.0 * climb } else { 2.0 * climb - 1.0 };
                // Dryness, not wetness: 0 on the low flat ground (lush), 1 on the high or steep
                // ground (straw). Getting this the wrong way round is how a "dry" stop ends up
                // never appearing at all — the histogram test below catches exactly that.
                let dry = clamp((h - 3.0) / 8.0 + slope * 0.5, 0.0, 1.0) + (band2 - 0.5) * 0.5;
                let gv = if dry < 0.5 { 2.0 * dry } else { 1.0 + 2.0 * (dry - 0.5) };
                self.sand_var[i] = clamp(sv.round(), 0.0, 2.0) as u8;
                self.grass_var[i] = clamp(gv.round(), 0.0, 2.0) as u8;

                // Pavement shape. Roads are surfaced with slab strips laid *along* the road, so
                // the joints run across it; the two base pads are the square-slab paving of a
                // built-up compound. Which way a strip runs is read off the road mask itself
                // (wider along x or along z two vertices away), so no direction has to be stored
                // anywhere and a bend in the road bends the strips with it.
                if road > 0.55 {
                    let l = |dx: i32, dz: i32| -> u8 {
                        let jx = (ix as i32 + dx).clamp(0, self.v as i32 - 1) as usize;
                        let jz = (iz as i32 + dz).clamp(0, self.v as i32 - 1) as usize;
                        self.road[jz * self.v + jx]
                    };
                    let along_x = l(-2, 0) as u16 + l(2, 0) as u16;
                    let along_z = l(0, -2) as u16 + l(0, 2) as u16;
                    self.pave[i] = if along_x >= along_z { 2 } else { 3 };
                }
                let p = v2(x, z);
                if (0..2).any(|t| p.dist(self.plan.bases[t].c) < PAD_R) {
                    self.pave[i] = 1;
                }
            }
        }
    }

    /// Copy the canonical half of every grid onto its mirror image: exact fairness.
    /// Mirror the height field onto itself. Must run **before anything seats on the ground**:
    /// the grading passes (abutments, protected lanes) are not mirror-invariant on their own,
    /// so a mirrored plan carries up to ~5 m of one-sided relief until this snap. Props seated
    /// before it keep their pre-snap seat and float or sink afterwards — measured +0.28 m on
    /// Twin Atolls / Iron Strait boulders when the snap ran after `scatter`.
    fn enforce_symmetry_heights(&mut self) {
        for iz in 0..self.v {
            for ix in 0..self.v {
                let i = iz * self.v + ix;
                let j = (self.v - 1 - iz) * self.v + (self.v - 1 - ix);
                if j >= i {
                    continue;
                }
                self.h[i] = self.h[j];
            }
        }
    }

    fn enforce_symmetry(&mut self) {
        for iz in 0..self.v {
            for ix in 0..self.v {
                let i = iz * self.v + ix;
                let j = (self.v - 1 - iz) * self.v + (self.v - 1 - ix);
                if j >= i {
                    continue;
                }
                self.h[i] = self.h[j];
                self.road[i] = self.road[j];
                self.sand_var[i] = self.sand_var[j];
                self.grass_var[i] = self.grass_var[j];
                self.pave[i] = self.pave[j];
                for k in 0..4 {
                    self.splat[i * 4 + k] = self.splat[j * 4 + k];
                }
            }
        }
        for cz in 0..self.gg {
            for cx in 0..self.gg {
                let i = cz * self.gg + cx;
                let j = (self.gg - 1 - cz) * self.gg + (self.gg - 1 - cx);
                if j < i {
                    self.nav[i] = self.nav[j];
                    self.route[i] = self.route[j];
                }
            }
        }
    }

    fn finish(mut self) -> MapData {
        let spawn = self.plan.spawn;
        let flag = self.plan.flag;
        let name = map_names()[self.idx].to_string();
        let mut map = MapData {
            name,
            world_size: self.w,
            grid: self.gg as u32,
            cell: self.cell,
            heights: core::mem::take(&mut self.h),
            splat: core::mem::take(&mut self.splat),
            road: core::mem::take(&mut self.road),
            sand_var: core::mem::take(&mut self.sand_var),
            grass_var: core::mem::take(&mut self.grass_var),
            pave: core::mem::take(&mut self.pave),
            nav: core::mem::take(&mut self.nav),
            structures: core::mem::take(&mut self.structs),
            spawn,
            flag_home: flag,
            // The anchor and yaw each base was actually built at, so the editor never has to guess.
            base_anchor: [
                (self.plan.bases[0].c, self.plan.bases[0].fwd.angle() - FRAC_PI_2),
                (self.plan.bases[1].c, self.plan.bases[1].fwd.angle() - FRAC_PI_2),
            ],
            water_level: 0.0,
        };
        for (i, s) in map.structures.iter_mut().enumerate() {
            s.id = i as f32;
            if s.hp_max <= 0.0 {
                s.hp_max = hp_for(s.kind as u8);
                s.hp = s.hp_max;
            }
        }
        // Mark which structures belong to a base complex: the anchor the layout built at, and the
        // team that owns it. The editor moves a base as *one asset*, and this is what makes that
        // exact — the blueprint it stamps and this perimeter are not the same list of parts, so
        // matching the two by position leaves pieces of the old complex behind.
        //
        // By team and distance from the anchor: every piece of a base belongs to the team that
        // owns it, and no piece is far from the anchor. A radius rather than a rectangle because
        // the blueprints are not identical between the generator and the editor, and a shape test
        // tuned to one of them leaves parts of the other unmarked — which is exactly the bug this
        // marker exists to prevent.
        for s in map.structures.iter_mut() {
            let team = s.team as usize;
            if team < 2 && s.pos().dist(self.plan.bases[team].c) < 46.0 {
                s.set_flag(sflag::BASE, true);
            }
        }
        #[cfg(test)]
        {
            let marked = map.structures.iter().filter(|s| s.flag(sflag::BASE)).count();
            assert!(marked > 20, "only {marked} structures were marked as part of a base");
        }
        map
    }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/// Distance from every terrain vertex to the nearest water vertex, in metres.
///
/// An 8-connected chamfer transform. The terrain grid is 2 m per cell, so the resulting metres
/// are approximate — the setbacks that read it are visual margins, not measurements. Both the
/// asphalt scrub and the road trim read it, and they have to agree: a road the trim keeps is a
/// road the scrub will not cut.
fn water_clearance_of(h: &[f32], n: usize, cell: f32) -> Vec<f32> {
    /// A little above `build_nav`'s 0.05 water threshold: below this the vertex is water.
    const WATER: f32 = 0.05;
    let far = 1.0e6f32;
    let mut dist = vec![far; n * n];
    for iz in 0..n {
        for ix in 0..n {
            if h[iz * n + ix] < WATER {
                dist[iz * n + ix] = 0.0;
            }
        }
    }
    let d1 = cell;
    let d2 = cell * core::f32::consts::SQRT_2;
    let relax = |dist: &mut Vec<f32>, ix: usize, iz: usize, px: i32, pz: i32, w: f32| {
        let (qx, qz) = (ix as i32 + px, iz as i32 + pz);
        if qx < 0 || qz < 0 || qx >= n as i32 || qz >= n as i32 {
            return;
        }
        let cand = dist[(qz as usize) * n + qx as usize] + w;
        if cand < dist[iz * n + ix] {
            dist[iz * n + ix] = cand;
        }
    };
    for iz in 0..n {
        for ix in 0..n {
            relax(&mut dist, ix, iz, -1, 0, d1);
            relax(&mut dist, ix, iz, 0, -1, d1);
            relax(&mut dist, ix, iz, -1, -1, d2);
            relax(&mut dist, ix, iz, 1, -1, d2);
        }
    }
    for iz in (0..n).rev() {
        for ix in (0..n).rev() {
            relax(&mut dist, ix, iz, 1, 0, d1);
            relax(&mut dist, ix, iz, 0, 1, d1);
            relax(&mut dist, ix, iz, 1, 1, d2);
            relax(&mut dist, ix, iz, -1, 1, d2);
        }
    }
    dist
}

fn team_other(t: u8) -> u8 {
    if t == 0 {
        1
    } else {
        0
    }
}

/// Radius of the ground ring a scattered prop's *rendered* mesh touches, in metres.
///
/// `scatter` sizes a prop's nav collision box (`w`/`d`/`h`) for physics and the AI, and
/// `put_at` uses the highest corner of that box as its seat. For a true-scale authored mesh
/// that is the wrong footprint: a rock's box is up to 6 m across plus a 0.5 m margin while the
/// boulder `props.ts::rockTemplate` draws there is ~1-1.3 m across, and a palm's box is 1.6 m +
/// 0.45 m while its trunk contacts over ~0.3 m. Seating on the box's highest corner is exactly
/// what leaves the visible stone floating. This is the radius `put_at` seats those kinds on.
///
/// 0.0 means "not a scattered prop": seat on the footprint corners as before.
pub fn prop_contact_radius(kind: u8) -> f32 {
    match kind {
        skind::ROCK => 0.9,
        skind::PALM => 0.35,
        _ => 0.0,
    }
}

fn hp_for(kind: u8) -> f32 {
    match kind {
        skind::WALL => 250.0,
        skind::BUNKER => 400.0,
        skind::TURRET_TOWER => 500.0,
        skind::PALM => 40.0,
        skind::ROCK => 600.0,
        skind::TENT => 120.0,
        skind::GARAGE | skind::HQ => 800.0,
        skind::BRIDGE => 300.0,
        skind::CRATE => 60.0,
        skind::BARREL => 30.0,
        skind::CONTAINER => 250.0,
        skind::SANDBAG => 150.0,
        skind::WATCHTOWER => 350.0,
        skind::RADAR => 300.0,
        skind::ANTENNA => 450.0,
        skind::LIGHTHOUSE => 1400.0,
        skind::WRECK => 300.0,
        skind::BUILDING => 500.0,
        skind::FUEL_DEPOT => 300.0,
        skind::AMMO_TENT => 200.0,
        skind::HELIPAD => 120.0,
        skind::FLAG_POLE => 200.0,
        skind::GATE => 300.0,
        _ => 200.0,
    }
}

/// Append `from..to` samples (less than one cell apart) to a route polyline.
fn push_line(pts: &mut Vec<Vec2>, kind: &mut Vec<u8>, from: Vec2, to: Vec2, k: u8) {
    let d = from.dist(to);
    let n = (d / 1.5).ceil().max(1.0) as u32;
    for i in 1..=n {
        pts.push(from.lerp(to, i as f32 / n as f32));
        kind.push(k);
    }
}

/// Raise the terrain around `p` towards `target` (roads, fords and bridge embankments).
fn stamp_height(g: &mut Gen, p: Vec2, radius: f32, target: f32) {
    let i0 = ((p.x - radius) / g.cell).floor().max(0.0) as i32;
    let i1 = ((p.x + radius) / g.cell).ceil().min((g.v - 1) as f32) as i32;
    let j0 = ((p.y - radius) / g.cell).floor().max(0.0) as i32;
    let j1 = ((p.y + radius) / g.cell).ceil().min((g.v - 1) as f32) as i32;
    for iz in j0..=j1 {
        for ix in i0..=i1 {
            let q = v2(ix as f32 * g.cell, iz as f32 * g.cell);
            let d = q.dist(p);
            if d > radius {
                continue;
            }
            let w = 1.0 - smoothstep(0.0, radius, d);
            let i = iz as usize * g.v + ix as usize;
            let lower = g.h[i] < target;
            let upper = g.h[i] > target + 3.0;
            if lower || upper {
                let t = if lower { target } else { g.h[i] - 3.0 };
                g.h[i] = lerp(g.h[i], t, w * 0.6);
            }
        }
    }
}

/// Lift every *near-dry* vertex within [`FORD_APPROACH_R`] of a ford line up to the drivable
/// shelf.
///
/// Raise-only (never shaves high ground) and iterated with a linear falloff: one soft
/// smoothstep pass is too weak at the edge of the radius to clear `build_nav`'s 0.05 m wet
/// threshold, which is what left the off-lane approach wet on map 2 seed 1 (see
/// [`Gen::grade_protected_lanes`]). The depth gate (`h >= -0.6`, the same floor `build_nav`
/// uses for DEEP_WATER) keeps the pass from filling in genuine channels and bays beside a
/// ford: without it, three lerp passes at weight 0.8 raised a -3 m channel to +0.57 m on map
/// 5 seed 0, and a helicopter's steep fire into that "channel" cleared the water entirely
/// (`projectiles_stop_at_the_water_surface`).
const FORD_APPROACH_R: f32 = 10.0;
const FORD_APPROACH_FLOOR: f32 = -0.6;

fn stamp_ford_approach(g: &mut Gen, p: Vec2, shelf: f32) {
    let i0 = ((p.x - FORD_APPROACH_R) / g.cell).floor().max(0.0) as i32;
    let i1 = ((p.x + FORD_APPROACH_R) / g.cell).ceil().min((g.v - 1) as f32) as i32;
    let j0 = ((p.y - FORD_APPROACH_R) / g.cell).floor().max(0.0) as i32;
    let j1 = ((p.y + FORD_APPROACH_R) / g.cell).ceil().min((g.v - 1) as f32) as i32;
    for _ in 0..3 {
        for iz in j0..=j1 {
            for ix in i0..=i1 {
                let q = v2(ix as f32 * g.cell, iz as f32 * g.cell);
                let d = q.dist(p);
                if d > FORD_APPROACH_R {
                    continue;
                }
                let w = (1.0 - d / FORD_APPROACH_R) * 0.8;
                let i = iz as usize * g.v + ix as usize;
                // Near-dry only: thin films and shallow pockets are the trap, deep water is
                // a map feature to leave alone (see the depth-gate note above).
                if g.h[i] >= FORD_APPROACH_FLOOR && g.h[i] < shelf {
                    g.h[i] = lerp(g.h[i], shelf, w);
                }
            }
        }
    }
}

/// Force four u8 weights to sum to exactly 255.
fn fix_quad(q: &mut [f32; 4]) {
    let mut sum = 0.0f32;
    for v in q.iter() {
        sum += *v;
    }
    let diff = 255.0 - sum;
    if diff.abs() < 0.5 {
        return;
    }
    let mut best = 0usize;
    for i in 1..4 {
        if q[i] > q[best] {
            best = i;
        }
    }
    q[best] = (q[best] + diff).max(0.0);
}

/// Breadth-first land path search over SAND/GROUND/ROAD cells (4-connected).
pub(crate) fn land_path_exists(map: &MapData, from: Vec2, to: Vec2) -> bool {
    let g = map.grid as i32;
    let idx = |p: Vec2| -> usize {
        let cx = clamp((p.x / map.cell).floor(), 0.0, (g - 1) as f32) as i32;
        let cz = clamp((p.y / map.cell).floor(), 0.0, (g - 1) as f32) as i32;
        (cz * g + cx) as usize
    };
    let start = idx(from);
    let goal = idx(to);
    if !terrain::passable_land(map.nav[start]) || !terrain::passable_land(map.nav[goal]) {
        return false;
    }
    let mut seen = vec![false; (g * g) as usize];
    let mut queue: Vec<u32> = Vec::with_capacity(1024);
    seen[start] = true;
    queue.push(start as u32);
    let mut head = 0usize;
    while head < queue.len() {
        let cur = queue[head] as usize;
        head += 1;
        if cur == goal {
            return true;
        }
        let cx = (cur as i32) % g;
        let cz = (cur as i32) / g;
        for (dx, dz) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
            let nx = cx + dx;
            let nz = cz + dz;
            if nx < 0 || nz < 0 || nx >= g || nz >= g {
                continue;
            }
            let ni = (nz * g + nx) as usize;
            if seen[ni] || !terrain::passable_land(map.nav[ni]) {
                continue;
            }
            seen[ni] = true;
            queue.push(ni as u32);
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod flat_flag_tests {
    use super::*;

    /// Nothing may mark a *flat* structure destructible: flat kinds are floor markings, and every
    /// damage path reaches structures through the grid of `solid()` ones and re-checks `solid()`,
    /// so the flag can never be acted on. It is not harmless bookkeeping either - the helipad
    /// carried it on generated maps and not on edited ones (the editor stamps `kind_flags`, which
    /// has never listed HELIPAD as destructible), which is exactly the kind of drift a test is for.
    #[test]
    fn no_generated_structure_is_flat_and_destructible() {
        for mode in [MapMode::Classic, MapMode::Mirror] {
            for index in 0..4 {
                let map = generate_mode(11, index, mode);
                for s in map.structures.iter() {
                    if !s.flag(sflag::FLAT) {
                        continue;
                    }
                    assert!(
                        !s.flag(sflag::DESTRUCTIBLE),
                        "{mode:?} map {index}: kind {} is FLAT and DESTRUCTIBLE at ({:.0},{:.0}), \
                         which no damage path can ever act on",
                        s.kind as u8,
                        s.pos().x,
                        s.pos().y
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GRID;
    use std::collections::BTreeMap;

    // The tests below were written against the world-space consts that became runtime fields
    // when the map size became selectable. They exercise the *small* map (what `generate_mode`
    // defaults to), so these aliases give them the same values they always had.
    const W: f32 = crate::types::WORLD_SIZE;
    const V: usize = crate::types::VERTS as usize;
    const GG: usize = crate::types::GRID as usize;
    const CELL: f32 = crate::types::CELL;

    /// Land / water shares and structure count, as the scale report prints them.
    fn terrain_mix(m: &MapData) -> (f32, f32, f32) {
        let g = m.grid as usize;
        let (mut land, mut shallow, mut deep) = (0u32, 0u32, 0u32);
        for t in m.nav.iter() {
            match *t {
                terrain::DEEP_WATER => deep += 1,
                terrain::SHALLOW_WATER => shallow += 1,
                _ => land += 1,
            }
        }
        let n = (g * g) as f32;
        (land as f32 / n * 100.0, shallow as f32 / n * 100.0, deep as f32 / n * 100.0)
    }

    /// The procedural generator has to produce a *playable* island for any seed, not just a
    /// pretty one: `validate` is the same check the game runs, so a seed that fails to give
    /// both teams a land route to the enemy flag is a bug in the generator, not bad luck.
    #[test]
    fn classic_maps_generate_and_validate() {
        let mut worst_land = 100.0f32;
        for idx in 0..map_names().len() as u32 {
            for seed in [1u32, 7, 1337, 90210, 4_294_967_295] {
                let m = generate_mode(seed, idx, MapMode::Classic);
                let tag = format!("classic seed {seed} idx {idx}");
                if let Err(e) = validate(&m) {
                    panic!("{tag} failed validation: {e}");
                }
                let (land, _shallow, _deep) = terrain_mix(&m);
                worst_land = worst_land.min(land);
            }
        }
        // A map that is mostly ocean cannot host a match; the mirrored maps run 69-76 %.
        assert!(
            worst_land > 45.0,
            "worst classic land share is only {worst_land:.1} %"
        );
    }

    /// Classic maps must actually differ per seed - that is the whole point of "unlimited".
    #[test]
    fn classic_is_seed_varied() {
        let a = generate_mode(11, 0, MapMode::Classic);
        let b = generate_mode(12, 0, MapMode::Classic);
        assert_ne!(checksum(&a), checksum(&b), "two seeds produced the same map");
    }

    /// Mirror maps must differ per seed too: the plan fixes the skeleton (bases, roads,
    /// crossings) but coastline wander and plan jitter make each seed a different island.
    /// Two seeds that share most of their land/water boundary are the same island in
    /// different grass - exactly what this test exists to catch.
    #[test]
    fn mirror_is_seed_varied() {
        let mask = |seed: u32| -> Vec<bool> {
            let m = generate_mode(seed, 0, MapMode::Mirror);
            let g = m.grid as usize;
            (0..g * g)
                .map(|i| {
                    let cx = (i % g) as f32 + 0.5;
                    let cz = (i / g) as f32 + 0.5;
                    m.height_at(cx * m.cell, cz * m.cell) <= m.water_level
                })
                .collect()
        };
        let a = mask(1);
        let b = mask(7);
        let diff = a.iter().zip(&b).filter(|(x, y)| x != y).count();
        let share = 1.0 - diff as f32 / a.len() as f32;
        assert!(
            share < 0.98,
            "seeds 1 and 7 share {:.1}% of their land/water boundary",
            share * 100.0
        );
        assert_ne!(
            checksum(&generate_mode(1, 0, MapMode::Mirror)),
            checksum(&generate_mode(7, 0, MapMode::Mirror)),
            "two mirror seeds produced the same map"
        );
    }

    /// Classic maps must NOT be mirror symmetric: forcing the mirror would destroy them.
    #[test]
    fn classic_is_not_mirror_symmetric() {
        let m = generate_mode(1337, 0, MapMode::Classic);
        let g = m.grid as usize;
        let mut same = 0u32;
        let mut total = 0u32;
        for cz in 0..g {
            for cx in 0..g {
                let j = (g - 1 - cz) * g + (g - 1 - cx);
                total += 1;
                if m.nav[cz * g + cx] == m.nav[j] {
                    same += 1;
                }
            }
        }
        let frac = same as f32 / total as f32;
        assert!(
            frac < 0.97,
            "classic map looks mirrored: {:.1} % of nav cells match their mirror",
            frac * 100.0
        );
    }

    /// Report for the classic generator, mirroring `map_scale_report`'s role: run with
    /// `cargo test -p rf-core classic_scale_report -- --nocapture` to see the numbers.
    #[test]
    fn classic_scale_report() {
        for seed in [1u32, 1337, 90210] {
            let t0 = std::time::Instant::now();
            let m = generate_mode(seed, 0, MapMode::Classic);
            let (land, _shallow, deep) = terrain_mix(&m);
            let roads = m.road.iter().filter(|v| **v > 150).count();
            let v = (m.grid as usize + 1) * (m.grid as usize + 1);
            // Walls and gates per team are the observable trace of the enclosure style.
            let count = |k: u8, team: u8| {
                m.structures
                    .iter()
                    .filter(|s| s.kind as u8 == k && s.team as u8 == team)
                    .count()
            };
            let [sand, dirt, rock, grass] = splat_mix(&m);
            println!(
                "classic seed {seed:<12} | land {land:.1}% | deep {deep:.1}% | road {:.2}% \
                 | ground sand {sand:.0} dirt {dirt:.0} rock {rock:.0} grass {grass:.0} \
                 | structures {} | walls t0 {} t1 {} | gates {} | turrets {} | gen {} ms",
                roads as f32 / v as f32 * 100.0,
                m.structures.len(),
                count(skind::WALL, 0),
                count(skind::WALL, 1),
                count(skind::GATE, 0) + count(skind::GATE, 1),
                count(skind::TURRET_TOWER, 0) + count(skind::TURRET_TOWER, 1),
                t0.elapsed().as_millis()
            );
        }
    }

    /// Mean splat weight per channel: sand, dirt, rock, grass. The splat is normalised to 255
    /// across the four channels, so these are shares of the ground.
    fn splat_mix(m: &MapData) -> [f32; 4] {
        let mut acc = [0f64; 4];
        let n = (m.splat.len() / 4) as f64;
        for i in 0..(m.splat.len() / 4) {
            for k in 0..4 {
                acc[k] += m.splat[i * 4 + k] as f64;
            }
        }
        [
            (acc[0] / n) as f32,
            (acc[1] / n) as f32,
            (acc[2] / n) as f32,
            (acc[3] / n) as f32,
        ]
    }

    /// The ground has to keep some rock and gain some grass: rock "here and there" as before,
    /// plus the grass patches the procedural layout asks for. A patch that never lands would
    /// leave the grass share where it was, so this is the check that `Plan::grass` works.
    #[test]
    fn classic_ground_has_rock_and_grass() {
        let mut grass_total = 0.0f32;
        let mut samples = 0;
        for seed in 0..12u32 {
            let m = generate_mode(seed, 0, MapMode::Classic);
            let [sand, dirt, rock, grass] = splat_mix(&m);
            // Every ground sample is a convex mix, so a channel can only be zero if the
            // terrain never produced it. Rock comes from slopes and the `rocky` field; on a
            // mostly-flat island that is still expected to be present.
            assert!(
                rock > 0.5,
                "seed {seed}: rock channel averages {rock:.2} — rock has been lost"
            );
            assert!(
                (sand + dirt + rock + grass - 255.0).abs() < 2.0,
                "seed {seed}: splat does not sum to 255 ({:.1})",
                sand + dirt + rock + grass
            );
            grass_total += grass;
            samples += 1;
        }
        let mean_grass = grass_total / samples as f32;
        // Without patches the procedural islands sit well under this; the patches lift it.
        assert!(
            mean_grass > 20.0,
            "mean grass share is only {mean_grass:.1} — grass patches are not landing"
        );
    }

    /// The paintable masks have to describe the map they sit on.
    ///
    /// Three sand stops and three grass stops exist so the ground can *change* across an island;
    /// a ramp where one stop never appears is a ramp the renderer cannot show. And pavement is a
    /// property of pavement: wherever the road mask says there is a road or an apron, the map has
    /// to say which shape it is laid in, or the shader draws the plain concrete it fell back to.
    #[test]
    fn ground_variants_and_pavement_are_consistent() {
        for (seed, index) in [(1u32, 0u32), (7, 2), (1337, 3)] {
            for size in [MapSize::Small, MapSize::Big] {
                let m = generate_sized(seed, index, MapMode::Classic, size);
                let v = (m.grid + 1) as usize;
                let mut sand_hist = [0u32; 3];
                let mut grass_hist = [0u32; 3];
                let mut pave_hist = [0u32; 4];
                for i in 0..v * v {
                    assert!(
                        m.sand_var[i] <= 2 && m.grass_var[i] <= 2,
                        "{seed}/{index}/{}: variant out of range ({} {})",
                        size.name(),
                        m.sand_var[i],
                        m.grass_var[i]
                    );
                    sand_hist[m.sand_var[i] as usize] += 1;
                    grass_hist[m.grass_var[i] as usize] += 1;
                    pave_hist[m.pave[i] as usize] += 1;
                }
                let tag = format!("{seed}/{index}/{}", size.name());
                assert!(
                    sand_hist.iter().all(|c| *c > v as u32),
                    "{tag}: sand ramp is missing a stop: {sand_hist:?}"
                );
                assert!(
                    grass_hist.iter().all(|c| *c > v as u32),
                    "{tag}: grass ramp is missing a stop: {grass_hist:?}"
                );
                // Roads are strips (laid along the road), the base pads are slabs. Both have to
                // appear on a real map, and the plain shape has to survive for whatever is
                // neither.
                assert!(pave_hist[1] > 0, "{tag}: no slab paving on the base pads");
                assert!(
                    pave_hist[2] + pave_hist[3] > 0,
                    "{tag}: no strip paving on the roads"
                );
            }
        }
    }

    /// Main bases are always fully walled: the complete ring plus both a main gate and a rear
    /// sally port. A `Partial`/`Open` main base was tried and it was a misreading of the brief —
    /// the "some enclosed, others just roads with buildings" note was about the secondary
    /// settlements, not the two bases the AI and the capture flow are tuned against.
    ///
    /// The gate count is the cleanest witness: only the full perimeter builds two, because the
    /// sally port lives in the back wall.
    #[test]
    fn classic_main_bases_are_fully_walled() {
        for seed in 0..12u32 {
            let m = generate_mode(seed, 0, MapMode::Classic);
            for team in 0..2u8 {
                let count = |k: u8| {
                    m.structures
                        .iter()
                        .filter(|s| s.kind as u8 == k && s.team as u8 == team)
                        .count()
                };
                assert!(
                    count(skind::GATE) >= 1,
                    "seed {seed} team {team}: base has no gate"
                );
                // The ring itself: walls at both x extremes and both y extremes, spanning the
                // base's real footprint (24 x 19 m half extents; base complexes keep their world
                // size, only their position is scaled).
                let walls: Vec<Vec2> = m
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == skind::WALL && s.team as u8 == team)
                    .map(|s| s.pos())
                    .collect();
                // Total wall run: the ring is 2*48 + 2*38 = 172 m less the two 8 m gate openings
                // and the corners the runs stop short of, so about 156 m. A single missing
                // segment shows up here while the bounding box and the four side checks still
                // pass — which is exactly how a hole in the wall got through before.
                let run_length: f32 = m
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == skind::WALL && s.team as u8 == team)
                    .map(|s| s.w)
                    .sum();
                assert!(
                    run_length > 140.0,
                    "seed {seed} team {team}: only {run_length:.1} m of wall around a ~156 m ring \
                     — a segment is missing"
                );
                let xs: Vec<f32> = walls.iter().map(|p| p.x).collect();
                let ys: Vec<f32> = walls.iter().map(|p| p.y).collect();
                let (minx, maxx) = (
                    xs.iter().cloned().fold(f32::MAX, f32::min),
                    xs.iter().cloned().fold(f32::MIN, f32::max),
                );
                let (miny, maxy) = (
                    ys.iter().cloned().fold(f32::MAX, f32::min),
                    ys.iter().cloned().fold(f32::MIN, f32::max),
                );
                // The ring is 48 x 38 m in *base-local* space, and each base is rotated towards
                // its enemy, so the axis-aligned box below is that rectangle at some yaw: its
                // span runs from 38 m (a side aligned with the axis) up to 48|cos|+38|sin| = 61 m
                // at the worst angle. A partial or open base falls well outside this.
                for (name, span) in [("width", maxx - minx), ("depth", maxy - miny)] {
                    assert!(
                        (36.0..=64.0).contains(&span),
                        "seed {seed} team {team}: wall ring {name} is {span:.1} m, not a base-sized ring"
                    );
                }
                for (name, ok) in [
                    ("west", walls.iter().any(|p| p.x - minx < 2.0)),
                    ("east", walls.iter().any(|p| maxx - p.x < 2.0)),
                    ("north", walls.iter().any(|p| p.y - miny < 2.0)),
                    ("south", walls.iter().any(|p| maxy - p.y < 2.0)),
                ] {
                    assert!(ok, "seed {seed} team {team}: no wall on the {name} side");
                }
            }
        }
    }

    /// Pavement must never stand in water — only a bridge crosses water, and it does so on its
    /// own deck mesh. A road polyline that reaches the shore has to stop there.
    #[test]
    fn pavement_never_stands_in_water() {
        for mode in [MapMode::Classic, MapMode::Mirror] {
            for idx in 0..map_names().len() as u32 {
                for seed in [1u32, 1337, 90210] {
                    let m = generate_mode(seed, idx, mode);
                    assert_eq!(m.road.len(), m.heights.len());
                    let mut wet_paved = 0u32;
                    let mut lowest = 0.0f32;
                    for i in 0..m.road.len() {
                        if m.road[i] > 0 && m.heights[i] < 0.05 {
                            wet_paved += 1;
                            lowest = lowest.min(m.heights[i]);
                        }
                    }
                    assert_eq!(
                        wet_paved, 0,
                        "{:?} map {idx} seed {seed}: {wet_paved} paved vertices are in water \
                         (lowest {lowest:.2} m)",
                        mode
                    );
                }
            }
        }
    }

    /// Report for the pavement rule: run with
    /// `cargo test -p rf-core shelf_paving_report -- --nocapture` to see the numbers quoted in
    /// the README about paved cells on the 0-0.75 m shelf.
    #[test]
    fn shelf_paving_report() {
        for mode in [MapMode::Mirror, MapMode::Classic] {
            for idx in 0..map_names().len() as u32 {
                let m = generate_mode(1337, idx, mode);
                let shelf = (0..m.road.len())
                    .filter(|i| m.road[*i] > 0 && m.heights[*i] >= 0.0 && m.heights[*i] <= 0.75)
                    .count();
                let wet = (0..m.road.len())
                    .filter(|i| m.road[*i] > 0 && m.heights[*i] < 0.0)
                    .count();
                println!(
                    "{:?} map {idx} ({}): paved on 0-0.75 m shelf {shelf}, paved below 0 m {wet}",
                    mode,
                    m.name
                );
            }
        }
    }

    /// Classic islands are never cut in two by a channel — that job belongs to the island's
    /// silhouette now — and they still differ from one another in shape.
    #[test]
    fn classic_islands_are_whole_and_shaped_differently() {
        let mut shapes = std::collections::BTreeSet::new();
        for seed in 0..12u32 {
            let m = generate_mode(seed, 0, MapMode::Classic);
            let decks = m
                .structures
                .iter()
                .filter(|s| s.kind as u8 == skind::BRIDGE)
                .count();
            assert_eq!(decks, 0, "seed {seed}: classic island has a splitting channel");
            // A coarse silhouette signature: land share to the nearest percent, plus the nav
            // class at four probe points inside the island.
            let (land, _s, _d) = terrain_mix(&m);
            let g = m.grid as f32;
            let probe: String = [(0.32f32, 0.32f32), (0.68, 0.32), (0.32, 0.68), (0.68, 0.68)]
                .iter()
                .map(|(fx, fz)| format!("{}", m.nav_at(g * fx, g * fz)))
                .collect();
            shapes.insert(format!("{land:.0}:{probe}"));
        }
        assert!(
            shapes.len() >= 6,
            "islands are not shaped differently: {} distinct shapes of 12 seeds",
            shapes.len()
        );
    }

    /// Scattered rocks have to be *scattered*: spread over the island, spaced apart, and
    /// leaning towards its outskirts rather than piled onto whichever ridge the sweep reached
    /// first.
    ///
    /// The old scatter filled its quota in scan order, which starts at the top-left corner: all
    /// 202 rocks landed in the first band the terrain gate accepted, mirrored to the opposite
    /// corner, with the middle of the island bare (traced in `examples/rocks`). Measured there:
    /// nearest neighbour p50 6.4 m between 2-6 m boulders — one wall of stone — and on Coral Rim
    /// only 7 % of rocks within 40 m of a map edge.
    #[test]
    fn scattered_rocks_are_spread_over_the_island() {
        // Both modes: Classic places one rock per accepted candidate, Mirror also stamps the
        // 180-degree twin, so the same quota lands twice the population. The game plays both.
        for (mode, name) in [(MapMode::Classic, "classic"), (MapMode::Mirror, "mirror")] {
            for index in 0..4u32 {
                let m = generate_mode(1, index, mode);
                let w = m.world_size;
                let rocks: Vec<Vec2> = m
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == skind::ROCK)
                    .map(|s| s.pos())
                    .collect();
                assert!(rocks.len() > 50, "{name} map {index}: only {} rocks", rocks.len());

                // Occupancy over a 4x4 grid of the theatre.
                let mut quad = [0u32; 16];
                let centre = v2(w * 0.5, w * 0.5);
                let mut inner = 0u32;
                let mut nn = Vec::with_capacity(rocks.len());
                for (i, a) in rocks.iter().enumerate() {
                    let qx = ((a.x / w * 4.0) as usize).min(3);
                    let qz = ((a.y / w * 4.0) as usize).min(3);
                    quad[qz * 4 + qx] += 1;
                    if a.dist(centre) < w * 0.25 {
                        inner += 1;
                    }
                    let mut best = f32::INFINITY;
                    for (j, b) in rocks.iter().enumerate() {
                        if i != j {
                            best = best.min(a.dist(*b));
                        }
                    }
                    nn.push(best);
                }
                nn.sort_by(|a, b| a.total_cmp(b));
                let nn50 = nn[nn.len() / 2];
                let peak = *quad.iter().max().unwrap();
                let empty = quad.iter().filter(|c| **c == 0).count();
                let inner_pct = 100.0 * inner as f32 / rocks.len() as f32;
                let peak_pct = 100.0 * peak as f32 / rocks.len() as f32;
                println!(
                    "{name} map {index}: {} rocks | nearest-neighbour p50 {nn50:.1} m | busiest \
                     sixteenth {peak} ({peak_pct:.0}%) | empty sixteenths {empty}/16 | \
                     {inner_pct:.0}% in the inner half",
                    rocks.len()
                );
                // Packed at the occupancy default, 2-6 m boulders sat 6.4 m apart: one wall.
                assert!(
                    nn50 > 9.0,
                    "{name} map {index}: rocks are packed together (nearest-neighbour p50 \
                     {nn50:.1} m)"
                );
                // The middle of the island used to be bare on every map.
                assert!(
                    empty <= 2,
                    "{name} map {index}: {empty} of 16 cells of the map have no rocks"
                );
                assert!(
                    peak_pct < 35.0,
                    "{name} map {index}: {peak} of {} rocks sit in one sixteenth of the map",
                    rocks.len()
                );
                // The outskirts lean, not a ring: the interior keeps some cover. The exact
                // share depends on how much of the island is "outskirts" (Coral Rim's land
                // reaches further out than the others), so the floor only rules out a bare
                // middle.
                assert!(
                    (3.0..45.0).contains(&inner_pct),
                    "{name} map {index}: {inner_pct:.0}% of rocks are in the inner half of the \
                     island"
                );
            }
        }
    }

    /// A road interrupted by water is removed back to its last junction — against the terrain
    /// that ships, not against the plan's estimate of it.
    ///
    /// The plan-level prune runs before the island exists (`plan_height` + `WATER_SLACK` for
    /// the domain warp). Whatever it gets wrong, the asphalt scrub then cuts for real, and a
    /// road cut at the shoreline is a road that stops in the middle of nowhere: the reported
    /// "dead ends are back". `Gen::trim_roads_to_dry_ground` repeats the prune against the
    /// finished height field and the scrub's own clearance.
    ///
    /// The contract, on a synthetic shore (dry up to y = 180, water past it):
    /// * nothing may be left ending in the water — that is what the scrub would cut into a stub;
    /// * a branch whose far end is in the water goes entirely, because after the trim its only
    ///   attachment is the junction it left;
    /// * road that never touches water is untouched, so the trim is not a road shredder.
    #[test]
    fn a_road_interrupted_by_water_is_trimmed_to_its_last_junction() {
        let mut plan = Plan::with_mode(false);
        // Two dry through-roads, and a connector between them.
        plan.road(Road::new(vec![v2(60.0, 100.0), v2(300.0, 100.0)], 9.0, RoadKind::Road));
        plan.road(Road::new(vec![v2(60.0, 60.0), v2(300.0, 60.0)], 9.0, RoadKind::Road));
        plan.road(Road::new(vec![v2(240.0, 60.0), v2(240.0, 100.0)], 9.0, RoadKind::Road));
        // A dead-end spur off the first road, running into the water. Nothing else crosses it.
        plan.road(Road::new(vec![v2(150.0, 100.0), v2(150.0, 260.0)], 9.0, RoadKind::Road));
        // Dry up to y = 180; everything past it is water.
        let on_land = |p: Vec2| p.y < 180.0;
        plan.prune_road_dead_ends(&[v2(60.0, 100.0), v2(60.0, 60.0)], &on_land);

        let mut ends: Vec<Vec2> = Vec::new();
        let mut spur_len = 0.0f32;
        let mut dry_len = 0.0f32;
        for r in plan.roads.iter() {
            for w in r.pts.windows(2) {
                let seg = w[0].dist(w[1]);
                if seg < 0.75 {
                    continue;
                }
                if w[0].x == 150.0 && w[1].x == 150.0 {
                    spur_len += seg;
                } else if w[0].y == 100.0 || w[0].y == 60.0 {
                    dry_len += seg;
                }
            }
            if let Some(first) = r.pts.first() {
                ends.push(*first);
            }
            if let Some(last) = r.pts.last() {
                ends.push(*last);
            }
        }
        let into_water = ends.iter().filter(|e| !on_land(**e)).count();
        println!(
            "dead-end spur kept {spur_len:.0} m of 160 | through-roads kept {dry_len:.0} m (their \
             dry length is 480, minus the 60 m tail past the last junction) | {into_water} road \
             ends left in the water"
        );
        assert_eq!(
            into_water, 0,
            "a road was left ending in the water, which the asphalt scrub will cut into a stub"
        );
        assert!(
            spur_len < 1.0,
            "the dead-end spur was not removed back to its junction (kept {spur_len:.0} m)"
        );
        assert!(
            dry_len > 350.0,
            "the trim ate road that never touches water ({dry_len:.0} m kept of the 360 m that \
             survives the last-junction rule)"
        );
    }

    /// The build actually applies the trim, against the terrain that ships.
    ///
    /// `a_road_interrupted_by_water_is_trimmed_to_its_last_junction` pins the algorithm;
    /// this pins the wiring — that `Gen::build` runs it on the finished height field before
    /// the roads are stamped. Without that call the plan's polylines keep their original ends,
    /// several of which stand within the asphalt scrub's clearance of water, and the scrub
    /// cuts them there: the reported stubs.
    #[test]
    fn no_road_is_left_ending_where_the_scrub_will_cut_it() {
        for (mode, name) in [(MapMode::Classic, "classic"), (MapMode::Mirror, "mirror")] {
            for seed in 0..6u32 {
                let (map, ends) = generate_with_road_ends(seed, 0, mode);
                let n = (map.grid + 1) as usize;
                let cell = map.cell;
                let clear = water_clearance_of(&map.heights, n, cell);
                // A road may reach a bridge abutment: that is the one place pavement is allowed
                // to come up to the water.
                let approaches: Vec<Vec2> = map
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == skind::BRIDGE)
                    .map(|s| s.pos())
                    .collect();
                let mut bad = Vec::new();
                for e in ends.iter() {
                    if approaches.iter().any(|a| a.dist(*e) <= 15.0) {
                        continue;
                    }
                    let ix = ((e.x / cell).floor() as i32).clamp(0, n as i32 - 1) as usize;
                    let iz = ((e.y / cell).floor() as i32).clamp(0, n as i32 - 1) as usize;
                    let i = iz * n + ix;
                    if map.heights[i] < 0.05 || clear[i] < ROAD_WATER_SETBACK {
                        bad.push((*e, map.heights[i], clear[i]));
                    }
                }
                println!(
                    "{name} seed {seed}: {} road ends, {} on ground the scrub would cut",
                    ends.len(),
                    bad.len()
                );
                assert!(
                    bad.is_empty(),
                    "{name} seed {seed}: {} road ends stand where the asphalt scrub will cut \
                     them (first at ({:.0},{:.0}), height {:.2}, {:.1} m from water)",
                    bad.len(),
                    bad[0].0.x,
                    bad[0].0.y,
                    bad[0].1,
                    bad[0].2
                );
            }
        }
    }

    /// Every selectable size has to generate a valid, playable map, in both modes — this is the
    /// check that the dimensions really did become runtime.
    #[test]
    fn every_map_size_generates() {
        for size in [MapSize::Small, MapSize::Medium, MapSize::Big] {
            for idx in 0..map_names().len() as u32 {
                for mode in [MapMode::Classic, MapMode::Mirror] {
                    let m = generate_sized(1337, idx, mode, size);
                    let tag = format!("{} map {idx} {mode:?}", size.name());
                    assert_eq!(m.grid, size.grid(), "{tag}: grid");
                    assert!((m.world_size - size.world()).abs() < 0.001, "{tag}: world size");
                    assert!((m.cell - size.cell()).abs() < 0.001, "{tag}: cell size");
                    assert_eq!(
                        m.heights.len(),
                        (size.verts() * size.verts()) as usize,
                        "{tag}: heightfield length"
                    );
                    assert_eq!(m.nav.len(), (size.grid() * size.grid()) as usize, "{tag}: nav length");
                    if let Err(e) = validate(&m) {
                        panic!("{tag} failed validation: {e}");
                    }
                }
            }
        }
    }

    /// Report the cost of each size: run with
    /// `cargo test -p rf-core map_size_report -- --nocapture`.
    #[test]
    fn map_size_report() {
        for size in [MapSize::Small, MapSize::Medium, MapSize::Big] {
            let t0 = std::time::Instant::now();
            let m = generate_sized(1337, 0, MapMode::Classic, size);
            let ms = t0.elapsed().as_millis();
            let (land, _s, deep) = terrain_mix(&m);
            println!(
                "{:>6} {:>5.0} m, grid {:>4}, cell {:.2} m | land {land:.1}% deep {deep:.1}% \
                 | structures {:>4} | heights {:>5} KiB | nav {:>4} KiB | gen {ms} ms",
                size.name(),
                size.world(),
                size.grid(),
                size.cell(),
                m.structures.len(),
                m.heights.len() * 4 / 1024,
                m.nav.len() / 1024,
            );
        }
    }

    fn checksum(m: &MapData) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x100_0000_01b3);
        };
        for v in &m.heights {
            eat(v.to_bits() as u64);
        }
        for v in &m.splat {
            eat(*v as u64);
        }
        for v in &m.nav {
            eat(*v as u64);
        }
        for v in &m.road {
            eat(*v as u64);
        }
        for s in &m.structures {
            eat(s.x.to_bits() as u64);
            eat(s.z.to_bits() as u64);
            eat(s.kind as u64);
            eat(s.team as u64);
        }
        eat(m.spawn[0].x.to_bits() as u64);
        eat(m.spawn[1].y.to_bits() as u64);
        h
    }

    /// Overlap area between two structure footprints, as a fraction of the smaller one.
    fn overlap_frac(a: &Structure, b: &Structure) -> f32 {
        let ca = a.pos();
        let cb = b.pos();
        let axes = [
            v2(a.yaw.cos(), a.yaw.sin()),
            v2(-a.yaw.sin(), a.yaw.cos()),
            v2(b.yaw.cos(), b.yaw.sin()),
            v2(-b.yaw.sin(), b.yaw.cos()),
        ];
        let mut min_overlap = f32::INFINITY;
        for ax in axes {
            let project = |c: Vec2, yaw: f32, hw: f32, hd: f32| -> (f32, f32) {
                let u = v2(yaw.cos(), yaw.sin());
                let v = v2(-yaw.sin(), yaw.cos());
                let e = (hw * u.dot(ax)).abs() + (hd * v.dot(ax)).abs();
                let centre = c.dot(ax);
                (centre - e, centre + e)
            };
            let (a0, a1) = project(ca, a.yaw, a.w * 0.5, a.d * 0.5);
            let (b0, b1) = project(cb, b.yaw, b.w * 0.5, b.d * 0.5);
            let ov = a1.min(b1) - a0.max(b0);
            if ov <= 0.0 {
                return 0.0;
            }
            if ov < min_overlap {
                min_overlap = ov;
            }
        }
        let area = min_overlap * min_overlap;
        let smaller = (a.w * a.d).min(b.w * b.d).max(1e-3);
        (area / smaller).min(1.0)
    }

    fn kinds(map: &MapData) -> BTreeMap<u8, u32> {
        let mut m = BTreeMap::new();
        for s in &map.structures {
            *m.entry(s.kind as u8).or_insert(0) += 1;
        }
        m
    }

    /// Land / water balance and generation cost per map.
    ///
    /// The complaint this guards against: "maps are way too small — the archipelago is a
    /// small island in a huge empty sea". A map is only big enough if most of the world is
    /// *playable* ground, so the fraction of nav cells that are land is asserted, not just
    /// eyeballed in the ASCII dump. Two water numbers matter as well:
    ///
    /// * the `deep` class (below -0.6 m) — channels and the world rim, not an ocean;
    /// * `blue`, the share of the world deeper than 3 m. The sea shader blends from turquoise
    ///   to open-ocean blue over `smoothstep(0.5, 8.0, depth)`, so a world with little water
    ///   below 3 m still *reads* as turquoise shallows rather than empty blue field. This is
    ///   the number that actually answers the screenshot.
    #[test]
    fn map_scale_report() {
        let mut report = String::new();
        let mut failures: Vec<String> = Vec::new();
        for index in 0..4u32 {
            let t0 = std::time::Instant::now();
            let m = generate(1, index);
            let gen_ms = t0.elapsed().as_secs_f64() * 1e3;
            let mut land = 0u32;
            let mut shallow = 0u32;
            let mut deep = 0u32;
            let mut blocked = 0u32;
            let mut rock = 0u32;
            let mut blue = 0u32;
            let mut shelf = 0u32;
            for t in m.nav.iter() {
                match *t {
                    terrain::DEEP_WATER => deep += 1,
                    terrain::SHALLOW_WATER => shallow += 1,
                    terrain::ROCK => {
                        rock += 1;
                        land += 1;
                    }
                    terrain::BLOCKED => blocked += 1,
                    _ => land += 1,
                }
            }
            // Depth histogram straight off the heightfield (nav cells, via their corners).
            for iz in 0..GG {
                for ix in 0..GG {
                    let h = (m.heights[iz * V + ix]
                        + m.heights[iz * V + ix + 1]
                        + m.heights[(iz + 1) * V + ix]
                        + m.heights[(iz + 1) * V + ix + 1])
                        * 0.25;
                    if h < -3.0 {
                        blue += 1;
                    }
                    if h <= 0.05 && h > -1.5 {
                        shelf += 1;
                    }
                }
            }
            let cells = (GG * GG) as f32;
            report.push_str(&format!(
                "{:<15} {:.0} m, grid {GG}, cell {CELL:.1} m | land {:.1}% | shallow {:.1}% | <1.5 m {:.1}% | deep {:.1}% | >3 m deep {:.1}% | rock {:.1}% | blocked {:.1}% | structures {} | gen {gen_ms:.0} ms\n",
                m.name,
                W,
                land as f32 / cells * 100.0,
                shallow as f32 / cells * 100.0,
                shelf as f32 / cells * 100.0,
                deep as f32 / cells * 100.0,
                blue as f32 / cells * 100.0,
                rock as f32 / cells * 100.0,
                blocked as f32 / cells * 100.0,
                m.structures.len(),
            ));
            if (land as f32) / cells < 0.62 {
                failures.push(format!(
                    "{}: only {:.0}% of the world is land",
                    m.name,
                    land as f32 / cells * 100.0
                ));
            }
            // Open-ocean blue is what the user's screenshot was full of; only the authored
            // channels (and the thin world rim) may be deeper than 3 m.
            if (blue as f32) / cells > 0.10 {
                failures.push(format!(
                    "{}: {:.0}% of the world is more than 3 m deep - the sea reads as open ocean",
                    m.name,
                    blue as f32 / cells * 100.0
                ));
            }
            // A bright turquoise fringe along the beaches is the tropical look.
            if (shelf as f32) / cells < 0.04 {
                failures.push(format!(
                    "{}: only {:.1}% of the world is water shallower than 1.5 m - no turquoise waterline",
                    m.name,
                    shelf as f32 / cells * 100.0
                ));
            }
            // Sanity cap: the world may be wet, but it may not be mostly deep water.
            if (deep as f32) / cells > 0.42 {
                failures.push(format!(
                    "{}: {:.0}% deep water - too much empty sea",
                    m.name,
                    deep as f32 / cells * 100.0
                ));
            }
        }
        println!("{report}");
        assert!(
            failures.is_empty(),
            "map scale:\n  {}",
            failures.join("\n  ")
        );
    }

    #[test]
    fn names_and_wrapping() {
        assert_eq!(map_names().len(), 4);
        assert_eq!(map_names()[0], "Twin Atolls");
        let a = generate(7, 0);
        let b = generate(7, 4);
        assert_eq!(a.name, b.name);
        assert_eq!(checksum(&a), checksum(&b));
    }

    #[test]
    fn dimensions_and_determinism() {
        for seed in 1..6u32 {
            for index in 0..4u32 {
                let m = generate(seed, index);
                assert_eq!(m.heights.len(), V * V, "heights {seed}/{index}");
                assert_eq!(m.splat.len(), V * V * 4, "splat {seed}/{index}");
                assert_eq!(m.road.len(), V * V, "road {seed}/{index}");
                assert_eq!(m.nav.len(), GG * GG, "nav {seed}/{index}");
                assert_eq!(m.world_size, W);
                assert_eq!(m.grid, GRID);
                assert!((m.cell - CELL).abs() < 1e-6);
                let again = generate(seed, index);
                assert_eq!(
                    checksum(&m),
                    checksum(&again),
                    "not deterministic for seed {seed} index {index}"
                );
            }
        }
    }

    #[test]
    fn validates_and_is_walkable() {
        for seed in 1..6u32 {
            for index in 0..4u32 {
                let m = generate(seed, index);
                if let Err(e) = validate(&m) {
                    panic!("validate failed for seed {seed} index {index}: {e}");
                }
                for team in 0..2 {
                    let sp = m.spawn[team];
                    let fh = m.flag_home[team];
                    assert!(
                        m.height_at(sp.x, sp.y) > 0.2,
                        "spawn {team} underwater ({seed}/{index})"
                    );
                    assert!(
                        m.height_at(fh.x, fh.y) > 0.2,
                        "flag {team} underwater ({seed}/{index})"
                    );
                    assert!(
                        land_path_exists(&m, sp, fh),
                        "team {team} cannot reach its own flag ({seed}/{index})"
                    );
                }
                assert!(
                    land_path_exists(&m, m.spawn[0], m.flag_home[1]),
                    "no land path spawn0 -> flag1 ({seed}/{index})"
                );
                assert!(
                    land_path_exists(&m, m.spawn[1], m.flag_home[0]),
                    "no land path spawn1 -> flag0 ({seed}/{index})"
                );
            }
        }
    }

    #[test]
    fn no_solid_overlap() {
        for seed in 1..6u32 {
            for index in 0..4u32 {
                let m = generate(seed, index);
                let solids: Vec<&Structure> = m.structures.iter().filter(|s| s.solid()).collect();
                for i in 0..solids.len() {
                    for j in i + 1..solids.len() {
                        let f = overlap_frac(solids[i], solids[j]);
                        assert!(
                            f <= 0.15,
                            "solid overlap {:.2} between #{} (kind {}) and #{} (kind {}) seed {} index {}",
                            f,
                            solids[i].id,
                            solids[i].kind,
                            solids[j].id,
                            solids[j].kind,
                            seed,
                            index
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn structural_invariants() {
        for seed in 1..6u32 {
            for index in 0..4u32 {
                let m = generate(seed, index);
                let tag = format!("seed {seed} index {index} ({})", m.name);
                let k = kinds(&m);
                let get = |kind: u8| *k.get(&kind).unwrap_or(&0);
                // Base complexes, mirrored.
                assert_eq!(get(skind::GARAGE), 2, "garages {tag}");
                assert_eq!(get(skind::HQ), 2, "hq {tag}");
                assert_eq!(get(skind::FLAG_POLE), 2, "flag poles {tag}");
                assert_eq!(get(skind::FUEL_DEPOT), 2, "fuel {tag}");
                assert_eq!(get(skind::AMMO_TENT), 2, "ammo {tag}");
                assert_eq!(get(skind::HELIPAD), 2, "helipads {tag}");
                assert_eq!(get(skind::WATCHTOWER), 2, "watchtowers {tag}");
                assert_eq!(get(skind::RADAR), 2, "radars {tag}");
                assert!(get(skind::GATE) >= 2, "gates {tag}");
                assert!(get(skind::BUNKER) >= 4, "bunkers {tag}");
                assert!(get(skind::TURRET_TOWER) >= 4, "turrets {tag}");
                assert!(get(skind::WALL) >= 24, "walls {tag}");
                // Crossings: every bridge crossing is a chain of 2..6 abutting pieces, so
                // the map total scales with how many crossings and how wide they are.
                // (A self-mirrored crossing on the map centre line contributes an odd
                // number of pieces, so only the range is asserted here; the per-crossing
                // chain structure is proven by tests/bridge_audit.rs.)
                let decks = get(skind::BRIDGE);
                assert!((4..=30).contains(&decks), "bridge decks {} {tag}", decks);
                // Scatter / interest. Palms and rocks are instanced (one draw call per
                // variant), so their budget is a *density*: the tropical look wants roughly
                // one palm per 900 m^2 of world and one rock per 1300 m^2, and the band below
                // is wide enough to survive seed variation while still catching a map that
                // forgot to scale its scatter with the world.
                let world_m2 = W * W;
                let palms = get(skind::PALM) as f32;
                assert!(
                    palms >= world_m2 / 4000.0 && palms <= world_m2 / 500.0,
                    "palms {palms} over {world_m2} m^2 {tag}"
                );
                let rocks = get(skind::ROCK) as f32;
                assert!(
                    rocks >= world_m2 / 20000.0 && rocks <= world_m2 / 900.0,
                    "rocks {rocks} over {world_m2} m^2 {tag}"
                );
                assert!(get(skind::WRECK) >= 1, "wrecks {tag}");
                assert!(get(skind::TENT) >= 2, "tents {tag}");
                assert!(get(skind::BUILDING) >= 2, "buildings {tag}");
                assert!(
                    get(skind::LIGHTHOUSE) + get(skind::ANTENNA) >= 2,
                    "landmarks {tag}"
                );
                assert_eq!(get(skind::NONE), 0, "no NONE structures {tag}");

                for s in &m.structures {
                    assert!(s.hp_max > 0.0 && s.hp == s.hp_max, "hp {tag}");
                    assert!(s.team <= 2.0, "team {tag}");
                    assert!(s.w > 0.0 && s.d > 0.0 && s.h > 0.0, "dims {tag}");
                    assert!(obb_inside_world(s, W), "outside world {tag}");
                }
                // Flag plazas and spawn pads stay clear of solid structures.
                for team in 0..2 {
                    for p in [m.spawn[team], m.flag_home[team]] {
                        for s in m.structures.iter().filter(|s| s.solid()) {
                            assert!(
                                obb_dist(p, s) > 1.2,
                                "structure {} sits on a plaza {tag}",
                                s.id
                            );
                        }
                    }
                }

                // Nav sanity.
                let mut land = 0u32;
                let mut blocked = 0u32;
                for cz in 0..GG {
                    for cx in 0..GG {
                        let t = m.nav[cz * GG + cx];
                        if t == terrain::BLOCKED {
                            blocked += 1;
                        } else if !terrain::is_water(t) {
                            land += 1;
                        }
                    }
                }
                assert!(land > 2000, "not enough land {tag}");
                assert!(blocked > 100, "structures do not block nav {tag}");
                assert!(
                    (blocked as f32) < (land as f32) * 0.45,
                    "nav too clogged {tag}"
                );

                // Terrain quality: no 1-vertex spikes, walkable gradients inland, a
                // landmark hill per map. Coastal bluffs are allowed to be steep (they are
                // the ROCK cells), so gradient is only checked well away from the water.
                let mut max_h = f32::MIN;
                let mut spike = 0u32;
                let mut steep = 0u32;
                let mut inland = 0u32;
                let mut land_v = 0u32;
                for iz in 3..V - 3 {
                    for ix in 3..V - 3 {
                        let i = iz * V + ix;
                        let h = m.heights[i];
                        max_h = max_h.max(h);
                        if h <= 0.2 {
                            continue;
                        }
                        land_v += 1;
                        let nbr = [
                            m.heights[i - 1],
                            m.heights[i + 1],
                            m.heights[i - V],
                            m.heights[i + V],
                        ];
                        let wet = nbr.iter().any(|v| *v < 0.25)
                            || (-3..=3).any(|dz| {
                                (-3..=3).any(|dx| {
                                    m.heights[((iz as i32 + dz) as usize) * V
                                        + (ix as i32 + dx) as usize]
                                        <= 0.05
                                })
                            });
                        if wet {
                            continue;
                        }
                        inland += 1;
                        let mx = nbr.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                        if h > mx + 2.2 {
                            spike += 1;
                        }
                        if m.slope_at(ix as f32 * CELL, iz as f32 * CELL).len() > 1.15 {
                            steep += 1;
                            if steep < 7 && seed == 2 && index == 0 {
                                println!(
                                    "STEEP ({:.0},{:.0}) h={:.2} nbrs {:.2} {:.2} {:.2} {:.2} sl={:.2}",
                                    ix as f32 * CELL,
                                    iz as f32 * CELL,
                                    h,
                                    nbr[0],
                                    nbr[1],
                                    nbr[2],
                                    nbr[3],
                                    m.slope_at(ix as f32 * CELL, iz as f32 * CELL).len()
                                );
                            }
                        }
                    }
                }
                assert_eq!(spike, 0, "terrain spikes {tag}");
                assert!(max_h >= 14.0, "no landmark hill {tag} (max {max_h})");
                assert!(max_h <= 30.0, "terrain too tall {tag} ({max_h})");
                assert!(
                    inland > (land_v / 4),
                    "not enough inland terrain {tag} ({inland}/{land_v})"
                );
                assert!(
                    (steep as f32) < (inland as f32) * 0.05,
                    "too much impassable slope inland {tag} ({steep}/{inland})"
                );

                // Splat weights sum to ~255 and stay in range.
                for i in 0..V * V {
                    let sum = m.splat[i * 4] as u32
                        + m.splat[i * 4 + 1] as u32
                        + m.splat[i * 4 + 2] as u32
                        + m.splat[i * 4 + 3] as u32;
                    assert!((250..=260).contains(&sum), "splat sum {} {tag}", sum);
                }

                // Exact 180 degree symmetry of terrain, splat, road and nav.
                for iz in 0..V {
                    for ix in 0..V {
                        let i = iz * V + ix;
                        let j = (V - 1 - iz) * V + (V - 1 - ix);
                        assert_eq!(
                            m.heights[i].to_bits(),
                            m.heights[j].to_bits(),
                            "height asymmetry {tag}"
                        );
                        assert_eq!(m.road[i], m.road[j], "road asymmetry {tag}");
                        for c in 0..4 {
                            assert_eq!(
                                m.splat[i * 4 + c],
                                m.splat[j * 4 + c],
                                "splat asymmetry {tag}"
                            );
                        }
                    }
                }
                for cz in 0..GG {
                    for cx in 0..GG {
                        let i = cz * GG + cx;
                        let j = (GG - 1 - cz) * GG + (GG - 1 - cx);
                        assert_eq!(m.nav[i], m.nav[j], "nav asymmetry {tag}");
                    }
                }

                // Spawn pads are paved.
                for team in 0..2 {
                    let sp = m.spawn[team];
                    let ci = clamp((sp.y / CELL).floor(), 0.0, (GG - 1) as f32) as usize * GG
                        + clamp((sp.x / CELL).floor(), 0.0, (GG - 1) as f32) as usize;
                    assert_eq!(
                        m.nav[ci],
                        terrain::ROAD,
                        "spawn pad is not paved {tag} team {team}"
                    );
                }
            }
        }
    }

    /// A lane lifted out of the water is a ford, not a highway: it has to come out of the
    /// generator as a sandbar.
    ///
    /// Regression guard for the "unnatural stone road". The lift keeps the protected route
    /// cell, and `stamp_roads` had already painted that cell at the route's 255 asphalt
    /// level; the surface shader bakes the mask straight into a bright grey strip standing
    /// in the sea. Nav class, occupancy and drivability are deliberately untouched - only
    /// the baked mask changes - so the mask is the one thing to assert on.
    #[test]
    fn a_lane_lifted_out_of_the_water_is_never_paved() {
        for index in 0..4u32 {
            for seed in [1u32, 7, 42, 99] {
                let (m, lifted) = generate_with_lift_mask(seed, index);
                let n = lifted.iter().filter(|b| **b).count();
                // Without this the test would pass vacuously the day the lift stops firing.
                assert!(
                    n > 20,
                    "{} seed {seed}: only {n} lifted vertices - the waterline lift is not running",
                    m.name
                );
                for (i, is_lifted) in lifted.iter().enumerate() {
                    if *is_lifted {
                        assert_eq!(
                            m.road[i], 0,
                            "{} seed {seed}: vertex {i} is a lane lifted out of the water but \
                             carries road mask {} - asphalt standing in the sea",
                            m.name, m.road[i]
                        );
                    }
                }
            }
        }
    }
}


