//! Navigation: coarse-grid flow fields used by the AI drivers (and the flag-radar HUD).
//!
//! Each field is a breadth-first distance transform from one goal cell over the 128x128 nav
//! grid; sampling it gives a "which way should I point" vector in O(1). Fields are rebuilt on
//! a stagger so the per-frame cost stays flat.

use crate::math::{v2, Vec2};
use crate::types::{terrain, MapData};
use crate::world::World;

pub const DIRS: [(i32, i32); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];

pub mod pass {
    pub const LAND: u8 = 0;
    pub const AMPHIBIOUS: u8 = 1;
    pub const AIR: u8 = 2;
}

#[derive(Clone)]
pub struct FlowField {
    pub dist: Vec<u16>,
    pub dir: Vec<u8>,
    pub goal: Vec2,
    pub valid: bool,
    pub stamp: f32,
    /// Scratch BFS queue, kept between rebuilds: a 256x256 grid holds ~50k cells, and
    /// allocating (and zeroing) that on every rebuild is pure waste.
    queue: Vec<u32>,
    /// Base passability ("can a point sit here?"), one byte per cell, filled once per
    /// `build`. Every later stage asks that question — the width mask five times per cell,
    /// each BFS up to eight times per visited cell — and recomputing the terrain class per
    /// edge was most of the rebuild cost. Reading a precomputed byte instead cut the big-map
    /// LAND rebuild roughly in half (see `examples/simbench.rs`). Kept between rebuilds for
    /// the same reason as `queue`. Not filled for AIR (everything is passable there).
    base: Vec<u8>,
    /// Memoised width-aware LAND clearance, one byte per cell (0 = a hull cannot sit here).
    /// Filled once per `build` from `base`; the BFS then reads a byte instead of re-running
    /// the width rule. Kept between rebuilds for the same reason as `queue`.
    wide: Vec<u8>,
    /// Width-blind recovery distances for cells the wide route excludes (see the fallback in
    /// [`FlowField::build`]). One `u16` per cell, kept between rebuilds.
    esc: Vec<u16>,
}

impl FlowField {
    pub fn new() -> FlowField {
        FlowField {
            // Sized in `build`, from the map: a field belongs to one world and the world's
            // size is a runtime choice, so there is no compile-time grid to allocate against.
            dist: Vec::new(),
            dir: Vec::new(),
            goal: Vec2::ZERO,
            valid: false,
            stamp: 0.0,
            queue: Vec::new(),
            base: Vec::new(),
            wide: Vec::new(),
            esc: Vec::new(),
        }
    }

