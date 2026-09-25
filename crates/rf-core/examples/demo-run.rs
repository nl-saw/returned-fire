//! Probe: attract/demo mode (`?auto=1&demo=1`). The player's hull is CPU-driven via
//! `set_cpu_driven(0, true)`, so the simulation's own AI must drive it like any other driver:
//! leave the pad, navigate, pick targets and fight the enemy — with no blind autopilot (no
//! friendly fire by construction, no map-edge riding), and without summoning anti-camping
//! drones (those punish players, not drivers).
//!
//! Usage: cargo run --release --example demo-run [seconds]

use rf_core::types::*;
use rf_core::world::{Input, World};

fn main() {
    let secs = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(240);

    let mut map = rf_core::mapgen::generate(3, 0);
    rf_core::normalize_map(&mut map);
    let mut w = World::new_with_map(3, map, [0, -1]);
    // Attract mode: the "player" hull is driven by the CPU.
    w.set_cpu_driven(0, true);

    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    let home = w.vehicles[w.vehicle_index(id).unwrap()].pos;
    println!("demo jeep #{} at ({:.1},{:.1})", id, home.x, home.y);

    fn kind_name(kind: u8) -> &'static str {
        match kind {
            vkind::JEEP => "jeep",
            vkind::TANK => "tank",
            vkind::HRSV => "hrsv",
            vkind::HELI => "heli",
            vkind::TROOP => "troop",
            vkind::SUBMARINE => "submarine",
            _ => "?",
        }
    }

    let blank = Input::default();
    let mut max_dist = 0.0f32;
    let mut fired_by_demo = 0u32; // projectiles whose owner is the demo hull
    let mut last_log = -10.0f32;
    let mut last_hp: Vec<(u32, f32)> = Vec::new();
    let mut last_proj_id = 0u32;
    let mut round_start = 0.0f32;
    let mut prev_state = w.state;

    for tick in 0..(secs * 60) {
        w.step(1.0 / 60.0, &[blank, blank]);
        let t = tick as f32 / 60.0;

        // Count shots the demo hull fires: new projectile ids owned by it (ids are monotonic).
        let newest = w.projs.iter().map(|p| p.id).max().unwrap_or(0);
        for p in w.projs.iter() {
            if p.owner == id && p.id > last_proj_id {
                fired_by_demo += 1;
            }
        }
        last_proj_id = newest.max(last_proj_id);

        if let Some(vi) = w.vehicle_index(id) {
            max_dist = max_dist.max(w.vehicles[vi].pos.dist(home));
        }

        // Friendly-fire audit: any team-0 vehicle other than the demo hull taking damage?
        for v in w.vehicles.iter() {
            if v.team != 0 || v.id == id || !v.alive() {
                continue;
            }
            let hp = v.hp;
            match last_hp.iter_mut().find(|(vid, _)| *vid == v.id) {
                Some((_, prev)) if *prev > hp + 1e-3 => println!(
                    "  t={t:.1} FRIENDLY DAMAGE? team0 #{} {} hp {prev:.0}->{hp:.0}",
                    v.id,
                    kind_name(v.kind)
                ),
                Some((_, prev)) => *prev = hp,
                None => last_hp.push((v.id, hp)),
            }
        }

        // Per-second detail for the first 40 s of each round: goal + nearest enemy distance.
        if prev_state != matchstate::PLAYING && w.state == matchstate::PLAYING {
            round_start = t; // a new round just started
        }
        prev_state = w.state;
        if tick % 60 == 0 && t - round_start < 40.0 {
            let mut d_ne = f32::INFINITY;
            for v in w.vehicles.iter() {
                if v.team == 1 && v.alive() && v.kind != vkind::SUBMARINE {
                    if let Some(vi) = w.vehicle_index(id) {
                        d_ne = d_ne.min(w.vehicles[vi].pos.dist(v.pos));
                    }
                }
            }
            let goal = w
                .vehicle_index(id)
                .map(|vi| w.vehicles[vi].ai.goal)
                .unwrap_or(u8::MAX);
            println!("  t={t:5.1} goal={goal} d_nearest_enemy={d_ne:.0}");
        }

        if t - last_log >= 20.0 {
            last_log = t;
            let (alive, pos, goal, spd, hp) = match w.vehicle_index(id) {
                Some(vi) => (
                    w.vehicles[vi].alive(),
                    w.vehicles[vi].pos,
                    w.vehicles[vi].ai.goal,
                    w.vehicles[vi].vel.len(),
                    w.vehicles[vi].hp,
                ),
                None => (false, rf_core::math::v2(0.0, 0.0), u8::MAX, 0.0, 0.0),
            };
            let t1 = w
                .vehicles
                .iter()
                .filter(|v| v.team == 1 && v.alive())
                .count();
            let state_str = if w.state == matchstate::PLAYING { "playing" } else { "ended" };
            let (px, pz) = (pos.x, pos.y);
            let drones = w.drone_count;
            let score = w.score;
            println!(
                "t={t:5.0}s demo alive={alive} @({px:.0},{pz:.0}) d_home={max_dist:5.1} goal={goal} \
                 spd={spd:4.1} hp={hp:3.0} team1_alive={t1} fired_by_demo={fired_by_demo} \
                 drones={drones} score={score:?} state={state_str}"
            );
        }
    }

    let alive = w.vehicle_index(id).map(|i| w.vehicles[i].alive()).unwrap_or(false);
    println!(
        "\nSUMMARY: max_dist_from_home={max_dist:.1}m demo_alive_at_end={} fired_by_demo={fired_by_demo} drones_spawned={} score={:?}",
        alive, w.drone_count, w.score
    );
}
