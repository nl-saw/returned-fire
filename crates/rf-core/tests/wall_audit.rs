//! Perimeter wall audit.
//!
//! The user saw *misaligned wall segments* in a top-down render of a base: a wall run must be a
//! straight, continuous chain, and four of them must close into a real rectangle with corners
//! that butt. This audit derives the runs from the geometry alone (it does not trust any private
//! mapgen API) and checks, for every map and several seeds:
//!
//! * consecutive segments in a run share an endpoint within 5 cm along the run axis,
//! * they overlap by at most 1% of the smaller segment's area,
//! * their lateral offset from the run line is under 2 cm,
//! * their `yaw` is identical within 0.5 degrees and their `y` within 2 cm,
//! * every run end is either a gate opening or a corner that touches another run (within 10 cm),
//! * the gate is a clean opening (a ~7.4 m frame in an ~8 m gap),
//! * no wall piece intersects a building, the helipad, a flag pole/plaza or a bridge deck.
//!
//! Run it with `cargo test --test wall_audit -- --nocapture` to also print the run table.

use rf_core::math::{v2, Vec2};
use rf_core::types::{skind, MapData, Structure, WORLD_SIZE};

const SEEDS: [u32; 3] = [1, 7, 99];
const MAPS: u32 = 4;

/// Box-vs-box test in the oriented-rectangle sense (separating axis on both boxes).
fn obb_overlap_area(a: &Structure, b: &Structure) -> f32 {
    let ca = a.pos();
    let cb = b.pos();
    let axes = [
        v2(a.yaw.cos(), a.yaw.sin()),
        v2(-a.yaw.sin(), a.yaw.cos()),
        v2(b.yaw.cos(), b.yaw.sin()),
        v2(-b.yaw.sin(), b.yaw.cos()),
    ];
    let mut min_ov = f32::INFINITY;
    for ax in axes {
        let ea = (a.w * 0.5 * ax.dot(v2(a.yaw.cos(), a.yaw.sin()))).abs()
            + (a.d * 0.5 * ax.dot(v2(-a.yaw.sin(), a.yaw.cos()))).abs();
        let eb = (b.w * 0.5 * ax.dot(v2(b.yaw.cos(), b.yaw.sin()))).abs()
            + (b.d * 0.5 * ax.dot(v2(-b.yaw.sin(), b.yaw.cos()))).abs();
        let pa = ca.dot(ax);
        let pb = cb.dot(ax);
        let ov = (pa + ea).min(pb + eb) - (pa - ea).max(pb - eb);
        if ov <= 0.0 {
            return 0.0;
        }
        min_ov = min_ov.min(ov);
    }
    min_ov * min_ov
}

/// Canonical long axis of a wall segment (sign-normalised so runs group reliably).
fn axis_of(s: &Structure) -> Vec2 {
    let mut a = v2(s.yaw.cos(), s.yaw.sin());
    if a.x < -1e-6 || (a.x.abs() <= 1e-6 && a.y < 0.0) {
        a = -a;
    }
    a
}

#[derive(Clone)]
struct Piece {
    s: Structure,
    axis: Vec2,
    /// Interval along `axis`.
    s0: f32,
    s1: f32,
    /// Signed offset along the normal of `axis`.
    perp: f32,
}

impl Piece {
    fn new(s: &Structure) -> Piece {
        let axis = axis_of(s);
        let n = v2(-axis.y, axis.x);
        let c = s.pos();
        let mid = c.dot(axis);
        Piece {
            s: s.clone(),
            axis,
            s0: mid - s.w * 0.5,
            s1: mid + s.w * 0.5,
            perp: c.dot(n),
        }
    }
    fn end(&self, at_start: bool) -> Vec2 {
        let mid = self.s.pos().dot(self.axis);
        let t = if at_start { self.s0 } else { self.s1 };
        // reconstruct the world point on the segment's centreline
        let c = self.s.pos();
        let along = (c.dot(self.axis) - mid) + (t - mid);
        c + self.axis * along
    }
}

#[derive(Clone)]
struct Run {
    pieces: Vec<Piece>,
    /// Reference line: perpendicular offset of the run's centreline.
    perp: f32,
    axis: Vec2,
}