    pub fn build(&mut self, map: &MapData, blocked: &[bool], goal: Vec2, mode: u8) {
        self.goal = goal;
        self.valid = false;
        let g = map.grid as i32;
        // `resize` keeps the allocation across rebuilds of the same world, which matters: these
        // buffers are half a megabyte on the big map and the field is rebuilt regularly.
        let n = (g * g) as usize;
        if self.dist.len() != n {
            self.dist.resize(n, u16::MAX);
            self.dir.resize(n, 8);
            self.base.resize(n, 0);
            self.wide.resize(n, 0);
            self.esc.resize(n, u16::MAX);
            self.queue.clear();
        }
        let cell = map.cell;
        let gi = ((goal.x / cell).floor() as i32).clamp(0, g - 1);
        let gj = ((goal.y / cell).floor() as i32).clamp(0, g - 1);
        // If the goal itself is not passable (flag on a pier, player over water...), find the
        // nearest passable cell so the field is still useful.
        let start = match nearest_passable(map, blocked, gi, gj, mode) {
            Some((x, y)) => (x, y),
            None => {
                self.dist.iter_mut().for_each(|d| *d = u16::MAX);
                self.dir.iter_mut().for_each(|d| *d = 8);
                return;
            }
        };

        self.dist.iter_mut().for_each(|d| *d = u16::MAX);
        self.dir.iter_mut().for_each(|d| *d = 8);
        // Base passability ("can a point sit here?") as one byte per cell, filled once. The
        // width mask below asks it five times per cell and both BFSes up to eight times per
        // visited cell; recomputing the terrain class at every edge was most of the rebuild
        // cost. AIR skips the fill entirely: everything is passable in the air.
        let air = mode == pass::AIR;
        let mut base = core::mem::take(&mut self.base);
        if !air {
            for (i, b) in base.iter_mut().enumerate() {
                *b = base_passable(map, blocked, i, mode) as u8;
            }
        }
        // Land hulls route on the width-aware mask; air and amphibious hulls use the raw
        // terrain test directly (a jeep fits anywhere it can float). The rule below is
        // identical to `cell_passable`, just reading the precomputed bytes instead of
        // re-testing terrain at every edge.
        let wide = mode == pass::LAND;
        let mut mask = core::mem::take(&mut self.wide);
        if wide {
            for (i, m) in mask.iter_mut().enumerate() {
                *m = wide_from_base(&base, &map.nav, g, i) as u8;
            }
        }
        let passable = |idx: usize| -> bool {
            if wide {
                mask[idx] != 0
            } else if air {
                true
            } else {
                base[idx] != 0
            }
        };
        let mut queue = core::mem::take(&mut self.queue);
        queue.clear();
        let si = (start.1 * g + start.0) as usize;
        self.dist[si] = 0;
        queue.push(si as u32);
        let mut head = 0usize;
        while head < queue.len() {
            let cur = queue[head] as usize;
            head += 1;
            let cx = (cur as i32) % g;
            let cz = (cur as i32) / g;
            let d = self.dist[cur];
            for (di, (dx, dz)) in DIRS.iter().enumerate() {
                let nx = cx + dx;
                let nz = cz + dz;
                if nx < 0 || nz < 0 || nx >= g || nz >= g {
                    continue;
                }
                let ni = (nz * g + nx) as usize;
                if self.dist[ni] != u16::MAX {
                    continue;
                }
                if !passable(ni) {
                    continue;
                }
                // Do not cut corners between two blocked diagonals.
                if *dx != 0 && *dz != 0 {
                    let a = (cz * g + nx) as usize;
                    let b = (nz * g + cx) as usize;
                    if !passable(a) || !passable(b) {
                        continue;
                    }
                }
                // Uniform-cost BFS. A clearance penalty was tried here and made things
                // worse: it steered drivers away from narrow bridge decks and into the
                // waterline, so lanes stay equally cheap.
                self.dist[ni] = d.saturating_add(if *dx != 0 && *dz != 0 { 14 } else { 10 });
                let _ = di;
                queue.push(ni as u32);
            }
        }
        // Remember which cells the width-aware route actually reached. `mask` has done its
        // job as the BFS passability test; from here it is the routed/off-route flag. Water and
        // air fields have no width rule and no fallback, so they skip this pass entirely.
        let mut stranded = 0usize;
        if wide {
            for i in 0..mask.len() {
                mask[i] = (mask[i] != 0 && self.dist[i] != u16::MAX) as u8;
                // A base-passable cell the wide route never reached is a cell a hull could be
                // standing on with no route — exactly what the fallback below exists for. If
                // there are none, BFS2 and its merge would compute distances nobody reads.
                if base[i] != 0 && self.dist[i] == u16::MAX {
                    stranded += 1;
                }
            }
        }
        // Recovery fallback for cells the wide route excludes.
        //
        // The width rule can exclude a cell a hull is *standing on* - map 2 "Iron Strait"
        // seed 99 spawns its team-0 tank on a pad cell with only two open cardinal sides, and
        // with no fallback the whole LAND field reads infinite there, `ai.rs` takes the HOLD
        // branch and the tank never leaves its own spawn (measured: closest 166 m for the
        // whole 180 s). The same happens to a hull that drifts into an excluded cell.
        //
        // So cells the wide route does not reach fall back to the ordinary, width-blind field,
        // computed here (BFS2) into `esc`. The two-tier direction pass below keeps it strictly
        // separate: a routed cell only ever steers at another routed cell, so the fallback can
        // never turn a narrow slot back into a chosen route. Its only job is to keep an
        // already-excluded hull pointing at the goal instead of holding. `FALLBACK_BASE` keeps
        // the nominal cost above every real route cost (so `use_swim`'s comparison still
        // prefers water for a stranded amphibian) while staying finite, which is all
        // `ai.rs`'s route test needs.
        const FALLBACK_BASE: u16 = 20_000;
        let mut esc = core::mem::take(&mut self.esc);
        // `stranded == 0` means every base-passable cell is routed, so BFS2 would reach only
        // cells the merge never reads (routed cells keep `mask != 0`) — skip it and its reset.
        if wide && stranded > 0 {
            esc.iter_mut().for_each(|e| *e = u16::MAX);
            queue.clear();
            let si = (start.1 * g + start.0) as usize;
            esc[si] = 0;
            queue.push(si as u32);
            let mut head = 0usize;
            while head < queue.len() {
                let cur = queue[head] as usize;
                head += 1;
                let e = esc[cur];
                let cx = (cur as i32) % g;
                let cz = (cur as i32) / g;
                for (dx, dz) in DIRS.iter() {
                    let nx = cx + dx;
                    let nz = cz + dz;
                    if nx < 0 || nz < 0 || nx >= g || nz >= g {
                        continue;
                    }
                    let ni = (nz * g + nx) as usize;
                    if esc[ni] != u16::MAX {
                        continue;
                    }
                    if base[ni] == 0 {
                        continue;
                    }
                    if *dx != 0 && *dz != 0 {
                        let a = (cz * g + nx) as usize;
                        let b = (nz * g + cx) as usize;
                        if base[a] == 0 || base[b] == 0 {
                            continue;
                        }
                    }
                    esc[ni] = e.saturating_add(if *dx != 0 && *dz != 0 { 14 } else { 10 });
                    queue.push(ni as u32);
                }
            }
            for i in 0..self.dist.len() {
                if mask[i] == 0 && esc[i] != u16::MAX {
                    self.dist[i] = FALLBACK_BASE.saturating_add(esc[i]);
                }
            }
        }
        // Direction = steepest descent towards the goal.
        //
        // A diagonal step costs 14 while two orthogonal steps cost 20, so a diagonal
        // neighbour is routinely 4 units "closer" purely as quantisation of the metric. A
        // car that steers at that neighbour weaves down the field and clips the inside of
        // every corner (in a base apron it drives straight into the buildings); an
        // orthogonal step therefore wins unless the diagonal saves more than the metric's
        // own 4-unit step. `DIRS` is ordered orthogonals first, and the comparison is
        // strict, so an exact tie keeps the straight heading.
        //
        // Two tiers, because of the width rule. A cell *on* the wide route descends only
        // towards other routed cells, so a fallback cell whose nominal cost happens to be
        // lower can never pull a routed hull into a narrow slot. An off-route cell walks down
        // the width-blind `esc` gradient instead, towards the goal.
        const DIAG_PENALTY: u16 = 4;
        for iz in 0..g {
            for ix in 0..g {
                let i = (iz * g + ix) as usize;
                if self.dist[i] == u16::MAX || self.dist[i] == 0 {
                    continue;
                }
                let routed = !wide || mask[i] != 0;
                let mut best = if routed { self.dist[i] } else { esc[i] };
                let mut best_dir = 8u8;
                for (di, (dx, dz)) in DIRS.iter().enumerate() {
                    let nx = ix + dx;
                    let nz = iz + dz;
                    if nx < 0 || nz < 0 || nx >= g || nz >= g {
                        continue;
                    }
                    let ni = (nz * g + nx) as usize;
                    let cost = if routed {
                        if wide && mask[ni] == 0 {
                            continue;
                        }
                        self.dist[ni].saturating_add(if *dx != 0 && *dz != 0 {
                            DIAG_PENALTY
                        } else {
                            0
                        })
                    } else {
                        if esc[ni] == u16::MAX {
                            continue;
                        }
                        esc[ni]
                    };
                    if cost < best {
                        best = cost;
                        best_dir = di as u8;
                    }
                }
                self.dir[i] = best_dir;
            }
        }
        self.valid = true;
        self.queue = queue;
        self.base = base;
        self.wide = mask;
        self.esc = esc;
    }

