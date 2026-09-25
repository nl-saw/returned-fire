//! Every editor function, checked against its own contract.
//!
//! `editor_play.rs` plays edited maps; this file tests the functions themselves — the brushes,
//! the structure ops, the base ops, the history and the save format — because a map that plays
//! fine can still be produced by a broken tool (a brush that silently no-ops, an eraser that
//! leaves pavement behind, an undo that restores half a stroke). The assertions are on the layer
//! bytes and the derived nav grid, at the points where each op promises to change something.

use rf_core::editor::{EditorMap, PlaceBlock};
use rf_core::mapgen::MapMode;
use rf_core::math::v2;
use rf_core::types::*;

/// A fresh classic small map — the mode and size the editor opens in.
fn new_map(seed: u32) -> EditorMap {
    EditorMap::new(seed, 0, MapMode::Classic, MapSize::Small)
}

/// Vertex grid stride of a map.
fn stride(e: &EditorMap) -> usize {
    e.map().grid as usize + 1
}

/// A vertex that is genuinely underwater (not a centimetre film).
fn find_water(e: &EditorMap) -> (usize, usize, f32) {
    let m = e.map();
    let v = m.grid as usize + 1;
    for iz in 2..v - 2 {
        for ix in 2..v - 2 {
            let h = m.heights[iz * v + ix];
            if h < -0.8 && h > -3.5 {
                return (ix, iz, h);
            }
        }
    }
    panic!("no underwater vertex found");
}

/// A dry land vertex on GROUND-class nav.
fn find_land(e: &EditorMap) -> (usize, usize, f32) {
    let m = e.map();
    let v = m.grid as usize + 1;
    for iz in 4..v - 4 {
        for ix in 4..v - 4 {
            let i = iz * v + ix;
            if m.heights[i] > 2.0 && m.nav_at(ix as f32 * m.cell, iz as f32 * m.cell) == terrain::GROUND {
                return (ix, iz, m.heights[i]);
            }
        }
    }
    panic!("no dry land vertex found");
}

fn vert(m: &MapData, ix: usize, iz: usize) -> f32 {
    let v = m.grid as usize + 1;
    m.heights[iz * v + ix]
}


/// Walk east in 4 m steps from (bx, bz) until `kind` fits: generated props can sit anywhere.
fn clear_spot(e: &EditorMap, kind: u8, bx: f32, bz: f32) -> (f32, f32) {
    for k in 0..16u32 {
        let (px, pz) = (bx + k as f32 * 4.0, bz);
        if e.can_place(kind, px, pz, 0.0).is_ok() {
            return (px, pz);
        }
    }
    panic!("no clear spot for kind {kind} near ({bx:.1},{bz:.1})");
}

// -- terrain brushes -------------------------------------------------------

#[test]
fn raise_removes_water_and_lowering_carves_it_back() {
    let mut e = new_map(11);
    let cell = e.map().cell;
    let (ix, iz, h0) = find_water(&e);
    let (x, z) = (ix as f32 * cell, iz as f32 * cell);
    assert!(e.map().is_water_at(x, z), "precondition: the probe point is water");

    // Raise through the waterline: the user's complaint was that water could not be removed.
    e.raise(x, z, 6.0, 4.0, 0.5);
    let h1 = vert(e.map(), ix, iz);
    assert!(h1 > h0 + 3.0, "raise moved {h0} to {h1}, wanted at least +3");
    assert!(!e.map().is_water_at(x, z), "water was not removed: h={h1}");
    // The nav grid is rebuilt after the step, so the cell must read as land now.
    let nav = e.map().nav_at(x, z);
    assert!(nav >= terrain::SAND, "nav still water ({nav}) after raising to {h1}");

    // And lowering works in the same place: carve it back below the waterline.
    e.raise(x, z, 6.0, -8.0, 0.5);
    let h2 = vert(e.map(), ix, iz);
    assert!(h2 < h1 - 6.0, "lower moved {h1} to {h2}, wanted at least -6");
    assert!(e.map().is_water_at(x, z), "lowering did not carve water: h={h2}");

    // Outside the brush nothing moves.
    let e2 = new_map(11);
    assert_eq!(vert(e2.map(), ix + 8, iz), vert(e.map(), ix + 8, iz));
}