impl Run {
    fn ends(&self) -> (Vec2, Vec2) {
        let a = self.pieces.first().unwrap();
        let b = self.pieces.last().unwrap();
        (a.end(true), b.end(false))
    }
    fn len(&self) -> f32 {
        self.pieces.last().unwrap().s1 - self.pieces.first().unwrap().s0
    }
    fn normal(&self) -> Vec2 {
        v2(-self.axis.y, self.axis.x)
    }
}

/// Group wall segments into straight runs from geometry alone.
fn runs_of(walls: &[Structure]) -> Vec<Run> {
    let pieces: Vec<Piece> = walls.iter().map(Piece::new).collect();
    let n = pieces.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, i: usize) -> usize {
        if p[i] != i {
            let r = find(p, p[i]);
            p[i] = r;
        }
        p[i]
    }
    for i in 0..n {
        for j in i + 1..n {
            let (a, b) = (&pieces[i], &pieces[j]);
            if a.axis.dot(b.axis).abs() < 0.99996 {
                continue; // not parallel
            }
            if (a.perp - b.perp).abs() > 0.35 {
                continue; // different line
            }
            let gap = if a.s1 < b.s0 {
                b.s0 - a.s1
            } else if b.s1 < a.s0 {
                a.s0 - b.s1
            } else {
                0.0
            };
            if gap > 1.0 {
                continue; // a hole between them
            }
            let (ra, rb) = (find(&mut parent, i), find(&mut parent, j));
            if ra != rb {
                parent[ra] = rb;
            }
        }
    }
    let mut groups: std::collections::BTreeMap<usize, Vec<Piece>> = std::collections::BTreeMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(pieces[i].clone());
    }
    let mut out: Vec<Run> = Vec::new();
    for (_, mut ps) in groups {
        ps.sort_by(|a, b| a.s0.partial_cmp(&b.s0).unwrap());
        let perp = ps.iter().map(|p| p.perp).sum::<f32>() / ps.len() as f32;
        let axis = ps[0].axis;
        out.push(Run {
            pieces: ps,
            perp,
            axis,
        });
    }
    out.sort_by(|a, b| {
        let pa = a.pieces[0].perp;
        let pb = b.pieces[0].perp;
        pa.partial_cmp(&pb).unwrap()
    });
    out
}

fn describe(run: &Run) -> String {
    let p = &run.pieces[0];
    format!(
        "run axis=({:.2},{:.2}) perp={:.2} segs={} span={:.1}m at ({:.0},{:.0})",
        run.axis.x,
        run.axis.y,
        run.perp,
        run.pieces.len(),
        run.len(),
        p.s.x,
        p.s.z
    )
}

