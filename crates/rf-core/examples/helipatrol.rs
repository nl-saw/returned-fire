//! Probe: why does a heli sometimes fly straight at the enemy main base instead of engaging?
//! Reproduces `?auto=1&seed=11&vehicle=4&size=medium&allies=1&demo=1&maxveh=5&cpu=hard` and
//! traces every helicopter: goal, acquired target, nearest enemy + LOS, heading vs the bearing
//! to the enemy flag, and whether it is firing.
//!
//! Usage: cargo run --release --example helipatrol [seconds]

use rf_core::types::*;
use rf_core::world::{aigoal, Input, World};

fn goal_name(g: u8) -> &'static str {
    match g {
        aigoal::IDLE => "idle",
        aigoal::TO_FLAG => "to_flag",
        aigoal::HOME_WITH_FLAG => "home_w_flag",
        aigoal::HUNT => "hunt",
        aigoal::ATTACK_STRUCT => "atk_struct",
        aigoal::PATROL => "patrol",
        aigoal::EVADE => "evade",
        aigoal::SUPPORT => "support",
        aigoal::HOLD => "hold",
        _ => "?",
    }
}

fn main() {
    let secs = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);

    // Exact match of the URL: seed 11, map 0 classic, medium (1024 m).
    let mut map = rf_core::mapgen::generate_sized(
        11,
        0,
        rf_core::mapgen::MapMode::Classic,
        MapSize::Medium,
    );
    rf_core::normalize_map(&mut map);
    let mut w = World::new_with_map(11, map, [0, -1]);
    w.set_options(2 /* hard */, false, true /* allies */);
    w.set_vehicle_cap(5);
    w.set_cpu_driven(0, true); // demo: the "player" slot is CPU-driven
    w.request_vehicle(0, vkind::HELI); // vehicle=4

    let blank = Input::default();
    let mut last_log = -10.0f32;
    let mut last_fire: std::collections::HashMap<u32, f32> = std::collections::HashMap::new();
    let mut last_proj_id = 0u32;

    // Per-heli aggregates (keyed by vehicle id).
    #[derive(Default)]
    struct Stats {
        air: u32,
        no_contact: u32,          // nearest enemy > 120 m
        contact_no_fire: u32,     // enemy <= 120 m with LOS, not firing within last 4 s
        hunt_not_engaging: u32,   // goal HUNT but not firing within last 4 s
        head_to_base: u32,        // heading within 45 deg of the enemy flag while moving
        head_to_target: u32,      // heading within 45 deg of its acquired target while moving
    }
    let mut stats: std::collections::HashMap<u32, Stats> = std::collections::HashMap::new();

    for tick in 0..(secs * 60) {
        w.step(1.0 / 60.0, &[blank, blank]);
        let t = tick as f32 / 60.0;

        // Shots fired this tick: new projectile ids, grouped by owner.
        for p in w.projs.iter() {
            if p.id > last_proj_id {
                last_fire.insert(p.owner, t);
            }
        }
        last_proj_id = w.projs.iter().map(|p| p.id).max().unwrap_or(0).max(last_proj_id);

        if tick % 60 != 0 {
            continue; // one sample per second
        }

        for v in w.vehicles.iter() {
            if v.kind != vkind::HELI || !v.alive() || !v.airborne {
                continue;
            }
            let team = v.team as usize;
            let enemy_flag = w.flags[1 - team].pos;
            let s = stats.entry(v.id).or_default();
            s.air += 1;

            // Nearest enemy vehicle + LOS, exactly like the AI's acquisition window.
            let mut d_ne = f32::INFINITY;
            let mut los_ne = false;
            for o in w.vehicles.iter() {
                if !o.alive() || o.team == v.team || o.kind == vkind::SUBMARINE {
                    continue;
                }
                let d = o.pos.dist(v.pos);
                if d < d_ne {
                    d_ne = d;
                    let eye = rf_core::math::v3(v.pos.x, v.center_y(), v.pos.y);
                    let tgt = rf_core::math::v3(o.pos.x, o.center_y(), o.pos.y);
                    los_ne = rf_core::ai::has_los(&w, eye, tgt, -1);
                }
            }

            let firing = last_fire.get(&v.id).is_some_and(|tf| t - tf < 4.0);
            if d_ne > 120.0 {
                s.no_contact += 1;
            }
            if d_ne <= 120.0 && los_ne && !firing {
                s.contact_no_fire += 1;
            }
            if v.ai.goal == aigoal::HUNT && !firing {
                s.hunt_not_engaging += 1;
            }

            // Where is it actually pointing?
            let spd = v.vel.len();
            if spd > 3.0 {
                let hdg = v.vel.heading();
                let mut diff = hdg - (enemy_flag - v.pos).heading();
                while diff > std::f32::consts::PI {
                    diff -= 2.0 * std::f32::consts::PI;
                }
                while diff < -std::f32::consts::PI {
                    diff += 2.0 * std::f32::consts::PI;
                }
                if diff.abs() < 0.785 {
                    s.head_to_base += 1;
                }
                let ti = w
                    .vehicles
                    .iter()
                    .position(|o| o.id == v.ai.target as u32 && o.alive());
                if let Some(ti) = ti {
                    let mut dt = hdg - (w.vehicles[ti].pos - v.pos).heading();
                    while dt > std::f32::consts::PI {
                        dt -= 2.0 * std::f32::consts::PI;
                    }
                    while dt < -std::f32::consts::PI {
                        dt += 2.0 * std::f32::consts::PI;
                    }
                    if dt.abs() < 0.785 {
                        s.head_to_target += 1;
                    }
                }
            }

            // Per-second line for helis in a suspicious state: hunting, not firing, and an
            // enemy is somewhere on the map within 300 m (visible-ish) but it is not engaging.
            let ti = w
                .vehicles
                .iter()
                .position(|o| o.id == v.ai.target as u32 && o.alive());
            let d_tgt = ti.map(|i| w.vehicles[i].pos.dist(v.pos)).unwrap_or(f32::INFINITY);
            if (v.ai.goal == aigoal::HUNT || v.ai.goal == aigoal::PATROL)
                && !firing
                && d_ne < 300.0
                && t - last_log >= 1.0
            {
                let mut db = v.vel.heading() - (enemy_flag - v.pos).heading();
                while db > std::f32::consts::PI {
                    db -= 2.0 * std::f32::consts::PI;
                }
                while db < -std::f32::consts::PI {
                    db += 2.0 * std::f32::consts::PI;
                }
                println!(
                    "t={t:5.1} team{} heli#{} @({:4.0},{:4.0}) {} tgt={} d_tgt={:5.0} \
                     nearest_enemy={:4.0} los={} spd={:4.1} off_base_bearing={:+.2}rad",
                    v.team,
                    v.id,
                    v.pos.x,
                    v.pos.y,
                    goal_name(v.ai.goal),
                    if ti.is_some() { format!("#{}", w.vehicles[ti.unwrap()].id) } else { "-".into() },
                    d_tgt,
                    d_ne,
                    los_ne,
                    spd,
                    db,
                );
            }
        }

        if t - last_log >= 30.0 {
            last_log = t;
            let a = w.score[0];
            let b = w.score[1];
            println!(
                "t={t:5.0}s score=({a}:{b}) helis: {}",
                stats
                    .iter()
                    .map(|(id, s)| {
                        format!(
                            "#{} air={}s no_contact={} contact_no_fire={} hunt_not_engaging={} head_base={} head_tgt={}",
                            id, s.air, s.no_contact, s.contact_no_fire, s.hunt_not_engaging, s.head_to_base, s.head_to_target
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
        }
    }

    println!("\nSUMMARY (per heli):");
    let mut rows: Vec<_> = stats.iter().collect();
    rows.sort_by_key(|(_, v)| v.air);
    for (id, s) in rows {
        println!(
            "  heli#{}: air={}s  no_contact(>120m)={} ({:.0}%)  contact_<=120m+LOS_no_fire={} ({:.0}%)  \
             hunt_not_engaging={} ({:.0}%)  heading_to_base={} ({:.0}%)  heading_to_target={} ({:.0}%)",
            id,
            s.air,
            s.no_contact,
            100.0 * s.no_contact as f32 / s.air.max(1) as f32,
            s.contact_no_fire,
            100.0 * s.contact_no_fire as f32 / s.air.max(1) as f32,
            s.hunt_not_engaging,
            100.0 * s.hunt_not_engaging as f32 / s.air.max(1) as f32,
            s.head_to_base,
            100.0 * s.head_to_base as f32 / s.air.max(1) as f32,
            s.head_to_target,
            100.0 * s.head_to_target as f32 / s.air.max(1) as f32,
        );
    }
}
