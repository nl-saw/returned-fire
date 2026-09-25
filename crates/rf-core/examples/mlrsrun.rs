//! Does the MLRS park to shoot, and how far does it get doing it?
//!
//! A duel between an MLRS and a tank, both kept alive (hp is restored every tick) so the
//! measurement is about driving rather than about who wins: distance travelled, the share of
//! ticks spent standing still, and rounds away.
//!
//! `cargo run --release --example mlrsrun -- [seconds] [seed]`

use rf_core::math::v2;
use rf_core::types::*;
use rf_core::world::{Input, World};

fn tank_pos(w: &World, id: u32) -> rf_core::math::Vec2 {
    w.vehicle_index(id).map(|vi| w.vehicles[vi].pos).unwrap_or(v2(0.0, 0.0))
}

fn wrap_pi(a: f32) -> f32 {
    let mut x = a;
    while x > core::f32::consts::PI {
        x -= core::f32::consts::TAU;
    }
    while x < -core::f32::consts::PI {
        x += core::f32::consts::TAU;
    }
    x
}

fn main() {
    let secs: f32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(240.0);
    let seed: u32 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(11);
    let mut w = World::new_with_map(
        seed,
        rf_core::mapgen::generate_mode(seed, 0, rf_core::mapgen::MapMode::Classic),
        [-1, -1],
    );
    rf_core::normalize_map(&mut w.map);
    w.set_options(1, false, false);
    let blank = Input::default();
    let mut last: std::collections::HashMap<u32, rf_core::math::Vec2> = std::collections::HashMap::new();
    let mut ammo: std::collections::HashMap<u32, f32> = std::collections::HashMap::new();
    let mut travelled = 0.0f32;
    let mut moving_ticks = 0u32;
    let mut stalled_ticks = 0u32;
    let mut fired = 0.0f32;
    let mut fired_moving = 0.0f32;
    let mut seen = 0usize;
    for _ in 0..(secs * 60.0) as u32 {
        w.step(1.0 / 60.0, &[blank, blank]);
        for vi in 0..w.vehicles.len() {
            let v = &w.vehicles[vi];
            if v.kind != vkind::HRSV || !v.alive() {
                continue;
            }
            let id = v.id;
            if !last.contains_key(&id) {
                seen += 1;
                ammo.insert(id, v.ammo0);
            }
            let prev_ammo = *ammo.get(&id).unwrap_or(&v.ammo0);
            if v.ammo0 < prev_ammo {
                fired += prev_ammo - v.ammo0;
                if v.vel.len() > 1.0 {
                    fired_moving += prev_ammo - v.ammo0;
                }
            }
            ammo.insert(id, v.ammo0);
            if let Some(p) = last.get(&id) {
                let d = p.dist(v.pos);
                travelled += d;
                if v.vel.len() < 0.3 {
                    stalled_ticks += 1;
                } else {
                    moving_ticks += 1;
                }
            }
            last.insert(id, v.pos);
        }
    }
    println!(
        "AI MLRS over {secs:.0} s: {seen} fielded, travelled {travelled:.0} m total ({:.0} m each), \
         standing still {:.0}% of ticks, rounds fired {fired:.0} ({:.0} while moving)",
        travelled / seen.max(1) as f32,
        stalled_ticks as f32 / (stalled_ticks + moving_ticks).max(1) as f32 * 100.0,
        fired_moving,
    );
}
