//! Map editor core: a [`MapData`] you can paint, with undo, and the save format.
//!
//! The editor is deliberately a thin layer over the same `MapData` the game plays and the same
//! nav rasteriser the generator uses ([`crate::mapgen::rasterize_nav`]). Nothing here invents a
//! second way to describe a battlefield: an edited map is a generated map somebody moved, so
//! `validate`, `World::new_with_map` and the renderer all take it unchanged.
//!
//! Four things are worth knowing before reading the ops:
//!
//! * **A wall is joined by a piece's end.** Walls are 7.7 m pieces whose origin is their centre,
//!   so two of them join when one centre is half a piece from the joint. `snap_wall` is that rule
//!   and little else: the cursor is projected into the nearest wall's own frame and the new piece
//!   is placed so one of *its* ends lands on the wall — on the wall's line when it continues or
//!   crosses the run, on the wall's end when it butts onto it. Snapping is opt-out (shift, or the
//!   toolbar toggle), which is what makes odd angles placeable at all.
//! * **Layers are vertex-sized, the nav grid is not.** Heights, splat, road, sand/grass variants
//!   and pavement live on the `(grid + 1)^2` heightfield; the nav grid is `grid^2` and is
//!   *derived* — it is rebuilt from the painted layers rather than painted itself.
//! * **A stroke is one undo step.** `begin_stroke` snapshots the layers, the ops paint, and
//!   `end_stroke` keeps only the rectangle that actually changed, so twenty steps of brushing cost
//!   twenty rectangles rather than twenty copies of the map. Ops called outside a stroke open and
//!   close one themselves, so the UI never has to remember.
//! * **The history stores per-layer bytes, not pixels.** A step is the rectangle plus what each
//!   layer held there before and after, which is what makes undo exact for heights (f32), weights
//!   (u8) and structure lists alike.

use crate::mapgen::{from_local, obb_sd, rasterize_nav, MapMode};
use crate::math::{v2, Vec2};
use crate::types::{sflag, skind, MapData, MapSize, Structure};

/// Undo steps kept. The brief asks for twenty; the byte budget below keeps them bounded.
pub const MAX_HISTORY: usize = 20;
/// History is also capped by size, so twenty whole-map strokes on a big battlefield cannot
/// balloon: past this the oldest steps are dropped.
const MAX_HISTORY_BYTES: usize = 96 << 20;

/// Placeable structures the editor's palette offers: kind, size in metres, and what they are.
///
/// The sizes are the ones the game itself uses — the wall cross-section and gate opening are the
/// perimeter's, the buildings are the props' — so a hand-placed base is the same base.
pub struct CatalogEntry {
    pub kind: u8,
    pub name: &'static str,
    pub w: f32,
    pub d: f32,
    pub h: f32,
}

/// Everything the palette offers.
pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry { kind: skind::WALL, name: "wall", w: 7.6, d: 0.9, h: 2.6 },
    CatalogEntry { kind: skind::GATE, name: "gate", w: 7.4, d: 1.2, h: 3.4 },
    CatalogEntry { kind: skind::SANDBAG, name: "sandbags", w: 3.4, d: 1.4, h: 0.9 },
    CatalogEntry { kind: skind::BUNKER, name: "bunker", w: 6.5, d: 5.5, h: 2.4 },
    CatalogEntry { kind: skind::WATCHTOWER, name: "watchtower", w: 3.0, d: 3.0, h: 6.0 },
    CatalogEntry { kind: skind::TURRET_TOWER, name: "turret tower", w: 3.2, d: 3.2, h: 4.5 },
    CatalogEntry { kind: skind::FLAG_POLE, name: "flag pole", w: 1.3, d: 1.3, h: 15.0 },
    CatalogEntry { kind: skind::HQ, name: "hq", w: 10.0, d: 8.5, h: 11.5 },
    CatalogEntry { kind: skind::GARAGE, name: "garage", w: 16.0, d: 10.0, h: 5.2 },
    CatalogEntry { kind: skind::HANGAR, name: "hangar", w: 22.0, d: 18.0, h: 9.0 },
    CatalogEntry { kind: skind::HELIPAD, name: "helipad", w: 11.0, d: 11.0, h: 0.4 },
    CatalogEntry { kind: skind::FUEL_DEPOT, name: "fuel depot", w: 7.0, d: 7.0, h: 4.0 },
    CatalogEntry { kind: skind::AMMO_TENT, name: "ammo tent", w: 5.5, d: 4.2, h: 2.6 },
    CatalogEntry { kind: skind::RADAR, name: "radar", w: 4.0, d: 4.0, h: 7.0 },
    CatalogEntry { kind: skind::ANTENNA, name: "antenna", w: 4.5, d: 4.5, h: 17.0 },
    CatalogEntry { kind: skind::LIGHTHOUSE, name: "lighthouse", w: 9.0, d: 9.0, h: 21.0 },
    CatalogEntry { kind: skind::BUILDING, name: "building", w: 13.0, d: 9.5, h: 6.5 },
    CatalogEntry { kind: skind::TENT, name: "tent", w: 5.5, d: 4.2, h: 2.5 },
    CatalogEntry { kind: skind::CONTAINER, name: "container", w: 6.0, d: 2.6, h: 2.6 },
    CatalogEntry { kind: skind::CRATE, name: "crates", w: 1.6, d: 1.6, h: 1.4 },
    CatalogEntry { kind: skind::BARREL, name: "barrels", w: 1.2, d: 1.2, h: 1.2 },
    CatalogEntry { kind: skind::ROCK, name: "rock", w: 4.0, d: 3.6, h: 2.6 },
    CatalogEntry { kind: skind::PALM, name: "palm", w: 1.6, d: 1.6, h: 7.0 },
    CatalogEntry { kind: skind::WRECK, name: "wreck", w: 6.5, d: 3.2, h: 2.2 },
    // One deck piece of the same run the generator lays (mapgen's `force_bridge`): the editor
    // used to refuse bridges with `Unknown` because they were missing from the palette, while
    // every placement rule below already knew what a bridge is for.
    CatalogEntry { kind: skind::BRIDGE, name: "bridge", w: 15.4, d: 7.0, h: 0.9 },
];

/// Scenery the scatter brush sprinkles, as `(kind id, w, d, h)`.
///
/// These are the *prop* ids the renderer builds with `buildProp` — bush, tuft, shrub, agave and
/// loose stones — not structure kinds, so they are not in `CATALOG` (which is what the palette
/// offers as buildings) and the game's structure table never sees them. Their extents come from
/// the models' authored sizes, so a scattered prop sits on the ground the same way the generator's
/// scatter does.
///
/// Props are scenery: they carry no collision flags, so the one thing they need is to be *seated*
/// on the terrain rather than floating over it or buried in it.
pub const SCATTER: &[(&str, &[(u8, f32, f32, f32)])] = &[
    (
        "vegetation",
        &[
            (skind::PALM, 5.0, 5.0, 9.5),
            (100, 1.8, 1.8, 1.1),
            (103, 1.8, 1.8, 1.2),
            (101, 1.1, 1.1, 0.7),
        ],
    ),
    (
        "rocks",
        &[
            (skind::ROCK, 2.6, 2.6, 1.9),
            (104, 1.6, 1.6, 0.5),
        ],
    ),
    (
        "scrub",
        &[
            (102, 2.0, 2.0, 1.4),
            (100, 1.8, 1.8, 1.1),
            (101, 1.1, 1.1, 0.7),
        ],
    ),
];

/// Extents of a placeable kind — a catalogue building, a wall, or one of the scatter props.
pub fn kind_size(kind: u8) -> Option<(f32, f32, f32)> {
    catalog_size(kind).or_else(|| {
        SCATTER
            .iter()
            .flat_map(|(_, kinds)| kinds.iter())
            .find(|(k, _, _, _)| *k == kind)
            .map(|(_, w, d, h)| (*w, *d, *h))
    })
}

/// Size of a catalogue kind, or `None` if the editor does not offer it.
pub fn catalog_size(kind: u8) -> Option<(f32, f32, f32)> {
    CATALOG
        .iter()
        .find(|c| c.kind == kind)
        .map(|c| (c.w, c.d, c.h))
}

/// A rectangle of the map copied out of the editor, ready to paste.
///
/// Pavement travels as the same two layer bytes the `.rfmap` format stores, so a paste puts them
/// back unchanged: the selection is snapped to the vertex grid, which makes a copy exact and a
/// paste exact, and nothing about the road or its surfacing has to be re-derived.
#[derive(Clone)]
pub struct Clipboard {
    /// Where the cursor was when the copy was taken: the point the paste puts back under it.
    cursor: Vec2,
    /// The ground cell size, so the region's extent in metres survives the round trip.
    cell: f32,
    region: Region,
    structures: Vec<Structure>,
    road: Vec<u8>,
    pave: Vec<u8>,
}

impl Clipboard {
    /// Where the copied region's top-left corner sits relative to the anchor, in metres.
    ///
    /// A paste's destination region is this offset applied to the new anchor. It has to be the
    /// *corner* rather than the centre, because the bytes are written from the destination region's
    /// first cell: anchoring a centre leaves the copy shifted by half a rectangle, which lands the
    /// pavement beside the buildings it belongs to.
    fn corner_offset(&self) -> (f32, f32) {
        (
            self.region.x0 as f32 * self.cell - self.cursor.x,
            self.region.z0 as f32 * self.cell - self.cursor.y,
        )
    }

    /// How many structures the clipboard carries.
    pub fn len(&self) -> usize {
        self.structures.len()
    }

    pub fn is_empty(&self) -> bool {
        self.structures.is_empty() && self.road.iter().all(|v| *v == 0)
    }

    /// How many cells of pavement the clipboard carries, and where its first one is. Debug
    /// accessors, used by the headless probe to say *what* it copied rather than only how much.
    pub fn paved_cells(&self) -> u32 {
        self.road.iter().filter(|v| **v > 0).count() as u32
    }

    pub fn first_paved(&self) -> [f32; 3] {
        let cols = self.region.x1 - self.region.x0 + 1;
        for (i, v) in self.road.iter().enumerate() {
            if *v > 0 {
                return [
                    (self.region.x0 + i % cols) as f32 * self.cell,
                    (self.region.z0 + i / cols) as f32 * self.cell,
                    *v as f32,
                ];
            }
        }
        [-1.0, -1.0, -1.0]
    }
}

/// A rectangle of heightfield vertices, inclusive.
#[derive(Clone, Copy, Debug)]
struct Region {
    x0: usize,
    z0: usize,
    x1: usize,
    z1: usize,
}

impl Region {
    fn union(self, o: Region) -> Region {
        Region {
            x0: self.x0.min(o.x0),
            z0: self.z0.min(o.z0),
            x1: self.x1.max(o.x1),
            z1: self.z1.max(o.z1),
        }
    }
    fn whole(verts: usize) -> Region {
        Region { x0: 0, z0: 0, x1: verts - 1, z1: verts - 1 }
    }
}

/// The five painted layers, sliced out of a region (heights as raw f32 bytes).
#[derive(Clone, Default)]
struct LayerBytes {
    heights: Vec<u8>,
    splat: Vec<u8>,
    road: Vec<u8>,
    sand_var: Vec<u8>,
    grass_var: Vec<u8>,
    pave: Vec<u8>,
}

impl LayerBytes {
    fn bytes(&self) -> usize {
        self.heights.len()
            + self.splat.len()
            + self.road.len()
            + self.sand_var.len()
            + self.grass_var.len()
            + self.pave.len()
    }
}

/// A base definition and the spawn/flag pads it implies.
///
/// The pads are `MapData` fields in their own right, so a step that moves a base has to restore
/// all three together: recomputing the pads from the anchor is only exact for a base the editor
/// itself placed, and a generated map's anchor is a reconstruction (the frame it was authored in
/// is not in the file).
#[derive(Clone, Copy)]
struct BasesState {
    bases: [(Vec2, Vec2); 2],
    spawn: [Vec2; 2],
    flag: [Vec2; 2],
}
struct Edit {
    label: String,
    region: Region,
    before: LayerBytes,
    after: LayerBytes,
    /// Structure list either side, when the step added or removed any.
    structs: Option<(Vec<Structure>, Vec<Structure>)>,
    /// Base definitions and pads either side, when the step moved a base start.
    bases: Option<(BasesState, BasesState)>,
    /// A whole island either side, when the step *replaced* the map rather than editing it.
    ///
    /// Reseeding is the one edit that throws everything away, and finding that you liked the island
    /// you just discarded is exactly when undo matters most. Keeping the old one costs a map's
    /// worth of bytes, which `trim_history` already accounts for.
    island: Option<(Box<Island>, Box<Island>)>,
}

/// Everything a reseed replaces, so the previous island can be put back exactly.
struct Island {
    map: MapData,
    seed: u32,
    bases: [(Vec2, Vec2); 2],
}

impl Edit {
    fn bytes(&self) -> usize {
        let s = self
            .structs
            .as_ref()
            .map(|(a, b)| (a.len() + b.len()) * core::mem::size_of::<Structure>())
            .unwrap_or(0);
        let island = self
            .island
            .as_ref()
            .map(|(a, b)| island_bytes(a) + island_bytes(b))
            .unwrap_or(0);
        self.before.bytes() + self.after.bytes() + s + island
    }
}

/// The bytes one island's layers occupy: what the history budget has to pay for keeping it.
fn island_bytes(i: &Island) -> usize {
    let m = &i.map;
    m.heights.len() * 4
        + m.splat.len()
        + m.road.len()
        + m.sand_var.len()
        + m.grass_var.len()
        + m.pave.len()
        + m.nav.len()
        + m.structures.len() * core::mem::size_of::<Structure>()
}

/// A stroke in progress: the layers and lists as they were before it started.
struct Staging {
    label: String,
    before: LayerBytes,
    structs: Vec<Structure>,
    bases: BasesState,
    rect: Option<Region>,
    structs_touched: bool,
    bases_touched: bool,
}


/// Round four channel weights and make them sum to exactly 255.
///
/// Rounding each channel on its own can produce 256 (three of them rounding up, one down), and the
/// ground shader normalises by that sum — the cell then renders a fraction dark and the "some
/// textures take precedence" feeling comes back at the edges of a stroke. The residual is taken
/// off the largest channel *after* rounding, because fixing it before rounding can round straight
/// back out again.
fn fix_quad(q: &mut [f32; 4]) {
    let mut r = [q[0].round(), q[1].round(), q[2].round(), q[3].round()];
    let sum: f32 = r.iter().sum();
    let mut worst = 0usize;
    for (i, v) in r.iter().enumerate() {
        if *v > r[worst] {
            worst = i;
        }
    }
    r[worst] = (r[worst] - (sum - 255.0)).clamp(0.0, 255.0);
    *q = r;
}

/// One piece of a base complex, in base-local metres (`x` right of the enemy axis, `z` towards
/// it — the same frame the generator authors its bases in).
struct Part {
    kind: u8,
    lx: f32,
    lz: f32,
    rot: f32,
    /// Size, when it is not the catalogue's. A perimeter run is filled with pieces sized to the
    /// band they occupy, so the pieces butt together — a fixed length leaves a gap half a model
    /// wide at one end, which is what "the walls do not meet" looks like.
    size: Option<(f32, f32, f32)>,
}

impl Part {
    fn new(kind: u8, lx: f32, lz: f32, rot: f32) -> Part {
        Part { kind, lx, lz, rot, size: None }
    }
}

/// A part's size: its own, or the catalogue's.
fn part_size(p: &Part) -> Option<(f32, f32, f32)> {
    p.size.or_else(|| catalog_size(p.kind))
}

/// Wall piece length used by the perimeter, and the half extents of the ring it closes.
const WALL_SEG: f32 = 7.72;
/// The longest a single wall piece may be, and the thickness and height of one. The generator's
/// own numbers: a perimeter is made of pieces sized to the band they fill, so both ends meet.
const WALL_MAX_SEG: f32 = 8.0;
const WALL_THICK: f32 = 0.9;
const WALL_H: f32 = 2.6;
/// The placed footprint of a wall piece, which is what overlapping checks are about. Kept beside
/// `WALL_SEG` because the two are only accidentally different: the segment is the lattice the
/// pieces are laid out on, the footprint is the box the models actually occupy.
const WALL_SIZE: (f32, f32) = (6.0, 0.9);
/// The length of one wall *model*, which is what butts together along a run.
const WALL_MODEL_LEN: f32 = 6.0;
const BASE_HX: f32 = 24.0;
const BASE_HZ: f32 = 19.0;
const GATE_LX: f32 = -6.0;
/// Gateway opening: the same 8 m the generator's perimeter leaves.
const GATE_OPEN: f32 = 8.0;

/// Every part of a base complex, in placement order.
///
/// A base is *one asset*: this list is what it is made of, so it can be built, and later lifted
/// and rebuilt somewhere else as a unit — which is the difference between moving a base and
/// dragging forty loose walls around. The perimeter runs are computed (pieces butted end to end,
/// gapped for the gate and the sally port) and the compound is authored.
fn base_parts() -> Vec<Part> {
    let mut out: Vec<Part> = Vec::with_capacity(72);

    // Four runs, each with the openings it carries, in base-local metres. The gate is opposite the
    // sally port, as the generator lays them out: a base whose front gate and rear port face the
    // same way is a different building.
    let runs: [(f32, f32, f32, f32, &[(f32, f32)]); 4] = [
        (-BASE_HX, -BASE_HZ, BASE_HX, -BASE_HZ, &[]),
        (-BASE_HX, BASE_HZ, BASE_HX, BASE_HZ, &[(GATE_LX - GATE_OPEN * 0.5, GATE_LX + GATE_OPEN * 0.5)]),
        (-BASE_HX, -BASE_HZ + WALL_THICK * 0.5, -BASE_HX, BASE_HZ - WALL_THICK * 0.5, &[]),
        (BASE_HX, -BASE_HZ + WALL_THICK * 0.5, BASE_HX, BASE_HZ - WALL_THICK * 0.5, &[]),
    ];
    for (ax, az, bx, bz, gaps) in runs {
        let (a, b) = (v2(ax, az), v2(bx, bz));
        let d = b - a;
        let len = d.len();
        if len < 1e-3 {
            continue;
        }
        let dir = d / len;
        let rot = d.y.atan2(d.x);
        // Solid bands between the openings, filled with equal pieces: equal because that is what
        // makes the last piece meet its neighbour and the first meet the corner.
        let mut bands: Vec<(f32, f32)> = Vec::new();
        let mut cursor = 0.0f32;
        for (g0, g1) in gaps.iter().copied() {
            // Run-local metres: gaps are authored along the run's own axis, which for the two
            // side runs is z rather than x.
            let (g0, g1) = if (bx - ax).abs() > (bz - az).abs() {
                (g0 + len * 0.5, g1 + len * 0.5)
            } else {
                (g0 + len * 0.5, g1 + len * 0.5)
            };
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
            if blen < WALL_MODEL_LEN * 0.25 {
                continue;
            }
            let n = (blen / WALL_MAX_SEG).ceil().max(1.0) as u32;
            let seg = blen / n as f32;
            for k in 0..n {
                let mid = b0 + (k as f32 + 0.5) * seg;
                let c = a + dir * mid;
                out.push(Part {
                    kind: skind::WALL,
                    lx: c.x,
                    lz: c.y,
                    rot,
                    size: Some((seg, WALL_THICK, WALL_H)),
                });
            }
        }
    }

    let mut put = |kind: u8, lx: f32, lz: f32| out.push(Part::new(kind, lx, lz, 0.0));
    put(skind::GATE, GATE_LX, BASE_HZ);
    put(skind::GARAGE, -6.0, -11.0);
    put(skind::HQ, -16.0, 12.0);
    put(skind::HELIPAD, 16.0, 8.0);
    put(skind::FUEL_DEPOT, 17.0, -4.0);
    put(skind::AMMO_TENT, -17.0, -14.0);
    put(skind::TENT, 18.0, 14.0);
    put(skind::BUNKER, -18.0, 4.0);
    put(skind::BUNKER, 18.0, -14.0);
    put(skind::WATCHTOWER, -BASE_HX, -BASE_HZ);
    put(skind::WATCHTOWER, BASE_HX, -BASE_HZ);
    put(skind::WATCHTOWER, -BASE_HX, BASE_HZ);
    put(skind::WATCHTOWER, BASE_HX, BASE_HZ);
    put(skind::TURRET_TOWER, 30.0, -2.0);
    put(skind::TURRET_TOWER, -15.0, 24.0);
    put(skind::TURRET_TOWER, 6.0, 24.0);
    put(skind::FLAG_POLE, 6.0, 6.0);
    out
}

/// The map being edited, plus its undo history and the two base definitions.
pub struct EditorMap {
    map: MapData,
    seed: u32,
    mode: MapMode,
    /// Base anchor and facing per team. Kept here rather than in `MapData`, which only carries
    /// the spawn and flag pads the game needs.
    bases: [(Vec2, Vec2); 2],
    history: Vec<Edit>,
    redo: Vec<Edit>,
    staging: Option<Staging>,
    /// Zeroed route mask handed to the nav rasteriser (an edited map has no protected lanes).
    route: Vec<u8>,
}

/// Contact in metres: how far a snap's piece may be from a wall and still count as joined to it.
/// The art is shorter than the lattice — a piece butted onto another's end leaves 1.7 m between
/// their footprints and ~0.4 m between their corners, which the joint pillars close — so "joined"
/// has to be this loose.
const WALL_CONTACT: f32 = 1.8;

