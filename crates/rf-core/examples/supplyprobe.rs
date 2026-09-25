//! Does a helicopter actually take on fuel and ammo at its own base?
//!
//! `cargo run --release --example supplyprobe`

use rf_core::types::*;
use rf_core::world::{Input, World};

fn main() {
    let mut w = World::new_with_map(
        11,
        rf_core::mapgen::generate_mode(11, 0, rf_core::mapgen::MapMode::Classic),
        [0, -1],
    );
    rf_core::normalize_map(&mut w.map);
    // The team-0 helipad, and the fuels depots around it.
    let pad = w
        .map
        .structures
        .iter()
        .enumerate()
        .find(|(_, s)| s.kind as u8 == skind::HELIPAD && s.team == 0.0)
        .map(|(i, s)| (i, s.pos(), s.y, s.team))
        .expect("team 0 has a helipad");
    println!(
        "helipad at ({:.0},{:.0}) flags fuel={} ammo={} repair={} in supply list: {}",
        pad.1.x,
        pad.1.y,
        w.map.structures[pad.0].flag(sflag::FUEL),
        w.map.structures[pad.0].flag(sflag::AMMO),
        w.map.structures[pad.0].flag(sflag::REPAIR),
        w.supply.contains(&(pad.0 as u32)),
    );
    let id = w.spawn_vehicle(vkind::HELI, 0, 1);
    let vi = w.vehicle_index(id).expect("heli spawned");
    w.vehicles[vi].pos = pad.1;
    w.vehicles[vi].y = pad.2;
    w.vehicles[vi].fuel = 20.0;
    w.vehicles[vi].ammo0 = 10.0;
    w.vehicles[vi].ammo1 = 5.0;
    let blank = Input::default();
    println!("before: fuel {:.0} ammo0 {:.0} ammo1 {:.0}", w.vehicles[vi].fuel, w.vehicles[vi].ammo0, w.vehicles[vi].ammo1);
    for _ in 0..(10 * 60) {
        w.step(1.0 / 60.0, &[blank, blank]);
    }
    let v = &w.vehicles[vi];
    println!(
        "after 10 s parked on it: fuel {:.0} ammo0 {:.0} ammo1 {:.0} resupplying={} alive={}",
        v.fuel,
        v.ammo0,
        v.ammo1,
        v.flags & vflag::RESUPPLYING != 0,
        v.alive()
    );
    // The same, but an *AI* hull (player 0): is the pad open to it too?
    let aid = w.spawn_vehicle(vkind::HELI, 0, 0);
    if let Some(ai) = w.vehicle_index(aid) {
        w.vehicles[ai].pos = pad.1;
        w.vehicles[ai].y = pad.2;
        w.vehicles[ai].fuel = 20.0;
        w.vehicles[ai].ammo0 = 10.0;
        for _ in 0..(10 * 60) {
            w.step(1.0 / 60.0, &[blank, blank]);
        }
        let v = &w.vehicles[ai];
        println!(
            "an AI heli after 10 s on the pad: goal {} fuel {:.0} ammo0 {:.0} resupplying={}",
            v.ai.goal,
            v.fuel,
            v.ammo0,
            v.flags & vflag::RESUPPLYING != 0
        );
    }

    // And what happens when the tank runs dry: the ground hull is expected to stop.
    let tid = w.spawn_vehicle(vkind::TANK, 0, 0);
    if let Some(ti) = w.vehicle_index(tid) {
        w.vehicles[ti].pos = pad.1 + rf_core::math::v2(40.0, 0.0);
        w.vehicles[ti].fuel = 0.0;
    }
    for _ in 0..(3 * 60) {
        w.step(1.0 / 60.0, &[blank, blank]);
    }
    if let Some(ti) = w.vehicle_index(tid) {
        println!(
            "a dry tank after 3 s: speed {:.2} m/s, alive {}, goal {}",
            w.vehicles[ti].vel.len(),
            w.vehicles[ti].alive(),
            w.vehicles[ti].ai.goal
        );
    }
    // And a dry helicopter: should it not fall?
    let hid = w.spawn_vehicle(vkind::HELI, 0, 0);
    if let Some(hi) = w.vehicle_index(hid) {
        w.vehicles[hi].pos = pad.1 + rf_core::math::v2(0.0, 30.0);
        w.vehicles[hi].fuel = 0.0;
        w.vehicles[hi].alt = 20.0;
    }
    for _ in 0..(6 * 60) {
        w.step(1.0 / 60.0, &[blank, blank]);
    }
    if let Some(hi) = w.vehicle_index(hid) {
        let v = &w.vehicles[hi];
        println!(
            "a dry helicopter after 6 s: alt {:.1} m, speed {:.1} m/s, alive {}, hp {:.0}",
            v.alt,
            v.vel.len(),
            v.alive(),
            v.hp
        );
    } else {
        println!("a dry helicopter after 6 s: gone from the field (crashed or culled)");
    }
}
