//! Diagnostic: road ends that are not supposed to be there.
//!
//! A road may stop at a base gate, on a bridge abutment, or at the garage it serves. Anywhere
//! else it is a dead end — and the reported look is a road that simply stops in the middle of
//! the map because water, terrain or the road filters cut it there.
//!
//! This walks the stamped road raster (what the renderer and the nav grid actually see, after
//! every scrub and prune), finds road vertices with only one road neighbour, and reports the
//! ones that are nowhere near a legitimate terminus — with how close each sits to water, since
//! "the road was cut at the shoreline" is the usual cause.
//!
//! Usage: `cargo run --release --example roadends -- [map_index] [seed] [classic|mirror]`

use rf_core::math::v2;
use rf_core::mapgen::MapMode;
use rf_core::types::*;

fn main() {
    let index: u32 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(0);
    let seed: u32 = std::env::args()
        .nth(2)
        .and_then(|a| a.parse().ok())
        .unwrap_or(1);
    let mode = match std::env::args().nth(3).as_deref() {
        Some("mirror") => MapMode::Mirror,
        _ => MapMode::Classic,
    };
    let mut map: MapData = rf_core::mapgen::generate_mode(seed, index, mode);
    rf_core::normalize_map(&mut map);
    // A `World` owns the map and knows where the gates are.
    let world = rf_core::world::World::new_with_map(seed, map, [-1, -1]);
    let map = &world.map;
    let w = map.world_size;
    let n = (map.grid + 1) as usize; // road raster is per terrain vertex
    let cell = w / (n - 1) as f32;

    let road_at = |ix: i32, iz: i32| -> bool {
        if ix < 0 || iz < 0 || ix >= n as i32 || iz >= n as i32 {
            return false;
        }
        map.road[iz as usize * n + ix as usize] > 0
    };
    let water_at = |ix: i32, iz: i32| -> bool {
        if ix < 0 || iz < 0 || ix >= n as i32 || iz >= n as i32 {
            return false;
        }
        map.heights[iz as usize * n + ix as usize] < 0.05
    };

    // Legitimate termini: the base gates, the pads, the flag stands and any bridge deck (a road
    // is allowed to stop at an abutment), plus the garage doors of the two bases.
    let mut termini: Vec<rf_core::Vec2> = Vec::new();
    for t in 0..2u8 {
        if let Some(g) = world.gate_pos(t) {
            termini.push(g);
        }
        termini.push(map.spawn[t as usize]);
        termini.push(map.flag_home[t as usize]);
    }
    for s in map.structures.iter() {
        let k = s.kind as u8;
        if k == skind::BRIDGE || k == skind::GARAGE || k == skind::HELIPAD || k == skind::HQ {
            termini.push(s.pos());
        }
    }

    // A free end is a road vertex whose road neighbours all lie in one direction: the ribbon
    // stops there. Sweep the eight compass sectors at two radii and require the occupied
    // sectors to span less than a half turn.
    let sectors_at = |ix: i32, iz: i32| -> u32 {
        let mut mask = 0u32;
        for (k, (dx, dz)) in [
            (1i32, 0i32),
            (1, 1),
            (0, 1),
            (-1, 1),
            (-1, 0),
            (-1, -1),
            (0, -1),
            (1, -1),
        ]
        .iter()
        .enumerate()
        {
            for r in 1..=3i32 {
                if road_at(ix + dx * r, iz + dz * r) {
                    mask |= 1 << k;
                    break;
                }
            }
        }
        mask
    };
    // Largest gap between occupied sectors, in eighths of a turn.
    let span = |mask: u32| -> u32 {
        if mask == 0 {
            return 0;
        }
        let mut best = 0;
        for start in 0..8u32 {
            let mut run = 0;
            while run < 8 && mask & (1 << ((start + run) % 8)) != 0 {
                run += 1;
            }
            best = best.max(run);
        }
        best
    };
    let mut ends: Vec<(rf_core::Vec2, f32, f32)> = Vec::new();
    let mut road_verts = 0usize;
    for iz in 0..n as i32 {
        for ix in 0..n as i32 {
            if !road_at(ix, iz) {
                continue;
            }
            road_verts += 1;
            // Only the ribbon's own cells: a cap is where at most a half turn is occupied.
            if span(sectors_at(ix, iz)) > 4 {
                continue;
            }
            let p = v2(ix as f32 * cell, iz as f32 * cell);
            let mut water = 99.0f32; // no water inside the scanned radius
            'scan: for r in 1..=10i32 {
                for dz in -r..=r {
                    for dx in -r..=r {
                        if water_at(ix + dx, iz + dz) {
                            water = r as f32 * cell;
                            break 'scan;
                        }
                    }
                }
            }
            let mut term = f32::INFINITY;
            for t in termini.iter() {
                term = term.min(p.dist(*t));
            }
            ends.push((p, water, term));
        }
    }

    // Merge ends that are within 8 m of each other (one stub can produce a few vertices).
    let mut merged: Vec<(rf_core::Vec2, f32, f32)> = Vec::new();
    for e in ends.iter() {
        if let Some(m) = merged.iter_mut().find(|m| m.0.dist(e.0) < 8.0) {
            if e.1 < m.1 {
                *m = *e;
            }
            continue;
        }
        merged.push(*e);
    }

    // Whole-map view: 64 x 32 cells (a terminal cell is twice as tall as it is wide), road
    // where any vertex of the cell is paved, '~' for water, '.' for open ground.
    if std::env::args().any(|a| a == "map") {
        const COLS: usize = 64;
        const ROWS: usize = 32;
        println!("road map ('#' road/route, '~' water, '.' ground):");
        for iz in 0..ROWS {
            let mut row = String::from("  ");
            for ix in 0..COLS {
                let (x0, x1) = (ix as f32 / COLS as f32 * w, (ix + 1) as f32 / COLS as f32 * w);
                let (z0, z1) = (iz as f32 / ROWS as f32 * w, (iz + 1) as f32 / ROWS as f32 * w);
                let (mut paved, mut wet) = (false, 0);
                let mut samples = 0;
                let mut x = x0;
                while x < x1 {
                    let mut z = z0;
                    while z < z1 {
                        let qx = ((x / cell) as usize).min(n - 1);
                        let qz = ((z / cell) as usize).min(n - 1);
                        paved |= map.road[qz * n + qx] > 0;
                        if map.heights[qz * n + qx] < 0.05 {
                            wet += 1;
                        }
                        samples += 1;
                        z += cell;
                    }
                    x += cell;
                }
                row.push(if paved {
                    '#'
                } else if wet * 2 > samples {
                    '~'
                } else {
                    '.'
                });
            }
            println!("{row}");
        }
    }

    // A true tip: a free end with no junction cell (road in six or more sectors) nearby. A cap
    // at a corner of a junction or a plaza has one within a couple of cells and is not a dead
    // end, however ragged the raster looks there.
    let busy = |ix: i32, iz: i32| -> bool { span(sectors_at(ix, iz)) >= 6 };
    let is_tip = |p: rf_core::Vec2| -> bool {
        let ix = ((p.x / cell) as i32).clamp(0, n as i32 - 1);
        let iz = ((p.y / cell) as i32).clamp(0, n as i32 - 1);
        for dz in -3..=3i32 {
            for dx in -3..=3i32 {
                if busy(ix + dx, iz + dz) {
                    return false;
                }
            }
        }
        true
    };
    let tips: Vec<&(rf_core::Vec2, f32, f32)> = merged
        .iter()
        .filter(|(p, _, term)| *term > 30.0 && is_tip(*p))
        .collect();
    println!(
        "  {} of the free ends are true tips (no junction within 6 m); {} of those are more than \
         30 m from any terminus",
        merged.iter().filter(|(p, _, _)| is_tip(*p)).count(),
        tips.len()
    );
    let bad: Vec<&(rf_core::Vec2, f32, f32)> =
        merged.iter().filter(|(_, _, term)| *term > 30.0).collect();
    // The reported class: a road that stops near the water with no terminus to justify it —
    // "interrupted by terrain/water" — rather than a junction tip on dry land.
    let shoreline: Vec<&(rf_core::Vec2, f32, f32)> = merged
        .iter()
        .filter(|(_, water, term)| *water < 25.0 && *term > 30.0)
        .collect();
    println!(
        "map {index} seed {seed} {mode:?} ({w:.0} m): {road_verts} road vertices, {} road ends, \
         {} of them more than 30 m from any gate/pad/flag/bridge/garage",
        merged.len(),
        bad.len()
    );
    // The reported bug's fingerprint: a free end sitting just outside the asphalt scrub's
    // clearance, i.e. pavement that was stamped and then cut at the waterline.
    let cut_band: Vec<&(rf_core::Vec2, f32, f32)> = merged
        .iter()
        .filter(|(_, water, term)| (10.0..20.0).contains(water) && *term > 30.0)
        .collect();
    println!(
        "  of those, {} stop within 25 m of water with no terminus (interrupted by water); {} \
         sit in the 10-20 m band just outside the scrub's 11 m cut, which is what a \
         stamped-then-cut road end looks like",
        shoreline.len(),
        cut_band.len()
    );
    // The faithful reading of "dead end": from a free end, how far do you drive before you
    // reach a junction? A cap that is 30+ m from the nearest junction, and not at a terminus,
    // is a branch that just stops. Junction = a road cell with road in six or more of the
    // eight compass sectors.
    let mut long_ends = 0usize;
    let mut worst = 0f32;
    for (p, _water, term) in merged.iter() {
        if *term <= 30.0 {
            continue;
        }
        let ix = ((p.x / cell) as i32).clamp(0, n as i32 - 1);
        let iz = ((p.y / cell) as i32).clamp(0, n as i32 - 1);
        let mut seen = std::collections::HashSet::new();
        let mut frontier = vec![(ix, iz)];
        let mut found = None;
        seen.insert((ix, iz));
        for step in 0..40 {
            let dist = step as f32 * cell;
            let mut next = Vec::new();
            let mut hit = false;
            for (cx, cz) in frontier.iter() {
                for dz in -1..=1i32 {
                    for dx in -1..=1i32 {
                        let (qx, qz) = (cx + dx, cz + dz);
                        if qx < 0 || qz < 0 || qx >= n as i32 || qz >= n as i32 {
                            continue;
                        }
                        if !road_at(qx, qz) || !seen.insert((qx, qz)) {
                            continue;
                        }
                        if busy(qx, qz) {
                            hit = true;
                        }
                        next.push((qx, qz));
                    }
                }
            }
            if hit {
                found = Some(dist);
                break;
            }
            if next.is_empty() {
                break;
            }
            frontier = next;
        }
        if let Some(d) = found {
            if d > 30.0 {
                long_ends += 1;
                worst = worst.max(d);
            }
        }
    }
    println!(
        "  {} free ends are more than 30 m from the nearest junction (worst {worst:.0} m) — \
         a branch that simply stops",
        long_ends
    );
    for (p, water, term) in merged.iter().take(40) {
        let flag = if *term > 30.0 { "  <-- DEAD END" } else { "" };
        // What is stamped there: a route lane is 255, a plan road 232/246, a track 120.
        let ix = ((p.x / cell) as i32).clamp(0, n as i32 - 1) as usize;
        let iz = ((p.y / cell) as i32).clamp(0, n as i32 - 1) as usize;
        let mut peak = 0u8;
        for dz in -2..=2i32 {
            for dx in -2..=2i32 {
                let qx = (ix as i32 + dx).clamp(0, n as i32 - 1) as usize;
                let qz = (iz as i32 + dz).clamp(0, n as i32 - 1) as usize;
                peak = peak.max(map.road[qz * n + qx]);
            }
        }
        let kind = match peak {
            255 => "route lane",
            246 => "paved road",
            232 => "road",
            120 => "track",
            _ => "faint",
        };
        println!(
            "  ({:6.1},{:6.1})  water {water:5.1} m away, nearest terminus {term:6.1} m, level \
             {peak} ({kind}){flag}",
            p.x, p.y
        );
        if *term > 30.0 {
            // A 60 x 30 m window: '#' road, ':' route lane, '~' water, '-' dry ground.
            for dz in -13..=13i32 {
                let mut row = String::from("        ");
                for dx in -15..=15i32 {
                    let qx = ix as i32 + dx;
                    let qz = iz as i32 + dz;
                    if qx < 0 || qz < 0 || qx >= n as i32 || qz >= n as i32 {
                        row.push('?');
                        continue;
                    }
                    let (ux, uz) = (qx as usize, qz as usize);
                    let level = map.road[uz * n + ux];
                    row.push(if level == 255 {
                        ':'
                    } else if level > 0 {
                        '#'
                    } else if map.heights[uz * n + ux] < 0.05 {
                        '~'
                    } else {
                        '-'
                    });
                }
                println!("{row}");
            }
        }
    }
}
