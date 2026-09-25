//! Opposing force: vehicle AI (drivers + gunners), missile turret towers, anti-camping
//! drones, infantry, the out-of-bounds submarine, and the enemy team's "commander" that
//! keeps the fight supplied from the garage.

use crate::combat;
use crate::math::*;
use crate::nav;
use crate::physics;
use crate::spec::{vehicle, wkind};
use crate::types::*;
use crate::world::{aigoal, AiState, Input, Vehicle, World};

/// How far ahead the AI leads a moving target when aiming.
const LEAD: f32 = 0.55;

pub fn update(w: &mut World, dt: f32) {
    ai_commander(w, dt);
    for vi in 0..w.vehicles.len() {
        if !w.vehicles[vi].alive() {
            continue;
        }
        // A CPU-driven slot (attract/demo mode) is a driver, not a human: it goes through the
        // same think loop as any other CPU hull, and its stillness never counts toward the
        // idle-camping drone.
        let is_player = w.vehicles[vi].player > 0 && !w.vehicle_cpu_driven(vi);
        let kind = w.vehicles[vi].kind;
        if is_player {
            // Player vehicles only need bookkeeping (idle detection for drones).
            let speed = w.vehicles[vi].vel.len();
            if speed < 0.9 {
                w.vehicles[vi].idle_t += dt;
            } else {
                w.vehicles[vi].idle_t = 0.0;
            }
            continue;
        }
        match kind {
            vkind::TROOP => think_troop(w, vi, dt),
            vkind::SUBMARINE => think_sub(w, vi, dt),
            _ => think_vehicle(w, vi, dt),
        }
    }
    update_towers(w, dt);
    update_drones(w, dt);
}

/// Nearest enemy hull worth aiming at. With `prefer_ground`, ground units win over air even
/// when the airframe is closer: a jeep returning fire on a tank while a heli circles overhead
/// should not switch its aim to the helicopter — it still shoots the heli when it is the only
/// contact, but it never chases or prioritises air. (Jeeps use this; every other hull keeps
/// Which contact to prefer when several are inside the acquisition radius. Distance alone is not
/// always the right answer: a jeep returning fire should shoot the tank that is actually
/// threatening it rather than the helicopter crossing overhead, and a helicopter's first problem
/// is always the other helicopter.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Prefer {
    /// Closest of anything.
    Any,
    /// A ground hull over a flyer, even when the flyer is closer.
    Ground,
    /// An enemy helicopter over anything else, even when something else is closer — both within
    /// the acquisition window; a heli on the far side of the map is not a target.
    Air,
}

fn nearest_enemy_vehicle(w: &World, team: u8, p: Vec2, max_d: f32, prefer: Prefer) -> Option<usize> {
    let mut best: Option<usize> = None;
    let mut bd = max_d;
    let mut ground_best: Option<usize> = None;
    let mut heli_best: Option<usize> = None;
    for (i, v) in w.vehicles.iter().enumerate() {
        if !v.alive() || v.team == team || v.kind == vkind::SUBMARINE {
            continue;
        }
        // Not worth aiming at: either the hard spawn shield is up, or the target is sitting
        // in its own home zone with protection left. Treating it as invisible (rather than
        // shooting and having the damage refused) is what keeps a freshly spawned player from
        // being camped the instant the shield drops.
        if w.protected_from_attack(i) {
            continue;
        }
        let d = v.pos.dist(p);
        if d >= max_d {
            continue;
        }
        if d < bd {
            bd = d;
            best = Some(i);
        }
        if !v.spec().flying && ground_best.is_none_or(|gi| v.pos.dist(p) < w.vehicles[gi].pos.dist(p)) {
            ground_best = Some(i);
        }
        // Air-to-air: the nearest *helicopter* **within the acquisition window**. Drones are
        // flyers too, but they are the anti-camping punishment rather than a dogfight, and a
        // helicopter that stops duelling to swat one loses the duel it was in. The window
        // matters: unbounded, this channel made every heli "acquire" an enemy heli on the far
        // side of the map (measured 609 m apart on seed 11) and hold HUNT on it — the gun is
        // locked to a target past its range so nothing in the bubble gets shot, and the hull
        // flies its hunt field straight at the enemy base instead.
        if v.kind == vkind::HELI && heli_best.is_none_or(|hi| v.pos.dist(p) < w.vehicles[hi].pos.dist(p))
        {
            heli_best = Some(i);
        }
    }
    match prefer {
        Prefer::Ground => ground_best.or(best),
        Prefer::Air => heli_best.or(best),
        Prefer::Any => best,
    }
}

fn nearest_enemy_tower(w: &World, team: u8, p: Vec2, max_d: f32) -> Option<usize> {
    let mut best: Option<usize> = None;
    let mut bd = max_d;
    for (i, s) in w.map.structures.iter().enumerate() {
        if !s.alive() || s.kind as u8 != skind::TURRET_TOWER || s.team as u8 == team {
            continue;
        }
        let d = s.pos().dist(p);
        if d < bd {
            bd = d;
            best = Some(i);
        }
    }
    best
}

/// Where a hull should go to rearm: the nearest supply structure of its own team that actually
/// carries what it is short of.
///
/// The distinction matters more than it looks. A base's garage is a supply point - it carries
/// ammunition and repairs - and it is usually the nearest one, so a target picked on distance
/// alone sends a thirsty tank to a building with no fuel in it. Measured: an AI helicopter
/// hovered over its own garage from 26 % to empty, waiting at a pump that never had petrol. When
/// nothing carries what is needed, any supply point still beats driving around looking.
fn supply_target(w: &World, team: u8, pos: Vec2, need_fuel: bool, need_ammo: bool) -> Option<Vec2> {
    let mut best_needed: Option<(f32, Vec2)> = None;
    let mut best_any: Option<(f32, Vec2)> = None;
    for k in 0..w.supply.len() {
        let s = w.map.structures[w.supply[k] as usize];
        if !s.alive() || s.team as u8 != team {
            continue;
        }
        let d = s.dist_to(pos);
        if best_any.map_or(true, |b| d < b.0) {
            best_any = Some((d, s.pos()));
        }
        // Repair does not count as "carries what it needs": every garage repairs, garages are
        // usually the nearest building in a base, and a thirsty hull that accepts one parks at a
        // pump with no petrol in it (measured: an AI helicopter hovered over its own garage from
        // 26 % to empty while a full fuel point sat 13 m away).
        let carries = (need_fuel && s.flag(sflag::FUEL)) || (need_ammo && s.flag(sflag::AMMO));
        if carries && best_needed.map_or(true, |b| d < b.0) {
            best_needed = Some((d, s.pos()));
        }
    }
    best_needed.or(best_any).map(|b| b.1)
}

/// What a hull is short of, when it should break off to rearm: `(fuel, ammo)`. `None` when it
/// is fine, or when it is a flag carrier - that is one drive from scoring, and turning back is
/// how a capture is thrown away.
///
/// The two lines differ on purpose. A hull breaks off at a third of a tank (or an empty gun) and
/// then stays until it is topped up: with a single line, a helicopter took on the four per cent
/// that put it over the mark and turned straight back round, arriving in the field on a third of
/// a tank. `ai.goal` carries the commitment - this runs before the new goal is written, so it
/// reads last tick's decision.
fn supply_need(w: &World, vi: usize) -> Option<(bool, bool)> {
    let v = &w.vehicles[vi];
    let spec = v.spec();
    if v.carrying_flag() || spec.fuel_time >= 900.0 {
        return None;
    }
    let committed = v.ai.goal == aigoal::SUPPORT;
    let need_fuel = v.fuel < spec.fuel_max * if committed { 0.95 } else { 0.3 };
    // A runner's gun is for getting itself out of trouble, not for fighting, so it only ever
    // goes home for fuel. Everyone else rearms when the gun is dry, and fills it once there.
    let armed = v.kind != vkind::JEEP;
    let dry = |ammo: f32, max: f32| if committed { ammo < max * 0.95 } else { ammo < 1.0 };
    let need_ammo = armed
        && ((spec.weapon0.damage > 0.0 && spec.ammo0_max > 0.0 && dry(v.ammo0, spec.ammo0_max))
            || (spec.weapon1.damage > 0.0 && spec.ammo1_max > 0.0 && dry(v.ammo1, spec.ammo1_max)));
    if need_fuel || need_ammo {
        Some((need_fuel, need_ammo))
    } else {
        None
    }
}

/// How close to the enemy flag a tank or helicopter has to be before it starts opening the
/// base up instead of looking for something to shoot.
const BREACH_RANGE: f32 = 90.0;

/// Distance from `p` to the segment `a`..`b`.
fn seg_dist(p: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let l2 = ab.len_sq();
    if l2 < 1e-6 {
        return p.dist(a);
    }
    let t = ((p - a).dot(ab) / l2).clamp(0.0, 1.0);
    p.dist(a + ab * t)
}

/// The enemy wall worth shooting to open a way in: the one standing closest to the straight
/// line from `from` to `to` (the flag), within `max_d` of the shooter.
///
/// Nearest-wall would pick whichever corner happens to be closest, which is how a hull ends up
/// shelling a wall it is not trying to get past. Distance to the line to the flag is what makes
/// a wall "in the way", and since the perimeter walls carry `BLOCKS_LOS` that is also literally
/// true: the runner behind them cannot be shot at, and cannot be covered, until they come down.
fn breach_target(w: &World, team: u8, from: Vec2, to: Vec2, max_d: f32) -> Option<usize> {
    let mut best: Option<usize> = None;
    let mut bd = f32::MAX;
    for (i, s) in w.map.structures.iter().enumerate() {
        if !s.alive() || s.team as u8 == team || s.kind as u8 != skind::WALL {
            continue;
        }
        let sp = s.pos();
        let d = sp.dist(from);
        if d > max_d {
            continue;
        }
        // In the way first, reachable second: the 5 % distance term only breaks ties between
        // walls that are equally in the way.
        let score = seg_dist(sp, from, to) + d * 0.05;
        if score < bd {
            bd = score;
            best = Some(i);
        }
    }
    best
}

/// Centre of the nearest enemy home zone that still has protection left on the clock, if the
/// shooter is close enough for it to matter. Returns `None` once every enemy hull has burned
/// its protection, which is the signal for the AI to press the base again as it always did.
fn nearest_protected_enemy_home(w: &World, team: u8, p: Vec2) -> Option<Vec2> {
    let mut best: Option<Vec2> = None;
    let mut bd = f32::INFINITY;
    for v in w.vehicles.iter() {
        if !v.alive() || v.team == team || v.home_safe <= 0.0 || v.kind == vkind::SUBMARINE {
            continue;
        }
        let c = w.home_center(v.team);
        let d = c.dist(p);
        // Only zones the shooter is anywhere near matter: a driver on the far side of the map
        // is going to cross that ground anyway, and making it detour around a bubble it will
        // never touch would wreck its route. Three standoff rings is close enough to care.
        if d < w.tuning.rules.home_standoff * 3.0 && d < bd {
            bd = d;
            best = Some(c);
        }
    }
    best
}

/// Coarse line-of-sight test against terrain and tall solid structures.
/// `ignore_struct` lets a turret tower look past its own body (otherwise it blocks its own
/// shot whenever the target sits below the muzzle).
pub fn has_los(w: &World, a: Vec3, b: Vec3, ignore_struct: i32) -> bool {
    let steps = 16;
    let mut buf = Vec::with_capacity(16);
    for i in 1..steps {
        let t = i as f32 / steps as f32;
        let p = a + (b - a) * t;
        let g = w.map.height_at(p.x, p.z);
        if g > p.y + 1.2 {
            return false;
        }
        w.grid.query(v2(p.x, p.z), 0.6, &mut buf);
        for si in buf.iter() {
            if *si as i32 == ignore_struct {
                continue;
            }
            let s = &w.map.structures[*si as usize];
            if !s.alive() || (!s.flag(sflag::BLOCKS_LOS) && s.h < 3.0) {
                continue;
            }
            if s.kind as u8 == skind::PALM || s.kind as u8 == skind::WRECK {
                continue;
            }
            if s.dist_to(v2(p.x, p.z)) < 0.6 && p.y < s.y + s.h {
                return false;
            }
        }
    }
    true
}