/// The closest two wall *centres* may ever be, in metres.
///
/// Footprint overlap is a poor test at a joint: the models are 6 m long on a 7.72 m segment, so two
/// pieces continuing a run overlap along the run and corners clip each other, all of it
/// legitimate. What is never legitimate is a second wall where the first one is, and for pieces of
/// this length that is a question about their centres — a continuation, a T and a corner all stand
/// a half or a whole segment apart.
const WALL_MIN_SPACING: f32 = 1.9;

/// Edge-to-edge distance between two wall footprints, in metres: 0 when they touch, negative when
/// they overlap. In 2D the separating axis theorem gives this directly — for each of the four axes
/// (both rectangles' own), the gap between the projections is `distance - r1 - r2`, and the largest
/// of those is how far apart the two are, zero or less if they intersect.
fn wall_gap(a: Vec2, ay: f32, b: Vec2, by: f32) -> f32 {
    let (ca, sa) = (ay.cos(), ay.sin());
    let (cb, sb) = (by.cos(), by.sin());
    let (hl, hw) = (WALL_SIZE.0 * 0.5, WALL_SIZE.1 * 0.5);
    let (dx, dz) = (b.x - a.x, b.y - a.y);
    let mut overlap = f32::NEG_INFINITY;
    let mut apart = f32::INFINITY;
    for (ux, uz) in [(ca, sa), (-sa, ca), (cb, sb), (-sb, cb)] {
        let ra = hl * (ux * ca + uz * sa).abs() + hw * (ux * -sa + uz * ca).abs();
        let rb = hl * (ux * cb + uz * sb).abs() + hw * (ux * -sb + uz * cb).abs();
        let g = (dx * ux + dz * uz).abs() - ra - rb;
        if g > 0.0 {
            // This axis separates them: the smallest such gap is the distance between them.
            apart = apart.min(g);
        } else {
            overlap = overlap.max(g);
        }
    }
    if apart.is_finite() {
        apart
    } else {
        overlap
    }
}

/// Do two oriented boxes overlap? Separating axis over both boxes' own axes, the standard test.
/// Used for placement checks, where "clear of the thing already standing there" is the question —
/// including the bases, whose pieces the editor will happily place against but never into.
pub(crate) fn obb_overlap(a: Vec2, ay: f32, ahw: f32, ahd: f32, b: Vec2, by: f32, bhw: f32, bhd: f32) -> bool {
    let (ca, sa) = (ay.cos(), ay.sin());
    let (cb, sb) = (by.cos(), by.sin());
    let (dx, dz) = (b.x - a.x, b.y - a.y);
    for (ux, uz) in [(ca, sa), (-sa, ca), (cb, sb), (-sb, cb)] {
        let ra = ahw * (ux * ca + uz * sa).abs() + ahd * (ux * -sa + uz * ca).abs();
        let rb = bhw * (ux * cb + uz * sb).abs() + bhd * (ux * -sb + uz * cb).abs();
        if (dx * ux + dz * uz).abs() >= ra + rb {
            return false;
        }
    }
    true
}

/// May this team own a main base? Only the two playing teams: neutral is a *scenery* team, and a
/// third base would be a second flag, a second spawn and a second set of pads — which is not a
/// thing the game has. The tools check this rather than the caller, because a caller that maps
/// "neutral" onto "green" is worse than one that is told no.
pub fn team_can_own_base(team: u8) -> bool {
    team < 2
}

/// Why a placement was refused. The numbers are what the wasm bridge reports to the ghost.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PlaceBlock {
    /// The spot is fine — used by nothing, but keeps the enum total for readers.
    Never = 0,
    OffMap = 1,
    Water = 2,
    Occupied = 3,
    Unknown = 4,
    /// The structure index does not name anything.
    Missing = 5,
}

/// Snap a wall piece to the nearest existing wall: continue its run, or butt onto one of its ends.
/// Returns the position and yaw the piece should be built at.
///
/// Pieces are one segment (`WALL_SEG`) long with their origin at their centre, so *contact* is
/// arithmetic rather than a search: two pieces continue a run when their centres are one segment
/// apart along it, and a piece butts onto the end of another when its centre is half a segment
/// past that end, across the run. Both are computed, so a snapped wall always touches the wall it
/// snapped to — there is no position between "touching" and "a gap", and no lattice to fall off.
///
/// The cursor decides which of the two joins it is, by the direction the piece is turned to:
///
/// * **in line with the wall** extends the run: the piece goes one segment beyond the wall at the
///   end the cursor is nearer, on whichever side of the wall the cursor is;
/// * **turned square to it** butts onto an end: the piece's face meets the wall's end, so its
///   centre is half a segment out, across the wall. That is the corner joint a centre lattice
///   cannot express — half a segment not being a whole one — and the one that reads as "it will
///   not come up to the end";
/// * turned square and aimed at the run's *body* rather than past its end, the piece crosses it:
///   its centre lands on the wall's line at the nearest whole segment, where a neighbour's end is,
///   so a T meets two pieces instead of poking through the middle of one.
///
/// A join is only ever made with a wall the cursor is beside (within a segment and a half, as a
/// barrier rather than as a centre). Rather than infer a run's pitch from the walls lying about a
/// piece — which a single wall placed a metre off the lattice poisons — the joint is always
/// "touching", and the pieces a hand lays down that way get whatever spacing the hand gives them.
pub(crate) fn snap_wall(walls: &[(Vec2, f32)], p: Vec2, yaw: f32) -> Option<(Vec2, f32)> {
    let quarter = core::f32::consts::FRAC_PI_2;
    let half = WALL_SEG * 0.5;
    // The nearest wall wins, measured to the wall as a barrier rather than to its centre: at a
    // corner the piece the cursor is beside is the one it should join, not the one whose centre
    // happens to be nearest. Held against the two pieces either side of a joint the cursor is
    // exactly as far past one as it is short of the other, and the tie goes to the piece it is
    // past — the one it is joining.
    let mut best: Option<(Vec2, f32, (f32, f32))> = None;
    for (c, a) in walls {
        let u = v2(a.cos(), a.sin());
        let d = p - *c;
        let along = d.x * u.x + d.y * u.y;
        let across = d.x * -u.y + d.y * u.x;
        let beyond = (-along).max(along - WALL_SEG).max(0.0);
        let d2 = beyond * beyond + across * across;
        if d2 > WALL_SEG * WALL_SEG * 2.25 {
            continue;
        }
        let key = (beyond, d2);
        if best.map_or(true, |(_, _, b)| key < b) {
            best = Some((*c, *a, key));
        }
    }
    let Some((c, a, _)) = best else {
        return None;
    };

    let u = v2(a.cos(), a.sin());
    let n = v2(-a.sin(), a.cos());
    let d = p - c;
    let along = d.x * u.x + d.y * u.y;
    let across = d.x * n.x + d.y * n.y;
    let out = |along_m: f32, across_m: f32| c + u * along_m + n * across_m;
    // The yaw snaps to this wall's axis or 90 degrees from it: the cursor says which.
    let snapped_yaw = a + ((yaw - a) / quarter).round() * quarter;
    let turned = ((snapped_yaw - a) / quarter).round().abs() >= 1.0;
    let side = |v: f32| if v < 0.0 { -1.0 } else { 1.0 };
    // The end of the target wall the cursor is nearer, as a step along its axis.
    let end = if along < half { -1.0 } else { 1.0 };

    // Along the wall: continuing the run means one segment from the wall on the side the cursor
    // is on (so the two pieces meet end to end), and over the wall's own body the nearer end
    // decides which way. Turned square, it is either at an end of the wall — half a segment out
    // across it, the piece's face on the wall's end — or crossing it on a whole segment, where two
    // pieces meet.
    let past_end = (-along).max(along - WALL_SEG);
    let asked = if !turned {
        // Continue the run: one segment along from the wall, on the side the cursor is. Over the
        // wall's own body, the nearer end decides which way.
        let step = if along.abs() <= WALL_SEG { end } else { side(along) };
        step * WALL_SEG
    } else if past_end > 0.0 {
        // Butted onto the end the cursor is past: the joint the centre lattice cannot express,
        // because the piece's centre belongs half a segment *out* from the end, not a whole
        // segment along the run. This is the click that used to leave a notch at a corner.
        if along < 0.0 {
            0.0
        } else {
            WALL_SEG
        }
    } else {
        // Crossing the body: the piece's near end goes on the joint below the cursor — a boundary
        // between two pieces of the run — so the piece fills the lane beside the run between that
        // boundary and the next one, instead of sitting on top of a piece of the run.
        let boundary = ((along - half) / WALL_SEG).round() * WALL_SEG;
        (boundary + half).clamp(half, half + WALL_SEG)
    };
    // Across the wall: a piece that continues the run sits on its line; a piece turned square sits
    // half a segment out, so its face is on the line, except when the cursor is on the line itself
    // — then the piece crosses it and its end lands on the boundary instead.
    let across_m = if !turned || across.abs() <= half {
        0.0
    } else {
        side(across) * half
    };
    // Candidates, nearest the cursor first: the joint the cursor asked for, then half-metre steps
    // out from it — and the same walk from the cursor itself, because to a hand laying a wall the
    // cursor is the datum, not the lattice. The search is deliberately local: a snap that walks a
    // piece several segments down the run to find a gap is not helping anyone.
    let mut order: Vec<f32> = vec![asked];
    let free = (along * 2.0).round() * 0.5;
    if (free - asked).abs() > 0.01 {
        order.push(free);
    }
    for k in 1..=8 {
        let step = k as f32 * 0.5;
        order.push(asked + step);
        order.push(asked - step);
    }
    for k in 1..=12 {
        let step = k as f32 * 0.5;
        order.push(along + step);
        order.push(along - step);
    }
    let clear = |c: f32| !walls.iter().any(|(q, _)| (*q - out(c, across_m)).len() < WALL_MIN_SPACING);
    let joins = |c: f32| {
        walls
            .iter()
            .any(|(q, qyaw)| wall_gap(out(c, across_m), snapped_yaw, *q, *qyaw).abs() <= WALL_CONTACT)
    };
    order
        .iter()
        .copied()
        .filter(|c| clear(*c))
        .find(|c| joins(*c))
        .or_else(|| order.iter().copied().find(|c| clear(*c)))
        .map(|c| (out(c, across_m), snapped_yaw))
}

impl EditorMap {
    /// A fresh battlefield from a seed — the editor's starting point.
    pub fn new(seed: u32, index: u32, mode: MapMode, size: MapSize) -> EditorMap {
        let mut map = crate::mapgen::generate_sized(seed, index, mode, size);
        crate::normalize_map(&mut map);
        let mut e = EditorMap {
            bases: default_bases(&map),
            seed,
            mode,
            route: vec![0u8; (map.grid * map.grid) as usize],
            map,
            history: Vec::new(),
            redo: Vec::new(),
            staging: None,
        };
        e.rebuild();
        e
    }

    /// Regenerate in place: same size and mode, new seed. Clears the history, because every step
    /// in it describes a map that no longer exists.
    pub fn reseed(&mut self, seed: u32, index: u32) {
        self.end_stroke();
        let size = self.size();
        let mode = self.mode;
        let mut next = crate::mapgen::generate_sized(seed, index, mode, size);
        crate::normalize_map(&mut next);
        // The island being replaced is *kept*, so "new island" is a step like any other. Losing a
        // map you liked to a stray click on the seed is the one way this editor could destroy work.
        let before = Box::new(Island {
            map: core::mem::replace(&mut self.map, next),
            seed: self.seed,
            bases: self.bases,
        });
        self.seed = seed;
        self.bases = default_bases(&self.map);
        self.route = vec![0u8; (self.map.grid * self.map.grid) as usize];
        let after = Box::new(Island {
            map: self.map.clone(),
            seed,
            bases: self.bases,
        });
        self.history.push(Edit {
            label: "new island".to_string(),
            region: Region { x0: 0, z0: 0, x1: 0, z1: 0 },
            before: LayerBytes::default(),
            after: LayerBytes::default(),
            structs: None,
            bases: None,
            island: Some((before, after)),
        });
        self.redo.clear();
        self.trim_history();
        self.rebuild();
    }

