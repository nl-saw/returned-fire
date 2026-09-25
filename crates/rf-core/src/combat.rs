//! Weapons: projectile integration, hits, splash damage, mines and structure destruction.

use crate::math::*;
use crate::spec::{vehicle, weapon, WeaponSpec};
use crate::types::*;
use crate::world::{Projectile, Vehicle, World};

/// Spawn a projectile from a vehicle's muzzle, aimed along `dir` (unit, world space).
///
/// `speed` is the muzzle velocity, already jittered by the caller. It is a parameter rather
/// than something this function rolls for itself so that the shot the effects layer is told
/// about (`ekind::TRACER`) travels at exactly the speed of the round that was created — a
/// tracer drawn at a guessed constant leads or lags the real projectile.
pub fn spawn_projectile(
    w: &mut World,
    weapon: &WeaponSpec,
    owner_id: u32,
    owner_kind: u8,
    team: u8,
    muzzle: Vec3,
    dir: Vec3,
    target: i32,
    speed: f32,
) {
    let id = w.next_id;
    w.next_id += 1;
    let spread = weapon.spread;
    let mut d = dir.norm();
    if spread > 0.0 {
        d.x += w.rng.sym() * spread;
        d.y += w.rng.sym() * spread * 0.7;
        d.z += w.rng.sym() * spread;
        d = d.norm();
    }
    let speed = speed.max(1.0);
    // A turret missile guides for ~1.6 s and then flies ballistically; the submarine's
    // heavyweight keeps its lock far longer; a weapon that sets `homing_lock` (the MLRS
    // heat-seeker) overrides both with its own.
    let homing_t = if !weapon.homing {
        0.0
    } else if weapon.homing_lock > 0.0 {
        weapon.homing_lock
    } else if weapon.pkind == pkind::HOMING {
        8.0
    } else {
        1.6
    };
    w.projs.push(Projectile {
        id,
        kind: weapon.pkind,
        team,
        owner: owner_id,
        owner_kind,
        pos: muzzle,
        vel: d * speed,
        life: weapon.life,
        damage: weapon.damage,
        splash: weapon.splash,
        splash_damage: weapon.splash_damage,
        gravity: weapon.gravity,
        homing: weapon.homing,
        homing_t,
        target,
        seed: w.rng.f32() * 100.0,
    });
    w.push_event(
        ekind::MUZZLE_FLASH,
        v2(muzzle.x, muzzle.z),
        muzzle.y,
        0.0,
        weapon.muzzle_fwd,
        0.0,
        0.0,
        0.0,
    );
    w.sound(weapon.sfx, v2(muzzle.x, muzzle.z), muzzle.y, 1.0);
}

/// Muzzle world position for a vehicle given its turret yaw and gun pitch.
///
/// `muzzle_fwd` / `muzzle_up` describe where the muzzle sits when the gun is at rest, in the
/// hull frame (they are matched to the model anchors in `web/src/assets/models/vehicles.ts`).
/// Only a short barrel ahead of the trunnion swings with the elevation: rotating the whole
/// offset about the hull centre — which is what this used to do — swung the muzzle through an
/// arc as long as the aircraft, so the helicopter's chin gun fired from 1.9 m *below* its own
/// skids at full depression instead of from the barrel under the nose.
pub fn muzzle_pos(v: &Vehicle, weapon: &WeaponSpec, yaw: f32, pitch: f32) -> Vec3 {
    let dir = v3(yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos());
    let hdir = v3(yaw.sin(), 0.0, yaw.cos());
    let base = v3(v.pos.x, v.center_y(), v.pos.y);
    // Thrown / indirect weapons (grenades, MLRS) have no elevating barrel at all: their muzzle
    // stays fixed to the hull and only the round's flight path arcs.
    let lever = if weapon.lobbed {
        0.0
    } else {
        weapon.muzzle_fwd.min(barrel_len(v.kind))
    };
    base + hdir * (weapon.muzzle_fwd - lever) + v3(0.0, weapon.muzzle_up, 0.0) + dir * lever
}