    /// Desired heading (unit vector) at a world position; zero when unreachable.
    pub fn sample(&self, map: &MapData, p: Vec2) -> Vec2 {
        if !self.valid {
            return Vec2::ZERO;
        }
        let g = map.grid as i32;
        let ix = ((p.x / map.cell).floor() as i32).clamp(0, g - 1);
        let iz = ((p.y / map.cell).floor() as i32).clamp(0, g - 1);
        let i = (iz * g + ix) as usize;
        let d = self.dir[i];
        if d >= 8 {
            return Vec2::ZERO;
        }
        let (dx, dz) = DIRS[d as usize];
        v2(dx as f32, dz as f32).norm()
    }

    /// Remaining path cost in metres, or `f32::INFINITY` when unreachable.
    pub fn cost(&self, map: &MapData, p: Vec2) -> f32 {
        if !self.valid {
            return f32::INFINITY;
        }
        let g = map.grid as i32;
        let ix = ((p.x / map.cell).floor() as i32).clamp(0, g - 1);
        let iz = ((p.y / map.cell).floor() as i32).clamp(0, g - 1);
        let d = self.dist[(iz * g + ix) as usize];
        if d == u16::MAX {
            f32::INFINITY
        } else {
            d as f32 * 0.1 * map.cell
        }
    }
}

