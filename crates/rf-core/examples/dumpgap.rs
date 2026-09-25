//! Gap probe: BFS passable_land from flag_home[team]; report pocket size, bbox, and the
//! nearest frontier cells to the enemy flag home (the cut).
use rf_core::types::terrain;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seed: u32 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let map_idx: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let size_i: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let team: usize = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
    let size = [rf_core::types::MapSize::Small, rf_core::types::MapSize::Medium, rf_core::types::MapSize::Big][size_i];
    let mut map = rf_core::mapgen::generate_sized(seed, map_idx as u32, rf_core::mapgen::MapMode::Classic, size);
    rf_core::normalize_map(&mut map);
    let g = map.grid as i32;
    let cell = map.cell;
    let f = map.flag_home[team];
    let e = map.flag_home[1 - team];
    let ci = |p: rf_core::math::Vec2| -> (i32, i32) { ((p.x/cell).floor() as i32, (p.y/cell).floor() as i32) };
    let (fx, fz) = ci(f); let (ex, ez) = ci(e);
    let mut seen = vec![false; (g*g) as usize];
    let si = (fz * g + fx) as usize;
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
    let mut minx=i32::MAX; let mut maxx=i32::MIN; let mut minz=i32::MAX; let mut maxz=i32::MIN;
    for &c in &q { let cx=(c as i32)%g; let cz=(c as i32)/g; minx=minx.min(cx); maxx=maxx.max(cx); minz=minz.min(cz); maxz=maxz.max(cz); }
    println!("seed {seed} map {map_idx} {:?} team {team}: reached {} cells, bbox cx[{}..{}] cz[{}..{}]", size, q.len(), minx, maxx, minz, maxz);
    // frontier cells (reachable, with a non-passable 4-neighbour) nearest to enemy flag home
    let mut front: Vec<(f32, i32, i32)> = Vec::new();
    for &c in &q {
        let cx = (c as i32)%g; let cz = (c as i32)/g;
        let blocked_nb = [(1i32,0),(-1,0),(0,1),(0,-1)].iter().any(|&(dx,dz)| {
            let nx=cx+dx; let nz=cz+dz;
            if nx<0||nz<0||nx>=g||nz>=g { return false; }
            !terrain::passable_land(map.nav[(nz*g+nx) as usize])
        });
        if blocked_nb {
            let d = (((cx - ex) as f32).powi(2) + ((cz - ez) as f32).powi(2)).sqrt() * cell;
            front.push((d, cx, cz));
        }
    }
    front.sort_by(|a,b| a.0.partial_cmp(&b.0).unwrap());
    println!("nearest frontier to enemy flag home ({:.1}, {:.1}):", e.x, e.y);
    for (d, cx, cz) in front.iter().take(8) {
        let cls = map.nav[(cz*g+cx) as usize];
        let h = map.height_at(*cx as f32*cell, *cz as f32*cell);
        println!("  ({}, {}) dist {:.1} m nav={} h={:.2}", cx, cz, d, cls, h);
    }
    // what structures sit near those frontier cells?
    for (d, cx, cz) in front.iter().take(3) {
        let wx = *cx as f32*cell; let wz = *cz as f32*cell;
        for s in &map.structures {
            let dd = ((s.x-wx).powi(2)+(s.z-wz).powi(2)).sqrt();
            if dd < 12.0 {
                println!("  struct near ({},{}) dist {:.1}: kind={} team={:.0} pos=({:.1},{:.1}) w={:.1} d={:.1}", cx, cz, dd, s.kind as u8, s.team, s.x, s.z, s.w, s.d);
            }
        }
    }
}
