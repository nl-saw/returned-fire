//! Land-route reachability probe (bug repro for "AI camps at base").
//! BFS over passable_land from each flag home; when no path exists, reports how far the
//! reachable region gets from the enemy base and what sits in the gap.
//!
//!   cargo run --release --example nav-reach [map_index] [size 0=small 1=medium 2=big] [seed]
//! seed 0 = sweep seeds 1..=8 silently (only failures + a summary line).

use rf_core::math::v2;
use rf_core::types::terrain;

fn reachable(map: &rf_core::types::MapData, from: rf_core::math::Vec2, to: rf_core::math::Vec2) -> bool {
    let g = map.grid as i32;
    let idx = |p: rf_core::math::Vec2| -> usize {
        let cx = (p.x / map.cell).floor().clamp(0.0, (g - 1) as f32) as i32;
        let cz = (p.y / map.cell).floor().clamp(0.0, (g - 1) as f32) as i32;
        (cz * g + cx) as usize
    };
    let start = idx(from);
    let goal = idx(to);
    if !terrain::passable_land(map.nav[start]) || !terrain::passable_land(map.nav[goal]) {
        return false;
    }
    let mut seen = vec![false; (g * g) as usize];
    seen[start] = true;
    let mut queue: Vec<u32> = vec![start as u32];
    let mut head = 0usize;
    while head < queue.len() {
        let cur = queue[head] as usize;
        head += 1;
        if cur == goal {
            return true;
        }
        let cx = (cur as i32) % g;
        let cz = (cur as i32) / g;
        for (dx, dz) in [(1i32, 0), (-1, 0), (0, 1), (0, -1)] {
            let nx = cx + dx;
            let nz = cz + dz;
            if nx < 0 || nz < 0 || nx >= g || nz >= g {
                continue;
            }
            let ni = (nz * g + nx) as usize;
            if seen[ni] || !terrain::passable_land(map.nav[ni]) {
                continue;
            }
            seen[ni] = true;
            queue.push(ni as u32);
        }
    }
    false
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let map_index: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let size_idx: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    // seed 0 = sweep seeds 1..=8 silently (only failures printed)
    let seed: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(7);
    let size = match size_idx {
        0 => rf_core::types::MapSize::Small,
        2 => rf_core::types::MapSize::Big,
        _ => rf_core::types::MapSize::Medium,
    };

    if seed == 0 {
        let mut bad = 0usize;
        for s in 1..=8u32 {
            let mut m = rf_core::mapgen::generate_sized(s, map_index, rf_core::mapgen::MapMode::Classic, size);
            rf_core::normalize_map(&mut m);
            for team in 0..2usize {
                if !reachable(&m, m.flag_home[team], m.flag_home[1 - team]) {
                    bad += 1;
                    println!(
                        "FAIL map {} seed {} {:?} team {}: no land path flag_home -> enemy flag_home",
                        map_index, s, size, team
                    );
                }
            }
        }
        println!("sweep map {} {:?}: {} disconnected (of 16 directed checks)", map_index, size, bad);
        return;
    }

    let mut map = rf_core::mapgen::generate_sized(seed, map_index, rf_core::mapgen::MapMode::Classic, size);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    let cell = map.cell;
    let idx = |p: rf_core::math::Vec2| -> usize {
        let cx = (p.x / cell).floor().clamp(0.0, (g - 1) as f32) as i32;
        let cz = (p.y / cell).floor().clamp(0.0, (g - 1) as f32) as i32;
        (cz * g + cx) as usize
    };

    // Bridges and their nav class at the deck centre.
    let bridges: Vec<_> = map
        .structures
        .iter()
        .filter(|s| s.kind as u8 == rf_core::types::skind::BRIDGE)
        .collect();
    println!("map {} seed {} {:?}: {} bridge pieces", map_index, seed, size, bridges.len());
    for (bi, b) in bridges.iter().enumerate() {
        let p = b.pos();
        let i = idx(p);
        let t = map.nav[i];
        println!(
            "  bridge {:2}: pos=({:6.1},{:6.1}) w={:.1} d={:.1} yaw={:.2} nav_at_centre={} water={} passable_land={}",
            bi,
            p.x,
            p.y,
            b.w,
            b.d,
            b.yaw,
            t,
            terrain::is_water(t),
            terrain::passable_land(t)
        );
    }

    for team in 0..2usize {
        let from = map.flag_home[team];
        let to = map.flag_home[1 - team];
        // BFS reachable set from `from`.
        let mut seen = vec![false; (g * g) as usize];
        let start = idx(from);
        if !terrain::passable_land(map.nav[start]) {
            println!(
                "team {}: START cell not passable ({}) at ({:.1},{:.1})",
                team,
                map.nav[start],
                from.x,
                from.y
            );
            continue;
        }
        seen[start] = true;
        let mut queue: Vec<u32> = vec![start as u32];
        let mut head = 0usize;
        while head < queue.len() {
            let cur = queue[head] as usize;
            head += 1;
            let cx = (cur as i32) % g;
            let cz = (cur as i32) / g;
            for (dx, dz) in [(1i32, 0), (-1, 0), (0, 1), (0, -1)] {
                let nx = cx + dx;
                let nz = cz + dz;
                if nx < 0 || nz < 0 || nx >= g || nz >= g {
                    continue;
                }
                let ni = (nz * g + nx) as usize;
                if seen[ni] || !terrain::passable_land(map.nav[ni]) {
                    continue;
                }
                seen[ni] = true;
                queue.push(ni as u32);
            }
        }
        let reached = queue.len();
        let goal_reached = seen[idx(to)];
        // Nearest reachable cell to the enemy home, and what class it is.
        let mut best_d = f32::MAX;
        let mut best_i = 0usize;
        for (i, &s) in seen.iter().enumerate() {
            if !s {
                continue;
            }
            let cx = (i as i32 % g) as f32 + 0.5;
            let cz = ((i as i32 / g) as f32) + 0.5;
            let d = v2(cx * cell, cz * cell).dist(to);
            if d < best_d {
                best_d = d;
                best_i = i;
            }
        }
        println!(
            "team {}: reached {}/{} cells | path to enemy home: {} | nearest reachable cell to enemy home: {:.1} m (nav class {} at ({:.0},{:.0}))",
            team,
            reached,
            g * g,
            goal_reached,
            best_d,
            map.nav[best_i],
            ((best_i as i32 % g) as f32 + 0.5) * cell,
            (((best_i as i32 / g) as f32) + 0.5) * cell
        );
    }
}
