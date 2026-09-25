//! Diagnostic: where the scattered rocks actually are.
//!
//! "The stones around the map are way too concentrated." This dumps the rock population of a
//! generated map: a coarse density grid over the theatre, the distribution of distance to the
//! nearest map edge, and clustering statistics (nearest-neighbour distance, and the share of
//! rocks that have another rock within one hull's width).
//!
//! Usage: `cargo run --release --example rocks -- [map_index] [seed] [size small|medium|big]`

use rf_core::math::v2;
use rf_core::mapgen::MapMode;
use rf_core::Vec2;
use rf_core::types::*;
use rf_core::world::World;

fn main() {
    let index: u32 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(0);
    let seed: u32 = std::env::args()
        .nth(2)
        .and_then(|a| a.parse().ok())
        .unwrap_or(1);
    let size = match std::env::args().nth(3).as_deref() {
        Some("medium") => MapSize::Medium,
        Some("big") => MapSize::Big,
        _ => MapSize::Small,
    };

    let mode = match std::env::args().nth(4).as_deref() {
        Some("classic") => MapMode::Classic,
        _ => MapMode::Mirror,
    };
    let map = rf_core::mapgen::generate_mode(seed, index, mode);
    let _ = size;
    let rocks: Vec<Vec2> = map
        .structures
        .iter()
        .filter(|s| s.kind as u8 == skind::ROCK)
        .map(|s| s.pos())
        .collect();
    let w = map.world_size;
    println!(
        "map {index} seed {seed} ({w:.0} m): {} rocks, {} structures total",
        rocks.len(),
        map.structures.len()
    );

    // Wide, short map: a terminal cell is about twice as tall as it is wide, so a square
    // theatre reads square at 2:1 cells per row.
    const COLS: usize = 64;
    const ROWS: usize = 32;
    let mut wide = [[0u32; COLS]; ROWS];
    for r in rocks.iter() {
        let cx = ((r.x / w * COLS as f32) as usize).min(COLS - 1);
        let cz = ((r.y / w * ROWS as f32) as usize).min(ROWS - 1);
        wide[cz][cx] += 1;
    }
    let mut land = [[false; COLS]; ROWS];
    for iz in 0..ROWS {
        for ix in 0..COLS {
            let x = (ix as f32 + 0.5) / COLS as f32 * w;
            let z = (iz as f32 + 0.5) / ROWS as f32 * w;
            land[iz][ix] = map.height_at(x, z) > 0.45;
        }
    }
    println!("theatre map ('.'=sea, ' '=land, digits=rocks per cell):");
    for iz in 0..ROWS {
        let mut row = String::new();
        for ix in 0..COLS {
            let v = wide[iz][ix];
            row.push(if v > 0 {
                char::from_digit(v.min(9), 10).unwrap()
            } else if land[iz][ix] {
                ' '
            } else {
                '.'
            });
        }
        println!("  |{row}|");
    }

    // Density grid, 16x16 cells over the theatre.
    const N: usize = 16;
    let cell = w / N as f32;
    let mut grid = [[0u32; N]; N];
    for r in rocks.iter() {
        let cx = ((r.x / cell) as usize).min(N - 1);
        let cz = ((r.y / cell) as usize).min(N - 1);
        grid[cz][cx] += 1;
    }
    let peak = grid.iter().flatten().copied().max().unwrap_or(1).max(1);
    println!("density ({cell:.0} m cells, one glyph per cell, ' '=0 .. '#'=peak {peak}):");
    for iz in 0..N {
        let mut row = String::new();
        for ix in 0..N {
            let v = grid[iz][ix];
            let g = if v == 0 {
                ' '
            } else {
                let level = (v * 8 / peak).min(7) as usize;
                ['1', '2', '3', '4', '5', '6', '7', '#'][level]
            };
            row.push(g);
        }
        println!("  {row}");
    }

    // Distance to the nearest map edge.
    let mut edges: Vec<f32> = rocks
        .iter()
        .map(|r| r.x.min(r.y).min(w - r.x).min(w - r.y))
        .collect();
    edges.sort_by(|a, b| a.total_cmp(b));
    let q = |f: f32| edges[((edges.len() as f32 - 1.0) * f).round() as usize];
    let near_edge = edges.iter().filter(|e| **e < 40.0).count();
    println!(
        "distance to nearest map edge: p10 {:.0} p50 {:.0} p90 {:.0} m | {} of {} rocks ({}%) \
         within 40 m of an edge",
        q(0.10),
        q(0.50),
        q(0.90),
        near_edge,
        rocks.len(),
        100 * near_edge / rocks.len().max(1)
    );

    // Control: the same edge-distance statistic over *drivable ground*. On an island map the
    // map border is ocean, so "rocks are 76 m from an edge" means nothing until it is compared
    // with how far the land itself is.
    let mut land_edges: Vec<f32> = Vec::new();
    let mut step = 2.0f32;
    while step < w {
        let mut x = 2.0f32;
        while x < w {
            let h = map.height_at(x, step);
            let t = map.nav_at(x, step);
            if h > 0.45 && !rf_core::types::terrain::is_water(t) {
                land_edges.push(x.min(step).min(w - x).min(w - step));
            }
            x += 4.0;
        }
        step += 4.0;
    }
    land_edges.sort_by(|a, b| a.total_cmp(b));
    let lq = |f: f32| land_edges[((land_edges.len() as f32 - 1.0) * f).round() as usize];
    let land_near = land_edges.iter().filter(|e| **e < 40.0).count();
    println!(
        "  for comparison, drivable ground: {} samples, p10 {:.0} p50 {:.0} p90 {:.0} m, {}% \
         within 40 m of an edge",
        land_edges.len(),
        lq(0.10),
        lq(0.50),
        lq(0.90),
        100 * land_near / land_edges.len().max(1)
    );

    // Radial profile: share of rocks against share of drivable ground in each tenth of the
    // theatre's radius. This is the "are they out on the outskirts or piled in the middle"
    // measurement; the border distance above cannot see it because the border is water.
    let mut rock_bins = [0u32; 10];
    let mut land_bins = [0u32; 10];
    let centre = v2(w * 0.5, w * 0.5);
    for r in rocks.iter() {
        let b = ((r.dist(centre) / (w * 0.5) * 10.0) as usize).min(9);
        rock_bins[b] += 1;
    }
    for e in land_edges.iter() {
        let _ = e;
    }
    let mut z = 2.0f32;
    while z < w {
        let mut x = 2.0f32;
        while x < w {
            let h = map.height_at(x, z);
            let t = map.nav_at(x, z);
            if h > 0.45 && !rf_core::types::terrain::is_water(t) {
                let b = ((v2(x, z).dist(centre) / (w * 0.5) * 10.0) as usize).min(9);
                land_bins[b] += 1;
            }
            x += 4.0;
        }
        z += 4.0;
    }
    let rn = rocks.len().max(1) as f32;
    let ln = land_bins.iter().sum::<u32>().max(1) as f32;
    print!("  radial profile (centre -> border), rocks vs drivable ground:");
    for b in 0..10 {
        print!(
            "  {:.0}-{:.0}%: {:.0}%/{:.0}%",
            b as f32 * 10.0,
            (b + 1) as f32 * 10.0,
            100.0 * rock_bins[b] as f32 / rn,
            100.0 * land_bins[b] as f32 / ln
        );
    }
    println!();

    // Clustering: nearest-neighbour distance, and how many rocks have a neighbour closer than
    // a hull width (they cannot be driven between).
    let mut nn: Vec<f32> = Vec::with_capacity(rocks.len());
    let mut close = 0usize;
    for (i, a) in rocks.iter().enumerate() {
        let mut best = f32::INFINITY;
        for (j, b) in rocks.iter().enumerate() {
            if i == j {
                continue;
            }
            best = best.min(a.dist(*b));
        }
        if best < 4.0 {
            close += 1;
        }
        nn.push(best);
    }
    nn.sort_by(|a, b| a.total_cmp(b));
    let nq = |f: f32| nn[((nn.len() as f32 - 1.0) * f).round() as usize];
    println!(
        "nearest neighbour: p10 {:.1} p50 {:.1} p90 {:.1} m | {} of {} rocks ({:.0}%) have one \
         within 4 m",
        nq(0.10),
        nq(0.50),
        nq(0.90),
        close,
        rocks.len(),
        100.0 * close as f32 / rocks.len().max(1) as f32
    );

    // Sanity: are rocks standing on the terrain that justifies them (slope/height)?
    let mut on_slope = 0;
    let mut high = 0;
    let mut flat_low = 0;
    for r in rocks.iter() {
        let h = map.height_at(r.x, r.y);
        let s = map.slope_at(r.x, r.y).len();
        if s > 0.30 {
            on_slope += 1;
        } else if h > 2.6 {
            high += 1;
        } else {
            flat_low += 1;
        }
    }
    println!(
        "terrain under rocks: {on_slope} on slope>0.30, {high} on high ground>2.6 m, {flat_low} on \
         neither"
    );
    let _ = World::new_with_map(seed, rf_core::mapgen::generate(seed, index), [-1, -1]);
    let _ = v2(0.0, 0.0);
}
