//! Diagnostic: how the flag-running jeeps handle the *enemy* main base.
//!
//! The report is "in demo mode I see them stuck in the base too much". A jeep is supposed to
//! find a way in, take that route, grab the flag, and find a way out again. This runs a real
//! map under AI command and measures every jeep visit to the enemy base *area* (the perimeter
//! plus an approach margin), splitting it into:
//!
//! * time spent inside the perimeter,
//! * time spent stalled — a 3 s window that moved the hull less than 2 m (instantaneous speed
//!   is useless: a hull grinding on a wall spikes above any threshold),
//! * where the stalled samples cluster in base-local coordinates (front gate at +z, sally port
//!   at -z), and whether the hull was carrying the flag at the time.
//!
//! Usage: `cargo run --release --example jeepbase -- [secs] [map_index] [seed] [ai|idle]`

use rf_core::types::*;
use rf_core::world::{Input, World};

/// Radius around the enemy base anchor that counts as "at the base": the perimeter is
/// 48x38 m, so this is the walls plus a short approach margin. (The generator's own half
/// extents are crate-private, hence a radius rather than a box.)
const BASE_RADIUS: f32 = 55.0;

#[derive(Default, Clone)]
struct Visit {
    team: u8,
    secs: f32,
    stalled: f32,
    inside_secs: f32,
    reached_inside: bool,
    carried_flag: bool,
    died: bool,
    longest_stall: f32,
    stall_at: (f32, f32),
    cells: Vec<(i32, i32)>,
}

struct Open {
    visit: Visit,
    run: f32,
    window: Option<(f32, rf_core::Vec2)>,
}

