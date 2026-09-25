//! Structure kind census per generator mode and battlefield size (profiling aid).
//!
//!   cargo run --release --example kindcount

use std::collections::BTreeMap;

fn main() {
    for (mode_name, mode) in [
        ("classic", rf_core::mapgen::MapMode::Classic),
        ("mirror", rf_core::mapgen::MapMode::Mirror),
    ] {
        for (size_name, size) in [
            ("small", rf_core::types::MapSize::Small),
            ("medium", rf_core::types::MapSize::Medium),
            ("big", rf_core::types::MapSize::Big),
        ] {
            let mut map = rf_core::mapgen::generate_sized(1337, 0, mode, size);
            rf_core::normalize_map(&mut map);
            let mut counts: BTreeMap<u8, usize> = BTreeMap::new();
            for s in &map.structures {
                *counts.entry(s.kind as u8).or_insert(0) += 1;
            }
            let total = counts.values().sum::<usize>();
            // The renderer's INSTANCED_KINDS (web/src/render/world.ts): palm, rock, crate,
            // barrel, sandbag, container, wreck.
            const INSTANCED: [u8; 7] = [12, 13, 15, 16, 17, 24, 21];
            let instanced = counts.iter().filter(|(k, _)| INSTANCED.contains(k)).map(|(_, v)| *v).sum::<usize>();
            let detail: Vec<String> = counts
                .iter()
                .map(|(k, v)| format!("{k}:{v}"))
                .collect();
            println!(
                "{mode_name} {size_name}: total={total} instanced={instanced} single={}",
                total - instanced
            );
            println!("   {}", detail.join(" "));
        }
    }
}
