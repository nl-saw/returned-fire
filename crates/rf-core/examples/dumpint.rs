use rf_core::types::terrain;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let mut map = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    let cell = map.cell;
    let names = ["DEEP","SHAL","SAND","GROU","ROAD","ROCK","BLCK"];
    // cells cx 148..165, cz 62..74 (flag ~ (158,65), gate ~ (155,71))
    print!("      ");
    for cx in 149..=162 { print!("{:>4}", cx % 10); }
    println!();
    for cz in (70..=82).rev() {
        print!("cz{:>3} ", cz);
        for cx in 149..=162 {
            let i = cz as usize * g as usize + cx as usize;
            let t = map.nav[i];
            print!("{:>4}", names[t as usize].chars().take(2).collect::<String>());
        }
        println!();
    }
    // flag and spawn cells
    for t in 0..2usize {
        let f = map.flag_home[t]; let s = map.spawn[t];
        println!("team{}: flag cell ({},{}) spawn cell ({},{})", t, (f.x/cell) as i32, (f.y/cell) as i32, (s.x/cell) as i32, (s.y/cell) as i32);
    }
}
