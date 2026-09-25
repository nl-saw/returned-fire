//! Check whether the height field of a classic (unmirrored) map is mirror-symmetric.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: u32 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(2);
    let map_idx: u32 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(2);
    let size_i: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(2);
    let size = [rf_core::types::MapSize::Small, rf_core::types::MapSize::Medium, rf_core::types::MapSize::Big][size_i];
    let mut map = rf_core::mapgen::generate_sized(seed, map_idx, rf_core::mapgen::MapMode::Classic, size);
    rf_core::normalize_map(&mut map);
    let w = map.world_size;
    let (anchor, _) = map.base_anchor[0];
    let mx = w - anchor.x;
    let mz = w - anchor.y;
    println!("classic seed {seed} idx {map_idx}: h(anchor)= {:.2}  h(mirror)= {:.2}", map.height_at(anchor.x, anchor.y), map.height_at(mx, mz));
    // sample a few random-ish points
    for (fx, fz) in [(0.3, 0.7), (0.6, 0.4), (0.5, 0.8), (0.2, 0.3)] {
        let x = w * fx;
        let z = w * fz;
        println!("h({:.0},{:.0})={:.2}  h(mirror)={:.2}", x, z, map.height_at(x, z), map.height_at(w - x, w - z));
    }
}