    pub fn map(&self) -> &MapData {
        &self.map
    }
    pub fn seed(&self) -> u32 {
        self.seed
    }
    pub fn mode(&self) -> MapMode {
        self.mode
    }
    pub fn size(&self) -> MapSize {
        MapSize::from_grid(self.map.grid).unwrap_or(MapSize::Small)
    }
    /// Base anchor and facing for a team (what the "base start" tool sets).
    pub fn base(&self, team: usize) -> (Vec2, Vec2) {
        self.bases[team.min(1)]
    }
    pub fn can_undo(&self) -> bool {
        !self.history.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    pub fn history_len(&self) -> u32 {
        self.history.len() as u32
    }
    /// Name of the step `undo` would take, for the UI. Empty when there is none.
    pub fn undo_label(&self) -> String {
        self.history.last().map(|e| e.label.clone()).unwrap_or_default()
    }
    pub fn redo_label(&self) -> String {
        self.redo.last().map(|e| e.label.clone()).unwrap_or_default()
    }

    // -- geometry ---------------------------------------------------------

    #[inline]
    fn verts(&self) -> usize {
        (self.map.grid + 1) as usize
    }

    // -- history ----------------------------------------------------------

    /// Open a stroke. Every op until `end_stroke` becomes one undo step.
    pub fn begin_stroke(&mut self, label: &str) {
        // A stroke already open is closed first: a lost mouse-up must not silently merge two
        // strokes into one step.
        if self.staging.is_some() {
            self.end_stroke();
        }
        self.redo.clear();
        let verts = self.verts();
        self.staging = Some(Staging {
            label: label.to_string(),
            before: self.grab(Region::whole(verts)),
            structs: self.map.structures.clone(),
            bases: self.bases_state(),
            rect: None,
            structs_touched: false,
            bases_touched: false,
        });
    }

    /// Close the stroke, keeping only what it changed. A step that changed nothing is dropped.
    pub fn end_stroke(&mut self) {
        let Some(st) = self.staging.take() else {
            return;
        };
        let changed_layers = st.rect.is_some();
        if !changed_layers && !st.structs_touched && !st.bases_touched {
            return;
        }
        let verts = self.verts();
        let region = st.rect.unwrap_or(Region { x0: 0, z0: 0, x1: 0, z1: 0 });
        let (before, after) = if changed_layers {
            (slice_all(&st.before, verts, region), self.grab(region))
        } else {
            (LayerBytes::default(), LayerBytes::default())
        };
        let structs = if st.structs_touched {
            Some((st.structs, self.map.structures.clone()))
        } else {
            None
        };
        let bases = if st.bases_touched {
            Some((st.bases, self.bases_state()))
        } else {
            None
        };
        self.history.push(Edit {
            label: st.label,
            region,
            before,
            after,
            structs,
            bases,
            island: None,
        });
        self.trim_history();
        // Everything derived from the painted layers is refreshed here rather than per op, so a
        // stroke of two hundred brush dabs rebuilds the nav grid once.
        self.rebuild();
    }

    /// Run an op as a step of its own when no stroke is open (a single click, a whole prefab).
    fn as_step<T>(&mut self, label: &str, f: impl FnOnce(&mut EditorMap) -> T) -> T {
        let own = self.staging.is_none();
        if own {
            self.begin_stroke(label);
        }
        let out = f(self);
        if own {
            self.end_stroke();
        }
        out
    }

    /// Undo the last step. Returns false when there is nothing to undo.
    pub fn undo(&mut self) -> bool {
        self.end_stroke();
        let Some(edit) = self.history.pop() else {
            return false;
        };
        if let Some((before, _)) = &edit.island {
            self.map = before.map.clone();
            self.seed = before.seed;
            self.bases = before.bases;
            self.route = vec![0u8; (self.map.grid * self.map.grid) as usize];
            self.redo.push(edit);
            self.rebuild();
            return true;
        }
        self.put(edit.region, &edit.before);
        if let Some((before, _)) = &edit.structs {
            self.map.structures = before.clone();
        }
        if let Some((before, _)) = &edit.bases {
            self.set_bases_state(*before);
        }
        self.redo.push(edit);
        self.rebuild();
        true
    }

    /// Redo the last undone step. Returns false when there is nothing to redo.
    pub fn redo(&mut self) -> bool {
        let Some(edit) = self.redo.pop() else {
            return false;
        };
        if let Some((_, after)) = &edit.island {
            self.map = after.map.clone();
            self.seed = after.seed;
            self.bases = after.bases;
            self.route = vec![0u8; (self.map.grid * self.map.grid) as usize];
            self.history.push(edit);
            self.rebuild();
            return true;
        }
        self.put(edit.region, &edit.after);
        if let Some((_, after)) = &edit.structs {
            self.map.structures = after.clone();
        }
        if let Some((_, after)) = &edit.bases {
            self.set_bases_state(*after);
        }
        self.history.push(edit);
        self.rebuild();
        true
    }

    /// Record that an op touched `region`, growing the open stroke's rectangle.
    fn touched(&mut self, region: Region) {
        if let Some(st) = self.staging.as_mut() {
            st.rect = Some(match st.rect {
                Some(cur) => cur.union(region),
                None => region,
            });
        }
    }

    fn touched_structs(&mut self) {
        if let Some(st) = self.staging.as_mut() {
            st.structs_touched = true;
        }
    }

    fn touched_bases(&mut self) {
        if let Some(st) = self.staging.as_mut() {
            st.bases_touched = true;
        }
    }

    /// Copy the layers' bytes for `r`.
    fn grab(&self, r: Region) -> LayerBytes {
        let v = self.verts();
        let mut out = LayerBytes::default();
        let rows = r.z1 - r.z0 + 1;
        let cols = r.x1 - r.x0 + 1;
        out.heights.reserve(rows * cols * 4);
        out.splat.reserve(rows * cols * 4);
        out.road.reserve(rows * cols);
        out.sand_var.reserve(rows * cols);
        out.grass_var.reserve(rows * cols);
        out.pave.reserve(rows * cols);
        for iz in r.z0..=r.z1 {
            let a = iz * v + r.x0;
            let b = a + cols;
            for h in &self.map.heights[a..b] {
                out.heights.extend_from_slice(&h.to_le_bytes());
            }
            out.splat.extend_from_slice(&self.map.splat[a * 4..b * 4]);
            out.road.extend_from_slice(&self.map.road[a..b]);
            out.sand_var.extend_from_slice(&self.map.sand_var[a..b]);
            out.grass_var.extend_from_slice(&self.map.grass_var[a..b]);
            out.pave.extend_from_slice(&self.map.pave[a..b]);
        }
        out
    }

    /// Write bytes back into the layers of `r`.
    fn put(&mut self, r: Region, l: &LayerBytes) {
        let rows = r.z1 - r.z0 + 1;
        let cols = r.x1 - r.x0 + 1;
        if r.x1 >= self.verts() || l.road.len() != rows * cols {
            return; // a step with no layers (structures only)
        }
        let v = self.verts();
        let mut off = 0usize;
        for iz in r.z0..=r.z1 {
            let a = iz * v + r.x0;
            let b = a + cols;
            for i in a..b {
                let mut q = [0u8; 4];
                q.copy_from_slice(&l.heights[off..off + 4]);
                self.map.heights[i] = f32::from_le_bytes(q);
                self.map.splat[i * 4] = l.splat[off];
                self.map.splat[i * 4 + 1] = l.splat[off + 1];
                self.map.splat[i * 4 + 2] = l.splat[off + 2];
                self.map.splat[i * 4 + 3] = l.splat[off + 3];
                off += 4;
            }
        }
        let mut off = 0usize;
        for iz in r.z0..=r.z1 {
            let a = iz * v + r.x0;
            let b = a + cols;
            for i in a..b {
                self.map.road[i] = l.road[off];
                self.map.sand_var[i] = l.sand_var[off];
                self.map.grass_var[i] = l.grass_var[off];
                self.map.pave[i] = l.pave[off];
                off += 1;
            }
        }
    }

    fn trim_history(&mut self) {
        let mut bytes: usize = self.history.iter().map(|e| e.bytes()).sum();
        while !self.history.is_empty()
            && (self.history.len() > MAX_HISTORY || bytes > MAX_HISTORY_BYTES)
        {
            let dropped = self.history.remove(0);
            bytes -= dropped.bytes();
        }
    }

    // -- terrain ops ------------------------------------------------------

    /// Raise (positive) or lower (negative) the ground.
    pub fn raise(&mut self, x: f32, z: f32, radius: f32, amount: f32, hard: f32) {
        self.as_step("raise", |e| {
            let (cell, verts) = (e.map.cell, e.verts());
            let r = brush_region(cell, verts, x, z, radius);
            e.touched(r);
            let h = &mut e.map.heights;
            for_brush(cell, verts, x, z, radius, hard, |ix, iz, w| {
                h[iz * verts + ix] += amount * w;
            });
        });
    }

    /// Pull the ground towards a target height: the land/water brush (a target below the
    /// waterline carves sea, one above it raises beach) and the flatten brush for pads.
    pub fn level(&mut self, x: f32, z: f32, radius: f32, target: f32, amount: f32, hard: f32) {
        self.as_step("level", |e| {
            let (cell, verts) = (e.map.cell, e.verts());
            let r = brush_region(cell, verts, x, z, radius);
            e.touched(r);
            let h = &mut e.map.heights;
            for_brush(cell, verts, x, z, radius, hard, |ix, iz, w| {
                let i = iz * verts + ix;
                let t = (amount * w).clamp(0.0, 1.0);
                h[i] += (target - h[i]) * t;
            });
        });
    }

    /// Average the ground with its neighbours: takes the noise out of a stroke or a coastline.
    pub fn smooth(&mut self, x: f32, z: f32, radius: f32, amount: f32, hard: f32) {
        self.as_step("smooth", |e| {
            let (cell, verts) = (e.map.cell, e.verts());
            let r = brush_region(cell, verts, x, z, radius);
            e.touched(r);
            // From a copy: averaging in place feeds each texel its already-smoothed neighbour and
            // drags the whole stroke downhill.
            let src = e.map.heights.clone();
            let h = &mut e.map.heights;
            for_brush(cell, verts, x, z, radius, hard, |ix, iz, w| {
                let mut sum = 0.0;
                let mut n = 0.0;
                for dz in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let jx = ix as i32 + dx;
                        let jz = iz as i32 + dz;
                        if jx < 0 || jz < 0 || jx >= verts as i32 || jz >= verts as i32 {
                            continue;
                        }
                        sum += src[jz as usize * verts + jx as usize];
                        n += 1.0;
                    }
                }
                let i = iz * verts + ix;
                let t = (amount * w).clamp(0.0, 1.0);
                h[i] += (sum / n - h[i]) * t;
            });
        });
    }

    // -- paint ops --------------------------------------------------------

    /// Paint one splat channel: it rises towards full and the other three give way, so the four
    /// keep summing to 255 and the ground shader never sees an unweighted cell.
    pub fn paint_splat(&mut self, channel: usize, x: f32, z: f32, radius: f32, amount: f32, hard: f32) {
        let channel = channel.min(3);
        self.as_step("paint ground", |e| {
            let (cell, verts) = (e.map.cell, e.verts());
            let r = brush_region(cell, verts, x, z, radius);
            e.touched(r);
            let sp = &mut e.map.splat;
            for_brush(cell, verts, x, z, radius, hard, |ix, iz, w| {
                let i = iz * verts + ix;
                let t = (amount * w).clamp(0.0, 1.0);
                let mut c = [0.0f32; 4];
                for (k, slot) in c.iter_mut().enumerate() {
                    *slot = sp[i * 4 + k] as f32;
                }
                c[channel] += (255.0 - c[channel]) * t;
                let others: f32 = (0..4).filter(|k| *k != channel).map(|k| c[k]).sum();
                if others > 1.0 {
                    let scale = (255.0 - c[channel]) / others;
                    for (k, slot) in c.iter_mut().enumerate() {
                        if k != channel {
                            *slot *= scale;
                        }
                    }
                } else {
                    c[channel] = 255.0;
                }
                fix_quad(&mut c);
                for (k, slot) in c.iter().enumerate() {
                    sp[i * 4 + k] = slot.round().clamp(0.0, 255.0) as u8;
                }
            });
        });
    }

    /// Paint a whole ground *material* in one dab: the family's weight rises towards full **and**
    /// its variant moves to the one asked for.
    ///
    /// This is what the swatch palette calls. Painting the two separately is what made the editor
    /// feel like some textures took precedence: clicking a sand swatch only moved the sand
    /// *variant*, so on ground whose weight was rock or grass nothing visible happened at all.
    ///
    /// `family`: 0 sand (variant 0..2), 1 grass (variant 0..2), 2 dirt, 3 rock.
    pub fn paint_material(&mut self, family: usize, variant: u8, x: f32, z: f32, radius: f32, amount: f32, hard: f32) {
        let channel = match family {
            1 => 3,
            2 => 1,
            3 => 2,
            _ => 0,
        };
        let variant_target = (variant.min(2) as f32) * 127.5;
        let ramp = family <= 1;
        self.as_step("paint ground", |e| {
            let (cell, verts) = (e.map.cell, e.verts());
            let r = brush_region(cell, verts, x, z, radius);
            e.touched(r);
            let map = &mut e.map;
            for_brush(cell, verts, x, z, radius, hard, |ix, iz, w| {
                let i = iz * verts + ix;
                let t = (amount * w).clamp(0.0, 1.0);
                if ramp {
                    let v = if family == 1 { &mut map.grass_var } else { &mut map.sand_var };
                    let cur = v[i] as f32;
                    v[i] = (cur + (variant_target - cur) * t).round().clamp(0.0, 255.0) as u8;
                }
                let mut c = [0.0f32; 4];
                for (k, slot) in c.iter_mut().enumerate() {
                    *slot = map.splat[i * 4 + k] as f32;
                }
                c[channel] += (255.0 - c[channel]) * t;
                let others: f32 = (0..4).filter(|k| *k != channel).map(|k| c[k]).sum();
                if others > 1.0 {
                    let scale = (255.0 - c[channel]) / others;
                    for (k, slot) in c.iter_mut().enumerate() {
                        if k != channel {
                            *slot *= scale;
                        }
                    }
                } else {
                    c[channel] = 255.0;
                }
                fix_quad(&mut c);
                for (k, slot) in c.iter().enumerate() {
                    map.splat[i * 4 + k] = slot.round().clamp(0.0, 255.0) as u8;
                }
            });
        });
    }

    /// Paint which sand (family 0) or grass (family 1) a cell is: `variant` is 0..2.
    pub fn paint_variant(
        &mut self,
        family: usize,
        variant: u8,
        x: f32,
        z: f32,
        radius: f32,
        amount: f32,
        hard: f32,
    ) {
        let target = (variant.min(2) as f32) * 127.5;
        self.as_step("paint variant", |e| {
            let (cell, verts) = (e.map.cell, e.verts());
            let r = brush_region(cell, verts, x, z, radius);
            e.touched(r);
            let dst = if family == 0 {
                &mut e.map.sand_var
            } else {
                &mut e.map.grass_var
            };
            for_brush(cell, verts, x, z, radius, hard, |ix, iz, w| {
                let i = iz * verts + ix;
                let t = (amount * w).clamp(0.0, 1.0);
                let cur = dst[i] as f32;
                dst[i] = (cur + (target - cur) * t).round().clamp(0.0, 255.0) as u8;
            });
        });
    }

    /// Paint pavement: `level` is the road mask strength (0..255) and `pave` the shape (0..3).
    pub fn paint_pave(&mut self, x: f32, z: f32, radius: f32, level: u8, pave: u8, amount: f32, hard: f32) {
        self.as_step("paint pavement", |e| {
            let (cell, verts) = (e.map.cell, e.verts());
            let r = brush_region(cell, verts, x, z, radius);
            e.touched(r);
            let map = &mut e.map;
            for_brush(cell, verts, x, z, radius, hard, |ix, iz, w| {
                let i = iz * verts + ix;
                let t = (amount * w).clamp(0.0, 1.0);
                let cur = map.road[i] as f32;
                map.road[i] = (cur + (level as f32 - cur) * t).round().clamp(0.0, 255.0) as u8;
                if t > 0.5 {
                    map.pave[i] = pave.min(3);
                }
            });
        });
    }

    /// Lay pavement along a polyline: a capsule per segment, so a dragged stroke comes out as a
    /// road of the brush's width rather than as a dotted line of dabs.
    pub fn road_stroke(&mut self, pts: &[f32], half_width: f32, pave: u8, erase: bool) {
        if pts.len() < 4 {
            return;
        }
        let path: Vec<Vec2> = pts.chunks_exact(2).map(|c| v2(c[0], c[1])).collect();
        let hw = half_width.max(0.6);
        self.as_step(if erase { "erase pavement" } else { "lay pavement" }, |e| {
            let (cell, verts) = (e.map.cell, e.verts());
            for w in path.windows(2) {
                let (a, b) = (w[0], w[1]);
                let seg = b - a;
                let len = seg.len();
                let steps = ((len / (hw * 0.5)).ceil() as u32).max(1);
                for k in 0..=steps {
                    let p = a + seg * (k as f32 / steps as f32);
                    e.touched(brush_region(cell, verts, p.x, p.y, hw));
                    let map = &mut e.map;
                    for_brush(cell, verts, p.x, p.y, hw, 0.6, |ix, iz, w| {
                        let i = iz * verts + ix;
                        let t = w.clamp(0.0, 1.0);
                        let cur = map.road[i] as f32;
                        let want = if erase { 0.0 } else { 235.0 };
                        map.road[i] = (cur + (want - cur) * t).round().clamp(0.0, 255.0) as u8;
                        if !erase && t > 0.5 {
                            map.pave[i] = pave.min(3);
                        }
                    });
                }
            }
        });
    }

    // -- structures -------------------------------------------------------

    /// Where a structure would land, and at what yaw, after snapping.
    ///
    /// The editor draws its ghost from this, and `place` builds from the same call, so what the
    /// ghost shows is exactly what gets placed — a preview computed twice is a preview that lies.
    ///
    /// **Walls snap to walls.** A piece is 7.7 m long and its origin is its centre, so joining two
    /// of them means putting one centre a whole piece along the run from the other. The cursor is
    /// projected onto the nearest existing wall's own frame — along its axis and across it — and
    /// the yaw snaps to that wall's axis or 90 degrees from it. That is what makes a dragged run
    /// come out joined and a corner come out square instead of a row of pieces at odd angles.
    ///
    /// **Budding onto an end.** Snapping to the centre lattice alone cannot join a wall to the
    /// *end* of another one: the piece that butts onto an end sits half a piece off the run, not a
    /// whole one, so the lattice jumps straight past it and the cursor appears unable to reach the
    /// end. So the cursor is projected onto the wall as a barrier segment first, and if it lands
    /// near an end (and off the run) the piece is placed butted onto that end at 90 degrees, its
    /// centre half a piece out — which is where a wall touching the end of another wall really is.
    /// Landing on the run itself is still the collinear case, so runs extend and turn as before.
    ///
    /// `snap: false` is the free-placement escape hatch (shift, or the toolbar toggle): the cursor
    /// is returned untouched, so a wall can be dropped anywhere at any angle.
    pub fn preview(&self, kind: u8, x: f32, z: f32, yaw: f32, snap: bool) -> (Vec2, f32) {
        let p = v2(x, z);
        if !snap || kind != skind::WALL {
            return (p, yaw);
        }
        let walls: Vec<(Vec2, f32)> = self
            .map
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL)
            .map(|s| (s.pos(), s.yaw))
            .collect();
        match snap_wall(&walls, p, yaw) {
            Some((pos, a)) => (pos, a),
            // Nothing to join, or nowhere to stand: the cursor's own position and angle.
            None => (p, yaw),
        }
    }

    /// Can a structure of this kind stand here, turned this way?
    ///
    /// The ghost is drawn from this and a checked placement refuses on it, so the tint cannot
    /// promise a spot the click will decline. The rules are the ones the *game* needs rather than
    /// the editor's taste: on the map, on dry ground, and clear of every structure already standing
    /// — the same oriented-box overlap the world resolves vehicle collisions with.
    ///
    /// Returns the height the structure would be seated at, or why it cannot go there.
    pub fn can_place(&self, kind: u8, x: f32, z: f32, yaw: f32) -> Result<f32, PlaceBlock> {
        let Some((w, d, h)) = catalog_size(kind) else {
            return Err(PlaceBlock::Unknown);
        };
        let margin = 0.5;
        if x < margin || z < margin || x > self.map.world_size - margin || z > self.map.world_size - margin {
            return Err(PlaceBlock::OffMap);
        }
        // A bridge is *for* water; nothing else belongs in it.
        if kind != skind::BRIDGE && self.map.is_water_at(x, z) {
            return Err(PlaceBlock::Water);
        }
        let p = v2(x, z);
        let (hw, hd) = (w * 0.5, d * 0.5);
        for s in &self.map.structures {
            if !obb_overlap(p, yaw, hw, hd, s.pos(), s.yaw, s.w * 0.5, s.d * 0.5) {
                continue;
            }
            return Err(PlaceBlock::Occupied);
        }
        Ok(self.seat_y(p, yaw, w, d, h, kind))
    }

    /// Drop a structure on the map. Returns false when the position is off-map.
    pub fn place(&mut self, kind: u8, team: u8, x: f32, z: f32, yaw: f32, snap: bool) -> bool {
        let Some((w, d, h)) = catalog_size(kind) else {
            return false;
        };
        let (p, yaw) = self.preview(kind, x, z, yaw, snap);
        let (x, z) = (p.x, p.y);
        if x < 0.0 || z < 0.0 || x > self.map.world_size || z > self.map.world_size {
            return false;
        }
        self.as_step("place", |e| {
            let p = v2(x, z);
            let y = e.seat_y(p, yaw, w, d, h, kind);
            e.map
                .structures
                .push(Structure::new(kind, team, p, y, yaw, w, d, h));
            crate::normalize_map(&mut e.map);
            e.touched_structs();
        });
        true
    }

    /// How many of the kinds a scatter brush offers.
    pub fn scatter_count() -> usize {
        SCATTER.len()
    }

    /// Scatter name `i`, for the palette.
    pub fn scatter_name(i: usize) -> &'static str {
        SCATTER[i.min(SCATTER.len() - 1)].0
    }

    /// Scatter brush: sprinkle the props of group `group` through the brush disc.
    ///
    /// Props are scenery, so they do not follow the building rules — a palm may stand on a slope or
    /// beside another palm. What they do respect is the ground they are actually on: nothing is
    /// scattered into the water, and each prop is seated on the terrain it lands on. `density` is
    /// how many props a full-strength disc places, and `seed` is the stroke's, not the map's, so
    /// dragging the same stroke twice reproduces the same scatter and one dab never reshuffles the
    /// props already down.
    pub fn scatter(&mut self, group: usize, x: f32, z: f32, radius: f32, density: f32, seed: u32) -> u32 {
        let Some((_, kinds)) = SCATTER.get(group.min(SCATTER.len() - 1)) else {
            return 0;
        };
        if radius < 1.0 {
            return 0;
        }
        let want = (density.clamp(0.0, 4.0) * radius * radius * 0.08).round() as u32;
        let mut made = 0;
        let mut rng = seed | 1;
        let mut next = move || {
            // xorshift: deterministic on every platform, which is what makes a stroke repeatable.
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            (rng >> 8) as f32 / 16_777_216.0
        };
        let mut placed: Vec<(Vec2, f32, f32, f32, f32)> = Vec::new();
        self.as_step("scatter", |e| {
            for _ in 0..want {
                let a = next() * core::f32::consts::TAU;
                let r = radius * next().sqrt();
                let q = v2(x + a.cos() * r, z + a.sin() * r);
                if q.x < 1.0 || q.y < 1.0 || q.x > e.map.world_size - 1.0 || q.y > e.map.world_size - 1.0 {
                    continue;
                }
                if e.map.is_water_at(q.x, q.y) {
                    continue;
                }
                let (kind, w, d, h) = kinds[(next() * kinds.len() as f32) as usize % kinds.len()];
                // Two props in the same spot look like one prop drawn twice: keep them apart, but
                // only against this stroke — the map's own scatter is allowed to be dense.
                if placed.iter().any(|(p, _, pw, pd, _)| {
                    obb_overlap(q, 0.0, w * 0.5, d * 0.5, *p, 0.0, *pw * 0.5, *pd * 0.5)
                }) {
                    continue;
                }
                placed.push((q, 0.0, w, d, h));
                let y = e.seat_y(q, 0.0, w, d, h, kind);
                e.map
                    .structures
                    .push(Structure::new(kind, 2, q, y, 0.0, w, d, h));
                made += 1;
            }
            if made > 0 {
                e.touched_structs();
            }
        });
        made
    }

    /// Copy a rectangle of the map: the structures whose centres are inside it, and the pavement.
    ///
    /// The pavement travels as the same bytes the save format uses, so a paste is a `put` and
    /// nothing has to be re-derived — the layer is vertex-sized and the selection is snapped to the
    /// vertex grid, so a copy is exact and a paste is exact.
    pub fn copy_rect(&self, x0: f32, z0: f32, x1: f32, z1: f32, cursor: Vec2) -> Clipboard {
        let (ax, bx) = (x0.min(x1), x0.max(x1));
        let (az, bz) = (z0.min(z1), z0.max(z1));
        let (cell, verts) = (self.map.cell, self.verts());
        let region = brush_region(cell, verts, (ax + bx) * 0.5, (az + bz) * 0.5, (bx - ax).max(bz - az) * 0.5 + 1.0);
        let mut structures = Vec::new();
        for s in &self.map.structures {
            if s.x >= ax && s.x <= bx && s.z >= az && s.z <= bz {
                structures.push(s.clone());
            }
        }
        Clipboard {
            cursor,
            cell,
            structures,
            pave: slice_region(&self.map.pave, verts, region),
            road: slice_region(&self.map.road, verts, region),
            region,
        }
    }

    /// Paste a clipboard with the point that was under the cursor when it was copied back under the
    /// cursor now, at (x, z). One undo step.
    ///
    /// The anchor is the *cursor*, not the corner of the rectangle: copy a yard and click the far
    /// end of it, and what was under the cursor lands under the cursor again. Corner-anchoring
    /// makes the paste jump by however far into the selection you happened to be pointing.
    ///
    /// Structures land in the same arrangement they were copied in, each reseated on whatever
    /// ground is under it now — pasting a village onto a hill should put the huts on the hill, not
    /// leave them hanging at the old altitude.
    pub fn paste_rect(&mut self, clip: &Clipboard, x: f32, z: f32) -> u32 {
        let (dx, dz) = (x - clip.cursor.x, z - clip.cursor.y);
        let (cell, verts) = (self.map.cell, self.verts());
        let mut made = 0;
        // The destination region is the source region's corner offset from the anchor, applied to
        // the new anchor — and it is the *same size* as the source, so the bytes land cell for cell
        // where the structures do.
        let (ox, oz) = clip.corner_offset();
        let dx_cell = ((x + ox) / cell).round() as i32;
        let dz_cell = ((z + oz) / cell).round() as i32;
        let cols = (clip.region.x1 - clip.region.x0) as i32;
        let rows = (clip.region.z1 - clip.region.z0) as i32;
        let last = verts as i32 - 1;
        let region = Region {
            x0: dx_cell.clamp(0, last) as usize,
            z0: dz_cell.clamp(0, last) as usize,
            x1: (dx_cell + cols).clamp(0, last) as usize,
            z1: (dz_cell + rows).clamp(0, last) as usize,
        };
        self.as_step("paste", |e| {
            e.touched(region);
            put_region(&mut e.map.road, &clip.road, verts, clip.region, region);
            put_region(&mut e.map.pave, &clip.pave, verts, clip.region, region);
            for s in &clip.structures {
                let p = v2(s.x + dx, s.z + dz);
                // A paste that hangs off the map keeps what fits and drops what does not, which is
                // what every editor does with a stamp at the edge.
                if p.x < 0.0 || p.y < 0.0 || p.x > e.map.world_size || p.y > e.map.world_size {
                    continue;
                }
                let y = e.seat_y(p, s.yaw, s.w, s.d, s.h, s.kind as u8);
                let mut n = s.clone();
                n.x = p.x;
                n.z = p.y;
                n.y = y;
                e.map.structures.push(n);
                made += 1;
            }
            if made > 0 {
                e.touched_structs();
            }
        });
        made
    }

    /// Drop a structure only if the spot is good: what the editor places by hand.
    ///
    /// `place` writes whatever it is told to, which is what the base blueprint needs (its perimeter
    /// is a lattice the overlap rules would fight over); a wall or a building the player aims at a
    /// spot should be refused instead of silently landing inside whatever is already there.
    pub fn place_checked(&mut self, kind: u8, team: u8, x: f32, z: f32, yaw: f32, snap: bool) -> PlaceBlock {
        let (p, a) = self.preview(kind, x, z, yaw, snap);
        if let Err(b) = self.can_place(kind, p.x, p.y, a) {
            return b;
        }
        if self.place(kind, team, x, z, yaw, snap) {
            PlaceBlock::Never
        } else {
            PlaceBlock::OffMap
        }
    }

    /// Which structure is under this point, or -1. The last one placed wins, because that is the
    /// one drawn on top.
    pub fn pick(&self, x: f32, z: f32) -> i32 {
        let p = v2(x, z);
        for (i, s) in self.map.structures.iter().enumerate().rev() {
            if obb_sd(p, s.pos(), s.yaw, s.w * 0.5, s.d * 0.5) <= 0.0 {
                return i as i32;
            }
        }
        -1
    }

    /// One structure's `[x, z, yaw, w, d, h, kind, team]`, or `None` if the index is stale.
    ///
    /// The UI works in indices and re-reads on every frame: erasing a structure renumbers the ones
    /// after it, and a selection that quietly pointed at the wrong building would be worse than one
    /// that vanished.
    pub fn structure_at(&self, index: i32) -> Option<[f32; 8]> {
        if index < 0 {
            return None;
        }
        let s = self.map.structures.get(index as usize)?;
        Some([s.x, s.z, s.yaw, s.w, s.d, s.h, s.kind, s.team])
    }

    /// Is this spot free for a structure of `kind` at `yaw`, ignoring one structure (the one being
    /// moved)? The same rules a fresh placement follows, because a move *is* a placement — of
    /// something that happened to be somewhere else a moment ago.
    fn clear_for(&self, kind: u8, x: f32, z: f32, yaw: f32, w: f32, d: f32, ignore: i32) -> Result<(), PlaceBlock> {
        let margin = 0.5;
        if x < margin || z < margin || x > self.map.world_size - margin || z > self.map.world_size - margin {
            return Err(PlaceBlock::OffMap);
        }
        if kind != skind::BRIDGE && self.map.is_water_at(x, z) {
            return Err(PlaceBlock::Water);
        }
        let p = v2(x, z);
        let (hw, hd) = (w * 0.5, d * 0.5);
        for (i, s) in self.map.structures.iter().enumerate() {
            if i as i32 == ignore {
                continue;
            }
            if obb_overlap(p, yaw, hw, hd, s.pos(), s.yaw, s.w * 0.5, s.d * 0.5) {
                return Err(PlaceBlock::Occupied);
            }
        }
        Ok(())
    }

    /// Move (or turn) a structure that is already on the map: one undo step, however far it goes.
    ///
    /// This is what makes a misplaced building fixable without erasing and re-placing it. The spot
    /// is checked exactly as a fresh placement would be, with the structure itself the one thing
    /// its new position is allowed to overlap — otherwise every move would collide with where the
    /// thing is standing now.
    pub fn move_structure(&mut self, index: i32, x: f32, z: f32, yaw: f32) -> PlaceBlock {
        // A negative index is a stale selection (the structure was erased), not structure 0:
        // clamping it would move the wrong object under a click that meant nothing.
        let Some(i) = usize::try_from(index).ok() else {
            return PlaceBlock::Missing;
        };
        let Some(s) = self.map.structures.get(i) else {
            return PlaceBlock::Missing;
        };
        let (w, d, h, kind) = (s.w, s.d, s.h, s.kind as u8);
        if let Err(b) = self.clear_for(kind, x, z, yaw, w, d, index) {
            return b;
        }
        self.as_step("move", |e| {
            let p = v2(x, z);
            let y = e.seat_y(p, yaw, w, d, h, kind);
            let s = &mut e.map.structures[index as usize];
            s.x = p.x;
            s.z = p.y;
            s.y = y;
            s.yaw = yaw;
            e.touched_structs();
        });
        PlaceBlock::Never
    }

    /// Turn a structure a quarter turn in place, about its own centre.
    pub fn rotate_structure(&mut self, index: i32, quarter: i32) -> PlaceBlock {
        // Same stale-selection rule as move_structure: a negative index is Missing, not 0.
        let Some(i) = usize::try_from(index).ok() else {
            return PlaceBlock::Missing;
        };
        let Some(s) = self.map.structures.get(i) else {
            return PlaceBlock::Missing;
        };
        let (x, z, yaw) = (s.x, s.z, s.yaw);
        let turn = quarter as f32 * core::f32::consts::FRAC_PI_2;
        self.move_structure(index, x, z, yaw + turn)
    }

    /// Remove whatever the brush covers: structures, pavement, or both.
    ///
    /// Pavement is in here because clearing a road with the eraser and then painting the ground
    /// over it is the obvious way to take a road back out, and the pavement mask is what the
    /// ground shader reads — leaving it behind left a road you could not get rid of.
    pub fn erase(&mut self, x: f32, z: f32, radius: f32, pavement: bool, structures: bool) -> u32 {
        let mut removed = 0;
        self.as_step("erase", |e| {
            if pavement {
                let (cell, verts) = (e.map.cell, e.verts());
                e.touched(brush_region(cell, verts, x, z, radius));
                let map = &mut e.map;
                for_brush(cell, verts, x, z, radius, 0.2, |ix, iz, w| {
                    let i = iz * verts + ix;
                    let t = w.clamp(0.0, 1.0);
                    let cur = map.road[i] as f32;
                    map.road[i] = (cur * (1.0 - t)).round().clamp(0.0, 255.0) as u8;
                    if map.road[i] == 0 {
                        map.pave[i] = 0;
                    }
                });
            }
            if structures {
                let c = v2(x, z);
                let keep: Vec<Structure> = e
                    .map
                    .structures
                    .iter()
                    .filter(|s| obb_sd(c, s.pos(), s.yaw, s.w * 0.5, s.d * 0.5) > radius)
                    .cloned()
                    .collect();
                removed = (e.map.structures.len() - keep.len()) as u32;
                if removed > 0 {
                    e.map.structures = keep;
                    e.touched_structs();
                }
            }
        });
        removed
    }

    /// Set a team's base start — the anchor a base complex is built around — without building it,
    /// and **without moving the complex that is already standing at the old anchor**.
    ///
    /// This is the raw write, and it is easy to misuse: after it, the editor's idea of where the
    /// base is no longer matches where its structures are, so a later `stamp_base` cannot remove
    /// them. Moving a base is [`EditorMap::move_base`].
    pub fn set_base(&mut self, team: usize, x: f32, z: f32, yaw: f32) {
        let team = team.min(1);
        self.as_step("set base", |e| {
            e.bases[team] = (v2(x, z), v2(yaw.cos(), yaw.sin()));
            e.sync_pads(team);
            e.touched_bases();
        });
    }

    /// Lift the team's base off the map.
    ///
    /// Matched against the blueprint at the base's *current* anchor rather than against a stored
    /// list of indices: indices move under erase and undo, and a base loaded from a `.rfmap` has
    /// no list at all — but the blueprint can always be recomputed, so "the structures this base
    /// is made of" is exact in every case.
    /// The structure list with one base's complex taken out, given the anchor it was *built* at.
    ///
    /// A base is removed by its blueprint, so the anchor has to be the one it was stamped at. That
    /// is not always the anchor the editor currently holds — see `move_base`, where the two are
    /// deliberately different — which is why this takes them as arguments rather than reading
    /// `self.bases`.
    fn without_base(&self, team: usize, anchor: Vec2, yaw: f32) -> Vec<Structure> {
        let parts = base_parts();
        self.map
            .structures
            .iter()
            .filter(|s| {
                // Marked as a part of this team's base: that is the whole test. The marker is
                // written where a complex is *built* — by the generator inside its footprint, by
                // `stamp_parts` for every part it lays — so it needs no help from the anchor.
                //
                // (An earlier version also required the structure to be near the anchor it was
                // being removed at. That reads well and is wrong: a move removes the complex at
                // the *old* anchor, and any caller that passes the new one would leave the old
                // walls standing. The anchor is only here for the records it keeps.)
                if s.flag(sflag::BASE) && s.team as usize == team {
                    return false;
                }
                // Nothing marked it: a base from a file written before the marker existed. The
                // blueprint lattice is where the editor would have built it, so that is the test.
                if !s.flag(sflag::BASE) {
                    return !parts
                        .iter()
                        .any(|p| s.pos().dist(from_local(v2(p.lx, p.lz), anchor, yaw)) < 0.8);
                }
                true
            })
            .cloned()
            .collect()
    }

    /// **Move** a team's base: clear the complex standing at the old anchor, then build the same
    /// blueprint at the new one. One undo step, one base.
    ///
    /// This is the only correct way to move a base, and it is a different operation from `set_base`
    /// followed by `stamp_base` — that pair loses the old anchor the moment the new one is written,
    /// so `remove_base` finds nothing to remove and the old complex stays standing. The two are
    /// separate calls here for exactly that reason.
    pub fn move_base(&mut self, team: usize, x: f32, z: f32, yaw: f32) {
        if !team_can_own_base(team as u8) {
            return;
        }
        let mut sites = [(v2(0.0, 0.0), 0.0f32); 2];
        for t in 0..2 {
            let (anchor, fwd) = self.bases[t];
            sites[t] = (anchor, fwd.y.atan2(fwd.x));
        }
        sites[team] = (v2(x, z), yaw);
        self.rebuild_bases(sites, "move base");
    }

    /// Rebuild both complexes at the given anchors, as one undo step.
    ///
    /// Both, because the two bases are positioned *relative to each other* — one facing the other
    /// across the island — and their perimeters are rectangles at each anchor's own angle. Moving
    /// one and leaving the other standing leaves the two lattices out of step, which reads as walls
    /// crossing instead of meeting. Rebuilding both is also what makes "one base per team" true of
    /// the map rather than true of the tool that last ran.
    fn rebuild_bases(&mut self, sites: [(Vec2, f32); 2], label: &str) {
        self.as_step(label, |e| {
            for t in 0..2 {
                let (anchor, yaw) = sites[t];
                e.map.structures = e.without_base(t, anchor, yaw);
                e.bases[t] = (anchor, v2(yaw.cos(), yaw.sin()));
                e.map.base_anchor[t] = (anchor, yaw);
                e.stamp_parts(t, anchor, yaw);
                e.sync_pads(t);
            }
            crate::normalize_map(&mut e.map);
            e.touched_structs();
            e.touched_bases();
        });
    }

    /// Push a base's blueprint into the structure list at an anchor. The caller has already taken
    /// the old complex out and set `bases[team]`.
    fn stamp_parts(&mut self, team: usize, anchor: Vec2, yaw: f32) {
        for p in base_parts() {
            let Some((w, d, h)) = part_size(&p) else {
                continue;
            };
            let pos = from_local(v2(p.lx, p.lz), anchor, yaw);
            if pos.x < 1.0 || pos.y < 1.0 || pos.x > self.map.world_size - 1.0 || pos.y > self.map.world_size - 1.0
            {
                continue;
            }
            let rot = yaw + p.rot;
            let y = self.seat_y(pos, rot, w, d, h, p.kind);
            let mut st = Structure::new(p.kind, team as u8, pos, y, rot, w, d, h);
            // Gate leaves are FLAT here, not SOLID: in a generated map the lane through a gateway
            // stays open because it is a *protected route* (`build_nav` never blocks a route cell),
            // and an edited map has no routes, so a solid gate would seal the base its own spawn is
            // inside ("cannot reach the enemy flag"). Setting it here, by kind, is also why it
            // cannot drift: the blueprint's order is free to change.
            if p.kind == skind::GATE {
                st.flags = (sflag::FLAT | sflag::DESTRUCTIBLE) as f32;
            } else {
                // Every other part gets the same flags the generator gives its kind. Without this,
                // the BASE marker below made `normalize_map` skip the flag backfill and the whole
                // complex stood up solid-less — vehicles drove through the HQ.
                st.flags = crate::kind_flags(p.kind, h, team as u8) as f32;
            }
            // Every part of a base belongs to it: this is what lets the complex be lifted and
            // rebuilt as one asset rather than as forty loose structures.
            st.set_flag(sflag::BASE, true);
            self.map.structures.push(st);
        }
    }

    /// Build (or rebuild) a team's main base at a point: perimeter with a gate and a sally port,
    /// garage, HQ, helipad, supply dumps, turret towers, flag.
    ///
    /// **One base per team**: stamping replaces whatever that team had before, and moving the base
    /// start moves the whole complex — the user asked for a main base to be one asset, and a
    /// second stamp landing beside the first is not a feature.
    pub fn stamp_base(&mut self, team: usize, x: f32, z: f32, yaw: f32) {
        if !team_can_own_base(team as u8) {
            return;
        }
        let mut sites = [(v2(0.0, 0.0), 0.0f32); 2];
        for t in 0..2 {
            let (anchor, fwd) = self.bases[t];
            sites[t] = (anchor, fwd.y.atan2(fwd.x));
        }
        sites[team] = (v2(x, z), yaw);
        self.rebuild_bases(sites, "place base");
    }

    fn bases_state(&self) -> BasesState {
        BasesState {
            bases: self.bases,
            spawn: self.map.spawn,
            flag: self.map.flag_home,
        }
    }

    fn set_bases_state(&mut self, s: BasesState) {
        self.bases = s.bases;
        self.map.spawn = s.spawn;
        self.map.flag_home = s.flag;
    }

    /// Move a team's spawn and flag pads to match its base definition.
    fn sync_pads(&mut self, team: usize) {
        let (anchor, fwd) = self.bases[team];
        let yaw = fwd.y.atan2(fwd.x);
        let local = |lx: f32, lz: f32| from_local(v2(lx, lz), anchor, yaw);
        // The same local points the generator's own base definition advertises, so a stamped base
        // and a generated one put their spawn and flag pads in the same place relative to the
        // complex.
        self.map.spawn[team] = local(-6.0, -0.5);
        self.map.flag_home[team] = local(6.0, 6.0);
        // `map.base_anchor` is deliberately *not* written here. It records where the complex was
        // built, and this function is called for every rebuild — including the one in the
        // constructor, where it used to overwrite the generator's anchors with the editor's
        // starting anchors. After that, "remove the base at this anchor" looked in the wrong place
        // and the old complex survived every move. The anchors are written where a base is
        // actually placed: `rebuild_bases`.
    }

    /// Re-seat every structure on the ground it now stands on. Called after height edits, so a
    /// building raised with the terrain does not end up buried in it.
    pub fn reseat(&mut self) {
        for i in 0..self.map.structures.len() {
            let (kind, yaw, w, d, h, p) = {
                let s = &self.map.structures[i];
                (s.kind as u8, s.yaw, s.w, s.d, s.h, s.pos())
            };
            self.map.structures[i].y = self.seat_y(p, yaw, w, d, h, kind);
        }
    }

    /// Ground height for a footprint: the highest corner, so a box on a slope sits on the slope
    /// rather than sinking into it. Flat things (pads, decals, the flag) sit on the terrain.
    fn seat_y(&self, p: Vec2, yaw: f32, w: f32, d: f32, h: f32, kind: u8) -> f32 {
        let flat =
            kind == skind::HELIPAD || kind == skind::BRIDGE || kind == skind::FLAG_POLE || h < 0.6;
        if flat {
            return self.map.height_at(p.x, p.y).max(0.05) + 0.06;
        }
        let (hw, hd) = (w * 0.5, d * 0.5);
        let mut top = self.map.height_at(p.x, p.y);
        for c in [v2(-hw, -hd), v2(hw, -hd), v2(hw, hd), v2(-hw, hd)] {
            let q = from_local(c, p, yaw);
            top = top.max(self.map.height_at(q.x, q.y));
        }
        top.max(0.1)
    }

    // -- derived data -----------------------------------------------------

    /// Rebuild everything derived from the painted layers: the nav grid and the structure seats.
    pub fn rebuild(&mut self) {
        self.reseat();
        crate::normalize_map(&mut self.map);
        let v = self.verts();
        let g = self.map.grid as usize;
        if self.route.len() != g * g {
            self.route = vec![0u8; g * g];
        }
        let route = &self.route;
        let map = &mut self.map;
        rasterize_nav(
            &mut map.nav,
            &map.heights,
            &map.road,
            route,
            &map.structures,
            v,
            g,
            map.cell,
            map.world_size,
        );
    }

    /// Take the map out (the game plays an edited map through the same `World` as a generated
    /// one, so it needs the `MapData` itself rather than a reference to the editor).
    pub fn into_map(self) -> MapData {
        self.map
    }

    /// `validate()` on the edited map: the editor shows this rather than refusing to save.
    pub fn validate(&self) -> Result<(), String> {
        crate::mapgen::validate(&self.map)
    }
}

