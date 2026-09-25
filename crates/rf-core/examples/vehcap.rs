//! What a raised per-team vehicle cap does to the field, and how fast it fills.
//!
//! `cargo run --release --example vehcap -- [cap] [seconds] [difficulty]`

use rf_core::types::*;
use rf_core::world::{Input, World, MAX_VEHICLE_CAP};

fn main() {
    let cap: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(12);
    let secs: f32 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(180.0);
    let diff: u32 = std::env::args().nth(3).and_then(|a| a.parse().ok()).unwrap_or(0);

    for cap in [0usize, cap] {
        let mut w = World::new_with_map(11, rf_core::mapgen::generate_mode(11, 0, rf_core::mapgen::MapMode::Classic), [-1, -1]);
        rf_core::normalize_map(&mut w.map);
        w.set_options(diff, false, false);
        w.set_vehicle_cap(cap);
        let blank = Input::default();
        let mut peak = [0usize; 2];
        let mut samples: Vec<(f32, [usize; 2])> = Vec::new();
        for tick in 0..(secs * 60.0) as u32 {
            w.step(1.0 / 60.0, &[blank, blank]);
            let mut live = [0usize; 2];
            for v in w.vehicles.iter() {
                if v.alive() && v.player == 0 && matches!(v.kind, vkind::JEEP | vkind::TANK | vkind::HRSV | vkind::HELI) {
                    live[v.team as usize] += 1;
                }
            }
            for t in 0..2 {
                peak[t] = peak[t].max(live[t]);
            }
            let t = tick as f32 / 60.0;
            if (t - 30.0).abs() < 0.01 || (t - 60.0).abs() < 0.01 || (t - 120.0).abs() < 0.01 {
                samples.push((t, live));
            }
        }
        println!(
            "cap {:>3} (clamped {:>3}) diff {diff}: peak per team {:?}, total hulls on the field {}, at 30/60/120 s {:?}",
            cap,
            w.vehicle_cap.min(MAX_VEHICLE_CAP),
            peak,
            w.vehicles.len(),
            samples
        );
    }
}