/// Terrain/dynamic passability, ignorant of hull width: may a *point* sit on `idx` in `mode`?
///
/// This is the old `cell_passable` body. The land route layers a clearance rule on top of it
/// (see [`cell_passable`]); every other caller means exactly this.
#[inline]
fn base_passable(map: &MapData, blocked: &[bool], idx: usize, mode: u8) -> bool {
    if mode == pass::AIR {
        return true;
    }
    if idx < blocked.len() && blocked[idx] {
        return false;
    }
    let t = map.nav[idx];
    if t == terrain::ROCK || t == terrain::BLOCKED {
        return false;
    }
    if terrain::is_water(t) {
        return mode == pass::AMPHIBIOUS;
    }
    true
}

/// The LAND width rule over precomputed passability bytes (see [`FlowField::build`]).
///
/// Identical to the body of [`cell_passable`] — same bit layout, same corner exception — but
/// it reads one byte per neighbour instead of re-running [`base_passable`] five times. `nav`
/// is only consulted for the closed-side structure check. A test pins this against
/// `cell_passable` on generated maps so the two cannot drift apart.
#[inline]
fn wide_from_base(base: &[u8], nav: &[u8], g: i32, idx: usize) -> bool {
    if base[idx] == 0 {
        return false;
    }
    let cx = (idx as i32) % g;
    let cz = (idx as i32) / g;
    // Bit per cardinal side: 1 = west, 2 = east, 4 = north, 8 = south.
    let mut open = 0u8;
    let mut closed = 0u8;
    let mut closed_struct = 0u8;
    for (bit, dx, dz) in [(1u8, -1i32, 0i32), (2, 1, 0), (4, 0, -1), (8, 0, 1)] {
        let nx = cx + dx;
        let nz = cz + dz;
        if nx < 0 || nz < 0 || nx >= g || nz >= g {
            closed += 1;
            continue;
        }
        let ni = (nz * g + nx) as usize;
        if base[ni] != 0 {
            open |= bit;
        } else {
            closed += 1;
            if nav[ni] == terrain::BLOCKED {
                closed_struct += 1;
            }
        }
    }
    // Three or four open sides: a lane edge or the middle of a lane.
    if open.count_ones() >= 3 {
        return true;
    }
    if open.count_ones() == 2 {
        // Opposite open sides (west+east, north+south) is a one-cell slot: too narrow for any
        // hull, and rejected whatever bounds it.
        if open & 0b0011 == 0b0011 || open & 0b1100 == 0b1100 {
            return false;
        }
        // Adjacent open sides is a corner. Routable only when *both* closed sides are static
        // structure footprints (see `cell_passable`).
        return closed == 2 && closed_struct == 2;
    }
    false
}