/// Barrel length between the trunnion and the muzzle, per vehicle, straight out of the models
/// in `web/src/assets/models/vehicles.ts` — this, and not the whole distance from the hull
/// centre, is what swings with the gun's elevation. Hand-thrown weapons have no barrel.
fn barrel_len(kind: u8) -> f32 {
    match kind {
        vkind::TANK => 2.2,      // gun group -> muzzle at BARREL_TIP 2.2
        vkind::HELI => 0.98,     // chin gun: gun (0, 0.02, 0.1) -> muzzle (0, -0.05, 0.98)
        vkind::HRSV => 1.25,     // pod: hub z -> muzzle z + 1.3
        vkind::DRONE => 0.76,    // gun pod -> muzzle
        vkind::SUBMARINE => 0.74, // launcher tube -> muzzle
        _ => 0.0,                // jeep, infantry: thrown from the hand
    }
}

/// Swept test of one projectile step (`a` -> `b`, the positions at the start and the end of the
/// tick) against a vehicle's vertical cylinder: centre `(center.x, center.y)` in the XZ plane,
/// radius `r`, height band `center_y +/- band`.
///
/// Returns the fraction along the step at which the round first enters the cylinder, or `None`.
/// `a` and `b` may both sit outside the cylinder and the segment still pass through it — that is
/// the case this exists for. Projectile `y` is linear over one tick (gravity is applied before
/// the move), so the band test is the span of `y` over the crossing interval.
fn segment_enter_cylinder(
    a: Vec3,
    b: Vec3,
    center: Vec2,
    center_y: f32,
    r: f32,
    band: f32,
) -> Option<f32> {
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    let fx = a.x - center.x;
    let fz = a.z - center.y;
    let aa = dx * dx + dz * dz;
    let (t0, t1) = if aa <= 1e-9 {
        if fx * fx + fz * fz > r * r {
            return None;
        }
        (0.0, 1.0)
    } else {
        let bb = 2.0 * (fx * dx + fz * dz);
        let cc = fx * fx + fz * fz - r * r;
        let disc = bb * bb - 4.0 * aa * cc;
        if disc <= 0.0 {
            return None;
        }
        let s = disc.sqrt();
        let e0 = (-bb - s) / (2.0 * aa);
        let e1 = (-bb + s) / (2.0 * aa);
        if e1 < 0.0 || e0 > 1.0 {
            return None;
        }
        (e0.max(0.0), e1.min(1.0))
    };
    let ya = a.y + (b.y - a.y) * t0;
    let yb = a.y + (b.y - a.y) * t1;
    let (ylo, yhi) = if ya < yb { (ya, yb) } else { (yb, ya) };
    if ylo > center_y + band || yhi < center_y - band {
        return None;
    }
    Some(t0)
}

