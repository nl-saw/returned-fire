//! Vehicle + weapon tuning tables. Faithful-ish to the 1995 original:
//! jeep (fast, 1 hit to kill, carries flags, swims), tank (360° turret, long range),
//! HRSV/MLRS (slowest, toughest, heat-seeking missiles + mines),
//! helicopter (fast, fragile, must rearm at base).



#[derive(Clone, Copy, Debug)]
pub struct WeaponSpec {
    pub name: &'static str,
    /// Damage applied on a direct hit.
    pub damage: f32,
    /// Splash radius in metres (0 = none).
    pub splash: f32,
    /// Splash damage at the centre (falls off linearly to 0 at `splash`).
    pub splash_damage: f32,
    /// Muzzle speed m/s.
    pub speed: f32,
    /// Seconds between shots while the trigger is held.
    pub cooldown: f32,
    /// Rounds per trigger pull (burst).
    pub burst: u32,
    /// Seconds between rounds inside a burst.
    pub burst_gap: f32,
    /// Gravity applied to the projectile (m/s^2). Shells/grenades arc slightly.
    pub gravity: f32,
    /// Indirect-fire weapon: launched on a high arc instead of straight down the sight.
    pub lobbed: bool,
    /// Max lifetime seconds.
    pub life: f32,
    /// Inaccuracy cone (radians, half-angle).
    pub spread: f32,
    /// Projectile kind (see `types::pkind`).
    pub pkind: u8,
    /// Weapon can only be fired when roughly stationary.
    pub must_stop: bool,
    /// Minimum range: cannot fire at targets closer than this.
    pub min_range: f32,
    /// Effective range hint used by the AI.
    pub range: f32,
    /// Projectile is guided towards the locked target.
    pub homing: bool,
    /// Seconds of guided flight. 0 = the pkind default (turret SAMs 1.6 s, submarine
    /// heat-seekers 8 s); a positive value overrides it for this weapon.
    pub homing_lock: f32,
    /// Maximum radians of upward pitch added to the launch direction at full weapon range;
    /// `fire` scales it down by the distance to the locked target, so a round at point-blank
    /// flies level and one at stand-off leaves on a high arc. That arc is what lets a
    /// heat-seeker clear intervening terrain — which a gunner can see over but a
    /// level-flying round cannot — before homing brings it back down on target. 0 = level
    /// direct flight (turret SAMs, submarine seekers).
    pub launch_climb: f32,
    /// Sound id played when firing.
    pub sfx: f32,
    /// Muzzle offset from the vehicle centre (forward, up).
    pub muzzle_fwd: f32,
    pub muzzle_up: f32,
    /// Recoil impulse applied to the firing vehicle.
    pub recoil: f32,
}

pub mod weapon {
    use super::WeaponSpec;

    pub const NONE: WeaponSpec = WeaponSpec {
        name: "none",
        damage: 0.0,
        splash: 0.0,
        splash_damage: 0.0,
        speed: 0.0,
        cooldown: 1.0,
        burst: 0,
        burst_gap: 0.0,
        gravity: 0.0,
        lobbed: false,
        life: 0.0,
        spread: 0.0,
        pkind: 0,
        must_stop: false,
        min_range: 0.0,
        range: 0.0,
        homing: false,
        homing_lock: 0.0,
        launch_climb: 0.0,
        sfx: 0.0,
        muzzle_fwd: 0.0,
        muzzle_up: 0.0,
        recoil: 0.0,
    };