fn think_vehicle(w: &mut World, vi: usize, dt: f32) {
    let team = w.vehicles[vi].team;
    let kind = w.vehicles[vi].kind;
    let spec = *w.vehicles[vi].spec();
    let pos = w.vehicles[vi].pos;
    let mut inp = Input::default();

    // ---- perception (cheap, every tick) --------------------------------------
    // A jeep returns fire on whatever is in sight but aims ground units first; the other
    // hulls keep plain nearest-of-anything.
    //
    // A helicopter looks as far as its chin gun reaches, not just as far as it can see: the
    // 20 mm is good to 120 m while `sight` is 92, and the gap was not academic — a tank dead
    // ahead at 115 m was ignored for a whole 14 s pass (measured in `examples/heliduel`), the
    // heli flying past it taking fire without ever pulling the trigger. Rockets reach 170 m
    // but are left out of the acquisition radius: 120 m is the range the gun can actually
    // kill at, and it keeps the stand-off from doubling in one step.
    // A hull acquires as far as its main weapon reaches, not just as far as it can see. The
    // helicopter was the first case (20 mm good to 120 m against a 92 m sight, so a tank in the
    // outer envelope was never a target); the MLRS is the second and worse: its launcher throws
    // homing rockets 190 m against an 80 m sight, so it drove past fights it could have ended,
    // and in the AI-vs-AI match measurement it threw a third of its rounds from a standstill
    // because the only targets it ever saw were the ones already on top of it.
    let engage_sight = if matches!(kind, vkind::HELI | vkind::HRSV) {
        spec.sight.max(spec.weapon0.range)
    } else {
        spec.sight
    };
    // A helicopter looks for the other helicopter first: it is the one contact that can kill it
    // before it finishes anything else. A jeep prefers ground; everyone else takes the nearest.
    let prefer = match kind {
        vkind::JEEP => Prefer::Ground,
        vkind::HELI => Prefer::Air,
        _ => Prefer::Any,
    };
    let target = nearest_enemy_vehicle(w, team, pos, engage_sight, prefer);
    let tinfo = target.map(|ti| {
        let v = &w.vehicles[ti];
        (ti, v.pos, v.center_y(), v.vel, v.spec().radius, v.id)
    });

    // ---- decide (staggered) --------------------------------------------------
    w.vehicles[vi].ai.think_t -= dt;
    w.vehicles[vi].ai.strafe_t -= dt;
    if w.vehicles[vi].ai.think_t <= 0.0 {
        let interval = 0.18 + (1.0 - w.vehicles[vi].ai.skill) * 0.3;
        w.vehicles[vi].ai.think_t = interval;
        let goal = decide_goal(w, vi, tinfo.map(|t| t.0));
        w.vehicles[vi].ai.goal = goal;
        w.vehicles[vi].ai.target = tinfo.map(|t| t.5 as i32).unwrap_or(-1);
        w.vehicles[vi].ai.field = match goal {
            aigoal::TO_FLAG => 0,
            aigoal::HOME_WITH_FLAG => 1,
            aigoal::HUNT | aigoal::ATTACK_STRUCT => 2,
            // Holding: the field is unused (the loiter drives toward home), but `to_base`
            // keeps the stored index sensible for anything that reads it.
            // Resupply is a run home, so it reads the base field.
            aigoal::SUPPORT | aigoal::HOLD => 1,
            _ => 0,
        };
        // The lateral command holds its sign for a whole run. Re-drawing it every think left
        // the hull oscillating about its own position instead of translating: at 30 m the
        // helicopter averaged 0.5 m/s and slid a couple of metres over a two-second
        // engagement — a stationary target for the tank shooting back at it.
        //
        // Drones are exempt. `strafe_dir` is not a translation axis for them but the
        // direction they circle in, and their shot has to leave the nose (no turret), so a
        // steadier circle lets the nose sweep further past the target before the trigger
        // opens — the drone audit that requires every shot to be laid on the camper catches
        // it. They keep the old per-think flip.
        //
        // The draw happens for every hull either way, and the run length comes from the
        // vehicle's own `jitter` rather than a fresh `rng.f32()`. Both matter: the sim shares
        // one RNG stream, so an extra draw here reshuffles every randomized decision
        // downstream — the drone audit went from zero off-target shots to ten when this
        // block drew twice.
        let flip = w.rng.chance(0.25);
        if kind != vkind::DRONE && w.vehicles[vi].ai.strafe_t <= 0.0 {
            // 1.9-2.9 s of held direction: long enough for the lateral run to build speed.
            w.vehicles[vi].ai.strafe_t = 1.9 + w.vehicles[vi].ai.jitter * 0.159;
            if flip {
                w.vehicles[vi].ai.strafe_dir = -w.vehicles[vi].ai.strafe_dir;
            }
        } else if kind == vkind::DRONE && flip {
            w.vehicles[vi].ai.strafe_dir = -w.vehicles[vi].ai.strafe_dir;
        }
    }


    let goal = w.vehicles[vi].ai.goal;
    // Amphibious flag runners take the sea route when it is meaningfully shorter: it dodges
    // the bridge chokepoints and the towers that cover them.
    let mut use_swim = false;
    if spec.amphibious && !w.vehicles[vi].carrying_flag() && goal != aigoal::HOME_WITH_FLAG {
        let land = w.fields.to_flag[team as usize].cost(&w.map, pos);
        let swim = w.fields.to_flag_swim[team as usize].cost(&w.map, pos);
        use_swim = swim.is_finite() && (!land.is_finite() || swim < land * 0.9);
    }
    let field_ref = if use_swim {
        &w.fields.to_flag_swim[team as usize]
    } else {
        match w.vehicles[vi].ai.field {
            1 => &w.fields.to_base[team as usize],
            // A hunting jeep whose "enemy hull" is a flying unit does not chase it: the
            // to_enemy field points straight at that heli, so drive the flag route instead —
            // same goal, a route that never leads into an airframe.
            2 if kind == vkind::JEEP
                && to_enemy_hull(w, team).is_some_and(|i| w.vehicles[i].spec().flying) =>
            {
                &w.fields.to_flag[team as usize]
            }
            2 => &w.fields.to_enemy[team as usize],
            _ => &w.fields.to_flag[team as usize],
        }
    };
    let mut dir = field_ref.sample(&w.map, pos);
    // Slight per-hull lane offset. The field carries one 8-way heading per 2 m cell, so every
    // hull standing in the same cell is told to drive the identical line: a whole column of
    // attackers traces the same path, round after round. Sampling the field a little to one
    // side of the hull picks a different cell, hence a different heading, and the hull tracks
    // a parallel lane instead. See `lane_offset` for the amplitude and why it costs no RNG.
    if dir.len_sq() > 0.01 {
        let lane = lane_offset(&spec, w.vehicles[vi].id, w.vehicles[vi].ai.jitter, w.time);
        if lane.abs() > 0.05 {
            let alt = field_ref.sample(&w.map, pos + dir.perp() * lane);
            if alt.len_sq() > 0.01 {
                dir = alt;
            }
        }
    }

    // Attack-run behaviour: gunners stop and shoot when they have a shot.
    let mut engage = false;
    // Hulls that fight *while driving*: the jeep (never parks - a jeep that stops to strafe is a
    // jeep that never delivers the flag) and the MLRS (its launcher is on a 180-degree turret,
    // its missiles home, and `must_stop` is false for the pod - see the engagement branch).
    let driver = kind == vkind::JEEP || kind == vkind::HRSV;
    let engage_range = spec.weapon0.range;
    if let Some((ti, tp, ty, tv, _, _)) = tinfo {
        let d = tp.dist(pos);
        let eye = v3(pos.x, w.vehicles[vi].center_y(), pos.y);
        let tgt = v3(tp.x, ty, tp.y);
        let los = has_los(w, eye, tgt, -1);
        if los && d < engage_sight {
            w.vehicles[vi].ai.last_seen = w.time;
            // Aim with lead, plus a per-vehicle error so the AI misses sometimes.
            let tof = d / spec.weapon0.speed.max(1.0);
            let lead = tv * (tof * LEAD);
            let aim_at = tp + lead;
            let want_yaw = (aim_at - pos).heading();
            let err = (1.0 - w.vehicles[vi].ai.skill) * 0.14;
            let jitter = (w.time * 1.7 + w.vehicles[vi].ai.jitter).sin() * err;
            inp.aim = wrap_angle(want_yaw + jitter);
            inp.has_aim = true;
            // Aim from the muzzle, not the hull centre: the barrel sits `muzzle_up` above
            // it, and ignoring that makes flat shots sail over small targets.
            let dy = ty - (w.vehicles[vi].center_y() + spec.weapon0.muzzle_up);
            inp.aim_pitch = (dy / d.max(6.0)).atan();
            // Fire when roughly on target and in range. Alignment has to include the gun's
            // *elevation*, not just the turret bearing: `gun_pitch` lags `aim_pitch` by about
            // a third of a second, and without this check a helicopter (whose aim point is
            // well below its own altitude) empties its first rocket ripple while the pod is
            // still level, so the rounds sail over the target and burst long.
            let aligned = wrap_angle(want_yaw - w.vehicles[vi].turret_yaw).abs() < 0.12;
            // The elevation tolerance is a *stationary* hull's: a launcher driving over broken
            // ground has its pod thrown around by the terrain it is crossing, and the pod's
            // pitch lags the aim by more than five hundredths of a radian most of the time. The
            // MLRS fires on the move now (its 180-degree pod and homing missiles need no
            // stillness), so it gets a tolerance that reflects that: measured in a 250 m lane,
            // the pod never matched the 0.05 gate while driving and the hull launched nothing.
            let elev_tol = if kind == vkind::HRSV { 0.16 } else { 0.05 };
            let elevated = (inp.aim_pitch - w.vehicles[vi].gun_pitch).abs() < elev_tol;
            let in_range = d < engage_range * 0.95 && d > spec.weapon0.min_range;
            if aligned && elevated && in_range && los && w.rng.chance(0.85) {
                inp.fire0 = true;
                if spec.weapon1.damage > 0.0 && d > 30.0 && w.vehicles[vi].ammo1 > 0.0 {
                    inp.fire1_edge = w.rng.chance(0.4);
                }
            }
            // Keep distance for stand-off shooters, close in for brawlers. Jeeps are the one
            // exception: they never park to fight. The aim and fire above still run (return
            // fire on anything in sight, helis included), but `engage` stays false so the hull
            // keeps driving its objective — a jeep that stops to strafe a contact is a jeep
            // that never delivers the flag.
            if !driver {
                if kind == vkind::HELI {
                    // A helicopter fights on the move, and it is the one hull whose gun does
                    // not care which way the nose points: `turret_arc` is a full circle, so
                    // it can hold the target with the chin gun and the rocket pods while it
                    // translates sideways.
                    //
                    // It used to hold `throttle = 0` at a 34 m stand-off, which parks the
                    // aircraft. Measured against a tank at 30 m (examples/heliduel) the hull
                    // averaged 0.5 m/s of ground speed and stood still for the 1.6 s the
                    // turret needed to come round: "it sort of stops first". The cause was
                    // not the throttle but `strafe_dir`, which was re-drawn every think and
                    // so cancelled its own momentum; the run now commits (see `strafe_t`).
                    //
                    // The stand-off itself stays at 34 m. A longer one looks safer on paper
                    // (more time of flight to dodge in) but measured worse in the duel: the
                    // 20 mm kills a tank in about 1.5 s of fire, so every extra second spent
                    // trading shots is another 120 mm the helicopter has to survive, and at
                    // 60 m the stand-off version won in 2.32 s having taken a hit where the
                    // close-in version won in 1.37 s untouched. Closing is the armour.
                    let prefer = 34.0;
                    engage = true;
                    // Full lateral authority, one committed direction: a crossing target.
                    inp.strafe = w.vehicles[vi].ai.strafe_dir;
                    inp.throttle = if d < prefer * 0.65 {
                        // Too close to trade shots: extend. 12 m/s astern is slower than the
                        // tank's 15.5 m/s forward, so sliding out beats reversing into it.
                        -0.7
                    } else if d > prefer * 1.35 {
                        1.0
                    } else {
                        // Hold the stand-off while keeping the collective in: a *zero*
                        // throttle drops `step_air` into its idle drag, which caps the
                        // lateral run at ~9 m/s. Any real collective switches the drag to the
                        // forward-speed term instead, and since the nose is on the target
                        // (not along the direction of travel) that term is small — the
                        // aircraft then crosses at 18-20 m/s with the gun still laid.
                        0.3
                    };
                } else if kind == vkind::HRSV {
                    // The MLRS fights *on the move*, and it fights nose-on. Its pod is on a
                    // 180-degree turret, so a target abeam is already at the edge of the arc
                    // and one astern is unreachable: driving its own route, the launcher simply
                    // never bears and the hull sails past fights it could have joined. So it
                    // steers at the target and keeps the throttle in — the parked version
                    // covered 50 m in a 240 s match, stood still a quarter of the time and threw
                    // 2 of its 6 rounds on the move; nose-on it covers 178 m and fires 15 of 17
                    // while moving. Nothing to reverse for: `min_range` is zero, and the hull is
                    // slow enough (9.2 m/s) that closing is not a risk in itself.
                    engage = true;
                    inp.steer = clamp(wrap_angle(want_yaw - w.vehicles[vi].yaw) * 2.2, -1.0, 1.0);
                    inp.throttle = 1.0;
                } else {
                    let prefer = 26.0;
                    if d < prefer * 0.65 {
                        engage = true;
                        inp.throttle = -1.0;
                        inp.strafe = w.vehicles[vi].ai.strafe_dir * 0.7;
                    } else if d > prefer * 1.35 {
                        inp.throttle = 1.0;
                    } else {
                        engage = true;
                        inp.throttle = 0.0;
                        inp.strafe = w.vehicles[vi].ai.strafe_dir * 0.85;
                    }
                }
                if kind == vkind::HRSV && d < spec.weapon0.min_range + 6.0 {
                    inp.throttle = -0.8;
                    inp.fire0 = false;
                }
            }
            let _ = ti;
        }
    }
    // Attack the enemy's missile towers when nothing better is in sight. Flag runners are
    // excluded: a jeep that stops to plink at a tower stands there forever instead of
    // running the flag, which is exactly what it did before this guard.
    if !engage && tinfo.is_none() && kind != vkind::JEEP {
        if let Some(si) = nearest_enemy_tower(w, team, pos, 120.0) {
            let sp = w.map.structures[si].pos();
            let eye = v3(pos.x, w.vehicles[vi].center_y(), pos.y);
            let tgt = v3(sp.x, w.map.structures[si].y + 2.0, sp.y);
            if has_los(w, eye, tgt, -1) {
                let d = sp.dist(pos);
                let want_yaw = (sp - pos).heading();
                inp.aim = want_yaw;
                inp.has_aim = true;
                inp.aim_pitch = ((w.map.structures[si].y + 2.0)
                    - (w.vehicles[vi].center_y() + spec.weapon0.muzzle_up))
                    / d.max(8.0);
                let in_range = d < spec.weapon0.range * 0.9;
                if wrap_angle(want_yaw - w.vehicles[vi].turret_yaw).abs() < 0.14 && in_range {
                    inp.fire0 = true;
                }
                // Only stop to shoot if the tower is genuinely in range; otherwise keep
                // driving towards the objective instead of parking out of reach. The MLRS does
                // not stop even then: it carries the reach (190 m against this branch's 120 m
                // acquisition) and the turret arc to shell a tower on the move, and parking it
                // meant the towers it was sent to kill simply survived the round.
                if in_range && d < 62.0 {
                    if kind != vkind::HRSV {
                        inp.throttle = 0.0;
                    }
                    inp.has_aim = true;
                } else {
                    inp.has_aim = true;
                    let dir = w.fields.to_flag[team as usize].sample(&w.map, pos);
                    if dir.len_sq() > 0.01 {
                        let err = wrap_angle(dir.heading() - w.vehicles[vi].yaw);
                        inp.steer = clamp(err * 2.2, -1.0, 1.0);
                        inp.throttle = clamp(0.4 + (1.0 - err.abs() / core::f32::consts::PI) * 0.6, 0.0, 1.0);
                    }
                }
            }
        }
    }

    if !engage {
        // Drive along the flow field towards the objective.
        if goal == aigoal::HOLD {
            // Every crossing on our corridor is down: hold near the spawn pad rather than
            // following the (unreachable) field or the straight-line objective fallback into
            // the water. A fresh `decide_goal` drops this the moment a field reaches us.
            dir = hold_dir(w, vi, pos);
        } else if dir.len_sq() < 0.01 {
            // No field here (or unreachable): head straight at the objective — except when a
            // live field exists nearby. A hull standing in water is mid-crossing; steer from
            // the nearest dry cell's direction, which points back along the route that got it
            // here: on Twin Atolls seed 3 a tank sat on the cove at (265,276) for 240 s, its
            // heading snapping between the field's around-the-lake direction on dry cells and
            // the straight-line target across the water on every shallow cell it touched. The
            // same recovery applies to a grounded hull in an unreachable land pocket (map 0
            // seed 3: a flag carrier milled for 200 s in a wall notch where `to_base` was
            // zero); without it the straight-line fallback plus `avoid_ahead` oscillates in
            // place forever. Applies to every grounded hull — the jeep is amphibious, so an
            // "only for land hulls" gate would disable it for exactly the hull that needs it.
            if !spec.flying {
                // First choice: drive to the cell where the route starts. The route's own
                // heading there is the second choice, and the straight line the last — see
                // `route_reentry` for why the order matters on a shoreline cell.
                dir = route_reentry(w, vi, field_ref, pos)
                    .unwrap_or_else(|| nearby_field_dir(&w.map, field_ref, pos));
            }
            if dir.len_sq() < 0.01 {
                dir = objective_dir(w, vi);
            }
        }
        // Resupply's last leg. The base flow field leads to the flag stand, which is not where
        // the fuel is: a hull following it home ends up circling the plaza a few metres from its
        // depot, and a tank that does that dies of thirst beside the pump (measured: stalled at
        // 8 m from the pad, burning fuel, with the pad's own 6 m supply radius never reached).
        // Inside the base the hull is through the gate already, so it can drive straight at it.
        // The approach: aim at the gate while outside, at the depot once through it.
        //
        // The base field knows the way home, but a hull that has arrived at the wall stands in
        // the wall's own shoulder - a cell the field has no direction for - and the straight-line
        // fallback then drove it into the masonry. Measured: pinned 8-12 m from its own depot for
        // a full minute with the depot through the wall, and (on the first cut, which took the
        // depot as the target from outside) burned a whole tank circling the perimeter. The gate
        // is a known point (`World::gate_pos`), so a hull near its own base just drives at it.
        if goal == aigoal::SUPPORT {
            let (need_fuel, need_ammo) = supply_need(w, vi).unwrap_or((true, true));
            if spec.flying {
                if let Some(p) = supply_target(w, team, pos, need_fuel, need_ammo) {
                    dir = (p - pos).norm();
                }
            } else if w.inside_own_base(team as u8, pos) {
                if let Some(p) = supply_target(w, team, pos, need_fuel, need_ammo) {
                    if pos.dist(p) < 45.0 {
                        dir = (p - pos).norm();
                    }
                }
            }
        }

        // Exit corridor: inside its own base, leave through the gateway. While still well
        // behind the wall line the hull steers at a point on the opening's centreline, so
        // from any spawn jitter its path threads the middle of the channel — aiming at one
        // fixed point past the gate used to send wide spawns out at an angle into the jamb
        // (measured: 15 of 24 fresh spawns clipped a jamb, 16 crossed more than 1.5 m
        // off-centre). Within 2 m of the wall it switches to the point 12 m past the gate:
        // aiming at the frame itself pulls a half-through hull back into the base (measured:
        // map 0 seed 7 sat spinning in the gateway for 60 s). Two fresh spawns never start in
        // contact (spawn separation in world.rs); if one is queued within ~12 m behind a
        // friendly on the lane it creeps until the gap opens, so they leave single file
        // without wedging — holding off the lane used to park a hull for seconds behind a
        // leader that was already clearing (measured: map 1 seed 1 died 74 m out instead of
        // reaching the flag), and peeling wide swung it off-centre inside the opening itself.
        // A flag runner coming home is excluded: its objective is the stand inside the walls,
        // not the opening it just came through.
        let mut exit_queued = false;
        if goal != aigoal::HOLD
            && goal != aigoal::HOME_WITH_FLAG
            && goal != aigoal::SUPPORT
            && !spec.flying
            && w.inside_own_base(team, pos)
        {
            if let Some((target, queued)) = exit_lane_target(w, vi, team) {
                dir = (target - pos).norm();
                exit_queued = queued;
            }
        }
        // The field knows the route, not what stands on it two seconds from now: a short ray
        // test against the nav grid turns a hull away from a building while there is still
        // room to do it, instead of letting it arrive at the wall first and correct after.
        if !spec.flying {
            let speed = w.vehicles[vi].vel.len();
            let look = clamp(7.0 + speed * 1.5, 9.0, 30.0);
            // Inside its own base the exit corridor is authoritative: it is what keeps a spawn
            // centred in the gateway, and swerving around a teammate there is what puts a hull
            // into a jamb (measured: a jeep crossing 1.93 m off centre against a 1.8 m bar).
            let watch_mates = !w.inside_own_base(team, pos);
            if let Some(d) = avoid_ahead(w, vi, pos, dir, look, watch_mates) {
                dir = d;
            }
        }
        let want = dir.heading();
        let err = wrap_angle(want - w.vehicles[vi].yaw);
        inp.steer = clamp(err * 2.2, -1.0, 1.0);
        let align = 1.0 - (err.abs() / core::f32::consts::PI).min(1.0);
        inp.throttle = clamp(0.35 + align * 0.75, 0.0, 1.0);
        if err.abs() > 1.5 && w.vehicles[vi].fwd_speed > spec.speed * 0.6 {
            inp.throttle = -0.4;
        }
        // Queued behind a friendly on the exit lane: creep until the gap opens, so the pair
        // leaves single file instead of converging into contact (measured: map 2 seed 3 —
        // two spawns with no spacing rule deadlocked in the gateway).
        if exit_queued {
            inp.throttle = inp.throttle.min(0.35);
        }
        // ...and the same rule everywhere else, without the lane: a friendly ground hull close
        // ahead in the direction of travel is the one thing a driver must not drive through.
        // The exit lane only covered the yard, so on the map a hull would happily close on a
        // teammate that had stopped to shoot and shunt it (measured: 30-38 friendly contacts
        // per five-minute AI-vs-AI round, 46-54 s spent in contact).
        if let Some(hold) = friendly_ahead(w, vi, dir) {
            inp.throttle = inp.throttle.min(hold);
        }
        // Three-point turn. A wheeled vehicle hardly steers when stationary (the physics
        // scales steering authority with speed), so a driver that is pointing the wrong way
        // would otherwise sit there until it has crawled into whatever is in front of it.
        let wrong_way = err.abs() > 1.9 && !spec.flying;
        if wrong_way && w.vehicles[vi].fwd_speed < 2.5 {
            inp.throttle = -0.75;
            // Steering reverses with the gear, so back up with the wheel turned the other way.
            inp.steer = clamp(-err.signum(), -1.0, 1.0);
        }
        if !inp.has_aim {
            inp.aim = w.vehicles[vi].yaw;
        }
    } else {
        let want = inp.aim;
        let err = wrap_angle(want - w.vehicles[vi].yaw);
        inp.steer = clamp(err * 1.6, -1.0, 1.0);
    }

    // ---- MLRS mine-laying ------------------------------------------------------
    // The AI's MLRS turns its advance into a minefield: every few seconds while it drives on
    // the enemy it drops one at its own feet, and when an enemy closes in and it backs off it
    // hedges the retreat line the same way. Same-team vehicles never trip mines (`combat::
    // update_mines` skips them), so a trail is safe for your own reinforcements — only the
    // side that chases or counterattacks pays, and a land vehicle that does dies outright.
    if kind == vkind::HRSV && w.vehicles[vi].mines >= 1.0 && w.vehicles[vi].ai.mine_cd <= 0.0 {
        let retreating = engage && inp.throttle < -0.5;
        let advancing = !engage && inp.throttle > 0.2 && goal != aigoal::HOLD;
        if retreating || advancing {
            inp.fire1_edge = true;
            w.vehicles[vi].ai.mine_cd = if retreating { 8.0 } else { 6.0 };
        }
    }

    // ---- stuck detection and escape ------------------------------------------
    {
        // Recovery budget. A hull that cannot make ground reverses with the wheel turned for
        // a short, fixed burst, then tries the field again from a new heading. It must be
        // *bounded*: the old 1.8 s reverse (with the steer flipping sign half way) could walk
        // a tank back into the wall it was peeling off, and with no cool-down the next
        // detection fired immediately - measured on map 2 "Iron Strait", where the team-1
        // tank sat against the x=389 perimeter with `throttle -0.95` for 240 s, never
        // leaving a 16 x 9 m box, while the narrower jeep squeezed out and drove off.
        const ESCAPE_TIME: f32 = 0.8;
        /// Seconds of recovery before another one may arm. Held as a negative `stuck_t`, so
        /// no extra AI state is needed.
        const ESCAPE_COOLDOWN: f32 = 0.6;
        /// A hull commanded to drive that cannot get this far from where it was when the
        /// window opened is wedged.
        const PROGRESS_R: f32 = 0.6;
        let v = &mut w.vehicles[vi];
        v.ai.escape_t = (v.ai.escape_t - dt).max(0.0);
        v.ai.evade_cd = (v.ai.evade_cd - dt).max(0.0);
        v.ai.mine_cd = (v.ai.mine_cd - dt).max(0.0);
        // Distance-window detection rather than "distance covered this tick versus the
        // speedometer reads". A per-tick expectation fires on a standing start (every hull
        // covers ~0 m for its first ticks) and misses a hull whose wheels are stalled against
        // a wall; both showed up as tanks reversing before they had moved and then sitting
        // wedged anyway. Anchoring a window and requiring real displacement is independent of
        // wheel speed and cannot fire while the driver is deliberately stationary (a firing
        // attack run commands throttle 0, which resets the window every tick). The throttle
        // test is on the magnitude: the three-point turn backs up at -0.75, and a hull that
        // cannot move in reverse is just as wedged as one that cannot move forward (measured
        // on map 0 seed 7: a tank pinned at (265,278) with `throttle -0.75` for 200 s because
        // the recovery never armed).
        if v.ai.escape_t <= 0.0 && inp.throttle.abs() > 0.2 {
            // A hull grinding up a steep grade covers little ground per window without being
            // wedged, and the escape burst would reverse it into the slope it is climbing:
            // measured on seed 1337, an MLRS pinned on a ~19 % ridge crest where every
            // recovery swing drove it back down. Exempt active climbing (real grade under the
            // hull in the direction of travel, and actually rolling) from accumulation; a hull
            // truly wedged on the slope has no forward speed and still arms normally.
            let climbing = {
                let s = w.map.slope_at(v.pos.x, v.pos.y);
                let f = v2(v.yaw.sin(), v.yaw.cos());
                let motion = if v.fwd_speed >= 0.0 { 1.0 } else { -1.0 };
                s.dot(f) * motion > 0.08 && v.fwd_speed.abs() > 0.3
            };
            if v.pos.dist(v.ai.last_pos) > PROGRESS_R || climbing {
                v.ai.last_pos = v.pos;
                v.ai.stuck_t = 0.0;
            } else {
                v.ai.stuck_t += dt;
            }
        } else if v.ai.escape_t <= 0.0 {
            v.ai.last_pos = v.pos;
            v.ai.stuck_t = 0.0;
        }
        if v.ai.stuck_t > 0.9 && v.ai.escape_t <= 0.0 {
            // Alternate the swing so repeated attempts cannot ping-pong against the same
            // jamb, and leave a cool-down so two hulls cannot lock each other in a reverse
            // loop (each one's recovery gives the other a window to move).
            v.ai.escape_t = ESCAPE_TIME;
            v.ai.stuck_t = -ESCAPE_COOLDOWN;
            v.ai.escape_dir = if v.ai.escape_dir >= 0.0 { -1.0 } else { 1.0 };
            v.ai.last_pos = v.pos;
        }
        if v.ai.escape_t > 0.0 {
            inp.throttle = -0.9;
            inp.steer = if v.ai.escape_dir >= 0.0 { 1.0 } else { -1.0 };
        }
    }

    // ---- respect the enemy's protected home zone -----------------------------
    // While a home zone is still protected there is nothing to gain by *shooting* into it: the
    // defenders inside cannot be hurt, and a driver that parks on the pad shells a player who
    // may still be reading the controls. Hold fire, and wait outside the ring — but only for
    // drivers, since a gunner already in a firefight keeps its behaviour.
    //
    // Flag runners are exempt from the wait. Protection refuses *damage*
    // (`World::protected_from_attack`); it does not make the flag uncapturable
    // (`flag_capturable` reads the flag state alone), and the stand sits *inside* the bubble —
    // 13.6 m from the pad on map 0 seed 1, against a 24 m `HOME_SAFE_RADIUS`. Held out, a
    // runner orbits while its objective sits 20 m away. In AI-vs-AI play (demo mode) that is
    // not a pause, it is permanent: the defending commander keeps fielding hulls that carry
    // 20 s of home protection each, so the zone is protected almost continuously and the flag
    // is never reached. That is the reported "jeeps stuck in the base": traced at 38 m from
    // the pad, speed 0.0, `throttle 0.00 brake 1`, goal TO_FLAG, while the base's turrets shot
    // at them. Measured over 600 s on four maps (`examples/jeepbase`, seed 3), letting runners
    // through took time inside the enemy walls from 3/210/7/85 s to 358/330/239/171 s,
    // flag-carrying visits from 0/7/0/0 to 11/4/4/5, stalled time on map 3 from 417 s (41 % of
    // every visit) to 6 s, and produced captures on two maps where there had been none
    // (map 0 at t=480 s, map 3 at t=393 s and t=527 s).
    if !engage && !spec.flying {
        if let Some(zone) = nearest_protected_enemy_home(w, team, pos) {
            let d = pos.dist(zone);
            if d < w.tuning.rules.home_standoff * 1.25 {
                inp.fire0 = false;
                inp.fire1 = false;
                inp.fire1_edge = false;
                if goal != aigoal::TO_FLAG && goal != aigoal::HOME_WITH_FLAG {
                    let mut away = pos - zone;
                    if away.len_sq() < 1e-4 {
                        away = v2(w.vehicles[vi].yaw.sin(), w.vehicles[vi].yaw.cos()) * -1.0;
                    }
                    let err = wrap_angle(away.heading() - w.vehicles[vi].yaw);
                    inp.steer = clamp(err * 2.0, -1.0, 1.0);
                    // Pointed at the zone: turn on the spot. Pointed away: back off to the
                    // standoff ring and stop there.
                    if err.abs() > 1.5 {
                        inp.throttle = 0.35;
                    } else if d < w.tuning.rules.home_standoff {
                        inp.throttle = 1.0;
                    } else {
                        inp.throttle = 0.0;
                        inp.brake = true;
                    }
                }
                if !inp.has_aim {
                    inp.aim = w.vehicles[vi].yaw;
                }
            }
        }
    }

    // ---- missile evasion ------------------------------------------------------
    // A guided missile only holds its lock for ~1.6 s, so a hard jink timed just before
    // impact breaks it. Without this the AI is simply target practice for the towers.
    {
        let me = w.vehicles[vi].id as i32;
        let threatened = w.projs.iter().any(|p| {
            let dx = p.pos.x - pos.x;
            let dz = p.pos.z - pos.y;
            p.team != team
                && p.homing
                && p.homing_t > 0.0
                && p.target == me
                && dx * dx + dz * dz < 70.0 * 70.0
        });
        if threatened && w.vehicles[vi].ai.evade_cd <= 0.0 && w.vehicles[vi].ai.escape_t <= 0.0 {
            inp.throttle = 1.0;
            inp.steer = w.vehicles[vi].ai.strafe_dir;
            if w.rng.chance(0.25) {
                w.vehicles[vi].ai.strafe_dir = -w.vehicles[vi].ai.strafe_dir;
            }
            w.vehicles[vi].ai.evade_cd = 1.4;
        }
    }

    // ---- shell evasion (helicopters) ------------------------------------------
    // The block above only ever fires for `homing` rounds. The threat that actually kills a
    // helicopter is a tank's 120 mm — aimed with lead, 145 damage on a 200 hp airframe — and
    // it got no reaction at all: the AI held its heading and flew through the solution. A
    // helicopter answers a shell by reversing its lateral run, which is what breaks the
    // tank's lead; the chin gun stays on the target the whole time, because `turret_arc` is a
    // full circle and the jink never touches `inp.aim`.
    // It only pays once the aircraft is actually moving: reversing a run that has not built
    // any speed dodges nothing and throws away the acceleration that makes the next few
    // seconds survivable (measured: the jink fired at 1.0 s, the run peaked at 13 m/s and the
    // reversal dropped it to 6 — the helicopter spent the fight hovering again, which is the
    // bug being fixed). So: no jink until the run is mature and the hull has real way on.
    if kind == vkind::HELI
        && w.vehicles[vi].ai.evade_cd <= 0.0
        && w.vehicles[vi].ai.strafe_t <= 1.2
        && w.vehicles[vi].vel.len() > 6.0
    {
        let vel = w.vehicles[vi].vel;
        let inbound = w.projs.iter().any(|p| {
            if p.team == team || p.homing {
                return false;
            }
            let rel = v2(p.pos.x - pos.x, p.pos.z - pos.y);
            let rv = v2(p.vel.x - vel.x, p.vel.z - vel.y);
            let vv = rv.len_sq();
            if vv < 1.0 {
                return false;
            }
            // Time to closest approach; only rounds arriving within the next second or so
            // are worth moving for, and only if they actually bear on the aircraft.
            let t = -rel.dot(rv) / vv;
            t > 0.0 && t < 0.9 && (rel + rv * t).len() < 9.0
        });
        if inbound {
            w.vehicles[vi].ai.strafe_dir = -w.vehicles[vi].ai.strafe_dir;
            // Commit the new direction: a jink that flips back next think displaces nothing.
            w.vehicles[vi].ai.strafe_t = 2.4;
            // Long enough that the new run actually builds speed: a jink every second
            // reverses the aircraft's momentum before it has any, which leaves it hovering
            // in place — the very thing this is supposed to stop.
            w.vehicles[vi].ai.evade_cd = 2.0;
            inp.strafe = w.vehicles[vi].ai.strafe_dir;
        }
    }

    // ---- final approach -------------------------------------------------------
    // Inside the last 30 m, steer straight at the objective: the plaza is open ground and
    // the flow field can otherwise push a driver along the perimeter wall.
    if !engage {
        let objective = match goal {
            aigoal::HOME_WITH_FLAG => Some(w.flags[team as usize].home),
            aigoal::TO_FLAG => Some(w.flags[1 - team as usize].pos),
            _ => None,
        };
        if let Some(target) = objective {
            let d = target.dist(pos);
            // Only drive straight at the objective when nothing is in the way: since the
            // base perimeter became a continuous wall, a blind final approach just parks
            // the vehicle against the outside of it.
            let eye = v3(pos.x, w.vehicles[vi].center_y(), pos.y);
            let tgt = v3(target.x, w.map.height_at(target.x, target.y) + 1.0, target.y);
            if d < 30.0 && has_los(w, eye, tgt, -1) {
                let err = wrap_angle((target - pos).heading() - w.vehicles[vi].yaw);
                inp.steer = clamp(err * 2.0, -1.0, 1.0);
                inp.throttle = if err.abs() > 1.6 { 0.25 } else { 0.9 };
                inp.fire0 = inp.fire0 || (d < 12.0);
            }
        }
    }

    // ---- breach the enemy base's wall ------------------------------------------
    // A hull with nothing left to shoot and the enemy base in front of it is more use opening the
    // place up than milling around outside it: the perimeter walls are destructible, they block
    // line of sight, and the flag stand is inside them. That includes the jeep, which is the
    // hull most likely to be standing at an enemy wall with nothing to shoot - it is the runner,
    // and a runner that cannot get in has nothing else to do. Towers come first - they shoot the
    // runner - so this only runs when there is no tower to answer either.
    //
    // A flag carrier with no route home is the same block used backwards: it is not opening a
    // way in, it is breaking its way out. The base field having no cost at the hull's position
    // means the nav grid is pinched - a wall notch, a destroyed structure closing the lane - and
    // driving cannot fix it (the escape reverse bounces off the same masonry), which is the
    // reported "jeep stuck in the enemy base": it mills inside the walls with nothing to shoot,
    // because carriers were excluded from breaching. It shoots the wall that stands between it
    // and its own base - scored against the line home, not the flag it just left - and keeps
    // driving so it pushes through the moment a gap opens. The condition clears itself: once a
    // wall section falls, `to_base` reopens within one field refresh (~1.5 s) and the carrier
    // drives out on its own. In water it is not trapped - the land field reads unreachable for
    // a swimming hull, but open water is a route, not a jam. Unlike the breachers above it does
    // not wait for the field to be quiet: a trapped hull cannot move either way, so the wall
    // that holds it is the threat to answer first, defender or no defender.
    let carrier_trapped = w.vehicles[vi].carrying_flag()
        && !w.in_water(pos)
        && w.fields.to_base[team as usize].cost(&w.map, pos).is_infinite();
    if !engage
        && matches!(kind, vkind::TANK | vkind::HELI | vkind::HRSV | vkind::JEEP)
        && (carrier_trapped
            || (tinfo.is_none()
                && !w.vehicles[vi].carrying_flag()
                && nearest_enemy_tower(w, team, pos, 120.0).is_none()
                && pos.dist(w.flags[1 - team as usize].pos) < BREACH_RANGE))
    {
        // A trapped carrier breaks towards its own base; everyone else breaks towards the flag.
        let objective = if carrier_trapped {
            w.flags[team as usize].home
        } else {
            w.flags[1 - team as usize].pos
        };
        if let Some(si) = breach_target(w, team, pos, objective, BREACH_RANGE) {
            let s = w.map.structures[si];
            let sp = s.pos();
            let d = sp.dist(pos);
            let reach = spec.weapon0.range * 0.9;
            let want_yaw = (sp - pos).heading();
            inp.aim = want_yaw;
            inp.has_aim = true;
            // Aim at the middle of the wall, not at its base: 2.6 m of wall is easy to shoot
            // over, and a round that clears the top does nothing at all.
            let aim_y = s.y + s.h * 0.5;
            inp.aim_pitch = ((aim_y - (w.vehicles[vi].center_y() + spec.weapon0.muzzle_up)) / d.max(6.0))
                .atan();
            if d < reach {
                if wrap_angle(want_yaw - w.vehicles[vi].turret_yaw).abs() < 0.14 {
                    inp.fire0 = true;
                }
                if kind == vkind::TANK {
                    inp.throttle = 0.0;
                    inp.steer = 0.0;
                }
            }
        }
    }

    // A resupply run ends in a hover. A helicopter at 45 m/s does not stop over a pad, it flies
    // past it, and the pad's six-metre supply radius only catches it in passing - measured, one
    // took fuel on in fits and starts (26 % -> 42 %) and never got full, because every pass
    // carried it out of range again. Close to the pad it brakes and then holds station.
    if goal == aigoal::SUPPORT && spec.flying {
        let (need_fuel, need_ammo) = supply_need(w, vi).unwrap_or((true, true));
        if let Some(p) = supply_target(w, team, pos, need_fuel, need_ammo) {
            let d = pos.dist(p);
            if d < 30.0 {
                // Close the last few metres gently, then hold station over the pad. The steering
                // is left alone: it is what keeps the nose - and so the thrust - pointed at it.
                let speed = w.vehicles[vi].vel.len();
                inp.throttle = if d > 8.0 {
                    0.35
                } else if speed > 1.2 {
                    -0.4
                } else {
                    0.0
                };
            }
        }
    }

    // Helicopters keep their altitude sane over terrain.
    if spec.flying {
        let ground = w.map.height_at(pos.x, pos.y);
        inp.ascend = ground > 8.0 && w.vehicles[vi].alt < 16.0;
    }

    w.vehicles[vi].ai_input = inp;
    // AI fires its own weapons inside the physics step through `ai_input`.
}