pub fn update_projectiles(w: &mut World, dt: f32) {
    // (projectile index, impact point, impact height, reason, structure hit, vehicle hit)
    // reason: 1 terrain, 2 water, 3 structure, 4 vehicle
    let mut hits: Vec<(usize, Vec2, f32, u8, i32, i32)> = Vec::new();
    let n = w.projs.len();
    for i in 0..n {
        if w.projs[i].life <= 0.0 {
            continue;
        }
        // Homing: steer towards the target with a limited turn rate, until the lock expires.
        if w.projs[i].homing && w.projs[i].homing_t > 0.0 {
            w.projs[i].homing_t -= dt;
            let tgt = w.projs[i].target;
            let tp = if tgt >= 0 {
                w.vehicle_index(tgt as u32)
                    .filter(|vi| w.vehicles[*vi].alive())
                    .map(|vi| {
                        let v = &w.vehicles[vi];
                        v3(v.pos.x, v.center_y(), v.pos.y)
                    })
            } else {
                None
            };
            if let Some(tp) = tp {
                let cur = w.projs[i].vel.norm();
                let speed = w.projs[i].vel.len();
                let want = (tp - w.projs[i].pos).norm();
                let nd = cur + (want - cur) * (2.4 * dt).min(1.0);
                w.projs[i].vel = nd.norm() * speed;
            }
        }

        let (prev, mut vel, gravity, mut life) = {
            let p = &w.projs[i];
            (p.pos, p.vel, p.gravity, p.life)
        };
        let mut pos = prev;
        vel.y -= gravity * dt;
        pos += vel * dt;
        life -= dt;
        {
            let p = &mut w.projs[i];
            p.pos = pos;
            p.vel = vel;
            p.life = life;
        }
        if life <= 0.0 || pos.y < -30.0 {
            continue;
        }

        let gp = v2(pos.x, pos.z);
        let gh = w.map.height_at(gp.x, gp.y);
        // Rounds stop at the sea SURFACE, not at the sea bed, so they cannot fly through
        // water and burst on the far bank.
        let surface = if gh <= w.map.water_level { w.map.water_level } else { gh };
        if pos.y <= surface {
            let reason = if gh <= w.map.water_level { 2 } else { 1 };
            hits.push((i, gp, surface, reason, -1, -1));
            continue;
        }
        if let Some((si, sy)) = ray_hit_structure(w, gp, pos.y) {
            hits.push((i, gp, sy, 3, si as i32, -1));
            continue;
        }
        let mut hit_vi: i32 = -1;
        let mut hit_t = f32::MAX;
        for vi in 0..w.vehicles.len() {
            let v = &w.vehicles[vi];
            if !v.alive() || v.id == w.projs[i].owner || v.team == w.projs[i].team {
                continue;
            }
            let spec = v.spec();
            // SWEPT, not end-point: a 20 mm round at 210 m/s moves 3.5 m per 1/60 s tick, so
            // testing only where the step ended sampled either side of a helicopter's few-metre
            // airframe and let most shots that should have hit sweep straight through it.
            if let Some(t) = segment_enter_cylinder(
                prev,
                pos,
                v.pos,
                v.center_y(),
                spec.radius + 0.9,
                spec.height * 0.75 + 0.6,
            ) {
                // The round hits the first hull along the step, whichever order they are in.
                if t < hit_t {
                    hit_t = t;
                    hit_vi = vi as i32;
                }
            }
        }
        if hit_vi >= 0 {
            let v = &w.vehicles[hit_vi as usize];
            hits.push((i, v.pos, v.center_y(), 4, -1, hit_vi));
        }
    }

    for (i, gp, y, reason, si, vi) in hits {
        if i >= w.projs.len() || w.projs[i].life <= 0.0 {
            continue;
        }
        let pr = w.projs[i].clone();
        w.projs[i].life = 0.0;
        let by_player = w
            .vehicle_index(pr.owner)
            .map(|oi| w.vehicles[oi].player as i32 - 1)
            .unwrap_or(-1);
        match reason {
            2 => {
                w.push_event(ekind::WATER_SPLASH, gp, 0.2, 0.0, 1.6, 0.0, 0.0, 0.0);
                w.sound(sfx::IMPACT_WATER, gp, y, 0.7);
            }
            1 => {
                w.push_event(ekind::DUST, gp, y, 0.0, 1.6, 0.0, 0.0, 0.0);
                w.sound(sfx::IMPACT_GROUND, gp, y, 0.7);
            }
            3 => {
                w.push_event(ekind::IMPACT, gp, y, 0.0, 1.2, 0.0, 0.0, 0.0);
                w.sound(sfx::IMPACT_METAL, gp, y, 0.7);
                damage_structure(w, si as usize, pr.damage, pr.team);
            }
            _ => {
                w.push_event(ekind::IMPACT, gp, y, 0.0, 1.0, 0.0, 0.0, 0.0);
                w.sound(sfx::IMPACT_METAL, gp, y, 0.7);
                damage_vehicle(w, vi as usize, pr.damage, pr.team, by_player);
            }
        }
        if pr.damage >= 40.0 || pr.splash > 0.0 {
            w.explosion(gp, y, (pr.damage / 120.0).clamp(0.45, 2.2));
        }
        if pr.splash > 0.0 {
            splash(w, gp, y, pr.splash, pr.splash_damage, pr.team, by_player);
        }
    }
    w.projs.retain(|p| p.life > 0.0 && p.pos.y > -30.0);
}

/// Cheap point-vs-structure test; returns the structure index and its top height.
fn ray_hit_structure(w: &World, p: Vec2, y: f32) -> Option<(usize, f32)> {
    let mut buf = Vec::with_capacity(16);
    w.grid.query(p, 0.5, &mut buf);
    for si in buf {
        let s = &w.map.structures[si as usize];
        if !s.solid() {
            continue;
        }
        if y > s.y + s.h || y < s.y - 1.0 {
            continue;
        }
        if s.dist_to(p) <= 0.35 {
            return Some((si as usize, y));
        }
    }
    None
}

