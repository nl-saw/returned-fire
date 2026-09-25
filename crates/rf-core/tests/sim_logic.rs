//! Physics / combat / AI unit tests on a synthetic flat map, so the simulation core can be
//! validated independently of the procedural map generator.

use rf_core::math::{v2, v3};
use rf_core::spec::vehicle;
use rf_core::types::{
    ekind, skind, sflag, terrain, vflag, vkind, vstate, MapData, Structure, CELL, GRID, VERTS,
    WATER_LEVEL, WORLD_SIZE,
};
use rf_core::world::{Input, World};

/// A flat island covering everything above `shore_z`; the rest is deep water.
fn flat_map(shore_fraction: f32) -> MapData {
    let shore_z = WORLD_SIZE * shore_fraction;
    let mut heights = vec![0.0f32; (VERTS * VERTS) as usize];
    for iz in 0..VERTS {
        for ix in 0..VERTS {
            let z = iz as f32 * CELL;
            let h = if z < shore_z { 3.0 } else { -6.0 };
            heights[(iz * VERTS + ix) as usize] = h;
        }
    }
    let mut nav = vec![terrain::GROUND; (GRID * GRID) as usize];
    for iz in 0..GRID {
        let z = iz as f32 * CELL;
        if z >= shore_z {
            for ix in 0..GRID {
                nav[(iz * GRID + ix) as usize] = terrain::DEEP_WATER;
            }
        }
    }
    MapData {
        name: "test-flat".into(),
        world_size: WORLD_SIZE,
        grid: GRID,
        cell: CELL,
        heights,
        splat: vec![0, 200, 0, 55].repeat((VERTS * VERTS) as usize),
        road: vec![0u8; (VERTS * VERTS) as usize],
        sand_var: vec![1u8; (VERTS * VERTS) as usize],
        grass_var: vec![1u8; (VERTS * VERTS) as usize],
        pave: vec![0u8; (VERTS * VERTS) as usize],
        nav,
        structures: Vec::new(),
        spawn: [v2(30.0, 20.0), v2(WORLD_SIZE - 30.0, 20.0)],
        flag_home: [v2(34.0, 24.0), v2(WORLD_SIZE - 34.0, 24.0)],
        // A bare test map has no base complex; the anchors its pads would imply are as good as any.
        base_anchor: [(v2(34.0, 24.0), 0.0), (v2(WORLD_SIZE - 34.0, 24.0), 0.0)],
        water_level: WATER_LEVEL,
    }
}

fn wall(map: &mut MapData, pos: rf_core::Vec2, w: f32, d: f32, hp: f32) -> usize {
    let mut s = Structure::new(skind::WALL, 2, pos, 3.0, 0.0, w, d, 4.0);
    s.flags = (sflag::SOLID | sflag::DESTRUCTIBLE | sflag::BLOCKS_LOS) as f32;
    s.hp = hp;
    s.hp_max = hp;
    map.structures.push(s);
    map.structures.len() - 1
}

fn world_with(map: MapData) -> World {
    World::new_with_map(42, map, [0, -1])
}

fn input(throttle: f32, steer: f32) -> Input {
    Input {
        throttle,
        steer,
        ..Default::default()
    }
}

#[test]
fn vehicles_accelerate_and_stop_when_out_of_fuel() {
    // Both slots human, so this synthetic map fields no AI garrison. The test used to pass for
    // the wrong reason: an AI hull on the enemy team drove into the player's jeep and the
    // collision response (`fwd_speed *= 0.35` on every tick in contact) stopped it inside a
    // second. With the lane clear, the dead engine coasts on ground drag alone,
    // `dv/dt = -(1.6 + 0.06 v)`, which takes about 8.5 s from top speed.
    let mut w = World::new_with_map(42, flat_map(0.7), [0, 1]);
    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    let start = w.vehicles[vi].pos;
    for _ in 0..180 {
        w.step(1.0 / 60.0, &[input(1.0, 0.0), Input::default()]);
    }
    let moved = w.vehicles[vi].pos.dist(start);
    assert!(moved > 10.0, "jeep barely moved: {moved}");
    assert!(w.vehicles[vi].fuel < vehicle::JEEP.fuel_max);

    // Drain the tank and confirm the jeep coasts to a halt. The window is the drag model's own
    // stopping time, not the one a helpful collision used to provide.
    w.vehicles[vi].fuel = 0.0;
    for _ in 0..(60 * 15) {
        w.step(1.0 / 60.0, &[input(1.0, 0.0), Input::default()]);
    }
    assert!(
        w.vehicles[vi].vel.len() < 1.0,
        "out-of-fuel jeep still moving at {}",
        w.vehicles[vi].vel.len()
    );
}

