//! Arcade vehicle physics: throttle/steering/slide, terrain following, water handling,
//! collisions with the world and with each other, plus weapon aiming and firing.

use crate::combat;
use crate::math::*;
use crate::spec::WeaponSpec;
use crate::types::*;
use crate::world::{Input, World};

/// The first non-finite kinematic event seen by [`step_vehicle`], kept on `World::nan_debug`
/// for the `Game::nan_debug` seam. It records where the hull was a tick earlier and what was
/// driven into it, so a poisoned simulation can be read off instead of guessed at.
#[derive(Clone, Copy, Debug)]
pub struct NanHit {
    pub id: u32,
    pub kind: u8,
    pub team: u8,
    pub player: u8,
    /// Position a tick earlier (before the offending integration, or before detection when
    /// the state was already poisoned on entry).
    pub px: f32,
    pub pz: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub fwd_speed: f32,
    pub yaw: f32,
    /// The input applied on the offending tick — non-finite here means the entry point is
    /// the input itself.
    pub steer_in: f32,
    pub throttle_in: f32,
    /// True when the state was already non-finite at the start of the tick: the entry point
    /// is outside `step_vehicle` (collision, spawn, or a previous tick's backstop).
    pub pre_poisoned: bool,
}

/// Keep a position on the indexed map, inside the same leash `World::update_bounds` allows.
///
/// Also the backstop for a non-finite position: the terrain lookup clamps its indices, so a
/// NaN coordinate is not recoverable from the map — it has to be caught here or it spreads
/// into every consumer of `pos` (y, aim, projectiles, camera).
pub fn clamp_to_playable(p: Vec2, world: f32, border: f32) -> Vec2 {
    if !p.x.is_finite() || !p.y.is_finite() {
        return v2(world * 0.5, world * 0.5);
    }
    v2(
        clamp(p.x, -border, world + border),
        clamp(p.y, -border, world + border),
    )
}


/// Pitch and roll (radians) of the plane through the four points where a rigid hull's own
/// footprint (`spec.length` x `spec.width`) touches the terrain.
///
/// Returned in `VehicleView`'s sign convention: positive pitch is nose-DOWN, positive roll
/// raises the hull's local +X end. `map.slope_at` is a central difference over a +/-1 cell
/// (4 m) baseline at the hull's *centre*, which is the tangent plane only on a planar patch:
/// over a crest or a dip the four corners the hull actually rests on genuinely differ from it,
/// which is the reported "does not follow the terrain geometry". Four bilinear samples
/// (`map.height_at` is a 257x257 lookup) is the whole per-tick budget for this - no
/// allocations.
pub fn hull_attitude(map: &MapData, pos: Vec2, yaw: f32, length: f32, width: f32) -> (f32, f32) {
    let fwd = v2(yaw.sin(), yaw.cos());
    // `fwd.perp()` is the NEGATED local +X axis (see `VehicleView::roll`), so the renderer's
    // local +X - the direction `rotateZ(+roll)` raises - is `(fwd.y, -fwd.x)`.
    let right = v2(fwd.y, -fwd.x);
    let (half_l, half_w) = (length * 0.5, width * 0.5);
    let h = |f: f32, r: f32| {
        map.height_at(
            pos.x + fwd.x * f + right.x * r,
            pos.y + fwd.y * f + right.y * r,
        )
    };
    let (fr, fl) = (h(half_l, half_w), h(half_l, -half_w));
    let (rr, rl) = (h(-half_l, half_w), h(-half_l, -half_w));
    // Rise per metre along +forward and along local +X, from the mean of each pair of corners.
    let pitch_g = ((fr + fl) - (rr + rl)) * 0.5 / length;
    let roll_g = ((fr + rr) - (fl + rl)) * 0.5 / width;
    // Ground rising forward means nose-UP (negative pitch); rising towards +X means the +X end
    // is raised (positive roll).
    (-pitch_g.atan(), roll_g.atan())
}

pub fn drive_vehicles(w: &mut World, dt: f32, inputs: &[Input; 2]) {
    let n = w.vehicles.len();
    for vi in 0..n {
        if !w.vehicles[vi].alive() {
            continue;
        }
        // A CPU-driven slot (demo/attract mode) is steered by the AI brain,
        // not by a human input frame — otherwise the hull would sit on its pad taking whatever
        // the (absent) driver pressed.
        let inp = if w.vehicles[vi].player > 0 && !w.vehicle_cpu_driven(vi) {
            inputs[(w.vehicles[vi].player - 1) as usize]
        } else {
            w.vehicles[vi].ai_input
        };
        step_vehicle(w, vi, dt, inp);
    }
}

