//! What sits at each flag_home: height, nav class, nearby base structures.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: u32 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let map_idx: u32 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let size_i: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let size = [rf_core::types::MapSize::Small, rf_core::types::MapSize::Medium, rf_core::types::MapSize::Big][size_i];
    let mut map = rf_core::mapgen::generate_sized(seed, map_idx, rf_core::mapgen::MapMode::Classic, size);
    rf_core::normalize_map(&mut map);
    for team in 0..2 {
        let fh = map.flag_home[team];
        let h = map.height_at(fh.x, fh.y);
        let g = map.grid as i32;
        let cell = map.cell;
        let cx = (fh.x / cell).floor() as i32;
        let cz = (fh.y / cell).floor() as i32;
        let navc = map.nav[(cz * g + cx) as usize];
        println!("team {team} flag_home ({:.1},{:.1}) h={:.2} nav={} water_level={}", fh.x, fh.y, h, navc, map.water_level);
        for s in &map.structures {
            if (s.team - team as f32).abs() > 0.5 { continue; }
            let dd = ((s.x - fh.x).powi(2) + (s.z - fh.y).powi(2)).sqrt();
            if dd < 40.0 {
                println!("   kind={:2} team={:.0} pos=({:.1},{:.1}) dist={:.1} h_at={:.2}", s.kind as u8, s.team, s.x, s.z, dd, map.height_at(s.x, s.z));
            }
        }
    }
}