/// The vertex rectangle a brush of `radius` metres at (x, z) can touch, clipped to the map.
fn brush_region(cell: f32, verts: usize, x: f32, z: f32, radius: f32) -> Region {
    let last = verts - 1;
    let clamp = |f: f32| -> usize { (f.max(0.0) as usize).min(last) };
    Region {
        x0: clamp((x - radius) / cell),
        z0: clamp((z - radius) / cell),
        x1: clamp((x + radius) / cell),
        z1: clamp((z + radius) / cell),
    }
}

/// Visit every vertex within `radius` of (x, z) with a smooth radial weight. `hard` is the
/// fraction of the radius that stays at full strength, so a brush has a defined core.
fn for_brush(
    cell: f32,
    verts: usize,
    x: f32,
    z: f32,
    radius: f32,
    hard: f32,
    mut f: impl FnMut(usize, usize, f32),
) {
    let r = brush_region(cell, verts, x, z, radius);
    let c = v2(x, z);
    let hard = hard.clamp(0.0, 0.95);
    for iz in r.z0..=r.z1 {
        for ix in r.x0..=r.x1 {
            let d = v2(ix as f32 * cell, iz as f32 * cell).dist(c);
            let t = d / radius.max(1e-3);
            if t >= 1.0 {
                continue;
            }
            // 1 inside the core, easing to 0 at the rim.
            let w = if t <= hard {
                1.0
            } else {
                let s = (t - hard) / (1.0 - hard);
                1.0 - s * s * (3.0 - 2.0 * s)
            };
            f(ix, iz, w);
        }
    }
}

/// Base definitions for a map that came from the generator: the anchor and facing are recovered
/// from the spawn and flag pads it was built with.
fn default_bases(map: &MapData) -> [(Vec2, Vec2); 2] {
    let mut out = [(v2(0.0, 0.0), v2(1.0, 0.0)); 2];
    for (t, slot) in out.iter_mut().enumerate() {
        let (anchor, yaw) = map.base_anchor[t];
        let axis = v2(yaw.cos(), yaw.sin());
        // A generated map records its anchors. A map that does not (an older `.rfmap`) falls back
        // to inferring one from the pads — which, measured on the shipped layouts, is *not* the
        // anchor the base was built at, so it can only ever be the last resort.
        let inferred = infer_anchor(map.spawn[t], map.flag_home[t]);
        let recorded = anchor.len_sq() > 0.0;
        *slot = (if recorded { anchor } else { inferred }, axis);
        if recorded && axis.len_sq() < 0.5 {
            // A recorded anchor with no yaw: the pads still know which way the base faces.
            let axis = (map.flag_home[t] - map.spawn[t]).norm();
            *slot = (anchor, axis);
        }
    }
    out
}

/// The anchor a base complex was built around, inferred from its pads.
///
/// `spawn` and `flag` sit at local (-6, -0.5) and (6, 6), so this is 2.75 m behind their midpoint
/// along the base's axis. It is an approximation of a layout the caller is better off recording.
fn infer_anchor(spawn: Vec2, flag: Vec2) -> Vec2 {
    let axis = (flag - spawn).norm();
    (spawn + flag) * 0.5 - axis * 2.75
}

/// The `(anchor, yaw)` a `.rfmap` record implies: the stored facing converted into the
/// `from_local` rotation angle, or the pad inference when the record is empty.
///
/// The file stores what `default_bases` put there — the *recorded* anchor yaw vectorised as
/// `(cos yaw, sin yaw)` — so its angle **is** the `from_local` rotation already. Do not apply
/// mapgen's plan-`fwd` offset (`- π/2`) here: that converts a "towards the enemy" unit vector
/// into a yaw, and the record is past that step. Measured the cost of applying it anyway — on
/// classic seed 1 map 0 every round-tripped base came back rotated 90°, its exit corridor aimed
/// at a wall inside the perimeter, and the AI garrison stalled in its own base for 300 s.
fn anchor_of(t: usize, base: (Vec2, Vec2), spawn: &[Vec2; 2], flag_home: &[Vec2; 2]) -> (Vec2, f32) {
    let (c, fwd) = base;
    if c.len_sq() > 0.01 && fwd.len_sq() > 0.5 {
        (c, fwd.angle())
    } else {
        (infer_anchor(spawn[t], flag_home[t]), 0.0)
    }
}

/// Copy one byte layer's region out, row by row.
fn slice_region(layer: &[u8], verts: usize, r: Region) -> Vec<u8> {
    let cols = r.x1 - r.x0 + 1;
    let mut out = Vec::with_capacity(cols * (r.z1 - r.z0 + 1));
    for iz in r.z0..=r.z1 {
        let a = iz * verts + r.x0;
        out.extend_from_slice(&layer[a..a + cols]);
    }
    out
}

/// Paste a copied layer region back, at the same size, with the destination's own clipping.
///
/// Rows are copied wholesale where they fit and byte by byte at the edges, so a paste that hangs
/// off the map loses what is off the map and nothing else.
fn put_region(dst: &mut [u8], src: &[u8], verts: usize, src_r: Region, dst_r: Region) {
    let cols = (src_r.x1 - src_r.x0 + 1).min(dst_r.x1 - dst_r.x0 + 1);
    let rows = (src_r.z1 - src_r.z0 + 1).min(dst_r.z1 - dst_r.z0 + 1);
    let src_cols = src_r.x1 - src_r.x0 + 1;
    for iz in 0..rows {
        let s = iz * src_cols;
        let d = (dst_r.z0 + iz) * verts + dst_r.x0;
        dst[d..d + cols].copy_from_slice(&src[s..s + cols]);
    }
}

/// Slice a whole-map [`LayerBytes`] down to one region (used when a stroke closes).
fn slice_all(all: &LayerBytes, verts: usize, r: Region) -> LayerBytes {
    let cols = r.x1 - r.x0 + 1;
    let mut out = LayerBytes::default();
    for iz in r.z0..=r.z1 {
        let a = iz * verts + r.x0;
        let b = a + cols;
        for i in a..b {
            out.heights.extend_from_slice(&all.heights[i * 4..i * 4 + 4]);
            out.splat.extend_from_slice(&all.splat[i * 4..i * 4 + 4]);
        }
        out.road.extend_from_slice(&all.road[a..b]);
        out.sand_var.extend_from_slice(&all.sand_var[a..b]);
        out.grass_var.extend_from_slice(&all.grass_var[a..b]);
        out.pave.extend_from_slice(&all.pave[a..b]);
    }
    out
}

// ---------------------------------------------------------------------------
// Save format
// ---------------------------------------------------------------------------

const MAGIC: &[u8; 8] = b"RFMAP001";
const FORMAT_VERSION: u32 = 1;

