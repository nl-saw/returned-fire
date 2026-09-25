//! Is wall-breaching symmetric? Per side, over an AI-vs-AI round: how much of the *enemy* base's
//! perimeter each team knocks down, and how often the breach branch's preconditions actually held.
//!
//! `cargo run --release --example breachwatch -- [seconds] [map] [seed]`

use rf_core::types::*;
use rf_core::world::{Input, World};

fn main() {
    let secs: f32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(300.0);
    let index: u32 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    let seed: u32 = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(11);

    // Two field shapes: both teams CPU (symmetric), and the player's team with a human hull parked
    // at base plus its AI allies - which is what a real match looks like, and what the reported
    // asymmetry was observed in.
    for (mode, players, label) in [
        (rf_core::mapgen::MapMode::Classic, [-1, -1], "both CPU"),
        (rf_core::mapgen::MapMode::Classic, [0, -1], "player parked + allies"),
    ] {
        let mut w = World::new_with_map(seed, rf_core::mapgen::generate_mode(seed, index, mode), players);
        rf_core::normalize_map(&mut w.map);
        if players[0] >= 0 {
            w.set_options(1, false, true);
            w.spawn_vehicle(vkind::JEEP, 0, 1);
        }
        // Each team's own perimeter walls, and the flag they defend.
        let mut walls: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
        for (i, s) in w.map.structures.iter().enumerate() {
            if s.kind as u8 != skind::WALL {
                continue;
            }
            let t = (s.team as usize).min(1);
            if s.team < 2.0 && s.pos().dist(w.flags[t].home) < 45.0 {
                walls[t].push(i);
            }
        }
        let hp0: [f32; 2] = [
            walls[0].iter().map(|i| w.map.structures[*i].hp).sum(),
            walls[1].iter().map(|i| w.map.structures[*i].hp).sum(),
        ];
        let blank = Input::default();
        for _ in 0..(secs * 60.0) as u32 {
            w.step(1.0 / 60.0, &[blank, blank]);
        }
        let hp1: [f32; 2] = [
            walls[0].iter().map(|i| if w.map.structures[*i].alive() { w.map.structures[*i].hp } else { 0.0 }).sum(),
            walls[1].iter().map(|i| if w.map.structures[*i].alive() { w.map.structures[*i].hp } else { 0.0 }).sum(),
        ];
        let _ = mode;
        println!(
            "{label} (map {index} seed {seed}, {secs:.0}s): team 0's walls lost {:.0}, team 1's walls lost {:.0}",
            hp0[0] - hp1[0],
            hp0[1] - hp1[1],
        );
    }
}