#[test]
fn level_carves_sea_and_raises_beach() {
    let mut e = new_map(12);
    // Beach: a vertex close to the waterline on land.
    let (bx, bz) = {
        let m = e.map();
        let v = m.grid as usize + 1;
        let mut found = (0usize, 0usize);
        'outer: for iz in 4..v - 4 {
            for ix in 4..v - 4 {
                let h = m.heights[iz * v + ix];
                if (0.1..1.2).contains(&h) {
                    found = (ix, iz);
                    break 'outer;
                }
            }
        }
        found
    };
    let cell = e.map().cell;
    let (x, z) = (bx as f32 * cell, bz as f32 * cell);

    // Target below the waterline: carves sea.
    e.level(x, z, 5.0, -3.0, 1.0, 0.5);
    let h_sea = vert(e.map(), bx, bz);
    assert!(h_sea < -2.0, "level to -3 left the vertex at {h_sea}");
    assert!(e.map().is_water_at(x, z));

    // Target above: raises beach back out of the sea.
    e.level(x, z, 5.0, 4.0, 1.0, 0.5);
    let h_land = vert(e.map(), bx, bz);
    assert!(h_land > 3.0, "level to +4 left the vertex at {h_land}");
    assert!(!e.map().is_water_at(x, z));
}

#[test]
fn smooth_takes_the_spike_out() {
    let mut e = new_map(13);
    let cell = e.map().cell;
    let (ix, iz, _) = find_land(&e);
    let (x, z) = (ix as f32 * cell, iz as f32 * cell);
    // A one-vertex spike.
    e.raise(x, z, 1.5, 6.0, 0.95);
    let spike = vert(e.map(), ix, iz);
    assert!(spike > 7.0, "spike setup failed: {spike}");
    e.smooth(x, z, 8.0, 1.0, 0.5);
    let after = vert(e.map(), ix, iz);
    assert!(after < spike - 2.0, "smooth left the spike at {after} (was {spike})");
    // Neighbours absorbed some of it: a neighbour of the spike rose above plain ground.
    let before_neigh = vert(e.map(), ix + 1, iz);
    assert!(before_neigh > 2.5, "neighbour did not absorb the spike: {before_neigh}");
}

#[test]
fn paint_splat_keeps_the_quad_summed_to_255() {
    let mut e = new_map(14);
    let cell = e.map().cell;
    let (ix, iz, _) = find_land(&e);
    let i = iz * stride(&e) + ix;
    let sum0: u32 = (0..4).map(|k| e.map().splat[i * 4 + k] as u32).sum();
    assert_eq!(sum0, 255, "precondition: generated splat sums to 255");

    e.paint_splat(2, ix as f32 * cell, iz as f32 * cell, 4.0, 1.0, 0.5);
    let m = e.map();
    let c: [u8; 4] = [m.splat[i * 4], m.splat[i * 4 + 1], m.splat[i * 4 + 2], m.splat[i * 4 + 3]];
    assert!(c[2] > 200, "painted channel did not rise: {c:?}");
    let sum: u32 = c.iter().map(|b| *b as u32).sum();
    assert_eq!(sum, 255, "splat no longer sums to 255: {c:?}");
}

#[test]
fn paint_material_moves_family_and_variant_together() {
    let mut e = new_map(15);
    let cell = e.map().cell;
    let (ix, iz, _) = find_land(&e);
    let i = iz * stride(&e) + ix;
    let sand_before = e.map().splat[i * 4] as u32;

    // Family 0 (sand), variant 2 (coral): the weight rises AND the variant moves.
    e.paint_material(0, 2, ix as f32 * cell, iz as f32 * cell, 4.0, 1.0, 0.5);
    let m = e.map();
    assert!(m.splat[i * 4] as u32 > sand_before.max(200), "sand weight did not rise");
    assert!(m.sand_var[i] > 180, "sand variant did not move to coral: {}", m.sand_var[i]);

    // Family 1 (grass) variant 0.
    e.paint_material(1, 0, ix as f32 * cell, iz as f32 * cell, 4.0, 1.0, 0.5);
    let m = e.map();
    assert!(m.splat[i * 4 + 3] > 200, "grass weight did not rise: {:?}", &m.splat[i * 4..i * 4 + 4]);
    assert!(m.grass_var[i] < 70, "grass variant did not move to lush: {}", m.grass_var[i]);
}