/// Collect every wall defect on one map; empty means the perimeter is sound.
fn audit_map(index: u32, seed: u32, show_runs: bool) -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    let map: MapData = rf_core::mapgen::generate(seed, index);
    let tag = format!("map {index} \"{}\" seed {seed}", map.name);
    let walls: Vec<Structure> = map
        .structures
        .iter()
        .filter(|s| s.kind as u8 == skind::WALL)
        .cloned()
        .collect();
    if walls.is_empty() {
        problems.push(format!("{tag}: no walls at all"));
        return problems;
    }
    let runs = runs_of(&walls);

    if show_runs {
        println!("--- {tag}: {} wall segments in {} runs", walls.len(), runs.len());
        for w in &walls {
            println!(
                "      #{} pos ({:.2},{:.2}) y {:.2} yaw {:.4} w {:.2} d {:.2}",
                w.id, w.x, w.z, w.y, w.yaw, w.w, w.d
            );
        }
        for r in &runs {
            println!("    {}", describe(r));
        }
    }

    // 1. Intra-run geometry.
    for (ri, run) in runs.iter().enumerate() {
        let p0 = &run.pieces[0];
        for (k, p) in run.pieces.iter().enumerate() {
            let where_ = format!("{tag} run {ri} [{}] ({})", k, describe(run));
            if (p.perp - run.perp).abs() >= 0.02 {
                problems.push(format!(
                    "{where_}: lateral offset {:.3} m from the run line",
                    (p.perp - run.perp).abs()
                ));
            }
            let dyaw = (p.s.yaw - p0.s.yaw)
                .abs()
                .min(std::f32::consts::TAU - (p.s.yaw - p0.s.yaw).abs());
            if dyaw >= 0.5f32.to_radians() {
                problems.push(format!(
                    "{where_}: yaw differs by {:.3} deg from the run's first segment",
                    dyaw.to_degrees()
                ));
            }
            if (p.s.y - p0.s.y).abs() > 0.02 {
                problems.push(format!(
                    "{where_}: y differs by {:.3} m from the run's first segment",
                    (p.s.y - p0.s.y).abs()
                ));
            }
            if k == 0 {
                continue;
            }
            let prev = &run.pieces[k - 1];
            let gap = p.s0 - prev.s1;
            if gap.abs() > 0.05 {
                problems.push(format!(
                    "{where_}: {} cm {} with its predecessor",
                    (gap.abs() * 100.0).round(),
                    if gap > 0.0 { "gap" } else { "overlap" }
                ));
            }
            let smaller = p.s.w.min(prev.s.w);
            let ov_area = obb_overlap_area(&p.s, &prev.s);
            if ov_area > 0.01 * smaller * 0.9 + 1e-4 {
                problems.push(format!(
                    "{where_}: overlaps its predecessor by {:.2} m^2 ({:.1}% of the smaller segment)",
                    ov_area,
                    100.0 * ov_area / (smaller * 0.9)
                ));
            }
        }
    }

    // 2. Run ends: a gate opening or a corner that touches another run.
    let gates: Vec<Structure> = map
        .structures
        .iter()
        .filter(|s| s.kind as u8 == skind::GATE)
        .cloned()
        .collect();
    for (ri, run) in runs.iter().enumerate() {
        for (which, end) in [(true, run.ends().0), (false, run.ends().1)] {
            let near_gate = gates.iter().any(|g| {
                let d = g.dist_to(end);
                let parallel = axis_of(g).dot(run.axis).abs() > 0.99;
                d < 4.0 && parallel
            });
            if near_gate {
                continue;
            }
            // Otherwise it must be a corner: either it butts into another run's material
            // (within 10 cm), or it terminates on a perpendicular run's centreline. The second
            // case is the corner post: with a 0.9 m thick wall a corner square has to be filled
            // by exactly one piece, so the through run's tip ends half a thickness past the
            // corner point, right where the other run's centreline (and its end) is.
            let touch = walls.iter().any(|w| {
                let q = Piece::new(w);
                let same = (q.perp - run.perp).abs() < 0.02 && q.axis.dot(run.axis).abs() > 0.99996;
                if same {
                    return false; // same run
                }
                q.s.dist_to(end) < 0.10
            }) || runs.iter().any(|other| {
                if other.axis.dot(run.axis).abs() > 0.02 {
                    return false; // not perpendicular: not a corner joint
                }
                let n = other.normal();
                let perp_dist = (end.dot(n) - other.perp).abs();
                let along = end.dot(other.axis);
                let (lo, hi) = (
                    other.pieces.first().unwrap().s0,
                    other.pieces.last().unwrap().s1,
                );
                perp_dist <= 0.45 + 0.10 && along > lo - 0.6 && along < hi + 0.6
            });
            if !touch {
                problems.push(format!(
                    "{tag} run {ri} ({}) end {} ({:.1},{:.1}) is neither a gate nor a corner: no other run within 10 cm",
                    describe(run),
                    if which { "start" } else { "end" },
                    end.x,
                    end.y
                ));
            }
        }
    }

    // 3. Gate openings: a ~7.4 m frame inside an ~8 m gap in the wall line it sits on.
    for g in &gates {
        // Every wall piece lying on the gate's own line, whichever band it belongs to.
        let n_g = v2(-axis_of(g).y, axis_of(g).x);
        let mut on_line: Vec<&Piece> = Vec::new();
        for r in runs.iter() {
            if axis_of(g).dot(r.axis).abs() <= 0.99 {
                continue;
            }
            if (g.pos().dot(n_g) - r.perp).abs() > 1.0 {
                continue;
            }
            on_line.extend(r.pieces.iter());
        }
        let c = g.pos().dot(axis_of(g));
        let lo = on_line
            .iter()
            .filter(|p| p.s1 <= c + 1e-3)
            .map(|p| p.s1)
            .fold(None, |acc: Option<f32>, v| Some(acc.map_or(v, |a: f32| a.max(v))));
        let hi = on_line
            .iter()
            .filter(|p| p.s0 >= c - 1e-3)
            .map(|p| p.s0)
            .fold(None, |acc: Option<f32>, v| Some(acc.map_or(v, |a: f32| a.min(v))));
        let gap = match (lo, hi) {
            (Some(lo), Some(hi)) if hi > lo => hi - lo,
            _ => {
                problems.push(format!(
                    "{tag}: gate at ({:.0},{:.0}) is not an opening in a wall run",
                    g.x, g.z
                ));
                continue;
            }
        };
        if (gap - 8.0).abs() >= 0.35 {
            problems.push(format!("{tag}: gate opening is {:.2} m, expected ~8 m", gap));
        }
        if (g.w - 7.4).abs() >= 0.3 || g.w >= gap {
            problems.push(format!(
                "{tag}: gate frame is {:.2} m wide inside a {:.2} m gap",
                g.w, gap
            ));
        }
    }

    // 4. Walls must never cut through the base's furniture or a bridge deck.
    let protected: Vec<&Structure> = map
        .structures
        .iter()
        .filter(|s| {
            matches!(
                s.kind as u8,
                skind::GARAGE
                    | skind::HQ
                    | skind::HELIPAD
                    | skind::FLAG_POLE
                    | skind::FUEL_DEPOT
                    | skind::AMMO_TENT
                    | skind::BRIDGE
                    | skind::BUNKER
                    | skind::WATCHTOWER
                    | skind::RADAR
            )
        })
        .collect();
    for w in &walls {
        for o in &protected {
            let ov = obb_overlap_area(w, o);
            if ov >= 0.05 {
                problems.push(format!(
                    "{tag}: wall #{} at ({:.0},{:.0}) intersects kind {} #{} by {:.2} m^2",
                    w.id, w.x, w.z, o.kind, o.id, ov
                ));
            }
        }
        if !(w.d > 0.85 && w.d < 0.95) {
            problems.push(format!(
                "{tag}: wall #{} is {:.2} m thick, expected 0.9",
                w.id, w.d
            ));
        }
    }
    // 5. The strongest check of all, and the one that matches what the user saw: rasterise
    //    the perimeter and prove there is no hole to see through. The intentional gateways
    //    are sealed for this test (a gate is a door, not a defect), then a flood fill from
    //    outside the map must not reach the middle of the base.
    problems.extend(enclosure_problems(index, seed, &walls, &gates, &tag));

    problems
}

