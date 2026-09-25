fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let cx0: f32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(424.0);
    let cz0: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(174.0);
    let r: f32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(55.0);
    let mut map = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium);
    rf_core::normalize_map(&mut map);
    let (ba, byaw) = map.base_anchor[1];
    // gate world pos: local (-6, 19) rotated by base yaw about anchor
    let (gx, gz) = (ba.x + -6.0*byaw.cos() - 19.0*byaw.sin(), ba.y + -6.0*byaw.sin() + 19.0*byaw.cos());
    println!("base_anchor=({:.1},{:.1}) yaw={:.2} gate≈({:.1},{:.1})", ba.x, ba.y, byaw, gx, gz);
    for s in &map.structures {
        let dx = s.x - cx0; let dz = s.z - cz0;
        if (dx*dx + dz*dz).sqrt() > r { continue; }
        println!("kind={:2} team={} pos=({:6.1},{:6.1}) y={:.1} yaw={:.2} w={:.1} d={:.1} h={:.1} solid={} flat={} gate={}",
            s.kind, s.team, s.x, s.z, s.y, s.yaw, s.w, s.d, s.h,
            s.flag(rf_core::types::sflag::SOLID), s.flag(rf_core::types::sflag::FLAT),
            s.kind as u8 == rf_core::types::skind::GATE);
    }
}