/// May a hull of `mode` be routed through `idx`?
///
/// LAND is width-aware. A 2 m nav cell is far narrower than the 4.4 m tank, so a lone
/// base-passable cell between two rocks was a legal land route: on map 2 "Iron Strait" seed 7
/// the LAND field aimed team 1's tank at the ridge at (277,264); at 13 m/s the hull could not
/// make the turn at the ridge end, physics stopped it dead, and the `HOLD` fallback (its field
/// cost there is infinite) pinned it against the rock for the rest of the round - 167 m from
/// the enemy flag, full hp, yaw still turning.
///
/// A cell is LAND-passable only when it and at least three of its four cardinal neighbours are
/// base-passable. That rejects every one-cell slot - the defect's shape - and the tight corners
/// a wide hull clips, while keeping the full width of a three-cell lane routed. The cell at the
/// end of a ridge keeps three open sides and stays routable, which is the measured wide crossing
/// at (276,270); the choke at (277,264) has one.
///
/// A cell with exactly two open sides that are adjacent (a corner, not a slot) is admitted only
/// when both closed sides are static structure footprints. mapgen already reserves vehicle
/// shoulders around those (`NAV_SHOULDER`, `NAV_SQUEEZE`) and `normalize_map` widens them by
/// 0.8 m, so re-applying the tank's own width there would double-penalise hand-placed bases.
/// Rock, water and runtime `dyn_block` get the full width rule.
///
/// The "all four cardinal neighbours" bar was measured first and is too strict: it also rejects
/// the *edge* cells of every lane, so a 6 m lane - including every 7 m bridge deck here - is
/// routed as a single 2 m line. A hull with momentum does not hold a one-cell line, drifts into
/// the excluded cell, loses the field and `ai.rs` HOLDs it: measured stalls at 53 / 155 / 208 /
/// 209 m on maps 1/2/3 with the four-neighbour bar. Full 8-neighbour dilation is stricter still
/// and would seal the decks outright.
///
/// `blocked` is `World::dyn_block` snapshotted by `update_fields` for the whole build, so a
/// newly blocked cell (a wreck, a destroyed structure) also lowers the neighbour count of its
/// cardinal neighbours - the lane closure is consistent with the snapshot and cannot route a
/// tank into a gap that just shut.
#[inline]
pub fn cell_passable(map: &MapData, blocked: &[bool], idx: usize, mode: u8) -> bool {
    if mode != pass::LAND {
        return base_passable(map, blocked, idx, mode);
    }
    if !base_passable(map, blocked, idx, mode) {
        return false;
    }
    let g = map.grid as i32;
    let cx = (idx as i32) % g;
    let cz = (idx as i32) / g;
    // Bit per cardinal side: 1 = west, 2 = east, 4 = north, 8 = south.
    let mut open = 0u8;
    let mut closed = 0u8;
    let mut closed_struct = 0u8;
    for (bit, dx, dz) in [(1u8, -1i32, 0i32), (2, 1, 0), (4, 0, -1), (8, 0, 1)] {
        let nx = cx + dx;
        let nz = cz + dz;
        // At the grid edge a missing neighbour is not passable, so the world border is never
        // a one-sided lane.
        if nx < 0 || nz < 0 || nx >= g || nz >= g {
            closed += 1;
            continue;
        }
        let ni = (nz * g + nx) as usize;
        if base_passable(map, blocked, ni, mode) {
            open |= bit;
        } else {
            closed += 1;
            if map.nav[ni] == terrain::BLOCKED {
                closed_struct += 1;
            }
        }
    }
    // Three or four open sides: a lane edge or the middle of a lane.
    if open.count_ones() >= 3 {
        return true;
    }
    if open.count_ones() == 2 {
        // Opposite open sides (west+east, north+south) is a one-cell slot: too narrow for any
        // hull, and rejected whatever bounds it.
        if open & 0b0011 == 0b0011 || open & 0b1100 == 0b1100 {
            return false;
        }
        // Adjacent open sides is a corner. It is routable only when *both* closed sides are
        // static structure footprints. Those are the one kind of obstacle mapgen already pads
        // for vehicles (`NAV_SHOULDER`, `NAV_SQUEEZE`) and `normalize_map` widens by 0.8 m, so
        // re-applying the tank's own width there would double-penalise hand-placed bases. Rock,
        // water and runtime `dyn_block` get the full width rule.
        return closed == 2 && closed_struct == 2;
    }
    false
}

fn nearest_passable(
    map: &MapData,
    blocked: &[bool],
    sx: i32,
    sz: i32,
    mode: u8,
) -> Option<(i32, i32)> {
    let g = map.grid as i32;
    let si = (sz * g + sx) as usize;
    if cell_passable(map, blocked, si, mode) {
        return Some((sx, sz));
    }
    for r in 1..14i32 {
        for dz in -r..=r {
            for dx in -r..=r {
                if dx.abs() != r && dz.abs() != r {
                    continue;
                }
                let nx = sx + dx;
                let nz = sz + dz;
                if nx < 0 || nz < 0 || nx >= g || nz >= g {
                    continue;
                }
                if cell_passable(map, blocked, (nz * g + nx) as usize, mode) {
                    return Some((nx, nz));
                }
            }
        }
    }
    None
}

/// The set of fields the AI keeps warm, one rebuild at a time.
pub struct Fields {
    /// index 0/1 = team: field towards the ENEMY flag (attack run).
    pub to_flag: [FlowField; 2],
    /// index 0/1 = team: field towards own flag stand (bring the flag home / retreat).
    pub to_base: [FlowField; 2],
    /// index 0/1 = team: field towards the enemy's live vehicle (hunting).
    pub to_enemy: [FlowField; 2],
    /// index 0/1 = team: attack run for AMPHIBIOUS vehicles, which may cross open water.
    pub to_flag_swim: [FlowField; 2],
    pub cursor: u8,
    pub timer: f32,
}