    /// M60 main gun: 150 shells, 5 shells kill a turret tower.
    pub const TANK_SHELL: WeaponSpec = WeaponSpec {
        name: "120mm",
        damage: 100.0,
        splash: 2.4,
        splash_damage: 45.0,
        speed: 145.0,
        cooldown: 1.15,
        burst: 1,
        burst_gap: 0.0,
        gravity: 6.0,
        lobbed: false,
        life: 3.0,
        spread: 0.006,
        pkind: crate::types::pkind::SHELL,
        must_stop: false,
        min_range: 0.0,
        range: 150.0,
        homing: false,
        homing_lock: 0.0,
        launch_climb: 0.0,
        sfx: crate::types::sfx::GUN_TANK,
        muzzle_fwd: 3.55, // model anchor: barrel tip (ring 1.38 + trunnion, 2.2 m barrel)
        muzzle_up: 0.55,
        recoil: 5.0,
    };

    /// Helicopter chin gun: rapid, 100 rounds.
    pub const HELI_CANNON: WeaponSpec = WeaponSpec {
        name: "20mm",
        damage: 55.0,
        splash: 0.9,
        splash_damage: 12.0,
        speed: 210.0,
        cooldown: 0.16,
        burst: 1,
        burst_gap: 0.0,
        gravity: 3.0,
        lobbed: false,
        life: 4.0,
        spread: 0.012,
        pkind: crate::types::pkind::BULLET,
        must_stop: false,
        min_range: 0.0,
        range: 120.0,
        homing: false,
        homing_lock: 0.0,
        launch_climb: 0.0,
        sfx: crate::types::sfx::GUN_CHAIN,
        muzzle_fwd: 4.13, // model anchor: chin-gun tip, 4.13 m ahead of the hull centre
        muzzle_up: -0.47,
        recoil: 0.6,
    };

    /// Helicopter rocket pods: 50 rockets, 2 rockets kill a tower.
    pub const HELI_ROCKET: WeaponSpec = WeaponSpec {
        name: "70mm",
        damage: 250.0,
        splash: 4.5,
        splash_damage: 120.0,
        speed: 95.0,
        cooldown: 0.55,
        burst: 2,
        burst_gap: 0.12,
        gravity: 0.0,
        lobbed: false,
        life: 7.0,
        spread: 0.01,
        pkind: crate::types::pkind::ROCKET,
        must_stop: false,
        min_range: 0.0,
        range: 170.0,
        homing: false,
        homing_lock: 0.0,
        launch_climb: 0.0,
        sfx: crate::types::sfx::ROCKET_LAUNCH,
        muzzle_fwd: 1.36, // model anchor: right rocket pod
        muzzle_up: -0.32,
        recoil: 0.4,
    };

    /// HRSV heat-seeker: 100 missiles, guided for 3.5 s then ballistic. Replaces the old
    /// lobbed rocket barrage — a round that homes on its target instead of arcing at where
    /// it was, which is what makes the MLRS dangerous at every range rather than only in a
    /// stand-off band. The lock is far longer than a turret SAM's 1.6 s (a jink beats that)
    /// but shorter than the submarine's 8 s heavyweight, so a sustained evasive pattern can
    /// still shake it.
    pub const HRSV_ROCKET: WeaponSpec = WeaponSpec {
        name: "MLRS",
        damage: 150.0,
        splash: 5.5,
        splash_damage: 90.0,
        speed: 78.0,
        cooldown: 0.85,
        burst: 2,
        burst_gap: 0.16,
        gravity: 0.0,
        lobbed: false,
        life: 7.0,
        spread: 0.005,
        pkind: crate::types::pkind::MISSILE,
        must_stop: false,
        min_range: 0.0,
        range: 190.0,
        homing: true,
        homing_lock: 3.5,
        launch_climb: 0.15, // ~8.6 deg at full range, scaled by distance (see the field doc)
        sfx: crate::types::sfx::ROCKET_LAUNCH,
        muzzle_fwd: 0.74, // model anchor: elevating pod mouth (parked at +0.13 rad)
        muzzle_up: 0.98,
        recoil: 1.2,
    };