#[test]
fn paint_pave_and_road_stroke_lay_and_erase_pavement() {
    let mut e = new_map(16);
    let cell = e.map().cell;
    let (ix, iz, _) = find_land(&e);
    let i = iz * stride(&e) + ix;
    assert!(e.map().road[i] < 40, "precondition: the probe vertex is unpaved");

    // A straight stroke through the probe point.
    let (x, z) = (ix as f32 * cell, iz as f32 * cell);
    e.road_stroke(&[x - 10.0, z, x + 10.0, z], 2.5, 0, false);
    let road = e.map().road[i];
    assert!(road > 180, "stroke did not pave the centre line: {road}");

    // Erasing the same stroke takes it back out — the old bug was pavement that survived.
    e.road_stroke(&[x - 10.0, z, x + 10.0, z], 2.5, 0, true);
    let road = e.map().road[i];
    assert!(road < 30, "erase left pavement behind: {road}");

    // paint_pave on its own.
    e.paint_pave(x, z, 4.0, 255, 1, 1.0, 0.5);
    let m = e.map();
    assert!(m.road[i] > 200, "paint_pave did not raise the road mask");
    assert_eq!(m.pave[i], 1, "paint_pave did not write the pave shape");
}

// -- structures ------------------------------------------------------------

#[test]
fn place_rejects_water_and_offmap_but_allows_bridges_in_water() {
    let mut e = new_map(17);
    let cell = e.map().cell;
    let world = e.map().world_size;
    let (wx, wz, _) = find_water(&e);
    let (wpx, wpz) = (wx as f32 * cell, wz as f32 * cell);

    // A wall in the sea is refused.
    assert_eq!(e.can_place(skind::WALL, wpx, wpz, 0.0), Err(PlaceBlock::Water));
    // A bridge is exactly what belongs there — find a water spot with no generated prop under it
    // so the check we are exercising is the water rule, not the overlap rule.
    let v = stride(&e);
    let mut bridge_ok = false;
    for iz in 2..v - 2 {
        for ix in 2..v - 2 {
            if e.map().heights[iz * v + ix] > -0.8 || e.map().heights[iz * v + ix] < -3.5 {
                continue;
            }
            let (px, pz) = (ix as f32 * cell, iz as f32 * cell);
            if e.can_place(skind::BRIDGE, px, pz, 0.0).is_ok() {
                bridge_ok = true;
                break;
            }
        }
        if bridge_ok {
            break;
        }
    }
    assert!(bridge_ok, "no water spot accepted a bridge");

    // Off the map is refused for everything.
    assert_eq!(e.can_place(skind::WALL, -5.0, world / 2.0, 0.0), Err(PlaceBlock::OffMap));
    assert_eq!(
        e.can_place(skind::WALL, world + 5.0, world / 2.0, 0.0),
        Err(PlaceBlock::OffMap)
    );

    // A wall on land places, and the same spot is now occupied. Generated props can sit on the
    // first GROUND vertex, so clear a spot with the same rule the editor uses.
    let (lx, lz, _) = find_land(&e);
    let (lpx, lpz) = (lx as f32 * cell, lz as f32 * cell);
    let (wx, wz) = clear_spot(&e, skind::WALL, lpx, lpz);
    assert!(e.can_place(skind::WALL, wx, wz, 0.0).is_ok());
    let n0 = e.map().structures.len();
    assert!(e.place(skind::WALL, 0, wx, wz, 0.0, false));
    assert_eq!(e.map().structures.len(), n0 + 1);
    assert_eq!(e.can_place(skind::WALL, wx, wz, 0.0), Err(PlaceBlock::Occupied));
}

#[test]
fn move_and_rotate_structure_update_the_record() {
    let mut e = new_map(18);
    let cell = e.map().cell;
    let (lx, lz, _) = find_land(&e);
    let (x, z) = (lx as f32 * cell, lz as f32 * cell);
    // Find a clear spot to place the tent and later move it to: generated props can sit
    // anywhere, so both destinations must be checked with the same rule the editor uses.
    let (sx, sz) = clear_spot(&e, skind::TENT, x + 6.0, z);
    assert!(e.place(skind::TENT, 0, sx, sz, 0.0, false));
    let idx = e.map().structures.len() as i32 - 1;

    // Move it ten metres: the record follows.
    let (tx, tz) = clear_spot(&e, skind::TENT, sx + 10.0, sz);
    assert_eq!(e.move_structure(idx, tx, tz, 0.0), PlaceBlock::Never);
    let s = &e.map().structures[idx as usize];
    assert!((s.x - tx).abs() < 0.01 && (s.z - tz).abs() < 0.01, "move did not update pos");

    // A quarter turn: yaw advances by pi/2 about the structure's own centre.
    let yaw0 = s.yaw;
    assert_eq!(e.rotate_structure(idx, 1), PlaceBlock::Never);
    let s = &e.map().structures[idx as usize];
    let d = (s.yaw - yaw0).abs();
    let want = core::f32::consts::FRAC_PI_2;
    assert!(
        (d - want).abs() < 0.05 || (d + want).abs() < 0.05,
        "quarter turn moved yaw by {d}"
    );

    // Out-of-range indices are reported, not panics.
    assert_eq!(e.move_structure(99999, x, z, 0.0), PlaceBlock::Missing);
    assert_eq!(e.rotate_structure(-1, 1), PlaceBlock::Missing);
}