/// How far to one side of the flow field's route this hull drives, in metres.
///
/// Why: `FlowField::sample` answers with one of eight compass headings for the whole 2 m cell
/// the hull stands in, so every hull on the same route — and every hull in the next round,
/// since the field is rebuilt from the same map — is handed the same line. The offset below is
/// what makes a column of attackers fan out into slightly different lanes.
///
/// The amplitude shrinks with hull width: a 7 m bridge deck is no room for a tank to wander,
/// while a jeep can pick its own line down the middle of a 60 m plain. Widening the probe into
/// a cell the width rule rejects (a wall, a one-cell pinch, open water) yields no heading and
/// the offset is simply dropped, so what is drivable is still the field's decision.
///
/// Derived from the hull's id and its existing `jitter` phase rather than a fresh `rng` draw:
/// the simulation shares one RNG stream and an extra draw here reshuffles every randomized
/// decision after it (that is what broke the drone audit once). The slow `time` term is what
/// keeps one hull from driving a perfectly straight parallel line for a whole round.
fn lane_offset(spec: &crate::spec::VehicleSpec, id: u32, jitter: f32, time: f32) -> f32 {
    let amp: f32 = (7.0 - spec.width * 1.5).clamp(1.5, 5.0);
    let base = (id as f32 * 0.618 + jitter).sin();
    let drift = (time * 0.21 + jitter * 1.7).sin() * 0.4;
    amp * (base + drift).clamp(-1.0, 1.0)
}

