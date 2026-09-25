//! Push-out probe: for a grid of points around the gate, compute the total structure push-out
//! a vehicle of radius r would receive. Shows the effective (inflated) gap width.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1337);
    let map = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium);
    // Fake a world-free check: structures live on the map; circle_push is a World method but
    // only reads the structure. Re-implement the query against map.structures directly.
    let r = 2.7f32; // MLRS radius
    for z in (884..=900).rev() {
        let mut row = String::new();
        for x in 546..=562 {
            let p = rf_core::math::v2(x as f32, z as f32);
            let mut push = rf_core::math::Vec2::ZERO;
            for s in map.structures.iter() {
                if !s.solid() || (s.kind as u8) == 10 /* BRIDGE guess */ { continue; }
                // replicate circle_push against this structure
                let d = p - s.pos();
                let (ss, c) = (-s.yaw).sin_cos();
                let lx = d.x * c - d.y * ss;
                let lz = d.x * ss + d.y * c;
                let hw = s.w * 0.5;
                let hd = s.d * 0.5;
                let cx = lx.clamp(-hw, hw);
                let cz = lz.clamp(-hd, hd);
                let dx = lx - cx;
                let dz = lz - cz;
                let dsq = dx * dx + dz * dz;
                if dsq > r * r { continue; }
                let (nx, nz, pen) = if dsq > 1e-6 {
                    let dist = dsq.sqrt();
                    (dx / dist, dz / dist, r - dist)
                } else {
                    let px = hw - lx.abs();
                    let pz = hd - lz.abs();
                    if px < pz { (lx.signum(), 0.0, px + r) } else { (0.0, lz.signum(), pz + r) }
                };
                let (s2, c2) = s.yaw.sin_cos();
                push += rf_core::math::v2(nx * c2 - nz * s2, nx * s2 + nz * c2) * pen;
            }
            row.push(if push.len() < 0.01 { '.' } else if push.len() < 0.5 { 'o' } else if push.len() < 1.2 { 'O' } else { '#' });
        }
        println!("z={:3} {}", z, row);
    }
    println!("x: 546..562; . free  o light push  O medium  # heavy (MLRS r=2.7)");
}
