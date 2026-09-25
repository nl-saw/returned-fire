use rf_core::types::terrain;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let mut map = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    // ASCII: 1 char per 4x4 cells. '#'=blocked 'o'=passable '~'=water '.'=other water
    for cz in (0..g).rev().step_by(4) {
        let mut line = String::new();
        for cx in (0..g).step_by(4) {
            // worst-case in the 4x4 block: passable if ANY cell passable? use majority class
            let mut n_pass = 0; let mut n_block = 0; let mut n_water = 0;
            for dz in 0..4 { for dx in 0..4 {
                if cz+dz >= g || cx+dx >= g { continue; }
                let i = ((cz+dz) as usize) * (g as usize) + (cx+dx) as usize;
                if terrain::passable_land(map.nav[i]) { n_pass += 1; }
                else if map.nav[i] as u8 == rf_core::types::terrain::BLOCKED { n_block += 1; }
                else { n_water += 1; }
            }}
            line.push(if n_block >= 6 { '#' } else if n_pass >= 6 { 'o' } else if n_water >= 6 { '~' } else { '.' });
        }
        println!("{line}");
    }
    for t in 0..2usize {
        let f = map.flag_home[t]; let s = map.spawn[t];
        println!("team {} flag=({:.0},{:.0}) spawn=({:.0},{:.0})", t, f.x, f.y, s.x, s.y);
    }
}
