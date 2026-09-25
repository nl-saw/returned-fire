fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let mut map = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    let cell = map.cell;
    for cz in 74..=78 {
        for cx in 150..=161 {
            let i = cz as usize * g as usize + cx as usize;
            if map.nav[i] != rf_core::types::terrain::BLOCKED { continue; }
            let qx = (cx as f32 + 0.5) * cell;
            let qz = (cz as f32 + 0.5) * cell;
            // which solid structures' OBB+shoulder cover this point?
            let mut hits = Vec::new();
            for s in &map.structures {
                if !(s.flags > 0.0 && (s.flags as u32) & rf_core::types::sflag::SOLID != 0) { continue; }
                if (s.flags as u32) & rf_core::types::sflag::FLAT != 0 { continue; }
                let hw = s.w * 0.5 + 0.75; let hd = s.d * 0.5 + 0.75;
                // transform point into structure local frame
                let dx = qx - s.x; let dz = qz - s.z;
                let (sn, cs) = (s.yaw.sin(), s.yaw.cos());
                let lx = dx * cs + dz * sn;
                let lz = -dx * sn + dz * cs;
                if lx.abs() <= hw && lz.abs() <= hd {
                    hits.push(format!("k{}({:.0},{:.0})", s.kind as u8, s.x, s.z));
                }
            }
            println!("cell({},{}) ({:.1},{:.1}) h={:.2} covered_by: {}", cx, cz, qx, qz, map.height_at(qx, qz), hits.join(", "));
        }
    }
}