/// Direction to head for when no flow field is available yet.
/// The field direction at the nearest live cell around a hull standing where its own cell's
/// flow is zero.
///
/// Two situations leave a grounded hull with no direction to follow at its own position:
/// - In water, the land fields give water cells no direction (infinite cost), but the route
///   it is wading across is still there one or two metres away.
/// - In an unreachable pocket on land: destroyed structures and base walls pinch the nav grid
///   and leave a few drivable cells with no field at all (map 0 seed 3: a flag carrier milled
///   for 200 s at (216,187) inside a wall notch where `to_base` was zero while the field
///   worked ~4.5 m away; the straight-line fallback plus `avoid_ahead` just oscillated, and
///   the wobble kept clearing the stuck detector's progress window).
/// Scans rings of eight points out to ~10 m and returns the sample at the first non-water
/// cell with a live field. Callers must not gate this on `!amphibious`: the jeep is
/// amphibious, so an "only for land hulls" guard silently disabled the recovery for exactly
/// the hull that needs it most.
fn nearby_field_dir(map: &MapData, field: &nav::FlowField, pos: Vec2) -> Vec2 {
    for r in [1.5f32, 3.0, 4.5, 7.5, 10.5] {
        for k in 0..8usize {
            let a = (k as f32 / 8.0) * core::f32::consts::TAU;
            let p = pos + v2(a.cos(), a.sin()) * r;
            if !terrain::is_water(map.nav_at(p.x, p.y)) && field.cost(map, p).is_finite() {
                let d = field.sample(map, p);
                if d.len_sq() > 0.01 {
                    return d;
                }
            }
        }
    }
    Vec2::ZERO
}

