fn main() {
    let args: Vec<String> = std::env::args().collect();
    let size = match args.get(1).map(|s| s.as_str()).unwrap_or("small") { "medium" => rf_core::types::MapSize::Medium, "big" => rf_core::types::MapSize::Big, _ => rf_core::types::MapSize::Small };
    for seed in [1u32, 7, 9, 42, 100, 555, 1337, 90210] {
        let m = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, size);
        let pts: Vec<(f32, f32)> = m.structures.iter().filter(|s| s.team == 2.0 && (s.yaw - 0.0).abs() < 1e-6).map(|s| (s.x, s.z)).collect();
        let mut s: Vec<String> = pts.iter().map(|(x, z)| format!("({:.0},{:.0})", x, z)).collect();
        s.sort();
        println!("{:>5}: {}", seed, s.join(" "));
    }
}
