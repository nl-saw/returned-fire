//! Diagnostic: one AI helicopter against one tank, on a synthetic flat map, with the whole
//! engagement printed a line at a time.
//!
//! It exists because the helicopter's behaviour is otherwise only visible as an outcome: a
//! half-second trace showing distance, the hull's speed, the AI's own throttle and strafe
//! commands, the hull and turret bearing errors, the trigger's `aligned`/`elevated` gates and
//! whether the cannon actually fired turns "it stops before it shoots and does not strafe
//! enough" into numbers. Both reported faults were reproduced and then measured with it:
//! at 118 m the original AI never acquired the tank at all (its gun reaches 120 m, `sight` is
//! 92), and at 30 m it held station at 0.5 m/s firing most of its rounds from a standstill.
//!
//! Usage: `cargo run --release --example heliduel -- [gap] [secs] [mode] [heli_speed] [tank_hp] [seed]`
//!
//! * `gap`        starting separation in metres (default 80)
//! * `secs`       simulated seconds (default 30)
//! * `mode`       `ai` = the game's tank AI drives the target; `still` = it parks and shoots
//!                through player 1's input slot; anything else = it reverses while shooting
//! * `heli_speed` the helicopter's initial forward speed (45 = a full-speed attack run)
//! * `tank_hp`    target hit points — 300 is stock, thousands keep it alive long enough to
//!                measure whether the helicopter survives being shot at
//! * `seed`       world seed, so a sweep over seeds measures more than one coin flip
//!
//! The summary line reports the outcome, rounds fired while moving vs standing, mean ground
//! speed and path flown: the numbers the regression tests in `tests/sim_logic.rs` pin.

use rf_core::math::v2;
use rf_core::spec::vehicle;
use rf_core::types::*;
use rf_core::world::{Input, World};

/// Flat island at height 3.0 across the whole theatre; every cell is drivable ground.
fn flat_map() -> MapData {
    let heights = vec![3.0f32; (VERTS * VERTS) as usize];
    MapData {
        name: "flat".into(),
        world_size: WORLD_SIZE,
        grid: GRID,
        cell: CELL,
        heights,
        splat: vec![0, 200, 0, 55].repeat((VERTS * VERTS) as usize),
        road: vec![0u8; (VERTS * VERTS) as usize],
        sand_var: vec![1u8; (VERTS * VERTS) as usize],
        grass_var: vec![1u8; (VERTS * VERTS) as usize],
        pave: vec![0u8; (VERTS * VERTS) as usize],
        nav: vec![terrain::GROUND; (GRID * GRID) as usize],
        structures: Vec::new(),
        spawn: [v2(40.0, 40.0), v2(WORLD_SIZE - 40.0, 40.0)],
        flag_home: [v2(44.0, 44.0), v2(WORLD_SIZE - 44.0, 44.0)],
        base_anchor: [(v2(44.0, 44.0), 0.0), (v2(WORLD_SIZE - 44.0, 44.0), 0.0)],
        water_level: WATER_LEVEL,
    }
}

