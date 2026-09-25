//! Diagnostic: replay the audit's idle-player scenario and dump *why* an AI ground hull is
//! standing still while its throttle says drive.
//!
//! Usage: cargo run --release --example stallwatch -- [map] [seed] [secs]

use rf_core::math::{v2, Vec2};
use rf_core::types::*;
use rf_core::world::{Input, World};

fn main() {
    let index: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(3);
    let seed: u32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    let secs: f32 = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(200.0);
    let mut map = rf_core::mapgen::generate(seed, index);
    rf_core::normalize_map(&mut map);
    let mut w = World::new_with_map(seed, map, [0, -1]);
    w.spawn_vehicle(vkind::JEEP, 0, 1);
    for _ in 0..8 {
        rf_core::nav::update_fields(&mut w, 1.0);
    }
    let blank = || Input::default();
    let ticks = (secs * 60.0) as usize;
    let mut stuck: Vec<u32> = vec![0; ticks];
    let mut notes: Vec<String> = vec![String::new(); ticks];
    let mut per_vehicle: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for tick in 0..ticks {
        w.step(1.0 / 60.0, &[blank(), blank()]);
        let mut parts: Vec<String> = Vec::new();
        for (i, v) in w.vehicles.iter().enumerate() {
            if v.team != 1 || v.player != 0 || !v.alive() || v.kind == vkind::TROOP {
                continue;
            }
            if !(v.vel.len() < 0.5 && v.ai_input.throttle.abs() > 0.3) {
                continue;
            }
            stuck[tick] = 1;
            let row = per_vehicle.entry(v.id).or_insert_with(|| vec![0; ticks]);
            row[tick] = 1;
            // Nearest same-team ground hull, and how it sits relative to this hull's heading.
            let dir = v2(v.yaw.sin(), v.yaw.cos());
            let mut mate = String::from("mate=none");
            let mut best = f32::MAX;
            for o in w.vehicles.iter() {
                if o.id == v.id || !o.alive() || o.team != v.team || o.spec().flying || o.kind == vkind::TROOP {
                    continue;
                }
                let d = o.pos.dist(v.pos);
                if d < best {
                    best = d;
                    let gap = d - (v.spec().radius + o.spec().radius);
                    let dot = (o.pos - v.pos).norm().dot(dir);
                    let closing = v.vel.dot(dir) - o.vel.dot(dir);
                    mate = format!(
                        "mate={}({:.1},{:.1}) gap={:.1} cone={:.2} closing={:.2} ospd={:.1}",
                        o.kind, o.pos.x, o.pos.y, gap, dot, closing, o.vel.len()
                    );
                }
            }
            let s = w.map.slope_at(v.pos.x, v.pos.y);
            let grade = s.dot(dir);
            let fwd_h = w.ground_height(v.pos + dir * 8.0) - w.ground_height(v.pos);
            let back_h = w.ground_height(v.pos - dir * 8.0) - w.ground_height(v.pos);
            let yaw_deg = v.yaw.to_degrees();
            let cell = |q: Vec2| -> u8 {
                let g = w.map.grid as i32;
                let cx = (q.x / w.map.cell).floor() as i32;
                let cz = (q.y / w.map.cell).floor() as i32;
                if cx < 0 || cz < 0 || cx >= g || cz >= g {
                    return 255;
                }
                w.map.nav[(cz * g + cx) as usize]
            };
            let f_land = w.fields.to_flag[1].sample(&w.map, v.pos);
            let f_swim = w.fields.to_flag_swim[1].sample(&w.map, v.pos);
            let c_land = w.fields.to_flag[1].cost(&w.map, v.pos);
            let c_swim = w.fields.to_flag_swim[1].cost(&w.map, v.pos);
            let f_enemy = w.fields.to_enemy[1].sample(&w.map, v.pos);
            let c_enemy = w.fields.to_enemy[1].cost(&w.map, v.pos);
            let fld = format!(
                "field={} enemy_hdg={:.0} enemy_cost={:.0} land_hdg={:.0} swim_hdg={:.0} land_cost={:.0} swim_cost={:.0} cell_here={} cell_ahead={} cell_left={} cell_right={}",
                v.ai.field,
                f_enemy.heading().to_degrees(),
                if c_enemy.is_finite() { c_enemy } else { -1.0 },
                f_land.heading().to_degrees(),
                f_swim.heading().to_degrees(),
                if c_land.is_finite() { c_land } else { -1.0 },
                if c_swim.is_finite() { c_swim } else { -1.0 },
                cell(v.pos),
                cell(v.pos + dir * 8.0),
                cell(v.pos + dir.rot(1.5707964) * 8.0),
                cell(v.pos - dir.rot(1.5707964) * 8.0),
            );
            parts.push(format!(
                "#{} {} vi={} ({:.1},{:.1}) spd={:.2} thr={:.2} steer={:.2} fwd={:.2} goal={} hp={:.0} \
                 inbase={} grade={:.3} fwd8={:+.2} back8={:+.2} yaw={:.0} stuck_t={:.1} esc={:.1} {} | {}",
                v.id,
                vehicle_name(v.kind),
                i,
                v.pos.x,
                v.pos.y,
                v.vel.len(),
                v.ai_input.throttle,
                v.ai_input.steer,
                v.fwd_speed,
                v.ai.goal,
                v.hp,
                w.inside_own_base(1, v.pos),
                grade,
                fwd_h,
                back_h,
                yaw_deg,
                v.ai.stuck_t,
                v.ai.escape_t,
                fld,
                mate,
            ));
        }
        if !parts.is_empty() {
            notes[tick] = parts.join(" ;; ");
        }
    }
    // Longest run of stuck ticks and the detail inside it.
    let (mut best, mut cur, mut best_at) = (0usize, 0usize, 0usize);
    for (i, x) in stuck.iter().enumerate() {
        if *x == 1 {
            cur += 1;
            if cur > best {
                best = cur;
                best_at = i + 1 - cur;
            }
        } else {
            cur = 0;
        }
    }
    println!(
        "map {index} seed {seed}: longest stall {:.1}s starting t={:.1}s",
        best as f32 / 60.0,
        best_at as f32 / 60.0
    );
    let from = best_at.saturating_sub(15 * 60);
    for tick in from..(best_at + best).min(ticks) {
        if tick % 30 == 0 || stuck[tick] != stuck[tick.saturating_sub(1)] {
            println!("  t={:.2}s {}", tick as f32 / 60.0, notes[tick]);
        }
    }
    // Per-vehicle runs, longest first: the audit's metric is "any hull stuck", so a run can be
    // a relay between two hulls.
    let mut runs: Vec<(u32, usize, usize)> = per_vehicle
        .iter()
        .map(|(id, v)| {
            let (mut best, mut cur, mut at) = (0usize, 0usize, 0usize);
            for (i, x) in v.iter().enumerate() {
                if *x == 1 {
                    cur += 1;
                    if cur > best {
                        best = cur;
                        at = i + 1 - cur;
                    }
                } else {
                    cur = 0;
                }
            }
            (*id, best, at)
        })
        .collect();
    runs.sort_by_key(|(_, b, _)| std::cmp::Reverse(*b));
    for (id, best, at) in runs.iter().take(4) {
        println!("  vehicle #{id}: longest {:.1}s at t={:.1}s", *best as f32 / 60.0, *at as f32 / 60.0);
    }
    // Also flash the whole-run picture every 10 s: who is where and how fast.
    for tick in (0..ticks).step_by(600) {
        let mut row: Vec<String> = Vec::new();
        for v in w.vehicles.iter() {
            if v.team != 1 || v.player != 0 || !v.alive() || v.kind == vkind::TROOP {
                continue;
            }
            let _: Vec2 = v2(0.0, 0.0);
            row.push(format!(
                "{}#{}@({:.0},{:.0}) spd={:.1} goal={}",
                vehicle_name(v.kind),
                v.id,
                v.pos.x,
                v.pos.y,
                v.vel.len(),
                v.ai.goal
            ));
        }
        println!("  sample t={:.0}s {}", tick as f32 / 60.0, row.join(" | "));
    }
}

fn vehicle_name(kind: u8) -> &'static str {
    match kind {
        vkind::JEEP => "jeep",
        vkind::TANK => "tank",
        vkind::HELI => "heli",
        vkind::HRSV => "hrsv",
        vkind::SUBMARINE => "sub",
        vkind::DRONE => "drone",
        vkind::TROOP => "troop",
        _ => "?",
    }
}