/// Rasterise the perimeter at 25 cm and flood-fill from outside; the base interior must stay
/// dry. Returns a problem string when the wall band has a visible hole.
fn enclosure_problems(
    index: u32,
    seed: u32,
    walls: &[Structure],
    gates: &[Structure],
    tag: &str,
) -> Vec<String> {
    const RES: f32 = 0.25;
    const N: usize = (WORLD_SIZE / RES) as usize; // 1024
    let mut blocked = vec![false; N * N];
    let mut mark = |s: &Structure, w: f32, d: f32| {
        let hw = w * 0.5;
        let hd = d * 0.5;
        let (sn, cs) = s.yaw.sin_cos();
        let ex = hw * cs.abs() + hd * sn.abs();
        let ez = hw * sn.abs() + hd * cs.abs();
        let c = s.pos();
        let i0 = (((c.x - ex) / RES).floor().max(0.0)) as i32;
        let i1 = (((c.x + ex) / RES).ceil().min((N - 1) as f32)) as i32;
        let j0 = (((c.y - ez) / RES).floor().max(0.0)) as i32;
        let j1 = (((c.y + ez) / RES).ceil().min((N - 1) as f32)) as i32;
        for j in j0..=j1 {
            for i in i0..=i1 {
                let q = v2((i as f32 + 0.5) * RES, (j as f32 + 0.5) * RES);
                let dd = q - c;
                let lx = dd.x * cs + dd.y * sn;
                let lz = -dd.x * sn + dd.y * cs;
                if lx.abs() <= hw && lz.abs() <= hd {
                    blocked[j as usize * N + i as usize] = true;
                }
            }
        }
    };
    for w in walls {
        mark(w, w.w, w.d);
    }
    // Seal the doorways: a gate seals its whole 8 m opening for this test.
    for g in gates {
        mark(g, 8.2, 1.2);
    }

    // Flood fill from the border.
    let map: MapData = rf_core::mapgen::generate(seed, index);
    let mut seen = vec![false; N * N];
    let mut queue: Vec<u32> = Vec::with_capacity(1 << 16);
    for i in 0..N {
        for j in [0usize, N - 1] {
            let k = j * N + i;
            if !blocked[k] && !seen[k] {
                seen[k] = true;
                queue.push(k as u32);
            }
            let k = i * N + j;
            if !blocked[k] && !seen[k] {
                seen[k] = true;
                queue.push(k as u32);
            }
        }
    }
    let mut head = 0;
    while head < queue.len() {
        let cur = queue[head] as usize;
        head += 1;
        let cx = (cur % N) as i32;
        let cz = (cur / N) as i32;
        for (dx, dz) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
            let nx = cx + dx;
            let nz = cz + dz;
            if nx < 0 || nz < 0 || nx >= N as i32 || nz >= N as i32 {
                continue;
            }
            let k = nz as usize * N + nx as usize;
            if blocked[k] || seen[k] {
                continue;
            }
            seen[k] = true;
            queue.push(k as u32);
        }
    }

    let mut out = Vec::new();
    for team in 0..2 {
        let inside = map.spawn[team].lerp(map.flag_home[team], 0.5);
        let i = ((inside.x / RES) as usize).min(N - 1);
        let j = ((inside.y / RES) as usize).min(N - 1);
        // walk outwards a little in case the sample lands on a wall cell
        let mut reached = seen[j * N + i];
        if !reached {
            for dz in -6i32..=6 {
                for dx in -6i32..=6 {
                    let x = (i as i32 + dx).clamp(0, N as i32 - 1) as usize;
                    let z = (j as i32 + dz).clamp(0, N as i32 - 1) as usize;
                    if seen[z * N + x] {
                        reached = true;
                    }
                }
            }
        }
        if reached {
            out.push(format!(
                "{tag}: the team {team} base leaks: outside air reaches its centre, so the \
                 perimeter has a hole wider than 25 cm"
            ));
        }
    }
    out
}