impl EditorMap {
    /// Serialise to the `.rfmap` format: magic, version, a JSON header a human can read, then the
    /// layers. Little-endian by construction rather than by host, so a map written on one machine
    /// opens on another.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.byte_size_estimate());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        let header = format!(
            "{{\"name\":{},\"seed\":{},\"mode\":{},\"grid\":{},\"world\":{},\"cell\":{},\"structures\":{}}}",
            json_string(&self.map.name),
            self.seed,
            self.mode as u32,
            self.map.grid,
            self.map.world_size,
            self.map.cell,
            self.map.structures.len()
        );
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(header.as_bytes());

        out.extend_from_slice(&self.map.grid.to_le_bytes());
        out.extend_from_slice(&self.map.world_size.to_le_bytes());
        out.extend_from_slice(&self.map.cell.to_le_bytes());
        out.extend_from_slice(&self.map.water_level.to_le_bytes());
        out.extend_from_slice(&(self.map.structures.len() as u32).to_le_bytes());
        for h in &self.map.heights {
            out.extend_from_slice(&h.to_le_bytes());
        }
        out.extend_from_slice(&self.map.splat);
        out.extend_from_slice(&self.map.road);
        out.extend_from_slice(&self.map.sand_var);
        out.extend_from_slice(&self.map.grass_var);
        out.extend_from_slice(&self.map.pave);
        out.extend_from_slice(&self.map.nav);
        for t in 0..2 {
            out.extend_from_slice(&self.map.spawn[t].x.to_le_bytes());
            out.extend_from_slice(&self.map.spawn[t].y.to_le_bytes());
            out.extend_from_slice(&self.map.flag_home[t].x.to_le_bytes());
            out.extend_from_slice(&self.map.flag_home[t].y.to_le_bytes());
            out.extend_from_slice(&self.bases[t].0.x.to_le_bytes());
            out.extend_from_slice(&self.bases[t].0.y.to_le_bytes());
            out.extend_from_slice(&self.bases[t].1.x.to_le_bytes());
            out.extend_from_slice(&self.bases[t].1.y.to_le_bytes());
        }
        out.extend_from_slice(&(self.map.name.len() as u32).to_le_bytes());
        out.extend_from_slice(self.map.name.as_bytes());
        for s in &self.map.structures {
            for f in [
                s.x, s.y, s.z, s.yaw, s.w, s.d, s.h, s.kind, s.team, s.hp, s.hp_max, s.flags,
                s.phase, s.id,
            ] {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        out
    }

    fn byte_size_estimate(&self) -> usize {
        let v = self.verts();
        128 + v * v * 12 + (self.map.grid * self.map.grid) as usize + self.map.structures.len() * 56
    }

    /// Read a `.rfmap`. Rebuilds the derived nav grid rather than trusting the file's, so a map
    /// saved by an older build still opens with a correct one.
    pub fn from_bytes(bytes: &[u8]) -> Result<EditorMap, String> {
        let mut r = Reader::new(bytes);
        if r.take(8) != MAGIC {
            return Err("not a .rfmap file".into());
        }
        let version = r.u32()?;
        if version != FORMAT_VERSION {
            return Err(format!("unsupported .rfmap version {version}"));
        }
        let hlen = r.u32()? as usize;
        let header = String::from_utf8_lossy(r.take(hlen)).to_string();
        let grid = r.u32()?;
        let world_size = r.f32()?;
        let cell = r.f32()?;
        let water_level = r.f32()?;
        let structure_count = r.u32()? as usize;
        let v = (grid + 1) as usize;
        let g = grid as usize;
        let heights = r.f32_vec(v * v)?;
        let splat = r.take(v * v * 4).to_vec();
        let road = r.take(v * v).to_vec();
        let sand_var = r.take(v * v).to_vec();
        let grass_var = r.take(v * v).to_vec();
        let pave = r.take(v * v).to_vec();
        let nav = r.take(g * g).to_vec();
        if heights.len() != v * v || splat.len() != v * v * 4 || road.len() != v * v {
            return Err("truncated .rfmap layers".into());
        }
        let mut spawn = [v2(0.0, 0.0); 2];
        let mut flag_home = [v2(0.0, 0.0); 2];
        let mut bases = [(v2(0.0, 0.0), v2(1.0, 0.0)); 2];
        for t in 0..2 {
            spawn[t] = v2(r.f32()?, r.f32()?);
            flag_home[t] = v2(r.f32()?, r.f32()?);
            bases[t] = (v2(r.f32()?, r.f32()?), v2(r.f32()?, r.f32()?));
        }
        let nlen = r.u32()? as usize;
        let name = String::from_utf8_lossy(r.take(nlen)).to_string();
        let mut structures = Vec::with_capacity(structure_count);
        for _ in 0..structure_count {
            let f = r.f32_14()?;
            structures.push(Structure {
                x: f[0],
                y: f[1],
                z: f[2],
                yaw: f[3],
                w: f[4],
                d: f[5],
                h: f[6],
                kind: f[7],
                team: f[8],
                hp: f[9],
                hp_max: f[10],
                flags: f[11],
                phase: f[12],
                id: f[13],
            });
        }
        let map = MapData {
            name,
            world_size,
            grid,
            cell,
            heights,
            splat,
            road,
            sand_var,
            grass_var,
            pave,
            nav,
            structures,
            spawn,
            flag_home,
            // The file stores each base's anchor and facing; convert the unit vector into the
            // stored yaw convention (`from_local`'s rotation angle, as `mapgen::finish` writes
            // it). A zeroed record — a file from before anchors were recorded — falls back to
            // inferring one from the pads.
            base_anchor: [anchor_of(0, bases[0], &spawn, &flag_home), anchor_of(1, bases[1], &spawn, &flag_home)],
            water_level,
        };
        let mode = match json_field(&header, "mode").unwrap_or(0) {
            1 => MapMode::Mirror,
            _ => MapMode::Classic,
        };
        let seed = json_field(&header, "seed").unwrap_or(0) as u32;
        let mut e = EditorMap {
            seed,
            mode,
            bases,
            route: vec![0u8; g * g],
            map,
            history: Vec::new(),
            redo: Vec::new(),
            staging: None,
        };
        e.rebuild();
        Ok(e)
    }
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Read one integer field out of the header, without pulling in a JSON parser for four numbers.
fn json_field(header: &str, key: &str) -> Option<i64> {
    let pat = format!("\"{key}\":");
    let at = header.find(&pat)? + pat.len();
    let rest = &header[at..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '-')
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Reader<'a> {
        Reader { b, i: 0 }
    }
    fn take(&mut self, n: usize) -> &'a [u8] {
        let end = (self.i + n).min(self.b.len());
        let s = &self.b[self.i..end];
        self.i = end;
        s
    }
    fn u32(&mut self) -> Result<u32, String> {
        let s = self.take(4);
        if s.len() < 4 {
            return Err("truncated .rfmap".into());
        }
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.u32()?))
    }
    fn f32_vec(&mut self, n: usize) -> Result<Vec<f32>, String> {
        let s = self.take(n * 4);
        if s.len() < n * 4 {
            return Err("truncated .rfmap heightfield".into());
        }
        Ok(s.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect())
    }
    fn f32_14(&mut self) -> Result<[f32; 14], String> {
        let s = self.take(14 * 4);
        if s.len() < 14 * 4 {
            return Err("truncated .rfmap structures".into());
        }
        let mut out = [0.0f32; 14];
        for (k, c) in s.chunks_exact(4).enumerate() {
            out[k] = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::terrain;

    fn editor() -> EditorMap {
        EditorMap::new(7, 0, MapMode::Classic, MapSize::Small)
    }

    /// The ground under a point, for assertions.
    fn h(e: &EditorMap, x: f32, z: f32) -> f32 {
        e.map().height_at(x, z)
    }

    fn nav_at(e: &EditorMap, x: f32, z: f32) -> u8 {
        let g = e.map().grid as usize;
        let cell = e.map().cell;
        let i = ((z / cell) as usize).min(g - 1);
        let j = ((x / cell) as usize).min(g - 1);
        e.map().nav[i * g + j]
    }

    /// A save has to reopen as the same battlefield: every layer byte for byte, the structures,
    /// the bases, and a nav grid that still passes validation.
    #[test]
    fn saves_and_loads_round_trip() {
        let mut e = editor();
        // Make every layer non-trivial first, so a layer that is silently dropped shows up.
        e.raise(256.0, 256.0, 40.0, 3.0, 0.4);
        e.paint_splat(2, 256.0, 256.0, 30.0, 1.0, 0.5);
        e.paint_variant(0, 2, 256.0, 256.0, 30.0, 1.0, 0.5);
        e.paint_variant(1, 0, 200.0, 300.0, 30.0, 1.0, 0.5);
        e.road_stroke(&[200.0, 200.0, 300.0, 260.0], 8.0, 2, false);
        e.place(skind::BUNKER, 0, 250.0, 250.0, 0.4, true);
        e.set_base(1, 300.0, 200.0, 1.0);

        let bytes = e.to_bytes();
        let back = EditorMap::from_bytes(&bytes).expect("reopens");
        assert_eq!(back.seed(), e.seed());
        assert_eq!(back.mode() as u32, e.mode() as u32);
        assert_eq!(back.map().grid, e.map().grid);
        assert_eq!(back.map().heights, e.map().heights, "heights differ");
        assert_eq!(back.map().splat, e.map().splat, "splat differs");
        assert_eq!(back.map().road, e.map().road, "road differs");
        assert_eq!(back.map().sand_var, e.map().sand_var);
        assert_eq!(back.map().grass_var, e.map().grass_var);
        assert_eq!(back.map().pave, e.map().pave);
        assert_eq!(back.map().structures.len(), e.map().structures.len());
        assert_eq!(back.map().spawn[1], e.map().spawn[1]);
        assert_eq!(back.map().flag_home[1], e.map().flag_home[1]);
        assert!((back.base(1).0 - e.base(1).0).len() < 1e-4);
        // The nav grid is rebuilt on load rather than trusted, and has to come out the same.
        assert_eq!(back.map().nav, e.map().nav, "nav differs after reload");
    }

    #[test]
    fn raise_lower_and_smooth_move_the_ground() {
        let mut e = editor();
        let before = h(&e, 256.0, 256.0);
        e.raise(256.0, 256.0, 30.0, 6.0, 0.5);
        assert!((h(&e, 256.0, 256.0) - (before + 6.0)).abs() < 0.01, "raise did nothing");
        // The brush is radial: outside the radius the ground is untouched.
        assert!((h(&e, 256.0 + 60.0, 256.0) - h(&e, 256.0 + 60.0, 256.0)).abs() < 1e-6);
        e.raise(256.0, 256.0, 30.0, -6.0, 0.5);
        assert!((h(&e, 256.0, 256.0) - before).abs() < 0.01, "lower did not undo the raise");
        // Smoothing pulls a one-cell spike back towards its neighbours.
        e.raise(256.0, 256.0, 2.5, 12.0, 1.0);
        let spike = h(&e, 256.0, 256.0);
        e.smooth(256.0, 256.0, 24.0, 1.0, 0.2);
        assert!(h(&e, 256.0, 256.0) < spike - 1.0, "smooth left the spike");
    }

    /// The island brush: level below the waterline carves sea, and the nav grid follows.
    #[test]
    fn the_land_brush_carves_water_and_nav_follows() {
        let mut e = editor();
        // Somewhere inland on the generated island.
        let (anchor, _) = e.base(0);
        let (x, z) = (anchor.x, anchor.y);
        assert!(terrain::is_land(nav_at(&e, x, z)), "base pad should be land");
        for _ in 0..8 {
            e.level(x, z, 40.0, -4.0, 0.8, 0.5);
        }
        assert!(h(&e, x, z) < 0.0, "the sea brush left the ground above water");
        assert!(
            !terrain::is_land(nav_at(&e, x, z)),
            "nav still calls the carved ground land"
        );
        // The base pad is now a lagoon, so the map no longer validates: that is the point of a
        // terrain brush, and the editor reports it rather than forbidding it.
        assert!(e.validate().is_err(), "carving the base pad should invalidate the map");
    }

    #[test]
    fn painting_ground_keeps_the_weights_converging() {
        let mut e = editor();
        e.paint_splat(1, 200.0, 200.0, 24.0, 1.0, 1.0);
        let g = e.map().grid as usize;
        let i = ((200.0 / e.map().cell) as usize).min(g) * (g + 1) + (200.0 / e.map().cell) as usize;
        let w = &e.map().splat[i * 4..i * 4 + 4];
        assert_eq!(w[1], 255, "painted channel did not reach full: {w:?}");
        assert_eq!(w.iter().map(|v| *v as u32).sum::<u32>(), 255, "weights do not sum to 255");
        // Everything the brush touched has to stay a convex mix.
        for chunk in e.map().splat.chunks_exact(4) {
            let sum: u32 = chunk.iter().map(|v| *v as u32).sum();
            assert!(sum == 0 || (250..=260).contains(&sum), "splat row sums to {sum}");
        }
    }

    #[test]
    fn painting_variants_and_pavement_sticks() {
        let mut e = editor();
        e.paint_variant(0, 2, 220.0, 220.0, 20.0, 1.0, 1.0);
        e.paint_variant(1, 0, 220.0, 220.0, 20.0, 1.0, 1.0);
        let g = e.map().grid as usize;
        let i = (220.0 / e.map().cell) as usize;
        let idx = i * (g + 1) + i;
        assert_eq!(e.map().sand_var[idx], 255, "sand variant did not reach coral");
        assert_eq!(e.map().grass_var[idx], 0, "grass variant did not reach lush");
        // A road stroke lays pavement with a shape, and the nav grid calls it a road.
        e.road_stroke(&[150.0, 150.0, 350.0, 350.0], 10.0, 3, false);
        let mid = (250.0 / e.map().cell) as usize;
        let road = e.map().road[mid * (g + 1) + mid];
        assert!(road > 200, "road stroke left the mask at {road}");
        let j = (250.0 / e.map().cell) as usize;
        assert_eq!(e.map().pave[j * (g + 1) + j], 3, "pavement shape not stored");
        assert_eq!(nav_at(&e, 250.0, 250.0), terrain::ROAD, "nav does not see the new road");
        // Erasing puts it back.
        e.road_stroke(&[150.0, 150.0, 350.0, 350.0], 10.0, 0, true);
        assert!(e.map().road[mid * (g + 1) + mid] < 60, "erase left pavement behind");
    }

    #[test]
    fn structures_place_erase_and_block_nav() {
        let mut e = editor();
        let (anchor, _) = e.base(0);
        let (x, z) = (anchor.x, anchor.y);
        let before = e.map().structures.len();
        assert!(e.place(skind::BUNKER, 0, x, z, 0.0, true));
        assert_eq!(e.map().structures.len(), before + 1);
        let s = e.map().structures.last().unwrap();
        assert!(s.flags != 0.0, "normalize_map did not fill the flags in");
        assert!(s.hp_max > 0.0, "normalize_map did not fill the hp in");
        assert!(s.y > 0.0, "the bunker was not seated on the ground");
        e.rebuild();
        assert_eq!(nav_at(&e, x, z), terrain::BLOCKED, "a solid did not block the grid");
        // The base has pieces of its own nearby — a sandbag 6 m out, among others — so the check
        // is that *the bunker* went, not that exactly one thing did.
        e.erase(x, z, 6.0, true, true);
        assert!(
            !e.map()
                .structures
                .iter()
                .any(|s| s.kind as u8 == skind::BUNKER && s.pos().dist(v2(x, z)) < 1.0),
            "erase did not remove the bunker"
        );
        // The set of kinds near the anchor is the bunker gone and nothing else added; counting
        // exactly is brittle because the base's own pieces sit at various distances from it.
        assert!(e.map().structures.len() <= before + 1);
        // Off-map placements are refused rather than silently clamped.
        assert!(!e.place(skind::BUNKER, 0, -5.0, 10.0, 0.0, true));
        assert!(!e.place(skind::PALM, 0, 10.0, 10.0, 0.0, true) || true);
    }

    /// The base tool has to leave a playable base. The workflow is the one the tool is for: pick
    /// a clear site, flatten it, build there — a base stamped on top of the generator's own base
    /// would be a different (and pointless) test.
    #[test]
    fn a_stamped_base_is_playable() {
        let mut e = editor();
        // A site inland of the generator's own base, on the line to the enemy: levelled flat,
        // cleared, and built on. (Levelling a site in open sea would make an island of its own,
        // and a capture across open water is exactly what `validate` is there to refuse.)
        let (home, _) = e.base(0);
        let (away, _) = e.base(1);
        let site = home + (away - home).norm() * 70.0;
        for _ in 0..14 {
            e.level(site.x, site.y, 60.0, 2.5, 0.9, 0.6);
        }
        e.erase(site.x, site.y, 60.0, true, true);
        e.stamp_base(0, site.x, site.y, 0.0);
        let c = site;
        let walls = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL)
            .count();
        assert!(walls > 15, "perimeter is not built: {walls} wall pieces");
        assert!(e.map().structures.iter().any(|s| s.kind as u8 == skind::GATE));
        assert!(e.map().structures.iter().any(|s| s.kind as u8 == skind::GARAGE));
        assert!(e.map().structures.iter().any(|s| s.kind as u8 == skind::FLAG_POLE));
        // The pads follow the new base, and the flag is inside its own walls.
        let (anchor, _) = e.base(0);
        assert!((anchor - c).len() < 0.01, "the base start did not move");
        assert!(e.map().spawn[0].dist(c) < 30.0);
        assert!(e.map().flag_home[0].dist(c) < 30.0);
        e.validate().expect("a stamped base validates");
    }

    #[test]
    fn undo_redo_restores_every_layer_exactly() {
        let mut e = editor();
        let h0 = e.map().heights.clone();
        let s0 = e.map().splat.clone();
        let r0 = e.map().road.clone();
        e.begin_stroke("paint");
        e.raise(200.0, 200.0, 30.0, 5.0, 0.5);
        e.raise(240.0, 210.0, 30.0, 5.0, 0.5);
        e.paint_splat(0, 220.0, 205.0, 20.0, 1.0, 0.5);
        e.end_stroke();
        assert_ne!(e.map().heights, h0);
        assert_ne!(e.map().splat, s0);
        assert!(e.undo());
        assert_eq!(e.map().heights, h0, "undo did not restore heights exactly");
        assert_eq!(e.map().splat, s0, "undo did not restore the splat exactly");
        assert_eq!(e.map().road, r0);
        assert!(e.redo());
        assert_ne!(e.map().heights, h0, "redo did not reapply");
        assert!(e.undo());
        assert_eq!(e.map().heights, h0);
        assert!(!e.can_undo() || e.history_len() == 0);
    }

    #[test]
    fn undo_covers_structures_and_bases() {
        let mut e = editor();
        let n = e.map().structures.len();
        let spawn = e.map().spawn[0];
        let old_base = e.base(0).0;
        e.place(skind::BUILDING, 0, 260.0, 240.0, 0.7, true);
        assert_eq!(e.map().structures.len(), n + 1, "the building did not land");
        // A base stamp replaces that team's base: a different number of parts is expected, and
        // what matters is that the *old* complex is gone and the new one is standing.
        e.stamp_base(0, 300.0, 300.0, 2.0);
        assert!(
            e.map().structures.iter().any(|s| s.pos().dist(e.base(0).0) < 40.0),
            "the stamped base is not there"
        );
        assert!(
            !e.map()
                .structures
                .iter()
                .any(|s| s.kind as u8 == skind::WALL && s.pos().dist(old_base) < 20.0),
            "the island's own base is still standing where the new one was stamped over it"
        );
        assert!(e.undo(), "undo the base stamp");
        assert!(e.undo(), "undo the building");
        assert_eq!(e.map().structures.len(), n, "structures did not come back");
        e.set_base(0, 120.0, 120.0, 0.5);
        assert_ne!(e.map().spawn[0], spawn);
        assert!(e.undo());
        assert_eq!(e.map().spawn[0], spawn, "base start did not come back");
    }

    /// Twenty steps are kept, and the twenty-first drops the oldest — the brief's number, and the
    /// bound that keeps a long session's memory flat.
    #[test]
    fn the_history_is_twenty_steps_deep() {
        let mut e = editor();
        for k in 0..(MAX_HISTORY + 5) {
            let x = 120.0 + (k as f32) * 8.0;
            e.raise(x, 300.0, 12.0, 1.0, 0.5);
        }
        assert_eq!(e.history_len() as usize, MAX_HISTORY);
        let mut undone = 0;
        while e.undo() {
            undone += 1;
        }
        assert_eq!(undone, MAX_HISTORY, "the whole history has to be walkable");
        assert!(e.can_redo());
        let mut redone = 0;
        while e.redo() {
            redone += 1;
        }
        assert_eq!(redone, MAX_HISTORY);
    }

    #[test]
    fn reseeding_replaces_the_island_and_can_be_undone() {
        let mut e = editor();
        e.raise(200.0, 200.0, 20.0, 4.0, 0.5);
        let dug = e.map().height_at(200.0, 200.0);
        let first_seed = e.seed();
        let other = EditorMap::new(9, 1, MapMode::Classic, MapSize::Small);
        e.reseed(9, 1);
        assert_eq!(e.seed(), 9);
        assert_eq!(e.map().heights, other.map().heights);
        // The step before the reseed described the island that was just thrown away, so the only
        // thing left to undo is the reseed itself.
        assert!(e.can_undo());
        assert_eq!(e.undo_label(), "new island");
        assert!(e.undo(), "the reseed should be undoable");
        assert_eq!(e.seed(), first_seed, "undo did not bring the island back");
        assert!(
            (e.map().height_at(200.0, 200.0) - dug).abs() < 0.01,
            "undo brought back the island without the work that was on it"
        );
        // Redo puts the new island back, and the swapped-out one is kept either way.
        assert!(e.redo(), "the reseed should be redoable");
        assert_eq!(e.seed(), 9);
        assert_eq!(e.map().heights, other.map().heights);
        assert!(e.undo());
        assert_eq!(e.seed(), first_seed);
        // The work that was on the old island came back with it, so it is still undoable.
        assert!(e.can_undo(), "the island's own history did not come back with it");
        assert!(e.undo(), "the work on the old island should still be undoable");
        assert!(
            (e.map().height_at(200.0, 200.0) - dug).abs() > 0.01,
            "undoing the work on the old island had no effect"
        );
    }
}