fn main() {
    let start_gap: f32 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(80.0);
    let secs: f32 = std::env::args()
        .nth(2)
        .and_then(|a| a.parse().ok())
        .unwrap_or(30.0);
    // `still` = the tank parks and shoots; `ai` = the game's own tank AI drives it;
    // anything else = it reverses while shooting.
    let tank_arg = std::env::args().nth(3).unwrap_or_else(|| "reverse".into());
    let tank_ai = tank_arg == "ai";
    let tank_reverses = tank_arg != "still";
    // Initial forward speed of the helicopter: 45 gives a full-speed attack run, 0 a hover.
    let heli_speed: f32 = std::env::args()
        .nth(4)
        .and_then(|a| a.parse().ok())
        .unwrap_or(0.0);
    // Tank hit points: the 20 mm kills a stock 300 hp tank in about a second, which is too
    // fast to measure whether the helicopter survives being shot at. A padded target keeps
    // shooting back for the whole run.
    let tank_hp: f32 = std::env::args()
        .nth(5)
        .and_then(|a| a.parse().ok())
        .unwrap_or(300.0);

    // Seed: one sample is a coin flip when a single shell decides the duel, so the harness
    // takes a seed and callers sweep it.
    let seed: u32 = std::env::args()
        .nth(6)
        .and_then(|a| a.parse().ok())
        .unwrap_or(11);
    let mut w = World::new_with_map(seed, flat_map(), if tank_ai { [-1, -1] } else { [0, -1] });
    let hid = w.spawn_vehicle(vkind::HELI, 1, 0);
    let tid = w.spawn_vehicle(vkind::TANK, 0, if tank_ai { 0 } else { 1 });
    let hi = w.vehicle_index(hid).unwrap();
    let ti = w.vehicle_index(tid).unwrap();
    let cx = WORLD_SIZE * 0.5;
    {
        let h = &mut w.vehicles[hi];
        h.pos = v2(cx - start_gap * 0.5, cx);
        h.alt = vehicle::HELI.cruise_alt;
        h.y = 3.0 + h.alt;
        h.yaw = std::f32::consts::FRAC_PI_2; // +x, at the tank
        h.vel = v2(heli_speed, 0.0); // already up to speed: an attack run, not a spool-up
        h.fwd_speed = heli_speed;
        h.spawn_guard = 0.0;
        h.home_safe = 0.0;
    }
    {
        let t = &mut w.vehicles[ti];
        t.pos = v2(cx + start_gap * 0.5, cx);
        t.y = 3.0;
        t.yaw = -std::f32::consts::FRAC_PI_2; // -x, at the heli
        t.spawn_guard = 0.0;
        t.home_safe = 0.0;
        t.hp = tank_hp;
    }
    for _ in 0..8 {
        rf_core::nav::update_fields(&mut w, 1.0);
    }

    let blank = Input::default();
    let mut prev_h_ammo = w.vehicles[hi].ammo0;
    let mut prev_t_ammo = w.vehicles[ti].ammo0;
    let mut h_shots = 0.0f32;
    let mut t_shots = 0.0f32;
    let mut h_first_fire: Option<f32> = None;
    let mut h_fire_moving = 0.0f32;
    let mut h_fire_still = 0.0f32;
    let mut band_ticks = 0.0f32;
    let mut h_moved_in_band = 0.0f32;
    let mut h_peak_speed_in_band = 0.0f32;
    let mut h_spd_sum = 0.0f32;
    let mut h_inbound = 0.0f32;
    let mut t_hits = 0.0f32;
    let mut h_damage = 0.0f32;
    let mut prev_h_hp = w.vehicles[hi].hp;
    let mut hist: Vec<rf_core::Vec2> = Vec::new();
    let mut aim_err = 0.0f32;
    let mut next_err_t = 0.0f32;
    let mut path_len = 0.0f32;
    let mut prev_pos = w.vehicles[hi].pos;
    // Last known state of each hull: a wreck can be culled before the summary prints, so the
    // end-of-run numbers must be captured while the slots are still valid.
    let mut h_alive = true;
    let mut h_hp_end = w.vehicles[hi].hp;
    let mut t_hp_end = w.vehicles[ti].hp;

    println!(
        "AI HELI vs SCRIPTED {} TANK  gap {start_gap} m  (heli speed {:.0} m/s, cannon range {:.0} m, sight {:.0} m)",
        if tank_ai { "AI" } else if tank_reverses { "REVERSING" } else { "PARKED" },
        vehicle::HELI.speed,
        vehicle::HELI.weapon0.range,
        vehicle::HELI.sight
    );
    println!(
        "  t     d    hspd  alt  tspd   thr  strafe   yawerr  pcherr  hullerr  steer  A E R  hfire tfire  rounds  dmg   hhp  thp"
    );
    let ticks = (secs * 60.0) as u32;
    let mut log_t = -1.0f32;
    // A human's aim wanders: redraw the error a few times a second.
    const REACTION: f32 = 0.35;
    for tick in 0..ticks {
        let t = tick as f32 / 60.0;
        // The sim culls wrecks out of `w.vehicles`, which shifts every index after them:
        // resolve both hulls from their ids each tick instead of caching a slot.
        let (Some(hi), Some(ti)) = (w.vehicle_index(hid), w.vehicle_index(tid)) else {
            println!("--- end at t={t:.2}: a hull left the field (culled)");
            break;
        };
        // Freeze the commander so no reinforcements join the duel.
        w.ai_cmd_t = 1e9;
        hist.push(w.vehicles[hi].vel);
        if t >= next_err_t {
            next_err_t = t + 0.25;
            aim_err = (w.rng.f32() - 0.5) * 0.05;
        }
        // Scripted tank: reverse in a straight line (or park) and keep the gun on the heli.
        // It leads its shots like a competent player: aim at where the heli will be when the
        // shell arrives, and only shoot once the turret is roughly there.
        let tank_in = if tank_ai {
            blank
        } else {
            let tv = &w.vehicles[ti];
            let hv = &w.vehicles[hi];
            let d = tv.pos.dist(hv.pos);
            let tof = d / 145.0; // 120mm muzzle speed
            // A human gunner, not a fire-control computer: react to where the aircraft was
            // `REACTION` seconds ago (the velocity history below) and add a per-shot aim
            // error, so the helicopter's job — being somewhere else — is actually worth
            // something.
            let lag = (REACTION * 60.0) as usize;
            let vel_then = if hist.len() > lag { hist[hist.len() - 1 - lag] } else { hv.vel };
            let aim_pt = hv.pos + vel_then * tof;
            let mut want = (aim_pt - tv.pos).heading();
            want += aim_err;
            let laid = rf_core::math::wrap_angle(want - tv.turret_yaw).abs() < 0.05;
            // Elevate on the sight line like the AI does; without this the gun stays level
            // and a shell with `gravity 6.0` buries itself in the ground short of the target.
            let dy = hv.center_y() - (tv.center_y() + vehicle::TANK.weapon0.muzzle_up);
            Input {
                throttle: if tank_reverses { -1.0 } else { 0.0 },
                steer: 0.0,
                aim: want,
                has_aim: true,
                aim_pitch: (dy / d.max(6.0)).atan(),
                fire0: laid && d < 145.0,
                ..Default::default()
            }
        };
        w.step(1.0 / 60.0, &[tank_in, blank]);
        // A wreck can be culled *inside* the step, so the slots have to be re-resolved after
        // it as well as before.
        let (Some(hi), Some(ti)) = (w.vehicle_index(hid), w.vehicle_index(tid)) else {
            println!("--- end at t={t:.2}: a hull left the field (culled)");
            break;
        };

        let h = &w.vehicles[hi];
        let tv = &w.vehicles[ti];
        let d = h.pos.dist(tv.pos);
        let inp = h.ai_input;
        let want_yaw = (tv.pos - h.pos).heading();
        let yaw_err = rf_core::math::wrap_angle(want_yaw - h.turret_yaw).abs();
        let aim_pitch =
            (tv.center_y() - (h.center_y() + vehicle::HELI.weapon0.muzzle_up)) / d.max(6.0);
        let pitch_err = (aim_pitch - h.gun_pitch).abs();
        let cmd_pitch_err = (inp.aim_pitch - h.gun_pitch).abs();
        let hull_err = rf_core::math::wrap_angle(want_yaw - h.yaw).abs();
        let aligned = yaw_err < 0.12;
        let elevated = pitch_err < 0.05;
        let in_range = d < vehicle::HELI.weapon0.range * 0.95;
        let h_fired = h.ammo0 < prev_h_ammo - 1e-4;
        let t_fired = tv.ammo0 < prev_t_ammo - 1e-4;
        if h_fired {
            h_shots += prev_h_ammo - h.ammo0;
            if h_first_fire.is_none() {
                h_first_fire = Some(t);
            }
            if h.vel.len() > 3.0 {
                h_fire_moving += 1.0;
            } else {
                h_fire_still += 1.0;
            }
        }
        if t_fired {
            t_shots += prev_t_ammo - tv.ammo0;
        }
        prev_h_ammo = h.ammo0;
        prev_t_ammo = tv.ammo0;

        // Rounds in the air aimed at the helicopter, and damage actually taken.
        let inbound = w
            .projs
            .iter()
            .filter(|p| p.team == 0 && v2(p.pos.x, p.pos.z).dist(h.pos) < 60.0)
            .count();
        h_inbound += inbound as f32;
        if h.hp < prev_h_hp - 1e-4 {
            h_damage += prev_h_hp - h.hp;
            t_hits += 1.0;
        }
        prev_h_hp = h.hp;

        if d < 34.0 * 1.35 && d > 34.0 * 0.65 {
            band_ticks += 1.0;
            if h.vel.len() > 3.0 {
                h_moved_in_band += 1.0;
            }
            h_peak_speed_in_band = h_peak_speed_in_band.max(h.vel.len());
        }
        h_spd_sum += h.vel.len();
        path_len += h.pos.dist(prev_pos);
        prev_pos = h.pos;
        h_alive = h.alive();
        h_hp_end = h.hp;
        t_hp_end = tv.hp;

        if t - log_t >= 0.5 {
            log_t = t;
            println!(
                "{:5.1} {:5.0} {:6.1} {:4.1} {:6.1} {:6.2} {:7.2} {:8.2} {:8.2} {:6.2} {:6.2}  {} {} {}  {} {}  {:6} {:4.0}  {:4.0} {:4.0}",
                t,
                d,
                h.vel.len(),
                h.alt,
                tv.vel.len(),
                inp.throttle,
                inp.strafe,
                yaw_err,
                cmd_pitch_err,
                hull_err,
                inp.steer,
                if aligned { "Y" } else { "-" },
                if elevated { "Y" } else { "-" },
                if in_range { "Y" } else { "-" },
                if h_fired { "F" } else { "." },
                if t_fired { "F" } else { "." },
                inbound,
                if h.hp < prev_h_hp + 1e-4 { 0.0 } else { prev_h_hp - h.hp },
                h.hp,
                tv.hp,
            );
        }
        if !h.alive() || !tv.alive() {
            println!(
                "--- end at t={t:.2}: heli alive {} hp {:.0} | tank alive {} hp {:.0}",
                h.alive(),
                h.hp,
                tv.alive(),
                tv.hp
            );
            break;
        }
    }
    let surv = h_alive;
    let hspd = if ticks > 0 {
        h_spd_sum / ticks as f32
    } else {
        0.0
    };
    println!(
        "summary: heli {} hp {:.0} | heli shots {:.0} (first at {:?}) fired-moving {:.0} fired-still {:.0} | tank shots {:.0} tank hp {:.0}",
        if surv { "SURVIVED" } else { "SHOT DOWN" },
        h_hp_end,
        h_shots,
        h_first_fire,
        h_fire_moving,
        h_fire_still,
        t_shots,
        t_hp_end
    );
    println!(
        "         mean heli speed {hspd:.1} m/s | path flown {:.0} m | time in engage band {:.1} s, moving {:.1} s, peak speed there {:.1} m/s | damage taken {:.0} | hits taken {:.0} | mean inbound rounds {:.2}",
        path_len,
        band_ticks / 60.0,
        h_moved_in_band / 60.0,
        h_peak_speed_in_band,
        h_damage,
        t_hits,
        h_inbound / ticks as f32
    );
}