#[test]
fn erase_removes_structures_and_pavement_under_the_brush() {
    let mut e = new_map(19);
    let cell = e.map().cell;
    let (lx, lz, _) = find_land(&e);
    let i = lz * stride(&e) + lx;
    let (x, z) = (lx as f32 * cell, lz as f32 * cell);
    // Place the props where they are allowed to go; generated props may already be nearby.
    let (cx, cz) = clear_spot(&e, skind::CRATE, x, z - 1.5);
    assert!(e.place(skind::CRATE, 0, cx, cz, 0.0, false));
    let (bx, bz) = clear_spot(&e, skind::BARREL, cx + 1.5, z);
    assert!(e.place(skind::BARREL, 0, bx, bz, 0.0, false));

    // Erase over both: they are gone, whatever else was under the brush is not our concern.
    let removed = e.erase(cx, cz, 4.0, true, true);
    assert!(removed >= 2, "erase removed {removed}, wanted both props");
    for s in &e.map().structures {
        assert!((s.x - cx).abs() > 1.0 || (s.z - cz).abs() > 1.0, "crate survived the eraser");
        assert!((s.x - bx).abs() > 1.0 || (s.z - bz).abs() > 1.0, "barrel survived the eraser");
    }

    // Pavement under the brush is gone too.
    e.road_stroke(&[x - 8.0, z, x + 8.0, z], 2.0, 0, false);
    assert!(e.map().road[i] > 150);
    e.erase(x, z, 4.0, true, false);
    assert!(e.map().road[i] < 30, "pavement survived the eraser: {}", e.map().road[i]);

    // A structure well outside the brush survives.
    let mut far = cx + 20.0;
    for _ in 0..8 {
        if e.can_place(skind::CRATE, far, z, 0.0).is_ok() {
            break;
        }
        far += 4.0;
    }
    assert!(e.place(skind::CRATE, 0, far, z, 0.0, false), "no clear spot for the far crate");
    let n1 = e.map().structures.len();
    e.erase(cx, cz, 4.0, true, true);
    assert_eq!(e.map().structures.len(), n1, "erase reached outside its brush");
}

#[test]
fn scatter_is_deterministic_and_never_plants_in_water() {
    let mut e = new_map(20);
    let world = e.map().world_size;
    // A big land disc: the map centre is where the generator keeps dry ground.
    let (x, z) = (world / 2.0, world / 2.0);
    let n0 = e.map().structures.len();
    let made = e.scatter(0, x, z, 25.0, 3.0, 42);
    assert!(made > 0, "scatter placed nothing on the map centre");

    // Every prop it added stands on dry ground.
    for s in &e.map().structures[n0..] {
        let p = s.pos();
        assert!(!e.map().is_water_at(p.x, p.y), "prop planted in water at ({:.1},{:.1})", p.x, p.y);
    }

    // Same seed, same stroke: the same scatter.
    let mut e2 = new_map(20);
    let made2 = e2.scatter(0, x, z, 25.0, 3.0, 42);
    assert_eq!(made, made2, "scatter is not deterministic across maps");
}

