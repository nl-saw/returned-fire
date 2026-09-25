//! Height + passability slice around a base anchor, with the anchor marked 'A'.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: u32 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let map_idx: u32 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let size_i: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let team: usize = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
    let size = [rf_core::types::MapSize::Small, rf_core::types::MapSize::Medium, rf_core::types::MapSize::Big][size_i];
    let mut map = rf_core::mapgen::generate_sized(seed, map_idx, rf_core::mapgen::MapMode::Classic, size);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    let cell = map.cell;
    let (anchor, _) = map.base_anchor[team];
    let ax = anchor.x;
    let ay = anchor.y;
    let acx = (ax / cell).floor() as i32;
    let acz = (ay / cell).floor() as i32;
    let cx0 = acx - 16;
    let cz0 = acz - 16;
    // '#' passable land, '.' shallow, '~' deep water, 'B' blocked, 'A' anchor cell
    println!("anchor team {team} at ({ax:.0},{ay:.0}) cell ({acx},{acz}); window from ({cx0},{cz0}), 32x32; cell={cell}");
    for cz in cz0..cz0+32 {
        let mut row = String::new();
        for cx in cx0..cx0+32 {
            if cx < 0 || cz < 0 || cx >= g || cz >= g { row.push(' '); continue; }
            if cx == acx && cz == acz { row.push('A'); continue; }
            let i = (cz * g + cx) as usize;
            row.push(match map.nav[i] {
                2 | 3 | 4 => '#',
                1 => '.',
                0 => '~',
                _ => 'B',
            });
        }
        println!("{:4} {}", cz, row);
    }
    // heights along a few rays from the anchor, to see where water actually starts
    for (dx, dz) in [(-1.0f32, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0), (-0.7, -0.7), (0.7, 0.7)] {
        let mut first_water = f32::INFINITY;
        for t in 1..=40 {
            let h = map.height_at(ax + dx * (t as f32) * cell, ay + dz * (t as f32) * cell);
            if h < 0.6 && first_water.is_infinite() { first_water = t as f32 * cell; }
        }
        println!("ray ({dx:+.1},{dz:+.1}): first water at {first_water:.1} m");
    }
}