    /// Jeep grenades: 16, lobbed, same punch as a tank shell but short ranged.
    pub const JEEP_GRENADE: WeaponSpec = WeaponSpec {
        name: "Mk2",
        damage: 100.0,
        splash: 3.2,
        splash_damage: 60.0,
        speed: 34.0,
        cooldown: 0.7,
        burst: 1,
        burst_gap: 0.0,
        gravity: 22.0,
        lobbed: true,
        life: 5.0,
        spread: 0.0,
        pkind: crate::types::pkind::GRENADE,
        must_stop: false,
        min_range: 0.0,
        range: 62.0,
        homing: false,
        homing_lock: 0.0,
        launch_climb: 0.0,
        sfx: crate::types::sfx::GRENADE_THROW,
        muzzle_fwd: 1.10, // model anchor: pintle launcher barrel tip, hull-local (0, 1.77, 1.10)
        muzzle_up: 0.82,  // = 1.77 - the jeep's centerY (0.95); see vehicles.ts `buildJeep`
        recoil: 0.0,
    };

    /// Turret tower missile: as strong as a tank shell, slow to rotate and reload.
    pub const TOWER_MISSILE: WeaponSpec = WeaponSpec {
        name: "SAM",
        damage: 100.0,
        splash: 3.0,
        splash_damage: 50.0,
        speed: 72.0,
        cooldown: 3.4,
        burst: 1,
        burst_gap: 0.0,
        gravity: 0.0,
        lobbed: false,
        life: 5.0,
        spread: 0.01,
        pkind: crate::types::pkind::MISSILE,
        must_stop: false,
        min_range: 6.0,
        range: 58.0,
        homing: true,
        homing_lock: 0.0, // pkind default: the short 1.6 s lock a jink can break
        launch_climb: 0.0,
        sfx: crate::types::sfx::TOWER_FIRE,
        muzzle_fwd: 1.2,
        muzzle_up: 0.6,
        recoil: 0.0,
    };

    /// Drone machine gun sweep.
    pub const DRONE_GUN: WeaponSpec = WeaponSpec {
        name: "drone gun",
        damage: 9.0,
        splash: 0.0,
        splash_damage: 0.0,
        speed: 190.0,
        cooldown: 0.1,
        burst: 1,
        burst_gap: 0.0,
        gravity: 2.0,
        lobbed: false,
        life: 1.6,
        spread: 0.05,
        pkind: crate::types::pkind::BULLET,
        must_stop: false,
        min_range: 0.0,
        range: 70.0,
        homing: false,
        homing_lock: 0.0,
        launch_climb: 0.0,
        sfx: crate::types::sfx::GUN_CHAIN,
        muzzle_fwd: 1.33, // model anchor: underslung gun pod
        muzzle_up: -0.13,
        recoil: 0.0,
    };

    /// Submarine heat-seeker fired at players who leave the play area.
    pub const SUB_MISSILE: WeaponSpec = WeaponSpec {
        name: "sub missile",
        damage: 250.0,
        splash: 5.0,
        splash_damage: 120.0,
        speed: 58.0,
        cooldown: 6.0,
        burst: 1,
        burst_gap: 0.0,
        gravity: 0.0,
        lobbed: false,
        life: 14.0,
        spread: 0.0,
        pkind: crate::types::pkind::HOMING,
        must_stop: false,
        min_range: 0.0,
        range: 400.0,
        homing: true,
        homing_lock: 0.0, // pkind default: the long 8 s lock of the heavyweight seeker
        launch_climb: 0.0,
        sfx: crate::types::sfx::SUB_LAUNCH,
        muzzle_fwd: 0.49, // model anchor: launcher tube mouth
        muzzle_up: 1.02,
        recoil: 0.0,
    };