#[test]
fn wall_runs_are_straight_and_closed() {
    let mut all: Vec<String> = Vec::new();
    for index in 0..MAPS {
        for seed in SEEDS {
            all.extend(audit_map(index, seed, false));
        }
    }
    assert!(
        all.is_empty(),
        "{} perimeter wall defects:\n  {}",
        all.len(),
        all.join("\n  ")
    );
}

/// ASCII plan of one base's perimeter, straight from `generate` (no `normalize_map`, whose
/// AABB blocking smears a rotated 7 m wall into a 6 m square of `X`).
///
/// `#` wall segment, `+` corner post, `=` gate frame, `o` other solid structure,
/// `S` spawn pad, `F` flag stand, `.` open ground. One character per metre.
#[test]
#[ignore]
fn wall_ascii_dump() {
    let (index, seed) = (0u32, 1u32);
    let map: MapData = rf_core::mapgen::generate(seed, index);
    let c = map.spawn[0];
    let (half, step) = (36i32, 1.0f32);
    let (x0, z0) = (c.x - half as f32, c.y - half as f32);
    let (n, m) = ((2 * half) as usize, (2 * half) as usize);
    let mut grid = vec!['.'; n * m];
    let put = |x: f32, z: f32, ch: char, grid: &mut Vec<char>| {
        let i = ((x - x0) / step) as i32;
        let j = ((z - z0) / step) as i32;
        if i >= 0 && j >= 0 && (i as usize) < n && (j as usize) < m {
            grid[j as usize * n + i as usize] = ch;
        }
    };
    for s in map.structures.iter() {
        if s.pos().dist(c) > half as f32 + 8.0 {
            continue;
        }
        let k = s.kind as u8;
        let ch = if k == skind::WALL {
            if (s.w - 0.9).abs() < 0.01 && (s.d - 0.9).abs() < 0.01 {
                '+' // corner post
            } else {
                '#'
            }
        } else if k == skind::GATE {
            '='
        } else if s.solid() {
            'o'
        } else {
            continue
        };
        let (sn, cs) = s.yaw.sin_cos();
        let hw = s.w * 0.5;
        let hd = s.d * 0.5;
        let ex = hw * cs.abs() + hd * sn.abs();
        let ez = hw * sn.abs() + hd * cs.abs();
        // cell centres, so thin or small pieces are never skipped
        let (i0, i1) = (
            ((s.x - ex - x0) / step).floor() as i32,
            ((s.x + ex - x0) / step).ceil() as i32,
        );
        let (j0, j1) = (
            ((s.z - ez - z0) / step).floor() as i32,
            ((s.z + ez - z0) / step).ceil() as i32,
        );
        for j in j0..=j1 {
            for i in i0..=i1 {
                let x = x0 + i as f32 * step;
                let z = z0 + j as f32 * step;
                let dd = v2(x - s.x, z - s.z);
                let lx = dd.x * cs + dd.y * sn;
                let lz = -dd.x * sn + dd.y * cs;
                if lx.abs() <= hw && lz.abs() <= hd {
                    put(x, z, ch, &mut grid);
                }
            }
        }
    }
    put(map.spawn[0].x, map.spawn[0].y, 'S', &mut grid);
    put(map.flag_home[0].x, map.flag_home[0].y, 'F', &mut grid);
    println!(
        "base perimeter, map {index} \"{}\" seed {seed}: 1 char = 1 m, x {:.0}..{:.0}, z {:.0}..{:.0}",
        map.name,
        x0,
        x0 + n as f32,
        z0,
        z0 + m as f32
    );
    for j in 0..m {
        let row: String = (0..n).map(|i| grid[j * n + i]).collect();
        println!("{row}");
    }
}