pub fn splash(w: &mut World, center: Vec2, y: f32, radius: f32, damage: f32, team: u8, by_player: i32) {
    for vi in 0..w.vehicles.len() {
        let v = &w.vehicles[vi];
        if !v.alive() {
            continue;
        }
        let d = v.pos.dist(center);
        let dy = (v.center_y() - y).abs();
        let r = radius + v.spec().radius;
        if d < r && dy < radius + v.spec().height {
            let falloff = 1.0 - (d / r).clamp(0.0, 1.0);
            let dmg = damage * falloff;
            if v.team == team && dmg < 25.0 {
                continue; // friendly fire only hurts at close range
            }
            damage_vehicle(w, vi, dmg, team, by_player);
        }
    }
    let mut buf = Vec::with_capacity(32);
    w.grid.query(center, radius + 2.0, &mut buf);
    for si in buf {
        let s = &w.map.structures[si as usize];
        if !s.alive() || !s.flag(sflag::DESTRUCTIBLE) {
            continue;
        }
        let d = s.dist_to(center);
        if d < radius + 1.5 && (s.y - y).abs() < radius + s.h {
            let falloff = 1.0 - (d / (radius + 1.5)).clamp(0.0, 1.0);
            damage_structure(w, si as usize, damage * 0.85 * falloff, team);
        }
    }
    // Splash can also chain-detonate mines.
    for mi in 0..w.mines.len() {
        if w.mines[mi].armed > 0.0 && w.mines[mi].pos.dist(center) < radius + 1.0 {
            w.mines[mi].armed = -1.0;
            let p = w.mines[mi].pos;
            detonate_mine(w, mi, p);
        }
    }
}

/// The fireball where a downed helicopter comes down. A Cobra carries ~900 kg of fuel, and the
/// blast is sized to what a crash should do: a direct or very-near hit is always lethal (the
/// toughest hull has 400 hp, the centre deals 700), wall sections (250) and buildings (500) are
/// levelled on a direct hit, and only a garage/HQ core (800) survives one as more than a ruin.
pub const HELI_CRASH_RADIUS: f32 = 12.0;
pub const HELI_CRASH_DAMAGE: f32 = 700.0;

/// Apply the impact blast of a downed helicopter at `p`. Called exactly once per crash - from
/// `World::kill_vehicle` when the hull dies on the ground (low hover, fuel out at deck level),
/// and from the wreck's ground contact in `integrate_wrecks` when it fell. Drones are
/// deliberately excluded at both sites: a 60 hp recon bird should not level a tank. No kill
/// credit (`by_player = -1`): the fireball is environmental, whoever shot the heli down or not.
pub fn heli_crash_blast(w: &mut World, p: Vec2, y: f32, team: u8) {
    splash(w, p, y, HELI_CRASH_RADIUS, HELI_CRASH_DAMAGE, team, -1);
}

pub fn damage_vehicle(w: &mut World, vi: usize, dmg: f32, by_team: u8, by_player: i32) {
    if vi >= w.vehicles.len() || !w.vehicles[vi].alive() {
        return;
    }
    // Spawn protection: immune for a few seconds after leaving the garage, and while sitting
    // inside its own home zone with protection still on the clock. Both are the same rule
    // attackers use to decide whether the target is worth aiming at, so a shot already in the
    // air cannot beat it either.
    if w.protected_from_attack(vi) {
        return;
    }
    let team = w.vehicles[vi].team;
    // Turret towers never friendly-fire each other's team.
    if by_team == team && dmg < 30.0 {
        return;
    }
    w.vehicles[vi].hp -= dmg;
    w.vehicles[vi].hit_flash = 1.0;
    let p = w.vehicles[vi].pos;
    let y = w.vehicles[vi].center_y();
    w.push_event(ekind::IMPACT, p, y, 0.0, 0.7, 0.0, 0.0, 0.0);
    if w.vehicles[vi].hp <= 0.0 {
        w.kill_vehicle(vi, by_player);
    }
}

pub fn damage_structure(w: &mut World, si: usize, dmg: f32, by_team: u8) {
    if si >= w.map.structures.len() {
        return;
    }
    if !w.map.structures[si].alive() || !w.map.structures[si].flag(sflag::DESTRUCTIBLE) {
        return;
    }
    let s = w.map.structures[si];
    if s.team >= 0.0 && s.team < 2.0 && s.team as u8 == by_team && s.kind as u8 != skind::PALM {
        // Own-team structures still take splash, but much less.
    }
    w.map.structures[si].hp -= dmg;
    let p = w.map.structures[si].pos();
    let y = w.map.structures[si].y + w.map.structures[si].h * 0.5;
    w.push_event(ekind::IMPACT, p, y, 0.0, 0.9, 0.0, 0.0, 0.0);
    if w.map.structures[si].hp <= 0.0 {
        destroy_structure(w, si);
    }
}