fn step_vehicle(w: &mut World, vi: usize, dt: f32, mut inp: Input) {
    let spec = *w.vehicles[vi].spec();
    let kind = w.vehicles[vi].kind;

    // The raw input, for the nan_debug seam: if a NaN ever arrives here we want to see it,
    // not the sanitised replacement.
    let (raw_steer, raw_throttle) = (inp.steer, inp.throttle);

    // A non-finite input must never reach the integration: a NaN steer latches into yaw and
    // then into vel forever (lerp with a NaN target is NaN), and `clamp` cannot catch it,
    // because comparisons against NaN fall through to the value itself. The poison arrives
    // here from an upstream bearing that lost its target, or from a bad key state; either
    // way the hull drives on as if the control were centred.
    if !inp.steer.is_finite() {
        inp.steer = 0.0;
    }
    if !inp.throttle.is_finite() {
        inp.throttle = 0.0;
    }
    if !inp.aim.is_finite() {
        inp.has_aim = false;
    }
    if !inp.aim_pitch.is_finite() {
        inp.aim_pitch = 0.0;
    }

    // Pre-tick snapshot for the nan_debug seam; taken only while no hit is recorded yet so
    // the steady state pays nothing.
    let pre = if w.nan_debug.is_none() {
        let v = &w.vehicles[vi];
        Some((v.pos, v.y, v.vel, v.fwd_speed, v.yaw))
    } else {
        None
    };

    // ---- timers -----------------------------------------------------------------
    {
        let v = &mut w.vehicles[vi];
        v.reload0 = (v.reload0 - dt).max(0.0);
        v.reload1 = (v.reload1 - dt).max(0.0);
        if v.burst_t > 0.0 {
            v.burst_t -= dt;
        }
        if v.hit_flash > 0.0 {
            v.hit_flash = (v.hit_flash - dt * 4.0).max(0.0);
        }
    }

    // ---- fuel -------------------------------------------------------------------
    let mut throttle = clamp(inp.throttle, -1.0, 1.0);
    // A dry tank is a dry tank, airborne or not: the engine stops, the rotor loses its RPM and
    // the aircraft comes down. Flying hulls used to be exempt here, which is why a helicopter
    // with an empty tank flew on at 45 m/s forever ("they don't crash when fuel hits 0").
    let out_of_fuel = w.vehicles[vi].fuel <= 0.0;
    if out_of_fuel {
        throttle = 0.0;
    }
    if spec.fuel_time < 900.0 {
        let burn = (0.35 + throttle.abs() * 0.65).max(if spec.flying { 0.45 } else { spec.idle_burn });
        let used = (dt / spec.fuel_time) * 100.0 * burn;
        w.vehicles[vi].fuel = (w.vehicles[vi].fuel - used).max(0.0);
        // One-shot: without the flag check this fired on every tick and produced hundreds of
        // infantry per second.
        let already_bailed = w.vehicles[vi].flags & vflag::DRIVER_BAILED != 0;
        if w.vehicles[vi].fuel <= 0.0 && !already_bailed {
            w.vehicles[vi].flags |= vflag::DRIVER_BAILED;
            let p = w.vehicles[vi].pos;
            let team = w.vehicles[vi].team;
            w.notify(notify::LOW_FUEL, team);
            if spec.flying {
                // A helicopter out of fuel is not a glider: it goes down and burns. This reuses
                // the wreck path that already exists for a shot-down flyer - the fall, the
                // tumble, the impact blast and the cull are the same code, and
                // `downed_helicopter_falls_and_explodes_on_impact` covers them.
                w.sound(sfx::EXPLOSION_SMALL, p, 1.0, 0.7);
                w.kill_vehicle(vi, -1);
            } else {
                w.sound(sfx::BAIL_OUT, p, 1.0, 0.8);
                // The driver bails out and runs, exactly like the original.
                crate::ai::spawn_troops_from(w, p, team, 1);
            }
        }
    }

    if spec.flying {
        step_air(w, vi, dt, throttle, inp);
    } else {
        step_ground(w, vi, dt, throttle, inp);
    }

    // ---- surface following ------------------------------------------------------
    let (pos, was_y) = (w.vehicles[vi].pos, w.vehicles[vi].y);
    let ground = w.ground_height(pos);
    if spec.flying {
        let target = ground + w.vehicles[vi].alt;
        w.vehicles[vi].y = lerp(was_y, target, (dt * 6.0).min(1.0));
        let slope = w.map.slope_at(pos.x, pos.y);
        let fwd = v2(w.vehicles[vi].yaw.sin(), w.vehicles[vi].yaw.cos());
        let target_pitch = -slope.dot(fwd) * 0.6;
        // Roll is the hull's rotation about its own +X axis (`fwd.perp()` = (-cos yaw,
        // sin yaw) is the NEGATED local +X axis: for yaw = 0 the renderer's local +X is world
        // +X, while `perp` points at -X). `rotateZ(+roll)` raises the local +X end, so a hull
        // lying on terrain that rises towards `perp` needs a NEGATIVE roll. Measured against
        // the terrain normal the renderer draws (normal = normalize(-dh/dx, 1, -dh/dz)) with
        // the real three.js chain R_y(yaw) R_x(pitch) R_z(roll), the hull's up vector was
        // 39.8 deg off the ground it sat on with the old sign and 2.9 deg with this one.
        let target_roll = -slope.dot(fwd.perp()) * 0.6;
        w.vehicles[vi].pitch = lerp(w.vehicles[vi].pitch, target_pitch, (dt * 3.0).min(1.0));
        w.vehicles[vi].roll = lerp(w.vehicles[vi].roll, target_roll, (dt * 3.0).min(1.0));
    } else {
        // Snap when the hull has been moved a long way (respawn, teleport, being shoved off
        // a ledge); otherwise ease onto the surface so bumps do not jolt the camera.
        let y = if (was_y - ground).abs() > 2.5 {
            ground
        } else {
            lerp(was_y, ground, (dt * 12.0).min(1.0))
        };
        w.vehicles[vi].y = y;
        // The attitude is the plane the hull's own contact points lie in, not `map.slope_at`'s
        // centre gradient scaled by the old 0.9 fudge - 10 % under-tilt on every slope, and
        // measured at the wrong baseline over a crest or a dip. On a bridge deck (or floating
        // on shallow water) the drivable surface is flat even when the sea bed under it is
        // not, so level the hull there.
        let terrain = w.map.height_at(pos.x, pos.y);
        let (target_pitch, target_roll) = if ground > terrain + 0.05 {
            (0.0, 0.0)
        } else {
            hull_attitude(&w.map, pos, w.vehicles[vi].yaw, spec.length, spec.width)
        };
        // `(dt * 6.0)` left the hull 9.4 deg (pitch) / 4.5 deg (roll) behind a target that
        // swings as it traverses a slope, because the target moves every tick; 20/s is a
        // ~0.05 s time constant, a small fraction of that lag, while still easing over a
        // single bump rather than snapping.
        let rate = (dt * 20.0).min(1.0);
        w.vehicles[vi].pitch = lerp(w.vehicles[vi].pitch, target_pitch, rate);
        w.vehicles[vi].roll = lerp(w.vehicles[vi].roll, target_roll, rate);
    }

    // ---- water behaviour --------------------------------------------------------
    let in_water = w.in_water(pos);
    if in_water && !spec.flying {
        let depth = w.map.water_level - w.map.height_at(pos.x, pos.y);
        if !spec.amphibious && depth > 0.02 {
            // Blocked by the sea. Probe around for dry land and shove the hull onto it: a
            // tank must never end up floating at sea level with the shore above it.
            // Aim at the *nearest* ring that holds any dry probe, then the highest point in
            // that ring. Picking the overall highest within 8 m walked a hull back over its
            // own shoulder: on map 1 seed 7 a tank driving south along a lane whose edge ran
            // into a centimetre-deep shoreline seam found the highest dry point to be the
            // ridge it had just come down (5.5 m behind), while a dry shelf stood 2 m ahead —
            // every shove undid its progress and it pinned in place for the rest of the run.
            let mut ring: Option<f32> = None;
            for r in [2.0f32, 3.5, 5.5, 8.0] {
                let mut any = false;
                for i in 0..12u32 {
                    let a = i as f32 / 12.0 * core::f32::consts::TAU;
                    let probe = pos + v2(a.cos(), a.sin()) * r;
                    let h = w.map.height_at(probe.x, probe.y);
                    if h > w.map.water_level + 0.12 && h < 12.0 {
                        any = true;
                        break;
                    }
                }
                if any {
                    ring = Some(r);
                    break;
                }
            }
            let mut best: Option<Vec2> = None;
            let mut best_h = w.map.water_level + 0.12;
            if let Some(r) = ring {
                for i in 0..12u32 {
                    let a = i as f32 / 12.0 * core::f32::consts::TAU;
                    let probe = pos + v2(a.cos(), a.sin()) * r;
                    let h = w.map.height_at(probe.x, probe.y);
                    if h > best_h && h < 12.0 {
                        best_h = h;
                        best = Some(probe);
                    }
                }
            }
            let escape = match best {
                Some(p) => (p - pos).norm() * 0.9,
                None => -v2(w.vehicles[vi].yaw.sin(), w.vehicles[vi].yaw.cos()) * 0.6,
            };
            // Bound the shove. This runs every tick for as long as the hull is in the water,
            // and with no dry land within probe range the escape vector just walks the vehicle
            // in a straight line — off the heightfield, where the terrain lookup has nothing
            // to interpolate and the hull's y becomes NaN, which then spreads into positions,
            // projectiles and the renderer. Clamp to the same leash `update_bounds` uses for
            // the submarine.
            w.vehicles[vi].pos = clamp_to_playable(pos + escape, w.map.world_size, w.tuning.rules.border);
            w.vehicles[vi].fwd_speed *= 0.2;
            w.vehicles[vi].vel = w.vehicles[vi].vel * 0.2;
        } else if spec.amphibious && w.rng.chance(0.35) {
            let p = w.vehicles[vi].pos;
            w.push_event(ekind::WATER_SPLASH, p, w.map.water_level + 0.15, 0.0, 0.7, 0.0, 0.0, 0.0);
        }
    }

    // ---- animation --------------------------------------------------------------
    {
        let v = &mut w.vehicles[vi];
        let spin = v.fwd_speed * dt;
        v.anim = (v.anim + spin * 0.9) % 1000.0;
        if kind == vkind::HELI || kind == vkind::DRONE {
            v.anim += dt * 14.0;
        }
        let target_load = (inp.throttle.abs() * 0.8 + 0.2).clamp(0.15, 1.0);
        v.engine_load = lerp(v.engine_load, target_load, (dt * 2.5).min(1.0));
        if v.hp < v.spec().hp * 0.4 && w.rng.chance(dt * 6.0) {
            let p = v.pos;
            let y = v.center_y();
            w.push_event(ekind::SMOKE_PUFF, p, y, 0.0, 1.0, 0.0, 0.0, 0.0);
        }
    }

    // ---- aim + fire -------------------------------------------------------------
    update_aim(w, vi, dt, &inp);
    handle_weapons(w, vi, &inp, out_of_fuel);

    // nan_debug seam: record the first tick on which any kinematic went non-finite.
    if w.nan_debug.is_none() {
        let v = &w.vehicles[vi];
        let bad = !v.pos.x.is_finite()
            || !v.pos.y.is_finite()
            || !v.y.is_finite()
            || !v.vel.x.is_finite()
            || !v.vel.y.is_finite()
            || !v.fwd_speed.is_finite()
            || !v.yaw.is_finite();
        if bad {
            let (p0, y0, vel0, spd0, yaw0) = pre.expect("snapshot taken above");
            w.nan_debug = Some(NanHit {
                id: v.id,
                kind: v.kind,
                team: v.team,
                player: v.player,
                px: p0.x,
                pz: p0.y,
                y: y0,
                vx: vel0.x,
                vy: vel0.y,
                fwd_speed: spd0,
                yaw: yaw0,
                steer_in: raw_steer,
                throttle_in: raw_throttle,
                pre_poisoned: !p0.x.is_finite()
                    || !p0.y.is_finite()
                    || !y0.is_finite()
                    || !vel0.x.is_finite()
                    || !vel0.y.is_finite()
                    || !spd0.is_finite()
                    || !yaw0.is_finite(),
            });
        }
    }
}

fn step_ground(w: &mut World, vi: usize, dt: f32, throttle: f32, inp: Input) {
    let spec = *w.vehicles[vi].spec();
    let pos0 = w.vehicles[vi].pos;
    let slope = w.map.slope_at(pos0.x, pos0.y);
    let in_water = w.in_water(pos0);

    let (dust, fwd, moving) = {
        let v = &mut w.vehicles[vi];
        let speed_frac = (v.fwd_speed.abs() / spec.speed).clamp(0.0, 1.0);
        let turn = lerp(spec.turn_lo, spec.turn_hi, speed_frac);
        // Wheeled vehicles must be rolling to steer; tracked ones can pivot in place.
        let authority = if v.kind == vkind::TANK || v.kind == vkind::HRSV {
            0.85 + 0.15 * speed_frac
        } else if v.kind == vkind::TROOP {
            1.0
        } else {
            // Wheeled vehicles steer less when crawling, but not so little that they cannot
            // manoeuvre out of a tight spot: 0.18 made a stopped jeep practically unable to
            // turn around, which deadlocked the AI at its own spawn.
            (0.5 + smoothstep(0.0, 4.0, v.fwd_speed.abs()) * 0.6).min(1.0)
        };
        let dir = if v.fwd_speed < -0.3 { -1.0 } else { 1.0 };
        let brake_boost = if inp.brake { 1.55 } else { 1.0 };
        v.yaw = wrap_angle(v.yaw + inp.steer * turn * authority * brake_boost * dir * dt);

        // Longitudinal forces.
        let mut accel = 0.0;
        if throttle > 0.0 {
            let head = 1.0 - (v.fwd_speed / spec.speed).clamp(0.0, 1.0);
            accel = throttle * spec.accel * (0.35 + 0.65 * head);
        } else if throttle < 0.0 {
            let head = 1.0 - (v.fwd_speed / -spec.reverse).clamp(0.0, 1.0);
            accel = throttle * spec.accel * 0.75 * (0.35 + 0.65 * head);
        }
        let drag = if inp.brake && v.fwd_speed.abs() > 0.2 {
            spec.brake
        } else {
            1.6 + v.fwd_speed.abs() * 0.06
        };
        v.fwd_speed += (accel - v.fwd_speed.signum() * drag) * dt;
        if v.fwd_speed.abs() < 0.05 && throttle.abs() < 0.05 {
            v.fwd_speed = 0.0;
        }
        // Slope resistance: climbing costs speed, descending adds it. Only while the driver
        // is actually driving - otherwise a parked vehicle creeps downhill on its own.
        let fwd = v2(v.yaw.sin(), v.yaw.cos());
        let driving = throttle.abs() > 0.05 || inp.brake;
        if driving || v.fwd_speed.abs() > 1.5 {
            // Capped against what the engine can actually pull, so a hill can slow a hull but
            // never park it: the nav grid has already decided this ground is drivable, and the
            // AI routes on the nav, not on the gradient. Uncapped, the heaviest hull could not
            // climb ordinary terrain at all - an AI MLRS (accel 4.0 against a flat 7.0 cost per
            // unit of slope) stalled on anything steeper than ~0.34 and covered 50 m in a 240 s
            // match, a quarter of its ticks at a standstill and its throttle at 1.00.
            //
            // The cap is *per gear*, because the guarantee has to hold in the gear the hull is
            // actually in. Reverse drives at 75 % of the forward force against the same rolling
            // drag, so a flat 60 % of `spec.accel` leaves a tank's reverse net negative on a
            // 0.97 grade: with full reverse commanded it sat at 0.00 m/s for the whole run, and
            // reverse is exactly the gear a hull on a scarp needs (turn around, back out of a
            // pocket). Measured with `examples/slopeprobe`: reversing straight up that grade
            // moved a tank 0.2 m in 6 s before this, 14.4 m after; forward (22.1 m) is
            // untouched.
            //
            // It is also clamped to the same magnitude in *both* directions, not just against
            // the climb. The old `min` only ever limited the penalty, so gravity's downhill
            // assist stayed at the full `grade * 7.0`: on that same 0.97 grade it pushed with
            // 6.79 m/s^2 - more than a tank's whole reverse drive - and no cap on the climb
            // side can make headway against that. Same rule either way: the terrain may push a
            // hull by at most what it may hold it back by. Grades gentler than 0.6 are
            // unaffected in both directions (0.6 * 7.0 is the forward cap); steeper ones now
            // give a smaller free push downhill as well as a smaller hold on the way up.
            let pull = if throttle < 0.0 { spec.accel * 0.75 } else { spec.accel };
            let ceiling = if throttle < 0.0 {
                (pull - drag).max(0.0) * 0.6
            } else {
                spec.accel * 0.6
            };
            let resistance = (slope.dot(fwd) * 7.0).clamp(-ceiling, ceiling);
            v.fwd_speed -= resistance * dt;
        } else {
            // Static friction: hold a parked vehicle still on a slope.
            v.fwd_speed *= 1.0 - (7.0 * dt).min(1.0);
            if v.fwd_speed.abs() < 0.2 {
                v.fwd_speed = 0.0;
            }
        }

        let top = if in_water && spec.amphibious {
            spec.speed * 0.42
        } else {
            spec.speed
        };
        v.fwd_speed = clamp(v.fwd_speed, -spec.reverse, top);

        let grip = match v.kind {
            vkind::TANK | vkind::HRSV => 9.0,
            vkind::TROOP => 12.0,
            _ => 5.5,
        };
        let desired = fwd * v.fwd_speed;
        v.vel = v.vel.lerp(desired, (1.0 - (-grip * dt).exp()).clamp(0.0, 1.0));
        v.pos += v.vel * dt;
        let speed = v.fwd_speed.abs();
        (
            v.kind != vkind::TROOP && !in_water && speed > 6.0,
            fwd,
            v.vel.len(),
        )
    };
    let _ = moving;

    // Dust plume behind the wheels.
    if dust && w.rng.chance(dt * 9.0) {
        let p = w.vehicles[vi].pos - fwd * 2.0;
        let y = w.map.height_at(p.x, p.y);
        w.push_event(ekind::DUST, p, y + 0.2, 0.0, 0.8, 0.0, 0.0, 0.0);
    }
}

