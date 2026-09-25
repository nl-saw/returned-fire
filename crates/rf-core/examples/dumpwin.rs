use rf_core::types::terrain;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let cx0: f32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(424.0);
    let cz0: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(174.0);
    let r: f32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(70.0);
    let mut map = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    let cell = map.cell;
    // 1 char per 2 cells, window r metres around (cx0,cz0)
    let cz_hi = (((cz0 + r) / cell).floor() as i32).min(g - 1);
    let cz_lo = (((cz0 - r) / cell).floor() as i32).max(0);
    for cz in (cz_lo..=cz_hi).rev() {
        let mut line = String::new();
        for cx in ((cx0 - r) / cell).floor().max(0.0) as i32..=((cx0 + r) / cell).ceil().min((g-1) as f32) as i32 {
            if cx % 2 != 0 { continue; }
            let i = (cz as usize) * (g as usize) + cx as usize;
            let t = map.nav[i];
            line.push(if terrain::passable_land(t) { 'o' } else if t == terrain::BLOCKED { '#' } else { '~' });
        }
        println!("{line}");
    }
    println!("window centred ({cx0},{cz0}) r={r}m, 1 char = 2 cells x 1 cell (cell={cell}m)");
}
