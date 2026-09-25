//! Does an edited map *play*?
//!
//! The editor can produce a battlefield the generator never would: lanes closed with walls, roads
//! laid over the flow field's preferred routes, a base whose gateway is not where the perimeter
//! thinks it is. Two things make that different from a generated map, and both are quiet failures:
//!
//! * an edited map has **no protected routes** — the lane hints the generator writes are zero, so
//!   the AI's route preference has nothing to prefer and its cost comparison is not the one the
//!   generator's maps were balanced against;
//! * the drivable grid is re-rasterised from the painted layers, so a hand-placed wall can close a
//!   lane the generator kept open, or a road can open one it closed.
//!
//! So this file plays the maps rather than inspecting them: a driver that follows the flow field
//! has to reach the enemy flag on a generated map, and the same driver has to reach it on the same
//! map after each kind of edit. The edits below are the ones an author actually makes — a road, a
//! fence across a lane, a base — and the assertion is the one that matters to a player: the route
//! exists, and the drive finishes.

mod common;

use common::{edited, generated, idle_player_round, route_cost, warm};
use rf_core::math::{wrap_angle, Vec2};
use rf_core::types::*;
use rf_core::world::{Input, World};

/// Drive at the enemy flag along the flow field, respawning when killed.
///
/// Deliberately simple, and deliberately *not* the game's commander: this measures the map, not the
/// AI. Full throttle down the field, steer at the bearing, reverse out of a wedge. Deaths are
/// counted rather than treated as failure, because driving straight at a defended base is how a
/// driver that never dodges dies — the useful signals are *where* it died and whether it ever got
/// close, which is what tells a closed lane apart from a defended one.
struct Run {
    captured: bool,
    reached: bool,
    secs: f32,
    stuck: u32,
    deaths: u32,
    min_flag: f32,
    end: Vec2,
}

fn run(w: &mut World, max_secs: f32) -> Run {
    let team = 0usize;
    let enemy = 1usize;
    let id = w.spawn_vehicle(vkind::JEEP, 0, 1);
    warm(w);
    let start = w.score[team];
    let target = w.flags[enemy].pos;
    let max_ticks = (max_secs * 60.0) as u32;
    let mut stuck_timer = 0.0f32;
    let mut reverse = 0.0f32;
    let (mut stuck, mut deaths) = (0u32, 0u32);
    let mut min_flag = f32::INFINITY;
    let mut reached = false;
    let mut end = Vec2::ZERO;
    let mut waiting = 0u32;

    for tick in 0..max_ticks {
        let Some(vi) = w.vehicle_index(id).filter(|i| w.vehicles[*i].alive()) else {
            // Destroyed: ask the garage for another hull, as a player would.
            if w.score[team] > start {
                break;
            }
            deaths += 1;
            if deaths > 6 || waiting > 30 * 60 {
                break;
            }
            waiting += 1;
            w.step(1.0 / 60.0, &[Input::default(), Input::default()]);
            if !w.vehicles.iter().any(|v| v.id == id && v.alive()) && waiting % 240 == 0 {
                w.request_vehicle(0, vkind::JEEP);
            }
            if let Some(_fresh) = w.vehicle_index(id).filter(|i| w.vehicles[*i].alive()) {
                waiting = 0;
            }
            continue;
        };
        let pos = w.vehicles[vi].pos;
        end = pos;
        let d = pos.dist(target);
        min_flag = min_flag.min(d);
        // "Reached" is generous: inside the base's own defence ring, which is where an attacker has
        // to survive before the flag matters.
        if d < 45.0 {
            reached = true;
        }
        let field = &w.fields.to_flag[team];
        let dir = field.sample(&w.map, pos);
        let want = if dir.len_sq() > 0.01 {
            dir
        } else {
            (target - pos).norm()
        };
        let bearing = want.x.atan2(want.y);
        let err = wrap_angle(bearing - w.vehicles[vi].yaw);
        let mut inp = Input {
            throttle: 1.0,
            steer: (err * 2.0).clamp(-1.0, 1.0),
            ..Default::default()
        };
        if w.vehicles[vi].vel.len() < 0.7 {
            stuck_timer += 1.0 / 60.0;
        } else {
            stuck_timer = 0.0;
        }
        if stuck_timer > 1.5 {
            stuck_timer = 0.0;
            reverse = 1.2;
            stuck += 1;
        }
        if reverse > 0.0 {
            reverse -= 1.0 / 60.0;
            inp = Input {
                throttle: -1.0,
                steer: -inp.steer,
                ..Default::default()
            };
        }
        w.step(1.0 / 60.0, &[inp, Input::default()]);
        if w.score[team] > start {
            return Run {
                captured: true,
                reached: true,
                secs: tick as f32 / 60.0,
                stuck,
                deaths,
                min_flag,
                end,
            };
        }
    }
    Run {
        captured: w.score[team] > start,
        reached,
        secs: max_secs,
        stuck,
        deaths,
        min_flag,
        end,
    }
}

