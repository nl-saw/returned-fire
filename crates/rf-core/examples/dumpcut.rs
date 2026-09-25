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
    let c0 = ((f.x/cell).floor() as i32, (f.y/cell).floor() as i32);
    let mut seen = vec![false; (g*g) as usize];
    let si = (c0.1 * g + c0.0) as usize;
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
    // print strip: 'P' passable-in-pocket, '.' passable-outside, '#' blocked, '~' water
    for cz in (70..=80).rev() {
        let mut line = String::new();
        for cx in 146..=166 {
            let i = cz as usize * g as usize + cx as usize;
            let t = map.nav[i];
            line.push(if !terrain::passable_land(t) { if terrain::is_water(t) {'~'} else {'#'} } else if seen[i] {'P'} else {'.'});
        }
        println!("cz{:>3} {}", cz, line);
    }
    println!("cols cx 146..166");
}
