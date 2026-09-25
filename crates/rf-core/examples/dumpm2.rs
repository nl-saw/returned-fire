//! Count bridges on the still-disconnected Classic maps.
fn main() {
    for (mi, size) in [(0u32, 0usize), (0, 1), (1, 2), (2, 0), (2, 1), (2, 2), (3, 2)] {
        let seed = match mi { 0 => 3, 1 => 3, 2 => 2, _ => 4 };
        let ms = match size { 0 => rf_core::types::MapSize::Small, 2 => rf_core::types::MapSize::Big, _ => rf_core::types::MapSize::Medium };
        let mut m = rf_core::mapgen::generate_sized(seed, mi, rf_core::mapgen::MapMode::Classic, ms);
        rf_core::normalize_map(&mut m);
        let bridges: Vec<_> = m.structures.iter().filter(|s| s.kind as u8 == 9).collect();
        println!("map {} seed {} {:?}: {} bridges {:?}", mi, seed, ms, bridges.len(), bridges.iter().map(|s| (s.pos().x as i32, s.pos().y as i32)).collect::<Vec<_>>());
    }
}