fn destroy_structure(w: &mut World, si: usize) {
    let s = w.map.structures[si];
    let kind = s.kind as u8;
    let p = s.pos();
    let y = s.y + s.h * 0.5;
    w.map.structures[si].set_flag(sflag::DEAD, true);
    w.map.structures[si].hp = 0.0;
    let scale = (s.h * 0.25 + 0.8).clamp(0.8, 2.4);
    w.explosion(p, y, scale);
    w.push_event(ekind::DEBRIS, p, s.y, 0.0, 16.0, 0.5, 0.0, 0.0);

    // Everything that was solid leaves rubble that still blocks vehicles.
    if s.flag(sflag::SOLID) {
        block_footprint(w, si, true);
    }
    match kind {
        skind::BRIDGE => {
            w.notify(notify::BRIDGE_DOWN, 0);
            w.sound(sfx::BRIDGE_COLLAPSE, p, y, 1.0);
        }
        skind::TURRET_TOWER => {
            w.notify(notify::TOWER_DOWN, 0);
            for t in w.turrets.iter_mut() {
                if t.struct_id == si as u32 {
                    t.alive = false;
                }
            }
        }
        skind::BARREL => {
            // Barrels cook off and hurt whatever is nearby.
            splash(w, p, y, 6.0, 70.0, s.team as u8, -1);
        }
        skind::BUILDING | skind::HQ | skind::TENT | skind::CONTAINER => {
            // Only a side's building leaves defenders behind. On a procedural map every town
            // block, hamlet building and landmark is owned by **team 2** — the neutral owner a
            // prop is given — and there is no third spawn pad, so passing that owner on to
            // `spawn_vehicle` indexed `map.spawn[2]` and panicked: shooting a town building took
            // the match down with it.
            if s.team < 2.0 {
                crate::ai::spawn_troops_from(w, p, s.team as u8, 1 + (s.h as u32 % 3));
            }
        }
        _ => {}
    }
}

/// Mark (or clear) the nav cells covered by a structure footprint as dynamically blocked.
fn block_footprint(w: &mut World, si: usize, blocked: bool) {
    let s = w.map.structures[si];
    let (min, max) = s.bounds();
    let cell = w.map.cell;
    let g = w.map.grid as i32;
    let x0 = ((min.x / cell).floor() as i32).clamp(0, g - 1);
    let z0 = ((min.y / cell).floor() as i32).clamp(0, g - 1);
    let x1 = ((max.x / cell).ceil() as i32).clamp(0, g - 1);
    let z1 = ((max.y / cell).ceil() as i32).clamp(0, g - 1);
    let mut idxs = [0usize; 4096];
    let mut count = 0usize;
    for z in z0..=z1 {
        for x in x0..=x1 {
            let c = v2((x as f32 + 0.5) * cell, (z as f32 + 0.5) * cell);
            if s.dist_to(c) < cell * 0.75 {
                let i = (z * g + x) as usize;
                if count < idxs.len() {
                    idxs[count] = i;
                    count += 1;
                }
            }
        }
    }
    for i in &idxs[..count] {
        w.dyn_block[*i] = blocked;
    }
}

pub fn update_mines(w: &mut World, dt: f32) {
    let mut boom: Vec<(usize, Vec2)> = Vec::new();
    for mi in 0..w.mines.len() {
        if w.mines[mi].armed < 0.0 {
            continue;
        }
        if w.mines[mi].armed < 1.0 {
            w.mines[mi].armed += dt;
            continue;
        }
        w.mines[mi].blink += dt;
        let mp = w.mines[mi].pos;
        let mteam = w.mines[mi].team;
        for vi in 0..w.vehicles.len() {
            let v = &w.vehicles[vi];
            if !v.alive() || v.team == mteam || v.airborne {
                continue;
            }
            // A protected hull does not set mines off: the shield refusing the damage but the
            // charge still cooking off under the pad would be a nasty surprise the moment the
            // player first moved.
            if w.protected_from_attack(vi) {
                continue;
            }
            let spec = v.spec();
            if spec.flying || v.alt > 1.5 {
                continue;
            }
            if v.pos.dist(mp) < spec.radius + 1.6 {
                boom.push((mi, mp));
                break;
            }
        }
    }
    for (mi, p) in boom {
        detonate_mine(w, mi, p);
    }
}