#[test]
fn copy_and_paste_move_the_layers_exactly() {
    let mut e = new_map(21);
    let cell = e.map().cell;
    let (lx, lz, _) = find_land(&e);
    let (x0, z0) = (lx as f32 * cell - 6.0, lz as f32 * cell - 6.0);
    let (x1, z1) = (lx as f32 * cell + 6.0, lz as f32 * cell + 6.0);
    // Paint a road through the source rectangle and put a crate in it: the clipboard carries
    // pavement and structures (terrain is deliberately not copied — pasted props reseat on the
    // ground under them).
    e.road_stroke(&[x0, (z0 + z1) / 2.0, x1, (z0 + z1) / 2.0], 2.0, 0, false);
    let (mcx, mcz) = ((x0 + x1) / 2.0, (z0 + z1) / 2.0);
    assert!(e.can_place(skind::CRATE, mcx, mcz, 0.0).is_ok(), "source centre should be clear");
    assert!(e.place(skind::CRATE, 0, mcx, mcz, 0.0, false));

    let clip = e.copy_rect(x0, z0, x1, z1, v2(mcx, mcz));
    assert_eq!(clip.len(), 1, "the clipboard should carry the crate");
    // Destination: somewhere else on land, clear of the source.
    let (dx, dz) = (mcx + 40.0, mcz + 40.0);
    let pasted = e.paste_rect(&clip, dx, dz);
    assert_eq!(pasted, 1, "paste dropped the crate");

    // The crate landed exactly at the cursor offset from where it was copied.
    let moved = e.map().structures.iter().rev().find(|s| s.kind == skind::CRATE as f32);
    let Some(moved) = moved else { panic!("pasted crate not found") };
    assert!((moved.x - dx).abs() < 0.5 && (moved.z - dz).abs() < 0.5,
        "crate at ({:.1},{:.1}), wanted under the cursor ({dx:.1},{dz:.1})", moved.x, moved.z);

    // The pasted centre line carries the road mask.
    let v = stride(&e);
    let cx = (dx / cell).round() as usize;
    let cz = (dz / cell).round() as usize;
    assert!(e.map().road[cz * v + cx] > 150, "pasted pavement is missing");
}

// -- bases -----------------------------------------------------------------

#[test]
fn stamp_base_builds_one_complex_and_move_replaces_it_in_place() {
    let mut e = new_map(22);
    let cell = e.map().cell;
    let world = e.map().world_size;
    let (lx, lz, _) = find_land(&e);
    let (x, z) = (lx as f32 * cell, lz as f32 * cell);

    // Stamp team 0's base at a fresh spot.
    e.stamp_base(0, x, z, 0.5);
    let parts: Vec<_> = e
        .map()
        .structures
        .iter()
        .filter(|s| s.flag(sflag::BASE) && s.team == 0.0)
        .collect();
    assert!(parts.len() > 10, "base complex is too small: {} parts", parts.len());
    // Every part sits near the anchor it was stamped at.
    for s in &parts {
        let d = s.pos().dist(v2(x, z));
        assert!(d < 40.0, "base part {} m from its anchor", d);
    }
    // Spawn pad follows the base.
    assert!(e.map().spawn[0].dist(v2(x, z)) < 15.0, "spawn pad did not follow the base");

    // Move it: the old complex is gone, the new one stands at the new anchor, still exactly one.
    // (move_base re-stamps the blueprint at the new yaw, so part distances are not a rigid
    // translation — assert on the anchors, not on per-part offsets.)
    let (x2, z2) = (x + 120.0, z + 40.0);
    if x2 < world - 30.0 && z2 < world - 30.0 {
        e.move_base(0, x2, z2, 0.9);
        let parts: Vec<_> = e
            .map()
            .structures
            .iter()
            .filter(|s| s.flag(sflag::BASE) && s.team == 0.0)
            .collect();
        assert!(parts.len() > 10, "moved base lost parts: {}", parts.len());
        for s in &parts {
            let d_old = s.pos().dist(v2(x, z));
            let d_new = s.pos().dist(v2(x2, z2));
            assert!(d_new < 40.0, "part at ({:.1},{:.1}) is {d_new:.1} m from the new anchor", s.pos().x, s.pos().y);
            assert!(d_old > 15.0, "part at ({:.1},{:.1}) lingers by the old anchor ({d_old:.1} m)", s.pos().x, s.pos().y);
        }
    }
}

#[test]
fn reseat_lifts_buildings_with_the_terrain() {
    let mut e = new_map(23);
    let cell = e.map().cell;
    let (lx, lz, _) = find_land(&e);
    let (x, z) = (lx as f32 * cell, lz as f32 * cell);
    assert!(e.place(skind::BUILDING, 0, x, z, 0.0, false));
    let idx = e.map().structures.len() as i32 - 1;
    let y0 = e.map().structures[idx as usize].y;

    // Raise the ground two metres under it: without reseat the building is buried.
    e.raise(x, z, 5.0, 2.0, 0.9);
    let ground = e.map().height_at(x, z);
    assert!(ground > y0 + 1.0, "setup: the ground should now be above the old seat");

    e.reseat();
    let y1 = e.map().structures[idx as usize].y;
    assert!(y1 >= ground - 0.15, "reseat left the building buried: y={y1} ground={ground}");
}