/// The direction to the nearest cell where this hull's own field starts, for a grounded hull
/// standing where that field has no heading at all.
///
/// A hull can end up on a cell its route treats as impassable: the nav grid is a 2 m cell
/// average and the water test is a point test, so the inland half of a shoreline cell can be
/// 0.9 m of dry sand that `mapgen` classified as SHALLOW_WATER (measured on map 3 "Shattered
/// Keys" seed 3 at (415.8, 273.7): height 0.91 m over a water line of 0.0, nav byte 1). The
/// physics does not shove it out — `in_water` is false — but the land field has no direction
/// there, and the old recovery sampled the route on the nearest cell that *does* have one,
/// which aims the hull along the route as it runs from there: 2 m up the beach behind it, a
/// ~105 deg error. A hull that must turn around first, on a slope, reverses at 0.3 m/s while
/// the three-point turn and the stuck recovery trade the wheel, and dithers for 21.6 s.
/// Aiming at the re-entry cell itself is metres of driving in the gear the hull is already in,
/// and the route is picked up properly once the hull is standing on it.
fn route_reentry(w: &World, vi: usize, field: &nav::FlowField, pos: Vec2) -> Option<Vec2> {
    let map = &w.map;
    let heading = v2(w.vehicles[vi].yaw.sin(), w.vehicles[vi].yaw.cos());
    for r in [1.5f32, 3.0, 4.5, 6.0] {
        let mut best: Option<Vec2> = None;
        let mut best_align = -2.0f32;
        for k in 0..12usize {
            let a = (k as f32 / 12.0) * core::f32::consts::TAU;
            let p = pos + v2(a.cos(), a.sin()) * r;
            if terrain::is_water(map.nav_at(p.x, p.y)) || !field.cost(map, p).is_finite() {
                continue;
            }
            let to = (p - pos).norm();
            // Straight ahead or straight back: reachable in the gear the hull is in, without
            // the turn-around that the slope makes so expensive.
            let align = to.dot(heading).abs();
            if align > best_align {
                best_align = align;
                best = Some(to);
            }
        }
        if best.is_some() {
            return best;
        }
    }
    None
}

/// The enemy's player hull — the same hull `nav::update_fields` builds the `to_enemy` field
/// towards (cursor 4|5: first alive enemy vehicle with `player > 0`). A hunting jeep consults
/// this to decide whether its HUNT goal is really "run the flag" in disguise.
fn to_enemy_hull(w: &World, team: u8) -> Option<usize> {
    w.vehicles
        .iter()
        .position(|v| v.team != team && v.alive() && v.player > 0)
}

/// Where a ground hull inside its own base steers at while leaving, and whether it is queued
/// behind a friendly on the lane (and should creep until the gap opens). See the exit-corridor
/// comment in `think_vehicle` for the why.
fn exit_lane_target(w: &World, vi: usize, team: u8) -> Option<(Vec2, bool)> {
    let t = (team as usize).min(1);
    let gate = w.gate_pos(team)?;
    // The lane is the pad-gate line — what spawn yaw faces. The base anchor sits several
    // metres to one side of it, and an anchor-gate axis reads a hull parked on the true lane
    // as ~6 m off-centre, which breaks both the single-file window and the centreline aim.
    let pad = w.map.spawn[t];
    let axis = (gate - pad).norm();
    if axis.len_sq() < 0.01 {
        return None;
    }
    let perp = axis.rot(core::f32::consts::FRAC_PI_2);
    let me = &w.vehicles[vi];
    let my_along = (me.pos - gate).dot(axis);

    // Single file: a friendly ground hull queued ahead on the same lane gets the opening
    // first — but "queued" means within ~12 m ahead, not merely anywhere in front. A leader
    // already clearing the base is not blocking it, and slowing for one only delays the exit
    // (measured: map 1 seed 1 — a tank held behind a jeep that was 15 m ahead and gone, then
    // arrived at enemy turrets seconds late). Side by side, an id tie-break decides who
    // creeps so exactly one of a pair slows. The lateral window keeps a hull crossing the
    // base (or leaving through the sally port) from holding up the front lane.
    let mut queued = false;
    for o in w.vehicles.iter() {
        if o.id == me.id || !o.alive() || o.team != team || o.spec().flying {
            continue;
        }
        let their_rel = o.pos - gate;
        let ahead_by = their_rel.dot(axis) - my_along;
        if their_rel.dot(perp).abs() > 6.0 {
            continue;
        }
        let in_queue = (1.0..12.0).contains(&ahead_by) || (ahead_by >= -1.0 && o.id > me.id);
        // "In the yard" includes the few metres past the gate. It has to: the hull that has just
        // left is the one being rear-ended - it stops to shoot something the moment it is clear,
        // and the follower, no longer held, accelerates into it (the reported "tank spawns and
        // drives, jeep spawns and drives into the tank").
        if in_queue && (w.inside_own_base(team, o.pos) || o.pos.dist(gate) < 22.0) {
            queued = true;
            break;
        }
    }

    // Centreline aim while behind the wall line: steer at a point on the lane 10 m ahead,
    // clamped to no closer than 2 m inside the opening. A fixed point past the gate sent wide
    // spawns out at an angle into the jamb (measured: 15 of 24 fresh spawns clipped one); a
    // fixed point on the frame pulled half-through hulls back into the base (map 0 seed 7 sat
    // spinning in the gateway for 60 s). The moving target keeps the direction pointing out
    // of the base from any approach angle while each re-aim pulls the path back towards the
    // middle. Within 2 m of the wall it switches to the point 12 m past the gate, which keeps
    // pulling outward. A queued hull steers at the same centreline point — staying on the
    // lane is what keeps its crossing centred — but creeps (throttle cut in think_vehicle)
    // until the leader's gap opens; peeling off the lane to wait used to swing a hull several
    // metres wide inside the opening itself (measured: map 2 seed 3, near=3.05).
    let target = if my_along < -2.0 {
        gate + axis * (my_along + 10.0).min(-2.0)
    } else {
        w.gate_exit_target(team)?
    };
    // Stagger the lane by hull, the same per-hull offset the open field uses, clamped to what
    // the opening can take: every hull aiming at the *centre* line is why a pair leaving
    // together converged on it and arrived at the gate as one column. The offset stays inside
    // the 8 m opening (±1.8 m), and it is the same value `lane_offset` gives the hull outside,
    // so the line through the gate joins the line it drives beyond it instead of kinking.
    // Small on purpose: the gateway audits hold a tank to 1.2 m and a jeep to 1.8 m off centre
    // ("a wide spawn clips a jamb"), so this staggers the queue without moving the line through
    // the opening. The real separation on the way out is the single-file rule above.
    let side = lane_offset(&me.spec(), me.id, me.ai.jitter, w.time).clamp(-0.45, 0.45);
    Some((target + perp * side, queued))
}

fn objective_dir(w: &World, vi: usize) -> Vec2 {
    let team = w.vehicles[vi].team as usize;
    let goal = w.vehicles[vi].ai.goal;

    let target = match goal {
        aigoal::HOME_WITH_FLAG => w.flags[team].home,
        aigoal::SUPPORT => {
            // Home has a wall around it, so the straight-line fallback aims at the *gate* until
            // the hull is through it, and only then at the depot.
            let v = &w.vehicles[vi];
            if !v.spec().flying && !w.inside_own_base(team as u8, v.pos) {
                // Outside: aim at the stand inside the walls, exactly as a flag carrier coming
                // home does. The gate frame itself sits *in* the wall plane, and aiming at it
                // from outside pulls a hull back into the masonry (the same reason
                // `gate_exit_target` aims 12 m past the opening).
                w.flags[team].home
            } else {
                let (fuel, ammo) = supply_need(w, vi).unwrap_or((true, true));
                supply_target(w, team as u8, v.pos, fuel, ammo).unwrap_or(w.flags[team].home)
            }
        }
        aigoal::HUNT | aigoal::ATTACK_STRUCT => {
            // A jeep never hunts air: if the enemy's player hull is a heli (or drone), its
            // pursuit target skips it and falls back to the next ground unit or the flag.
            // Every other hull keeps the old first-player-hull rule.
            let chase_air = w.vehicles[vi].kind != vkind::JEEP;
            w.vehicles
                .iter()
                .find(|v| {
                    v.team != team as u8
                        && v.alive()
                        && v.player > 0
                        && (chase_air || !v.spec().flying)
                })
                .map(|v| v.pos)
                .unwrap_or(w.flags[1 - team].pos)
        }
        _ => w.flags[1 - team].pos,
    };
    (target - w.vehicles[vi].pos).norm()
}

fn decide_goal(w: &World, vi: usize, target: Option<usize>) -> u8 {
    let v = &w.vehicles[vi];
    let team = v.team as usize;
    let kind = v.kind;
    // Rearm before anything else. `aigoal::SUPPORT` was declared and never chosen, so no AI hull
    // had ever deliberately resupplied: a helicopter flew until its tank was dry and - now that
    // running dry actually stops the engine - fell out of the sky, and a tank that ran its
    // magazine out drove around as a ram. Threshold: a third of a tank, or an empty gun.
    if let Some((fuel, ammo)) = supply_need(w, vi) {
        if supply_target(w, v.team, v.pos, fuel, ammo).is_some() {
            return aigoal::SUPPORT;
        }
    }
    let goal = match kind {
        vkind::JEEP => {
            if v.carrying_flag() {
                aigoal::HOME_WITH_FLAG
            } else if w.flags[1 - team].state == flagstate::HOME
                || w.flags[1 - team].state == flagstate::DROPPED
            {
                aigoal::TO_FLAG
            } else {
                aigoal::HUNT
            }
        }
        vkind::HELI | vkind::DRONE => {
            if target.is_some() {
                aigoal::HUNT
            } else {
                aigoal::PATROL
            }
        }
        vkind::HRSV | vkind::TANK => {
            if target.is_some() {
                aigoal::HUNT
            } else {
                aigoal::ATTACK_STRUCT
            }
        }
        _ => aigoal::PATROL,
    };
    // A land vehicle whose objective is genuinely unreachable (every bridge on its corridor
    // is down, no ford) must not press into the gap: hold near its own base until a rebuilt
    // field reaches it again. The test is re-run every think tick, so recovery is automatic -
    // `nav::update_fields` reopens the route within one stagger, and normal goal selection
    // resumes on the next decision. Flying hulls ignore water and amphibious ones can swim,
    // so neither ever holds.
    if !v.spec().flying && !v.spec().amphibious {
        let field = match goal {
            aigoal::HOME_WITH_FLAG => &w.fields.to_base[team],
            aigoal::HUNT | aigoal::ATTACK_STRUCT => &w.fields.to_enemy[team],
            _ => &w.fields.to_flag[team],
        };
        // `valid` is false until the field is first built; an unbuilt field is not evidence
        // that the route is gone, so fall through to the normal goal in that case.
        //
        // A hull sitting on a water cell is mid-crossing (a shallow pocket the land field
        // cannot route through), not stranded: flipping it to HOLD here aims hold_dir at its
        // own pad 200+ m behind, and the brake-and-reverse that follows scatters the yaw of
        // a hull still doing 15 m/s into a spin that never recovers — measured on map 3 seed
        // 1, where a tank crossing a two-cell cove at (248,287) milled in place for 140 s.
        // Keep the current goal while it is in water; on land the check applies as before.
        let on_water = terrain::is_water(w.map.nav_at(v.pos.x, v.pos.y));
        if field.valid && !on_water && !field.cost(&w.map, v.pos).is_finite() {
            return aigoal::HOLD;
        }
    }
    goal
}

