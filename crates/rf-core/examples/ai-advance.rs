//! AI advance probe (bug repro): run an all-AI game on a named map and log, every few
//! seconds, where each vehicle is relative to its own flag home, plus its current goal.
//! A hull that "camps" shows up as a flat distance-from-base trace with a HOLD/ATTACK goal.
//!
//!   cargo run --release --example ai-advance [map_index] [size 0=small 1=medium 2=big] [seconds]

use rf_core::world::aigoal;

fn goal_name(g: u8) -> &'static str {
    match g {
        aigoal::TO_FLAG => "TO_FLAG",
        aigoal::HOME_WITH_FLAG => "HOME_FLG",
        aigoal::HUNT => "HUNT",
        aigoal::ATTACK_STRUCT => "ATK_STR",
        aigoal::PATROL => "PATROL",
        aigoal::HOLD => "HOLD",
        _ => "?",
    }
}

fn kind_name(k: u8) -> &'static str {
    match k {
        rf_core::types::vkind::JEEP => "jeep",
        rf_core::types::vkind::TANK => "tank",
        rf_core::types::vkind::HRSV => "MLRS",
        rf_core::types::vkind::HELI => "heli",
        rf_core::types::vkind::TROOP => "troop",
        rf_core::types::vkind::DRONE => "drone",
        rf_core::types::vkind::SUBMARINE => "sub",
        _ => "?",
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let map_index: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let size_idx: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let secs: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(240);
    let size = match size_idx {
        0 => rf_core::types::MapSize::Small,
        2 => rf_core::types::MapSize::Big,
        _ => rf_core::types::MapSize::Medium,
    };

    for seed in [7u32, 1337] {
        let map = rf_core::mapgen::generate_sized(seed, map_index, rf_core::mapgen::MapMode::Classic, size);
        let mut w = rf_core::world::World::new_with_map(seed, map, [-1, -1]);
        for _ in 0..8 {
            rf_core::nav::update_fields(&mut w, 1.0);
        }
        let blank = [rf_core::world::Input::default(); 2];

        println!("=== map {} seed {} ({:?}) ===", map_index, seed, size);
        // max distance from own base seen per (team, kind), to summarise the advance.
        let mut maxd: [[f32; 8]; 2] = [[0.0; 8]; 2];
        for t in 0..secs * 60 {
            w.step(1.0 / 60.0, &blank);
            if (t + 1) % (15 * 60) == 0 {
                let ts = (t + 1) / 60;
                for v in w.vehicles.iter().filter(|v| v.alive() && v.player == 0) {
                    let home = w.flags[v.team as usize].home;
                    let d = v.pos.dist(home);
                    maxd[v.team as usize][v.kind as usize] = maxd[v.team as usize][v.kind as usize].max(d);
                    println!(
                        "t={:4}s team={} {:5} pos=({:6.1},{:6.1}) d_home={:6.1}m goal={:8} tgt={:3} spd={:4.1} thr={:4.2} stuck={:4.1}",
                        ts,
                        v.team,
                        kind_name(v.kind),
                        v.pos.x,
                        v.pos.y,
                        d,
                        goal_name(v.ai.goal),
                        v.ai.target,
                        v.fwd_speed,
                        v.ai_input.throttle,
                        v.ai.stuck_t.max(0.0),
                    );
                }
            }
        }
        println!("max distance from own base per team/kind:");
        for team in 0..2usize {
            let parts: Vec<String> = (0..8)
                .filter(|&k| maxd[team][k] > 0.0)
                .map(|k| format!("{}={:.0}m", kind_name(k as u8), maxd[team][k]))
                .collect();
            println!("  team {}: {}", team, parts.join(" "));
        }
    }
}