    /// Infantry grenade.
    pub const TROOP_GRENADE: WeaponSpec = WeaponSpec {
        name: "inf grenade",
        damage: 60.0,
        splash: 2.6,
        splash_damage: 30.0,
        speed: 26.0,
        cooldown: 1.6,
        burst: 1,
        burst_gap: 0.0,
        gravity: 20.0,
        lobbed: true,
        life: 3.0,
        spread: 0.06,
        pkind: crate::types::pkind::GRENADE,
        must_stop: false,
        min_range: 8.0,
        range: 45.0,
        homing: false,
        homing_lock: 0.0,
        launch_climb: 0.0,
        sfx: crate::types::sfx::GRENADE_THROW,
        muzzle_fwd: 0.77, // model anchor: rifle muzzle
        muzzle_up: 0.33,
        recoil: 0.0,
    };

/// Every weapon spec, in `wkind` order: the compiled-in defaults the tuning table starts from.
pub const ALL: [WeaponSpec; super::wkind::COUNT] = [
    NONE,
    TANK_SHELL,
    HELI_CANNON,
    HELI_ROCKET,
    HRSV_ROCKET,
    JEEP_GRENADE,
    TOWER_MISSILE,
    DRONE_GUN,
    SUB_MISSILE,
    TROOP_GRENADE,
];
}

#[derive(Clone, Copy, Debug)]
pub struct VehicleSpec {
    pub name: &'static str,
    pub kind: u8,
    pub hp: f32,
    /// Top speed forward (m/s).
    pub speed: f32,
    /// Top speed reverse (m/s).
    pub reverse: f32,
    /// Acceleration (m/s^2).
    pub accel: f32,
    /// Braking deceleration (m/s^2).
    pub brake: f32,
    /// Turn rate at low speed (rad/s).
    pub turn_lo: f32,
    /// Turn rate at top speed (rad/s).
    pub turn_hi: f32,
    /// Seconds of full-throttle fuel.
    pub fuel_time: f32,
    /// Idle fuel burn fraction of full burn.
    pub idle_burn: f32,
    pub fuel_max: f32,
    pub ammo0_max: f32,
    pub ammo1_max: f32,
    pub mine_max: f32,
    /// Turret traverse speed (rad/s); 0 = turret locked to hull.
    pub turret_speed: f32,
    /// Turret can rotate a full 360; otherwise limited arc.
    pub turret_arc: f32,
    pub can_carry_flag: bool,
    pub amphibious: bool,
    pub flying: bool,
    /// Collision radius (m).
    pub radius: f32,
    pub length: f32,
    pub width: f32,
    pub height: f32,
    /// Hover height above the ground for flying vehicles.
    pub cruise_alt: f32,
    pub climb_rate: f32,
    pub weapon0: WeaponSpec,
    pub weapon1: WeaponSpec,
    /// Seconds to rebuild this vehicle in the base garage.
    pub build_time: f32,
    /// Vision / AI engagement range.
    pub sight: f32,
    /// Camera distance multiplier for this vehicle.
    pub cam_scale: f32,
    /// Engine tone id (see audio.ts).
    pub engine: u8,

}

/// Index and name for every weapon in `ALL`. The index is what the tuning config's flat value
/// array uses, and the name is the key the config file writes (`weapons.heli_cannon.life`).
pub mod wkind {
    pub const NONE: usize = 0;
    pub const TANK_SHELL: usize = 1;
    pub const HELI_CANNON: usize = 2;
    pub const HELI_ROCKET: usize = 3;
    pub const HRSV_ROCKET: usize = 4;
    pub const JEEP_GRENADE: usize = 5;
    pub const TOWER_MISSILE: usize = 6;
    pub const DRONE_GUN: usize = 7;
    pub const SUB_MISSILE: usize = 8;
    pub const TROOP_GRENADE: usize = 9;
    pub const COUNT: usize = 10;
    pub const KEYS: [&str; COUNT] = [
        "none",
        "tank_shell",
        "heli_cannon",
        "heli_rocket",
        "hrsv_rocket",
        "jeep_grenade",
        "tower_missile",
        "drone_gun",
        "sub_missile",
        "troop_grenade",
    ];
}

pub mod vehicle {
    use super::{weapon, VehicleSpec};
    use crate::types::vkind;

