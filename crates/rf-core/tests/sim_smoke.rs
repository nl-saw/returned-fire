//! Headless simulation smoke tests. These run natively (`cargo test`) so gameplay logic can
//! be validated without a browser: NaN sweeps, long-run stability, and a scripted flag
//! capture that exercises pick-up, carry and scoring.

use rf_core::types::{flagstate, matchstate, vkind, vstate, MapData, MapSize};
use rf_core::world::{Input, World};

fn build(seed: u32, map_index: u32) -> World {
    let mut map: MapData = rf_core::mapgen::generate(seed, map_index);
    rf_core::normalize_map(&mut map);
    World::new_with_map(seed, map, [0, -1])
}

/// Every selectable battlefield size has to *simulate*, not merely generate: the nav grid, the
/// occupancy grid, the flow fields and the physics bounds are all sized from the map now, so a
/// medium or big world quietly using the small map's dimensions would show up here.
#[test]
fn every_map_size_builds_and_steps() {
    for size in [MapSize::Small, MapSize::Medium, MapSize::Big] {
        let mut map: MapData =
            rf_core::mapgen::generate_sized(1337, 0, rf_core::mapgen::MapMode::Classic, size);
        rf_core::normalize_map(&mut map);
        assert_eq!(map.grid, size.grid(), "{}: grid", size.name());
        assert!((map.world_size - size.world()).abs() < 0.001, "{}: world", size.name());
        let mut w = World::new_with_map(1337, map, [0, -1]);
        w.spawn_vehicle(vkind::TANK, 0, 1);
        let world = size.world();
        for tick in 0..600 {
            let t = tick as f32 / 60.0;
            let inputs = [drive_input(1.0, (t * 1.3).sin(), tick % 45 < 3), Input::default()];
            w.step(1.0 / 60.0, &inputs);
            for v in w.vehicles.iter() {
                assert!(
                    v.pos.x.is_finite() && v.pos.y.is_finite(),
                    "{}: vehicle pos NaN at tick {tick}",
                    size.name()
                );
                // Physics clamps to the theatre, so a hull outside it means the bounds are still
                // the small map's.
                assert!(
                    v.pos.x > -40.0 && v.pos.y > -40.0 && v.pos.x < world + 40.0 && v.pos.y < world + 40.0,
                    "{}: hull left the {world:.0} m theatre at {:?}",
                    size.name(),
                    v.pos
                );
            }
            assert!(w.time.is_finite());
        }
        // The flow fields have to have been built for the *real* grid: they size themselves from
        // the map in `build`, so a mismatch here means they were still using the const.
        let cells = (size.grid() * size.grid()) as usize;
        assert_eq!(
            w.fields.to_flag[0].dir.len(),
            cells,
            "{}: flow field sized for the wrong grid",
            size.name()
        );
        assert_eq!(w.fields.to_base[0].dist.len(), cells, "{}: dist sized wrong", size.name());
    }
}

fn drive_input(throttle: f32, steer: f32, fire: bool) -> Input {
    Input {
        throttle,
        steer,
        aim: 0.0,
        aim_pitch: 0.0,
        has_aim: false,
        fire0: fire,
        fire1: false,
        fire1_edge: false,
        brake: false,
        ascend: false,
        strafe: 0.0,
    }
}

#[test]
fn maps_generate_and_validate() {
    for index in 0..4u32 {
        for seed in [1u32, 7, 99] {
            let mut map = rf_core::mapgen::generate(seed, index);
            rf_core::normalize_map(&mut map);
            assert_eq!(map.heights.len(), ((map.grid + 1) * (map.grid + 1)) as usize);
            assert_eq!(map.splat.len(), ((map.grid + 1) * (map.grid + 1) * 4) as usize);
            assert_eq!(map.nav.len(), (map.grid * map.grid) as usize);
            assert!(!map.structures.is_empty(), "map {index} has no structures");
            rf_core::mapgen::validate(&map).unwrap_or_else(|e| panic!("map {index}/{seed}: {e}"));
            for (i, h) in map.heights.iter().enumerate() {
                assert!(h.is_finite(), "height {i} is not finite");
                assert!(*h > -60.0 && *h < 200.0, "height {i} out of range: {h}");
            }
        }
    }
}

