//! `cargo run --release --example mapdump -- [map_index] [seed]`
//!
//! Prints an ASCII picture of the navigation grid plus structure statistics, so map
//! generation can be sanity-checked without a browser. `.` water, `:` shallow, `-` sand,
//! `#` ground, `=` road/bridge, `^` rock, `X` blocked, `T` turret tower, `F` flag stand,
//! `G` garage, `H` helipad.

use rf_core::mapgen;
use rf_core::types::{skind, terrain, MapData, GRID};

fn main() {
    let mut args = std::env::args().skip(1);
    let index: u32 = args.next().and_then(|a| a.parse().ok()).unwrap_or(0);
    let seed: u32 = args.next().and_then(|a| a.parse().ok()).unwrap_or(1);

    let mut map: MapData = mapgen::generate(seed, index);
    rf_core::normalize_map(&mut map);

    println!("map {} \"{}\" seed {}", index, map.name, seed);
    println!(
        "heights: min {:.1} max {:.1} | structures: {} | grid {}",
        map.heights.iter().cloned().fold(f32::INFINITY, f32::min),
        map.heights.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
        map.structures.len(),
        GRID
    );
    match mapgen::validate(&map) {
        Ok(()) => println!("validate: ok"),
        Err(e) => println!("validate: FAILED - {e}"),
    }

    for iz in (0..GRID).step_by(2) {
        let mut row = String::with_capacity(GRID as usize);
        for ix in 0..GRID {
            let t = map.nav[(iz * GRID + ix) as usize];
            let ch = match t {
                terrain::DEEP_WATER => '.',
                terrain::SHALLOW_WATER => ':',
                terrain::SAND => '-',
                terrain::GROUND => '#',
                terrain::ROAD => '=',
                terrain::ROCK => '^',
                _ => 'X',
            };
            row.push(ch);
        }
        println!("{row}");
    }

    let mut counts = std::collections::BTreeMap::new();
    for s in map.structures.iter() {
        *counts.entry(s.kind as u8).or_insert(0u32) += 1;
    }
    for (kind, n) in counts {
        println!("  kind {kind:>2} ({}): {n}", kind_name(kind));
    }
    let (spawn, flag) = (map.spawn, map.flag_home);
    println!(
        "spawn0 ({:.0},{:.0}) h={:.1} | spawn1 ({:.0},{:.0}) h={:.1}",
        spawn[0].x, spawn[0].y, map.height_at(spawn[0].x, spawn[0].y),
        spawn[1].x, spawn[1].y, map.height_at(spawn[1].x, spawn[1].y)
    );
    println!(
        "flag0  ({:.0},{:.0}) h={:.1} | flag1  ({:.0},{:.0}) h={:.1}",
        flag[0].x, flag[0].y, map.height_at(flag[0].x, flag[0].y),
        flag[1].x, flag[1].y, map.height_at(flag[1].x, flag[1].y)
    );
}

fn kind_name(k: u8) -> &'static str {
    match k {
        skind::GARAGE => "garage",
        skind::FLAG_POLE => "flag",
        skind::FUEL_DEPOT => "fuel",
        skind::AMMO_TENT => "ammo",
        skind::HELIPAD => "helipad",
        skind::RADAR => "radar",
        skind::WALL => "wall",
        skind::BUNKER => "bunker",
        skind::BRIDGE => "bridge",
        skind::TENT => "tent",
        skind::TURRET_TOWER => "turret",
        skind::PALM => "palm",
        skind::ROCK => "rock",
        skind::BUILDING => "building",
        skind::CRATE => "crate",
        skind::BARREL => "barrel",
        skind::SANDBAG => "sandbag",
        skind::WATCHTOWER => "watchtower",
        skind::HANGAR => "hangar",
        skind::ANTENNA => "antenna",
        skind::WRECK => "wreck",
        skind::HQ => "hq",
        skind::GATE => "gate",
        skind::CONTAINER => "container",
        skind::LIGHTHOUSE => "lighthouse",
        _ => "?",
    }
}
