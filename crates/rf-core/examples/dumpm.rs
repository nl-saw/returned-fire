//! Field validity + coverage check for all fields, Classic seed.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let map_idx: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut w = rf_core::world::World::new_with_map(
        seed,
        rf_core::mapgen::generate_sized(seed, map_idx, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium),
        [-1, -1],
    );
    for _ in 0..8 {
        rf_core::nav::update_fields(&mut w, 1.0);
    }
    // count finite cells per field
    for t in [0u8, 1] {
        for (name, f) in [("to_flag", &w.fields.to_flag[t as usize]), ("to_enemy", &w.fields.to_enemy[t as usize]), ("to_base", &w.fields.to_base[t as usize])] {
            let cell = w.map.cell;
            let mut finite = 0u32;
            for z in 0..w.map.grid {
                for x in 0..w.map.grid {
                    if f.cost(&w.map, rf_core::math::v2((x as f32 + 0.5) * cell, (z as f32 + 0.5) * cell)).is_finite() {
                        finite += 1;
                    }
                }
            }
            println!("team {t} {name}: valid={} finite_cells={finite}", f.valid);
        }
    }
    // cost at each team's spawn + gate
    for t in [0u8, 1] {
        let p = w.map.spawn[t as usize];
        let c = w.fields.to_enemy[t as usize].cost(&w.map, p);
        println!("team {t} spawn ({:.1},{:.1}): to_enemy cost={c:.1}", p.x, p.y);
    }
}
