//! Diagnostic: how much do the AI's routes actually differ?
//!
//! "They mostly go the same exact route now all the time." This measures it: it runs a real
//! map under AI command, and every time an AI hull crosses the midline between the two bases
//! it records *where* along that line it crossed. One route for everybody shows up as a tight
//! cluster; parallel lanes show up as a spread. Reported per team and per vehicle kind, with a
//! coarse histogram in metres along the midline.
//!
//! Usage: `cargo run --release --example routes -- [secs] [map_index] [seed]`

use rf_core::math::v2;
use rf_core::types::*;
use rf_core::world::{Input, World};

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

    let mut map = rf_core::mapgen::generate(seed, index);
    rf_core::normalize_map(&mut map);
    let mut w = World::new_with_map(seed, map, [-1, -1]);
    for _ in 0..8 {
        rf_core::nav::update_fields(&mut w, 1.0);
    }
    for t in 0..2u8 {
        let _ = t;
    }

    // Per team: the axis from its own base anchor to the enemy's, and the midpoint to measure
    // lateral position against. A crossing is counted when a hull's projection onto that axis
    // changes sign — it has passed the middle of the map, on its way to the enemy.
    let mut axes = [(v2(0.0, 0.0), v2(0.0, 0.0), v2(0.0, 0.0)); 2];
    for t in 0..2usize {
        let a = w.map.base_anchor[t].0;
        let b = w.map.base_anchor[1 - t].0;
        let axis = (b - a).norm();
        axes[t] = ((a + b) * 0.5, axis, axis.perp());
    }

    let blank = Input::default();
    // (team, kind) -> crossing lateral positions
    let mut crossings: std::collections::HashMap<(u8, u8), Vec<f32>> =
        std::collections::HashMap::new();
    let mut prev_d: Vec<Option<f32>> = Vec::new();
    let ticks = (secs * 60.0) as u32;

    for _ in 0..ticks {
        w.step(1.0 / 60.0, &[blank, blank]);
        prev_d.resize_with(w.vehicles.len(), || None);
        for (vi, v) in w.vehicles.iter().enumerate() {
            let is_ai = v.player == 0;
            if !v.alive() || !is_ai || v.kind == vkind::TROOP {
                prev_d[vi] = None;
                continue;
            }
            let t = (v.team as usize).min(1);
            let (mid, axis, side) = axes[t];
            let rel = v.pos - mid;
            let d = rel.dot(axis);
            let s = rel.dot(side);
            // Only count crossings well inside the theatre, and only away from either base
            // (a hull leaving its own pad crosses nothing, but a hull milling at a base would
            // otherwise register a dozen times).
            let far_from_bases = v.pos.dist(w.home_center(v.team)) > 60.0
                && v.pos.dist(w.home_center(1 - v.team)) > 60.0;
            if let Some(pd) = prev_d[vi] {
                if far_from_bases && pd < 0.0 && d >= 0.0 {
                    crossings.entry((v.team, v.kind)).or_default().push(s);
                }
            }
            prev_d[vi] = Some(d);
        }
    }

    println!(
        "map {index} seed {seed}, {secs:.0} s of AI-vs-AI: midline crossings between the bases"
    );
    let mut groups: Vec<((u8, u8), Vec<f32>)> = crossings.into_iter().collect();
    groups.sort_by_key(|((t, k), v)| (*t, *k, std::cmp::Reverse(v.len())));
    for ((team, kind), mut s) in groups {
        s.sort_by(|a, b| a.total_cmp(b));
        let n = s.len();
        let mean = s.iter().sum::<f32>() / n as f32;
        let var = s.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / n as f32;
        let sd = var.sqrt();
        let kind_name = match kind {
            vkind::JEEP => "jeep",
            vkind::TANK => "tank",
            vkind::HRSV => "hrsv",
            vkind::HELI => "heli",
            vkind::DRONE => "drone",
            vkind::SUBMARINE => "sub",
            _ => "other",
        };
        let q = |f: f32| s[((n as f32 - 1.0) * f).round() as usize];
        // Lane variation, isolated from route *choice* (bridge vs ford vs swim): keep only the
        // crossings that took the same way across, i.e. within 15 m of the median, and measure
        // how far apart they are. A column of clones scores ~0 here.
        let med = q(0.50);
        let lane: Vec<f32> = s.iter().copied().filter(|x| (x - med).abs() <= 15.0).collect();
        let lq = |f: f32| lane[((lane.len() as f32 - 1.0) * f).round() as usize];
        println!(
            "  team {team} {kind_name:<5} {n:>3} crossings | lateral sd {sd:>5.1} m | p10 {:>6.1} \
             p50 {:>6.1} p90 {:>6.1} | IQR {:>5.1} m | range {:.1}..{:.1} m",
            q(0.10),
            q(0.50),
            q(0.90),
            q(0.75) - q(0.25),
            s[0],
            s[n - 1]
        );
        println!(
            "        same-route lane spread: {} of {n} crossings, p10 {:.1} p90 {:.1} -> {:.1} m wide",
            lane.len(),
            lq(0.10),
            lq(0.90),
            lq(0.90) - lq(0.10)
        );
        // 10 m histogram, centred on the mean.
        let mut bins: Vec<(i32, u32)> = Vec::new();
        for x in s.iter() {
            let b = ((x - mean) / 10.0).floor() as i32;
            match bins.iter_mut().find(|(bb, _)| *bb == b) {
                Some((_, c)) => *c += 1,
                None => bins.push((b, 1)),
            }
        }
        bins.sort_by_key(|(b, _)| *b);
        let hist: Vec<String> = bins.iter().map(|(b, c)| format!("{:+}m:{}", b * 10, c)).collect();
        println!("        {}", hist.join("  "));
    }
}
