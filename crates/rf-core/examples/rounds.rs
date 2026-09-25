//! How rounds end: impact, or expiry in mid-air with nothing hit.
//!
//! `cargo run --release --example rounds -- [seconds] [map] [seed]`
//!
//! `update_projectiles` decrements `life`, then drops the round at zero *before* any terrain or
//! hull test. So a round whose remaining life is shorter than the step can only ever expire: it
//! vanishes where it is, with no impact event, no dust and no explosion. This counts that split
//! per weapon, plus how far the expiring rounds had travelled, and the peak number of rounds in
//! the air - which is what a longer lifetime buys and costs.

use rf_core::math::v2;
use rf_core::types::*;
use rf_core::world::{Input, World};
use std::collections::HashMap;

struct Tally {
    fired: u32,
    expired: u32,
    impacted: u32,
    expire_metres: f32,
}

fn main() {
    let secs: f32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(300.0);
    let index: u32 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    let seed: u32 = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(11);

    let mut w = World::new_with_map(
        seed,
        rf_core::mapgen::generate_mode(seed, index, rf_core::mapgen::MapMode::Classic),
        [0, -1],
    );
    rf_core::normalize_map(&mut w.map);
    // The demo shape: a CPU-driven player slot plus the ally garrison, against the commander.
    w.set_options(1, false, true);
    w.set_cpu_driven(0, true);
    w.request_vehicle(0, vkind::JEEP);

    let dt = 1.0 / 60.0;
    let blank = Input::default();
    // id -> (kind, where it started)
    let mut track: HashMap<u32, (u8, rf_core::math::Vec2)> = HashMap::new();
    let mut tally: HashMap<u8, Tally> = HashMap::new();
    let mut peak = 0usize;

    for _ in 0..(secs / dt) as u32 {
        // Snapshot what is in the air, and what its remaining life is, *before* the step: a round
        // with `life <= dt` is one the step can only expire.
        let before: Vec<(u32, u8, f32, rf_core::math::Vec2)> = w
            .projs
            .iter()
            .map(|p| (p.id, p.kind, p.life, v2(p.pos.x, p.pos.z)))
            .collect();
        w.step(dt, &[blank, blank]);
        for (id, kind, life, pos) in before {
            let e = tally.entry(kind).or_insert(Tally {
                fired: 0,
                expired: 0,
                impacted: 0,
                expire_metres: 0.0,
            });
            if !w.projs.iter().any(|p| p.id == id) {
                if life <= dt {
                    e.expired += 1;
                    let start = track.get(&id).map(|t| t.1).unwrap_or(pos);
                    e.expire_metres += start.dist(pos);
                } else {
                    e.impacted += 1;
                }
            }
        }
        for p in w.projs.iter() {
            let e = tally.entry(p.kind).or_insert(Tally {
                fired: 0,
                expired: 0,
                impacted: 0,
                expire_metres: 0.0,
            });
            // The *first* position seen is the launch point; keep it, so the distance an
            // expiring round reports is the whole flight, not the last step.
            if !track.contains_key(&p.id) {
                e.fired += 1;
                track.insert(p.id, (p.kind, v2(p.pos.x, p.pos.z)));
            }
        }
        peak = peak.max(w.projs.len());
        track.retain(|id, _| w.projs.iter().any(|p| p.id == *id));
    }

    println!("map {index} seed {seed} over {secs:.0}s: peak {peak} rounds in the air at once");
    let name = |k: u8| match k {
        pkind::SHELL => "shell  ",
        pkind::GRENADE => "grenade",
        pkind::ROCKET => "rocket ",
        pkind::MISSILE => "missile",
        pkind::BULLET => "bullet ",
        pkind::HOMING => "homing ",
        pkind::BOMB => "bomb   ",
        _ => "other  ",
    };
    let mut rows: Vec<(u8, &Tally)> = tally.iter().map(|(k, v)| (*k, v)).collect();
    rows.sort_by_key(|(k, _)| *k);
    for (kind, t) in rows {
        let ended = t.expired + t.impacted;
        if ended == 0 {
            continue;
        }
        println!(
            "  {}: {} fired, {} hit something, {} expired in mid-air ({:.0}% of those that ended), \
             mean {:.0} m flown before expiring",
            name(kind),
            t.fired,
            t.impacted,
            t.expired,
            t.expired as f32 / ended as f32 * 100.0,
            t.expire_metres / t.expired.max(1) as f32,
        );
    }
}