/// Direction for a driver with no route to its objective: fall back to its own spawn pad,
/// then walk a slow circle around it. This is the "every crossing is down" behaviour - the
/// hull holds near home instead of driving into the water at a destroyed bridge.
fn hold_dir(w: &World, vi: usize, pos: Vec2) -> Vec2 {
    let home = w.home_center(w.vehicles[vi].team);
    let r = w.tuning.rules.home_safe_radius;
    if pos.dist(home) > r * 0.75 {
        return (home - pos).norm();
    }
    // Mill around the pad; the per-vehicle phase offset keeps a garrison from stacking on
    // one point.
    let a = w.time * 0.45 + vi as f32 * 2.1;
    (home + v2(a.cos(), a.sin()) * (r * 0.55) - pos).norm()
}

/// Throttle ceiling for a driver closing on a friendly ground hull ahead of it: `None` when the
/// road is clear, `Some(0.0)` when it is close enough to touch, and something in between while it
/// is still catching up.
///
/// The driving only ever knew about the terrain, so a hull would close on a teammate that had
/// stopped to shoot and shunt it. Steering is the wrong answer for that - the hull ahead is a
/// wall, not an obstacle to slip past - so this stops *adding throttle* while the gap closes and
/// lets the queue sort itself out. Measured with `examples/traffic` over five-minute AI-vs-AI
/// rounds: 30/38/15 friendly ground contacts and 45.9/54.3/20.1 s spent in contact on maps
/// 0/1/3 before this, 6/4/4 contacts and 5.2/1.9/3.5 s after.
fn friendly_ahead(w: &World, vi: usize, dir: Vec2) -> Option<f32> {
    let me = &w.vehicles[vi];
    let mut hold: Option<f32> = None;
    for o in w.vehicles.iter() {
        if o.id == me.id || !o.alive() || o.team != me.team {
            continue;
        }
        if o.spec().flying || o.kind == vkind::TROOP {
            continue;
        }
        let to = o.pos - me.pos;
        let d = to.len();
        let gap = d - (me.spec().radius + o.spec().radius);
        if gap > 12.0 {
            continue;
        }
        // A ~30 degree cone: beside or behind is not in the way.
        if d > 1e-3 && to.norm().dot(dir) < 0.86 {
            continue;
        }
        // Only slow for someone we are actually gaining on; a teammate pulling away is a leader,
        // and matching its pace is how a convoy works.
        let closing = me.vel.dot(dir) - o.vel.dot(dir);
        if closing < 0.2 && gap > 0.5 {
            continue;
        }
        let want = if gap < 1.0 {
            0.0
        } else if gap < 4.0 {
            0.15
        } else {
            0.4
        };
        hold = Some(hold.map_or(want, |h: f32| h.min(want)));
    }
    hold
}

/// Cast short rays ahead of the desired heading and follow the clearest one, so a hull turns
/// away from an obstacle while there is still room to do it instead of arriving at it first
/// and correcting afterwards.
///
/// The flow field is a distance transform over a 2-4 m grid whose obstacles are grown by only
/// about a metre: it knows the route, not that its own quantised gradient points at a corner,
/// or that a wreck appeared on the lane after the last rebuild. A hull with momentum covers
/// more ground in a second than the next rebuild's correction can undo — which is what reads
/// as "slamming into buildings before making nav corrections". The rays test the same raster
/// the field routes on (`map.nav`, plus `dyn_block` for wrecks and destroyed structures), so
/// avoidance and routing cannot disagree about what is solid.
///
/// Water is deliberately *not* an obstacle here: crossing water is a routing decision (which
/// bridge, which ford) that belongs to the field, and a ray that treats open water as a wall
/// argues with it at every shoreline — measured on map 0 seed 1, where the team-1 tank circled
/// the bridge approach for fifteen seconds because its straight ray hit the channel beside the
/// deck. Off-map counts as blocked: no route ever wants there.
///
/// Returns `None` when every ray hits close in: a hull boxed in that tightly is stuck
/// detection's problem, and keeping the field's direction is what lets that detector arm.
fn avoid_ahead(w: &World, vi: usize, pos: Vec2, dir: Vec2, look: f32, watch_mates: bool) -> Option<Vec2> {
    let map = &w.map;
    let g = map.grid as i32;
    let cell = map.cell;
    let dyn_block = &w.dyn_block;
    // Teammates are obstacles too. The ray test below only knows the nav grid, which says nothing
    // about the hull parked at the depot or the one stopped in the gateway, so a driver had no
    // way to go *around* a teammate - it either queued behind it forever or drove into it. Only
    // the few nearest friendlies are collected, once per think, and the sample points are tested
    // against them on the way past.
    let me_team = w.vehicles[vi].team;
    let me_id = w.vehicles[vi].id;
    let mut mates: [(Vec2, f32); 6] = [(Vec2::ZERO, 0.0); 6];
    let mut mates_n = 0usize;
    for o in w.vehicles.iter().filter(|_| watch_mates) {
        if o.id == me_id || !o.alive() || o.team != me_team || o.spec().flying || o.kind == vkind::TROOP {
            continue;
        }
        if o.pos.dist(pos) > look + 6.0 {
            continue;
        }
        if mates_n < mates.len() {
            mates[mates_n] = (o.pos, o.spec().radius + 1.0);
            mates_n += 1;
        }
    }
    let mate_at = |p: Vec2| -> bool {
        mates[..mates_n].iter().any(|(c, r)| {
            let dx = p.x - c.x;
            let dz = p.y - c.y;
            dx * dx + dz * dz < r * r
        })
    };
    let blocked_at = |p: Vec2| -> bool {
        if mate_at(p) {
            return true;
        }
        let ix = (p.x / cell).floor() as i32;
        let iz = (p.y / cell).floor() as i32;
        if ix < 0 || iz < 0 || ix >= g || iz >= g {
            return true; // off the island: open water, and no route wants it
        }
        let i = (iz * g + ix) as usize;
        if dyn_block[i] {
            return true;
        }
        let t = map.nav[i];
        t == terrain::ROCK || t == terrain::BLOCKED
    };
    // Sample every metre: a blocked region is always at least one nav cell wide (2 m small/
    // medium, 4 m big), and a step half that wide cannot skip over it — measured the cost of
    // getting this wrong on map 0 seed 7, where a 2 m sample stride let a tank cross a bridge
    // at 11 m/s straight through the palm line at the landing (two rams, dead in four seconds).
    let mut best: Option<(f32, Vec2)> = None;
    for a in [0.0f32, 0.5, -0.5, 1.0, -1.0] {
        let d = dir.rot(a);
        let mut hit = f32::INFINITY;
        let mut t = 1.0;
        while t <= look {
            if blocked_at(pos + d * t) {
                hit = t;
                break;
            }
            t += 1.0;
        }
        // A clear ray beats a blocked one outright. Among clear rays the straight line wins
        // (the penalty keeps a hull from weaving between two equally open directions); among
        // blocked ones the farthest hit wins, because that is the most reaction time — which
        // is exactly what a wall across the lane needs.
        let score = if hit > look {
            look + (1.0 - a.abs()) * 2.0
        } else {
            hit
        };
        if best.map_or(true, |(s, _)| score > s) {
            best = Some((score, d));
        }
    }
    let (score, d) = best?;
    if score < 3.0 {
        return None;
    }
    Some(d)
}

/// The enemy team's commander: keeps 2-3 vehicles in the field.
fn ai_commander(w: &mut World, dt: f32) {
    w.ai_cmd_t -= dt;
    // The ally supply line ticks in real time even between commander periods: a replacement is
    // ready the moment its build time has run, not one whole period later. So does the
    // per-team spawn gap, which `spawn_vehicle` arms on every field spawn.
    for t in 0..2 {
        w.ally_cd[t] = (w.ally_cd[t] - dt).max(0.0);
        w.spawn_cd[t] = (w.spawn_cd[t] - dt).max(0.0);
    }
    if w.ai_cmd_t > 0.0 {
        return;
    }
    // How often the CPU may put a hull into the field. This is the second half of the
    // difficulty's unit availability: the field target above caps how many the CPU keeps
    // alive, this caps how fast it can replace them, and under sustained losses the slower of
    // the two binds. The old 2.6 s base read as a stream in play: two hulls lost at once came
    // back ~3.5 s apart (one per tick), which is what "enemy vehicles spawn too quickly after
    // each other" was. At 5.0 s the ticks are easy 5.0 / medium 3.33 / hard 1.67 s, so a pair
    // lands at least ~6.7 s apart on the default difficulty while hard stays aggressive. Note
    // this makes cumulative hulls-fielded per round non-monotone in difficulty (a bigger
    // garrison survives longer and needs fewer replacements); field strength is what orders.
    w.ai_cmd_t = 5.0 / w.unit_scale();
    for team in 0..2u8 {
        // A human team is skipped — unless CPU allies are on, in which case this same pass
        // fields and keeps topped up that team's *allies* (its `player == 0` hulls). A
        // CPU-driven slot (demo mode) still counts as "human" either way.
        let has_human = (0..2).any(|p| w.player_of_team[p] == team as i32);
        if has_human && !w.cpu_allies {
            continue;
        }
        let active = w
            .vehicles
            .iter()
            .filter(|v| {
                v.alive()
                    && v.team == team
                    && v.player == 0
                    && matches!(v.kind, vkind::JEEP | vkind::TANK | vkind::HRSV | vkind::HELI)
            })
            .count();
        if has_human {
            // CPU allies: a flat two-hull force, whatever the difficulty. That is exactly
            // parity with the enemy's easy garrison, and — once you add the player's own hull
            // on top — balanced against medium (the default); easy stays player-favoured and
            // hard keeps its edge. The supply line is independent of the player's garage
            // (`ally_cd` paces it at build time), because the commander spending the shared
            // reserve is what left every slot "IN BUILD" in the first place. An explicit
            // `vehicle_cap` (stress test) raises this too, so both teams can be pushed.
            let want_allies = w.vehicle_ceiling(2);
            if active >= want_allies {
                continue;
            }
            let runners = w
                .vehicles
                .iter()
                .filter(|v| v.alive() && v.team == team && v.player == 0 && v.kind == vkind::JEEP)
                .count();
            // A capture needs a jeep: while the enemy flag is loose and no runner is alive,
            // the replacement is one — the same rule the enemy commander runs.
            let enemy_flag = &w.flags[1 - team as usize];
            let capturable = enemy_flag.state == flagstate::HOME || enemy_flag.state == flagstate::DROPPED;
            if w.ally_cd[team as usize] > 0.0 {
                continue;
            }
            // The ally line keeps its own build-time pacing on top of the spawn gap.
            if w.spawn_cd[team as usize] > 0.0 {
                continue;
            }
            let kind = pick_commander_kind(&[1.0, 1.0, 1.0, 1.0], capturable && runners == 0, &mut w.rng)
                .unwrap_or(vkind::TANK);
            let id = w.spawn_vehicle(kind, team, 0);
            if let Some(vi) = w.vehicle_index(id) {
                // Newly built crews start with a little situational awareness delay.
                w.vehicles[vi].ai.think_t = w.rng.range(0.1, 0.5);
            }
            w.ally_cd[team as usize] = vehicle::spec(kind).build_time;
            continue;
        }
        // Unit availability, which is what the difficulty setting names: the CPU fields
        // 2 / 3 / 6 hulls at once on easy / medium / hard (`World::difficulty`, 1.0 / 1.5 /
        // 3.0), on top of the faster garage rebuild and reserve cap `world.rs::update_garage`
        // gives a CPU-held team. Easy is exactly the 2 the commander has always kept, i.e. the
        // rules the player plays under, so it is the default for a player who wants parity.
        // An explicit `vehicle_cap` overrides the whole formula, which is how a stress test
        // asks for thirty hulls a side.
        let want = w.vehicle_ceiling((2.0 * w.unit_scale()).round() as usize);
        // ...but no reinforcement at all while one of its hulls is still in the yard. With
        // `want` raised the commander used to fill the garrison instantly, and on Iron Strait
        // seed 7 three hulls fighting for the gateway wedged each other there: the tank stalled
        // 167 m from its objective and even the jeeps, which cross fine at two hulls, stopped
        // getting out. Holding reinforcements back fixes the congestion at its source instead
        // of widening the gate: a hull that is still inside its own base zone blocks the next
        // spawn until it has driven out.
        //
        // It only applies while the team already has a hull in the field **and** is at risk of
        // piling a second one in behind it: with one hull alive the commander reinforces
        // regardless. That case is not about the gateway - a lone hull can be inside its own
        // zone for reasons that have nothing to do with leaving, defending or refuelling or
        // simply parked - and gating it starved the whole garage: measured on Coral Rim, the
        // tank stopped at its own base and the CPU fielded nothing at all for the remaining
        // 260 s of the round. Measured with the `active > 1` rule on the same seed, the CPU
        // holds three hulls in the field for the whole round; and it captures at t=168 s on
        // Twin Atolls and t=231 s on Shattered Keys, exactly as the stricter rule did.
        // With a stress cap the threshold scales with the field instead of staying at one: a
        // single hull rotating home to refuel or repair would otherwise stop every
        // reinforcement for as long as the war lasts (measured with a cap of 16: the field sat
        // at 2-6 a side while the garage held nine hulls parked per slot and idled, and some
        // hull was inside its own base zone on almost every tick). The rule keeps its point -
        // do not pile another hull into a gateway that already has a queue - it just needs more
        // than one hull before a yard counts as busy on a big field.
        let yard_limit = if w.vehicle_cap > 0 {
            (w.vehicle_cap / 8).max(1)
        } else {
            1
        };
        let yard_busy = w
            .vehicles
            .iter()
            .filter(|v| {
                v.alive() && v.team == team && v.player == 0 && w.in_home_zone(team, v.pos)
            })
            .count()
            >= yard_limit;
        if yard_busy && active > 1 {
            continue;
        }
        // A capture needs a jeep, so the commander always keeps one runner in the field even
        // when the garrison is otherwise full.
        let runners = w
            .vehicles
            .iter()
            .filter(|v| v.alive() && v.team == team && v.player == 0 && v.kind == vkind::JEEP)
            .count();
        let enemy_flag = &w.flags[1 - team as usize];
        let capturable = enemy_flag.state == flagstate::HOME || enemy_flag.state == flagstate::DROPPED;
        if active >= want && (runners > 0 || !capturable) {
            continue;
        }
        // Keep every garage slot topped up so the draw below always has a real choice. The
        // old code only topped up kinds it did not spend this tick, and it spent whichever
        // kind was ready first in a fixed order - jeep/tank rebuild fastest (6/10 s vs 12 s),
        // so over an 8-minute audit the CPU fielded 24 jeeps and 10 tanks and zero MLRS or
        // helis: HRSV sat last in both orders and HELI behind the two fast builders.
        for kind in vehicle::GARAGE {
            let slot = vehicle::GARAGE.iter().position(|k| *k == kind).unwrap_or(0);
            if w.garage[team as usize].parked[slot] < 1.0 && w.garage[team as usize].building[slot] <= 0.0 {
                w.garage[team as usize].building[slot] = vehicle::spec(kind).build_time;
            }
        }
        // While the enemy flag is capturable the commander keeps up to two runners in the
        // field - a capture push, and what made `ai_commander_captures_the_flag_against_an_
        // idle_player` pass: with only one forced runner the second slot went through the
        // weighted draw and parked tanks/MLRS at home (the known goal=4 stall) while the lone
        // jeep kept dying on the way. With a runner pair alive, every other slot - the escorts
        // - goes through the weighted draw, so tanks, helis and MLRS still show up (measured:
        // 23/28 spawns were jeeps when "capturable" alone forced the jeep on nearly every tick).
        let want_runners = if capturable { 2 } else { 1 };
        // The cadence is `World::spawn_cd`, not this period: one field vehicle a team every
        // `CPU_SPAWN_DELAY` seconds, so a raised cap fills steadily instead of dropping a batch
        // on the pad. `spawn_vehicle` refuses a spawn inside the window, so the parked hull is
        // only spent once the spawn is actually going to happen.
        if w.spawn_cd[team as usize] > 0.0 {
            continue;
        }
        let parked: [f32; 4] = core::array::from_fn(|i| w.garage[team as usize].parked[i]);
        let kind = pick_commander_kind(&parked, runners < want_runners, &mut w.rng);
        if let Some(kind) = kind {
            let slot = vehicle::GARAGE.iter().position(|k| *k == kind).unwrap_or(0);
            w.garage[team as usize].parked[slot] -= 1.0;
            w.garage[team as usize].building[slot] = vehicle::spec(kind).build_time;
            let id = w.spawn_vehicle(kind, team, 0);
            if let Some(vi) = w.vehicle_index(id) {
                // Newly built crews start with a little situational awareness delay.
                w.vehicles[vi].ai.think_t = w.rng.range(0.1, 0.5);
            }
        }
    }
}