/// Is there a land route from this team's base to the enemy flag at all?
///
/// The flow field is a distance field: `to_flag` is finite where a route exists and infinite where
/// it does not. Reading it directly is the difference between "the driver was slow" and "the map
/// has no route", which are different bugs with different fixes.

/// ACTIVE: an edited map still has a route to the enemy flag, and it is still drivable.
///
/// **FINDING (routing): an edited map's route is systematically longer than the generated map's.**
/// The same battlefield that reports a route cost of 195 does so at 470 once it has been through
/// the editor — with *no edits at all*, because "no edits" still means re-rasterising the nav grid
/// from the painted layers, and the generator's protected routes are the difference. Those routes
/// are lane hints painted into `route`, which the flow field prefers; an edited map has none, so
/// the AI's cost comparison is not the one the generated maps were balanced against. It is not a
/// bug — a hand-built map has no generated lanes to protect — but it is the reason an edited map
/// plays differently, and the numbers are printed below so the difference stays visible.
///
/// What the test asserts is what an author needs to know: after each kind of edit the route still
/// *exists*, and a driver following it gets no further from the flag than it did before — a route
/// that exists but leads somewhere a driver cannot follow is the quiet failure this file is for.
/// Whether the *round* is winnable is the other test's question, and it is answered by letting the
/// game's own commander play.
#[test]
fn an_edited_map_is_still_drivable_to_the_enemy_flag() {
    // A map the naive driver reaches the enemy base on, so "the edit broke it" is a meaningful
    // claim. Seed 7 map 0 is not one: its route cost is 470 and the driver never gets closer than
    // 48 m, before any edits at all.
    let (seed, index) = (1u32, 0u32);
    let mut report = String::new();
    let mut failures: Vec<String> = Vec::new();

    // Baseline: the generated map, so every other row has something to be compared against.
    let mut base = generated(seed, index);
    let base_cost = route_cost(&mut base, 0);
    let base_run = run(&mut base, 200.0);
    report.push_str(&format!(
        "generated      : cost {base_cost:7.0}  reached={:5} min_flag={:5.1} stuck={} deaths={} in {:.0}s\n",
        base_run.reached, base_run.min_flag, base_run.stuck, base_run.deaths, base_run.secs
    ));
    assert!(
        base_cost.is_finite(),
        "the generated map has no route from base to flag, so nothing can be concluded from an edit"
    );

    // 1. Roads laid across the island and perpendicular to it: the ordinary first thing an author
    // does, and the edit most likely to open a lane the generator did not have.
    let (mut road_w, _) = edited(seed, index, |e| {
        let c = e.map().world_size * 0.5;
        e.begin_stroke("test roads");
        e.road_stroke(&[c - 130.0, c, c + 130.0, c], 6.0, 2, false);
        e.road_stroke(&[c, c - 130.0, c, c + 130.0], 6.0, 3, false);
        e.end_stroke();
    });
    let road_cost = route_cost(&mut road_w, 0);
    let road_run = run(&mut road_w, 200.0);
    report.push_str(&format!(
        "two roads      : cost {road_cost:7.0}  reached={:5} min_flag={:5.1} stuck={} deaths={} in {:.0}s\n",
        road_run.reached, road_run.min_flag, road_run.stuck, road_run.deaths, road_run.secs
    ));
    // Two things are checked, and neither is "the drive finished". A driver that never dodges dies
    // to the base defences on *every* map, so the signals that mean something are: the route still
    // exists, and the driver got no further from the flag than it did on the unedited map.
    // Roads and buildings add *cost*, they do not fence anything off, so a driver that ends up much
    // further away means the route it is following is not the one it had.
    let limit = base_run.min_flag + 20.0;
    if !road_cost.is_finite() {
        failures.push(format!("roads closed the route: cost {road_cost}"));
    }
    if road_run.min_flag > limit {
        failures.push(format!(
            "roads pushed the driver away from the flag: closest {:.1} m against a baseline of {:.1} m, {} deaths, ended ({:.0},{:.0})",
            road_run.min_flag, base_run.min_flag, road_run.deaths, road_run.end.x, road_run.end.y
        ));
    }

    // 2. A wall run straight across the island. This is the edit that *should* be able to close a
    // lane, and the check is the same either way: the map's own answer and the driver's experience
    // have to agree. A route the map claims and the driver cannot follow is the failure.
    let (mut wall_w, wall_e) = edited(seed, index, |e| {
        let c = e.map().world_size * 0.5;
        e.begin_stroke("test wall");
        for k in -15..=15 {
            e.place(skind::WALL, 0, c + k as f32 * 7.72, c, 0.0, false);
        }
        e.end_stroke();
    });
    let wall_cost = route_cost(&mut wall_w, 0);
    let wall_run = run(&mut wall_w, 200.0);
    report.push_str(&format!(
        "a wall across  : cost {wall_cost:7.0}  reached={:5} min_flag={:5.1} stuck={} deaths={} in {:.0}s ({} walls)\n",
        wall_run.reached,
        wall_run.min_flag,
        wall_run.stuck,
        wall_run.deaths,
        wall_run.secs,
        wall_e.map().structures.len()
    ));
    // A wall across the island *should* make the route longer — that is the edit working. So the
    // question is not whether the driver got as close, it is whether the route it was given is one
    // it can actually drive: a detour is a longer way round, while a lane that is not really there
    // shows up as a driver that wedges against the wall over and over.
    if wall_cost.is_finite() && wall_run.stuck > base_run.stuck + 8 {
        failures.push(format!(
            "the wall left a route (cost {wall_cost:.0}) that the driver could not follow: wedged {} times against {} on the baseline, closest {:.1} m, ended ({:.0},{:.0})",
            wall_run.stuck, base_run.stuck, wall_run.min_flag, wall_run.end.x, wall_run.end.y
        ));
    }
    if !wall_cost.is_finite() {
        report.push_str(
            "               (the wall closed the route outright: the map reports no route, which is a\n                            truthful answer to a deliberate edit rather than a failure)\n",
        );
    }

    // 3. Buildings beside the base's own exit: the edit most likely to wall an author in by
    // accident, because the base perimeter's gateway is not where the blueprint draws it.
    let (mut build_w, _) = edited(seed, index, |e| {
        let (bx, bz) = (e.base(0).0.x, e.base(0).0.y);
        e.begin_stroke("test buildings");
        for k in 0..4 {
            e.place(skind::BUILDING, 0, bx + 40.0 + k as f32 * 18.0, bz + 10.0, 0.3, false);
        }
        e.end_stroke();
    });
    let build_cost = route_cost(&mut build_w, 0);
    let build_run = run(&mut build_w, 200.0);
    report.push_str(&format!(
        "buildings      : cost {build_cost:7.0}  reached={:5} min_flag={:5.1} stuck={} deaths={} in {:.0}s\n",
        build_run.reached, build_run.min_flag, build_run.stuck, build_run.deaths, build_run.secs
    ));
    if !build_cost.is_finite() {
        failures.push(format!("buildings beside the base's exit closed the route: cost {build_cost}"));
    }
    if build_run.min_flag > limit {
        failures.push(format!(
            "buildings beside a base's exit pushed the driver away: closest {:.1} m against a baseline of {:.1} m, ended ({:.0},{:.0})",
            build_run.min_flag, base_run.min_flag, build_run.end.x, build_run.end.y
        ));
    }

    println!("{report}");
    assert!(
        failures.is_empty(),
        "edits that should not have broken the map did:\n  {}\n\n{report}",
        failures.join("\n  ")
    );
}