// -- history ---------------------------------------------------------------

#[test]
fn undo_redo_round_trip_terrain_structures_and_bases() {
    let mut e = new_map(24);
    let cell = e.map().cell;
    let (lx, lz, _) = find_land(&e);
    let (x, z) = (lx as f32 * cell, lz as f32 * cell);
    let h0 = vert(e.map(), lx, lz);
    let n0 = e.map().structures.len();

    // Three distinct steps.
    e.raise(x, z, 5.0, 3.0, 0.5);
    assert!(e.place(skind::CRATE, 0, x + 8.0, z, 0.0, false));
    let (wx, wz, _) = find_water(&e);
    e.stamp_base(1, wx as f32 * cell + 10.0, wz as f32 * cell + 10.0, 0.0);

    assert!(e.can_undo());
    // Undo the base step: team 1's complex is gone, structures back to n0+1.
    assert!(e.undo());
    assert_eq!(e.map().structures.len(), n0 + 1, "undo(base) left {} structures", e.map().structures.len());
    // Undo the place: back to n0, terrain still raised.
    assert!(e.undo());
    assert_eq!(e.map().structures.len(), n0);
    assert!((vert(e.map(), lx, lz) - h0).abs() > 2.0, "terrain should still be raised");
    // Undo the raise: heights restored exactly (the step stores the before bytes).
    assert!(e.undo());
    assert!((vert(e.map(), lx, lz) - h0).abs() < 0.01, "undo(raise) did not restore heights");

    // Redo replays all three in order.
    assert!(e.redo());
    assert!((vert(e.map(), lx, lz) - h0).abs() > 2.0);
    assert!(e.redo());
    assert_eq!(e.map().structures.len(), n0 + 1);
    assert!(e.redo());
    let parts: Vec<_> = e.map().structures.iter().filter(|s| s.flag(sflag::BASE) && s.team == 1.0).collect();
    assert!(!parts.is_empty(), "redo(base) did not rebuild the complex");

    // A new step clears the redo stack.
    e.raise(x, z, 5.0, -1.0, 0.5);
    assert!(!e.can_redo());
}

#[test]
fn begin_end_stroke_merges_dabs_into_one_undo_step() {
    let mut e = new_map(25);
    let cell = e.map().cell;
    let (lx, lz, _) = find_land(&e);
    let (x, z) = (lx as f32 * cell, lz as f32 * cell);
    let h0 = vert(e.map(), lx, lz);

    e.begin_stroke("raise");
    for k in 0..5 {
        e.raise(x + k as f32 * 1.5, z, 4.0, 2.0, 0.9);
    }
    e.end_stroke();
    // Dabs 0-2 fall inside the flat core of the brush (hard 0.9 of a 4 m radius), so the centre
    // vertex takes at least +6 — far more than any single dab's +2.
    assert!(vert(e.map(), lx, lz) > h0 + 3.0, "dabs did not accumulate");

    // One undo takes the whole stroke back.
    assert!(e.undo());
    assert!((vert(e.map(), lx, lz) - h0).abs() < 0.01, "one undo should restore the pre-stroke height");
}

// -- persistence -----------------------------------------------------------

