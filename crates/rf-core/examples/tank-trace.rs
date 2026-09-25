//! Tank-exit trace: the bridge_audit tank scenario (mirror map, turrets cleared) with a
//! position log every 5 s, to see where the tank goes on a failing seed.
//!
//!   cargo run --release --example tank-trace [seed] [map_idx]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let index: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    let mut w = rf_core::world::World::new(seed, index, [0, 1]);
    w.turrets.clear();
    let id = w.spawn_vehicle(rf_core::types::vkind::TANK, 0, 0);
    let vi = w.vehicle_index(id).expect("tank exists");
    for _ in 0..8 {
        rf_core::nav::update_fields(&mut w, 1.0);
    }
    let home = w.map.spawn[0];
    let flag = w.flags[1].home;
    println!("home=({:.1},{:.1}) flag=({:.1},{:.1}) trip={:.0}m", home.x, home.y, flag.x, flag.y, home.dist(flag));
    if let Some(g) = w.gate_pos(0) {
        println!("team0 gate=({:.1},{:.1}) d_home_gate={:.1}m", g.x, g.y, g.dist(home));
    }

    let blank = [rf_core::world::Input::default(); 2];
    for t in 0..(180 * 60) {
        if !w.vehicles[vi].alive() {
            println!("t={:4}s tank DIED at ({:.1},{:.1})", (t + 1) / 60, w.vehicles[vi].pos.x, w.vehicles[vi].pos.y);
            break;
        }
        w.step(1.0 / 60.0, &blank);
        if (t + 1) % (5 * 60) == 0 {
            let v = &w.vehicles[vi];
            println!(
                "t={:4}s pos=({:6.1},{:6.1}) d_flag={:6.1}m yaw={:5.2} spd={:5.1} goal={:8} stuck={:4.1}",
                (t + 1) / 60, v.pos.x, v.pos.y, v.pos.dist(flag), v.yaw, v.fwd_speed,
                match w.vehicles[vi].ai.goal {
                    0 => "IDLE",
                    1 => "TO_FLAG",
                    2 => "HOME_FLG",
                    3 => "HUNT",
                    4 => "ATK_STR",
                    5 => "PATROL",
                    6 => "EVADE",
                    7 => "SUPPORT",
                    8 => "HOLD",
                    _ => "?",
                },
                w.vehicles[vi].ai.stuck_t.max(0.0),
            );
        }
    }
}