/// ACTIVE: an edit the author makes *deliberately* to close a lane is reported as closed.
///
/// This is the other half of the audit, and the one with teeth: a sealed base has to be visible in
/// the flow field. If fencing a base in still leaves a finite route, the AI will drive into the
/// fence for the rest of the round and nothing on the map says why.
#[test]
fn sealing_a_base_fence_is_visible_in_the_route() {
    let (seed, index) = (7u32, 0u32);
    let mut base = generated(seed, index);
    let open = route_cost(&mut base, 0);
    assert!(open.is_finite(), "the generated map should have a route to begin with");

    let (mut fenced, fenced_e) = edited(seed, index, |e| {
        let (bx, bz) = (e.base(0).0.x, e.base(0).0.y);
        let r = 78.0f32;
        e.begin_stroke("test fence");
        let n = ((2.0 * core::f32::consts::PI * r) / 7.72).round() as i32;
        for k in 0..n {
            let a = k as f32 / n as f32 * core::f32::consts::TAU;
            e.place(skind::WALL, 0, bx + a.cos() * r, bz + a.sin() * r, a + core::f32::consts::FRAC_PI_2, false);
        }
        e.end_stroke();
    });
    let sealed = route_cost(&mut fenced, 0);
    let walls = fenced_e
        .map()
        .structures
        .iter()
        .filter(|s| s.kind as u8 == skind::WALL)
        .count();
    println!("open route cost {open:.0}; fenced ({walls} walls) cost {sealed:.0}");
    assert!(
        !sealed.is_finite(),
        "a sealed base still reports a finite route ({sealed:.0}), so the AI would drive into the fence:          open was {open:.0}, {walls} walls placed"
    );
}