/// What the commander fields on one tick: `parked` is per garage slot (in
/// `vehicle::GARAGE` order). When `force_jeep` (the field still wants more capture runners)
/// and a jeep is parked, the jeep wins outright; otherwise the pick is a weighted draw over
/// the kinds that are actually parked, so tanks, helis and MLRS all show up instead of the
/// two fastest builders crowding the rest out. Returns `None` when nothing is ready.
fn pick_commander_kind(parked: &[f32; 4], force_jeep: bool, rng: &mut Rng) -> Option<u8> {
    const WEIGHTS: [(u8, f32); 4] = [
        (vkind::TANK, 3.0),
        (vkind::HELI, 2.0),
        (vkind::HRSV, 2.0),
        (vkind::JEEP, 1.0),
    ];
    let ready = |k: u8| -> bool {
        vehicle::GARAGE.iter().position(|g| *g == k).map_or(false, |i| parked[i] >= 1.0)
    };
    if force_jeep && ready(vkind::JEEP) {
        return Some(vkind::JEEP);
    }
    let total: f32 = WEIGHTS.iter().filter(|e| ready(e.0)).map(|e| e.1).sum();
    if total <= 0.0 {
        return None;
    }
    let mut r = rng.f32() * total;
    for (k, wgt) in WEIGHTS.iter().copied() {
        if !ready(k) {
            continue;
        }
        r -= wgt;
        if r <= 0.0 {
            return Some(k);
        }
    }
    // A draw that consumed every weight: fall back to the last ready kind.
    WEIGHTS.iter().rev().find(|e| ready(e.0)).map(|e| e.0)
}

/// Missile turret towers: rotate, acquire, fire homing missiles.
/// Seconds a turret must hold a track before the launcher is cleared to fire.
const ACQUIRE_TIME: f32 = 1.1;

fn update_towers(w: &mut World, dt: f32) {
    let mut shots: Vec<(Vec2, f32, u8, i32)> = Vec::new();
    let n = w.turrets.len();
    for i in 0..n {
        let (alive, struct_id, team, tpos, yaw0, reload0, acquire0, prev_target) = {
            let t = &w.turrets[i];
            (t.alive, t.struct_id, t.team, t.pos, t.yaw, t.reload, t.acquire, t.target)
        };
        let mut acquire = acquire0;
        let mut yaw = yaw0;
        let mut reload = reload0;
        let target: i32;
        if !alive {
            continue;
        }
        let s = w.map.structures[struct_id as usize];
        if !s.alive() {
            w.turrets[i].alive = false;
            continue;
        }
        reload = (reload - dt).max(0.0);
        let muzzle_y = s.y + s.h + 0.6;
        // Acquire the closest enemy within range with line of sight.
        let mut best: Option<(i32, Vec2, f32)> = None;
        let mut bd = w.tuning.weapons[wkind::TOWER_MISSILE].range;
        for (vi, v) in w.vehicles.iter().enumerate() {
            if !v.alive() || v.team == team || v.kind == vkind::SUBMARINE {
                continue;
            }
            // Flag carriers are not acquired. The tower missile one-shots a 100 hp jeep, and
            // a carrier must pause at the pole and then drive back out through the covered
            // approach: with towers free to shoot it, capture is a coin flip against any base
            // with AA cover (measured on map 0 seed 3: every carrier died within ~3 s of the
            // pickup). Mobile defenders can still engage carriers; only fixed emplacements
            // stand down for them.
            if v.carrying_flag() {
                continue;
            }
            // Same rule as the vehicle gunners: shielded or at-home-with-protection targets
            // are not acquired at all.
            if w.protected_from_attack(vi) {
                continue;
            }
            let d = v.pos.dist(tpos);
            if d < bd {
                let eye = v3(tpos.x, muzzle_y, tpos.y);
                let tgt = v3(v.pos.x, v.center_y(), v.pos.y);
                if has_los(w, eye, tgt, struct_id as i32) {
                    bd = d;
                    best = Some((v.id as i32, v.pos, v.center_y()));
                }
            }
        }
        if let Some((id, tp, ty)) = best {
            let want = (tp - tpos).heading();
            yaw = approach_angle(yaw, want, 0.75 * dt);
            // Re-acquiring a different target restarts the tracking clock.
            acquire = if prev_target == id { acquire + dt } else { 0.0 };
            target = id;
            if acquire >= ACQUIRE_TIME && reload <= 0.0 && wrap_angle(want - yaw).abs() < 0.18 {
                reload = w.tuning.weapons[wkind::TOWER_MISSILE].cooldown;
                shots.push((tpos, muzzle_y, team, id));
            }
            let _ = ty;
        } else {
            target = -1;
            acquire = 0.0;
            yaw = wrap_angle(yaw + 0.25 * dt);
        }
        let t = &mut w.turrets[i];
        t.yaw = yaw;
        t.reload = reload;
        t.target = target;
        t.acquire = acquire;
    }
    for (p, y, team, target) in shots {
        let w0 = &w.tuning.weapon(wkind::TOWER_MISSILE);
        // Aim straight at the target: the missile's minimum turn radius is ~30 m, so a
        // fixed launch elevation would make it miss anything close and then orbit.
        let tgt = w
            .vehicle_index(target as u32)
            .map(|vi| v3(w.vehicles[vi].pos.x, w.vehicles[vi].center_y(), w.vehicles[vi].pos.y))
            .unwrap_or(v3(p.x + 1.0, y, p.y));
        let eye = v3(p.x, y, p.y);
        let d = tgt - eye;
        let flat = (d.x * d.x + d.z * d.z).sqrt().max(0.001);
        let yaw = d.x.atan2(d.z);
        let pitch = d.y.atan2(flat);
        let dir = v3(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
        let speed = w0.speed * (1.0 + w.rng.sym() * 0.03);
        combat::spawn_projectile(w, w0, 0, vkind::NONE, team, eye, dir, target, speed);
    }
}

/// Drones show up to punish players who camp in one spot.
fn update_drones(w: &mut World, _dt: f32) {
    let mut spawn_at: Option<(u8, Vec2)> = None;
    for (vi, v) in w.vehicles.iter().enumerate() {
        // The punishment is aimed at *players*: a CPU-driven slot (demo mode, later allies)
        // is a driver and never summons drones.
        if !v.alive() || v.player == 0 || w.vehicle_cpu_driven(vi) {
            continue;
        }
        if v.idle_t > w.tuning.rules.drone_idle_time && w.drone_count < w.tuning.rules.max_drones as u32 {
            spawn_at = Some((v.team, v.pos));
        }
    }
    if let Some((team, p)) = spawn_at {
        w.drone_count += 1;
        let enemy = 1 - team;
        let a = w.rng.range(0.0, core::f32::consts::TAU);
        let spawn = v2(
            clamp(p.x + a.cos() * 70.0, 4.0, w.map.world_size - 4.0),
            clamp(p.y + a.sin() * 70.0, 4.0, w.map.world_size - 4.0),
        );
        let id = w.spawn_vehicle(vkind::DRONE, enemy, 0);
        if let Some(vi) = w.vehicle_index(id) {
            w.vehicles[vi].pos = spawn;
            w.vehicles[vi].alt = vehicle::DRONE.cruise_alt;
            w.vehicles[vi].hp = vehicle::DRONE.hp;
        }
        // Reset the idle timer so drones arrive in waves.
        for v in w.vehicles.iter_mut() {
            if v.player > 0 {
                v.idle_t = 0.0;
            }
        }
        // `DRONES_IN`, not `OUT_OF_BOUNDS`: this is the idle-camp punishment, and reusing the
        // bounds id made sitting still in the middle of the map raise "LEAVING THE OPERATION
        // AREA" — a warning about a problem that was not happening.
        w.notify(notify::DRONES_IN, team);
        w.sound(sfx::ALARM, p, 2.0, 0.8);
    }

    // Drones orbit their target and strafe it.
    for vi in 0..w.vehicles.len() {
        if w.vehicles[vi].kind != vkind::DRONE || !w.vehicles[vi].alive() {
            continue;
        }
        let team = w.vehicles[vi].team;
        let pos = w.vehicles[vi].pos;
        // Clear last tick's orders first. `ai_input` persists on the vehicle, and a drone with
        // nothing to shoot used to keep whatever it was last told to do - trigger included - and
        // fly on firing along a stale bearing while it swung. Measured: 111 of 426 shots laid
        // off the player by up to 0.68 rad, every one of them on a drone whose `ai.target` was
        // already -1.
        w.vehicles[vi].ai_input = Input::default();
        let target = nearest_enemy_vehicle(w, team, pos, 140.0, Prefer::Any);
        let Some(ti) = target else {
            continue;
        };
        let tp = w.vehicles[ti].pos;
        let d = tp.dist(pos);
        let want = (tp - pos).heading();
        let mut inp = Input::default();
        inp.aim = want;
        inp.has_aim = true;
        inp.aim_pitch = ((w.vehicles[ti].center_y() - (w.vehicles[vi].y + 3.0)) / d.max(6.0)).atan();
        let err = wrap_angle(want - w.vehicles[vi].yaw);
        let eye = v3(pos.x, w.vehicles[vi].y + 2.0, pos.y);
        let tgt = v3(tp.x, w.vehicles[ti].center_y(), tp.y);
        if d < 70.0 && has_los(w, eye, tgt, -1) {
            // In gun range with a clean shot: nose on the target and hold it there while
            // strafing. The drone has no independent turret (turret_speed 0) — its shot goes
            // where the hull faces — so firing without an alignment gate is what made a
            // strafing drone spray "random directions": measured, the trigger was open for
            // most of every nose sweep (55/55 shots off target on map 0 seed 3 before this).
            inp.steer = clamp(err * 2.0, -1.0, 1.0);
            inp.throttle = if d < 45.0 { 0.0 } else { 0.3 };
            inp.strafe = w.vehicles[vi].ai.strafe_dir * 0.3;
            let aligned = wrap_angle(want - w.vehicles[vi].turret_yaw).abs() < 0.12;
            let elevated = (inp.aim_pitch - w.vehicles[vi].gun_pitch).abs() < 0.05;
            if aligned && elevated {
                inp.fire0 = true;
            }
        } else if d < 70.0 {
            // In gun range but the shot is blocked (a camper at base sits behind its own walls
            // and towers): do NOT dive at the obstruction — a drone that closed through a
            // cluttered yard clipped a 9 m tower on its first run and died before firing, and
            // one that arcs in place at cruise altitude drifts into the next tower. Climb to
            // the ceiling (cruise*1.7 = 18.7 m, eye ~20.7 m) while circling: every structure
            // on a base is shorter than that, so the line opens from some bearing and the fire
            // branch takes over; dropping `ascend` there eases it back to cruise altitude.
            let orbit = err + core::f32::consts::FRAC_PI_2 * 0.7 * w.vehicles[vi].ai.strafe_dir;
            inp.steer = clamp(orbit * 1.6, -1.0, 1.0);
            inp.throttle = 0.4;
            inp.ascend = true;
        } else {
            // Out of range: close on the target.
            inp.steer = clamp(err * 1.6, -1.0, 1.0);
            inp.throttle = if d > 90.0 { 1.0 } else { 0.6 };
            inp.strafe = w.vehicles[vi].ai.strafe_dir * 0.3;
        }
        w.vehicles[vi].ai_input = inp;
    }
}

fn think_troop(w: &mut World, vi: usize, dt: f32) {
    let team = w.vehicles[vi].team;
    let pos = w.vehicles[vi].pos;
    let mut inp = Input::default();
    let threat = nearest_enemy_vehicle(w, team, pos, 30.0, Prefer::Any);
    match threat {
        Some(ti) => {
            let tp = w.vehicles[ti].pos;
            let d = tp.dist(pos);
            let away = (pos - tp).norm();
            // Flee, but lob a grenade if the enemy is at a decent range.
            let want = away.heading();
            let err = wrap_angle(want - w.vehicles[vi].yaw);
            inp.steer = clamp(err * 2.0, -1.0, 1.0);
            inp.throttle = 1.0;
            inp.aim = (tp - pos).heading();
            inp.has_aim = true;
            inp.aim_pitch = 0.45;
            if d > 9.0 && d < 40.0 && w.vehicles[vi].ammo0 > 0.0 && w.vehicles[vi].reload0 <= 0.0 {
                inp.fire0 = true;
            }
            // Prefer running for the water when badly outgunned (they can swim).
            if d < 5.0 {
                inp.throttle = 1.0;
                inp.steer = clamp(err * 3.0, -1.0, 1.0);
            }
        }
        None => {
            // Wander back towards home.
            let home = w.flags[team as usize].home;
            let dir = (home - pos).norm();
            let err = wrap_angle(dir.heading() - w.vehicles[vi].yaw);
            inp.steer = clamp(err * 1.5, -1.0, 1.0);
            inp.throttle = 0.75;
    w.vehicles[vi].ai_input = inp;
            let _ = dt;
            return;
        }
    }
    w.vehicles[vi].ai_input = inp;
}

fn think_sub(w: &mut World, vi: usize, dt: f32) {
    // Surface, fire one homing missile, then slip away.
    let team = w.vehicles[vi].team;
    let pos = w.vehicles[vi].pos;
    w.vehicles[vi].ai.think_t -= dt;
    let target = nearest_enemy_vehicle(w, team, pos, 400.0, Prefer::Any);
    let mut inp = Input::default();
    if let Some(ti) = target {
        let tp = w.vehicles[ti].pos;
        let want = (tp - pos).heading();
        inp.aim = want;
        inp.has_aim = true;
        inp.aim_pitch = 0.25;
        w.vehicles[vi].turret_yaw = approach_angle(w.vehicles[vi].turret_yaw, want, 0.6 * dt);
        w.vehicles[vi].ai.target = w.vehicles[ti].id as i32;
        if w.vehicles[vi].reload0 <= 0.0 && wrap_angle(want - w.vehicles[vi].turret_yaw).abs() < 0.25 {
            physics::fire(w, vi, 0, w.vehicles[vi].turret_yaw, 0.25);
            w.vehicles[vi].ai.think_t = 12.0;
        }
    }
    w.vehicles[vi].ai_input = inp;
    if w.vehicles[vi].ai.think_t < -8.0 {
        w.vehicles[vi].state = vstate::WRECK;
        w.vehicles[vi].wreck_t = 0.0;
    }
}

/// Spawn a squad of infantry (from a destroyed building, or a bailed-out driver).
pub fn spawn_troops_from(w: &mut World, p: Vec2, team: u8, count: u32) {
    for i in 0..count {
        let a = (i as f32 / count.max(1) as f32) * core::f32::consts::TAU + w.rng.range(0.0, 1.5);
        let pos = p + v2(a.cos(), a.sin()) * w.rng.range(2.0, 4.5);
        if pos.x < 2.0 || pos.y < 2.0 || pos.x > w.map.world_size - 2.0 || pos.y > w.map.world_size - 2.0 {
            continue;
        }
        let id = w.spawn_vehicle(vkind::TROOP, team, 0);
        if let Some(vi) = w.vehicle_index(id) {
            w.vehicles[vi].pos = pos;
            w.vehicles[vi].y = w.map.height_at(pos.x, pos.y).max(w.map.water_level);
            w.vehicles[vi].yaw = a;
            w.vehicles[vi].turret_yaw = a;
            w.vehicles[vi].hp = vehicle::TROOP.hp;
            w.vehicles[vi].alt = 0.0;
            w.vehicles[vi].airborne = false;
        }
    }
}

/// The out-of-bounds punishment: a submarine surfaces and launches a heat-seeker.
pub fn launch_submarine(w: &mut World, team: u8, near: Vec2) {
    let enemy = 1 - team;
    // Find deep water near the offending player.
    let mut best = near;
    'outer: for r in (6..90).step_by(4) {
        for i in 0..12 {
            let a = i as f32 / 12.0 * core::f32::consts::TAU;
            let p = near + v2(a.cos(), a.sin()) * r as f32;
            if p.x < 2.0 || p.y < 2.0 || p.x > w.map.world_size - 2.0 || p.y > w.map.world_size - 2.0 {
                continue;
            }
            if w.map.height_at(p.x, p.y) < -2.5 {
                best = p;
                break 'outer;
            }
        }
    }
    let id = w.spawn_vehicle(vkind::SUBMARINE, enemy, 0);
    if let Some(vi) = w.vehicle_index(id) {
        w.vehicles[vi].pos = best;
        w.vehicles[vi].y = w.map.water_level - 0.6;
        w.vehicles[vi].yaw = (near - best).heading();
        w.vehicles[vi].turret_yaw = w.vehicles[vi].yaw;
        w.vehicles[vi].ai.think_t = 0.4;
        w.vehicles[vi].reload0 = 0.4;
        w.vehicles[vi].flags |= vflag::AIRBORNE;
    }
    w.sound(sfx::SUB_LAUNCH, best, 0.5, 1.0);
    w.push_event(ekind::WATER_SPLASH, best, 0.4, 0.0, 3.0, 0.0, 0.0, 0.0);
}

