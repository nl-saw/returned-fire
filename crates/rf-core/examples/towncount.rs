fn main() {
    for size in [rf_core::types::MapSize::Small, rf_core::types::MapSize::Medium, rf_core::types::MapSize::Big] {
        let mut line = format!("{:>6}: ", size.name());
        for seed in [1u32, 7, 9, 42, 100, 555, 1337, 90210] {
            let m = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, size);
            let marks = m.structures.iter().filter(|s| s.team == 2.0 && (s.yaw - 0.0).abs() < 1e-6).count();
            line.push_str(&format!("{:3} ", marks));
        }
        println!("{line}   (seeds 1,7,9,42,100,555,1337,90210; team-2 yaw-0 count)");
    }
}
