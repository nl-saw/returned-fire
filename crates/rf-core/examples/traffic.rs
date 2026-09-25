//! How often friendly ground hulls touch each other, and how far apart their lanes are.
//!
//! `cargo run --release --example traffic -- [seconds] [map] [seed]`

use rf_core::types::*;
use rf_core::world::{Input, World};
use std::collections::HashSet;

fn main() {
    let secs: f32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(300.0);
    let index: u32 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    let seed: u32 = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(11);

    let mut w = World::new_with_map(seed, rf_core::mapgen::generate_mode(seed, index, rf_core::mapgen::MapMode::Classic), [0, -1]);
    rf_core::normalize_map(&mut w.map);
    // The demo shape: a CPU-driven player slot plus the ally garrison, against the commander.
    w.set_options(1, false, true);
    w.set_cpu_driven(0, true);
    w.request_vehicle(0, vkind::JEEP);

    let blank = Input::default();
    let mut touching: HashSet<(u32, u32)> = HashSet::new();
    let mut started = 0usize;
    let mut contact_ticks = 0usize;
    let mut near_misses = 0usize;
    let mut per_team = [0usize; 2];
    // Lane spread: where each hull crosses a line 25 m outside its own gateway. Every hull got
    // the same 8-way field heading per 2 m cell, so "they all drive the same path" shows up
    // here as a spread of a metre or two; the per-hull lane offset is what widens it.
    let mut offsets: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
    let mut was_out: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
    for _ in 0..(secs * 60.0) as u32 {
        w.step(1.0 / 60.0, &[blank, blank]);
        let mut now: HashSet<(u32, u32)> = HashSet::new();
        let n = w.vehicles.len();
        for a in 0..n {
            if !w.vehicles[a].alive() || w.vehicles[a].spec().flying || w.vehicles[a].kind == vkind::TROOP {
                continue;
            }
            {
                // Crossing the line on the way out of the base.
                let team = w.vehicles[a].team as usize;
                let id = w.vehicles[a].id;
                let pos = w.vehicles[a].pos;
                if let (Some(gate), pad) = (w.gate_pos(team as u8), w.map.spawn[team]) {
                    let axis = (gate - pad).norm();
                    if axis.len_sq() > 0.01 {
                        let rel = pos - gate;
                        let out = rel.dot(axis) > 25.0;
                        let prev = was_out.insert(id, out).unwrap_or(false);
                        if out && !prev {
                            let perp = axis.rot(std::f32::consts::FRAC_PI_2);
                            offsets[team].push(rel.dot(perp));
                        }
                    }
                }
            }
            for b in (a + 1)..n {
                if !w.vehicles[b].alive() || w.vehicles[b].spec().flying || w.vehicles[b].kind == vkind::TROOP {
                    continue;
                }
                if w.vehicles[a].team != w.vehicles[b].team {
                    continue;
                }
                let d = w.vehicles[a].pos.dist(w.vehicles[b].pos);
                let sum = w.vehicles[a].spec().radius + w.vehicles[b].spec().radius;
                if d < sum + 0.2 {
                    let key = (w.vehicles[a].id.min(w.vehicles[b].id), w.vehicles[a].id.max(w.vehicles[b].id));
                    now.insert(key);
                    contact_ticks += 1;
                    if !touching.contains(&key) {
                        started += 1;
                        per_team[w.vehicles[a].team as usize] += 1;
                    }
                } else if d < sum + 2.5 {
                    near_misses += 1;
                }
            }
        }
        touching = now;
    }
    println!(
        "map {index} seed {seed} over {secs:.0}s: {started} friendly contacts began (team 0 {:.0}%, team 1 {:.0}%), {:.1} s of contact in total, {near_misses} near misses under 2.5 m",
        per_team[0] as f32 / started.max(1) as f32 * 100.0,
        per_team[1] as f32 / started.max(1) as f32 * 100.0,
        contact_ticks as f32 / 60.0,
    );
    for team in 0..2 {
        let o = &offsets[team];
        if o.is_empty() {
            continue;
        }
        let mean = o.iter().sum::<f32>() / o.len() as f32;
        let sd = (o.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / o.len() as f32).sqrt();
        let lo = o.iter().cloned().fold(f32::MAX, f32::min);
        let hi = o.iter().cloned().fold(f32::MIN, f32::max);
        println!(
            "  team {team}: {} departures crossed the 25 m line at {:.1} m mean, sd {:.2} m, spread {:.2} m ({:.1}..{:.1})",
            o.len(),
            mean,
            sd,
            hi - lo,
            lo,
            hi
        );
    }
}