/// Dump one base's perimeter geometry as text so it can be drawn and looked at
/// (`cargo test --test wall_audit wall_plan_dump -- --ignored --nocapture`).
///
/// Format, one record per line:
///   `W x z yaw w d`  wall segment      `GATE x z yaw w d`
///   `B  x z yaw w d`  base building    `SPAWN x z` / `FLAG x z`
#[test]
#[ignore]
fn wall_plan_dump() {
    use std::io::Write;
    let (index, seed) = (0u32, 1u32);
    let map: MapData = rf_core::mapgen::generate(seed, index);
    // team 0's base = the one whose spawn is nearest the origin corner
    let centre = map.spawn[0];
    let mut out = String::new();
    out.push_str(&format!("# map {index} seed {seed} spawn {:.1} {:.1}\n", centre.x, centre.y));
    for s in map.structures.iter() {
        let far = s.pos().dist(centre) > 60.0;
        if far {
            continue;
        }
        let k = s.kind as u8;
        if k == skind::WALL {
            out.push_str(&format!(
                "W {:.3} {:.3} {:.5} {:.3} {:.3}\n",
                s.x, s.z, s.yaw, s.w, s.d
            ));
        } else if k == skind::GATE {
            out.push_str(&format!(
                "GATE {:.3} {:.3} {:.5} {:.3} {:.3}\n",
                s.x, s.z, s.yaw, s.w, s.d
            ));
        } else if s.solid() {
            out.push_str(&format!(
                "B {:.3} {:.3} {:.5} {:.3} {:.3} {}\n",
                s.x, s.z, s.yaw, s.w, s.d, k
            ));
        }
    }
    out.push_str(&format!(
        "SPAWN {:.3} {:.3}\nFLAG {:.3} {:.3}\n",
        map.spawn[0].x, map.spawn[0].y, map.flag_home[0].x, map.flag_home[0].y
    ));
    let path = "/tmp/wall_plan.txt";
    std::fs::File::create(path)
        .and_then(|mut f| f.write_all(out.as_bytes()))
        .expect("write plan dump");
    println!("wrote {path} ({} bytes)", out.len());
}

/// Human-readable dump used while fixing the generator (and as visual-proof support).
#[test]
#[ignore]
fn wall_run_table() {
    for index in 0..MAPS {
        for seed in SEEDS {
            let problems = audit_map(index, seed, true);
            if problems.is_empty() {
                println!("    OK");
            } else {
                for p in problems {
                    println!("    PROBLEM {p}");
                }
            }
        }
    }
}
