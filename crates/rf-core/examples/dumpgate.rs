use rf_core::types::terrain;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let team: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let mut map = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    let cell = map.cell;
    let (ba, byaw) = map.base_anchor[team];
    // gate local (-6, 19); wall dir = base yaw
    let (sn, cs) = (byaw.sin(), byaw.cos());
    let gate = v2(ba.x + -6.0*cs - 19.0*sn, ba.y + -6.0*sn + 19.0*cs);
    println!("base=({:.1},{:.1}) yaw={:.3} gate=({:.1},{:.1})", ba.x, ba.y, byaw, gate.x, gate.y);
    // print nav class on a grid of points: along wall dir (u) -6..6 step 2.67, across (v) -5..5 step 2.67
    let names = ["DEEP","SHAL","SAND","GROU","ROAD","ROCK","BLCK"];
    print!("       ");
    for v in (-2..3) { print!(" v{:>4}", v); }
    println!();
    for u in -2..3 {
        let px = gate.x + (u as f32 * cell) * cs - (0.0) * sn;
        let pz = gate.y + (u as f32 * cell) * sn;
        print!("u{:>3}   ", u);
        for v in (-2..3) {
            let qx = px + -(v as f32 * cell) * sn; // across dir = perpendicular
            let qz = pz + (v as f32 * cell) * cs;
            let cx = ((qx / cell).floor()) as i32;
            let cz = ((qz / cell).floor()) as i32;
            if cx < 0 || cz < 0 || cx >= g || cz >= g { print!("   ?? "); continue; }
            let t = map.nav[cz as usize * g as usize + cx as usize];
            print!(" {} ", names[t as usize]);
        }
        println!();
    }
    fn v2(x: f32, y: f32) -> rf_core::math::Vec2 { rf_core::math::v2(x, y) }
}