fn step_air(w: &mut World, vi: usize, dt: f32, throttle: f32, inp: Input) {
    let spec = *w.vehicles[vi].spec();
    let wash = {
        let v = &mut w.vehicles[vi];
        // Yaw (tail rotor / pedals).
        let turn = lerp(
            spec.turn_lo,
            spec.turn_hi,
            (v.fwd_speed.abs() / spec.speed).clamp(0.0, 1.0),
        );
        v.yaw = wrap_angle(v.yaw + inp.steer * turn * dt);

        let fwd = v2(v.yaw.sin(), v.yaw.cos());
        let side = fwd.perp();
        // Forward thrust plus lateral strafe (helicopters can strafe without turning).
        // `brake` is collective-down in the air (altitude only, below) and must not push the
        // hull horizontally: as `-fwd * spec.brake` it made holding Shift drift the aircraft
        // backwards while it descended - lowering a helicopter's collective does not pull it
        // astern. Reverse flight is what S (negative throttle) is for.
        let mut a = fwd * (throttle * spec.accel);
        a += side * (inp.strafe.clamp(-1.0, 1.0) * spec.accel * 0.8);
        v.vel += a * dt;
        // Drag, sized so the terminal speed is exactly `spec.speed` (see `spec.rs`).
        //
        // This used to be `1 + 0.02 * |v|`, a factor that grows with speed and is applied
        // every second: thrust then balances drag at `v(1 + 0.02v) = accel`, which for the
        // helicopter's old 11 m/s^2 settled at 9.28 m/s - the aircraft was the SLOWEST
        // vehicle in the game and `clamp_len(spec.speed)` never bound. Under power, drag is
        // `accel * v / speed^2` so `accel = v * drag` holds only at `v = spec.speed`; the
        // converse of that is a thrust falloff, so the hull eases into the top end instead
        // of hitting a wall. With the collective released the thrust term vanishes and the
        // quadratic drag would leave a drone coasting forever, so an idle hull keeps the old
        // linear bleed - which is also what makes releasing `reverse` feel like a brake.
        let top = spec.speed.max(1.0);
        let drag = if throttle.abs() > 0.01 {
            spec.accel * v.fwd_speed.abs() / (top * top)
        } else {
            1.0 + v.fwd_speed.abs() * 0.02
        };
        v.vel = v.vel * (1.0 - (drag * dt).min(0.5));
        v.vel = v.vel.clamp_len(spec.speed);
        v.pos += v.vel * dt;
        // Flyers are clamped to the theatre (with a margin) so drones cannot wander off the
        // map and never come back.
        let margin = 24.0;
        let world = w.map.world_size;
        if v.pos.x < -margin || v.pos.y < -margin || v.pos.x > world + margin || v.pos.y > world + margin {
            v.pos.x = v.pos.x.clamp(-margin, world + margin);
            v.pos.y = v.pos.y.clamp(-margin, world + margin);
            let inward = (v2(world * 0.5, world * 0.5) - v.pos).norm();
            v.vel = inward * v.vel.len().min(spec.speed * 0.6);
        }
        v.fwd_speed = v.vel.dot(fwd);

        // Altitude: ascend/descend or settle back to the cruising height.
        let want_alt = if inp.ascend {
            spec.cruise_alt * 1.7
        } else if inp.brake {
            (spec.cruise_alt * 0.28).max(2.5)
        } else {
            spec.cruise_alt
        };
        let da = clamp(want_alt - v.alt, -spec.climb_rate * dt, spec.climb_rate * dt);
        v.alt = (v.alt + da).max(1.2);
        v.airborne = v.alt > 2.0;
        v.alt < 5.0
    };

    // Rotor wash kicks up spray or dust when hovering low.
    if wash && w.rng.chance(dt * 12.0) {
        let p = w.vehicles[vi].pos;
        let ground = w.ground_height(p);
        if ground <= w.map.water_level {
            w.push_event(ekind::WATER_SPLASH, p, w.map.water_level + 0.1, 0.0, 0.9, 0.0, 0.0, 0.0);
        } else {
            w.push_event(ekind::DUST, p, ground + 0.2, 0.0, 0.9, 0.0, 0.0, 0.0);
        }
    }
}

/// The two elevations (radians, positive up, flat first) that land a round of muzzle speed
/// `speed` under constant `gravity` on a point `range` metres away and `dy` metres above the
/// muzzle. `None` when the point is past the round's reach.
fn ballistic_solutions(speed: f32, gravity: f32, range: f32, dy: f32) -> Option<(f32, f32)> {
    if !(speed > 0.0) || !(gravity > 0.0) || range < 0.5 {
        return None;
    }
    let v2 = speed * speed;
    let a = gravity * range * range / (2.0 * v2);
    let disc = range * range - 4.0 * a * (dy + a);
    if disc <= 0.0 {
        return None;
    }
    let s = disc.sqrt();
    Some((
        ((range - s) / (2.0 * a)).atan(),
        ((range + s) / (2.0 * a)).atan(),
    ))
}

/// The flat of the two ballistic solutions, which is the one a direct-fire gun is laid on.
fn ballistic_pitch(speed: f32, gravity: f32, range: f32, dy: f32) -> Option<f32> {
    ballistic_solutions(speed, gravity, range, dy).map(|(flat, _)| flat)
}

/// Highest loft a lobbed weapon will take (radians, ~75 deg).
///
/// The high solution gets steeper as the range falls, and past this the round is nearly
/// vertical. That is not free: the lofted round loiters in the air several times as long as the
/// flat one, and a weapon with any angular dispersion scatters laterally in proportion to that
/// time. Measured on the aim table (`lobbed_rounds_land_on_the_crosshair_on_flat_ground`) an
/// MLRS rocket's 0.02 rad spread costs 0.05 m of lateral error on the flat 0.2 s arc at 15 m
/// and 1.5 m on the 5.2 s lofted one — against a 5.5 m splash that is still a hit, but it is a
/// measurable regression in the crosshair promise for no gain, because a 15 m lob clears
/// nothing a flat one would not. Below this elevation the flat solution is used, exactly as
/// before. The cut falls between a jeep grenade at 30 m (73.5 deg, lofted) and an MLRS rocket
/// at 100 m (75.2 deg, flat), so the jeep — the weapon the complaint is about — lofts over its
/// whole fighting range and the MLRS only where the loft is short enough to pay for itself.
const LOB_MAX_ELEVATION: f32 = 1.31;

/// The lofted solution if it is worth taking, else the flat one.
fn ballistic_pitch_lobbed(speed: f32, gravity: f32, range: f32, dy: f32) -> Option<f32> {
    ballistic_solutions(speed, gravity, range, dy)
        .map(|(flat, high)| if high <= LOB_MAX_ELEVATION { high } else { flat })
}