impl Fields {
    pub fn new() -> Fields {
        Fields {
            to_flag: [FlowField::new(), FlowField::new()],
            to_base: [FlowField::new(), FlowField::new()],
            to_enemy: [FlowField::new(), FlowField::new()],
            to_flag_swim: [FlowField::new(), FlowField::new()],
            cursor: 0,
            timer: 0.0,
        }
    }
}

/// Seconds between two field rebuilds (one field per interval, round-robin over 8 slots).
///
/// The interval scales with the grid: a rebuild costs O(cells), so keeping 0.18 s on a
/// 256x256 grid would put a four-times-bigger spike into a 60 Hz frame. Scaling linearly
/// with the grid side (not its area) keeps the fields fresher than a strictly proportional
/// budget would allow while halving the spike; the whole bank of 8 refreshes in `8 * 0.36 s`.
/// How often the flow fields are rebuilt, for a given grid resolution.
///
/// Scaled from the 128-cell reference so a bigger world rebuilds proportionally less often: a
/// rebuild costs O(cells), which is 262k cells on the big map against 65k here.
pub fn nav_interval(grid: u32) -> f32 {
    0.18 * (grid as f32 / 128.0)
}

/// Rebuild one field every [`nav_interval`] seconds, round-robin.
pub fn update_fields(w: &mut World, dt: f32) {
    w.fields.timer -= dt;
    if w.fields.timer > 0.0 {
        return;
    }
    // The world knows its own grid; the interval follows from it.
    w.fields.timer = nav_interval(w.map.grid);
    let cursor = w.fields.cursor;
    w.fields.cursor = (w.fields.cursor + 1) % 8;
    let blocked = core::mem::take(&mut w.dyn_block);
    match cursor {
        0 | 1 => {
            let team = (cursor % 2) as usize;
            let goal = w.flags[1 - team].pos;
            let mode = pass::LAND;
            let f = &mut w.fields.to_flag[team];
            f.build(&w.map, &blocked, goal, mode);
        }
        2 | 3 => {
            let team = (cursor % 2) as usize;
            let goal = w.flags[team].home;
            let f = &mut w.fields.to_base[team];
            f.build(&w.map, &blocked, goal, pass::LAND);
        }
        4 | 5 => {
            let team = (cursor % 2) as usize;
            let goal = w
                .vehicles
                .iter()
                .find(|v| v.team != team as u8 && v.alive() && v.player > 0)
                .map(|v| v.pos)
                .unwrap_or(w.flags[1 - team].home);
            let f = &mut w.fields.to_enemy[team];
            f.build(&w.map, &blocked, goal, pass::LAND);
        }
        _ => {
            // Amphibious route to the flag: the jeep can swim, which lets it bypass the
            // bridge chokepoints that the land route funnels through.
            let team = (cursor % 2) as usize;
            let goal = w.flags[1 - team].pos;
            let f = &mut w.fields.to_flag_swim[team];
            f.build(&w.map, &blocked, goal, pass::AMPHIBIOUS);
        }
    }
    w.dyn_block = blocked;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GRID;
    use crate::mapgen;
    use std::time::Instant;

    /// Cost of one flow-field rebuild: the AI rebuilds one field per [`NAV_INTERVAL`]
    /// round-robin, so this is the per-tick spike the simulation has to fit in a frame.
    /// Printed as evidence, with a budget assertion so a grid that got too big to path on
    /// fails here instead of showing up as a stutter in the browser.
    #[test]
    fn flow_field_rebuild_cost() {
        let map = mapgen::generate(7, 0);
        let blocked = vec![false; map.nav.len()];
        let mut f = FlowField::new();
        let goal = map.flag_home[1];
        // Warm up (also proves the goal is reachable).
        f.build(&map, &blocked, goal, pass::LAND);
        let reached = f.dist.iter().filter(|d| **d != u16::MAX).count();

        // Median of several batches: a single average is one load spike away from a false
        // failure on a busy machine, while the median still catches a real constant slowdown.
        let reps = 30;
        let batches = 5;
        let mut land_samples = Vec::with_capacity(batches);
        for _ in 0..batches {
            let t0 = Instant::now();
            for _ in 0..reps {
                f.build(&map, &blocked, goal, pass::LAND);
            }
            land_samples.push(t0.elapsed().as_secs_f64() * 1e6 / reps as f64);
        }
        let mut swim_samples = Vec::with_capacity(batches);
        for _ in 0..batches {
            let t1 = Instant::now();
            for _ in 0..reps {
                f.build(&map, &blocked, goal, pass::AMPHIBIOUS);
            }
            swim_samples.push(t1.elapsed().as_secs_f64() * 1e6 / reps as f64);
        }
        land_samples.sort_by(|a, b| a.total_cmp(b));
        swim_samples.sort_by(|a, b| a.total_cmp(b));
        let land_us = land_samples[batches / 2];
        let swim_us = swim_samples[batches / 2];

        println!(
            "flow field: grid {GRID}x{GRID} ({} cells) | LAND {:.0} us (median of {batches}) | \
             AMPHIBIOUS {:.0} us | reached {reached}/{} | rebuilt every {:.2} s",
            GRID * GRID,
            land_us,
            swim_us,
            GRID * GRID,
            nav_interval(GRID)
        );
        // A rebuild must not eat the frame it lands in. The shipping build is the release
        // wasm, so that is where the budget is real (4 ms of a 16.6 ms frame); a debug build
        // runs this loop ~18x slower and only gets a catastrophe check.
        let budget_us = if cfg!(debug_assertions) { 60_000.0 } else { 4_000.0 };
        assert!(
            land_us < budget_us,
            "LAND flow field rebuild takes {land_us:.0} us (budget {budget_us:.0} us)"
        );
        assert!(
            reached > ((GRID * GRID) / 4) as usize,
            "flow field barely reached anything"
        );
    }

    /// The measured defect, map 2 "Iron Strait" seed 7.
    ///
    /// `cell_passable` used to judge one cell's terrain class alone, so a single passable cell
    /// in the rock ridge was a legal LAND route for a 4.4 m tank. The field aimed team 1's
    /// tank at world (277,264); physics stopped it dead there (speed 0.0, full hp, yaw still
    /// turning) and `ai.rs`'s HOLD fallback pinned it 167 m from the enemy flag for the rest of
    /// the round. Measured nav window (2 m cells, world x249.., z258..274):
    ///
    /// ```text
    /// z 260 ..~~~~~=====~~^.============.
    /// z 262 ..~~~~~=====:~^..========....
    /// z 264 .~~~~~~~=====-@...=====......   @ = the choke: rock directly N and S
    /// z 266 .~~~~~~~=====-^..............
    /// z 268 .~~~~~~~=====-^..............
    /// z 270 .~~~~~~~-====--.............   <- 6 m south: SAND + open ground, wide
    /// ```
    ///
    /// The dilated LAND mask must reject every one-cell pinch and admit the wide crossings,
    /// which is where the field routes the tank.
    ///
    /// The original incident pinned its choke at world (277,264) and a pinch at (285,129).
    /// Per-seed terrain variation (mapgen's plan jitter + coastline wander) moves those cells
    /// between seeds, so the test now *finds* the defect's shape instead of hard-coding it:
    /// any cell whose own terrain is drivable (base-passable) but which the width rule rejects
    /// because fewer than three of its cardinal neighbours are open.
    #[test]
    fn land_mask_rejects_one_cell_rock_pinches() {
        let mut map = mapgen::generate(7, 2);
        crate::normalize_map(&mut map);
        let blocked = vec![false; map.nav.len()];
        let g = GRID as i32;

        // Scan for the defect's shape: a drivable cell whose only open sides are an opposite
        // pair (west+east or north+south) — a one-cell slot, too narrow for any hull. Also
        // check the other branch on real geometry: wide lane cells stay routable.
        let (mut slots, mut lanes) = (Vec::new(), 0u32);
        for cz in 1..g - 1 {
            for cx in 1..g - 1 {
                let i = (cz * g + cx) as usize;
                if !base_passable(&map, &blocked, i, pass::LAND) {
                    continue;
                }
                // Same side bits `cell_passable` uses: 1 west, 2 east, 4 north, 8 south.
                let mut open = 0u8;
                for (bit, dx, dz) in [(1u8, -1i32, 0i32), (2, 1, 0), (4, 0, -1), (8, 0, 1)] {
                    if base_passable(&map, &blocked, ((cz + dz) * g + cx + dx) as usize, pass::LAND) {
                        open |= bit;
                    }
                }
                if open == 0b0011 || open == 0b1100 {
                    assert!(
                        !cell_passable(&map, &blocked, i, pass::LAND),
                        "one-cell slot at ({cx},{cz}) is still a LAND routing cell"
                    );
                    slots.push(i);
                } else if open.count_ones() >= 3 {
                    assert!(
                        cell_passable(&map, &blocked, i, pass::LAND),
                        "wide lane cell ({cx},{cz}) was sealed"
                    );
                    lanes += 1;
                }
            }
        }
        // The map must still contain the defect's shape (otherwise this test passes vacuously)
        // and wide crossings must be the norm, not the exception.
        assert!(!slots.is_empty(), "map 2 seed 7 has no one-cell slots; the width rule is untested");
        assert!(lanes > 100, "wide lane cells nearly vanished ({lanes}) — the map is sealed");

        // And the field itself: a slot may carry the recovery fallback (a hull standing in an
        // excluded cell still points at the goal), but never a real route cost. The fallback's
        // nominal floor is 20_000 BFS units = 4000 m in world distance; any genuine LAND route
        // across this 512 m map costs far less than that.
        let mut f = FlowField::new();
        f.build(&map, &blocked, map.flag_home[0], pass::LAND);
        for i in slots.iter().take(16) {
            let cx = (*i as i32) % g;
            let cz = (*i as i32) / g;
            let w = v2(cx as f32 * 2.0 + 1.0, cz as f32 * 2.0 + 1.0);
            assert!(
                f.cost(&map, w) > 1000.0,
                "team 1's LAND field gives the one-cell slot at cell ({cx},{cz}) a real route cost"
            );
        }
    }

    /// `dyn_block` (destroyed structures, heavy wrecks) must close the lane the same way
    /// natural terrain does. `update_fields` snapshots it for the whole build and
    /// `cell_passable` counts a blocked cardinal neighbour as closed, so blocking one of a
    /// lane-edge cell's three open sides drops it below the three-open bar and the field stops
    /// routing through it - a hull is not sent into a gap that just shut.
    #[test]
    fn dyn_block_closes_the_lane_for_the_width_rule() {
        let mut map = mapgen::generate(1, 0);
        crate::normalize_map(&mut map);
        let g = GRID as i32;
        let mut blocked = vec![false; map.nav.len()];
        // A lane-edge cell: LAND-passable, exactly three of its cardinal neighbours open.
        let mut found: Option<(usize, usize)> = None;
        'scan: for cz in 1..g - 1 {
            for cx in 1..g - 1 {
                let i = (cz * g + cx) as usize;
                if !cell_passable(&map, &blocked, i, pass::LAND) {
                    continue;
                }
                let open: Vec<usize> = [(cx - 1, cz), (cx + 1, cz), (cx, cz - 1), (cx, cz + 1)]
                    .iter()
                    .filter(|(nx, nz)| {
                        base_passable(&map, &blocked, (*nz * g + *nx) as usize, pass::LAND)
                    })
                    .map(|(nx, nz)| (*nz * g + *nx) as usize)
                    .collect();
                if open.len() == 3 {
                    found = Some((i, open[0]));
                    break 'scan;
                }
            }
        }
        let (cell_i, neighbour) = found.expect("map 0 has a lane-edge cell");
        assert!(cell_passable(&map, &blocked, cell_i, pass::LAND));
        blocked[neighbour] = true;
        assert!(
            !cell_passable(&map, &blocked, cell_i, pass::LAND),
            "blocking a lane-edge neighbour left the cell routable"
        );
    }

    /// `wide_from_base` is what `FlowField::build` actually uses for the LAND mask; this pins
    /// it to the reference `cell_passable` on generated maps (with and without dynamic blocks)
    /// so an edit to one side fails here instead of silently re-routing every land hull.
    #[test]
    fn wide_from_base_matches_cell_passable() {
        for &(seed, m, dyn_block) in &[(7u32, 0u32, false), (99, 2, true), (3, 1, false)] {
            let map = mapgen::generate(seed, m);
            let g = map.grid as i32;
            let n = (g * g) as usize;
            let blocked: Vec<bool> = (0..n).map(|i| dyn_block && i % 17 == 0).collect();
            let mut base = vec![0u8; n];
            for (i, b) in base.iter_mut().enumerate() {
                *b = base_passable(&map, &blocked, i, pass::LAND) as u8;
            }
            for i in 0..n {
                let fast = wide_from_base(&base, &map.nav, g, i);
                let ref_ = cell_passable(&map, &blocked, i, pass::LAND);
                assert_eq!(fast, ref_, "seed {seed} map {m}: width rule disagrees at cell {i}");
            }
        }
    }
}
