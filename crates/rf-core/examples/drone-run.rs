//! Probe: idle-player drone behaviour. Spawns the player jeep at base and lets it idle so the
//! anti-camping drones arrive in waves, then audits every shot a drone fires: how many are laid
//! on the player (bearing + elevation within the AI's own alignment gates) vs sprayed elsewhere.
//!
//! The enemy garrison is retired every tick (`kill_vehicle`) so this audit isolates the
//! drone-vs-camper interaction — in a full round the commander's hulls reach the parked jeep
//! first and steal the kill, which is fine in game but useless for measuring drone aim.
//!
//! Usage: cargo run --release --example drone-run [seconds]

use rf_core::math::{v3, wrap_angle};
use rf_core::types::*;
use rf_core::world::{Input, World};

fn main() {
    let secs = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(90);

    let mut map = rf_core::mapgen::generate(3, 0);
    rf_core::normalize_map(&mut map);
    let mut w = World::new_with_map(3, map, [0, -1]);

    // The human parks a jeep at base and never touches the controls.
    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    if let Some(vi) = w.vehicle_index(id) {
        let p = w.vehicles[vi].pos;
        println!(
            "player jeep #{} at ({:.1},{:.1}) y={:.1}",
            id, p.x, p.y, w.vehicles[vi].y
        );
    }

    let blank = Input::default();
    let mut fired = 0u32;
    let mut on_target = 0u32;
    let mut max_bearing_err = 0.0f32;
    let mut max_pitch_err = 0.0f32;
    let mut first_fire_t: Option<f32> = None;
    let mut last_hp_log = -10.0f32;

    for tick in 0..(secs * 60) {
        w.step(1.0 / 60.0, &[blank, blank]);
        let t = tick as f32 / 60.0;

        // Isolate the audit: retire every garrison hull (drones are the unit under test).
        for vi in (0..w.vehicles.len()).rev() {
            let v = &w.vehicles[vi];
            if v.team == 1 && v.player == 0 && v.alive() && v.kind != vkind::DRONE {
                w.kill_vehicle(vi, -1);
            }
        }

        // Audit every drone fire tick: the shot leaves from (turret_yaw, gun_pitch).
        for v in w.vehicles.iter() {
            if v.kind != vkind::DRONE || !v.alive() || !v.ai_input.fire0 {
                continue;
            }
            fired += 1;
            first_fire_t.get_or_insert(t);
            // The drone's intended victim: the nearest enemy (team-0) vehicle.
            let Some(pi) = w
                .vehicles
                .iter()
                .position(|p| p.alive() && p.team == 0 && p.kind != vkind::SUBMARINE)
            else {
                continue;
            };
            let d = w.vehicles[pi].pos - v.pos;
            let want = wrap_angle(d.x.atan2(d.y)); // yaw convention: forward = (sin, cos)
            let berr = wrap_angle(want - v.turret_yaw).abs();
            let perr = (v.ai_input.aim_pitch - v.gun_pitch).abs();
            max_bearing_err = max_bearing_err.max(berr);
            max_pitch_err = max_pitch_err.max(perr);
            if berr < 0.12 && perr < 0.05 {
                on_target += 1;
            }
        }

        // Per-second drone telemetry (first 40 s and every 5 s after): where is it, what branch.
        if (tick % 60 == 0 && t <= 40.0) || (t > 40.0 && tick % 300 == 0) {
            for v in w.vehicles.iter().filter(|v| v.kind == vkind::DRONE && v.alive()) {
                let (djeep, want) = match w.vehicle_index(id) {
                    Some(i) => {
                        let p = &w.vehicles[i];
                        let d = p.pos - v.pos;
                        (p.pos.dist(v.pos), wrap_angle(d.x.atan2(d.y)))
                    }
                    None => (f32::INFINITY, 0.0),
                };
                println!(
                    "  t={t:5.1} drone@({:.1},{:.1}) alt={:.1} d_jeep={djeep:5.1} \
                     yaw={:.2} want={:.2} terr={:.2} thr={:.2} str={:.2} fire={} los={}",
                    v.pos.x,
                    v.pos.y,
                    v.alt,
                    wrap_angle(v.yaw),
                    want,
                    wrap_angle(want - v.turret_yaw),
                    v.ai_input.throttle,
                    v.ai_input.strafe,
                    v.ai_input.fire0,
                    rf_core::ai::has_los(
                        &w,
                        v3(v.pos.x, v.y + 2.0, v.pos.y),
                        w.vehicle_index(id)
                            .map(|i| {
                                let p = w.vehicles[i].pos;
                                v3(p.x, w.vehicles[i].center_y(), p.y)
                            })
                            .unwrap_or(v3(0.0, 0.0, 0.0)),
                        -1
                    )
                );
            }
        }

        if t - last_hp_log >= 5.0 {
            last_hp_log = t;
            let (alive, hp) = w
                .vehicle_index(id)
                .map(|i| (w.vehicles[i].alive(), w.vehicles[i].hp))
                .unwrap_or((false, 0.0));
            let drones = w
                .vehicles
                .iter()
                .filter(|v| v.kind == vkind::DRONE && v.alive())
                .count();
            println!(
                "t={t:5.1}s player_hp={hp:5.0} alive={alive} drones_alive={drones} \
                 drone_count={} fired={fired} on_target={on_target} max_berr={max_bearing_err:.3} max_perr={max_pitch_err:.3}",
                w.drone_count
            );
        }
    }

    println!(
        "\nSUMMARY: fired={fired} on_target={on_target} off_target={} first_fire={:?}s",
        fired - on_target,
        first_fire_t.map(|t| format!("{t:.1}")).unwrap_or_else(|| "never".into())
    );
}
