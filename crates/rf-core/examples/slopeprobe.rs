//! Diagnostic: what can a hull actually climb on a scarp the nav grid calls drivable?
//!
//! Usage: cargo run --release --example slopeprobe

use rf_core::math::{v2, Vec2};
use rf_core::types::*;
use rf_core::world::{Input, World};

fn run(map_index: u32, seed: u32, kind: u8, at: Vec2, throttle: f32, label: &str) {
    let mut map = rf_core::mapgen::generate(seed, map_index);
    rf_core::normalize_map(&mut map);
    let mut w = World::new_with_map(seed, map, [1, -1]);
    w.set_options(1, false, true);
    w.set_cpu_driven(1, false);
    w.request_vehicle(1, kind);
    for _ in 0..4 {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    }
    let Some(vi) = w
        .vehicles
        .iter()
        .position(|v| v.team == 1 && v.player == 2 && v.alive())
    else {
        println!("{label}: no hull materialised");
        return;
    };
    let s = w.map.slope_at(at.x, at.y);
    // `label` decides which way the hull faces: "uphill" faces up the gradient, anything else
    // faces down it, so a reverse command then drives *up* the slope.
    let yaw = if label.starts_with("uphill") {
        s.norm().heading()
    } else {
        (-s).norm().heading()
    };
    let gy = w.ground_height(at);
    {
        let v = &mut w.vehicles[vi];
        v.pos = at;
        v.y = gy;
        v.yaw = yaw;
        match v.kind {
            _ => {}
        }
        v.vel = Vec2::ZERO;
        v.fwd_speed = 0.0;
    }
    let grade = s.len();
    let mut inp = Input::default();
    inp.throttle = throttle;
    let mut line = String::new();
    let (acc, spd) = {
        let sp = w.vehicles[vi].spec();
        (sp.accel, sp.speed)
    };
    for t in 0..(6 * 60) {
        w.step(1.0 / 60.0, &[Input::default(), inp]);
        if t % 60 == 59 {
            let v = &w.vehicles[vi];
            let wet = w.in_water(v.pos);
            let _ = wet;
            line.push_str(&format!(
                " [p=({:.1},{:.1}) h={:.2} v={:.1} fwd={:+.1} wet={} yaw={:.0}]",
                v.pos.x,
                v.pos.y,
                w.map.height_at(v.pos.x, v.pos.y),
                v.vel.len(),
                v.fwd_speed,
                wet as u8,
                v.yaw.to_degrees()
            ));
        }
    }
    println!("    spec accel={acc:.1} speed={spd:.1}");
    println!(
        "{label}: kind {kind} thr {throttle:+.1} at ({:.0},{:.0}) slope {grade:.2} -> speed(t=1..6s){line}  moved {:.1}m",
        at.x,
        at.y,
        w.vehicles[vi].pos.dist(at)
    );
}

fn main() {
    let spots: [(u32, u32, Vec2); 4] = [
        (3, 3, v2(423.0, 273.9)),
        (3, 3, v2(415.8, 273.7)),
        (3, 3, v2(240.0, 200.0)),
        (3, 3, v2(419.0, 285.0)),
    ];
    for (mi, seed, p) in spots {
        run(mi, seed, vkind::TANK, p, 1.0, "uphill fwd");
        run(mi, seed, vkind::TANK, p, -1.0, "downhill rev (so: reversing UP)");
        run(mi, seed, vkind::TANK, p, 1.0, "downhill fwd (so: driving DOWN)");
        run(mi, seed, vkind::JEEP, p, 1.0, "uphill fwd");
    }
}