/// Helper used by the HUD: is `team`'s flag currently capturable?
pub fn flag_capturable(w: &World, team: u8) -> bool {
    let f = &w.flags[team as usize];
    f.state == flagstate::HOME || f.state == flagstate::DROPPED
}

pub fn empty_ai() -> AiState {
    AiState::default()
}

pub fn _silence_unused(w: &World, v: &Vehicle) {
    let _ = nav::pass::LAND;
    let _ = w.time;
    let _ = v.id;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::World;

    /// Block a square of nav cells centred on `p`, `half` cells out in each direction — a
    /// synthetic building. Returns the touched indices so the caller can restore them.
    fn stamp_building(w: &mut World, p: Vec2, half: i32) -> Vec<usize> {
        let g = w.map.grid as i32;
        let cell = w.map.cell;
        let cx = (p.x / cell).floor() as i32;
        let cz = (p.y / cell).floor() as i32;
        let mut out = Vec::new();
        for dz in -half..=half {
            for dx in -half..=half {
                let (ix, iz) = (cx + dx, cz + dz);
                if ix < 0 || iz < 0 || ix >= g || iz >= g {
                    continue;
                }
                let i = (iz * g + ix) as usize;
                out.push(i);
                w.map.nav[i] = terrain::BLOCKED;
            }
        }
        out
    }

    fn clear_cells(w: &mut World, cells: &[usize]) {
        for &i in cells {
            w.map.nav[i] = terrain::GROUND;
        }
    }

    /// A building across the lane must bend the heading away from it. The wall is wide enough
    /// that no ray within the look distance clears it, so the farthest hit has to win — which
    /// is one of the ±1.0 rad rays, not the straight line into the wall.
    #[test]
    fn avoidance_bends_around_a_building_in_the_lane() {
        let mut w = World::new(7, 0, [0, -1]);
        let pos = w.map.spawn[1];
        let gate = w.gate_pos(1).expect("team 1's base is recorded");
        let dir = (gate - pos).norm();
        // Nine cells wide, centred 20 m down the spawn -> gate lane.
        let wall = stamp_building(&mut w, pos + dir * 20.0, 4);
        // A single hull on the pad: its garrison mate is retired so the rays see only the
        // raster.
        let vi = w
            .vehicles
            .iter()
            .position(|v| v.team == 1 && v.kind == vkind::TANK)
            .expect("team 1's garrison tank");
        for oj in (0..w.vehicles.len()).rev() {
            if oj != vi && w.vehicles[oj].team == 1 && w.vehicles[oj].alive() {
                w.kill_vehicle(oj, -1);
            }
        }
        w.vehicles[vi].pos = pos;
        w.vehicles[vi].vel = Vec2::ZERO;
        let out = avoid_ahead(&w, 0, pos, dir, 16.0, false).expect("the side rays are not boxed in");
        clear_cells(&mut w, &wall);
        let dev = wrap_angle(out.heading() - dir.heading()).abs();
        assert!(
            dev >= 0.4,
            "a building across the lane should bend the heading (deviation {dev:.2} rad)"
        );
    }

    /// With a clear straight line and an obstacle off to one side, keep going straight: the
    /// deviation penalty must not make a hull weave away from open ground.
    #[test]
    fn avoidance_keeps_a_clear_straight_line() {
        let mut w = World::new(7, 0, [0, -1]);
        let pos = w.map.spawn[1];
        let gate = w.gate_pos(1).expect("team 1's base is recorded");
        let dir = (gate - pos).norm();
        // A building centred 14 m to the side of the lane: it blocks the near-side rays, not
        // the line itself.
        let wall = stamp_building(&mut w, pos + dir.perp() * 14.0, 4);
        let vi = w
            .vehicles
            .iter()
            .position(|v| v.team == 1 && v.kind == vkind::TANK)
            .expect("team 1's garrison tank");
        for oj in (0..w.vehicles.len()).rev() {
            if oj != vi && w.vehicles[oj].team == 1 && w.vehicles[oj].alive() {
                w.kill_vehicle(oj, -1);
            }
        }
        w.vehicles[vi].pos = pos;
        w.vehicles[vi].vel = Vec2::ZERO;
        let out = avoid_ahead(&w, 0, pos, dir, 16.0, false).expect("not boxed in");
        clear_cells(&mut w, &wall);
        let dev = wrap_angle(out.heading() - dir.heading()).abs();
        assert!(
            dev <= 0.25,
            "a building off to the side should not bend a clear line (deviation {dev:.2} rad)"
        );
    }

    /// The whole point of the weighted draw: with every kind parked and no jeep demanded, the
    /// commander must actually field helis and MLRS over time - the old fixed order never did.
    #[test]
    fn commander_mixes_helis_and_mlrs_into_the_field() {
        let mut rng = Rng::new(1);
        // All four slots parked (GARAGE order: JEEP, TANK, HRSV, HELI).
        let parked = [1.0, 1.0, 1.0, 1.0];
        let mut counts = [0usize; 4];
        for _ in 0..400 {
            let k = pick_commander_kind(&parked, false, &mut rng).expect("all parked");
            counts[vehicle::GARAGE.iter().position(|g| *g == k).unwrap()] += 1;
        }
        assert!(counts[2] > 0, "MLRS was never fielded in 400 draws: {counts:?}");
        assert!(counts[3] > 0, "heli was never fielded in 400 draws: {counts:?}");
        // Weights 3/2/2/1 over 8: tank should outdraw jeep comfortably.
        assert!(counts[1] > counts[0], "tank (w3) should outdraw jeep (w1): {counts:?}");
    }

    /// With no runner left in the field (`force_jeep`) a parked jeep wins outright, even
    /// against the draw; with a runner alive the same garage goes through the weighted draw.
    #[test]
    fn commander_keeps_a_capture_runner() {
        let mut rng = Rng::new(2);
        let parked = [1.0, 1.0, 1.0, 1.0];
        for _ in 0..60 {
            assert_eq!(pick_commander_kind(&parked, true, &mut rng), Some(vkind::JEEP));
        }
        // Not forced: a jeep is only one of the weighted options now.
        let mut saw_non_jeep = false;
        for _ in 0..60 {
            if pick_commander_kind(&parked, false, &mut rng) != Some(vkind::JEEP) {
                saw_non_jeep = true;
            }
        }
        assert!(saw_non_jeep, "unforced draw never left the jeep in 60 tries");
    }

    /// Nothing parked means nothing to field; a single parked kind is always the pick.
    #[test]
    fn commander_respects_an_empty_or_singleton_garage() {
        let mut rng = Rng::new(3);
        assert_eq!(pick_commander_kind(&[0.0; 4], true, &mut rng), None);
        assert_eq!(pick_commander_kind(&[0.0; 4], false, &mut rng), None);
        let only_mlrs = [0.0, 0.0, 1.0, 0.0]; // HRSV slot in GARAGE order
        for _ in 0..20 {
            assert_eq!(pick_commander_kind(&only_mlrs, true, &mut rng), Some(vkind::HRSV));
        }
    }
}