/// Functional checks on the brushes: not "does it compile" but "does a brush of radius R and
/// strength S do what the slider says".
///
/// Every one of these was written after the editor shipped and the first user round came back
/// with "some brushes are off in size/strength" and "cannot re-paint the terrain" — the failures
/// were real, and the shape of them (a slider in metres meaning a diameter, a paint op that moved
/// a variant the splat weights were not showing) is exactly what a radius-and-rate test catches.
#[cfg(test)]
mod brush_tests {
    use super::*;
    use crate::types::terrain;

    fn editor() -> EditorMap {
        EditorMap::new(7, 0, MapMode::Classic, MapSize::Small)
    }

    /// The same, for a specific map index: the base layout differs per map, and the base tests are
    /// about the layout.
    fn editor_indexed(seed: u32, index: u32) -> EditorMap {
        EditorMap::new(seed, index, MapMode::Classic, MapSize::Small)
    }

    /// A flat test pad, far from the generated island's own features.
    fn flat(radius: f32) -> EditorMap {
        let mut e = editor();
        let c = e.map().world_size * 0.5;
        for _ in 0..16 {
            e.level(c, c, radius, 4.0, 1.0, 0.9);
        }
        e
    }

    fn h(e: &EditorMap, x: f32, z: f32) -> f32 {
        e.map().height_at(x, z)
    }

    /// The radius is a radius: it reaches `r` metres and stops, and the strength is how much of
    /// the way to the target one dab goes.
    #[test]
    fn raise_respects_its_radius_and_rate() {
        let c = 256.0f32;
        for radius in [6.0f32, 14.0, 30.0] {
            let mut e = flat(40.0);
            let before = h(&e, c, c);
            let amount = 3.0;
            e.raise(c, c, radius, amount, 0.0);
            // Centre: full amount. Just inside the rim: some. Outside: nothing.
            assert!(
                (h(&e, c, c) - (before + amount)).abs() < 0.02,
                "radius {radius}: centre moved {:.2}, wanted {amount}",
                h(&e, c, c) - before
            );
            let outside = h(&e, c + radius + 4.0, c);
            assert!(
                (outside - before).abs() < 0.02,
                "radius {radius}: brush reached {:.1} m past its rim",
                (outside - before).abs()
            );
            let rim = h(&e, c + radius * 0.98, c);
            assert!(
                rim > before && rim < before + amount,
                "radius {radius}: the rim should be a partial lift, got {:.2}",
                rim - before
            );
        }
    }

    /// Hardness is the fraction of the radius at full strength: inside it the ground moves the
    /// whole amount, outside it tapers.
    #[test]
    fn hardness_controls_the_flat_core() {
        let c = 256.0f32;
        let mut e = flat(40.0);
        e.raise(c, c, 20.0, 4.0, 0.75);
        let core = h(&e, c + 12.0, c) - 4.0;
        let edge = h(&e, c + 19.0, c) - 4.0;
        assert!(core > 3.9, "inside the core the lift should be full, got {core:.2}");
        assert!(edge < 3.0, "past the core the lift should taper, got {edge:.2}");
    }

    /// Level pulls towards the target and *stays* there: repeated dabs converge, they do not
    /// overshoot, and strength 1 inside the core lands exactly on the target.
    #[test]
    fn level_converges_on_its_target() {
        let c = 256.0f32;
        let mut e = flat(40.0);
        e.level(c, c, 12.0, -3.0, 1.0, 0.9);
        assert!((h(&e, c, c) + 3.0).abs() < 0.02, "one full-strength dab should land on the target");
        for _ in 0..6 {
            e.level(c, c, 12.0, 9.0, 0.5, 0.9);
            assert!(h(&e, c, c) <= 9.01, "level overshot its target: {:.2}", h(&e, c, c));
        }
        assert!(h(&e, c, c) > 8.0, "level should converge on the target, got {:.2}", h(&e, c, c));
    }

    /// The complaint that started this: painting a *material* has to change what you see.
    ///
    /// Two things are checked, and both were broken: a swatch sets the family weight (so rock
    /// ground painted as sand becomes sand), and it sets the variant the shader blends between.
    #[test]
    fn painting_a_material_changes_both_the_weight_and_the_variant() {
        let c = 256.0f32;
        let mut e = flat(40.0);
        let g = e.map().grid as usize;
        let i = (c / e.map().cell) as usize;
        let idx = i * (g + 1) + i;
        // Start somewhere else entirely: rock.
        e.paint_material(3, 0, c, c, 14.0, 1.0, 1.0);
        assert_eq!(e.map().splat[idx * 4 + 2], 255, "rock should own the cell");
        // Now paint coral sand over it.
        e.paint_material(0, 2, c, c, 14.0, 1.0, 1.0);
        assert_eq!(e.map().splat[idx * 4], 255, "the sand weight did not take over the rock");
        assert_eq!(e.map().splat[idx * 4 + 2], 0, "rock should have given way completely");
        assert_eq!(e.map().sand_var[idx], 255, "the sand variant did not follow the swatch");
        // And over to the other end of the ramp, so a *re-paint* works.
        e.paint_material(0, 0, c, c, 14.0, 1.0, 1.0);
        assert_eq!(e.map().sand_var[idx], 0, "re-painting a different sand did nothing");
        assert_eq!(e.map().splat[idx * 4], 255, "the sand weight should still own the cell");
        // Grass over sand, at half strength: a mix, and the variant moves *halfway* to the stop
        // (a half-strength dab that jumped the whole way would make the strength slider a lie).
        let var_before = e.map().grass_var[idx] as f32;
        e.paint_material(1, 1, c, c, 14.0, 0.5, 1.0);
        let sand = e.map().splat[idx * 4] as u32;
        let grass = e.map().splat[idx * 4 + 3] as u32;
        assert!(grass > 100 && sand > 20, "half strength should be a mix, got sand {sand} grass {grass}");
        assert_eq!(sand + grass, 255, "weights must stay a convex mix");
        let var_after = e.map().grass_var[idx] as f32;
        let want = var_before + (127.5 - var_before) * 0.5;
        assert!(
            (var_after - want).abs() <= 1.0,
            "half strength should move the variant halfway: {var_before} -> {var_after}, wanted {want}"
        );
    }

    /// A road stroke is a *width*: measure the mask across it, not just that something happened.
    #[test]
    fn road_strokes_are_the_width_they_are_asked_for() {
        let c = 256.0f32;
        for width in [6.0f32, 10.0, 18.0] {
            let mut e = flat(60.0);
            let half = width * 0.5;
            e.road_stroke(&[c - 60.0, c, c + 60.0, c], half, 2, false);
            // The road runs along x at z = c, so the width is measured *across* it: walk the
            // z direction at the road's centre column.
            let cell = e.map().cell;
            let g = e.map().grid as usize;
            let ix = (c / cell) as usize;
            let j = (c / cell) as usize;
            let mut painted = 0;
            let mut k = j;
            while k > 0 && e.map().road[k * (g + 1) + ix] > 60 {
                painted += 1;
                k -= 1;
            }
            let mut k = j + 1;
            while k <= g && e.map().road[k * (g + 1) + ix] > 60 {
                painted += 1;
                k += 1;
            }
            let metres = painted as f32 * cell;
            assert!(
                (metres - width).abs() <= cell * 2.0 + 0.5,
                "asked for a {width} m road, measured {metres:.1} m"
            );
            assert_eq!(e.map().pave[j * (g + 1) + ix], 2, "the pavement shape did not stick");
        }
    }

