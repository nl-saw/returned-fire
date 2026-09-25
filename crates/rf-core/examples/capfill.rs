//! Why a raised vehicle cap does or does not fill: per-team hulls, yard occupancy and the
//! parked reserve, sampled over time, with the commander's own gate conditions.
//!
//! `cargo run --release --example capfill -- [cap] [difficulty] [seconds]`

use rf_core::types::*;
use rf_core::world::{Input, World};

fn main() {
    let cap: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(16);
    let diff: u32 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(2);
    let secs: f32 = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(240.0);

    let mut w = World::new_with_map(
        11,
        rf_core::mapgen::generate_mode(11, 0, rf_core::mapgen::MapMode::Classic),
        [-1, -1],
    );
    rf_core::normalize_map(&mut w.map);
    w.set_options(diff, false, false);
    w.set_vehicle_cap(cap);
    let blank = Input::default();
    let mut peak = [0usize; 2];
    let mut sum = [0f64; 2];
    let mut ticks = 0f64;
    let mut spawned = [0usize; 2];
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut blocked_yard = 0usize;
    let mut last_spawn = [-1.0f32; 2];
    let mut min_gap = [f32::MAX; 2];
    for tick in 0..(secs * 60.0) as u32 {
        w.step(1.0 / 60.0, &[blank, blank]);
        let t = tick as f32 / 60.0;
        let mut live = [0usize; 2];
        let mut home = [0usize; 2];
        for v in w.vehicles.iter() {
            if !v.alive() || v.player != 0 {
                continue;
            }
            if !matches!(v.kind, vkind::JEEP | vkind::TANK | vkind::HRSV | vkind::HELI) {
                continue;
            }
            let team = v.team as usize;
            live[team] += 1;
            if w.in_home_zone(v.team, v.pos) {
                home[team] += 1;
            }
        }
        for team in 0..2 {
            peak[team] = peak[team].max(live[team]);
            sum[team] += live[team] as f64;
        }
        ticks += 1.0;
        for v in w.vehicles.iter() {
            if v.player == 0 && seen.insert(v.id) {
                spawned[v.team as usize] += 1;
                let last = last_spawn[v.team as usize];
                if last >= 0.0 {
                    let gap = t - last;
                    min_gap[v.team as usize] = min_gap[v.team as usize].min(gap);
                }
                last_spawn[v.team as usize] = t;
            }
        }
        if (t * 60.0) as u32 % 1800 == 0 {
            let parked: Vec<i32> = (0..4).map(|i| w.garage[team_of(&w, 1)].parked[i] as i32).collect();
            println!(
                "t={t:5.0}s live {:?} in-home {:?} | team1 parked {parked:?} building {:?} ally_cd {:.1}",
                live,
                home,
                (0..4).map(|i| w.garage[1].building[i] as i32).collect::<Vec<_>>(),
                w.ally_cd[1],
            );
        }
    }
    println!(
        "cap {cap} diff {diff}: peak {peak:?}, mean live [{:.1}, {:.1}], CPU spawns {spawned:?}, smallest gap between two spawns {min_gap:?}",
        sum[0] / ticks,
        sum[1] / ticks
    );
    let _ = blocked_yard;
}

fn team_of(_w: &World, t: usize) -> usize {
    t
}