    pub const JEEP: VehicleSpec = VehicleSpec {
        name: "M151 MUTT",
        kind: vkind::JEEP,
        hp: 100.0,
        speed: 25.0,
        reverse: 9.0,
        accel: 13.0,
        brake: 22.0,
        turn_lo: 2.05,
        turn_hi: 1.15,
        fuel_time: 105.0,
        idle_burn: 0.12,
        fuel_max: 100.0,
        ammo0_max: 16.0,
        ammo1_max: 0.0,
        mine_max: 0.0,
        // The gunner traverses the pedestal launcher, so the grenade follows the mouse like
        // every other gun (the model carries that mount: `buildJeep` in
        // `web/src/assets/models/vehicles.ts`).
        // It used to be `turret_speed: 0.0` (locked to the hull), which meant a free crosshair
        // the weapon could not follow: measured in the browser, the jeep's turret yaw never
        // moved off its hull yaw (40.1 deg) while the crosshair ranged over 300 deg, and a
        // grenade aimed at a point 15 m ahead burst 56 m away on the hull's own bearing.
        turret_speed: 3.2,
        turret_arc: core::f32::consts::PI,
        can_carry_flag: true,
        amphibious: true,
        flying: false,
        radius: 1.5,
        length: 4.1,
        width: 2.0,
        height: 1.9,
        cruise_alt: 0.0,
        climb_rate: 0.0,
        weapon0: weapon::JEEP_GRENADE,
        weapon1: weapon::NONE,
        build_time: 6.0,
        sight: 58.0,
        cam_scale: 0.72,
        engine: 1,
    };

    pub const TANK: VehicleSpec = VehicleSpec {
        name: "M60 Patton",
        kind: vkind::TANK,
        hp: 300.0,
        speed: 15.5,
        reverse: 6.5,
        accel: 7.0,
        brake: 14.0,
        turn_lo: 1.05,
        turn_hi: 0.62,
        fuel_time: 145.0,
        idle_burn: 0.1,
        fuel_max: 100.0,
        ammo0_max: 150.0,
        ammo1_max: 0.0,
        mine_max: 0.0,
        turret_speed: 1.35,
        turret_arc: core::f32::consts::PI,
        can_carry_flag: false,
        amphibious: false,
        flying: false,
        radius: 2.4,
        length: 6.9,
        width: 3.6,
        height: 2.9,
        cruise_alt: 0.0,
        climb_rate: 0.0,
        weapon0: weapon::TANK_SHELL,
        weapon1: weapon::NONE,
        build_time: 10.0,
        sight: 72.0,
        cam_scale: 1.0,
        engine: 2,
    };

    pub const HRSV: VehicleSpec = VehicleSpec {
        name: "M270 MLRS",
        kind: vkind::HRSV,
        hp: 400.0,
        speed: 9.2,
        reverse: 4.0,
        // Tracked, like the tank, and it has to be able to climb what the nav grid calls
        // drivable. At 4.0 the slope cost in `physics::step_ground` (capped now, but still
        // 0.6 * accel) left it crawling: an AI MLRS covered 50 m in a 240 s match with a
        // quarter of its ticks at a standstill, and threw 2 of its 6 rounds while moving. At
        // 7.0 the same match covers 178 m each, sits still 10% of the time and fires 15 of 17
        // rounds on the move - "it doesn't drive far, make it able to shoot while driving".
        accel: 7.0,
        brake: 8.0,
        turn_lo: 0.72,
        turn_hi: 0.42,
        fuel_time: 175.0,
        idle_burn: 0.08,
        fuel_max: 100.0,
        ammo0_max: 100.0,
        ammo1_max: 10.0,
        mine_max: 10.0,
        turret_speed: 0.85,
        turret_arc: core::f32::consts::PI,
        can_carry_flag: false,
        amphibious: false,
        flying: false,
        radius: 2.7,
        length: 7.0,
        width: 3.2,
        height: 3.1,
        cruise_alt: 0.0,
        climb_rate: 0.0,
        weapon0: weapon::HRSV_ROCKET,
        weapon1: weapon::NONE,
        build_time: 12.0,
        sight: 80.0,
        cam_scale: 1.08,
        engine: 3,
    };

