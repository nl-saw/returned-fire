//! Diagnostic: flag carriers with no route home — "jeeps get stuck in the enemy base".
//!
//! A carrier is *trapped* when the flow field to its own base reports no cost at its position:
//! the nav grid is pinched (a wall notch, a destroyed structure closing the lane) and driving
//! cannot fix it — the hull just mills. This measures how much time carriers spend trapped,
//! whether they ever have a round in the air while trapped (the "not firing at walls" report),
//! and what happens to them: captured or killed.
//!
//! Usage: `cargo run --release --example carriertrap -- [secs] [map_index] [seed]`

use rf_core::types::*;
use rf_core::world::{Input, World};

fn wall_hp(w: &World, team: u8) -> f32 {
    w.map.structures.iter().filter(|s| {
        s.alive() && s.kind as u8 == skind::WALL && (s.team as u8) == team
    }).map(|s| s.hp).sum()
}

/// Does an enemy wall stand within 90 m of `pos`? (Replicates the reach gate of the AI's
/// breach target search, to split trapped time into "wall to shoot" vs "nothing in range".)
fn wall_in_range(w: &World, team: u8, pos: rf_core::Vec2) -> bool {
    w.map.structures.iter().any(|s| {
        s.alive()
            && s.kind as u8 == skind::WALL
            && (s.team as u8) != team
            && s.pos().dist(pos) <= 90.0
    })
}

fn main() {
    let secs: f32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(600.0);
    let index: u32 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    let seed: u32 = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(3);

    let mut map = rf_core::mapgen::generate(seed, index);
    rf_core::normalize_map(&mut map);
    let mut w = World::new_with_map(seed, map, [-1, -1]);
    for _ in 0..8 {
        rf_core::nav::update_fields(&mut w, 1.0);
    }

    let blank = Input::default();
    let mut trapped: f32 = 0.0;
    let mut trapped_inside: f32 = 0.0;
    let mut trapped_firing: f32 = 0.0; // trapped seconds with a carrier round in the air
    let mut trapped_no_wall: f32 = 0.0; // trapped seconds with no enemy wall within 90 m
    let mut carriers_seen = 0usize;
    let mut carrier_kills = 0usize;
    let mut captures = Vec::new();
    let mut score = 0.0f32;
    let mut wall0 = wall_hp(&w, 0);
    let mut wall1 = wall_hp(&w, 1);
    // Per-jeep carry state from last tick, to count carriers that die with the flag.
    let mut prev: Vec<(u32, bool)> = Vec::new();

    let ticks = (secs * 60.0) as u32;
    for tick in 0..ticks {
        w.step(1.0 / 60.0, &[blank, blank]);
        let t = tick as f32 / 60.0;
        if w.score[0] + w.score[1] > score + 0.5 {
            score = w.score[0] + w.score[1];
            captures.push((t, if w.score[0] > 0.0 { 0 } else { 1 }));
        }
        let mut now: Vec<(u32, bool)> = Vec::new();
        for v in w.vehicles.iter() {
            if v.kind != vkind::JEEP {
                continue;
            }
            let carrying = v.carrying_flag();
            // Carried last tick, dead now: the flag was dropped by a kill.
            if !v.alive()
                && prev.iter().any(|(id, c)| *id == v.id && *c)
                && !now.iter().any(|(id, _)| *id == v.id)
            {
                carrier_kills += 1;
            }
            if v.alive() {
                now.push((v.id, carrying));
                if carrying {
                    carriers_seen += 1;
                    let team = v.team as usize;
                    let enemy = 1 - v.team;
                    // The land field reads unreachable for a swimming hull; open water is a
                    // route, not a jam (the fix makes the same distinction).
                    if w.in_water(v.pos) {
                        continue;
                    }
                    let no_route = w.fields.to_base[team].cost(&w.map, v.pos).is_infinite();
                    if !no_route {
                        continue;
                    }
                    trapped += 1.0 / 60.0;
                    if w.inside_own_base(enemy, v.pos) {
                        trapped_inside += 1.0 / 60.0;
                    }
                    if !wall_in_range(&w, v.team, v.pos) {
                        trapped_no_wall += 1.0 / 60.0;
                    }
                    let firing = w.projs.iter().any(|p| p.owner == v.id);
                    if firing {
                        trapped_firing += 1.0 / 60.0;
                    }
                }
            }
        }
        prev = now;
    }
    let wall0_lost = wall0 - wall_hp(&w, 0);
    let wall1_lost = wall1 - wall_hp(&w, 1);
    println!(
        "map {index} seed {seed} AI-vs-AI {secs:.0}s: carrying {:.1}s | trapped \
         (no route home) {:.0}s, of which {:.0}s inside the enemy walls and {:.0}s with no wall \
         in reach | firing while trapped {:.0}s ({:.0}% of trapped time) | carrier kills {} | \
         captures {:?} | wall hp lost t0 {:.0} / t1 {:.0}",
        carriers_seen as f32 / 60.0,
        trapped,
        trapped_inside,
        trapped_no_wall,
        trapped_firing,
        100.0 * trapped_firing / trapped.max(1e-6),
        carrier_kills,
        captures.iter().map(|(t, team)| format!("t{}:{}", *t as i32, team)).collect::<Vec<_>>(),
        wall0_lost,
        wall1_lost
    );
}
