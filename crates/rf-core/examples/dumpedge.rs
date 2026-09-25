use rf_core::types::terrain;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let team: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let mut map = rf_core::mapgen::generate_sized(seed, 0, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Medium);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    let cell = map.cell;
    let f = map.flag_home[team];
    let si = (((f.y / cell).floor()) as i32 * g + ((f.x / cell).floor()) as i32) as usize;
    let mut seen = vec![false; (g * g) as usize];
    seen[si] = true;
    let mut q: Vec<usize> = vec![si];
    let mut head = 0;
    while head < q.len() {
        let cur = q[head]; head += 1;
        let cx = (cur as i32) % g; let cz = (cur as i32) / g;
        for (dx, dz) in [(1i32,0),(-1,0),(0,1),(0,-1)] {
            let nx = cx+dx; let nz = cz+dz;
            if nx<0||nz<0||nx>=g||nz>=g { continue; }
            let ni = (nz*g+nx) as usize;
            if seen[ni] || !terrain::passable_land(map.nav[ni]) { continue; }
            seen[ni] = true; q.push(ni);
        }
    }
    println!("pocket size: {} cells", q.len());
    // boundary: reachable cell next to a non-passable one; group by class, print first 40
    let mut n = 0;
    for cur in &q {
        let cx = (*cur as i32) % g; let cz = (*cur as i32) / g;
        for (dx, dz) in [(1i32,0),(-1,0),(0,1),(0,-1)] {
            let nx = cx+dx; let nz = cz+dz;
            if nx<0||nz<0||nx>=g||nz>=g { continue; }
            let ni = (nz*g+nx) as usize;
            if seen[ni] { continue; }
            let t = map.nav[ni];
            let h = map.height_at(((nx as f32)+0.5)*cell, ((nz as f32)+0.5)*cell);
            n += 1;
            if n <= 60 {
                println!("edge ({:6.1},{:6.1}) class={} h={:.2} (from ({:.1},{:.1}))",
                    (nx as f32+0.5)*cell, (nz as f32+0.5)*cell, t, h,
                    (cx as f32+0.5)*cell, (cz as f32+0.5)*cell);
            }
        }
    }
    println!("total boundary edges: {n}");
}