#[test]
fn simulation_is_stable_for_a_minute() {
    for index in 0..4u32 {
        let mut w = build(3, index);
        // Give the human a ride, then drive in circles while firing.
        let id = w.spawn_vehicle(vkind::TANK, 0, 1);
        assert!(w.vehicle_index(id).is_some());
        for tick in 0..3600 {
            let t = tick as f32 / 60.0;
            let inputs = [
                drive_input(1.0, (t * 1.3).sin(), tick % 45 < 3),
                Input::default(),
            ];
            w.step(1.0 / 60.0, &inputs);
            for v in w.vehicles.iter() {
                assert!(v.pos.x.is_finite() && v.pos.y.is_finite(), "vehicle pos NaN at tick {tick}");
                assert!(v.yaw.is_finite(), "vehicle yaw NaN at tick {tick}");
                assert!(v.hp.is_finite(), "vehicle hp NaN at tick {tick}");
            }
            for p in w.projs.iter() {
                assert!(p.pos.x.is_finite() && p.pos.y.is_finite() && p.pos.z.is_finite());
            }
            assert!(w.time.is_finite());
        }
        assert!(w.state == matchstate::PLAYING || w.state == matchstate::ROUND_OVER || w.state == matchstate::MATCH_OVER);
        assert_eq!(w.vviews.len(), w.vehicles.len());
    }
}

#[test]
fn jeep_can_capture_the_flag() {
    let mut w = build(11, 0);
    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    let vi = w.vehicle_index(id).expect("jeep spawned");
    assert!(w.vehicles[vi].spec().can_carry_flag);

    // Teleport onto the enemy flag: the pick-up must happen on the next tick.
    let enemy_flag = w.flags[1].pos;
    w.vehicles[vi].pos = enemy_flag;
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    assert_eq!(w.flags[1].state, flagstate::CARRIED, "flag was not picked up");
    assert!(w.vehicles[vi].carrying_flag());

    // Drive it home.
    let home = w.flags[0].home;
    w.vehicles[vi].pos = home;
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    assert!(w.score[0] >= 1.0, "capture did not score (score {:?})", w.score);
    assert_eq!(w.state, matchstate::ROUND_OVER);
}

/// The stress dial: `set_vehicle_cap` raises the ceiling the commander holds a team to, the
/// field never exceeds it, and `0` hands the field strength back to the difficulty rules.
///
/// Measured on a classic map with both teams CPU-held: the rules field 2 hulls a side on easy
/// (the difficulty default here), and a cap of 12 reaches well past that within three minutes —
/// it is a *ceiling*, not a spawn button, because replacements still come out of the garage one
/// `build_time` at a time and the yard rule holds a spawn until the previous hull has left its
/// own base zone.
#[test]
fn a_vehicle_cap_raises_the_field_and_is_never_exceeded() {
    let cpu_hulls = |w: &rf_core::world::World| -> [usize; 2] {
        let mut live = [0usize; 2];
        for v in w.vehicles.iter() {
            if v.alive()
                && v.player == 0
                && matches!(v.kind, vkind::JEEP | vkind::TANK | vkind::HRSV | vkind::HELI)
            {
                live[v.team as usize] += 1;
            }
        }
        live
    };
    let run = |cap: usize, seconds: u32| -> ([usize; 2], [usize; 2]) {
        let mut w = build(11, 0);
        w.set_options(0, false, false);
        w.set_vehicle_cap(cap);
        let blank = Input::default();
        let mut peak = [0usize; 2];
        for _ in 0..(seconds * 60) {
            w.step(1.0 / 60.0, &[blank, blank]);
            let live = cpu_hulls(&w);
            for t in 0..2 {
                peak[t] = peak[t].max(live[t]);
            }
            // The ceiling is a ceiling: it may never be passed, on any tick. With no cap the
            // difficulty rules decide, and hard is the most they ever ask for (3x of 2).
            let ceiling = if cap > 0 { cap } else { 6 };
            for t in 0..2 {
                assert!(
                    live[t] <= ceiling,
                    "team {t} fielded {} hulls under a ceiling of {ceiling} (cap {cap})",
                    live[t]
                );
            }
        }
        (peak, cpu_hulls(&w))
    };

    let (rules_peak, _) = run(0, 180);
    assert!(
        rules_peak.iter().all(|n| *n <= 6),
        "the difficulty rules fielded {rules_peak:?}, which is past the 2/3/6 they ask for"
    );

    let (capped_peak, _) = run(12, 180);
    assert!(
        capped_peak.iter().any(|n| *n >= 8),
        "a cap of 12 never raised the field past the rules: peaks {capped_peak:?}"
    );

    // Clamped, not obeyed blindly: the dial cannot ask for a thousand hulls a side.
    let mut w = build(11, 0);
    w.set_vehicle_cap(10_000);
    assert_eq!(w.vehicle_cap, rf_core::world::MAX_VEHICLE_CAP);
    // ...and `0` goes back to the rules, whatever the difficulty is.
    w.set_vehicle_cap(0);
    assert_eq!(w.vehicle_ceiling(3), 3, "cap 0 must leave the rules in charge");
    w.set_vehicle_cap(24);
    assert_eq!(w.vehicle_ceiling(3), 24, "an explicit cap must win over the rules");
}