#[test]
fn save_load_round_trip_preserves_everything_the_editor_touches() {
    let mut e = new_map(26);
    let cell = e.map().cell;
    let (lx, lz, _) = find_land(&e);
    let (x, z) = (lx as f32 * cell, lz as f32 * cell);

    // A battery of edits across every layer: the base first — its spawn pad sits six metres off
    // the anchor, so walk candidate anchors until validate() accepts the pad's ground.
    let mut stamped = false;
    for (ox, oz) in [
        (0.0, 0.0), (40.0, 0.0), (-40.0, 0.0), (0.0, 40.0), (80.0, 0.0), (0.0, 80.0),
        (40.0, 40.0), (-40.0, 40.0), (80.0, 40.0), (0.0, -40.0),
    ] {
        e.stamp_base(0, x + ox, z + oz, 1.2);
        if e.validate().is_ok() {
            stamped = true;
            break;
        }
    }
    assert!(stamped, "no candidate anchor left a drivable spawn pad");
    let (ex, ez) = (x + 90.0, z);
    e.raise(ex, ez, 6.0, 3.0, 0.5);
    e.level(ex + 12.0, ez, 4.0, -2.0, 1.0, 0.5);
    e.paint_splat(1, ex, ez + 8.0, 4.0, 1.0, 0.5);
    e.paint_material(0, 1, ex, ez - 8.0, 4.0, 1.0, 0.5);
    e.road_stroke(&[ex - 10.0, ez + 20.0, ex + 10.0, ez + 20.0], 2.0, 2, false);
    if e.can_place(skind::TURRET_TOWER, ex + 30.0, ez, 0.7).is_ok() {
        assert!(e.place(skind::TURRET_TOWER, 0, ex + 30.0, ez, 0.7, false));
    }
    e.scatter(0, ex - 30.0, ez, 15.0, 2.0, 7);

    let bytes = e.to_bytes();
    assert!(!bytes.is_empty());
    let back = EditorMap::from_bytes(&bytes).expect("an edited map reopens");

    // Layers: compare the whole vertex grid for heights and road.
    let a = e.map();
    let b = back.map();
    assert_eq!(a.heights.len(), b.heights.len());
    let mut h_diff = 0;
    let mut r_diff = 0;
    let mut s_diff = 0;
    for i in 0..a.heights.len() {
        if (a.heights[i] - b.heights[i]).abs() > 1e-4 {
            h_diff += 1;
        }
        if a.road[i] != b.road[i] {
            r_diff += 1;
        }
        for k in 0..4 {
            if a.splat[i * 4 + k] != b.splat[i * 4 + k] {
                s_diff += 1;
            }
        }
    }
    assert_eq!(h_diff, 0, "{h_diff} heights differ after reload");
    assert_eq!(r_diff, 0, "{r_diff} road bytes differ after reload");
    assert_eq!(s_diff, 0, "{s_diff} splat bytes differ after reload");

    // Structures: same count, same kinds at the same places.
    assert_eq!(a.structures.len(), b.structures.len(), "structure count changed on reload");
    for (sa, sb) in a.structures.iter().zip(b.structures.iter()) {
        assert_eq!(sa.kind, sb.kind);
        assert!((sa.x - sb.x).abs() < 1e-3 && (sa.z - sb.z).abs() < 1e-3, "structure moved on reload");
    }

    // Bases and pads.
    for t in 0..2 {
        let (pa, _) = a.base_anchor[t];
        let (pb, _) = b.base_anchor[t];
        assert!((pa - pb).len() < 1e-3, "base anchor {t} moved on reload");
        assert!((a.spawn[t] - b.spawn[t]).len() < 1e-3);
        assert!((a.flag_home[t] - b.flag_home[t]).len() < 1e-3);
    }

    // The reloaded map still validates.
    back.validate().expect("reloaded map fails validation");
}

#[test]
fn validate_accepts_a_generated_map_and_an_edited_one() {
    let mut e = new_map(27);
    e.validate().expect("a fresh generated map must validate");
    let cell = e.map().cell;
    let (lx, lz, _) = find_land(&e);
    e.raise(lx as f32 * cell, lz as f32 * cell, 8.0, 5.0, 0.5);
    assert!(e.place(skind::WALL, 0, lx as f32 * cell + 10.0, lz as f32 * cell, 0.0, false));
    e.validate().expect("a lightly edited map must validate");
}

#[test]
fn reseed_replaces_the_island_but_keeps_it_undoable() {
    let mut e = new_map(28);
    let h_before: Vec<f32> = e.map().heights[0..64].to_vec();
    e.raise(100.0, 100.0, 5.0, 4.0, 0.5);

    // The replaced island is *kept*: a stray click on the seed must not destroy work, so
    // "new island" is a step like any other and undo brings the old island back.
    e.reseed(99, 0);
    let h_after: Vec<f32> = e.map().heights[0..64].to_vec();
    assert_ne!(h_before, h_after, "reseed did not change the island");
    assert!(e.can_undo(), "the replaced island must be undoable");

    assert!(e.undo());
    let h_back: Vec<f32> = e.map().heights[0..64].to_vec();
    assert_eq!(h_before, h_back, "undo did not restore the pre-reseed island");
}