pub fn detonate_mine(w: &mut World, mi: usize, p: Vec2) {
    let team = w.mines[mi].team;
    w.mines[mi].armed = -1.0;
    let y = w.map.height_at(p.x, p.y);
    w.explosion(p, y + 0.6, 1.8);
    w.sound(sfx::MINE_BLAST, p, y, 1.0);
    let owner = w
        .mines
        .get(mi)
        .map(|m| m.id)
        .unwrap_or(0);
    let _ = owner;
    // Mines destroy any land vehicle outright, friend or foe.
    for vi in 0..w.vehicles.len() {
        let v = &w.vehicles[vi];
        if !v.alive() || v.airborne || v.spec().flying {
            continue;
        }
        if v.pos.dist(p) < 4.2 {
            let dmg = if v.team == team { v.hp } else { v.hp.max(180.0) };
            damage_vehicle(w, vi, dmg, team, -1);
        }
    }
    splash(w, p, y, 5.0, 60.0, team, -1);
}

/// Helicopter rockets can clear mines (a nod to the original's mine-sweeping).
pub fn clear_mine_at(w: &mut World, p: Vec2, radius: f32, team: u8) {
    for mi in 0..w.mines.len() {
        if w.mines[mi].armed >= 0.0 && w.mines[mi].team != team && w.mines[mi].pos.dist(p) < radius {
            detonate_mine(w, mi, w.mines[mi].pos);
        }
    }
}

/// Convenience for the AI: pick the best weapon for a target range.
pub fn weapon_for_range(spec: &crate::spec::VehicleSpec, range: f32) -> usize {
    let w1 = &spec.weapon1;
    if w1.damage > 0.0 && range > spec.weapon0.range * 0.6 && spec.kind != vkind::HRSV {
        return 1;
    }
    0
}

pub fn default_weapon() -> &'static WeaponSpec {
    &weapon::TANK_SHELL
}

pub fn vehicle_weapon(kind: u8, idx: usize) -> &'static WeaponSpec {
    let s = vehicle::spec(kind);
    if idx == 1 {
        &s.weapon1
    } else {
        &s.weapon0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tunnelling case the sweep exists for: a 20 mm round covers 3.5 m per tick
    /// (`HELI_CANNON.speed / 60`), and a near-tangent pass through a drone's cylinder puts both
    /// tick samples outside it. The end-point test this replaced called that a miss.
    #[test]
    fn swept_hit_test_catches_a_round_that_crosses_between_ticks() {
        let step = weapon::HELI_CANNON.speed / 60.0;
        assert!((3.4..3.6).contains(&step), "step moved to {step} m; revisit this test");
        let r = vehicle::DRONE.radius + 0.9;
        let band = vehicle::DRONE.height * 0.75 + 0.6;
        // Perpendicular offset of 2.1 m from a 2.5 m cylinder: both ends of a 3.5 m step sit
        // outside it, but the segment between them is inside.
        let off = 2.1f32;
        let a = v3(-step * 0.5, 3.0, off);
        let b = v3(step * 0.5, 3.0, off);
        assert!(v2(a.x, a.z).len() > r, "start of step is already inside the cylinder");
        assert!(v2(b.x, b.z).len() > r, "end of step is already inside the cylinder");
        assert!(
            segment_enter_cylinder(a, b, Vec2::ZERO, 3.0, r, band).is_some(),
            "the sweep missed a segment that passes through the cylinder"
        );
        // And the same geometry with the round passing over the hull is a clean miss.
        assert!(segment_enter_cylinder(
            v3(-step * 0.5, 3.0, off),
            v3(step * 0.5, 3.0, off),
            Vec2::ZERO,
            3.0 + band + 2.0,
            r,
            band
        )
        .is_none());
        // Straight through the middle still hits, at the entry point.
        assert!(segment_enter_cylinder(
            v3(-step * 0.5, 3.0, 0.0),
            v3(step * 0.5, 3.0, 0.0),
            Vec2::ZERO,
            3.0,
            r,
            band
        )
        .is_some());
    }
}