/// No team may put two field vehicles on the pad inside `CPU_SPAWN_DELAY` (4 s), whatever the
/// field strength: the commander used to drop a batch per think when a vehicle cap raised its
/// target, which reads as a glitch rather than a battle. Measured by watching ids appear, with
/// both teams CPU-held and a cap of 12 so the commander has every reason to hurry.
#[test]
fn field_vehicles_never_spawn_closer_than_the_spawn_delay() {
    let mut w = build(11, 0);
    // Hard is the shortest commander period there is (1.67 s, well inside the floor), and CPU
    // allies put team 0 - the human team, which otherwise fields only its own hull - under the
    // same commander.
    w.set_options(2, false, true);
    w.set_vehicle_cap(12);
    let blank = Input::default();
    // The opening garrison pair (tank + jeep, the same tick by design) is exempt, so the clock
    // starts from the hulls that are already standing there.
    let mut seen: std::collections::HashSet<u32> = w.vehicles.iter().map(|v| v.id).collect();
    let mut last = [-1.0f32; 2];
    let mut smallest = [f32::MAX; 2];
    let mut spawns = [0usize; 2];
    for tick in 0..(90.0 * 60.0) as u32 {
        w.step(1.0 / 60.0, &[blank, blank]);
        let t = tick as f32 / 60.0;
        // Ids are handed out in spawn order, so a new id in the list is a spawn this tick.
        for v in w.vehicles.iter() {
            if !v.alive() || v.player != 0 {
                continue;
            }
            if !matches!(v.kind, vkind::JEEP | vkind::TANK | vkind::HRSV | vkind::HELI) {
                continue;
            }
            if !seen.insert(v.id) {
                continue;
            }
            let team = (v.team as usize).min(1);
            spawns[team] += 1;
            if last[team] >= 0.0 {
                smallest[team] = smallest[team].min(t - last[team]);
            }
            last[team] = t;
        }
    }
    assert!(spawns[0] > 4 && spawns[1] > 4, "not enough spawns to judge: {spawns:?}");
    for team in 0..2 {
        assert!(
            smallest[team] >= rf_core::world::CPU_SPAWN_DELAY - 1e-3,
            "team {team} fielded two hulls {:.2} s apart, inside the {} s floor",
            smallest[team],
            rf_core::world::CPU_SPAWN_DELAY
        );
    }
}

