//! MLRS gate-wedge probe: run an all-AI game, and while the team-0 MLRS is near its own
//! gate, log every second where everything is (vehicles, solid structures) so the wedge
//! geometry is visible.
//!
//!   cargo run --release --example mlrs-wedge [seed] [map_idx] [size 0/1/2] [seconds]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let map_index: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let size_idx: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let secs: u32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(150);
    let size = match size_idx {
        0 => rf_core::types::MapSize::Small,
        2 => rf_core::types::MapSize::Big,
        _ => rf_core::types::MapSize::Medium,
    };

    let map = rf_core::mapgen::generate_sized(seed, map_index, rf_core::mapgen::MapMode::Classic, size);
    let mut w = rf_core::world::World::new_with_map(seed, map, [-1, -1]);
    for _ in 0..8 {
        rf_core::nav::update_fields(&mut w, 1.0);
    }
    let blank = [rf_core::world::Input::default(); 2];

    // Team-0 gate and base anchor (from the map).
    let (ba, byaw) = w.map.base_anchor[0];
    println!("team0 base=({:.1},{:.1}) yaw={:.2}", ba.x, ba.y, byaw);
    let gate = w.gate_pos(0);
    println!("gate={:?}", gate.map(|g| (g.x, g.y)));

    for t in 0..secs * 60 {
        w.step(1.0 / 60.0, &blank);
        if (t + 1) % 60 != 0 {
            continue;
        }
        let ts = (t + 1) / 60;
        // Tick-level log while pinned: every 10th tick, if a team-0 MLRS is slow near its gate.
        if (t + 1) % 10 == 0 {
            if let Some((vi2, m2)) = w.vehicles.iter().enumerate()
                .find(|(_, v)| v.alive() && v.team == 0 && v.kind == rf_core::types::vkind::HRSV)
            {
                if gate.map_or(false, |g| m2.pos.dist(g) < 45.0) && m2.fwd_speed.abs() < 2.0 {
                    let mut near = String::new();
                    for (oi, o) in w.vehicles.iter().enumerate() {
                        if oi != vi2 && o.alive() && o.pos.dist(m2.pos) < 12.0 {
                            near.push_str(&format!(" v{}@({:.1},{:.1})", oi, o.pos.x, o.pos.y));
                        }
                    }
                    println!(
                        "    tick t={:5.2}s pos=({:6.2},{:6.2}) yaw={:5.2} fwd={:5.2} vel={:4.2} thr={:4.2} str={:4.2}{}",
                        (t + 1) as f32 / 60.0, m2.pos.x, m2.pos.y, w.vehicles[vi2].yaw,
                        m2.fwd_speed, m2.vel.len(), w.vehicles[vi2].ai_input.throttle,
                        w.vehicles[vi2].ai_input.steer, near);
                }
            }
        }
        // Find the team-0 MLRS.
        let mlrs = w
            .vehicles
            .iter()
            .enumerate()
            .find(|(_, v)| v.alive() && v.team == 0 && v.kind == rf_core::types::vkind::HRSV);
        let Some((vi, m)) = mlrs else { continue };
        // Only log while it is close to its own gate (the wedge zone).
        let near_gate = gate.map_or(false, |g| m.pos.dist(g) < 30.0);
        if !near_gate {
            println!("t={:4}s MLRS at ({:.1},{:.1}) d_gate>30m", ts, m.pos.x, m.pos.y);
            continue;
        }
        let g = gate.unwrap();
        println!(
            "t={:4}s MLRS pos=({:6.1},{:6.1}) yaw={:5.2} spd={:5.1} thr={:5.2} steer={:5.2} stuck={:4.1} goal={} tgt={}",
            ts, m.pos.x, m.pos.y, w.vehicles[vi].yaw, m.fwd_speed,
            w.vehicles[vi].ai_input.throttle, w.vehicles[vi].ai_input.steer,
            w.vehicles[vi].ai.stuck_t.max(0.0), w.vehicles[vi].ai.goal, w.vehicles[vi].ai.target
        );
        // Other vehicles within 25 m.
        for (oi, o) in w.vehicles.iter().enumerate() {
            if oi == vi || !o.alive() || o.pos.dist(m.pos) > 25.0 {
                continue;
            }
            let kind = match o.kind {
                rf_core::types::vkind::JEEP => "jeep",
                rf_core::types::vkind::TANK => "tank",
                rf_core::types::vkind::HRSV => "MLRS",
                rf_core::types::vkind::HELI => "heli",
                rf_core::types::vkind::TROOP => "troop",
                _ => "?",
            };
            println!(
                "        {:5} team={} pos=({:6.1},{:6.1}) d={:5.1}m yaw={:5.2}",
                kind, o.team, o.pos.x, o.pos.y, o.pos.dist(m.pos), w.vehicles[oi].yaw
            );
        }
        // dyn_block cells (wrecks / destroyed structures) within 12 m of the MLRS.
        let cell = w.map.cell;
        let g = w.map.grid as i32;
        let mx = (m.pos.x / cell).floor() as i32;
        let mz = (m.pos.y / cell).floor() as i32;
        for dz in -4..=4 {
            for dx in -4..=4 {
                let x = mx + dx;
                let z = mz + dz;
                if x < 0 || z < 0 || x >= g || z >= g {
                    continue;
                }
                let i = (z as usize) * (w.map.grid as usize) + (x as usize);
                if w.dyn_block[i] {
                    println!(
                        "        dyn_block cell=({},{}) pos=({:5.1},{:5.1}) nav={}",
                        x, z, (x as f32 + 0.5) * cell, (z as f32 + 0.5) * cell, w.map.nav[i]
                    );
                }
            }
        }
        // Solid structures within 14 m of the MLRS.
        for s in w.map.structures.iter() {
            if !s.solid() || s.pos().dist(m.pos) > 14.0 {
                continue;
            }
            println!(
                "        struct kind={:2} pos=({:6.1},{:6.1}) d={:5.1}m w={:.1} h={:.1}",
                s.kind, s.pos().x, s.pos().y, s.pos().dist(m.pos), s.w, s.h
            );
        }
    }
}