/// Where a sight line from `origin` along (`yaw`, `pitch`) first meets the ground.
///
/// `None` when the line flies over the terrain for the whole of `reach` — the shooter is aiming
/// at the sky. The ground test is the one `combat::update_projectiles` lands rounds with, so
/// the point this returns is the point a straight shot would actually arrive at.
fn sight_line_ground(w: &World, origin: Vec3, yaw: f32, pitch: f32, reach: f32) -> Option<Vec3> {
    let dir = v3(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    let surface = |x: f32, z: f32| w.map.height_at(x, z).max(w.map.water_level);
    // The step has to be at least as fine as the projectile's own 1/60 s of travel, because a
    // line that only *grazes* a ridge leaves a crossing window far shorter than a coarse step:
    // marching the MLRS rocket's line every 14.6 m stepped straight over a touch at 57 m and
    // found water at 110 m instead, so the rocket was launched for 110 m and splashed 55 m past
    // the crosshair — the "it flies out of screen" complaint, reproduced.
    let step = (reach / 256.0).max(1.0);
    let steps = (reach / step).ceil().max(1.0);
    let mut above = origin.y - surface(origin.x, origin.z);
    let mut lo = 0.0f32;
    for i in 1..=(steps as u32) {
        let hi = step * i as f32;
        let p = origin + dir * hi;
        let d = p.y - surface(p.x, p.z);
        if above > 0.0 && d <= 0.0 {
            // Bisect the bracketing segment: a step of a few metres would otherwise put the aim
            // point — and so the landing point — that far out.
            let (mut a, mut b) = (lo, hi);
            for _ in 0..8 {
                let mid = (a + b) * 0.5;
                let q = origin + dir * mid;
                if q.y > surface(q.x, q.z) {
                    a = mid;
                } else {
                    b = mid;
                }
            }
            return Some(origin + dir * b);
        }
        above = d;
        lo = hi;
    }
    None
}

/// Upper bound on the extra angular cone an aim may be off an aircraft by and still be taken as
/// laid on it (radians). Roughly a full crossing lead at the slowest direct-fire weapon.
const AIR_AIM_LAG_MAX: f32 = 0.15;

/// The airborne enemy a shooter's sight line is laid on, predicted to where it will be when the
/// round arrives: `Some((position, time of flight))`.
///
/// Every solution used to resolve the aim to a point ON THE TERRAIN — `sight_line_ground` under
/// the crosshair — so a shot taken at an aircraft was solved to the ground below or behind it
/// and passed under the airframe; aiming above the horizon did not meet the ground at all and
/// left the gun on the raw sight elevation, with no arc solve and no lead. Air is now its own
/// branch: a shooter whose sight line (bearing *and* elevation — `main.ts` tests the cursor ray
/// against aircraft cylinders, `ai.rs` aims at `center_y()`) passes within a small angular cone
/// of an airborne enemy solves to that enemy's predicted position, on the real 3D range and
/// height difference.
///
/// The prediction is iterated twice — flight time to the predicted point, then the target
/// advanced by `vel * tof` — and the same solve drives the traverse lead in `update_aim`, so
/// bearing and elevation agree. Only aircraft are considered (`airborne` + `flying`), and only
/// against direct fire: a lobbed round's traverse follows the sight line and its arc is solved
/// at the moment of firing, so a led solution here would launch it on the wrong bearing.
fn aim_air_target(
    w: &World,
    vi: usize,
    yaw: f32,
    pitch: f32,
    weapon: &WeaponSpec,
) -> Option<(Vec3, f32)> {
    if weapon.lobbed || !(weapon.speed > 0.0) {
        return None;
    }
    let v = &w.vehicles[vi];
    // The sight line exactly as the callers build it, from the muzzle-height eye (see
    // `aim_target`).
    let eye = v3(v.pos.x, v.center_y() + weapon.muzzle_up, v.pos.y);
    let sight = v3(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    let reach = (weapon.speed * weapon.life).clamp(4.0, 400.0);
    let speed = weapon.speed.max(1.0);
    let mut best: Option<(f32, Vec3, f32)> = None;
    for t in w.vehicles.iter() {
        if !t.alive() || t.id == v.id || t.team == v.team {
            continue;
        }
        let spec = t.spec();
        if !t.airborne || !spec.flying {
            continue;
        }
        let tp = v3(t.pos.x, t.center_y(), t.pos.y);
        let rel = tp - eye;
        let d3 = rel.len();
        if d3 < 0.5 || d3 > reach {
            continue;
        }
        let inv = 1.0 / d3;
        let dot = sight.x * rel.x * inv + sight.y * rel.y * inv + sight.z * rel.z * inv;
        if dot <= 0.0 {
            continue;
        }
        let angle = dot.clamp(-1.0, 1.0).acos();
        // The cone: the airframe's own angular radius, plus how far the shooter's own aim can
        // lag a full intercept. `update_aim` leads the traverse by the whole flight time, the AI
        // leads by `LEAD` (55 %) and adds its skill error, and the input frame itself is up to a
        // tick old — so a shooter already pointing at the aircraft still lands inside this.
        let frame = (spec.radius + 1.0) * inv;
        let lag = (0.6 * t.vel.len() / speed).min(AIR_AIM_LAG_MAX);
        if angle > frame.max(0.04) + lag {
            continue;
        }
        // Lead: two passes. The eye stands in for the muzzle here — this is only a flight time.
        let mut pred = tp;
        let mut tof = d3 / speed;
        for _ in 0..2 {
            tof = (pred - eye).len().max(0.5) / speed;
            pred = v3(t.pos.x + t.vel.x * tof, tp.y, t.pos.y + t.vel.y * tof);
        }
        if best.map_or(true, |(b, _, _)| angle < b) {
            best = Some((angle, pred, tof));
        }
    }
    best.map(|(_, pred, tof)| (pred, tof))
}

/// The target a shooter is pointing at, as `(range, height above the muzzle)` measured from the
/// round's real muzzle.
///
/// Both callers of this — the player's `main.ts` and the AI in `ai.rs` — describe their aim as
/// an elevation to a target at a horizontal distance from the *hull centre*, taken from the
/// *muzzle's* height. The muzzle itself stands `muzzle_fwd` metres up the bearing (3.55 m on the
/// tank, 1.14 m on the jeep), so the sight line has to be marched from the hull's own position
/// at the muzzle's height and the firing solution then taken from where the round really
/// leaves. Solving the other way put every shot `muzzle_fwd` metres long: 3.5 m for a tank at
/// any range, 20 % of a 15 m lob.
///
/// An aircraft is checked first: it is not on the terrain, so the ground march cannot represent
/// it (and a sight line laid *up* at one does not meet the ground at all, which used to leave
/// the shot on the raw sight elevation with no gravity compensation and no lead).
fn aim_target(w: &World, vi: usize, yaw: f32, pitch: f32, weapon: &WeaponSpec) -> Option<(f32, f32)> {
    let v = &w.vehicles[vi];
    // The round leaves from the real muzzle, which stands `muzzle_fwd` metres up the bearing and
    // swings with the elevation: solve from where it really leaves.
    let muzzle = combat::muzzle_pos(v, weapon, yaw, pitch);
    if let Some((pred, _tof)) = aim_air_target(w, vi, yaw, pitch, weapon) {
        return Some((
            v2(pred.x - muzzle.x, pred.z - muzzle.z).len().max(0.5),
            pred.y - muzzle.y,
        ));
    }
    // The sight line exactly as the callers build it: from the hull's own position, at the
    // resting muzzle height, to a target `pitch` radians above the horizontal at the distance
    // they measured from the hull centre (`main.ts`'s `muzzleY`, `ai.rs`'s `center_y() +
    // muzzle_up`).
    let eye = v3(v.pos.x, v.center_y() + weapon.muzzle_up, v.pos.y);
    let reach = (weapon.speed * weapon.life).clamp(4.0, 400.0);
    let hit = sight_line_ground(w, eye, yaw, pitch, reach)?;
    Some((
        v2(hit.x - muzzle.x, hit.z - muzzle.z).len().max(0.5),
        hit.y - muzzle.y,
    ))
}

/// The elevation a direct-fire gun has to be laid at so its round lands on the point the
/// shooter's sight line meets.
///
/// A shell drops on the way (`WeaponSpec::gravity`), so a gun pointed straight at a target
/// hits short of it: the tank's 120 mm falls 1.4 m under a 100 m shot, which is a clean miss on
/// anything small. The caller only has a sight line — the aim the player's crosshair or the
/// AI's target produces — so recover the range by marching that line to the ground and solve
/// the arc for it. Lobbed weapons are excluded: their arc has to be solved from the muzzle at
/// the moment of firing, because `gun_pitch` doubles as the AI's alignment reference (see
/// `lobbed_launch`).
fn aimed_launch_pitch(w: &World, vi: usize, inp: &Input, weapon: &WeaponSpec) -> Option<f32> {
    let (range, dy) = aim_target(w, vi, inp.aim, inp.aim_pitch, weapon)?;
    ballistic_pitch(weapon.speed, weapon.gravity, range, dy)
}

/// Launch direction for a lobbed round (today only the jeep's thrown grenade — the MLRS round
/// became a heat-seeker), solved so the arc lands on the point its sight line is aimed at.
///
/// These used to leave on a fixed ~42.5 deg loft — `v3(x * 0.85, 0.78, z * 0.85)` — which threw
/// the sight elevation away and made the range a constant: a jeep grenade always burst about
/// 52 m from the muzzle and an MLRS rocket always about 200 m, whichever way the player aimed
/// (measured in the browser: a jeep whose crosshair was 15 m away landed its grenade 56 m away
/// on its own hull bearing, a 46 m miss). Marching the sight line to the ground recovers the
/// player's aim point and the AI's — both arrive here through `update_aim` — and the ballistic
/// solve then drops the round on it.
///
/// `gun_pitch` is deliberately left alone by the caller: it is the sight line the player sees
/// and the AI checks its elevation alignment against (ai.rs), not the launch angle.
///
/// The lofted (HIGH) ballistic solution is used, not the flat one, whenever it stays under
/// `LOB_MAX_ELEVATION`: the flat arc leaves the muzzle almost level at short range (12.2 deg for
/// a jeep grenade at 30 m, 24.6 deg at 45 m — see `lobbed_rounds_land_on_the_crosshair_on_flat_ground`)
/// and skims the ground, so it bursts on the first bump, ridge or piece of cover in front — the
/// reported "it hits the ground too often". Both solutions land on the same point by
/// construction; the high one merely gets there over the top. Where the high solution is
/// near-vertical it is not worth its long loiter (see `LOB_MAX_ELEVATION`) and the flat one is
/// used, as before.
///
/// Falls back to the old maximum-range loft when the line never meets the ground (aiming at the
/// sky) or the target is past the round's reach.
fn lobbed_launch(w: &World, vi: usize, yaw: f32, pitch: f32, weapon: &WeaponSpec) -> Vec3 {
    if let Some((range, dy)) = aim_target(w, vi, yaw, pitch, weapon) {
        if let Some(theta) = ballistic_pitch_lobbed(weapon.speed, weapon.gravity, range, dy) {
            return v3(yaw.sin() * theta.cos(), theta.sin(), yaw.cos() * theta.cos());
        }
    }
    let sight = v3(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    v3(sight.x * 0.85, 0.78, sight.z * 0.85).norm()
}

/// Turret traverse + gun elevation. Without an explicit aim the turret follows the hull.
pub fn update_aim(w: &mut World, vi: usize, dt: f32, inp: &Input) {
    let spec = *w.vehicles[vi].spec();
    let mut target_yaw = if inp.has_aim { inp.aim } else { w.vehicles[vi].yaw };
    // Lead an aircraft in the traverse as well as in the elevation. The front end and the AI
    // both hand us the bearing to where the target is *now*, and a crossing aircraft covers
    // several metres in the round's flight time, so a gun laid on that bearing shoots behind
    // it. `aim_air_target` is the same solve `aim_target` uses for the launch elevation, so
    // bearing and elevation agree; it is a no-op for a ground target, where the sight line is
    // already the answer.
    if inp.has_aim {
        if let Some((pred, _tof)) = aim_air_target(w, vi, inp.aim, inp.aim_pitch, &spec.weapon0) {
            let v = &w.vehicles[vi];
            target_yaw = v2(pred.x - v.pos.x, pred.z - v.pos.y).heading();
        }
    }
    {
        let v = &mut w.vehicles[vi];
        if spec.turret_speed > 0.0 || spec.kind == vkind::HELI {
            let rate = if spec.turret_speed > 0.0 {
                spec.turret_speed
            } else {
                2.4
            };
            let step = rate * dt * (0.55 + 0.45 * inp.throttle.abs().min(1.0)).max(0.35);
            let want = if spec.turret_arc >= core::f32::consts::PI {
                target_yaw
            } else {
                let rel = wrap_angle(target_yaw - v.yaw);
                v.yaw + clamp(rel, -spec.turret_arc, spec.turret_arc)
            };
            v.turret_yaw = approach_angle(v.turret_yaw, want, step);
        } else {
            v.turret_yaw = approach_angle(v.turret_yaw, v.yaw, 4.0 * dt);
        }
    }
    // A direct-fire gun is laid at the elevation that lands the round on the sight line's
    // target; a lobbed weapon is laid on the sight line itself and its arc is solved at the
    // moment of firing, because `gun_pitch` doubles as the AI's elevation-alignment reference.
    let want_pitch = if inp.has_aim && !spec.weapon0.lobbed {
        aimed_launch_pitch(w, vi, inp, &spec.weapon0).unwrap_or(inp.aim_pitch)
    } else {
        inp.aim_pitch
    };
    let want_pitch = want_pitch.clamp(-0.5, 1.1);
    let v = &mut w.vehicles[vi];
    v.gun_pitch = lerp(v.gun_pitch, want_pitch, (dt * 3.5).min(1.0));
}

fn handle_weapons(w: &mut World, vi: usize, inp: &Input, out_of_fuel: bool) {
    if out_of_fuel {
        return;
    }
    let spec = *w.vehicles[vi].spec();
    let kind = w.vehicles[vi].kind;

    // Up to two shots per tick to support fast bursts.
    for _ in 0..2 {
        let (reload, burst, ammo, can_fire, want, widx) = {
            let v = &w.vehicles[vi];
            let w0 = &spec.weapon0;
            let primary_ok = v.ammo0 > 0.0
                && v.reload0 <= 0.0
                && v.burst_t <= 0.0
                && (!w0.must_stop || v.fwd_speed.abs() < 1.3);
            (v.reload0, v.burst, v.ammo0, primary_ok, inp.fire0, 0usize)
        };
        let _ = (reload, ammo, burst);
        if want && can_fire {
            let (yaw, pitch) = if spec.turret_speed > 0.0 || spec.flying {
                (w.vehicles[vi].turret_yaw, w.vehicles[vi].gun_pitch)
            } else {
                let p = if spec.weapon0.lobbed { 0.45 } else { 0.0 };
                (w.vehicles[vi].yaw, p)
            };
            fire(w, vi, widx, yaw, pitch);
            continue;
        }
        break;
    }

    // Secondary: helicopter rockets, HRSV mines, jeep smoke (unused).
    if inp.fire1_edge {
        match kind {
            vkind::HELI => {
                if w.vehicles[vi].ammo1 > 0.0 && w.vehicles[vi].reload1 <= 0.0 {
                    let yaw = w.vehicles[vi].turret_yaw;
                    let pitch = w.vehicles[vi].gun_pitch;
                    fire(w, vi, 1, yaw, pitch);
                }
            }
            vkind::HRSV => drop_mine(w, vi),
            _ => {}
        }
    }
}

pub fn fire(w: &mut World, vi: usize, widx: usize, yaw: f32, pitch: f32) {
    let spec = *w.vehicles[vi].spec();
    let weapon = if widx == 1 { spec.weapon1 } else { spec.weapon0 };
    if weapon.damage <= 0.0 {
        return;
    }
    {
        let v = &mut w.vehicles[vi];
        if widx == 1 {
            if v.ammo1 <= 0.0 || v.reload1 > 0.0 {
                return;
            }
            v.ammo1 -= 1.0;
            v.reload1 = weapon.cooldown;
            v.burst = weapon.burst.saturating_sub(1);
            v.burst_t = weapon.burst_gap;
        } else {
            if v.ammo0 <= 0.0 || v.reload0 > 0.0 {
                return;
            }
            v.ammo0 -= 1.0;
            v.reload0 = weapon.cooldown;
            v.burst = weapon.burst.saturating_sub(1);
            v.burst_t = weapon.burst_gap;
        }
        v.last_fire = w.time;
    }
    let owner_id = w.vehicles[vi].id;
    let owner_kind = w.vehicles[vi].kind;
    let team = w.vehicles[vi].team;
    let muzzle = combat::muzzle_pos(&w.vehicles[vi], &weapon, yaw, pitch);
    let mut dir = v3(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    if weapon.lobbed {
        // Indirect fire (grenades, MLRS): the caller hands us the sight elevation to the target
        // and the round has to be launched on the arc that lands there, not along the sight.
        dir = lobbed_launch(w, vi, yaw, pitch, &weapon);
    }
    let mut target = w.vehicles[vi].ai.target;
    // A heat-seeker with no live lock acquires its target at the moment of launch — the
    // nearest hostile hull inside the weapon's range and within a wide cone of the launch
    // bearing. Pointing roughly at the enemy is enough to light it up; the missile does the
    // rest until the lock expires. This runs for player drivers (whose `ai.target` is never
    // set) and for AI drivers whose locked hull just died or was culled — note that a fresh
    // `AiState` defaults to 0, not -1, so "no lock" is tested by resolving the id, not by
    // its sign.
    if weapon.homing && w.vehicle_index(target as u32).filter(|vi| w.vehicles[*vi].alive()).is_none() {
        let hd = v2(dir.x, dir.z);
        if hd.len_sq() > 1e-6 {
            let hd = hd.norm();
            let origin = v2(muzzle.x, muzzle.z);
            let mut best: Option<(f32, i32)> = None;
            for ti in 0..w.vehicles.len() {
                let v = &w.vehicles[ti];
                if !v.alive() || v.team == team || w.protected_from_attack(ti) {
                    continue;
                }
                let to = v.pos - origin;
                let d = to.len();
                if d < 2.0 || d > weapon.range {
                    continue;
                }
                let dot = to.norm().dot(hd);
                if dot < 0.82 {
                    continue; // ~35 deg off the launch bearing: no lock
                }
                let score = d / (0.5 + dot);
                if best.map_or(true, |b| score < b.0) {
                    best = Some((score, v.id as i32));
                }
            }
            target = best.map(|b| b.1).unwrap_or(-1);
        }
    }
    // A heat-seeker arcs over intervening terrain: tilt the launch direction up by a fraction
    // of `launch_climb` scaled to the distance to the locked target, so a ridge the gunner can
    // see over does not eat the round (measured on Twin Atolls: a "clear" 120 m lane with a
    // 2.7 m rise in the middle killed every level-flying missile on the hillside). Homing then
    // brings the arc back down on the hull; at point-blank the fraction is ~0 and the round
    // flies level, which is what small close targets need to stay inside their hit band.
    if weapon.launch_climb > 0.0 {
        let frac = if target >= 0 {
            w.vehicle_index(target as u32)
                .map(|ti| {
                    let d = (w.vehicles[ti].pos - w.vehicles[vi].pos).len();
                    (d / weapon.range).clamp(0.0, 1.0)
                })
                .unwrap_or(1.0)
        } else {
            // No lock, so nothing will bring the arc back down: a lofted round simply sails
            // over whatever it was aimed at. The AI fires at structures with no vehicle lock
            // (`ai.target` is -1), so an unguided shot leaves *flat* - measured, 43 MLRS
            // rockets aimed at a missile tower from 140 m all passed over it and did nothing.
            0.0
        };
        let c = weapon.launch_climb * frac;
        let horiz = (1.0 - dir.y * dir.y).max(0.0).sqrt();
        dir = v3(dir.x * c.cos(), dir.y * c.cos() + horiz * c.sin(), dir.z * c.cos());
    }
    // Roll the muzzle velocity here, once, so the round and the tracer drawn for it agree.
    let speed = weapon.speed * (1.0 + w.rng.sym() * 0.03);
    combat::spawn_projectile(w, &weapon, owner_id, owner_kind, team, muzzle, dir, target, speed);
    // Recoil nudges the hull, and the flash lights the ground.
    let recoil = weapon.recoil;
    if recoil > 0.0 {
        let fwd = v2(yaw.sin(), yaw.cos());
        w.vehicles[vi].vel -= fwd * recoil * 0.25;
        w.vehicles[vi].fwd_speed -= recoil * 0.25;
    }
    if weapon.pkind == pkind::BULLET {
        // Event slots: x/z, y, (unused), yaw, pitch, range, and now the round's real speed in
        // the spare slot — the FX layer has to draw the streak at the speed the round actually
        // travels (190-210 m/s here), not at an assumed constant.
        w.push_event(
            ekind::TRACER,
            v2(muzzle.x, muzzle.z),
            muzzle.y,
            0.0,
            yaw,
            pitch,
            weapon.range,
            speed,
        );
    }
}

pub fn drop_mine(w: &mut World, vi: usize) {
    if w.vehicles[vi].mines < 1.0 {
        return;
    }
    let p = w.vehicles[vi].pos;
    let y = w.map.height_at(p.x, p.y);
    if y <= w.map.water_level {
        return;
    }
    w.vehicles[vi].mines -= 1.0;
    let id = w.next_id;
    w.next_id += 1;
    w.mines.push(crate::world::Mine {
        id,
        team: w.vehicles[vi].team,
        pos: p,
        y,
        armed: 0.0,
        blink: 0.0,
    });
    w.sound(sfx::MINE_DROP, p, y, 0.7);
    w.push_event(ekind::DUST, p, y + 0.1, 0.0, 0.5, 0.0, 0.0, 0.0);
}

/// Push vehicles out of structures and out of each other, applying ram damage.
pub fn resolve_vehicle_collisions(w: &mut World, dt: f32) {
    let n = w.vehicles.len();
    let mut scratch = w.take_scratch();
    for vi in 0..n {
        if !w.vehicles[vi].alive() {
            continue;
        }
        let spec = *w.vehicles[vi].spec();
        let pos = w.vehicles[vi].pos;
        let r = spec.radius;
        w.grid.query(pos, r + 2.0, &mut scratch);
        let mut push = Vec2::ZERO;
        let mut hardest = 0.0f32;
        for si in scratch.iter() {
            let s = w.map.structures[*si as usize];
            if !s.solid() || s.kind as u8 == skind::BRIDGE {
                continue;
            }
            if spec.flying && w.vehicles[vi].alt > s.h + 1.5 {
                continue;
            }
            if let Some(p) = s.circle_push(pos, r) {
                let l = p.len();
                push += p;
                if l > hardest {
                    hardest = l;
                }
            }
        }
        if hardest > 0.0 {
            let n = push.norm();
            w.vehicles[vi].pos += n * (hardest.min(1.2));
            let closing = -w.vehicles[vi].vel.dot(n);
            if closing > 4.5 && !w.protected_from_attack(vi) {
                let dmg = (closing - 4.5) * w.tuning.rules.ram_damage * (spec.hp / 200.0).max(0.6);
                let team = w.vehicles[vi].team;
                combat::damage_vehicle(w, vi, dmg, team, -1);
                let p = w.vehicles[vi].pos;
                w.push_event(ekind::IMPACT, p, w.vehicles[vi].center_y(), 0.0, 0.8, 0.0, 0.0, 0.0);
                w.sound(sfx::IMPACT_METAL, p, w.vehicles[vi].center_y(), 0.7);
            }
            w.vehicles[vi].vel = w.vehicles[vi].vel - n * w.vehicles[vi].vel.dot(n) * 1.35;
            w.vehicles[vi].fwd_speed *= 0.35;
        }
    }

    // Vehicle vs vehicle.
    for a in 0..n {
        if !w.vehicles[a].alive() {
            continue;
        }
        for b in (a + 1)..n {
            if !w.vehicles[b].alive() {
                continue;
            }
            let (pa, pb) = (w.vehicles[a].pos, w.vehicles[b].pos);
            let ra = w.vehicles[a].spec().radius;
            let rb = w.vehicles[b].spec().radius;
            let d = pb - pa;
            let dist = d.len();
            let min_d = ra + rb;
            if dist > min_d || dist < 1e-4 {
                continue;
            }
            let nrm = d / dist;
            let pen = min_d - dist;
            let fa = w.vehicles[a].spec().flying;
            let fb = w.vehicles[b].spec().flying;
            if fa != fb {
                // Air vs ground: the flyer gets shoved up over the ground vehicle.
                continue;
            }
            if fa {
                // Two flyers only touch if they are at the same height. The test above is
                // horizontal, so a drone at 18 m used to bounce off one at 3 m.
                let dy = (w.vehicles[a].center_y() - w.vehicles[b].center_y()).abs();
                let thickness =
                    (w.vehicles[a].spec().height + w.vehicles[b].spec().height) * 0.5;
                if dy > thickness {
                    continue;
                }
                // Two helicopters that fly into each other both come down. It is a collision,
                // not a scrape: the closing speed has to be real (a hover drifting into another
                // hover just shoves), and it happens before the shove below, so the pair falls
                // as wrecks - the existing wreck path gives them the tumble and the fireball.
                let closing = (w.vehicles[b].vel - w.vehicles[a].vel).dot(nrm).abs();
                let both_heli = w.vehicles[a].kind == vkind::HELI && w.vehicles[b].kind == vkind::HELI;
                if both_heli
                    && closing > 3.0
                    && !w.protected_from_attack(a)
                    && !w.protected_from_attack(b)
                {
                    let p = (pa + pb) * 0.5;
                    w.push_event(
                        ekind::BIG_EXPLOSION,
                        p,
                        w.vehicles[a].center_y(),
                        0.0,
                        1.7,
                        0.0,
                        0.0,
                        0.0,
                    );
                    w.sound(sfx::EXPLOSION_BIG, p, w.vehicles[a].center_y(), 1.0);
                    w.kill_vehicle(a, -1);
                    w.kill_vehicle(b, -1);
                    continue;
                }
            }
            w.vehicles[a].pos -= nrm * (pen * 0.5);
            w.vehicles[b].pos += nrm * (pen * 0.5);
            let rel = (w.vehicles[b].vel - w.vehicles[a].vel).dot(nrm);
            if rel.abs() > 3.0 && !w.protected_from_attack(a) && !w.protected_from_attack(b) {
                let base = rel.abs();
                let dmg_a = base * 1.6 * (w.vehicles[b].spec().hp / 300.0).clamp(0.4, 1.6);
                let dmg_b = base * 1.6 * (w.vehicles[a].spec().hp / 300.0).clamp(0.4, 1.6);
                let tb = w.vehicles[b].team;
                let ta = w.vehicles[a].team;
                combat::damage_vehicle(w, a, dmg_a, tb, -1);
                combat::damage_vehicle(w, b, dmg_b, ta, -1);
                let p = (pa + pb) * 0.5;
                w.push_event(ekind::IMPACT, p, 1.5, 0.0, 1.0, 0.0, 0.0, 0.0);
            }
            let va = w.vehicles[a].vel;
            let vb = w.vehicles[b].vel;
            w.vehicles[a].vel = va - nrm * va.dot(nrm) * 0.8;
            w.vehicles[b].vel = vb - nrm * vb.dot(nrm) * 0.8;
            w.vehicles[a].fwd_speed *= 0.6;
            w.vehicles[b].fwd_speed *= 0.6;
        }
    }

    // Vehicles squash infantry.
    for a in 0..n {
        if !w.vehicles[a].alive() || w.vehicles[a].kind == vkind::TROOP {
            continue;
        }
        let speed = w.vehicles[a].vel.len();
        if speed < 3.0 {
            continue;
        }
        for b in 0..n {
            if b == a || w.vehicles[b].kind != vkind::TROOP || !w.vehicles[b].alive() {
                continue;
            }
            if w.vehicles[b].airborne {
                continue;
            }
            let d = w.vehicles[a].pos.dist(w.vehicles[b].pos);
            if d < w.vehicles[a].spec().radius + 1.0 {
                let team = w.vehicles[a].team;
                combat::damage_vehicle(w, b, 200.0, team, -1);
            }
        }
    }
    w.give_scratch(scratch);
    let _ = dt;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::vehicle;
    use crate::types::{terrain, MapData, CELL, GRID, VERTS, WATER_LEVEL, WORLD_SIZE};

    /// Flat island covering everything above `shore_fraction` of the map, exactly as the
    /// weapon-spawn audit's map is built, so a shot here has nothing to hit but the ground.
    fn flat_map(shore_fraction: f32) -> MapData {
        let shore_z = WORLD_SIZE * shore_fraction;
        let mut heights = vec![0.0f32; (VERTS * VERTS) as usize];
        for iz in 0..VERTS {
            for ix in 0..VERTS {
                let z = iz as f32 * CELL;
                heights[(iz * VERTS + ix) as usize] = if z < shore_z { 3.0 } else { -6.0 };
            }
        }
        let mut nav = vec![terrain::GROUND; (GRID * GRID) as usize];
        for iz in 0..GRID {
            if iz as f32 * CELL >= shore_z {
                for ix in 0..GRID {
                    nav[(iz * GRID + ix) as usize] = terrain::DEEP_WATER;
                }
            }
        }
        MapData {
            name: "aim-flat".into(),
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
            base_anchor: [(v2(34.0, 24.0), 0.0), (v2(WORLD_SIZE - 34.0, 24.0), 0.0)],
            water_level: WATER_LEVEL,
        }
    }

    /// One aimed shot: stand a hull at (80, 80) facing north, aim its crosshair at the ground
    /// `dist` metres ahead, let the gun settle, fire, and watch the round to its impact.
    ///
    /// The aim is built exactly the way `main.ts` builds it — a sight line from the muzzle to
    /// the ground point under the cursor — so this measures the whole player path: the input's
    /// `aim_pitch`, `update_aim`'s launch elevation, `handle_weapons`' choice of gun, and the
    /// flight itself. Returns `(range error, lateral error, landed at all, launch angle in
    /// degrees)`.
    fn aimed_shot(kind: u8, dist: f32) -> (f32, f32, bool, f32) {
        // Both slots human, so `initial_spawn` fields no AI garrison and `ai_commander` skips
        // both teams. With the old `[0, -1]` world the AI *did* field a hull on this synthetic
        // map, drove it into the impact area, and the measured round landed on it instead of on
        // the crosshair - a few metres short of the aim point, growing with range, which is why
        // this table's numbers moved whenever the AI's behaviour changed. The shot's own launch
        // solve is byte-identical either way; only what it hits differs.
        let mut w = World::new_with_map(42, flat_map(0.9), [0, 1]);
        let vid = w.spawn_vehicle(kind, 0, 1);
        let vi = w.vehicle_index(vid).unwrap();
        let spec = *w.vehicles[vi].spec();
        let start = v2(80.0, 80.0);
        let aim = v2(80.0, 80.0 + dist);
        {
            let v = &mut w.vehicles[vi];
            v.pos = start;
            v.y = 3.0;
            v.yaw = 0.0;
            v.turret_yaw = 0.0;
            v.gun_pitch = 0.0;
            v.spawn_guard = 0.0;
            v.ammo0 = spec.ammo0_max.max(1.0);
            v.reload0 = 0.0;
            v.burst_t = 0.0;
        }
        let mut inp = Input::default();
        inp.has_aim = true;
        inp.aim = 0.0;
        // Settle: the gun traverses to the bearing and its elevation eases onto the launch
        // angle the sight line solves to. The sight line is the one main.ts builds: the resting
        // muzzle height, at the crosshair's horizontal distance from the hull.
        for _ in 0..180 {
            let eye = w.vehicles[vi].center_y() + spec.weapon0.muzzle_up;
            inp.aim_pitch = ((3.0 - eye) / dist).atan();
            inp.fire0 = false;
            w.step(1.0 / 60.0, &[inp, Input::default()]);
        }
        let before: Vec<u32> = w.projs.iter().map(|p| p.id).collect();
        inp.fire0 = true;
        w.step(1.0 / 60.0, &[inp, Input::default()]);
        inp.fire0 = false;
        let pid = match w.projs.iter().find(|p| p.owner == vid && !before.contains(&p.id)) {
            Some(p) => p.id,
            None => return (f32::NAN, f32::NAN, false, f32::NAN),
        };
        // The angle the round actually left on: the whole point of the lobbed change.
        let launch = w
            .projs
            .iter()
            .find(|p| p.id == pid)
            .map(|p| p.vel.y.atan2((p.vel.x * p.vel.x + p.vel.z * p.vel.z).sqrt()).to_degrees())
            .unwrap_or(f32::NAN);
        let mut last: Option<(Vec2, f32)> = None;
        let mut impact: Option<Vec2> = None;
        for _ in 0..900 {
            if let Some(p) = w.projs.iter().find(|p| p.id == pid) {
                last = Some((v2(p.pos.x, p.pos.z), p.pos.y));
            }
            w.step(1.0 / 60.0, &[inp, Input::default()]);
            for e in &w.events {
                let k = e.kind as u8;
                if k == ekind::DUST || k == ekind::WATER_SPLASH || k == ekind::IMPACT || k == ekind::EXPLOSION {
                    if let Some((p, _)) = last {
                        if v2(e.x, e.z).dist(p) < 12.0 {
                            impact = Some(v2(e.x, e.z));
                        }
                    }
                }
            }
            if impact.is_some() || w.projs.iter().all(|p| p.id != pid) {
                break;
            }
        }
        match impact {
            Some(p) => {
                let a = inp.aim;
                let (ux, uz) = (a.sin(), a.cos());
                let rel = p - start;
                let range = rel.len();
                let lateral = rel.x * -uz + rel.y * ux;
                (range - start.dist(aim), lateral, true, launch)
            }
            None => (f32::NAN, f32::NAN, false, launch),
        }
    }

    /// The AI gates its trigger on `|aim_pitch - gun_pitch| < 0.05` (ai.rs `elevated`). A
    /// direct-fire compensation bigger than that would silently stop the AI from ever firing,
    /// so the solve has to stay inside the gate — which it does, because a fast shell barely
    /// drops over the ranges the AI engages at.
    ///
    /// Lobbed weapons are deliberately *not* compensated in `update_aim` (their arc is solved in
    /// `fire`, leaving `gun_pitch` alone), so that gate is untouched for the jeep. The MLRS
    /// heat-seeker drops nothing at all (gravity 0): `ballistic_solutions` refuses a zero-g
    /// solve, and the sight line *is* the launch line, so there is no compensation to bound.
    #[test]
    fn gravity_compensation_stays_inside_the_ai_elevation_gate() {
        let cases: &[(f32, f32, f32, f32, &str)] = &[
            (145.0, 6.0, 150.0, -2.0, "tank 120mm"),
            (210.0, 3.0, 120.0, -14.0, "heli 20mm"),
            (190.0, 2.0, 70.0, -10.0, "drone gun"),
        ];
        println!("\n{:<12} {:>6} {:>10} {:>10} {:>10}", "weapon", "range", "sight", "launch", "delta");
        for (speed, gravity, range, dy, name) in cases {
            let straight = (dy / range).atan();
            let solved = ballistic_pitch(*speed, *gravity, *range, *dy).unwrap();
            let delta = (solved - straight).abs();
            println!("{name:<12} {range:>6.0} {straight:>10.4} {solved:>10.4} {delta:>10.4}");
            assert!(delta < 0.05, "{name}: compensation {delta:.4} rad exceeds the AI's gate");
        }
        // The jeep grenade is the only lobbed weapon left: the MLRS round became a heat-seeker
        // (direct flight, arc supplied by `launch_climb` at the muzzle instead of a ballistic solve).
        assert!(vehicle::JEEP.weapon0.lobbed && !vehicle::HRSV.weapon0.lobbed);
    }

    /// The crosshair promise: a round fired at the ground point under the cursor lands on it.
    ///
    /// Before this, both halves of the promise were broken and the misses were tens of metres:
    /// a jeep grenade left on a fixed 42.5 deg loft in the *hull's* direction (no traverse) and
    /// an MLRS rocket always landed ~200 m out whichever way the crosshair pointed, while a
    /// tank shell dropped 1.4 m under a 100 m shot because nothing solved the arc.
    ///
    /// The HRSV is no longer in this table: its round became a heat-seeker that homes on a
    /// vehicle instead of landing on a ground point (see `mlrs_heat_seeker_homes_on_its_target`
    /// in tests/gameplay_audit.rs).
    #[test]
    fn aimed_rounds_land_on_the_crosshair_for_every_land_vehicle() {
        // 100 m is past the jeep grenade's ballistic reach (34^2 / 22 = 52 m), so for the jeep
        // the check there is direction, not distance.
        let cases: &[(u8, f32)] = &[
            (vkind::JEEP, 15.0),
            (vkind::JEEP, 40.0),
            (vkind::JEEP, 100.0),
            (vkind::TANK, 15.0),
            (vkind::TANK, 40.0),
            (vkind::TANK, 100.0),
        ];
        println!("\n{:<14} {:>7} {:>12} {:>12}", "vehicle", "aim", "range err", "lateral err");
        let mut failures = Vec::new();
        for (kind, dist) in cases {
            let (range_err, lateral, landed, _launch) = aimed_shot(*kind, *dist);
            let name = vehicle::spec(*kind).name;
            if !landed {
                failures.push(format!("{name} fired at {dist} m never landed"));
                continue;
            }
            println!("{name:<14} {dist:>7.0} {range_err:>12.2} {lateral:>12.2}");
            if lateral.abs() > 1.5 {
                failures.push(format!("{name} at {dist} m: {lateral:.2} m off the aim bearing"));
            }
            if *kind == vkind::JEEP && *dist > 60.0 {
                // Out of reach: it must fall short on the correct bearing, not overshoot it.
                if range_err > -10.0 {
                    failures.push(format!("{name} at {dist} m: an out-of-reach throw landed {range_err:.2} m long"));
                }
            } else {
                // The residual is the simulation's own impact quantisation, not the aim: a round
                // is integrated in whole 1/60 s steps and `combat::update_projectiles` reports
                // the impact at the position at the END of the step that crossed the ground, so
                // a 145 m/s shell is up to 2.4 m past the surface crossing when it bursts (the
                // integrator's own O(dt) drop bias adds ~1 m more over 100 m). Anything beyond
                // that is the gun pointing somewhere the crosshair is not.
                let bound = vehicle::spec(*kind).weapon0.speed / 60.0 + 2.0;
                if range_err.abs() > bound {
                    failures.push(format!(
                        "{name} at {dist} m: landed {range_err:.2} m off (bound {bound:.2} m)"
                    ));
                }
            }
        }
        assert!(failures.is_empty(), "\n  - {}", failures.join("\n  - "));
    }

    /// What one aimed air shot produced.
    struct AirShot {
        /// Ticks from the shot to the first damage on the target.
        hit_tick: u32,
        target_hp_before: f32,
        target_hp_after: f32,
        shooter_hp_after: f32,
        /// The round's state at the start of the tick that hit, and the target's position after
        /// it: `(start_pos, end_pos_estimate, target_pos, radius)`. Used to show the shot was
        /// caught mid-step (the old end-point-only test would have sampled either side of it).
        crossing: Option<(Vec3, Vec3, Vec2, f32)>,
    }

    /// One aimed shot at a moving airborne target, built exactly the way `main.ts` builds an air
    /// aim (its cursor-ray pick): the input is the bearing to the aircraft's centre and the
    /// elevation from the muzzle to that centre. The turret is settled on the stationary target
    /// first, the target is then set crossing at `cross` m/s, the traverse is allowed to take up
    /// the lead, and one round is fired. Everything after that is the simulation's own solve.
    ///
    /// Returns `None` when the shot never leaves the muzzle.
    fn aimed_air_shot(shooter: u8, target_kind: u8, dist: f32, cross: f32) -> Option<AirShot> {
        let mut w = World::new_with_map(42, flat_map(0.9), [0, 1]);
        let sid = w.spawn_vehicle(shooter, 0, 1);
        let tid = w.spawn_vehicle(target_kind, 1, 2);
        let si = w.vehicle_index(sid).unwrap();
        let ti = w.vehicle_index(tid).unwrap();
        let sspec = *w.vehicles[si].spec();
        let tspec = *w.vehicles[ti].spec();
        {
            let v = &mut w.vehicles[si];
            v.pos = v2(80.0, 80.0);
            v.y = 3.0;
            v.yaw = 0.0;
            v.turret_yaw = 0.0;
            v.gun_pitch = 0.0;
            v.spawn_guard = 0.0;
            v.home_safe = 0.0;
            v.ammo0 = sspec.ammo0_max.max(1.0);
            v.reload0 = 0.0;
            v.burst_t = 0.0;
            v.fuel = sspec.fuel_max;
        }
        {
            let v = &mut w.vehicles[ti];
            v.pos = v2(80.0, 80.0 + dist);
            v.alt = tspec.cruise_alt;
            v.y = 3.0 + tspec.cruise_alt;
            v.yaw = 0.0;
            v.vel = Vec2::ZERO;
            v.spawn_guard = 0.0;
            v.home_safe = 0.0;
            v.fuel = tspec.fuel_max;
        }
        let hp0 = w.vehicles[ti].hp;
        // The player's air input: bearing and elevation straight to the aircraft's centre.
        let air_aim = |w: &World, si: usize, ti: usize| -> (f32, f32) {
            let s = &w.vehicles[si];
            let t = &w.vehicles[ti];
            let d = v2(t.pos.x - s.pos.x, t.pos.y - s.pos.y);
            let horiz = d.len().max(0.5);
            let eye = s.center_y() + s.spec().weapon0.muzzle_up;
            (d.heading(), ((t.center_y() - eye) / horiz).atan())
        };
        let mut inp = Input::default();
        inp.has_aim = true;
        for _ in 0..180 {
            let (y, p) = air_aim(&w, si, ti);
            inp.aim = y;
            inp.aim_pitch = p;
            inp.fire0 = false;
            w.step(1.0 / 60.0, &[inp, Input::default()]);
        }
        let cross_vel = v2(cross, 0.0);
        let dt = 1.0 / 60.0;
        let mut fired = false;
        let mut hit_tick = 0u32;
        let mut crossing = None;
        let mut prev: Option<(Vec3, Vec3)>; // (pos, vel) at the start of the step
        for tick in 0..240u32 {
            w.vehicles[ti].vel = cross_vel;
            let (y, p) = air_aim(&w, si, ti);
            inp.aim = y;
            inp.aim_pitch = p;
            // Let the traverse take up the lead before the trigger, as a player tracking the
            // aircraft would; then fire once.
            inp.fire0 = tick == 12;
            prev = w
                .projs
                .iter()
                .find(|pr| pr.owner == sid)
                .map(|pr| (pr.pos, pr.vel));
            let had = fired;
            w.step(dt, &[inp, Input::default()]);
            let now_fired = w.projs.iter().any(|pr| pr.owner == sid);
            if now_fired && !had {
                fired = true;
                hit_tick = tick;
            }
            if fired && w.vehicles[ti].hp < hp0 {
                hit_tick = tick - hit_tick;
                if let Some((p, v)) = prev {
                    let gravity = sspec.weapon0.gravity;
                    let end = v3(p.x + v.x * dt, p.y + (v.y - gravity * dt) * dt, p.z + v.z * dt);
                    crossing = Some((p, end, w.vehicles[ti].pos, tspec.radius + 0.9));
                }
                return Some(AirShot {
                    hit_tick,
                    target_hp_before: hp0,
                    target_hp_after: w.vehicles[ti].hp,
                    shooter_hp_after: w.vehicles[si].hp,
                    crossing,
                });
            }
            if fired && !now_fired {
                return None; // the round expired without touching the aircraft
            }
        }
        None
    }

    /// A shot aimed at a crossing aircraft has to lead it and connect. Before this the aim was
    /// always resolved to the ground point under the crosshair — an aircraft is not on the
    /// terrain, so the solve put the round under the airframe, and nothing in the aim path so
    /// much as read `Vehicle::airborne`.
    #[test]
    fn aimed_shot_hits_a_crossing_aircraft() {
        println!("\n{:<16} {:>6} {:>6} {:>8} {:>10} {:>10}", "shooter", "range", "cross", "hit tick", "hp before", "hp after");
        let mut failures: Vec<String> = Vec::new();
        for (shooter, dist, cross) in [
            (vkind::TANK, 100.0f32, 14.0f32),
            (vkind::TANK, 80.0, -14.0),
            (vkind::HELI, 120.0, 20.0),
        ] {
            let name = vehicle::spec(shooter).name;
            match aimed_air_shot(shooter, vkind::HELI, dist, cross) {
                Some(s) => {
                    println!(
                        "{name:<16} {dist:>6.0} {cross:>6.0} {:>8} {:>10.0} {:>10.0}",
                        s.hit_tick, s.target_hp_before, s.target_hp_after
                    );
                    if s.hit_tick > 90 {
                        failures.push(format!("{name} at {dist} m took {} ticks to connect", s.hit_tick));
                    }
                    if !(s.target_hp_after < s.target_hp_before) {
                        failures.push(format!("{name} at {dist} m landed no damage on the aircraft"));
                    }
                    if s.shooter_hp_after != vehicle::spec(shooter).hp {
                        failures.push(format!("{name} at {dist} m damaged itself"));
                    }
                }
                None => failures.push(format!("{name} at {dist} m never touched a crossing helicopter")),
            }
        }
        assert!(failures.is_empty(), "\n  - {}", failures.join("\n  - "));
    }

    /// The anti-tunnelling proof at the edge of the envelope: a 20 mm round covers 3.5 m per tick,
    /// so an end-point-only hit test samples either side of a crossing airframe and misses. This
    /// fires at the helicopter cannon's maximum engagement range and requires the damage to land
    /// on the aircraft and not on the shooter.
    #[test]
    fn fast_round_hits_an_aircraft_at_maximum_engagement_range() {
        let cannon = vehicle::HELI.weapon0;
        let range = cannon.range;
        println!("\n{:<12} {:>6} {:>8} {:>10} {:>10}", "target", "range", "hit tick", "hp before", "hp after");
        for (target_kind, cross) in [(vkind::HELI, 18.0f32), (vkind::DRONE, 8.0)] {
            // The crossing speed has to be one the target can actually fly. `aimed_air_shot`
            // re-applies `vel` at the top of every tick, but the shooter's traverse reads that
            // velocity *before* the target's own `step_air` clamps it to `spec.speed`, so
            // asking for more than the aircraft's top speed makes the solve lead a speed the
            // target never reaches and the round is guaranteed to fly long. The drone's spec
            // is 10 m/s, so it crosses at 8; the Cobra's is 45.
            let s = aimed_air_shot(vkind::HELI, target_kind, range, cross)
                .unwrap_or_else(|| panic!("{}: no hit at {range} m", vehicle::spec(target_kind).name));
            println!(
                "{:<12} {range:>6.0} {:>8} {:>10.0} {:>10.0}",
                vehicle::spec(target_kind).name,
                s.hit_tick,
                s.target_hp_before,
                s.target_hp_after
            );
            assert!(
                s.target_hp_after < s.target_hp_before,
                "{}: no damage at {range} m",
                vehicle::spec(target_kind).name
            );
            assert_eq!(
                s.shooter_hp_after,
                vehicle::HELI.hp,
                "{}: the shooter was the one damaged",
                vehicle::spec(target_kind).name
            );
            // If the step that landed the hit started and ended outside the airframe's own
            // cylinder, an end-point-only test would have called it a miss.
            if let Some((start, end, tp, r)) = s.crossing {
                let d0 = v2(start.x, start.z).dist(tp);
                let d1 = v2(end.x, end.z).dist(tp);
                if d0 > r && d1 > r {
                    println!(
                        "  {}: swept only (step ends {d0:.2} m and {d1:.2} m from the axis, radius {r:.2} m)",
                        vehicle::spec(target_kind).name
                    );
                }
            }
        }
    }

    /// The decisive anti-tunnelling integration proof, with the aim solve taken out of the
    /// picture so the *collision* path is what is under test.
    ///
    /// A 210 m/s round is launched on a straight line that passes 2.2 m from a drone's axis.
    /// The drone's cylinder is 2.5 m in radius and the round covers 3.5 m per tick, so the tick
    /// samples either side of the crossing sit 2.8 m from the axis: both outside. The old
    /// end-point-only test flew that round straight through; the swept test lands it, and the
    /// damage goes to the drone.
    #[test]
    fn fast_crossing_round_damages_the_aircraft_it_passes_through() {
        let mut w = World::new_with_map(7, flat_map(0.9), [0, 1]);
        let sid = w.spawn_vehicle(vkind::TANK, 0, 1);
        let tid = w.spawn_vehicle(vkind::DRONE, 1, 2);
        let ti = w.vehicle_index(tid).unwrap();
        let tspec = *w.vehicles[ti].spec();
        {
            let v = &mut w.vehicles[ti];
            v.pos = v2(80.0, 120.0);
            v.alt = tspec.cruise_alt;
            v.y = 3.0 + tspec.cruise_alt;
            v.vel = Vec2::ZERO;
            v.spawn_guard = 0.0;
            v.home_safe = 0.0;
        }
        let hp0 = w.vehicles[ti].hp;
        let axis = w.vehicles[ti].pos;
        let cy = w.vehicles[ti].center_y();
        let r = tspec.radius + 0.9;
        let off = 2.2f32; // perpendicular offset from the drone's axis
        let speed = 210.0f32; // the helicopter cannon's muzzle velocity
        let step = speed / 60.0;
        assert!(
            off < r && (step * 0.5).hypot(off) > r,
            "geometry no longer tunnels: offset {off}, radius {r}, step {step}"
        );
        // A real weapon, but with the launch spread and gravity zeroed so the test's line is
        // exactly the line it was built on.
        let wspec = WeaponSpec {
            spread: 0.0,
            gravity: 0.0,
            ..crate::spec::weapon::TANK_SHELL
        };
        combat::spawn_projectile(
            &mut w,
            &wspec,
            sid,
            vkind::TANK,
            0,
            v3(axis.x + off, cy, axis.y - 40.0),
            v3(0.0, 0.0, 1.0),
            -1,
            speed,
        );
        let dt = 1.0 / 60.0;
        let mut hit = None;
        for tick in 0..40u32 {
            let before = w.projs.first().map(|p| (p.pos, p.vel));
            combat::update_projectiles(&mut w, dt);
            if w.vehicles[ti].hp < hp0 {
                hit = Some((tick, before));
                break;
            }
        }
        let (tick, before) = hit.expect("the round never damaged the drone");
        let (p, v) = before.expect("the round vanished before it crossed");
        let end = v3(p.x + v.x * dt, p.y + v.y * dt, p.z + v.z * dt);
        let d0 = v2(p.x, p.z).dist(axis);
        let d1 = v2(end.x, end.z).dist(axis);
        println!(
            "\nswept drone hit on tick {tick}: tick samples {d0:.2} m and {d1:.2} m from the {r:.2} m axis, hp {hp0:.0} -> {:.0}",
            w.vehicles[ti].hp
        );
        assert!(d0 > r && d1 > r, "the end-point test would have caught this one ({d0:.2}, {d1:.2})");
        assert!(w.vehicles[ti].hp < hp0, "the drone took no damage");
    }

    /// The lobbed crosshair promise on flat ground: a thrown grenade still lands within a
    /// couple of metres of the point the crosshair sits on, on the lofted arc. (The MLRS round
    /// used to be lobbed too; it is now a heat-seeker and lives in tests/gameplay_audit.rs.)
    ///
    /// This is the before/after table for the high-arc change: "range err" is the impact's
    /// distance past the crosshair, "lateral err" its offset from the aim bearing.
    #[test]
    fn lobbed_rounds_land_on_the_crosshair_on_flat_ground() {
        // The jeep's reach is 34^2/22 = 52.5 m, so 60 m is an out-of-reach throw: it must fall
        // short on the correct bearing (the old fallback loft), not overshoot. The MLRS used to
        // be lobbed too; its round is now a heat-seeker and has moved to the gameplay_audit
        // suite (`mlrs_heat_seeker_homes_on_its_target`).
        let cases: &[(u8, f32)] = &[
            (vkind::JEEP, 15.0),
            (vkind::JEEP, 30.0),
            (vkind::JEEP, 45.0),
            (vkind::JEEP, 60.0),
        ];
        let mut failures = Vec::new();
        println!("\n{:<14} {:>7} {:>10} {:>12} {:>12}", "vehicle", "aim", "launch deg", "range err", "lateral err");
        for (kind, dist) in cases {
            let name = vehicle::spec(*kind).name;
            let (range_err, lateral, landed, launch) = aimed_shot(*kind, *dist);
            if !landed {
                failures.push(format!("{name} lobbed at {dist} m never landed"));
                continue;
            }
            println!("{name:<14} {dist:>7.0} {launch:>10.1} {range_err:>12.2} {lateral:>12.2}");
            // The arc itself: these lobs are on the lofted solution, not the flat one that used
            // to skim the ground (12.2 deg at 30 m, 24.6 deg at 45 m for the jeep). The 15 m
            // throw and the out-of-reach fallbacks are not.
            let must_loft = matches!((*kind, *dist), (vkind::JEEP, 30.0) | (vkind::JEEP, 45.0));
            if must_loft && launch < 45.0 {
                failures.push(format!("{name} at {dist} m: lob left on the flat {launch:.1} deg arc"));
            }
            if lateral.abs() > 1.5 {
                failures.push(format!("{name} at {dist} m: lob landed {lateral:.2} m off the aim bearing"));
            }
            if *kind == vkind::JEEP && *dist > 52.5 {
                // Past the throw's reach (34^2/22 = 52.5 m): it must fall short on the correct
                // bearing, not overshoot it.
                if range_err > -2.0 {
                    failures.push(format!("{name} at {dist} m: an out-of-reach throw landed {range_err:.2} m long"));
                }
            } else {
                // A lob is not a direct shot. The direct-fire bound — one tick of travel plus
                // 2 m — measures a straight line whose only error is the impact quantisation.
                // A lob is flown by the same 60 Hz semi-implicit Euler over a flight an order
                // of magnitude longer, which drops the round `g*t*dt/2` below the continuous
                // arc, and its range comes from the sight line's discrete ground march; both
                // errors grow with the flight time. Measured with the firing lane cleared (see
                // the isolation note in `aimed_shot`), the worst case is the MLRS at 150 m
                // (4.51 m, a 4.7 s lob) and every other lobbed case is inside 2.7 m, so the
                // tolerance carries a range term instead of pretending a lob lands as tightly
                // as a tank shell.
                let bound = vehicle::spec(*kind).weapon0.speed / 60.0 + 2.0 + 0.03 * dist;
                if range_err.abs() > bound {
                    failures.push(format!("{name} at {dist} m: lob landed {range_err:.2} m off (bound {bound:.2} m)"));
                }
            }
        }
        assert!(failures.is_empty(), "\n  - {}", failures.join("\n  - "));
    }
}