/// The console round seams: a forced win takes the *real* round-over path (score, capture
/// count, notification, and a match win once the score completes), a forced loss gives the
/// round to the other side, and `force_next_round` skips the round-over seconds entirely.
///
/// These exist so a round can be ended on demand — the flag-run audits, the console, and any
/// check of the round-end flow (`end_round` → 5.5 s → `new_round`) would otherwise have to
/// wait for an AI capture.
#[test]
fn forced_round_results_take_the_real_round_over_path() {
    let mut w = build(11, 0);
    let blank = Input::default();
    assert_eq!(w.state, matchstate::PLAYING);

    // A win for team 0: the score moves, the round ends, and the flags are back on their
    // stands rather than left in someone's hands.
    w.flags[1].state = flagstate::CARRIED;
    w.flags[1].carrier = 1;
    w.force_round_for(0);
    assert_eq!(w.score[0], 1.0, "a forced win did not score");
    assert_eq!(w.captures[0], 1.0, "a forced win did not count as a capture");
    assert_eq!(w.state, matchstate::ROUND_OVER);
    assert_eq!(w.round_winner, 0);
    assert_eq!(w.flags[1].state, flagstate::HOME, "the carried flag was left in hand");
    assert_eq!(w.flags[1].carrier, -1);

    // Repeating it while the round is already over must not stack scores.
    w.force_round_for(0);
    assert_eq!(w.score[0], 1.0, "a second force while ROUND_OVER scored again");

    // The round-over seconds run, then a fresh round starts with the score kept.
    for _ in 0..(6.0 * 60.0) as u32 {
        w.step(1.0 / 60.0, &[blank, blank]);
    }
    assert_eq!(w.state, matchstate::PLAYING, "the next round never started");
    assert_eq!(w.score, [1.0, 0.0], "the score did not survive into the next round");

    // A loss gives the round to the other team.
    w.force_round_for(1);
    assert_eq!(w.score, [1.0, 1.0]);
    assert_eq!(w.round_winner, 1);
    assert_eq!(w.state, matchstate::ROUND_OVER);

    // Enough wins take the match. Stop as soon as it does: `new_round` after a match over
    // clears the scoreboard, so looping past it would land back in an ordinary round.
    let rounds = w.rounds as u32;
    let mut matched = false;
    for _ in 0..(rounds + 2) {
        w.round_over_t = 0.0;
        w.new_round();
        w.force_round_for(0);
        if w.state == matchstate::MATCH_OVER {
            matched = true;
            break;
        }
    }
    assert!(matched, "{rounds} round wins did not take the match");
}

/// The console commands themselves, through the wasm-facing `Game`: a win goes to the human
/// team, a loss to the other side, and attract mode (nobody playing) defaults to team 0.
#[test]
fn forced_win_and_loss_go_to_the_human_team() {
    // Single player: the human is on team 0.
    let mut g = rf_core::Game::new(11, 0, 0, 0, false);
    g.force_round_win();
    assert_eq!(g.score(0), 1.0, "force_round_win did not score for the human team");
    assert_eq!(g.round_winner(), 0);

    let mut g = rf_core::Game::new(11, 0, 0, 0, false);
    g.force_round_lose();
    assert_eq!(g.score(1), 1.0, "force_round_lose did not score for the other team");
    assert_eq!(g.score(0), 0.0);
    assert_eq!(g.round_winner(), 1);

    // Two players: player two is on team 1, so a "win" for the *first* human still means team
    // 0, and attract mode with no human at all falls back to team 0 rather than doing nothing.
    let mut g = rf_core::Game::new(11, 0, 0, 0, true);
    g.force_round_win();
    assert_eq!(g.round_winner(), 0);

    // The next round follows on its own after the round-over seconds.
    for _ in 0..(6.0 * 60.0) as u32 {
        g.update(1.0 / 60.0);
    }
    assert_eq!(g.state(), matchstate::PLAYING as f32, "the next round never started");
    assert_eq!(g.score(0), 1.0, "the scored round was forgotten");

    // `force_next_round` restarts immediately, without scoring anything.
    g.force_next_round();
    assert_eq!(g.state(), matchstate::PLAYING as f32);
    assert_eq!(g.score(0), 1.0);
    assert_eq!(g.round_winner(), -1);
}

/// The capture bar is the base *perimeter*, not a circle around the stand: a runner who gets the
/// enemy flag through its own gate has scored, wherever in the yard it stops — and one still
/// outside the wall has not.
#[test]
fn a_flag_carrier_scores_inside_its_own_walls_but_not_outside_them() {
    let mut w = build(11, 0);
    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    let vi = w.vehicle_index(id).expect("jeep spawned");
    // Take the enemy flag.
    let enemy_flag = w.flags[1].pos;
    w.vehicles[vi].pos = enemy_flag;
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    assert!(w.vehicles[vi].carrying_flag(), "the flag was not picked up");

    let home = w.flags[0].home;
    // Just *outside* the own wall line, on the approach: no score.
    let outside = w.inside_base_walls(0, home);
    assert!(outside, "the stand is inside the walls");
    // Walk a point out along the base-local -z axis until it leaves the perimeter.
    let mut probe = home;
    for step in 0..40 {
        probe = home + rf_core::math::v2(0.0, -(step as f32) * 1.5);
        if !w.inside_base_walls(0, probe) {
            break;
        }
    }
    assert!(!w.inside_base_walls(0, probe), "the probe is outside the walls");
    assert!(w.vehicles[vi].carrying_flag(), "still carrying");
    w.vehicles[vi].pos = probe;
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    assert_eq!(w.score[0], 0.0, "scored from outside the walls at {probe:?}");

    // Now inside the compound, well away from the stand (wherever `probe` is, walk back in).
    let mut inside = probe;
    for _ in 0..40 {
        inside = inside + rf_core::math::v2(0.0, 1.5);
        if w.inside_base_walls(0, inside) {
            break;
        }
    }
    assert!(w.inside_base_walls(0, inside));
    assert!(
        inside.dist(home) > 8.0,
        "the point should be a real distance from the stand, not back on it ({:.1} m)",
        inside.dist(home)
    );
    w.vehicles[vi].pos = inside;
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    assert_eq!(w.score[0], 1.0, "a flag inside the walls with own flag home must score");
    assert_eq!(w.state, matchstate::ROUND_OVER);
}