    pub const HELI: VehicleSpec = VehicleSpec {
        name: "AH-1 Cobra",
        kind: vkind::HELI,
        hp: 200.0,
        // 1.5x the old 30 m/s. The player's "the helicopter is too slow" was really that
        // 30 was never reached: `physics::step_air` bled a `1 + 0.02 * v` factor every
        // second, so the old `accel: 11` settled at `v(1 + 0.02v) = 11` => about 9.1 m/s
        // (measured by `sim_logic::helicopter_reaches_its_advertised_top_speed`). 45 m/s
        // (162 km/h) is 1.8x the jeep and still inside the 44-48 band.
        speed: 45.0,
        reverse: 12.0,
        // Sized for feel under the corrected drag model, which makes the terminal speed
        // exactly `spec.speed` rather than a function of this number: 0-40 m/s in about
        // 2.9 s, 90 % of top speed in 4.1 s. The first fix for this bug raised `accel` to
        // 92 m/s^2 instead, which reached 44 m/s in 1.15 s but also scaled the lateral
        // strafe term (`accel * 0.8`) to 7 g - a sidestep no helicopter should survive.
        accel: 16.0,
        brake: 10.0,
        turn_lo: 1.75,
        turn_hi: 1.35,
        fuel_time: 78.0,
        idle_burn: 0.3,
        fuel_max: 100.0,
        ammo0_max: 100.0,
        ammo1_max: 50.0,
        mine_max: 0.0,
        turret_speed: 2.2,
        turret_arc: core::f32::consts::PI,
        can_carry_flag: false,
        amphibious: true,
        flying: true,
        radius: 2.6,
        length: 8.4,
        width: 2.2,
        height: 2.6,
        cruise_alt: 14.0,
        climb_rate: 9.0,
        weapon0: weapon::HELI_CANNON,
        weapon1: weapon::HELI_ROCKET,
        build_time: 12.0,
        sight: 92.0,
        cam_scale: 1.15,
        engine: 4,
    };

    pub const TROOP: VehicleSpec = VehicleSpec {
        name: "Infantry",
        kind: vkind::TROOP,
        hp: 20.0,
        speed: 3.4,
        reverse: 1.5,
        accel: 6.0,
        brake: 8.0,
        turn_lo: 4.0,
        turn_hi: 4.0,
        fuel_time: 999.0,
        idle_burn: 0.0,
        fuel_max: 1.0,
        ammo0_max: 4.0,
        ammo1_max: 0.0,
        mine_max: 0.0,
        turret_speed: 0.0,
        turret_arc: 0.0,
        can_carry_flag: false,
        amphibious: true,
        flying: false,
        radius: 0.55,
        length: 0.9,
        width: 0.9,
        height: 1.8,
        cruise_alt: 0.0,
        climb_rate: 0.0,
        weapon0: weapon::TROOP_GRENADE,
        weapon1: weapon::NONE,
        build_time: 0.0,
        sight: 45.0,
        cam_scale: 0.5,
        engine: 0,
    };