fn main() {
    let secs: f32 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(900.0);
    let index: u32 = std::env::args()
        .nth(2)
        .and_then(|a| a.parse().ok())
        .unwrap_or(0);
    let seed: u32 = std::env::args()
        .nth(3)
        .and_then(|a| a.parse().ok())
        .unwrap_or(1);
    let mode = std::env::args().nth(4).unwrap_or_else(|| "ai".into());
    let both_ai = mode != "idle" && mode != "idle-nw";
    // `idle-nw` mirrors the audit's scenario exactly: no field warm-up before the first step.
    let warm = mode != "idle-nw";

    let mut map = rf_core::mapgen::generate(seed, index);
    // The game path normalises the generated map (lane widths, structure shoulders); measuring
    // an unnormalised one is a different island from the one that actually gets played.
    rf_core::normalize_map(&mut map);
    let players = if both_ai { [-1, -1] } else { [0, -1] };
    let mut w = World::new_with_map(seed, map, players);
    if !both_ai {
        // The idle-player scenario needs an actual parked hull on team 0: it is what keeps
        // that team's home zone protected, which is the whole subject of this measurement.
        let _ = w.spawn_vehicle(vkind::JEEP, 0, 1);
    }
    if warm {
        for _ in 0..8 {
            rf_core::nav::update_fields(&mut w, 1.0);
        }
    }

    let blank = Input::default();
    let mut visits: Vec<Visit> = Vec::new();
    let mut open: Vec<Option<Open>> = Vec::new();
    let mut captures: Vec<f32> = Vec::new();
    let mut capture_teams: Vec<u8> = Vec::new();
    let mut score = 0.0f32;

    let ticks = (secs * 60.0) as u32;
    for tick in 0..ticks {
        w.step(1.0 / 60.0, &[blank, blank]);
        let t = tick as f32 / 60.0;
        if w.score[0] + w.score[1] > score + 0.5 {
            score = w.score[0] + w.score[1];
            // Which team scored matters: the audit counts team 1 only.
            captures.push(t);
            capture_teams.push(if w.score[0] > 0.0 { 0 } else { 1 });
        }
        open.resize_with(w.vehicles.len(), || None);
        for (vi, v) in w.vehicles.iter().enumerate() {
            if v.kind != vkind::JEEP {
                continue;
            }
            let enemy = 1 - v.team;
            // "At the base" = inside the perimeter or within the approach margin of it.
            let local = w.base_local(enemy, v.pos);
            let near = w.map.base_anchor[enemy.min(1) as usize].0.len_sq() > 0.01
                && v.pos.dist(w.map.base_anchor[enemy.min(1) as usize].0) <= BASE_RADIUS;
            let inside = w.inside_own_base(enemy, v.pos);
            let local = local.unwrap_or_default();
            match (&mut open[vi], near) {
                (slot @ None, true) => {
                    *slot = Some(Open {
                        visit: Visit {
                            team: v.team,
                            carried_flag: v.carrying_flag(),
                            stall_at: (local.x, local.y),
                            ..Default::default()
                        },
                        run: 0.0,
                        window: Some((t, v.pos)),
                    });
                }
                (Some(o), true) => {
                    o.visit.secs += 1.0 / 60.0;
                    o.visit.carried_flag |= v.carrying_flag();
                    o.visit.died |= v.hp <= 0.0;
                    if inside {
                        o.visit.inside_secs += 1.0 / 60.0;
                        o.visit.reached_inside = true;
                    }
                    // A wreck is not a stall: dead hulls sit where they died for a couple of
                    // seconds before the cull, and counting them made the first version of
                    // this measurement report 43% "stalled" at the base.
                    if let Some((t0, p0)) = o.window {
                        if t - t0 >= 3.0 {
                            if v.alive() && v.pos.dist(p0) < 2.0 {
                                o.visit.stalled += t - t0;
                                o.run += t - t0;
                                o.visit.longest_stall = o.visit.longest_stall.max(o.run);
                                o.visit.stall_at = (local.x, local.y);
                                o.visit.cells.push((local.x as i32 / 8, local.y as i32 / 8));
                            } else {
                                o.run = 0.0;
                            }
                            o.window = Some((t, v.pos));
                        }
                    } else {
                        o.window = Some((t, v.pos));
                    }
                }
                (Some(_), false) => {
                    if let Some(o) = open[vi].take() {
                        visits.push(o.visit);
                    }
                }
                (None, false) => {}
            }
        }
    }
    for slot in open.iter_mut() {
        if let Some(o) = slot.take() {
            visits.push(o.visit);
        }
    }

    let total: f32 = visits.iter().map(|v| v.secs).sum();
    let stalled: f32 = visits.iter().map(|v| v.stalled).sum();
    let inside: f32 = visits.iter().map(|v| v.inside_secs).sum();
    let inside_stalled: f32 = visits
        .iter()
        .filter(|v| v.reached_inside)
        .map(|v| v.stalled)
        .sum();
    let deaths = visits.iter().filter(|v| v.died).count();
    let carrying: Vec<&Visit> = visits.iter().filter(|v| v.carried_flag).collect();
    println!(
        "map {index} seed {seed} {} {secs:.0}s: {} visits to the enemy base | {:.0}s at the base, \
         {:.0}s inside the walls | stalled {:.0}s ({:.0}% of the visit time) | {} visits ended in \
         a kill | captures at {:?}",
        if both_ai { "AI-vs-AI" } else { "idle-player" },
        visits.len(),
        total,
        inside,
        stalled,
        100.0 * stalled / total.max(1.0),
        deaths,
        captures
            .iter()
            .zip(capture_teams.iter())
            .map(|(t, team)| format!("t{}:{}", *t as i32, team))
            .collect::<Vec<_>>()
    );
    println!(
        "  flag-carrying visits: {} ({:.0}s, stalled {:.0}s) | stalled while inside the walls: {:.0}s",
        carrying.len(),
        carrying.iter().map(|v| v.secs).sum::<f32>(),
        carrying.iter().map(|v| v.stalled).sum::<f32>(),
        inside_stalled
    );
    let mut worst: Vec<&Visit> = visits.iter().collect();
    worst.sort_by(|a, b| b.stalled.total_cmp(&a.stalled));
    for v in worst.iter().take(8) {
        println!(
            "  team {} visit {:5.1}s (inside {:4.1}s) stalled {:5.1}s (longest {:4.1}s) at local \
             ({:6.1},{:6.1}){}{}",
            v.team,
            v.secs,
            v.inside_secs,
            v.stalled,
            v.longest_stall,
            v.stall_at.0,
            v.stall_at.1,
            if v.carried_flag { "  [flag]" } else { "" },
            if v.died { "  [died]" } else { "" }
        );
    }
    let mut cells: std::collections::HashMap<(i32, i32), u32> = std::collections::HashMap::new();
    for v in visits.iter() {
        for c in v.cells.iter() {
            *cells.entry(*c).or_insert(0) += 1;
        }
    }
    let mut top: Vec<((i32, i32), u32)> = cells.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1));
    if !top.is_empty() {
        println!("  stalled hotspots (8 m cells, base-local x/z; gate +z, sally -z):");
        for ((cx, cz), n) in top.iter().take(10) {
            println!("    ({:5},{:5})  {} samples", cx * 8, cz * 8, n);
        }
    }
}