#[test]
fn destroyed_vehicles_leave_wrecks_and_rebuild() {
    let mut w = build(5, 1);
    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].hp = 1.0;
    // Two shields would absorb this test's hit: the hard spawn guard, and the home-zone
    // protection a hull keeps while it sits on its own pad. This test is about wrecks and the
    // garage, not about durability, so drop both.
    w.vehicles[vi].spawn_guard = 0.0;
    w.vehicles[vi].home_safe = 0.0;
    rf_core::combat::damage_vehicle(&mut w, vi, 500.0, 1, -1);
    assert_eq!(w.vehicles[vi].state, vstate::WRECK);
    let before = w.garage[0].building[0];
    assert!(before > 0.0, "garage did not start rebuilding the jeep");
    // The wreck must disappear once its timer runs out.
    for _ in 0..(60 * 20) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    }
    assert!(w.vehicles.iter().all(|v| v.id != id), "wreck was never cleared");
}

#[test]
fn turret_towers_shoot_at_intruders() {
    let mut w = build(9, 0);
    // Park a hostile tank right next to an enemy turret tower.
    let tower = w
        .map
        .structures
        .iter()
        .find(|s| s.kind as u8 == rf_core::types::skind::TURRET_TOWER)
        .expect("map has a turret tower")
        .clone();
    let enemy_team = 1 - tower.team as u8;
    let id = w.spawn_vehicle(vkind::TANK, enemy_team, 1);
    let vi = w.vehicle_index(id).unwrap();
    w.vehicles[vi].pos = tower.pos() + rf_core::math::v2(14.0, 6.0);
    let hp_before = w.vehicles[vi].hp;
    for _ in 0..(60 * 12) {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
        if w.vehicles[vi].hp < hp_before {
            break;
        }
    }
    assert!(
        w.vehicles[vi].hp < hp_before || w.vehicles[vi].state != vstate::ACTIVE,
        "the turret tower never engaged the intruder"
    );
}

/// A neutral building must not spawn infantry.
///
/// On a procedural map every town block, hamlet building and landmark is owned by **team 2**, the
/// neutral owner a prop is given. Destroying one passed that owner straight to `spawn_vehicle`,
/// which indexed the two-element `map.spawn` with it and panicked — so shooting a town building
/// took the match down with it. The classic map here is a real one, not a synthetic fixture: it is
/// the generator that makes the owners.
#[test]
fn destroying_a_neutral_building_spawns_no_neutral_troops() {
    use rf_core::types::skind;
    let mut map = rf_core::mapgen::generate_sized(
        3,
        0,
        rf_core::mapgen::MapMode::Classic,
        MapSize::Small,
    );
    rf_core::normalize_map(&mut map);
    let si = map
        .structures
        .iter()
        .position(|s| s.team == 2.0 && s.kind as u8 == skind::BUILDING && s.hp > 0.0)
        .expect("a classic map has neutral town buildings");
    let mut w = World::new_with_map(3, map, [0, -1]);
    let before = w.vehicles.len();
    rf_core::combat::damage_structure(&mut w, si, 100_000.0, 1);
    assert!(!w.map.structures[si].alive(), "the building is destroyed");
    assert_eq!(
        w.vehicles.len(),
        before,
        "a neutral building left defenders behind"
    );
    assert!(
        w.vehicles.iter().all(|v| v.team < 2),
        "a hull was spawned for the neutral owner"
    );
    // And the world still steps.
    for _ in 0..60 {
        w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    }
}