    pub const DRONE: VehicleSpec = VehicleSpec {
        name: "Recon drone",
        kind: vkind::DRONE,
        hp: 60.0,
        // This said 22.0, but the drone never flew at 22: the old air drag curve capped it
        // at `v(1 + 0.02v) = 12` => 9.8 m/s. Now that `physics::step_air` makes the terminal
        // speed exactly `spec.speed`, the spec has to say what the drone actually does - so
        // it is 10, the number the drone has always flown at. Raising it to an honest 22
        // would have doubled the speed of the one airborne threat the player has just been
        // given the tools to shoot at (see `physics.rs::aim_air_target`), which is not a
        // change this report asked for.
        speed: 10.0,
        reverse: 8.0,
        accel: 12.0,
        brake: 12.0,
        turn_lo: 2.0,
        turn_hi: 1.6,
        fuel_time: 999.0,
        idle_burn: 0.0,
        fuel_max: 1.0,
        ammo0_max: 999.0,
        ammo1_max: 0.0,
        mine_max: 0.0,
        turret_speed: 0.0,
        turret_arc: 0.0,
        can_carry_flag: false,
        amphibious: true,
        flying: true,
        radius: 1.6,
        length: 2.6,
        width: 2.6,
        height: 1.0,
        cruise_alt: 11.0,
        climb_rate: 7.0,
        weapon0: weapon::DRONE_GUN,
        weapon1: weapon::NONE,
        build_time: 0.0,
        sight: 70.0,
        cam_scale: 0.6,
        engine: 5,
    };

    pub const SUB: VehicleSpec = VehicleSpec {
        name: "Submarine",
        kind: vkind::SUBMARINE,
        hp: 999.0,
        speed: 0.0,
        reverse: 0.0,
        accel: 0.0,
        brake: 0.0,
        turn_lo: 0.0,
        turn_hi: 0.0,
        fuel_time: 999.0,
        idle_burn: 0.0,
        fuel_max: 1.0,
        ammo0_max: 99.0,
        ammo1_max: 0.0,
        mine_max: 0.0,
        turret_speed: 0.4,
        turret_arc: core::f32::consts::PI,
        can_carry_flag: false,
        amphibious: true,
        flying: false,
        radius: 4.0,
        length: 14.0,
        width: 3.0,
        height: 3.0,
        cruise_alt: 0.0,
        climb_rate: 0.0,
        weapon0: weapon::SUB_MISSILE,
        weapon1: weapon::NONE,
        build_time: 0.0,
        sight: 400.0,
        cam_scale: 1.0,
        engine: 0,
    };

    #[inline]
    pub fn spec(kind: u8) -> &'static VehicleSpec {
        match kind {
            vkind::JEEP => &JEEP,
            vkind::TANK => &TANK,
            vkind::HRSV => &HRSV,
            vkind::HELI => &HELI,
            vkind::TROOP => &TROOP,
            vkind::DRONE => &DRONE,
            vkind::SUBMARINE => &SUB,
            _ => &JEEP,
        }
    }

    /// Which weapons a hull mounts, as `wkind` indices. Fixed in code on purpose: what a hull
    /// *is* (its guns, its model, its role) is identity, while what those guns *do* is in the
    /// tuning table - so the same weapon cannot be described twice and drift.
    pub fn weapons_for(kind: u8) -> (usize, usize) {
        use super::wkind;
        match kind {
            vkind::JEEP => (wkind::JEEP_GRENADE, wkind::NONE),
            vkind::TANK => (wkind::TANK_SHELL, wkind::NONE),
            vkind::HRSV => (wkind::HRSV_ROCKET, wkind::NONE),
            vkind::HELI => (wkind::HELI_CANNON, wkind::HELI_ROCKET),
            vkind::TROOP => (wkind::TROOP_GRENADE, wkind::NONE),
            vkind::DRONE => (wkind::DRONE_GUN, wkind::NONE),
            vkind::SUBMARINE => (wkind::SUB_MISSILE, wkind::NONE),
            _ => (wkind::NONE, wkind::NONE),
        }
    }

    /// Order used by the garage UI.
    pub const GARAGE: [u8; 4] = [vkind::JEEP, vkind::TANK, vkind::HRSV, vkind::HELI];
}