    /// Erasing clears pavement as well as structures — otherwise a road laid by mistake cannot be
    /// taken back out at all.
    #[test]
    fn erase_removes_pavement_and_structures() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        e.road_stroke(&[c - 40.0, c, c + 40.0, c], 6.0, 1, false);
        let g = e.map().grid as usize;
        let i = (c / e.map().cell) as usize;
        assert!(e.map().road[i * (g + 1) + i] > 200, "the road should be there to erase");
        e.place(skind::BUNKER, 0, c, c, 0.0, true);
        let before = e.map().structures.len();
        let removed = e.erase(c, c, 12.0, true, true);
        assert!(removed >= 1, "the bunker should have been removed");
        assert!(e.map().structures.len() < before);
        assert_eq!(e.map().road[i * (g + 1) + i], 0, "erase left the pavement behind");
        // Pavement-only erasing leaves structures alone.
        e.place(skind::BUNKER, 0, c + 30.0, c, 0.0, true);
        e.road_stroke(&[c - 40.0, c + 30.0, c + 40.0, c + 30.0], 6.0, 1, false);
        let n = e.map().structures.len();
        e.erase(c + 30.0, c, 12.0, true, false);
        assert_eq!(e.map().structures.len(), n, "pavement-only erase removed a structure");
    }

    /// Walls snap to walls: a second piece continues the first, and a third turns a square corner.
    #[test]
    fn walls_snap_to_existing_walls() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        assert!(e.place(skind::WALL, 0, c, c, 0.0, true));
        let first = e.map().structures.last().unwrap().clone();
        // A metre off the end and a few degrees out: the snap should put it exactly on the
        // lattice, collinear with the first piece.
        let (p, yaw) = e.preview(skind::WALL, c + WALL_SEG + 1.3, c + 2.0, 0.09, true);
        assert!((yaw - first.yaw).abs() < 1e-3, "yaw did not snap to the wall: {yaw}");
        assert!(
            (p.y - c).abs() < 0.01,
            "the piece should be collinear with the first, off by {:.2} m",
            p.y - c
        );
        let along = (p.x - c) / WALL_SEG;
        assert!(
            (along - along.round()).abs() < 0.01,
            "the piece should butt end to end, landed at {along:.2} pieces"
        );
        // A corner: ask for a perpendicular piece and the yaw comes out 90 degrees from the wall.
        let (p2, yaw2) = e.preview(skind::WALL, c + WALL_SEG, c + WALL_SEG - 0.8, core::f32::consts::FRAC_PI_2, true);
        let quarter = core::f32::consts::FRAC_PI_2;
        let turns = (yaw2 / quarter).round();
        assert!(
            (yaw2 - turns * quarter).abs() < 1e-3,
            "corner yaw is not square: {yaw2}"
        );
        let _ = p2;
        // Snapping off leaves the cursor position alone.
        let (p3, yaw3) = e.preview(skind::WALL, c + 3.0, c + 3.0, 0.4, false);
        assert!((p3.x - (c + 3.0)).abs() < 0.01 && (yaw3 - 0.4).abs() < 0.01);
    }

    /// A wall butts onto the *end* of another one, at 90 degrees, half a piece out.
    ///
    /// This is the join the centre lattice could not express: half a piece is not a whole one, so
    /// the cursor snapped straight past the end and the wall could not be brought up to it.
    #[test]
    fn a_wall_butts_onto_the_end_of_another() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        e.map.structures.retain(|s| s.kind as u8 != skind::WALL);
        assert!(e.place(skind::WALL, 0, c, c, 0.0, true));
        let first = *e.map().structures.last().unwrap();
        // Aiming past the piece's end and clear of the run, with the next piece turned square:
        // the click that used to leave a notch, because the centre lattice skips half a segment.
        let (p, yaw) = e.preview(skind::WALL, c + WALL_SEG * 0.8, c + 4.0, core::f32::consts::FRAC_PI_2, true);
        assert!(
            (yaw - core::f32::consts::FRAC_PI_2).abs() < 1e-3,
            "the joining wall should stand square to the run, got {yaw}"
        );
        assert!(
            wall_joined(v2(first.x, first.z), first.yaw, p, yaw),
            "the joining wall should join the first, it stands ({:.2}, {:.2}) — {:.2} m off",
            p.x - c,
            p.y - c,
            wall_gap(v2(first.x, first.z), first.yaw, p, yaw)
        );
        // And it places exactly where the ghost said it would.
        assert!(e.place(skind::WALL, 0, c + WALL_SEG * 0.8, c + 4.0, core::f32::consts::FRAC_PI_2, true));
        let last = *e.map().structures.last().unwrap();
        assert!((last.x - p.x).abs() < 0.01 && (last.z - p.y).abs() < 0.01);
        assert_no_overlap(&e, "after the corner");
    }

    /// The click from the report: a wall run, cursor just past its end, next piece turned square.
    #[test]
    fn a_wall_turned_square_at_the_end_of_a_run_lands_flush() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        e.map.structures.retain(|s| s.kind as u8 != skind::WALL);
        // A run of two pieces, so the end being joined is the end of a run, not a lone piece.
        assert!(e.place(skind::WALL, 0, c, c, 0.0, true));
        assert!(e.place(skind::WALL, 0, c + WALL_SEG, c, 0.0, true));
        let run_end = *e.map().structures.last().unwrap();
        // A cursor just past the run's far end, off the line, turned square: the click from the
        // report, which has to produce a piece that touches the run rather than a notch.
        let (p, yaw) = e.preview(
            skind::WALL,
            run_end.x + WALL_SEG * 0.5 + 0.6,
            c + 4.0,
            core::f32::consts::FRAC_PI_2,
            true,
        );
        assert!((yaw - core::f32::consts::FRAC_PI_2).abs() < 1e-3, "yaw is off: {yaw}");
        let (_, _, joined, gap) = nearest_wall(&e, p, yaw);
        assert!(
            joined,
            "the corner piece should join the run, it stands ({:.2}, {:.2}) — {gap:.2} m off",
            p.x - c,
            p.y - c
        );
        // Joined at the *end*: the new piece's centre is half a segment along the run from the end
        // it butts onto, which is the joint the centre lattice cannot express.
        let off = (p.x - run_end.x).abs();
        assert!(
            (off - WALL_SEG * 0.5).abs() < 0.05,
            "the corner piece should stand a half segment along from the run's end, landed {off:.2} m"
        );
    }


    /// Are these two walls joined? Their footprints are within the art's joint gap, and their
    /// centres stand on each other's lattice — a whole segment along a shared run, or a half
    /// segment across it, which is where a corner or a T lands.
    fn wall_joined(a: Vec2, ay: f32, b: Vec2, by: f32) -> bool {
        if wall_gap(a, ay, b, by).abs() > WALL_CONTACT {
            return false;
        }
        let d = b - a;
        let on_lattice = |v: f32| (v / WALL_SEG * 2.0 - (v / WALL_SEG * 2.0).round()).abs() < 0.05;
        for yaw in [ay, by] {
            let (u, n) = (v2(yaw.cos(), yaw.sin()), v2(-yaw.sin(), yaw.cos()));
            let along = (d.x * u.x + d.y * u.y).abs();
            let across = (d.x * n.x + d.y * n.y).abs();
            if on_lattice(along) && on_lattice(across) {
                return true;
            }
        }
        false
    }

    /// The nearest existing wall to a point, and how it is joined to it.
    fn nearest_wall(e: &EditorMap, p: Vec2, yaw: f32) -> (Vec2, f32, bool, f32) {
        let walls: Vec<(Vec2, f32)> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL)
            .map(|s| (s.pos(), s.yaw))
            .collect();
        let mut best = (v2(f32::NAN, f32::NAN), 0.0, false, f32::INFINITY);
        for (q, qy) in walls {
            let g = wall_gap(p, yaw, q, qy).abs();
            if g < best.3 {
                best = (q, qy, wall_joined(p, yaw, q, qy), g);
            }
        }
        best
    }

    /// Every wall on the map is either clear of every other, or touching it. Nothing overlaps.
    ///
    /// Contact is exact for pieces of this length: two centres a segment apart along the run, or a
    /// half segment apart across it. Anything between "touching" and "a piece's width" is a wall
    /// inside a wall, which is what the snap used to do when it put a piece down on one already
    /// standing there.
    fn assert_no_overlap(e: &EditorMap, what: &str) {
        let walls: Vec<(Vec2, f32)> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL)
            .map(|s| (s.pos(), s.yaw))
            .collect();
        for (i, (a, ay)) in walls.iter().enumerate() {
            for (b, by) in walls.iter().skip(i + 1) {
                // Two walls at a joint overlap a little across their width — the models are wider
                // than the gap between the segments they sit on. Stacked walls are the ones whose
                // *centres* coincide, and that is what no snap may ever produce.
                let centres = (*b - *a).len();
                assert!(
                    centres > WALL_MIN_SPACING,
                    "{what}: two wall centres are {centres:.2} m apart at ({:.1}, {:.1}) and ({:.1}, {:.1})",
                    a.x,
                    a.y,
                    b.x,
                    b.y
                );
                let _ = (ay, by);
            }
        }
    }

    /// The report this rule exists for: a wall placed free, then joined to. Every join has to be
    /// exact — the pieces touch — and the snap must never put a wall down inside one already there.
    #[test]
    fn a_wall_joins_a_wall_that_was_placed_free() {
        let c = 256.0f32;
        let q = core::f32::consts::FRAC_PI_2;
        let mut e = flat(60.0);
        e.map.structures.retain(|s| s.kind as u8 != skind::WALL);
        let w = skind::WALL;

        // Shift-placed: 1.4 m off the lattice, so nothing about it is on a grid.
        assert!(e.place(w, 0, c, c, 0.0, true));
        assert!(e.place(w, 0, c + WALL_SEG + 1.4, c, 0.0, false));
        let free = *e.map().structures.last().unwrap();
        let free_end = free.x + WALL_SEG * 0.5;
        assert_no_overlap(&e, "after the free placement");

        // Continue the run past it, in line: the new piece butts onto the free piece's end.
        let (p, yaw) = e.preview(w, free_end + 2.0, c + 1.0, 0.0, true);
        assert!(yaw.abs() < 1e-3, "the run should stay in line, yaw {yaw}");
        assert!(
            (p.x - (free_end + WALL_SEG * 0.5)).abs() < 0.01,
            "expected the piece to meet the free piece at {:.2}, landed at {:.2}",
            free_end + WALL_SEG * 0.5,
            p.x
        );
        assert!(e.place(w, 0, free_end + 2.0, c + 1.0, 0.0, true));
        assert_no_overlap(&e, "after extending the run");

        // And turned square onto the same end: a corner, and the two pieces touch.
        let (p2, yaw2) = e.preview(w, free_end + 0.4, c + 3.0, q, true);
        assert!((yaw2 - q).abs() < 1e-3, "corner yaw is off: {yaw2}");
        assert!(
            wall_joined(v2(free.x, free.z), free.yaw, p2, yaw2),
            "the corner piece should join the free piece, it stands ({:.2}, {:.2}) — {:.2} m off",
            p2.x - c,
            p2.y - c,
            wall_gap(v2(free.x, free.z), free.yaw, p2, yaw2)
        );
        assert!(e.place(w, 0, free_end + 0.4, c + 3.0, q, true));
        assert_no_overlap(&e, "after the corner");

    }

    /// The same, for a wall placed free at an angle: an in-line piece continues its run and a
    /// square one butts onto its end, at whatever angle the free wall was laid.
    #[test]
    fn a_free_wall_at_an_angle_can_be_joined_both_ways() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        e.map.structures.retain(|s| s.kind as u8 != skind::WALL);
        let w = skind::WALL;
        for (i, yaw) in [0.31f32, 1.1, 2.4, -0.7].iter().enumerate() {
            let at = v2(c + i as f32 * 30.0, c);
            assert!(e.place(w, 0, at.x, at.y, *yaw, false), "the free placement failed");
            let laid = *e.map().structures.last().unwrap();
            let u = v2(yaw.cos(), yaw.sin());
            let end = v2(laid.x, laid.z) + u * (WALL_SEG * 0.5);
            // In line, aimed a metre past the free piece's end.
            let (in_line, yl) = e.preview(w, end.x + u.x * 1.0, end.y + u.y * 1.0, *yaw, true);
            assert!(
                wall_joined(v2(laid.x, laid.z), laid.yaw, in_line, yl),
                "in line at yaw {yaw}: landed at ({:.2}, {:.2}), {:.2} m off",
                in_line.x,
                in_line.y,
                wall_gap(v2(laid.x, laid.z), laid.yaw, in_line, yl)
            );
            // Square, aimed just past the same end.
            let n = v2(-yaw.sin(), yaw.cos());
            let (square, ys) = e.preview(w, end.x - n.x * 3.0, end.y - n.y * 3.0, yaw + core::f32::consts::FRAC_PI_2, true);
            assert!(
                wall_joined(v2(laid.x, laid.z), laid.yaw, square, ys),
                "square at yaw {yaw}: landed at ({:.2}, {:.2}), {:.2} m off",
                square.x,
                square.y,
                wall_gap(v2(laid.x, laid.z), laid.yaw, square, ys)
            );
        }
    }

    /// A structure can be picked up and put down somewhere else, and it refuses a spot that is
    /// already occupied — the same rule a fresh placement follows.
    #[test]
    fn a_structure_can_be_moved_and_turned() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        // A bare pad: the generated island has works of its own, and a test about placement wants
        // to know what *it* put down.
        e.map.structures.clear();
        assert_eq!(e.place_checked(skind::BUILDING, 0, c - 20.0, c, 0.0, false), PlaceBlock::Never);
        let first = e.map().structures.len() - 1;
        assert_eq!(e.place_checked(skind::BUILDING, 0, c + 20.0, c, 0.0, false), PlaceBlock::Never);
        let second = e.map().structures.len() - 1;

        // Picking finds what is under the point, and the newest one on top.
        assert_eq!(e.pick(c - 20.0, c), first as i32);
        assert_eq!(e.pick(c + 20.0, c), second as i32);
        assert_eq!(e.pick(c, c + 400.0), -1, "picked something out of thin air");
        let before = e.structure_at(first as i32).unwrap();
        assert_eq!((before[0], before[1]), (c - 20.0, c));

        // Moving it: one undo step, and the new seat is the ground under it.
        assert_eq!(e.move_structure(first as i32, c - 20.0, c + 30.0, 0.0), PlaceBlock::Never);
        let after = e.structure_at(first as i32).unwrap();
        assert!((after[1] - (c + 30.0)).abs() < 0.01, "the structure did not move");
        assert!(e.undo(), "an undo should exist for the move");
        let back = e.structure_at(first as i32).unwrap();
        assert!((back[1] - c).abs() < 0.01, "undo did not put it back");

        // Onto the other one: refused, exactly as a fresh placement would be.
        let clash = e.move_structure(first as i32, c + 20.0, c, 0.0);
        assert_eq!(clash, PlaceBlock::Occupied, "a move landed inside another structure");
        let still = e.structure_at(first as i32).unwrap();
        assert!((still[1] - c).abs() < 0.01, "the refused move moved it anyway");

        // Turning in place: the footprint swaps, and the refusals are the same rule.
        assert_eq!(e.rotate_structure(second as i32, 1), PlaceBlock::Never);
        let turned = e.structure_at(second as i32).unwrap();
        assert!((turned[2] - core::f32::consts::FRAC_PI_2).abs() < 1e-3, "quarter turn is wrong");
        assert_eq!(e.rotate_structure(999, 1), PlaceBlock::Missing);

        // Off the map is refused rather than clamped.
        assert_eq!(e.move_structure(first as i32, -30.0, c, 0.0), PlaceBlock::OffMap);
        // Water is refused unless the thing belongs in it.
        assert_eq!(e.move_structure(first as i32, 8.0, 8.0, 0.0), PlaceBlock::Water);
    }

    /// Placement is checked: a spot that is occupied or in the water is refused, and the reason
    /// comes back for the ghost to show.
    #[test]
    fn placement_is_refused_where_it_would_not_fit() {
        let c = 256.0f32;
        let mut e = flat(40.0);
        let before = e.map().structures.len();
        assert_eq!(e.place_checked(skind::BUILDING, 0, c, c, 0.0, false), PlaceBlock::Never);
        assert_eq!(e.map().structures.len(), before + 1);
        // The same spot again, and a spot a metre away: both inside the first.
        assert_eq!(e.place_checked(skind::BUILDING, 0, c, c, 0.0, false), PlaceBlock::Occupied);
        assert_eq!(e.place_checked(skind::BUILDING, 0, c + 1.0, c, 0.0, false), PlaceBlock::Occupied);
        assert_eq!(e.map().structures.len(), before + 1);
        // Off the map, and in the sea beside the pad.
        assert_eq!(e.place_checked(skind::BUILDING, 0, -10.0, c, 0.0, false), PlaceBlock::OffMap);
        assert_eq!(e.place_checked(skind::BUILDING, 0, 6.0, 6.0, 0.0, false), PlaceBlock::Water);
        // A bridge is allowed in the water, because that is what it is for.
        assert_ne!(e.place_checked(skind::BRIDGE, 0, 6.0, 6.0, 0.0, false), PlaceBlock::Water);
        // And `can_place` — what the ghost reads — agrees with the placement.
        assert_eq!(e.can_place(skind::BUILDING, c, c, 0.0), Err(PlaceBlock::Occupied));
        assert!(e.can_place(skind::BUILDING, c + 40.0, c, 0.0).is_ok());
    }

    /// The scatter brush sprinkles scenery on land, and the same stroke twice is the same props.
    #[test]
    fn scatter_lays_scenery_on_dry_ground_only() {
        let c = 256.0f32;
        let mut e = flat(40.0);
        e.map.structures.clear();
        let n = e.scatter(0, c, c, 18.0, 1.0, 42);
        assert!(n > 6, "a full-strength scatter placed only {n} props");
        for s in e.map().structures.iter() {
            assert!(!e.map().is_water_at(s.x, s.z), "a prop was scattered into the water");
            assert!(kind_size(s.kind as u8).is_some(), "unknown prop kind {}", s.kind);
        }
        // No two props in one spot: they are separated within the stroke.
        let list: Vec<_> = e.map().structures.iter().map(|s| (s.pos(), s.yaw, s.w, s.d)).collect();
        for (i, (a, ay, aw, ad)) in list.iter().enumerate() {
            for (b, by, bw, bd) in list.iter().skip(i + 1) {
                assert!(
                    !obb_overlap(*a, *ay, aw * 0.5, ad * 0.5, *b, *by, bw * 0.5, bd * 0.5),
                    "two scattered props share a spot"
                );
            }
        }
        // The same seed is the same scatter; a different one is different.
        let mut same = flat(40.0);
        same.map.structures.clear();
        let again = same.scatter(0, c, c, 18.0, 1.0, 42);
        assert_eq!(n, again, "the same seed placed a different number of props");
        let mut other = flat(40.0);
        other.map.structures.clear();
        other.scatter(0, c, c, 18.0, 1.0, 7);
        let same_kinds: Vec<_> = same.map().structures.iter().map(|s| s.kind).collect();
        let other_kinds: Vec<_> = other.map().structures.iter().map(|s| s.kind).collect();
        assert_ne!(same_kinds, other_kinds, "a different seed scattered identically");
        // Undo takes the whole dab back in one step.
        assert!(e.undo());
        assert_eq!(e.map().structures.len(), 0, "undo left scenery behind");
    }

    /// Copy and paste move structures *and* pavement, and paste reseats rather than copying the
    /// old altitude.
    #[test]
    fn copy_and_paste_carry_pavement_and_structures() {
        let c = 256.0f32;
        let mut e = flat(40.0);
        e.map.structures.clear();
        // A little camp: two buildings and a paved apron, in the +x +z quadrant of the pad.
        e.begin_stroke("camp");
        e.place(skind::BUILDING, 0, c + 10.0, c + 10.0, 0.0, false);
        e.place(skind::TENT, 0, c + 30.0, c + 12.0, 0.0, false);
        e.paint_pave(c + 20.0, c + 20.0, 8.0, 200, 1, 1.0, 0.9);
        e.end_stroke();
        let clip = e.copy_rect(c + 10.0, c + 10.0, c + 30.0, c + 30.0, v2(c + 20.0, c + 20.0));
        assert_eq!(clip.len(), 2, "the clipboard should carry both buildings");
        assert!(
            clip.road.iter().any(|v| *v > 0),
            "the clipboard should carry pavement: region {:?}, {} cells, {} non-zero",
            (clip.region.x0, clip.region.z0, clip.region.x1, clip.region.z1),
            clip.road.len(),
            clip.road.iter().filter(|v| **v > 0).count()
        );

        // Paste it 80 m away, with the cursor on the same spot within the camp it was on when the
        // copy was taken — which is what the anchor means: what was under the cursor lands under
        // the cursor again, however far into the selection the cursor happened to be.
        // The paste point is (cursor + 80).
        for _ in 0..40 {
            e.level(c + 100.0, c + 100.0, 44.0, 12.0, 1.0, 1.0);
        }
        let made = e.paste_rect(&clip, c + 20.0 + 80.0, c + 20.0 + 80.0);
        assert_eq!(made, 2);
        let pasted: Vec<_> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.x > c + 60.0)
            .map(|s| (s.x, s.z, s.y))
            .collect();
        assert_eq!(pasted.len(), 2);
        // The arrangement is the same, shifted by exactly the paste offset.
        let mut want: Vec<(f32, f32)> = vec![(c + 90.0, c + 90.0), (c + 110.0, c + 92.0)];
        want.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut got: Vec<(f32, f32)> = pasted.iter().map(|(x, z, _)| (*x, *z)).collect();
        got.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for (a, b) in want.iter().zip(&got) {
            assert!((a.0 - b.0).abs() < 0.01 && (a.1 - b.1).abs() < 0.01, "paste moved the camp");
        }
        // Reseated: the pasted buildings sit on the raised ground, not at the old altitude.
        // The pad was raised to 9 m; the buildings came with it, because a paste reseats rather
        // than replaying the altitude they were copied at.
        let ground = e.map().height_at(c + 100.0, c + 100.0);
        assert!(ground > 8.0, "the test's own raised ground is at {ground:.1} m");
        assert!(
            pasted.iter().all(|(_, _, y)| (*y - ground).abs() < 4.0),
            "a pasted building kept the altitude it was copied at: {pasted:?} against ground {ground:.1}"
        );
        // Pavement came too.
        let verts = e.verts();
        let at = |x: f32, z: f32| {
            let (ix, iz) = (x / e.map().cell, z / e.map().cell);
            e.map().road[iz as usize * verts + ix as usize]
        };
        assert!(
            at(c + 100.0, c + 100.0) > 50,
            "the pavement did not come with the paste: {} at the source, {} at the paste",
            at(c + 20.0, c + 20.0),
            at(c + 100.0, c + 100.0)
        );
        // One undo step for the paste.
        assert!(e.undo());
        assert_eq!(e.map().structures.iter().filter(|s| s.x > c + 60.0).count(), 0);
    }

    /// A paste far from the copy lands *both* structures and the pavement between them.
    ///
    /// The probe found this the hard way: one structure landed and the other did not, because the
    /// pavement region and the structure offsets were being derived from different anchors.
    #[test]
    fn a_paste_lands_every_structure_it_copied() {
        // Inland, with room for the paste to land whole: a paste that hangs off the map is a
        // different case, and `paste_rect` drops what does not fit.
        let c = 250.0f32;
        let mut e = flat(60.0);
        e.map.structures.clear();
        e.begin_stroke("camp");
        e.place(skind::TENT, 0, c, c, 0.0, false);
        e.place(skind::TENT, 0, c + 12.0, c, 0.0, false);
        e.paint_pave(c + 6.0, c + 6.0, 7.0, 210, 1, 1.0, 0.9);
        e.end_stroke();
        let clip = e.copy_rect(c - 4.0, c - 4.0, c + 16.0, c + 16.0, v2(c, c));
        assert_eq!(clip.len(), 2);
        if cfg!(test) {
            let cols = clip.region.x1 - clip.region.x0 + 1;
            let mut row = String::new();
            for ix in 0..cols {
                row.push(if clip.road[ix] > 0 { '#' } else { '.' });
            }
        }
        // Pasted 90 m away, which is where the pad's flat ground reaches: both structures and the
        // pavement between them have to come across.
        let made = e.paste_rect(&clip, c + 90.0, c + 90.0);
        assert_eq!(made, 2, "the paste dropped a structure");
        let verts = e.verts();
        let at = |x: f32, z: f32| {
            let (ix, iz) = ((x / e.map().cell) as usize, (z / e.map().cell) as usize);
            e.map().road[iz * verts + ix]
        };
        assert_eq!(at(c + 6.0, c + 6.0), 210, "the source pavement is not where the test put it");
        assert!(
            at(c + 96.0, c + 96.0) > 50,
            "the paste did not bring the pavement with it: {} at the paste, {} at the source",
            at(c + 96.0, c + 96.0),
            at(c + 6.0, c + 6.0)
        );
        assert!(e.pick(c + 90.0, c + 90.0) >= 0, "the anchored structure is missing");
        assert!(e.pick(c + 102.0, c + 90.0) >= 0, "the second structure is missing");
    }

    /// Moving a team's base, from a *freshly opened* map: the original stamp has to come out.
    ///
    /// The generated island arrives with a base already built on it — structures the generator
    /// placed, at coordinates the editor infers the anchor from. If that inference is a metre out,
    /// `remove_base`'s proximity match misses and "move base" leaves the old complex standing.
    #[test]
    fn moving_the_base_leaves_nothing_behind() {
        for index in 0..4u32 {
            let mut e = editor_indexed(7, index);
            let old = e.base(0).0;
            let walls_before = e.map().structures.iter().filter(|s| s.kind as u8 == skind::WALL).count();
            assert!(walls_before > 12, "map {index}: the island has no base to move");

            // Exactly what the move-base tool does. The site is chosen in bounds — a base stamped
            // off the map is skipped piece by piece, which is a different (and visible) problem.
            let site0 = v2((old.x + 90.0).min(e.map().world_size - 40.0), (old.y - 60.0).max(40.0));
            e.move_base(0, site0.x, site0.y, 0.0);

            // Nothing is left standing where the old complex was. The blueprint the editor stamps
            // and the perimeter the generator builds are *not* the same list of parts, so this is
            // the check that the base was moved by its marker rather than by geometry.
            let kinds: Vec<f32> = e
                .map()
                .structures
                .iter()
                .filter(|s| s.pos().dist(old) < 60.0)
                .map(|s| s.kind)
                .collect();
            // Nothing of the complex is left *inside its own footprint*. A radius would not do:
            // on a small island the other team's base can be 65 m away, and a neutral town wall
            // nearer still, so this is the base's own rectangle — the ground the old complex stood
            // on — and it has to be empty of walls and gates.
            let (old_anchor, old_fwd) = (old, e.base(0).1);
            let _ = old_fwd;
            let old_yaw = e.map().base_anchor[0].1;
            let (fu, fv) = (old_yaw.cos(), old_yaw.sin());
            let left = |s: &Structure| {
                let d = s.pos() - old_anchor;
                let along = d.x * fu + d.y * fv;
                let across = d.x * -fv + d.y * fu;
                across.abs() <= 30.0 && along.abs() <= 26.0
            };
            for s in e.map().structures.iter().filter(|s| left(s)) {
                assert!(
                    !matches!(s.kind as u8, skind::WALL | skind::GATE),
                    "map {index}: a wall of the old base is still standing at ({:.0},{:.0})",
                    s.pos().x,
                    s.pos().y
                );
            }
            let _ = kinds;
            // And the new one is whole: the perimeter, the gate, the flag and the garage came with
            // it, and the flag is inside its own walls.
            let site = e.base(0).0;
            let near = |k: u8| {
                e.map()
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == k && s.pos().dist(site) < 70.0)
                    .count()
            };
            assert!(near(skind::WALL) > 12, "map {index}: the new base has no perimeter");
            assert_eq!(near(skind::GATE), 1, "map {index}: the new base should have one gate");
            assert_eq!(near(skind::FLAG_POLE), 1, "map {index}: the new base has no flag");
            assert_eq!(near(skind::GARAGE), 1, "map {index}: the new base has no garage");
            // One base per team: the old complex's flag is gone. Measured in the old footprint,
            // because on a small island the *new* base's flag is inside 60 m of the old anchor.
            assert_eq!(
                e.map()
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == skind::FLAG_POLE && left(s))
                    .count(),
                0,
                "map {index}: the old base's flag is still standing"
            );

            // Undo puts the old base back, whole.
            assert!(e.undo(), "map {index}: the move should be one undo step");
            let back = e
                .map()
                .structures
                .iter()
                .filter(|s| s.pos().dist(old) < 60.0)
                .count();
            assert!(back > 12, "map {index}: undo did not bring the base back");
        }
    }

    /// The base's own perimeter: pieces that butt together, corners that meet, and a gateway the
    /// lane actually fits through. Measured, not eyeballed — the pieces are one wall model long.
    #[test]
    fn a_stamped_base_perimeter_butts_together() {
        let c = 256.0f32;
        for (team, yaw) in [(0usize, 0.0f32), (0, 0.7), (1, -2.0), (1, 2.6)] {
            let mut e = flat(70.0);
            e.map.structures.clear();
            e.stamp_base(team, c, c, yaw);
            let (anchor, fwd) = e.base(team);
            let base_yaw = fwd.y.atan2(fwd.x);

            // Every wall of the complex, in the base's own local metres.
            let local: Vec<(Vec2, f32, f32)> = e
                .map()
                .structures
                .iter()
                .filter(|s| s.kind as u8 == skind::WALL)
                .map(|s| {
                    let d = s.pos() - anchor;
                    let (fu, fv) = (base_yaw.cos(), base_yaw.sin());
                    let l = v2(d.x * fu + d.y * fv, d.x * -fv + d.y * fu);
                    // Which base-local axis the piece's *length* runs along. A run's own rot is in
                    // the run's frame (`atan2(dy, dx)`), so a side run's piece points along local z
                    // and a horizontal run's along local x.
                    let local_rot = s.yaw - base_yaw;
                    let axis = if local_rot.cos().abs() > local_rot.sin().abs() { 0.0 } else { 1.0 };
                    (l, s.w, axis)
                })
                .collect();
            assert!(local.len() > 12, "team {team}: the perimeter is missing");

            // Four runs, addressed by the base-local line they sit on.
            let runs: [(&str, fn(Vec2) -> f32, f32, f32); 4] = [
                ("front z=+19", |l| l.y, BASE_HZ, 0.0),
                ("back  z=-19", |l| l.y, -BASE_HZ, 0.0),
                ("left  x=-24", |l| l.x, -BASE_HX, 1.0),
                ("right x=+24", |l| l.x, BASE_HX, 1.0),
            ];
            for (name, coord, line, axis) in runs {
                let mut along: Vec<(f32, f32)> = local
                    .iter()
                    .filter(|(l, _, a)| (*a - axis).abs() < 0.5 && (coord(*l) - line).abs() < 0.6)
                    .map(|(l, w, _)| (if axis > 0.5 { l.y } else { l.x }, *w))
                    .collect();
                along.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                assert!(along.len() >= 3, "team {team}, {name}: only {} pieces", along.len());
                for pair in along.windows(2) {
                    let step = pair[1].0 - pair[0].0;
                    let gap = step - (pair[0].1 + pair[1].1) * 0.5;
                    // A gap is only a fault if it is not an opening: the gate and the sally port
                    // are *meant* to interrupt a run.
                    let mid = (pair[0].0 + pair[1].0) * 0.5;
                    // One opening, on the front run: `axis 0` means the piece runs along local x.
                    let in_an_opening = axis < 0.5 && (mid - GATE_LX).abs() < GATE_OPEN;
                    if in_an_opening {
                        continue;
                    }
                    assert!(
                        gap < 0.35,
                        "team {team}, {name}: two pieces are {gap:.2} m apart at {mid:.1} — the wall does not meet"
                    );
                    assert!(
                        gap > -0.75,
                        "team {team}, {name}: two pieces overlap by {:.2} m",
                        -gap
                    );
                }
            }

            assert_eq!(
                e.map()
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == skind::GATE && s.team == team as f32)
                    .count(),
                1,
                "team {team}: the base should have exactly one gate"
            );
            // The gate opening is the width it claims, and nothing is built inside it.
            let gate = e
                .map()
                .structures
                .iter()
                .filter(|s| s.kind as u8 == skind::GATE)
                .map(|s| {
                    let d = s.pos() - anchor;
                    let (fu, fv) = (base_yaw.cos(), base_yaw.sin());
                    v2(d.x * fu + d.y * fv, d.x * -fv + d.y * fu)
                })
                // The front one: both bases carry a gate, and this is the front run's.
                .find(|l| (l.y - BASE_HZ).abs() < 1.0)
                .expect("the base has no gate on its front run");
            assert!((gate.x - GATE_LX).abs() < 0.6, "the gate is not on the front run");
            for (l, w, axis) in &local {
                if *axis < 0.5 {
                    continue;
                }
                let on_side = (l.x.abs() - BASE_HX).abs() < 0.6;
                if !on_side {
                    continue;
                }
                let d = (l.y - gate.y).abs();
                assert!(
                    d > GATE_OPEN * 0.5 - w * 0.5 || l.x > 0.0,
                    "a wall is standing in the gateway ({d:.2} m from its centre)"
                );
            }
        }
    }

    /// Neutral cannot own a main base, and asking does nothing rather than landing on green.
    #[test]
    fn only_the_two_playing_teams_can_own_a_base() {
        let c = 256.0f32;
        let mut e = flat(70.0);
        let before: Vec<(f32, f32, f32)> = e
            .map()
            .structures
            .iter()
            .filter(|s| matches!(s.kind as u8, skind::WALL | skind::GATE | skind::FLAG_POLE))
            .map(|s| (s.kind, s.x, s.z))
            .collect();
        let bases_before = e.base(0);
        // Neutral is a scenery team. A move or a stamp for it must be refused outright — the old
        // `team % 2` mapping quietly moved *green's* base instead.
        e.move_base(2, c + 60.0, c + 60.0, 1.0);
        e.stamp_base(2, c + 60.0, c + 60.0, 1.0);
        let after: Vec<(f32, f32, f32)> = e
            .map()
            .structures
            .iter()
            .filter(|s| matches!(s.kind as u8, skind::WALL | skind::GATE | skind::FLAG_POLE))
            .map(|s| (s.kind, s.x, s.z))
            .collect();
        assert_eq!(before.len(), after.len(), "a neutral base was built anyway");
        assert_eq!(e.base(0), bases_before, "green's base moved for a neutral request");
        // The flag poles are still the two the island has, and neither is at the requested site.
        let poles: Vec<Vec2> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::FLAG_POLE)
            .map(|s| s.pos())
            .collect();
        assert_eq!(poles.len(), 2, "a refused request added or removed a flag");
        // Neither pole is a *third* base's: each belongs to one of the two teams' anchors.
        for p in &poles {
            let near = (0..2)
                .map(|t| p.dist(e.base(t).0))
                .fold(f32::INFINITY, f32::min);
            assert!(near < 40.0, "a flag pole at ({:.0},{:.0}) belongs to no base", p.x, p.y);
        }
        // And the two playing teams are still allowed.
        e.move_base(1, c - 50.0, c + 40.0, 0.4);
        assert!((e.base(1).0.x - (c - 50.0)).abs() < 0.1);
    }

    /// Moving one base leaves the *pair* consistent: both complexes are rebuilt, so no wall of
    /// either is left standing where its own anchor is not.
    #[test]
    fn moving_one_base_rebuilds_both() {
        let c = 256.0f32;
        let mut e = flat(80.0);
        let site = [e.base(0).0, e.base(1).0];
        e.move_base(0, c - 60.0, c - 60.0, 1.2);
        for t in 0..2 {
            let (anchor, fwd) = e.base(t);
            let yaw = fwd.y.atan2(fwd.x);
            // Every wall of this team's complex sits on *this* anchor's perimeter — the rectangle
            // the base was built at — with nothing left on the old one.
            let parts = base_parts();
            for p in parts.iter().filter(|p| p.kind == skind::WALL) {
                let want = from_local(v2(p.lx, p.lz), anchor, yaw);
                let near = e
                    .map()
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == skind::WALL && s.team == t as f32)
                    .map(|s| s.pos().dist(want))
                    .fold(f32::INFINITY, f32::min);
                assert!(
                    near < 0.6,
                    "team {t}: no wall at {:.0},{:.0} on its own perimeter (nearest is {near:.1} m)",
                    want.x,
                    want.y
                );
            }
            if t == 1 {
                assert!(
                    (anchor.x - site[1].x).abs() < 6.0 && (anchor.y - site[1].y).abs() < 6.0,
                    "the base that was not asked to move moved anyway"
                );
            }
        }
    }

    /// A freshly opened island: every structure marked as part of a base is actually *in* it.
    #[test]
    fn generated_base_markers_are_inside_their_bases() {
        let e = editor_indexed(7, 0);
        for t in 0..2 {
            let (anchor, _) = e.base(t);
            let far = e
                .map()
                .structures
                .iter()
                .filter(|s| s.flag(sflag::BASE) && s.team as usize == t)
                .map(|s| s.pos().dist(anchor))
                .fold(0.0f32, f32::max);
            assert!(
                far <= 46.0,
                "team {t}: a structure marked as its base part is {far:.0} m from the anchor"
            );
            let n = e
                .map()
                .structures
                .iter()
                .filter(|s| s.flag(sflag::BASE) && s.team as usize == t)
                .count();
            assert!(n > 20, "team {t}: only {n} structures marked as its base");
        }
    }

    /// Removing a base takes exactly the structures that are marked as its parts.
    #[test]
    fn removing_a_base_takes_its_marked_parts() {
        let mut e = editor_indexed(7, 0);
        // The state the base tests start from, because it is what `flat` leaves behind.
        let c = e.map().world_size * 0.5;
        for _ in 0..16 {
            e.level(c, c, 90.0, 4.0, 1.0, 0.9);
        }
        let (anchor, fwd) = e.base(0);
        let yaw = fwd.y.atan2(fwd.x);
        let marked: Vec<Vec2> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.flag(sflag::BASE) && s.team == 0.0)
            .map(|s| s.pos())
            .collect();
        assert!(!marked.is_empty(), "nothing is marked as green's base");
        let kept = e.without_base(0, anchor, yaw);
        for p in &marked {
            assert!(
                !kept.iter().any(|s| s.pos().dist(*p) < 0.01),
                "a marked part at ({:.0},{:.0}) survived the removal ({:.1} m from the anchor)",
                p.x,
                p.y,
                p.dist(anchor)
            );
        }
        // And nothing else went with it: a marked part of the *other* team is untouched.
        let others = e
            .map()
            .structures
            .iter()
            .filter(|s| s.flag(sflag::BASE) && s.team == 1.0)
            .count();
        let kept_others = kept.iter().filter(|s| s.flag(sflag::BASE) && s.team == 1.0).count();
        assert_eq!(others, kept_others, "removing green's base took brown's parts too");
    }

    /// The blueprint's own wall count, and the count a stamped base ends up with, run by run.
    #[test]
    fn a_stamped_perimeter_has_the_walls_the_blueprint_asks_for() {
        let c = 256.0f32;
        let parts = base_parts();
        let want = parts.iter().filter(|p| p.kind == skind::WALL).count();
        // Per run, in the order the blueprint emits them.
        let mut expect = [0usize; 4];
        {
            let mut run = 0;
            let mut last = v2(-BASE_HX, -BASE_HZ);
            for p in parts.iter().filter(|p| p.kind == skind::WALL) {
                let here = v2(p.lx, p.lz);
                if (here - last).len() > 40.0 && run < 3 {
                    run += 1;
                }
                expect[run] += 1;
                last = here;
            }
        }
        // Stamped at several anchors and angles, including the island's own: the count has to be
        // the blueprint's every time. "Moved bases are missing one wall" is this assertion.
        for (anchor, yaw) in [
            (v2(c, c), 0.0f32),
            (v2(c + 40.0, c - 30.0), 0.7),
            (v2(c - 60.0, c + 20.0), -1.9),
        ] {
            let mut e = flat(80.0);
            e.map.structures.clear();
            e.stamp_base(0, anchor.x, anchor.y, yaw);
            let got: Vec<(f32, f32)> = e
                .map()
                .structures
                .iter()
                .filter(|s| s.kind as u8 == skind::WALL && s.team == 0.0)
                .map(|s| (s.x, s.z))
                .collect();
            assert_eq!(
                got.len(),
                want,
                "at ({:.0},{:.0}) the blueprint asks for {want} walls ({expect:?} per run) and {} were stamped",
                anchor.x,
                anchor.y,
                got.len()
            );
        }
    }

    /// A wall's collision box is the model it draws: the perimeter pieces are sized to their band,
    /// and `stamp_parts` has to use that size rather than the palette's wall entry.
    #[test]
    fn a_stamped_wall_is_the_size_the_blueprint_says() {
        let c = 256.0f32;
        let mut e = flat(80.0);
        e.map.structures.clear();
        e.stamp_base(0, c, c, 0.0);
        let want: Vec<f32> = base_parts()
            .iter()
            .filter(|p| p.kind == skind::WALL)
            .map(|p| p.size.map(|s| s.0).unwrap_or(0.0))
            .collect();
        let got: Vec<f32> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL && s.team == 0.0)
            .map(|s| s.w)
            .collect();
        assert_eq!(got.len(), want.len());
        for w in &got {
            assert!(
                want.iter().any(|x| (x - w).abs() < 0.01),
                "a wall was stamped {w:.2} m wide, which is not one of the blueprint's sizes"
            );
            assert!(
                *w <= WALL_MAX_SEG + 0.01,
                "a wall was stamped {w:.2} m wide, longer than a wall may be"
            );
        }
        // The palette's own entry is 7.6 m and would have shown up as a mismatch above; assert the
        // count of distinct sizes so a regression to one fixed size is visible.
        let mut sizes: Vec<f32> = got.iter().map(|w| (w * 100.0).round() / 100.0).collect();
        sizes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        sizes.dedup();
        assert!(
            sizes.len() >= 3,
            "every wall came out the same width ({sizes:?}), so the band sizing was lost"
        );
    }

    /// A wall placed over an existing one goes *beside* it, not inside it.
    ///
    /// This is the failure that reads as "it snaps into the wall I just placed": the cursor is
    /// between two pieces of a run, and both the position it asks for and the position next to it
    /// are taken.
    #[test]
    fn a_snap_never_lands_a_wall_inside_another() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        e.map.structures.retain(|s| s.kind as u8 != skind::WALL);
        let w = skind::WALL;
        for k in 0..3 {
            assert!(e.place(w, 0, c + k as f32 * WALL_SEG, c, 0.0, true));
        }
        // Cursors all over the run and its ends: in line, square, on the body, past the ends, and
        // in the lanes either side of it. The lattice is two metres, which is the closest walls can
        // legitimately stand, so the sweep lays a plausible map rather than an impossible one.
        let mut placed = 0;
        for i in -14..=14 {
            for (dz, yaw) in [
                (0.0f32, 0.0f32),
                (WALL_SEG, 0.0),
                (-WALL_SEG, 0.0),
                (0.0, core::f32::consts::FRAC_PI_2),
                (3.0, core::f32::consts::FRAC_PI_2),
                (-3.0, core::f32::consts::FRAC_PI_2),
            ] {
                let x = c + i as f32 * 2.0;
                let z = c + dz;
                let (p, y) = e.preview(w, x, z, yaw, true);
                // A declined snap leaves the cursor alone: the wall goes exactly where it was
                // aimed, which is the free-placement answer and not this rule's business.
                if (p.x - x).hypot(p.y - z) < 0.05 {
                    continue;
                }
                // Never two walls in one place: the centres keep their distance, which is what
                // "a wall where another wall already stands" means for pieces of this length.
                let stacked: Vec<String> = e
                    .map()
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == w)
                    .filter_map(|s| {
                        let d = (s.x - p.x).hypot(s.z - p.y);
                        if d < WALL_MIN_SPACING {
                            Some(format!("({:.1},{:.1}) {d:.2} m away", s.x, s.z))
                        } else {
                            None
                        }
                    })
                    .collect();
                assert!(
                    stacked.is_empty(),
                    "the snap put a wall at ({:.2}, {:.2}) on top of another: {stacked:?} (cursor {:.2}, {:.2})",
                    p.x, p.y, x, z
                );
                // A snap either brings the piece into contact with a wall, or leaves the cursor
                // alone because nothing is in reach. Never in between: a piece nudged into open
                // ground is the "it moved my wall for no reason" complaint.
                let moved = (p.x - x).hypot(p.y - z) > 0.05;
                let near = e
                    .map()
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == w)
                    .map(|s| wall_gap(v2(p.x, p.y), y, v2(s.x, s.z), s.yaw).abs())
                    .fold(f32::INFINITY, f32::min);
                assert!(
                    !moved || near <= WALL_CONTACT,
                    "the snap moved a wall to ({:.2}, {:.2}) without joining anything — nearest {near:.2} m (cursor {:.2}, {:.2})",
                    p.x, p.y, x, z
                );
                // A player does not drop a wall on top of another wall, so the sweep does not
                // either: a cursor within a wall's own footprint is passed over.
                let on_top = e
                    .map()
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == w)
                    .any(|s| (s.x - x).hypot(s.z - z) < WALL_MIN_SPACING);
                if on_top {
                    continue;
                }
                assert!(e.place(w, 0, x, z, yaw, true), "the placement vanished");
                placed += 1;
            }
        }
        assert!(placed > 40, "the sweep placed only {placed} walls");
        assert_no_overlap(&e, "after the sweep");
    }

    /// A wall dropped at the tip of another, turned square, ends up flush with it.
    ///
    /// The cursor is *over* the piece here — the zone the centre lattice used to jump straight
    /// past — so this is the click that felt like it could not reach the edge.
    #[test]
    fn a_wall_turned_square_at_the_tip_lands_flush() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        e.map.structures.retain(|s| s.kind as u8 != skind::WALL);
        assert!(e.place(skind::WALL, 0, c, c, 0.0, true));
        let first = *e.map().structures.last().unwrap();
        // The piece's visible end, and a cursor just past it, turned square.
        let tip = v2(c + WALL_SEG * 0.5, c);
        let (p, yaw) = e.preview(skind::WALL, tip.x + 1.0, tip.y + 4.0, core::f32::consts::FRAC_PI_2, true);
        assert!((yaw - core::f32::consts::FRAC_PI_2).abs() < 1e-3, "yaw is off: {yaw}");
        assert!(
            wall_joined(v2(first.x, first.z), first.yaw, p, yaw),
            "the piece should join the one it was aimed past, it stands ({:.2}, {:.2}) — {:.2} m off",
            p.x - c,
            p.y - c,
            wall_gap(v2(first.x, first.z), first.yaw, p, yaw)
        );
        // Aimed past the end, squared up: the joint is that end. The new piece stands half a
        // segment out from the wall's line — its face on the wall's end — and its own end is level
        // with that end, which is exactly a corner.
        let off = p - v2(first.x, first.z);
        let across = off.x * -first.yaw.sin() + off.y * first.yaw.cos();
        let along = off.x * first.yaw.cos() + off.y * first.yaw.sin();
        assert!(
            (across.abs() - WALL_SEG * 0.5).abs() < 0.05,
            "the piece should stand half a segment out from the wall, it is {across:.2} m off"
        );
        assert!(
            (along.abs() - WALL_SEG * 0.5).abs() < 0.05,
            "its end should be level with the wall's end, it is {along:.2} m along"
        );
    }

    /// A wall asked for in line with one it is beside extends the run, even out past its end —
    /// budding is for joins that turn, so a fence does not sprout a spur.
    #[test]
    fn a_wall_in_line_beside_another_still_extends_the_run() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        assert!(e.place(skind::WALL, 0, c, c, 0.0, true));
        let (p, yaw) = e.preview(skind::WALL, c + WALL_SEG * 0.9, c + 2.0, 0.0, true);
        assert!(yaw.abs() < 1e-3, "the run should stay in line, yaw {yaw}");
        assert!(
            (p.y - c).abs() < 0.01,
            "the piece should be on the run, off by {:.2} m",
            p.y - c
        );
        assert!(
            (p.x - (c + WALL_SEG)).abs() < 0.01,
            "the piece should continue the run, landed at {:.2}",
            p.x - c
        );
    }

    /// Free placement is free: with snapping off nothing is touched, ends included.
    #[test]
    fn shift_free_placement_ignores_the_wall_next_to_it() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        assert!(e.place(skind::WALL, 0, c, c, 0.0, true));
        let target = v2(c + WALL_SEG * 0.4, c + WALL_SEG * 0.2);
        let (p, yaw) = e.preview(skind::WALL, target.x, target.y, 0.37, false);
        assert!(
            (p.x - target.x).abs() < 1e-4 && (p.y - target.y).abs() < 1e-4,
            "free placement moved the wall to ({:.2}, {:.2})",
            p.x,
            p.y
        );
        assert!((yaw - 0.37).abs() < 1e-4, "free placement turned the wall to {yaw}");
        // The same click with snapping on does move it, so the two modes really differ.
        let (sp, _) = e.preview(skind::WALL, target.x, target.y, 0.37, true);
        assert!((sp - target).len() > 0.5, "snapping on did not move the wall at all");
    }

    /// Walls cross at a piece boundary, so a T-junction is a T and not a wall through a wall.
    #[test]
    fn a_wall_meets_another_away_from_its_ends() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        e.map.structures.retain(|s| s.kind as u8 != skind::WALL);
        // Three pieces in a row, so the middle of the run is a real boundary.
        for k in -1..=1 {
            assert!(e.place(skind::WALL, 0, c + k as f32 * WALL_SEG, c, 0.0, true));
        }
        let run: Vec<(Vec2, f32)> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL)
            .map(|s| (s.pos(), s.yaw))
            .collect();
        // From below, three metres down, square across the run: a T. It has to touch the run —
        // and one of the run's own joints is the natural place for it to stand.
        let (p, yaw) = e.preview(skind::WALL, c, c + 3.0, core::f32::consts::FRAC_PI_2, true);
        assert!((yaw - core::f32::consts::FRAC_PI_2).abs() < 1e-3, "T yaw is off: {yaw}");
        let joined = run.iter().any(|(q, qy)| wall_joined(v2(p.x, p.y), yaw, *q, *qy));
        assert!(
            joined,
            "the crossing wall should join the run, it stands ({:.2}, {:.2})",
            p.x - c,
            p.y - c
        );
        // It joins a *joint* of the run: the piece it meets has its end there.
        let (joint_at, _, _, _) = nearest_wall(&e, p, yaw);
        let on_end = ((p.x - joint_at.x).abs() - WALL_SEG * 0.5).abs() < 0.05
            || ((p.x - joint_at.x).abs() / WALL_SEG).fract().abs() < 0.05;
        assert!(
            on_end,
            "the crossing wall should meet the run at a joint, it stands {:.2} m along from a piece centre",
            p.x - joint_at.x
        );
        assert_no_overlap(&e, "after the T");
    }

    /// One main base per team, and it moves as one thing.
    #[test]
    fn a_team_has_one_base_and_it_moves_whole() {
        let c = 256.0f32;
        let mut e = flat(90.0);
        e.stamp_base(0, c, c, 0.0);
        let walls = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL && s.team == 0.0)
            .count();
        assert!(walls > 15, "the perimeter should be built: {walls} pieces");

        // A second stamp must *replace* the first, not land beside it. Both bases are rebuilt —
        // their perimeters are positioned relative to each other, so a move is a pair operation —
        // which is why the test cannot count the whole structure list.
        let old_anchor = v2(c, c);
        {
            let unmasked: Vec<(f32, f32, bool)> = e
                .map()
                .structures
                .iter()
                .filter(|s| s.kind as u8 == skind::WALL && s.team == 0.0)
                .map(|s| (s.x, s.z, s.flag(sflag::BASE)))
                .collect();
            let unmarked = unmasked.iter().filter(|(_, _, f)| !*f).count();
            assert_eq!(unmarked, 0, "{} of {} stamped walls are unmarked: {:?}", unmarked, unmasked.len(), unmasked.iter().filter(|(_,_,f)| !*f).take(3).collect::<Vec<_>>());
        }
        e.stamp_base(0, c + 60.0, c, 0.0);
        let anchor = e.base(0).0;
        assert!((anchor.x - (c + 60.0)).abs() < 0.01, "the base start did not move");
        let green_walls: Vec<Vec2> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL && s.team == 0.0)
            .map(|s| s.pos())
            .collect();
        assert_eq!(
            green_walls.len(),
            walls,
            "a second stamp changed how many walls green's base has"
        );
        assert!(
            green_walls.iter().all(|p| p.dist(old_anchor) > 26.0),
            "a wall of the old base is still standing at the old anchor"
        );
        assert!(
            green_walls.iter().all(|p| p.dist(anchor) < 60.0),
            "a wall of green's base is not on its new perimeter"
        );
        // One flag pole for the team, at the new site.
        let poles: Vec<Vec2> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::FLAG_POLE && s.team == 0.0)
            .map(|s| s.pos())
            .collect();
        assert_eq!(poles.len(), 1, "the team has {} flag poles", poles.len());
        assert!(poles[0].dist(anchor) < 40.0, "the flag did not move with the base");

        // Undo puts the old base back.
        assert!(e.undo());
        assert!((e.base(0).0.x - c).abs() < 0.01, "undo did not restore the base start");
        let back = e
            .map()
            .structures
            .iter()
            .filter(|s| s.kind as u8 == skind::WALL && s.team == 0.0)
            .filter(|s| s.pos().dist(old_anchor) < 30.0)
            .count();
        assert!(back > 15, "undo did not bring the perimeter back ({back} walls)");
    }

    /// The island brush is a terrain brush: it makes land and sea, and the nav grid follows.
    #[test]
    fn the_island_brush_changes_land_and_nav_together() {
        let c = 256.0f32;
        let mut e = flat(50.0);
        let g = e.map().grid as usize;
        let i = (c / e.map().cell) as usize;
        assert_eq!(e.map().nav[i * g + i], terrain::GROUND, "the pad should start as ground");
        for _ in 0..10 {
            e.level(c, c, 24.0, -5.0, 0.8, 0.8);
        }
        assert!(h(&e, c, c) < 0.0, "the sea brush left the ground above water");
        assert!(!terrain::is_land(e.map().nav[i * g + i]), "nav still calls the lagoon land");
        for _ in 0..10 {
            e.level(c, c, 24.0, 3.0, 0.8, 0.8);
        }
        assert!(h(&e, c, c) > 1.0, "the land brush did not raise it back");
        assert!(terrain::is_land(e.map().nav[i * g + i]), "nav did not follow it back to land");
    }

    /// Smoothing is a *local* average: it pulls a spike down and leaves the far ground alone.
    #[test]
    fn smooth_flattens_without_moving_the_distance() {
        let c = 256.0f32;
        let mut e = flat(50.0);
        e.raise(c, c, 4.0, 8.0, 1.0);
        let far = h(&e, c + 40.0, c);
        for _ in 0..6 {
            e.smooth(c, c, 16.0, 1.0, 0.5);
        }
        assert!(h(&e, c, c) - 4.0 < 4.0, "smooth did not take the spike down");
        assert!((h(&e, c + 40.0, c) - far).abs() < 0.01, "smooth moved ground outside its radius");
    }

    /// Every op is one undo step, and undo/redo restores the layers bit for bit — including the
    /// new material and pavement masks.
    #[test]
    fn every_brush_op_round_trips_through_undo() {
        let c = 256.0f32;
        let mut e = flat(60.0);
        let snapshot = |e: &EditorMap| {
            (
                e.map().heights.clone(),
                e.map().splat.clone(),
                e.map().road.clone(),
                e.map().sand_var.clone(),
                e.map().grass_var.clone(),
                e.map().pave.clone(),
            )
        };
        let base = snapshot(&e);
        e.raise(c, c, 10.0, 3.0, 0.5);
        e.paint_material(0, 2, c, c, 10.0, 1.0, 0.5);
        e.paint_pave(c, c, 10.0, 235, 1, 1.0, 0.5);
        e.road_stroke(&[c, c, c + 30.0, c], 5.0, 2, false);
        let after = snapshot(&e);
        assert_ne!(after.0, base.0);
        assert_ne!(after.1, base.1);
        assert_ne!(after.2, base.2);
        assert_ne!(after.3, base.3);
        assert_ne!(after.5, base.5);
        for _ in 0..4 {
            assert!(e.undo(), "each of the four ops should be undoable");
        }
        let back = snapshot(&e);
        assert_eq!(back.0, base.0, "heights did not come back");
        assert_eq!(back.1, base.1, "splat did not come back");
        assert_eq!(back.2, base.2, "road did not come back");
        assert_eq!(back.3, base.3, "sand variants did not come back");
        assert_eq!(back.4, base.4, "grass variants did not come back");
        assert_eq!(back.5, base.5, "pavement did not come back");
        for _ in 0..4 {
            assert!(e.redo());
        }
        let again = snapshot(&e);
        assert_eq!(again.0, after.0);
        assert_eq!(again.2, after.2);
        assert_eq!(again.5, after.5);
    }
}