/// `clamp` is the backstop every AI steer/throttle passes through; a NaN that fell through it
/// used to latch into yaw and velocity forever (the "vehicles pinned at map centre" bug).
#[test]
fn clamp_never_passes_non_finite_values() {
    assert!(rf_core::math::clamp(f32::NAN, -1.0, 1.0).is_finite());
    assert_eq!(rf_core::math::clamp(f32::INFINITY, -1.0, 1.0), 1.0);
    assert_eq!(rf_core::math::clamp(f32::NEG_INFINITY, -1.0, 1.0), -1.0);
    assert_eq!(rf_core::math::clamp(0.5, -1.0, 1.0), 0.5);
}

/// A vehicle whose kinematics went non-finite must come back as a stopped, visible, drivable
/// hull — not an invisible one pinned at map centre for the rest of the match. That pin was
/// the "vehicles no longer spawn" report: `clamp_to_playable` leashed the NaN position to map
/// centre, but the NaN velocity re-poisoned it every tick and never healed.
#[test]
fn poisoned_vehicle_recovers_instead_of_pinning() {
    let mut w = build(3, 0);
    let id = w.spawn_vehicle(vkind::TANK, 0, 1);
    let vi = w.vehicle_index(id).expect("the spawned tank exists");

    // Poison every kinematic the integration could carry.
    {
        let v = &mut w.vehicles[vi];
        v.pos = rf_core::math::v2(f32::NAN, f32::NAN);
        v.vel = rf_core::math::v2(f32::NAN, f32::NAN);
        v.y = f32::NAN;
        v.fwd_speed = f32::NAN;
        v.yaw = f32::NAN;
    }

    // One tick: the bounds pass must heal it.
    w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
    let v = &w.vehicles[vi];
    assert!(v.pos.x.is_finite() && v.pos.y.is_finite(), "pos did not heal");
    assert!(v.vel.x.is_finite() && v.vel.y.is_finite(), "vel did not heal");
    assert!(v.y.is_finite(), "y did not heal");
    assert!(v.fwd_speed.is_finite(), "fwd_speed did not heal");
    assert!(v.yaw.is_finite(), "yaw did not heal");
    // The debug seam saw the event and flagged it as pre-existing (poisoned on entry).
    let hit = w.nan_debug.expect("the nan_debug seam recorded the event");
    assert_eq!(hit.id, id);
    assert!(hit.pre_poisoned, "the state was poisoned before the tick");

    // And it must be drivable again, not pinned: full throttle for two seconds moves it.
    let healed = w.vehicles[vi].pos;
    for _ in 0..120 {
        w.step(1.0 / 60.0, &[drive_input(1.0, 0.0, false), Input::default()]);
        let v = &w.vehicles[vi];
        assert!(v.pos.x.is_finite() && v.pos.y.is_finite(), "pos re-poisoned while driving");
        assert!(v.vel.x.is_finite() && v.vel.y.is_finite(), "vel re-poisoned while driving");
    }
    let moved = w.vehicles[vi].pos;
    assert!(
        moved.dist(healed) > 1.0,
        "the healed hull is pinned: it did not move under full throttle"
    );
}

/// A non-finite input (a poisoned bearing upstream, a bad key state) must be able to touch
/// nothing: the hull keeps driving on finite kinematics as if the control were centred.
#[test]
fn non_finite_input_cannot_poison_a_vehicle() {
    let mut w = build(3, 0);
    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    let vi = w.vehicle_index(id).expect("the spawned jeep exists");
    let nan_input = Input {
        throttle: f32::NAN,
        steer: f32::NAN,
        aim: f32::NAN,
        aim_pitch: f32::NAN,
        has_aim: true,
        fire0: false,
        fire1: false,
        fire1_edge: false,
        brake: false,
        ascend: false,
        strafe: 0.0,
    };
    for tick in 0..300 {
        w.step(1.0 / 60.0, &[nan_input, Input::default()]);
        let v = &w.vehicles[vi];
        assert!(v.pos.x.is_finite() && v.pos.y.is_finite(), "pos NaN at tick {tick}");
        assert!(v.vel.x.is_finite() && v.vel.y.is_finite(), "vel NaN at tick {tick}");
        assert!(v.yaw.is_finite(), "yaw NaN at tick {tick}");
        assert!(v.fwd_speed.is_finite(), "fwd_speed NaN at tick {tick}");
    }
}