/// Global gameplay constants.
pub mod rules {
    /// Vehicles cannot leave this inset border (submarine punishes them if they do).
    pub const BORDER: f32 = 6.0;
    /// Seconds a power-sliding / drifting vehicle keeps its momentum.
    pub const DRIFT_DAMP: f32 = 2.4;
    /// Damage dealt by ramming scales with relative speed.
    pub const RAM_DAMAGE: f32 = 2.2;
    /// How long a burning wreck stays in the world.
    pub const WRECK_TIME: f32 = 14.0;
    /// Fraction of its impact speed a destroyed ground vehicle keeps when it starts to
    /// plough. `kill_vehicle` used to zero `vel` outright, which is the reported
    /// "destroyed vehicles freeze on the spot"; a wreck must still coast a little in the
    /// direction it was last going.
    pub const WRECK_COAST: f32 = 0.65;
    /// Exponential bleed rate (1/s) applied to a coasting wreck until it stops. Sized as a
    /// distance budget rather than a feel: `speed / WRECK_DRAG` metres of skid, about 4 m
    /// for a tank and 7 m for a jeep, reached in roughly two seconds.
    pub const WRECK_DRAG: f32 = 2.2;
    /// Gravity (m/s^2) on a flyer whose lift is gone. Slightly above 1 g so a helicopter
    /// knocked down from its 14 m cruise reaches the ground in about 1.3 s instead of
    /// hanging: the crash has to read as a crash.
    pub const WRECK_GRAVITY: f32 = 16.0;
    /// Tumble rates (rad/s) of a falling flyer wreck: yaw, pitch and roll. Distinct so the
    /// three axes do not line up into a flat spin, which reads as a glitch.
    pub const WRECK_TUMBLE_YAW: f32 = 2.2;
    pub const WRECK_TUMBLE_PITCH: f32 = 3.1;
    pub const WRECK_TUMBLE_ROLL: f32 = 4.3;
    /// Time a dropped flag stays on the ground before returning home.
    pub const FLAG_RETURN_TIME: f32 = 25.0;
    /// Rounds needed to win a match.
    pub const ROUNDS_TO_WIN: f32 = 3.0;
    /// Flag capture range.
    pub const FLAG_PICKUP_RANGE: f32 = 3.4;
    /// Time a player must sit still before drones show up.
    pub const DRONE_IDLE_TIME: f32 = 14.0;
    pub const MAX_DRONES: u32 = 5;
    /// Seconds between out-of-bounds submarine launches.
    pub const SUB_COOLDOWN: f32 = 9.0;
    /// Grace period after spawning during which a vehicle cannot be hurt. Stops the enemy
    /// from shelling a base pad the moment a new hull rolls out of the garage.
    ///
    /// This is the hard shield: damage is refused outright, so it also covers the moment a
    /// player is still reading the controls with the engine idling.
    pub const SPAWN_GUARD: f32 = 8.0;

    /// Seconds of home-zone protection a freshly built hull carries, and the radius of the
    /// zone around its own base that the protection applies in.
    ///
    /// Unlike `SPAWN_GUARD` this is not a timer that runs down while the player sits in the
    /// open: it only counts down while the vehicle is *inside* its own base zone, so a driver
    /// who has been shot at can always fall back and break contact for whatever is left of
    /// it. The two together mean a hull that rolls out of the garage and never moves cannot be
    /// touched for `SPAWN_GUARD + HOME_SAFE_TIME` seconds (measured: see
    /// `idle_player_survival_from_spawn_all_maps_both_teams` in `tests/gameplay_audit.rs`).
    ///
    /// It is deliberately per-hull and finite: an idle player is safe long enough to get
    /// their bearings, and the match is not turned into a stalemate by a base nobody may
    /// shoot into. Measured relative to `mapgen::BASE_HX` (24 m), the base the zone protects.
    pub const HOME_SAFE_TIME: f32 = 20.0;
    pub const HOME_SAFE_RADIUS: f32 = 24.0;

    /// How far outside an enemy home zone an AI driver holds while that zone is still
    /// protected. Without it the AI parks on the base pad and shells a player who has not
    /// finished spawning — the behaviour the idle-survival audit was written to catch.
    pub const HOME_STANDOFF: f32 = 34.0;
}