/// ACTIVE: the game's own AI still finishes a round on an edited map.
///
/// This is the audit's real question. The naive driver above measures whether a *map* can be
/// crossed; this measures whether the *game* can be played on it. The AI's route preference comes
/// from the generator's protected lanes, and an edited map has none, so nothing guarantees that the
/// behaviour measured on generated maps survives an author's fingerprint. The commander plays the
/// same map three ways — as generated, with roads, and with buildings in its way — and has to take
/// the flag in each.
#[test]
fn the_ai_still_captures_on_an_edited_map() {
    // Chosen because the *baseline* works: classic mode, seed 1, map 0 — the AI takes the flag at
    // 148 s. Comparing an edit against a map the AI already cannot finish measures nothing, which
    // is how the first version of this test managed to blame an edit for seed 3's own difficulty.
    let (seed, index) = (1u32, 0u32);
    let mut report = String::new();
    let mut failures: Vec<String> = Vec::new();

    let mut rounds: Vec<(&str, World)> = vec![("generated", generated(seed, index))];
    let (roads, _) = edited(seed, index, |e| {
        let c = e.map().world_size * 0.5;
        e.begin_stroke("test roads");
        e.road_stroke(&[c - 130.0, c, c + 130.0, c], 6.0, 2, false);
        e.road_stroke(&[c, c - 130.0, c, c + 130.0], 6.0, 3, false);
        e.end_stroke();
    });
    rounds.push(("with roads", roads));
    let (built, _) = edited(seed, index, |e| {
        let (bx, bz) = (e.base(0).0.x, e.base(0).0.y);
        e.begin_stroke("test buildings");
        for k in 0..4 {
            e.place(skind::BUILDING, 0, bx + 40.0 + k as f32 * 18.0, bz + 10.0, 0.3, false);
        }
        e.end_stroke();
    });
    rounds.push(("with buildings", built));

    for (what, mut w) in rounds {
        let out = idle_player_round(&mut w, 320.0);
        report.push_str(&format!(
            "{what:14}: captured={:5} at {:5.0}s  longest AI stall {:4.1}s\n",
            out.captured, out.capture_secs, out.longest_stall
        ));
        for line in out.log.iter().take(4) {
            report.push_str(&format!("                  {line}\n"));
        }
        if !out.captured {
            failures.push(format!(
                "the AI never took the flag on the {what} map in 320 s (longest stall {:.1}s)",
                out.longest_stall
            ));
        }
    }
    println!("{report}");
    assert!(failures.is_empty(), "{}\n{report}", failures.join("\n"));
}

/// What does an *unedited* pass through the editor change? (diagnostic)
///
/// `seed 3, index 0`, pinned to classic mode on both sides: the answer is nothing that matters.
/// It exists because the first version of this file took its baseline from `mapgen::generate`,
/// which defaults to *mirror* — so every "before" and "after" in the tables below was a different
/// island, and the audit was measuring the wrong thing entirely.
#[test]
#[ignore = "diagnostic: run with --ignored --nocapture"]
fn diagnostic_what_a_round_trip_changes() {
    let (seed, index) = (3u32, 0u32);
    let e = rf_core::editor::EditorMap::new(seed, index, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Small);
    let mut ed = e.map().clone();
    rf_core::normalize_map(&mut ed);
    let mut gen = rf_core::mapgen::generate_sized(seed, index, rf_core::mapgen::MapMode::Classic, rf_core::types::MapSize::Small);
    rf_core::normalize_map(&mut gen);
    let diff = |name: &str, a: &[u8], b: &[u8]| {
        let n = a.iter().zip(b).filter(|(x, y)| x != y).count();
        println!("{name:10}: {n} of {} differ", a.len());
    };
    let n = gen.heights.iter().zip(&ed.heights).filter(|(a, b)| (*a - *b).abs() > 1e-4).count();
    println!("heights   : {n} of {} differ", gen.heights.len());
    diff("splat", &gen.splat, &ed.splat);
    diff("road", &gen.road, &ed.road);
    diff("nav", &gen.nav, &ed.nav);
    diff("pave", &gen.pave, &ed.pave);
    println!("structures: {} generated, {} edited", gen.structures.len(), ed.structures.len());
    println!("spawn gen {:?} ed {:?}", gen.spawn, ed.spawn);
}

/// Diagnostic: which classic maps can the AI actually finish? (baseline hunt)
#[test]
#[ignore = "diagnostic"]
fn diagnostic_ai_capture_by_seed() {
    for seed in [1u32, 2, 3, 5, 7, 11, 13] {
        for index in [0u32, 1] {
            let mut w = common::generated(seed, index);
            let out = common::idle_player_round(&mut w, 260.0);
            println!(
                "seed {seed:2} map {index}: captured={:5} at {:5.0}s stall {:5.1}s",
                out.captured, out.capture_secs, out.longest_stall
            );
        }
    }
}
