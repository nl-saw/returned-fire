//! Diagnostic: what changes in the structure list across a round reset?
//!
//! Usage: `cargo run --release --example roundcheck -- [map_index] [seed]`

use rf_core::types::*;
use rf_core::world::{Input, World};

fn snapshot(w: &World) -> Vec<(u8, f32, f32, f32, f32, f32, f32, f32)> {
    w.map
        .structures
        .iter()
        .map(|s| (s.kind as u8, s.x, s.y, s.z, s.w, s.d, s.h, s.hp))
        .collect()
}

fn main() {
    let index: u32 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(0);
    let seed: u32 = std::env::args()
        .nth(2)
        .and_then(|a| a.parse().ok())
        .unwrap_or(11);
    // Classic is what the game boots into (`?mode=mirror` selects the older generator).
    let mode = match std::env::args().nth(3).as_deref() {
        Some("mirror") => rf_core::mapgen::MapMode::Mirror,
        _ => rf_core::mapgen::MapMode::Classic,
    };
    let mut w = World::new_with_map(
        seed,
        rf_core::mapgen::generate_mode(seed, index, mode),
        [-1, -1],
    );
    rf_core::normalize_map(&mut w.map);
    let before = snapshot(&w);
    let mut biggest: Vec<(f32, u8, f32, f32, f32)> = before
        .iter()
        .map(|s| (s.4 * s.5, s.0, s.1, s.2, s.3))
        .collect();
    biggest.sort_by(|a, b| b.0.total_cmp(&a.0));

    let blank = Input::default();
    // Wrecks are structures too: watch the list while a round is fought out.
    let mut last = w.map.structures.len();
    for tick in 0..(300.0 * 60.0) as u32 {
        w.step(1.0 / 60.0, &[blank, blank]);
        let n = w.map.structures.len();
        if n != last {
            println!(
                "t={:6.1}s structures {} -> {} ({} wrecks)",
                tick as f32 / 60.0,
                last,
                n,
                w.map.structures
                    .iter()
                    .filter(|s| s.kind as u8 == skind::WRECK)
                    .count()
            );
            last = n;
        }
    }
    // End the round the way the game does, then let the core rebuild it.
    let at_round_end = w.map.structures.len();
    w.end_round(1);
    for _ in 0..(8.0 * 60.0) as u32 {
        w.step(1.0 / 60.0, &[blank, blank]);
    }
    let after = snapshot(&w);
    println!(
        "structures: {} at boot, {} at round end, {} after the reset",
        before.len(),
        at_round_end,
        after.len()
    );
    if before.len() == after.len() {
        let mut moved = 0;
        let mut resized = 0;
        let mut retyped = 0;
        for (a, b) in before.iter().zip(after.iter()) {
            if (a.1 - b.1).abs() > 1e-3 || (a.2 - b.2).abs() > 1e-3 || (a.3 - b.3).abs() > 1e-3 {
                moved += 1;
                if moved <= 5 {
                    println!(
                        "  moved: kind {} ({:.1},{:.1},{:.1}) -> ({:.1},{:.1},{:.1})",
                        a.0, a.1, a.2, a.3, b.1, b.2, b.3
                    );
                }
            }
            if (a.4 - b.4).abs() > 1e-3 || (a.5 - b.5).abs() > 1e-3 || (a.6 - b.6).abs() > 1e-3 {
                resized += 1;
                if resized <= 5 {
                    println!(
                        "  resized: kind {} {:.1}x{:.1}x{:.1} -> {:.1}x{:.1}x{:.1}",
                        a.0, a.4, a.5, a.6, b.4, b.5, b.6
                    );
                }
            }
            if a.0 != b.0 {
                retyped += 1;
            }
        }
        println!("moved {moved}, resized {resized}, retyped {retyped}");
    }
    let mut hist = std::collections::BTreeMap::new();
    for s in w.map.structures.iter() {
        *hist.entry(s.kind as u8).or_insert(0) += 1;
    }
    // ASCII view of the pavement mask around each base: '#' paved, '.' ground, '~' water,
    // 'B' the base centre. 2 m cells, 200 m across, so a "base floor" rectangle shows up.
    let nn = (w.map.grid + 1) as usize;
    let cc = w.map.world_size / (nn - 1) as f32;
    for t in 0..2usize {
        let c = w.map.spawn[t];
        println!("pavement around base {t} (2 m cells, 100 m each way, '#'=paved):");
        for dz in -25..=25i32 {
            let mut row = String::from("  ");
            for dx in -50..=50i32 {
                let x = c.x + dx as f32 * 2.0;
                let z = c.y + dz as f32 * 2.0;
                if x < 0.0 || z < 0.0 || x >= w.map.world_size || z >= w.map.world_size {
                    row.push('?');
                    continue;
                }
                let ix = (x / cc) as usize;
                let iz = (z / cc) as usize;
                let i = iz * nn + ix;
                row.push(if (dx as f32).abs() < 1.0 && (dz as f32).abs() < 1.0 {
                    'B'
                } else if w.map.road[i] > 0 {
                    '#'
                } else if w.map.heights[i] < 0.05 {
                    '~'
                } else {
                    '.'
                });
            }
            println!("{row}");
        }
    }
    println!("structures by kind: {hist:?}");
    // How far does pavement reach from each base centre? The base walls are 48x38 m.
    let n = (w.map.grid + 1) as usize;
    let cell = w.map.world_size / (n - 1) as f32;
    for t in 0..2usize {
        let c = w.map.spawn[t];
        let mut max_d = [0.0f32; 8];
        let mut paved = 0usize;
        for iz in 0..n {
            for ix in 0..n {
                if w.map.road[iz * n + ix] == 0 {
                    continue;
                }
                let p = rf_core::math::v2(ix as f32 * cell, iz as f32 * cell);
                let d = p.dist(c);
                if d > 200.0 {
                    continue;
                }
                paved += 1;
                let a = (p.y - c.y).atan2(p.x - c.x);
                let k = (((a + std::f32::consts::PI) / (std::f32::consts::TAU / 8.0)) as usize).min(7);
                if d > max_d[k] {
                    max_d[k] = d;
                }
            }
        }
        println!(
            "base {t} at ({:.0},{:.0}): {paved} paved vertices within 200 m; extent by octant {:?}",
            c.x,
            c.y,
            max_d.map(|v| v as i32)
        );
    }
    println!("largest structures by footprint (w*d), kind, position:");
    for (area, kind, x, y, z) in biggest.iter().take(8) {
        println!("  kind {kind:>2} area {area:7.1} m^2 at ({x:.0},{y:.0},{z:.0})");
    }
}