#[test]
fn tank_turret_tracks_the_aim_direction() {
    let mut w = world_with(flat_map(0.7));
    let id = w.spawn_vehicle(vkind::TANK, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    let want = std::f32::consts::FRAC_PI_2; // aim east
    for _ in 0..180 {
        let mut i = input(0.0, 0.0);
        i.has_aim = true;
        i.aim = want;
        w.step(1.0 / 60.0, &[i, Input::default()]);
    }
    let err = (w.vehicles[vi].turret_yaw - want).abs();
    assert!(err < 0.05, "turret did not converge, error {err}");
}

#[test]
fn firing_consumes_ammo_and_damages_structures() {
    let mut map = flat_map(0.7);
    let wall_idx = wall(&mut map, v2(70.0, 40.0), 6.0, 6.0, 250.0);
    let mut w = world_with(map);
    let id = w.spawn_vehicle(vkind::TANK, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = v2(45.0, 40.0);
    w.vehicles[vi].yaw = std::f32::consts::FRAC_PI_2; // face +x
    w.vehicles[vi].turret_yaw = std::f32::consts::FRAC_PI_2;
    let ammo_before = w.vehicles[vi].ammo0;
    let hp_before = w.map.structures[wall_idx].hp;

    for _ in 0..600 {
        let mut i = input(0.0, 0.0);
        i.has_aim = true;
        i.aim = std::f32::consts::FRAC_PI_2;
        i.fire0 = true;
        w.step(1.0 / 60.0, &[i, Input::default()]);
        if w.map.structures[wall_idx].hp < hp_before {
            break;
        }
    }
    assert!(w.vehicles[vi].ammo0 < ammo_before, "no ammo was consumed");
    assert!(
        w.map.structures[wall_idx].hp < hp_before,
        "tank shells never damaged the wall (hp {} -> {})",
        hp_before,
        w.map.structures[wall_idx].hp
    );
}

#[test]
fn tank_kills_a_jeep_with_one_shell_on_flat_ground() {
    // The original: a jeep is destroyed by a single hit. This is the end-to-end check that
    // the muzzle offset, the aim pitch and the direct-hit window all agree.
    let mut w = world_with(flat_map(0.9));
    let jeep = w.spawn_vehicle(vkind::JEEP, 1, 2);
    let ji = w.vehicle_index(jeep).unwrap();
    w.vehicles[ji].pos = v2(120.0, 60.0);
    w.vehicles[ji].spawn_guard = 0.0;
    let tank = w.spawn_vehicle(vkind::TANK, 0, 1);
    let ti = w.vehicle_index(tank).unwrap();
    w.vehicles[ti].pos = v2(78.0, 60.0);
    w.vehicles[ti].spawn_guard = 0.0;
    let yaw = (w.vehicles[ji].pos - w.vehicles[ti].pos).heading();
    w.vehicles[ti].yaw = yaw;
    w.vehicles[ti].turret_yaw = yaw;

    let mut shots = 0u32;
    let mut prev = w.vehicles[ti].ammo0;
    for _ in 0..(4 * 60) {
        let mut i = input(0.0, 0.0);
        i.fire0 = true;
        // Aim exactly as the AI does: from the muzzle at the target's centre of mass.
        let d = w.vehicles[ji].pos - w.vehicles[ti].pos;
        let spec = w.vehicles[ti].spec();
        i.has_aim = true;
        i.aim = d.heading();
        i.aim_pitch = ((w.vehicles[ji].center_y() - (w.vehicles[ti].center_y() + spec.weapon0.muzzle_up))
            / d.len().max(6.0))
            .atan();
        w.step(1.0 / 60.0, &[i, Input::default()]);
        if w.vehicles[ti].ammo0 < prev {
            shots += 1;
            prev = w.vehicles[ti].ammo0;
        }
        if w.vehicles[ji].state != vstate::ACTIVE {
            break;
        }
    }
    assert_eq!(
        w.vehicles[ji].state,
        vstate::WRECK,
        "the tank never destroyed a stationary jeep at 42 m"
    );
    assert_eq!(shots, 1, "a jeep must die to a single shell (took {shots})");
}

#[test]
fn tanks_cannot_swim_but_jeeps_can() {
    let mut w = world_with(flat_map(0.6));
    let tank = w.spawn_vehicle(vkind::TANK, 0, 1);
    let jeep = w.spawn_vehicle(vkind::JEEP, 0, 1);
    let ti = w.vehicle_index(tank).unwrap();
    let ji = w.vehicle_index(jeep).unwrap();
    // Start both just south of the shoreline heading north into the sea.
    w.vehicles[ti].pos = v2(60.0, WORLD_SIZE * 0.6 - 14.0);
    w.vehicles[ji].pos = v2(100.0, WORLD_SIZE * 0.6 - 14.0);
    w.vehicles[ti].yaw = 0.0;
    w.vehicles[ji].yaw = 0.0;

    for _ in 0..600 {
        let i = input(1.0, 0.0);
        w.step(1.0 / 60.0, &[i, Input::default()]);
    }
    let tank_in_water = w.in_water(w.vehicles[ti].pos);
    let jeep_pos = w.vehicles[ji].pos;
    assert!(!tank_in_water, "the tank drove into the sea");
    assert!(
        jeep_pos.y > WORLD_SIZE * 0.6,
        "the amphibious jeep failed to cross the waterline (z {})",
        jeep_pos.y
    );
}

#[test]
fn mines_destroy_land_vehicles() {
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(vkind::TANK, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    let pos = w.vehicles[vi].pos;
    // Spawn protection would absorb the blast, so let it lapse first — both the garage guard
    // and the home-zone shield a fresh hull carries while it sits on its own base pad.
    w.vehicles[vi].spawn_guard = 0.0;
    w.vehicles[vi].home_safe = 0.0;
    // Enemy mine right under the tank.
    w.mines.push(rf_core::world::Mine {
        id: 999,
        team: 1,
        pos,
        y: 3.0,
        armed: 2.0,
        blink: 0.0,
    });
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    assert_eq!(w.vehicles[vi].state, vstate::WRECK, "the mine did not kill the tank");
}

#[test]
fn spawn_protection_absorbs_early_damage() {
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    assert!(w.vehicles[vi].spawn_guard > 0.0);
    rf_core::combat::damage_vehicle(&mut w, vi, 500.0, 1, -1);
    assert_eq!(w.vehicles[vi].hp, vehicle::JEEP.hp, "spawn guard let damage through");
    // Once the guard lapses the jeep dies to a single shell, as in the original. The hull is
    // parked inside its own base zone, so the home-zone shield has to be spent too.
    w.vehicles[vi].spawn_guard = 0.0;
    w.vehicles[vi].home_safe = 0.0;
    rf_core::combat::damage_vehicle(&mut w, vi, 500.0, 1, -1);
    assert_eq!(w.vehicles[vi].state, vstate::WRECK);
}

#[test]
fn structure_takes_damage_and_leaves_rubble() {
    let mut map = flat_map(0.9);
    let idx = wall(&mut map, v2(50.0, 50.0), 8.0, 2.0, 120.0);
    let mut w = world_with(map);
    rf_core::combat::damage_structure(&mut w, idx, 1000.0, 0);
    assert!(!w.map.structures[idx].alive(), "wall survived a direct hit");
    let blocked = w.dyn_block.iter().filter(|b| **b).count();
    assert!(blocked > 0, "destroyed wall did not create blocking rubble");
}

#[test]
fn bridge_decks_let_tanks_cross_water() {
    let mut map = flat_map(0.6);
    // A bridge deck spanning the shoreline at x = 60.
    let mut deck = Structure::new(skind::BRIDGE, 2, v2(60.0, WORLD_SIZE * 0.6), 0.15, 0.0, 8.0, 40.0, 1.25);
    deck.flags = (sflag::SOLID | sflag::DESTRUCTIBLE) as f32;
    deck.hp = 300.0;
    deck.hp_max = 300.0;
    map.structures.push(deck);
    let mut w = world_with(map);

    // Mark the deck's nav cells as road, as the map generator does.
    for iz in 0..GRID {
        for ix in 0..GRID {
            let p = v2((ix as f32 + 0.5) * CELL, (iz as f32 + 0.5) * CELL);
            if p.dist(v2(60.0, WORLD_SIZE * 0.6)) < 20.0 && p.x > 52.0 && p.x < 68.0 {
                w.map.nav[(iz * GRID + ix) as usize] = terrain::ROAD;
            }
        }
    }
    assert!(w.ground_height(v2(60.0, WORLD_SIZE * 0.6)) > WATER_LEVEL + 0.5);
    assert!(!w.in_water(v2(60.0, WORLD_SIZE * 0.6)));
    // Off the deck it is still sea.
    assert!(w.in_water(v2(90.0, WORLD_SIZE * 0.6)));
}

#[test]
fn requested_vehicle_spawns_for_the_player_slot() {
    let mut w = world_with(flat_map(0.9));
    // Single player: team 0 has no AI garrison, so the human must be given a ride.
    assert!(
        w.vehicles.iter().all(|v| v.player == 0),
        "team 0 should have no AI vehicles in single player"
    );
    w.request_vehicle(0, vkind::JEEP);
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    let mine = w
        .vehicles
        .iter()
        .find(|v| v.player == 1)
        .expect("the requested jeep was never spawned");
    assert_eq!(mine.kind, vkind::JEEP);
    w.sync_views();
    // The renderer identifies the owner through `build_t`, which carries the player slot.
    let view = w
        .vviews
        .iter()
        .find(|v| v.build_t == 1.0)
        .expect("no view is tagged as belonging to player 1");
    assert_eq!(view.kind, vkind::JEEP as f32);
    assert_eq!(w.player_hud[0].status, 1.0, "HUD should report a live vehicle");
    assert_eq!(w.player_hud[0].vehicle_kind, vkind::JEEP as f32);
}

// ---------------------------------------------------------------------------------------
// Projectile spawn audit: every weapon a vehicle can fire, measured against the muzzle
// anchors of the models the player actually sees.
// ---------------------------------------------------------------------------------------

/// Muzzle anchor from the renderer's models (`web/src/assets/models/vehicles.ts`), in
/// hull-local metres: `(plan distance from the hull centre, height above the hull origin)`.
/// The simulation's `muzzle_fwd` / `muzzle_up` describe the same point (`muzzle_up` is offset
/// by `center_y()`), and the round must start there — not at the hull centre, not inside the
/// model and, since the gun pitches, not somewhere the barrel never reaches.
fn model_muzzle(kind: u8, widx: usize) -> (f32, f32) {
    match (kind, widx) {
        // pintle launcher: turret ring at 1.31 + trunnion 0.46, barrel tip 1.10 forward
        (vkind::JEEP, 0) => (1.10, 1.77),
        (vkind::TANK, 0) => (3.55, 2.00),  // ring 1.38 + trunnion 0.62, barrel tip 2.2
        (vkind::HRSV, 0) => (0.74, 2.53),  // elevating pod, parked at +0.13 rad
        (vkind::HELI, 0) => (4.13, 0.83),  // chin gun: turret (0.86, 3.05) + gun tip
        (vkind::HELI, 1) => (1.36, 0.98),  // right rocket pod (0.9, 0.98, 1.03)
        (vkind::TROOP, 0) => (0.77, 1.23), // rifle muzzle (0.19, 1.23, 0.75)
        (vkind::DRONE, 0) => (1.33, 0.37), // underslung gun pod
        (vkind::SUBMARINE, 0) => (0.49, 2.52), // launcher tube mouth
        _ => (0.0, 0.0),
    }
}

/// One measured shot.
struct Shot {
    vehicle: &'static str,
    weapon: &'static str,
    aim: String,
    spawn_fwd: f32,
    spawn_up: f32,
    model_fwd: f32,
    model_up: f32,
    speed: f32,
    want_speed: f32,
    dir_err: f32,
    vel_dir_y: f32,
    fwd_frac: f32,
    hull_dist: f32,
    lobbed: bool,
    climb: f32,
    /// The round left with a lock to home on. An unguided seeker keeps its launch climb all
    /// the way to the target and sails over it, so the climb only applies when this is true.
    guided: bool,
    spread: f32,
}

/// Fire one weapon once from a known aim on flat ground, at altitude for flyers, and
/// report where the round started and where it went.
fn fire_one(kind: u8, widx: usize, yaw: f32, pitch: f32) -> Shot {
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(kind, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    let spec = *w.vehicles[vi].spec();
    {
        let v = &mut w.vehicles[vi];
        v.pos = v2(80.0, 80.0);
        v.y = 3.0; // flat ground height on this map
        v.alt = if spec.flying { spec.cruise_alt } else { 0.0 };
        v.y += v.alt;
        v.spawn_guard = 0.0;
        v.ammo0 = spec.ammo0_max.max(1.0);
        v.ammo1 = spec.ammo1_max.max(1.0);
        v.reload0 = 0.0;
        v.reload1 = 0.0;
        v.gun_pitch = pitch;
        v.turret_yaw = yaw;
    }
    let weapon = if widx == 1 { spec.weapon1 } else { spec.weapon0 };
    let center = v3(
        w.vehicles[vi].pos.x,
        w.vehicles[vi].center_y(),
        w.vehicles[vi].pos.y,
    );
    let n0 = w.projs.len();
    rf_core::physics::fire(&mut w, vi, widx, yaw, pitch);
    assert_eq!(
        w.projs.len(),
        n0 + 1,
        "{} {}: nothing was fired",
        spec.name,
        weapon.name
    );
    let p = w.projs.last().unwrap().clone();

    let off = p.pos - center;
    let hdir = v3(yaw.sin(), 0.0, yaw.cos());
    let spawn_fwd = off.x * hdir.x + off.z * hdir.z;
    // Height above the hull *origin*, the frame the model anchors are written in.
    let spawn_up = p.pos.y - w.vehicles[vi].y;

    let aim = v3(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    // A heat-seeker climbs off the muzzle: `fire` tilts the launch direction up by
    // `launch_climb`, scaled to the distance of the locked target — but only when there *is*
    // one, because nothing brings an unguided round back down. This world has no enemy, so the
    // seeker launches unguided and leaves flat, exactly what `want` models.
    let guided = weapon.homing && p.target >= 0;
    let want = if weapon.lobbed {
        v3(aim.x * 0.85, 0.78, aim.z * 0.85).norm()
    } else if weapon.launch_climb > 0.0 && guided {
        let c = weapon.launch_climb;
        let horiz = (1.0 - aim.y * aim.y).max(0.0).sqrt();
        v3(aim.x * c.cos(), aim.y * c.cos() + horiz * c.sin(), aim.z * c.cos())
    } else {
        aim
    };
    let vd = p.vel.norm();
    let dot = (vd.x * want.x + vd.y * want.y + vd.z * want.z).clamp(-1.0, 1.0);
    let (m_fwd, m_up) = model_muzzle(kind, widx);
    let speed = p.vel.len();
    let horiz = (p.vel.x * p.vel.x + p.vel.z * p.vel.z).sqrt();

    Shot {
        vehicle: spec.name,
        weapon: weapon.name,
        aim: format!("({yaw:.2},{pitch:+.2})"),
        spawn_fwd,
        spawn_up,
        model_fwd: m_fwd,
        model_up: m_up,
        speed,
        want_speed: weapon.speed,
        dir_err: dot.acos(),
        vel_dir_y: vd.y,
        fwd_frac: horiz / speed.max(1e-3),
        hull_dist: off.len(),
        lobbed: weapon.lobbed,
        climb: weapon.launch_climb,
        guided,
        spread: weapon.spread,
    }
}

/// A guided seeker lofts off the muzzle; an unguided one leaves flat.
///
/// The loft exists so a heat-seeker can arc over a ridge and have its seeker bring it back down
/// onto the hull. With no lock there is nothing to bring it down, so a lofted round sails over
/// its target: 43 MLRS rockets aimed at a missile tower from 140 m all passed over it and the
/// tower ended the round at full health - the reported "it never hits this turret". Both halves
/// are pinned here, because either one alone can be satisfied by the wrong behaviour.
#[test]
fn a_guided_seeker_lofts_and_an_unguided_one_flies_flat() {
    let unguided = fire_one(vkind::HRSV, 0, 0.0, 0.10);
    let aim_y = 0.10f32.sin();
    assert!(
        (unguided.vel_dir_y - aim_y).abs() < 0.02,
        "an unguided seeker must leave along the sight line: vy {:.3}, aim asks {:.3}",
        unguided.vel_dir_y,
        aim_y
    );

    // Now with a lock: the same shot, with a live enemy hull in front of it to lock onto.
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(vkind::HRSV, 0, 1);
    let vi = w.vehicle_index(id).expect("MLRS spawned");
    let origin = w.vehicles[vi].pos;
    let yaw = w.vehicles[vi].yaw;
    let enemy = w.spawn_vehicle(vkind::TANK, 1, 0);
    if let Some(ei) = w.vehicle_index(enemy) {
        w.vehicles[ei].pos = origin + v2(yaw.sin(), yaw.cos()) * 120.0;
        // A fresh spawn is invulnerable for a moment, and an invulnerable hull cannot be locked.
        w.vehicles[ei].spawn_guard = 0.0;
        w.vehicles[ei].home_safe = 0.0;
    }
    w.vehicles[vi].reload0 = 0.0;
    rf_core::physics::fire(&mut w, vi, 0, yaw, 0.10);
    let p = w.projs.last().expect("the seeker launched");
    assert!(p.target >= 0, "the seeker must have locked the tank in front of it");
    let flat = 0.10f32.sin();
    assert!(
        p.vel.norm().y > flat + 0.02,
        "a locked seeker must leave on its launch climb: vy {:.3}, flat would be {:.3}",
        p.vel.norm().y,
        flat
    );
}

#[test]
fn every_weapon_spawns_at_the_muzzle_along_its_aim() {
    // yaw, pitch: the aim a player or the AI would actually use (a strafing helicopter is
    // nose-down; the tank fires nearly flat; grenades are lobbed; an MLRS heat-seeker leaves on
    // the sight line plus its launch climb when it has a lock, and flat when it has none).
    let cases: &[(u8, usize, f32, f32, &str)] = &[
        (vkind::JEEP, 0, 0.0, 0.45, "grenade throw"),
        (vkind::TANK, 0, 0.0, 0.06, "flat main gun"),
        (vkind::TANK, 0, 2.4, -0.04, "main gun, sideways"),
        (vkind::HRSV, 0, 0.0, 0.10, "heat-seeker missile"),
        (vkind::HELI, 0, 0.0, 0.0, "level cannon"),
        (vkind::HELI, 0, 0.0, -0.26, "strafing cannon"),
        (vkind::HELI, 0, 2.4, -0.50, "full depression"),
        (vkind::HELI, 1, 0.0, -0.26, "rocket pod"),
        (vkind::DRONE, 0, 0.0, -0.30, "drone gun"),
        (vkind::TROOP, 0, 0.0, 0.30, "infantry grenade"),
        (vkind::SUBMARINE, 0, 0.0, 0.20, "sub launcher"),
    ];

    println!(
        "\n{:<12} {:<9} {:>13} {:>15} {:>15} {:>8} {:>8} {:>6} {:>6} {:>7}",
        "vehicle", "weapon", "aim(yaw,pitch)", "spawn(fwd,up)", "model(fwd,up)", "speed", "want", "direrr", "fwd%", "vy"
    );
    let mut failures = Vec::new();
    for (kind, widx, yaw, pitch, label) in cases {
        let s = fire_one(*kind, *widx, *yaw, *pitch);
        println!(
            "{:<12} {:<9} {:>13} {:>15} {:>15} {:>8.1} {:>8.1} {:>6.3} {:>6.2} {:>7.3}  {label}",
            s.vehicle,
            s.weapon,
            s.aim,
            format!("{:.2},{:+.2}", s.spawn_fwd, s.spawn_up),
            format!("{:.2},{:+.2}", s.model_fwd, s.model_up),
            s.speed,
            s.want_speed,
            s.dir_err,
            s.fwd_frac,
            s.vel_dir_y,
        );

        // 1. The round starts at the muzzle: in front of the hull centre, outside the hull,
        //    never below the hull's own origin.
        if s.spawn_fwd < 0.3 {
            failures.push(format!("{label}: spawn is not in front of the hull ({:.2} m)", s.spawn_fwd));
        }
        if s.hull_dist < 0.4 {
            failures.push(format!("{label}: spawn is at the hull centre ({:.2} m)", s.hull_dist));
        }
        if s.spawn_up < -0.05 {
            failures.push(format!("{label}: muzzle is below the hull origin ({:+.2} m)", s.spawn_up));
        }
        // 2. ... at the model's own muzzle anchor, within a tolerance.
        if (s.spawn_fwd - s.model_fwd).abs() > 0.7 {
            failures.push(format!(
                "{label}: muzzle is {:.2} m off the model anchor (fwd {:.2} vs {:.2})",
                s.spawn_fwd - s.model_fwd,
                s.spawn_fwd,
                s.model_fwd
            ));
        }
        if (s.spawn_up - s.model_up).abs() > 0.6 {
            failures.push(format!(
                "{label}: muzzle height {:.2} m vs model {:.2} m",
                s.spawn_up, s.model_up
            ));
        }
        // 3. ... and leaves along the aim, at the documented speed.
        let tol = 0.02 + s.spread * 2.5;
        if s.lobbed {
            if s.vel_dir_y < 0.6 {
                failures.push(format!("{label}: lobbed shot is not arcing up (vy {:.2})", s.vel_dir_y));
            }
        } else if s.dir_err > tol {
            failures.push(format!(
                "{label}: velocity is {:.3} rad off the aim (tolerance {:.3})",
                s.dir_err, tol
            ));
        }
        if (s.speed - s.want_speed).abs() > s.want_speed * 0.05 {
            failures.push(format!(
                "{label}: speed {:.1} m/s, expected {:.1}",
                s.speed, s.want_speed
            ));
        }
        // 4. The vertical component is exactly the aim's — plus the seeker's launch climb,
        //    which is a documented departure from the sight line, not a loft borrowed from the
        //    grenade arc (that behaviour is opt-in through `WeaponSpec::lobbed`).
        //
        //    The climb applies only to a *guided* shot: it exists so a heat-seeker can arc over
        //    a ridge and have its seeker bring it back down, and with no lock nothing brings it
        //    down at all - the round sails over whatever it was aimed at. Measured, 43 MLRS
        //    rockets aimed at a missile tower from 140 m all passed over it and the tower
        //    finished the round at full health. These shots carry no lock, so the expectation is
        //    the bare aim.
        if !s.lobbed {
            let want_y = if s.climb > 0.0 && s.guided {
                let c = s.climb;
                let horiz = (1.0 - pitch.sin() * pitch.sin()).max(0.0).sqrt();
                pitch.sin() * c.cos() + horiz * c.sin()
            } else {
                pitch.sin()
            };
            if (s.vel_dir_y - want_y).abs() > 0.05 + s.spread {
                failures.push(format!(
                    "{label}: vertical component is {:.3} but the aim asks for {:.3}",
                    s.vel_dir_y, want_y
                ));
            }
        }
    }
    assert!(failures.is_empty(), "\n  - {}", failures.join("\n  - "));
}

#[test]
fn helicopter_cannon_fires_forward_along_the_boresight() {
    // The gun is a chin turret under the nose: the rounds must leave it along the boresight
    // with a real forward component at every elevation the player can command, and the
    // muzzle must stay on the aircraft instead of sinking to the skids (or through them)
    // as the nose comes down.
    for pitch in [0.0f32, -0.15, -0.26, -0.40, -0.50] {
        let s = fire_one(vkind::HELI, 0, 0.7, pitch);
        println!(
            "heli 20mm  aim pitch {pitch:+.2}  spawn fwd {:.2} m up {:+.2} m  vdir.y {:+.3}  fwd {:.0}%  err {:.4} rad",
            s.spawn_fwd,
            s.spawn_up,
            s.vel_dir_y,
            s.fwd_frac * 100.0,
            s.dir_err
        );
        assert!(
            s.fwd_frac > 0.80,
            "helicopter round is not flying forward at pitch {pitch}: {:.0}% horizontal",
            s.fwd_frac * 100.0
        );
        assert!(
            (s.vel_dir_y - pitch.sin()).abs() < 0.02,
            "helicopter round left at {:.3} vertical instead of the boresight {:.3}",
            s.vel_dir_y,
            pitch.sin()
        );
        assert!(
            s.spawn_up > 0.0,
            "chin gun muzzle sank below the hull at pitch {pitch}: {:+.2} m",
            s.spawn_up
        );
        assert!(
            s.spawn_fwd > 3.0,
            "chin gun muzzle is inside the nose at pitch {pitch}: {:.2} m ahead of the centre",
            s.spawn_fwd
        );
        assert!(
            s.spawn_fwd < 4.6,
            "chin gun muzzle is beyond the barrel tip at pitch {pitch}: {:.2} m",
            s.spawn_fwd
        );
    }
}

/// Measured straight-line top speed of `kind`, flat out for `seconds` on the synthetic flat
/// map. It drives due +x from a clear patch, so no terrain or structure interferes.
fn measure_top_speed(kind: u8, seconds: f32) -> f32 {
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(kind, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = v2(60.0, 60.0);
    w.vehicles[vi].yaw = std::f32::consts::FRAC_PI_2;
    w.vehicles[vi].spawn_guard = 0.0;
    w.vehicles[vi].home_safe = 0.0;
    let mut peak = 0.0f32;
    for _ in 0..(seconds * 60.0) as u32 {
        w.step(1.0 / 60.0, &[input(1.0, 0.0), Input::default()]);
        peak = peak.max(w.vehicles[vi].fwd_speed.abs());
    }
    peak
}

#[test]
fn helicopter_reaches_its_advertised_top_speed() {
    // The old spec claimed 30 m/s but the hull topped out at 9.1: `physics::step_air` bled a
    // `1 + 0.02 * v` factor per second, so the terminal speed solved `v(1 + 0.02v) = accel`
    // and 30 was unreachable. Drag is now `accel * v / speed^2` under power, i.e. the
    // terminal speed IS `spec.speed`, and `accel` only sets how long the spool-up takes.
    // Measured here, not assumed, over a window long enough for the 90 %-in-4.1 s curve.
    let measured = measure_top_speed(vkind::HELI, 12.0);
    println!(
        "helicopter measured top speed: {measured:.2} m/s (spec {:.1})",
        vehicle::HELI.speed
    );
    assert!(
        (measured - vehicle::HELI.speed).abs() < 1.0,
        "helicopter reaches {measured:.2} m/s, spec says {:.1}",
        vehicle::HELI.speed
    );
    // Every air vehicle now reaches its advertised speed, so the same assertion holds for
    // the drone. Its spec was lowered from 22 to 10 in the same change: the drone has only
    // ever flown at ~9.8 (the old drag curve capped it there), and an honestly-22 drone
    // would double the speed of the one airborne threat the player can now shoot at.
    let drone = measure_top_speed(vkind::DRONE, 12.0);
    assert!(
        (drone - vehicle::DRONE.speed).abs() < 1.0,
        "drone reaches {drone:.2} m/s, spec says {:.1}",
        vehicle::DRONE.speed
    );
    assert!(
        (drone - 9.8).abs() < 1.5,
        "drone effective speed moved unexpectedly: {drone:.2} m/s"
    );
}

/// Put an AI helicopter `gap` metres from a parked enemy tank on the flat map, return the
/// world and the two slot ids. The tank is a player slot with no input, so it never moves and
/// never shoots back: the measurement is the helicopter's own behaviour.
fn heli_vs_parked_tank(gap: f32, tank_hp: f32) -> (World, u32, u32) {
    let mut w = world_with(flat_map(0.9));
    let hid = w.spawn_vehicle(vkind::HELI, 1, 0);
    let tid = w.spawn_vehicle(vkind::TANK, 0, 1);
    let hi = w.vehicle_index(hid).unwrap();
    let ti = w.vehicle_index(tid).unwrap();
    {
        let t = &mut w.vehicles[ti];
        t.pos = v2(160.0, 200.0);
        t.yaw = -std::f32::consts::FRAC_PI_2;
        t.spawn_guard = 0.0;
        t.home_safe = 0.0;
        t.hp = tank_hp;
    }
    {
        let h = &mut w.vehicles[hi];
        h.pos = v2(160.0 - gap, 200.0);
        h.yaw = std::f32::consts::FRAC_PI_2; // nose on the tank, +x
        h.alt = vehicle::HELI.cruise_alt;
        h.y = 3.0 + h.alt;
        h.airborne = true;
        h.spawn_guard = 0.0;
        h.home_safe = 0.0;
    }
    (w, hid, tid)
}

#[test]
fn helicopter_engages_a_tank_beyond_its_sight_range() {
    // The chin gun reaches 120 m but `sight` is 92, and the AI took the smaller of the two, so
    // a target in that band was invisible. Measured over 12 seeds at 118 m in
    // `examples/heliduel`: the helicopter never acquired the tank, fired 39 shots across the
    // whole sweep (and those only after flying past it) and was shot down in 9 of the 12
    // duels. In the same sweep the fixed AI fires ~10 shots per duel and wins all 12.
    let (mut w, hid, tid) = heli_vs_parked_tank(118.0, 300.0);
    let mut fired = 0.0f32;
    let mut prev = w.vehicles[w.vehicle_index(hid).unwrap()].ammo0;
    for _ in 0..(20.0 * 60.0) as u32 {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        let Some(hi) = w.vehicle_index(hid) else { break };
        let now = w.vehicles[hi].ammo0;
        fired += (prev - now).max(0.0);
        prev = now;
    }
    let hp = w
        .vehicle_index(tid)
        .map(|ti| w.vehicles[ti].hp)
        .unwrap_or(0.0);
    println!("heli at 118 m (gun reaches 120, sight 92): fired {fired:.0} rounds, tank hp {hp:.0}");
    assert!(
        fired >= 5.0,
        "the helicopter engaged a tank 118 m away — inside its gun's 120 m — with only \
         {fired:.0} rounds"
    );
    assert!(hp < 300.0, "the tank took no damage: hp {hp:.0}");
}

#[test]
fn helicopter_does_not_park_to_shoot() {
    // Reported bug: "the heli does not attack targets in front of it, it sort of stops first".
    // The engage profile held `throttle = 0` at its 34 m stand-off and `strafe_dir` was
    // re-drawn every think, so the lateral command cancelled its own momentum: the aircraft
    // parked inside the tank's easiest range and traded shots from a standstill. Here it is
    // the *standstill* that is asserted, not distance covered — a helicopter that charges
    // past the target and keeps flying also covers ground, and that is not the behaviour the
    // report is about. Measured: 12 of 18 rounds fired while standing before the fix, 5 of
    // 128 after (the 5 are the spool-up from a standing start).
    let (mut w, hid, tid) = heli_vs_parked_tank(30.0, 3000.0);
    let hi0 = w.vehicle_index(hid).unwrap();
    let mut prev_ammo = w.vehicles[hi0].ammo0;
    let mut prev_pos = w.vehicles[hi0].pos;
    let (mut path, mut elapsed) = (0.0f32, 0.0f32);
    let (mut moving_shots, mut still_shots) = (0.0f32, 0.0f32);
    for _ in 0..(14.0 * 60.0) as u32 {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        let Some(hi) = w.vehicle_index(hid) else { break };
        if !w.vehicles[hi].alive() {
            break;
        }
        let v = &w.vehicles[hi];
        path += v.pos.dist(prev_pos);
        prev_pos = v.pos;
        elapsed += 1.0 / 60.0;
        let fired = (prev_ammo - v.ammo0).max(0.0);
        if fired > 0.0 {
            // "Moving" at the moment of the shot, with a margin over the spawn-in spool-up.
            if v.vel.len() > 3.0 {
                moving_shots += fired;
            } else {
                still_shots += fired;
            }
        }
        prev_ammo = v.ammo0;
    }
    let mean_speed = if elapsed > 0.0 { path / elapsed } else { 0.0 };
    println!(
        "heli at 30 m: mean ground speed {mean_speed:.1} m/s over {elapsed:.1} s, \
         rounds fired moving {moving_shots:.0} / standing {still_shots:.0}"
    );
    assert!(
        moving_shots + still_shots > 10.0,
        "the helicopter barely engaged ({:.0} rounds in {elapsed:.1} s)",
        moving_shots + still_shots
    );
    assert!(
        moving_shots > still_shots * 4.0,
        "the helicopter fires from a standstill ({still_shots:.0} of {:.0} rounds, mean \
         ground speed {mean_speed:.1} m/s)",
        moving_shots + still_shots
    );
    let _ = tid;
}

#[test]
fn helicopter_collective_down_does_not_push_the_hull_backwards() {
    // Reported bug: holding Shift (brake) to descend also drifted the hull backwards, because
    // `step_air` applied `-fwd * spec.brake` as a horizontal force - ~10 m/s^2 astern for the
    // helicopter, so a five-second hold moved it tens of metres. Collective-down must only
    // change altitude; reverse flight is negative throttle's job.
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(vkind::HELI, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = v2(60.0, 60.0);
    w.vehicles[vi].yaw = std::f32::consts::FRAC_PI_2;
    w.vehicles[vi].alt = vehicle::HELI.cruise_alt;
    w.vehicles[vi].airborne = true;
    w.vehicles[vi].spawn_guard = 0.0;
    w.vehicles[vi].home_safe = 0.0;
    let start = w.vehicles[vi].pos;
    let inp = Input { brake: true, ..Default::default() };
    for _ in 0..(5.0 * 60.0) as u32 {
        w.step(1.0 / 60.0, &[inp, Input::default()]);
    }
    let v = &w.vehicles[vi];
    println!(
        "heli collective-down: alt {:.1} -> {:.1} m, horizontal drift {:.2} m",
        vehicle::HELI.cruise_alt,
        v.alt,
        (v.pos - start).len()
    );
    assert!(
        v.alt < vehicle::HELI.cruise_alt * 0.6,
        "collective-down did not lower the hull: alt {:.1}",
        v.alt
    );
    assert!(
        (v.pos - start).len() < 0.5,
        "holding collective-down drifted the hull {:.2} m horizontally",
        (v.pos - start).len()
    );
}

#[test]
fn destroyed_ground_vehicle_coasts_on_its_last_heading() {
    // The reported bug: "destroyed vehicles should still move a little in the direction
    // they were going last". Drive a tank flat out, kill it, and require it to keep
    // ploughing straight and then stop — never steering, never sliding forever.
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(vkind::TANK, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = v2(60.0, 60.0);
    w.vehicles[vi].yaw = std::f32::consts::FRAC_PI_2; // due +x
    w.vehicles[vi].spawn_guard = 0.0;
    w.vehicles[vi].home_safe = 0.0;
    for _ in 0..240 {
        w.step(1.0 / 60.0, &[input(1.0, 0.0), Input::default()]);
    }
    let impact = w.vehicles[vi].fwd_speed;
    assert!(impact > 8.0, "the tank never got rolling: {impact} m/s");
    let at_kill = w.vehicles[vi].pos;
    w.kill_vehicle(vi, -1);
    assert_eq!(w.vehicles[vi].state, vstate::WRECK);

    let mut rest = at_kill;
    let mut rest_speed = impact;
    for _ in 0..(60 * 6) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        let Some(vi) = w.vehicle_index(id) else { break };
        assert_eq!(w.vehicles[vi].state, vstate::WRECK, "a wreck was re-activated");
        rest = w.vehicles[vi].pos;
        rest_speed = w.vehicles[vi].vel.len();
    }
    let travelled = at_kill.dist(rest);
    assert!(travelled > 2.5, "the wreck froze where it died (moved {travelled:.2} m)");
    assert!(travelled < 40.0, "the wreck slid impossibly far ({travelled:.2} m)");
    let d = rest - at_kill;
    assert!(d.y.abs() < d.x.abs() * 0.2, "the wreck veered off its last heading: {d:?}");
    assert!(rest_speed < 0.2, "the wreck never came to rest ({rest_speed:.2} m/s)");
}

/// A helicopter that runs its tank dry crashes: the engine stops, the airframe goes down and it
/// burns. Flying hulls used to be exempt from the fuel gate entirely (`out_of_fuel` excluded
/// them), so an empty helicopter flew on at full speed forever - the reported "they don't crash
/// when fuel hits 0".
#[test]
fn a_helicopter_out_of_fuel_falls_and_burns() {
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(vkind::HELI, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = v2(80.0, 80.0);
    w.vehicles[vi].yaw = std::f32::consts::FRAC_PI_2;
    for _ in 0..120 {
        w.step(1.0 / 60.0, &[input(1.0, 0.0), Input::default()]);
    }
    let vi = w.vehicle_index(id).unwrap();
    assert!(w.vehicles[vi].airborne, "the helicopter never got airborne");
    assert!(w.vehicles[vi].fuel > 0.0, "it should still have fuel");
    // Dry it out mid-flight and let the engine quit.
    w.vehicles[vi].fuel = 0.0;
    let mut saw_explosion = false;
    let mut y_min = w.vehicles[vi].y;
    for _ in 0..(60 * 10) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        for e in w.events.iter() {
            if e.kind as u8 == ekind::EXPLOSION || e.kind as u8 == ekind::BIG_EXPLOSION {
                saw_explosion = true;
            }
        }
        match w.vehicle_index(id) {
            Some(vi) => y_min = y_min.min(w.vehicles[vi].y),
            None => break, // culled after the crash
        }
    }
    assert!(
        w.vehicle_index(id).is_none() || !w.vehicles[w.vehicle_index(id).unwrap()].alive(),
        "a helicopter out of fuel must not still be flying"
    );
    assert!(y_min < 8.0, "the aircraft never came down (lowest y {y_min:.2})");
    assert!(saw_explosion, "the crash produced no explosion");
}

/// A helicopter picks the enemy *helicopter* out of a crowd, even when something else is closer:
/// it is the one contact that can kill it before it finishes anything else. Jeeps keep the
/// opposite preference (ground over air), which is why this is a preference and not "nearest".
#[test]
fn a_helicopter_prioritises_an_enemy_helicopter() {
    let mut w = world_with(flat_map(0.9));
    // An *AI* hull (player 0): a player-slot hull is flown by the human's input, so nothing would
    // be choosing a target for it at all.
    let id = w.spawn_vehicle(vkind::HELI, 0, 0);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = v2(80.0, 80.0);
    w.vehicles[vi].y = 16.0;
    w.vehicles[vi].alt = 14.0;
    w.vehicles[vi].spawn_guard = 0.0;
    w.vehicles[vi].home_safe = 0.0;
    // A tank at 40 m, and an enemy helicopter twice as far out.
    let tank = w.spawn_vehicle(vkind::TANK, 1, 0);
    let ti = w.vehicle_index(tank).unwrap();
    w.vehicles[ti].pos = v2(120.0, 80.0);
    w.vehicles[ti].y = w.ground_height(w.vehicles[ti].pos);
    w.vehicles[ti].spawn_guard = 0.0;
    w.vehicles[ti].home_safe = 0.0;
    let foe = w.spawn_vehicle(vkind::HELI, 1, 0);
    let fi = w.vehicle_index(foe).unwrap();
    w.vehicles[fi].pos = v2(80.0, 160.0);
    w.vehicles[fi].y = w.ground_height(w.vehicles[fi].pos) + 14.0;
    w.vehicles[fi].alt = 14.0;
    w.vehicles[fi].spawn_guard = 0.0;
    w.vehicles[fi].home_safe = 0.0;

    // Step long enough for a think, then read who it locked.
    let mut locked = None;
    for _ in 0..(60 * 3) {
        w.step(
            1.0 / 60.0,
            &[rf_core::world::Input::default(), rf_core::world::Input::default()],
        );
        locked = Some(w.vehicles[vi].ai.target);
        if locked == Some(foe as i32) {
            break;
        }
    }
    assert_eq!(
        locked,
        Some(foe as i32),
        "the helicopter locked {} instead of the enemy helicopter {} (tank is {})",
        locked.unwrap_or(-1),
        foe,
        tank
    );
}

/// Two helicopters that fly into each other both come down. A scrape does not: the closing speed
/// has to be real, and they have to be at the same height (the contact test is horizontal, so
/// without the height check a drone at 18 m bounced off one at 3 m).
#[test]
fn two_helicopters_that_collide_both_come_down() {
    // Head-on at 30 m/s each, at the same altitude. Both on *player* slots: an AI hull would
    // fly itself somewhere else and the test would be measuring the driver, not the collision.
    let mut w = world_with(flat_map(0.9));
    let a = w.spawn_vehicle(vkind::HELI, 0, 1);
    let b = w.spawn_vehicle(vkind::HELI, 1, 2);
    let (ia, ib) = (w.vehicle_index(a).unwrap(), w.vehicle_index(b).unwrap());
    // Face each other and give each the velocity that closes the gap: the sim's yaw convention
    // (`fwd = (sin, cos)`) makes hand-written headings easy to get backwards.
    for (i, j) in [(ia, ib), (ib, ia)] {
        w.vehicles[j].pos = v2(80.0, 80.0);
        w.vehicles[i].pos = v2(80.0, 80.0) + (w.vehicles[i].pos - v2(80.0, 80.0)).norm() * 6.0;
        w.vehicles[i].alt = 14.0;
        w.vehicles[i].spawn_guard = 0.0;
        w.vehicles[i].home_safe = 0.0;
        w.vehicles[i].vel = (w.vehicles[j].pos - w.vehicles[i].pos).norm() * 30.0;
        w.vehicles[i].yaw = w.vehicles[i].vel.heading();
    }
    let mut exploded = 0;
    for _ in 0..(60 * 4) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        for e in w.events.iter() {
            if e.kind as u8 == ekind::BIG_EXPLOSION || e.kind as u8 == ekind::EXPLOSION {
                exploded += 1;
            }
        }
    }
    let alive = |id: u32| w.vehicle_index(id).is_some_and(|i| w.vehicles[i].alive());
    assert!(!alive(a) && !alive(b), "a head-on helicopter collision must bring both down");
    assert!(exploded > 0, "the collision produced no explosion");

    // A gentle drift into each other is a shove, not a crash.
    let mut w = world_with(flat_map(0.9));
    let a = w.spawn_vehicle(vkind::HELI, 0, 1);
    let b = w.spawn_vehicle(vkind::HELI, 1, 2);
    let (ia, ib) = (w.vehicle_index(a).unwrap(), w.vehicle_index(b).unwrap());
    for (i, sign) in [(ia, 1.0f32), (ib, -1.0)] {
        w.vehicles[i].pos = v2(80.0, 80.0) + v2(5.0 * sign, 0.0);
        w.vehicles[i].alt = 14.0;
        w.vehicles[i].spawn_guard = 0.0;
        w.vehicles[i].home_safe = 0.0;
        w.vehicles[i].vel = v2(0.8 * sign, 0.0);
    }
    for _ in 0..(60 * 3) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    }
    let alive = |id: u32| w.vehicle_index(id).is_some_and(|i| w.vehicles[i].alive());
    assert!(
        alive(a) && alive(b),
        "hovering into each other is a shove, not a mid-air collision"
    );
}

/// Two flyers only touch at the same height: a drone a dozen metres above a helicopter is not in
/// contact with it. The contact pass is called directly - with no AI and no weapons in the way,
/// "do these two touch" is the only question it can be answering.
#[test]
fn flyers_touch_only_at_the_same_height() {
    let place = |alt_a: f32, alt_b: f32| {
        let mut w = world_with(flat_map(0.9));
        let a = w.spawn_vehicle(vkind::HELI, 0, 1);
        let b = w.spawn_vehicle(vkind::DRONE, 1, 0);
        let (ia, ib) = (w.vehicle_index(a).unwrap(), w.vehicle_index(b).unwrap());
        for (i, alt) in [(ia, alt_a), (ib, alt_b)] {
            let p = v2(80.0 + if i == ia { 0.0 } else { 0.5 }, 80.0);
            w.vehicles[i].pos = p;
            w.vehicles[i].alt = alt;
            // `step` lerps `y` toward `ground + alt` every tick; this test calls the contact pass
            // on its own, so the height has to be placed the way the tick would have it.
            w.vehicles[i].y = w.ground_height(p) + alt;
            w.vehicles[i].vel = rf_core::math::Vec2::ZERO;
            w.vehicles[i].spawn_guard = 0.0;
            w.vehicles[i].home_safe = 0.0;
        }
        let before = (w.vehicles[ia].pos, w.vehicles[ib].pos);
        rf_core::physics::resolve_vehicle_collisions(&mut w, 1.0 / 60.0);
        (w.vehicles[ia].pos.dist(before.0), w.vehicles[ib].pos.dist(before.1))
    };

    let (moved_a, moved_b) = place(3.0, 18.0);
    assert!(
        moved_a < 0.01 && moved_b < 0.01,
        "a helicopter and a drone 15 m apart vertically shoved each other ({moved_a:.2} m, {moved_b:.2} m)"
    );

    // ...and the same pair at the same height is in contact, so the check above is not vacuous.
    let (same_a, same_b) = place(14.0, 14.0);
    assert!(
        same_a > 0.01 || same_b > 0.01,
        "two flyers at the same height and half a metre apart must touch"
    );
}

#[test]
fn downed_helicopter_falls_and_explodes_on_impact() {
    // A knocked-down flyer must lose lift, keep its forward momentum, tumble, and burst on
    // contact — not hang in the air as a frozen wreck.
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(vkind::HELI, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = v2(80.0, 80.0);
    w.vehicles[vi].yaw = std::f32::consts::FRAC_PI_2;
    w.vehicles[vi].spawn_guard = 0.0;
    w.vehicles[vi].home_safe = 0.0;
    for _ in 0..120 {
        w.step(1.0 / 60.0, &[input(1.0, 0.0), Input::default()]);
    }
    let vi = w.vehicle_index(id).unwrap();
    assert!(w.vehicles[vi].airborne, "the helicopter never got airborne");
    let y_kill = w.vehicles[vi].y;
    let x_kill = w.vehicles[vi].pos.x;
    assert!(y_kill > 8.0, "the helicopter was too low to fall: y {y_kill:.2}");
    w.kill_vehicle(vi, -1);

    // Events are cleared at the start of every `step`, so this only sees what happens
    // after death: the crash blast must be among them.
    let mut explosions = 0;
    let mut y_min = y_kill;
    let mut landed = false;
    for _ in 0..(60 * 8) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        for e in w.events.iter() {
            if e.kind as u8 == ekind::EXPLOSION || e.kind as u8 == ekind::BIG_EXPLOSION {
                explosions += 1;
            }
        }
        let Some(vi) = w.vehicle_index(id) else { break };
        y_min = y_min.min(w.vehicles[vi].y);
        if !w.vehicles[vi].airborne {
            landed = true;
            break;
        }
    }
    assert!(
        landed,
        "the downed helicopter never reached the ground (lowest y {y_min:.2}, killed at {y_kill:.2})"
    );
    assert!(
        y_min < y_kill - 5.0,
        "the wreck did not actually fall (lowest y {y_min:.2} from {y_kill:.2})"
    );
    assert!(explosions >= 1, "the crash produced no explosion");
    let vi = w.vehicle_index(id).expect("the crashed wreck was culled early");
    assert!(!w.vehicles[vi].airborne, "the crash landed but still reports airborne");
    assert!(w.vehicles[vi].vel.len() < 0.2, "the crash did not stop the hull");
    assert!(
        w.vehicles[vi].pos.x > x_kill + 1.0,
        "the falling wreck lost its forward momentum (x {:.1} -> {:.1})",
        x_kill,
        w.vehicles[vi].pos.x
    );
    assert!(w.vehicles[vi].wreck_t > 0.0, "the crash consumed the wreck lifetime");
}

#[test]
fn heli_crash_destroys_what_it_lands_on() {
    // A downed Cobra's fireball must kill what it lands on: a direct or very-near hit is
    // always lethal, for hulls and masonry alike. Both crash paths are covered - a falling
    // wreck blasts at impact, a ground kill (low hover) blasts at death. Sandbox mode keeps
    // the AI off the victims so they stay parked where the blast finds them; it is flipped on
    // after spawning because the sandbox range refuses to field hulls for CPU-held teams.
    let scene = || -> (World, usize, u32, u32, u32, u32) {
        let mut map = flat_map(0.9);
        // Wall face 1 m from the crash point; tank 4 m out; jeep at the fireball's edge (12 m).
        let wall_idx = wall(&mut map, v2(103.0, 80.0), 4.0, 20.0, 250.0);
        let mut w = world_with(map);
        // The heli spawns first: a later spawn would be nudged away from the parked tank and
        // move the crash point.
        let heli_id = w.spawn_vehicle(vkind::HELI, 1, 0);
        let hi = w.vehicle_index(heli_id).unwrap();
        w.vehicles[hi].pos = v2(100.0, 80.0);
        w.vehicles[hi].spawn_guard = 0.0;
        w.vehicles[hi].home_safe = 0.0;
        let tank_id = w.spawn_vehicle(vkind::TANK, 1, 0);
        let ti = w.vehicle_index(tank_id).unwrap();
        w.vehicles[ti].pos = v2(104.0, 80.0);
        w.vehicles[ti].spawn_guard = 0.0;
        w.vehicles[ti].home_safe = 0.0;
        let jeep_id = w.spawn_vehicle(vkind::JEEP, 1, 0);
        let ji = w.vehicle_index(jeep_id).unwrap();
        w.vehicles[ji].pos = v2(112.0, 80.0);
        w.vehicles[ji].spawn_guard = 0.0;
        w.vehicles[ji].home_safe = 0.0;
        // A control tank far outside the fireball must come through untouched.
        let far_id = w.spawn_vehicle(vkind::TANK, 1, 0);
        let fi = w.vehicle_index(far_id).unwrap();
        w.vehicles[fi].pos = v2(140.0, 80.0);
        w.vehicles[fi].spawn_guard = 0.0;
        w.vehicles[fi].home_safe = 0.0;
        w.sandbox = true;
        (w, wall_idx, heli_id, tank_id, jeep_id, far_id)
    };

    let assert_blasted = |w: &World,
                          wall_idx: usize,
                          tank_id: u32,
                          jeep_id: u32,
                          far_id: u32| {
        assert!(
            !w.map.structures[wall_idx].alive(),
            "the wall 1 m from the crash point survived (hp {:.0})",
            w.map.structures[wall_idx].hp
        );
        let ti = w.vehicle_index(tank_id).unwrap();
        assert!(
            !w.vehicles[ti].alive(),
            "the tank 4 m from the crash point survived (hp {:.0})",
            w.vehicles[ti].hp
        );
        let ji = w.vehicle_index(jeep_id).unwrap();
        assert!(w.vehicles[ji].alive(), "the jeep at the fireball's edge was overkilled");
        assert!(
            w.vehicles[ji].hp < 50.0,
            "the jeep at the edge took no serious damage (hp {:.0})",
            w.vehicles[ji].hp
        );
        let fi = w.vehicle_index(far_id).unwrap();
        assert_eq!(
            w.vehicles[fi].hp,
            vehicle::TANK.hp,
            "the control tank 40 m away was touched"
        );
    };

    // ---- path 1: a falling wreck blasts at impact -----------------------------------
    let (mut w, wall_idx, heli_id, tank_id, jeep_id, far_id) = scene();
    let hi = w.vehicle_index(heli_id).unwrap();
    let ground = w.ground_height(w.vehicles[hi].pos);
    w.vehicles[hi].y = ground + 25.0;
    w.vehicles[hi].alt = 25.0;
    w.vehicles[hi].airborne = true;
    w.kill_vehicle(hi, -1);
    for _ in 0..(60 * 8) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        let Some(hi) = w.vehicle_index(heli_id) else { break };
        if !w.vehicles[hi].airborne {
            break;
        }
    }
    assert_blasted(&w, wall_idx, tank_id, jeep_id, far_id);

    // ---- path 2: a ground kill (low hover) blasts at death ---------------------------
    let (mut w, wall_idx, heli_id, tank_id, jeep_id, far_id) = scene();
    let hi = w.vehicle_index(heli_id).unwrap();
    w.vehicles[hi].alt = 1.5;
    w.vehicles[hi].y = w.ground_height(w.vehicles[hi].pos) + 1.5;
    w.vehicles[hi].airborne = false;
    w.kill_vehicle(hi, -1);
    assert_blasted(&w, wall_idx, tank_id, jeep_id, far_id);
}

#[test]
fn drone_wrecks_are_not_flagged_to_smoke() {
    // The player: every wreck smokes except the drone. `vflag::BURNING` is the signal the
    // renderer keys its soot column off, so it must survive for a tank wreck and be clear
    // for a drone's. (Both still burn black: the renderer keys that off the WRECK state.)
    let mut w = world_with(flat_map(0.9));
    let drone = w.spawn_vehicle(vkind::DRONE, 0, 1);
    let di = w.vehicle_index(drone).unwrap();
    w.kill_vehicle(di, -1);
    w.sync_views();
    let dv = w.vviews.iter().find(|v| v.id == drone as f32).expect("drone view");
    assert_eq!(dv.state, vstate::WRECK);
    assert_eq!(dv.flags as u32 & vflag::BURNING, 0, "a drone wreck must not smoke");

    let tank = w.spawn_vehicle(vkind::TANK, 0, 1);
    let ti = w.vehicle_index(tank).unwrap();
    w.kill_vehicle(ti, -1);
    w.sync_views();
    let tv = w.vviews.iter().find(|v| v.id == tank as f32).expect("tank view");
    assert_eq!(tv.state, vstate::WRECK);
    assert_ne!(tv.flags as u32 & vflag::BURNING, 0, "a tank wreck should smoke");
}

#[test]
fn a_wreck_blocks_the_road_only_while_it_lies_there() {
    // The reported "the tank will not use the intact bridge, it just mills about near its
    // base". A heavy wreck shuts its nav cell (`kill_vehicle`), but nothing ever handed that
    // cell back: `dyn_block` is only cleared wholesale in `new_round`, so every tank that
    // died on a 3-4 cell wide deck or ford lane sealed a bit more of the only route the AI
    // had. Three or four losses closed it for the rest of the round, and the flow field then
    // told perfectly good drivers there was no way across.
    let mut w = world_with(flat_map(0.9));
    let id = w.spawn_vehicle(vkind::TANK, 0, 0);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = v2(60.0, 60.0);
    w.kill_vehicle(vi, -1);
    let cell = w.cell_index(v2(60.0, 60.0));
    assert!(w.dyn_block[cell], "a heavy wreck must block its cell while it is there");

    // Long enough for the 14 s wreck lifetime to expire and `cull` to drop the hulk.
    for _ in 0..(60 * 20) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    }
    assert!(
        w.vehicle_index(id).is_none(),
        "the wreck outlived its lifetime"
    );
    assert!(
        !w.dyn_block[cell],
        "the cell stayed blocked after the wreck was removed - the route can never reopen"
    );
}

#[test]
fn two_wrecks_on_one_cell_release_it_only_at_the_last() {
    // The unblock has to be a hand-back, not a wipe: a cell shared by two hulks stays shut
    // until both are gone, or the second wreck would leave a hole in the road it is lying on.
    let mut w = world_with(flat_map(0.9));
    let a = w.spawn_vehicle(vkind::TANK, 0, 0);
    let b = w.spawn_vehicle(vkind::TANK, 0, 0);
    let (ai, bi) = (w.vehicle_index(a).unwrap(), w.vehicle_index(b).unwrap());
    w.vehicles[ai].pos = v2(70.0, 70.0);
    w.vehicles[bi].pos = v2(70.4, 70.2);
    let cell = w.cell_index(v2(70.0, 70.0));
    assert_eq!(w.cell_index(v2(70.4, 70.2)), cell, "test needs one shared cell");
    w.kill_vehicle(ai, -1);
    w.kill_vehicle(bi, -1);

    // Expire only the first hulk by hand (the second keeps its own lifetime).
    w.vehicles[ai].wreck_t = 0.0;
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    assert!(w.vehicle_index(a).is_none(), "the first wreck should be gone");
    assert!(
        w.dyn_block[cell],
        "the cell opened while the second wreck was still lying on it"
    );

    // Removal shifts the remaining hulls down, so re-resolve the survivor by id.
    let bi = w.vehicle_index(b).expect("the second wreck should still be here");
    w.vehicles[bi].wreck_t = 0.0;
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    assert!(w.vehicle_index(a).is_none(), "the first wreck should be gone");
    assert!(w.vehicle_index(b).is_none(), "the second wreck should be gone");
    assert!(
        !w.dyn_block[cell],
        "the last wreck to leave did not reopen the cell"
    );
}

// ---------------------------------------------------------------------------
// Terrain conformance
// ---------------------------------------------------------------------------

/// The lowest terrain under a prop's own *visual* contact ring - the ground its mesh, not
/// its nav collision box, actually touches.
fn contact_low(map: &MapData, x: f32, z: f32, r: f32) -> f32 {
    let mut low = map.height_at(x, z);
    for k in 0..8 {
        let a = k as f32 / 8.0 * core::f32::consts::TAU;
        low = low.min(map.height_at(x + a.cos() * r, z + a.sin() * r));
    }
    low
}

fn percentile(sorted: &[f32], p: f32) -> f32 {
    if sorted.is_empty() {
        return f32::NAN;
    }
    sorted[((sorted.len() - 1) as f32 * p).round() as usize]
}

/// A scattered prop is drawn as a true-scale authored mesh (a boulder about 1-1.3 m across, a
/// palm trunk of ~0.3 m) while `scatter` gives it a nav collision box up to 6 m across plus a
/// 0.5 m margin. Seating on the *highest* corner of that box therefore hangs the visible stone
/// the whole footprint relief in the air - the reported floating boulders. This measures the
/// air under the contact ring of every ROCK and PALM on the real maps.
#[test]
fn scattered_props_are_seated_on_the_ground_they_touch() {
    let contact = rf_core::mapgen::prop_contact_radius;
    let mut failures = Vec::new();
    for index in 0..4u32 {
        for seed in [7u32, 1234] {
            let map = rf_core::mapgen::generate(seed, index);
            for kind in [skind::ROCK, skind::PALM] {
                let mut gaps: Vec<f32> = map
                    .structures
                    .iter()
                    .filter(|s| s.kind as u8 == kind)
                    .map(|s| s.y - contact_low(&map, s.x, s.z, contact(kind)))
                    .collect();
                if gaps.is_empty() {
                    continue;
                }
                gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let p50 = percentile(&gaps, 0.5);
                let p90 = percentile(&gaps, 0.9);
                let max = *gaps.last().unwrap();
                println!(
                    "seed {seed} index {index} ({}) kind {kind}: n={} p50={p50:.2} p90={p90:.2} max={max:.2}",
                    map.name,
                    gaps.len()
                );
                if max > 0.25 {
                    failures.push(format!(
                        "seed {seed} index {index} ({}): kind {kind} floats {max:.2} m above its \
                         contact ring (p50 {p50:.2} m over {} props)",
                        map.name,
                        gaps.len()
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Make a world whose heights are the given function, all dry land at GROUND nav class.
fn tilted_world(h: impl Fn(f32, f32) -> f32) -> World {
    let mut map = flat_map(0.9);
    for iz in 0..VERTS {
        for ix in 0..VERTS {
            let x = ix as f32 * CELL;
            let z = iz as f32 * CELL;
            map.heights[(iz * VERTS + ix) as usize] = h(x, z);
        }
    }
    map.nav = vec![terrain::GROUND; (GRID * GRID) as usize];
    world_with(map)
}

fn park(w: &mut World, vi: usize, pos: rf_core::Vec2, yaw: f32) {
    let y = w.ground_height(pos);
    let v = &mut w.vehicles[vi];
    v.pos = pos;
    v.y = y;
    v.yaw = yaw;
    v.turret_yaw = yaw;
    v.vel = rf_core::Vec2::ZERO;
    v.fwd_speed = 0.0;
}

/// The hull's attitude must be the angle of the surface it rests on, taken from its own
/// contact plane. On a plane tilted 0.25 m/m (14.04 deg) the four contact points and
/// `slope_at` agree, so the only error left is the old 0.9 fudge and the tracking lag.
#[test]
fn hull_attitude_matches_the_ground_it_rests_on() {
    /// Slope in metres per metre, across +x.
    const GRADE: f32 = 0.25;
    let ground = |x: f32, _z: f32| 4.0 + GRADE * x;
    let mut w = tilted_world(ground);
    // yaw 0 puts the slope across the hull (roll only); pi/2 puts it along the hull (pitch
    // only), so both axes and both signs are checked.
    let cases = [
        (0.0f32, 60.0f32, 0.0f32, GRADE.atan()),
        (
            core::f32::consts::FRAC_PI_2,
            160.0,
            -GRADE.atan(),
            0.0,
        ),
    ];
    let mut worst = 0.0f32;
    for (yaw, x, want_pitch, want_roll) in cases {
        let id = w.spawn_vehicle(vkind::TANK, 0, 1);
        let vi = w.vehicle_index(id).unwrap();
        park(&mut w, vi, v2(x, 128.0), yaw);
        // Let the follower settle onto the target (the fix's ~0.05 s time constant).
        for _ in 0..240 {
            w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        }
        let (pitch, roll) = (w.vehicles[vi].pitch, w.vehicles[vi].roll);
        let ep = (pitch - want_pitch).abs().to_degrees();
        let er = (roll - want_roll).abs().to_degrees();
        println!(
            "yaw {yaw:.2}: pitch {pitch:.4} rad (want {want_pitch:.4}, err {ep:.2} deg), \
             roll {roll:.4} rad (want {want_roll:.4}, err {er:.2} deg)"
        );
        worst = worst.max(ep).max(er);
    }
    assert!(
        worst < 1.0,
        "hull attitude is {worst:.2} deg off the surface it rests on"
    );
    // Document why the old code cannot pass this: `* 0.9` misses the 14.04 deg roll target by
    // 1.40 deg, more than the tolerance above.
    let old_shortfall = (GRADE.atan() * 0.9 - GRADE.atan()).abs().to_degrees();
    assert!(
        old_shortfall > 1.0,
        "the old 0.9 fudge shortfall ({old_shortfall:.2} deg) does not actually fail this test"
    );
}

/// Tracking lag over a curving traverse: the ridge runs along z, so driving north across it
/// rolls the hull first one way then the other, and the steering sweeps the contact plane
/// under it. Measures the shipped follower against the surface the hull is instantaneously on,
/// and the pre-fix follower (6/s on `slope_at * 0.9`) on the same trajectory.
#[test]
fn hull_attitude_tracks_a_curving_slope() {
    let ground = |x: f32, _z: f32| 6.0 + 0.25 * x + 1.6 * (x * 0.035).sin();
    let mut w = tilted_world(ground);
    let id = w.spawn_vehicle(vkind::TANK, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    let spec = *w.vehicles[vi].spec();
    park(&mut w, vi, v2(60.0, 128.0), 0.0);

    let dt = 1.0 / 60.0;
    let mut old_pitch = 0.0f32;
    let mut old_roll = 0.0f32;
    let (mut new_sum, mut new_max) = (0.0f64, 0.0f32);
    let (mut old_sum, mut old_max) = (0.0f64, 0.0f32);
    let mut n = 0u32;
    for i in 0..900 {
        let steer = (i as f32 * 0.008).sin() * 0.7;
        w.step(dt, &[input(1.0, steer), Input::default()]);
        // Discard the first second: the follower starts from flat and the old one's lag is
        // dominated by that transient rather than by the terrain.
        if i < 60 || w.vehicles[vi].state != vstate::ACTIVE {
            continue;
        }
        let (pos, yaw) = (w.vehicles[vi].pos, w.vehicles[vi].yaw);
        let (tp, tr) = rf_core::physics::hull_attitude(&w.map, pos, yaw, spec.length, spec.width);
        // The pre-fix follower, integrated on the same trajectory: `slope_at`'s centre
        // gradient, the 0.9 fudge, and the 6/s tracking rate.
        let slope = w.map.slope_at(pos.x, pos.y);
        let fwd = v2(yaw.sin(), yaw.cos());
        let ot = (
            -slope.dot(fwd).atan() * 0.9,
            -slope.dot(fwd.perp()).atan() * 0.9,
        );
        let rate = (dt * 6.0).min(1.0);
        old_pitch += (ot.0 - old_pitch) * rate;
        old_roll += (ot.1 - old_roll) * rate;
        let en = ((w.vehicles[vi].pitch - tp).abs().to_degrees())
            .max((w.vehicles[vi].roll - tr).abs().to_degrees());
        let eo = ((old_pitch - tp).abs().to_degrees()).max((old_roll - tr).abs().to_degrees());
        new_sum += en as f64;
        new_max = new_max.max(en);
        old_sum += eo as f64;
        old_max = old_max.max(eo);
        n += 1;
    }
    let new_mean = (new_sum / n as f64) as f32;
    let old_mean = (old_sum / n as f64) as f32;
    println!(
        "attitude error vs instantaneous contact plane over {n} ticks:\n  \
         before (6/s, slope_at*0.9): mean {old_mean:.2} deg, worst {old_max:.2} deg\n  \
         after  (20/s, contact plane): mean {new_mean:.2} deg, worst {new_max:.2} deg"
    );
    assert!(n > 300, "not enough samples on the traverse ({n})");
    assert!(
        new_mean < old_mean * 0.5 && new_max < old_max,
        "the contact-plane follower does not beat the old one (mean {new_mean:.2} vs \
         {old_mean:.2}, worst {new_max:.2} vs {old_max:.2})"
    );
}


