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
    let mut minx=i32::MAX; let mut maxx=i32::MIN; let mut minz=i32::MAX; let mut maxz=i32::MIN;
    for &c in &q { let cx=(c as i32)%g; let cz=(c as i32)/g; minx=minx.min(cx); maxx=maxx.max(cx); minz=minz.min(cz); maxz=maxz.max(cz); }
    println!("pocket: {} cells, bbox cx[{}..{}] cz[{}..{}]", q.len(), minx, maxx, minz, maxz);
    // explicit chain checks
    let chk = |label: &str, x: f32, z: f32| {
        let cx = (x/cell).floor() as i32; let cz = (z/cell).floor() as i32;
        let i = (cz*g+cx) as usize;
        println!("{label}: ({:.1},{:.1}) cell({},{}) class={} passable={} in_pocket={}",
            x, z, cx, cz, map.nav[i], terrain::passable_land(map.nav[i]), seen[i]);
    };
    chk("flag", f.x, f.y);
    let (ba, byaw) = map.base_anchor[team];
    let (sn, cs) = (byaw.sin(), byaw.cos());
    let gx = ba.x + -6.0*cs - 19.0*sn;
    let gz = ba.y + -6.0*sn + 19.0*cs;
    chk("gate", gx, gz);
    // just outside the gate (perpendicular, away from base centre)
    let ox = gx + -sn * 4.0;  // perp dir candidates: print both
    let oz = gz + cs * 4.0;
    chk("outA(+perp)", ox, oz);
    chk("outB(-perp)", gx + sn*4.0, gz - cs*4.0);
    chk("far", map.flag_home[1-team].x, map.flag_home[1-team].y);
}
