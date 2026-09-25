//! Runtime tuning: the numbers a designer changes without a rebuild.
//!
//! `spec.rs` holds the compiled-in defaults for every rule, weapon and vehicle. This module
//! mirrors them as plain data (`Tuning`) that can be overridden at boot from the game's config
//! file, so the same binary can run a different balance - and so a value can be changed and
//! measured without a `wasm-pack` round trip.
//!
//! The bridge to JavaScript is a flat `f32` array, not JSON: the wasm crate carries no serde,
//! and `tuning_layout()` publishes the dotted name of every slot in order, so the web side maps
//! its config file onto the array by name. A slot left as `NaN` keeps the compiled-in default,
//! which is what makes a config file sparse - it only lists what it changes.
//!
//! The field list *is* the layout: every struct below is declared through `tuning_struct!`,
//! which emits the struct, its dotted names, its values and its apply loop from one list, so
//! the names and the fields cannot drift apart. Adding a tunable is one line in one list.

use crate::spec::{rules, weapon, wkind, VehicleSpec, WeaponSpec};
use crate::types::vkind;

/// Declare a tuning struct plus its layout, serialiser and apply loop from a single field list.
///
/// All fields are numeric on purpose: booleans are 0/1 and ids are indices (see `weapon::`'s
/// `wkind`). A round trip through the config file is then lossless and order-checked.
macro_rules! tuning_struct {
    (
        $(#[$meta:meta])*
        pub struct $name:ident { $($field:ident),* $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq)]
        pub struct $name {
            $(pub $field: f32,)*
        }

        impl $name {
            /// Append this struct's dotted field names, in value order.
            pub fn layout(&self, prefix: &str, out: &mut Vec<String>) {
                $(out.push(format!("{prefix}.{}", stringify!($field)));)*
            }
            /// Append this struct's values, in layout order.
            pub fn values(&self, out: &mut Vec<f32>) {
                $(out.push(self.$field);)*
            }
            /// Read this struct's values back, skipping non-finite slots (leave-as-default).
            /// Returns how many slots it consumed.
            pub fn apply(&mut self, v: &[f32], at: usize) -> usize {
                let mut i = at;
                $(
                    if let Some(x) = v.get(i) {
                        if x.is_finite() {
                            self.$field = *x;
                        }
                    }
                    i += 1;
                )*
                i - at
            }
            /// How many values this struct occupies.
            pub const SLOTS: usize = [$({ stringify!($field); 1 }),*].len();
        }
    };
}

tuning_struct! {
    /// The match rules (`spec::rules`), as numbers.
    pub struct RulesTune {
        border,
        drift_damp,
        ram_damage,
        wreck_time,
        wreck_coast,
        wreck_drag,
        wreck_gravity,
        wreck_tumble_yaw,
        wreck_tumble_pitch,
        wreck_tumble_roll,
        flag_return_time,
        rounds_to_win,
        flag_pickup_range,
        drone_idle_time,
        max_drones,
        sub_cooldown,
        spawn_guard,
        home_safe_time,
        home_safe_radius,
        home_standoff,
    }
}

tuning_struct! {
    /// One weapon (`spec::WeaponSpec`), as numbers. `name`, `pkind` and `sfx` are ids: they
    /// select code paths and assets, so they are *not* tunable - changing what a weapon is
    /// belongs in `spec.rs`. Everything that decides how it behaves is here.
    pub struct WeaponTune {
        damage,
        splash,
        splash_damage,
        speed,
        cooldown,
        burst,
        burst_gap,
        gravity,
        lobbed,
        life,
        spread,
        must_stop,
        min_range,
        range,
        homing,
        homing_lock,
        launch_climb,
        muzzle_fwd,
        muzzle_up,
        recoil,
    }
}

tuning_struct! {
    /// One hull (`spec::VehicleSpec`), as numbers. `weapon0`/`weapon1` are not here: a hull's
    /// guns are fixed by `spec::vehicle::weapons_for`, and what those guns *do* is tuned in the
    /// weapon table, so the same weapon cannot be described two different ways.
    pub struct VehicleTune {
        hp,
        speed,
        reverse,
        accel,
        brake,
        turn_lo,
        turn_hi,
        fuel_time,
        idle_burn,
        fuel_max,
        ammo0_max,
        ammo1_max,
        mine_max,
        turret_speed,
        turret_arc,
        can_carry_flag,
        amphibious,
        flying,
        radius,
        length,
        width,
        height,
        cruise_alt,
        climb_rate,
        build_time,
        sight,
        cam_scale,
        engine,
    }
}

/// Every tunable in the simulation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tuning {
    pub rules: RulesTune,
    /// Indexed by `wkind::*`.
    pub weapons: [WeaponTune; wkind::COUNT],
    /// Indexed by `vkind::*` (slot 0 is unused: `vkind::NONE`).
    pub vehicles: [VehicleTune; vkind::COUNT],
}

impl Default for Tuning {
    /// The compiled-in balance from `spec.rs`.
    fn default() -> Self {
        let mut weapons = [WeaponTune::default(); wkind::COUNT];
        for (i, w) in weapon::ALL.iter().enumerate() {
            weapons[i] = WeaponTune::from_spec(w);
        }
        let mut vehicles = [VehicleTune::default(); vkind::COUNT];
        for kind in 1..vkind::COUNT {
            vehicles[kind] = VehicleTune::from_spec(crate::spec::vehicle::spec(kind as u8));
        }
        Tuning {
            rules: RulesTune {
                border: rules::BORDER,
                drift_damp: rules::DRIFT_DAMP,
                ram_damage: rules::RAM_DAMAGE,
                wreck_time: rules::WRECK_TIME,
                wreck_coast: rules::WRECK_COAST,
                wreck_drag: rules::WRECK_DRAG,
                wreck_gravity: rules::WRECK_GRAVITY,
                wreck_tumble_yaw: rules::WRECK_TUMBLE_YAW,
                wreck_tumble_pitch: rules::WRECK_TUMBLE_PITCH,
                wreck_tumble_roll: rules::WRECK_TUMBLE_ROLL,
                flag_return_time: rules::FLAG_RETURN_TIME,
                rounds_to_win: rules::ROUNDS_TO_WIN,
                flag_pickup_range: rules::FLAG_PICKUP_RANGE,
                drone_idle_time: rules::DRONE_IDLE_TIME,
                max_drones: rules::MAX_DRONES as f32,
                sub_cooldown: rules::SUB_COOLDOWN,
                spawn_guard: rules::SPAWN_GUARD,
                home_safe_time: rules::HOME_SAFE_TIME,
                home_safe_radius: rules::HOME_SAFE_RADIUS,
                home_standoff: rules::HOME_STANDOFF,
            },
            weapons,
            vehicles,
        }
    }
}

impl Default for RulesTune {
    fn default() -> Self {
        Tuning::default().rules
    }
}
impl Default for WeaponTune {
    fn default() -> Self {
        WeaponTune::from_spec(&weapon::NONE)
    }
}
impl Default for VehicleTune {
    fn default() -> Self {
        VehicleTune::from_spec(&crate::spec::vehicle::JEEP)
    }
}

impl WeaponTune {
    pub fn from_spec(w: &WeaponSpec) -> Self {
        WeaponTune {
            damage: w.damage,
            splash: w.splash,
            splash_damage: w.splash_damage,
            speed: w.speed,
            cooldown: w.cooldown,
            burst: w.burst as f32,
            burst_gap: w.burst_gap,
            gravity: w.gravity,
            lobbed: w.lobbed as u8 as f32,
            life: w.life,
            spread: w.spread,
            must_stop: w.must_stop as u8 as f32,
            min_range: w.min_range,
            range: w.range,
            homing: w.homing as u8 as f32,
            homing_lock: w.homing_lock,
            launch_climb: w.launch_climb,
            muzzle_fwd: w.muzzle_fwd,
            muzzle_up: w.muzzle_up,
            recoil: w.recoil,
        }
    }

    /// This weapon with `base`'s identity fields (`name`, `pkind`, `sfx`) - the parts the
    /// config does not carry. Every tuned number is written out: a `..*base` here would silently
    /// keep the compiled-in value for anything not listed, which is exactly the bug this test
    /// suite caught on the first cut.
    pub fn to_spec(&self, base: &WeaponSpec) -> WeaponSpec {
        WeaponSpec {
            damage: self.damage,
            splash: self.splash,
            splash_damage: self.splash_damage,
            speed: self.speed,
            cooldown: self.cooldown,
            burst: self.burst.max(0.0).round() as u32,
            burst_gap: self.burst_gap,
            gravity: self.gravity,
            lobbed: self.lobbed > 0.5,
            life: self.life,
            spread: self.spread,
            must_stop: self.must_stop > 0.5,
            min_range: self.min_range,
            range: self.range,
            homing: self.homing > 0.5,
            homing_lock: self.homing_lock,
            launch_climb: self.launch_climb,
            muzzle_fwd: self.muzzle_fwd,
            muzzle_up: self.muzzle_up,
            recoil: self.recoil,
            ..*base
        }
    }
}

impl VehicleTune {
    pub fn from_spec(s: &VehicleSpec) -> Self {
        VehicleTune {
            hp: s.hp,
            speed: s.speed,
            reverse: s.reverse,
            accel: s.accel,
            brake: s.brake,
            turn_lo: s.turn_lo,
            turn_hi: s.turn_hi,
            fuel_time: s.fuel_time,
            idle_burn: s.idle_burn,
            fuel_max: s.fuel_max,
            ammo0_max: s.ammo0_max,
            ammo1_max: s.ammo1_max,
            mine_max: s.mine_max,
            turret_speed: s.turret_speed,
            turret_arc: s.turret_arc,
            can_carry_flag: s.can_carry_flag as u8 as f32,
            amphibious: s.amphibious as u8 as f32,
            flying: s.flying as u8 as f32,
            radius: s.radius,
            length: s.length,
            width: s.width,
            height: s.height,
            cruise_alt: s.cruise_alt,
            climb_rate: s.climb_rate,
            build_time: s.build_time,
            sight: s.sight,
            cam_scale: s.cam_scale,
            engine: s.engine as f32,
        }
    }

    /// The hull's full spec: the tuned numbers over the compiled-in identity (`name`, `kind`),
    /// with its guns taken from the tuned weapon table - see `spec::vehicle::weapons_for`.
    pub fn to_spec(&self, base: &VehicleSpec, weapons: &[WeaponTune; wkind::COUNT]) -> VehicleSpec {
        let (w0, w1) = crate::spec::vehicle::weapons_for(base.kind);
        VehicleSpec {
            hp: self.hp,
            speed: self.speed,
            reverse: self.reverse,
            accel: self.accel,
            brake: self.brake,
            turn_lo: self.turn_lo,
            turn_hi: self.turn_hi,
            fuel_time: self.fuel_time,
            idle_burn: self.idle_burn,
            fuel_max: self.fuel_max,
            ammo0_max: self.ammo0_max,
            ammo1_max: self.ammo1_max,
            mine_max: self.mine_max,
            turret_speed: self.turret_speed,
            turret_arc: self.turret_arc,
            can_carry_flag: self.can_carry_flag > 0.5,
            amphibious: self.amphibious > 0.5,
            flying: self.flying > 0.5,
            radius: self.radius,
            length: self.length,
            width: self.width,
            height: self.height,
            cruise_alt: self.cruise_alt,
            climb_rate: self.climb_rate,
            build_time: self.build_time,
            sight: self.sight,
            cam_scale: self.cam_scale,
            engine: self.engine.max(0.0).round() as u8,
            weapon0: weapons[w0].to_spec(&weapon::ALL[w0]),
            weapon1: weapons[w1].to_spec(&weapon::ALL[w1]),
            ..*base
        }
    }
}

impl Tuning {
    /// The dotted name of every slot, in `values`/`apply` order. The web side matches its
    /// config file against this, so the file's keys are the Rust field names.
    pub fn layout() -> Vec<String> {
        let t = Tuning::default();
        let mut out: Vec<String> = Vec::with_capacity(Tuning::slots());
        t.rules.layout("rules", &mut out);
        for (i, name) in wkind::KEYS.iter().enumerate() {
            t.weapons[i].layout(&format!("weapons.{name}"), &mut out);
        }
        for (i, name) in vkind::KEYS.iter().enumerate().skip(1) {
            t.vehicles[i].layout(&format!("vehicles.{name}"), &mut out);
        }
        out
    }

    pub fn values(&self) -> Vec<f32> {
        let mut out: Vec<f32> = Vec::with_capacity(Self::slots());
        self.rules.values(&mut out);
        for i in 0..wkind::COUNT {
            self.weapons[i].values(&mut out);
        }
        for i in 1..vkind::COUNT {
            self.vehicles[i].values(&mut out);
        }
        out
    }

    /// How many values `layout()` and `values()` produce.
    pub const fn slots() -> usize {
        RulesTune::SLOTS + WeaponTune::SLOTS * wkind::COUNT + VehicleTune::SLOTS * (vkind::COUNT - 1)
    }

    /// Apply a flat override vector. Slots that are missing or non-finite keep the value they
    /// had, so a partial (or empty) config leaves the compiled-in balance alone. Values that
    /// would break the simulation are clamped here rather than trusted.
    pub fn apply(&mut self, values: &[f32]) {
        let mut at = 0;
        at += self.rules.apply(values, at);
        for i in 0..wkind::COUNT {
            at += self.weapons[i].apply(values, at);
        }
        for i in 1..vkind::COUNT {
            at += self.vehicles[i].apply(values, at);
        }
        self.sanitise(&Tuning::default());
    }

    /// Keep the numbers inside the ranges the rest of the code assumes. A config file is
    /// hand-editable, so this is the only place that has to be paranoid: a negative `radius`
    /// or a zero `speed` would otherwise divide or NaN its way through the physics.
    ///
    /// `defaults` is the compiled-in table, and it is what makes the clamps *relative*: the
    /// submarine carries `speed`/`accel`/`brake` of zero because it has no ground physics at
    /// all, and a blanket floor would quietly change it. So a field only gets the ground
    /// model's floor where the compiled table says that field is a ground number.
    pub fn sanitise(&mut self, defaults: &Tuning) {
        let r = &mut self.rules;
        r.rounds_to_win = r.rounds_to_win.clamp(1.0, 99.0);
        r.max_drones = r.max_drones.clamp(0.0, 32.0);
        r.flag_pickup_range = r.flag_pickup_range.clamp(0.5, 20.0);
        r.spawn_guard = r.spawn_guard.max(0.0);
        r.home_safe_time = r.home_safe_time.max(0.0);
        r.home_safe_radius = r.home_safe_radius.max(0.0);
        r.home_standoff = r.home_standoff.max(0.0);
        r.border = r.border.clamp(0.0, 64.0);
        r.wreck_time = r.wreck_time.max(0.0);
        for (i, w) in self.weapons.iter_mut().enumerate() {
            // Slot 0 is the placeholder every empty hull slot points at (`weapon::NONE`). It is
            // never fired, and its zeroes *are* its defaults - clamping them would break the
            // promise that a config file which does not mention a field leaves it alone.
            if i == wkind::NONE {
                continue;
            }
            w.damage = w.damage.max(0.0);
            w.splash = w.splash.max(0.0);
            w.splash_damage = w.splash_damage.max(0.0);
            w.speed = w.speed.max(1.0);
            w.cooldown = w.cooldown.clamp(0.02, 60.0);
            w.burst = w.burst.clamp(1.0, 64.0);
            w.burst_gap = w.burst_gap.clamp(0.0, 10.0);
            w.gravity = w.gravity.max(0.0);
            w.life = w.life.clamp(0.05, 120.0);
            w.spread = w.spread.clamp(0.0, 1.5);
            w.min_range = w.min_range.max(0.0);
            w.range = w.range.clamp(1.0, 2000.0);
            w.homing_lock = w.homing_lock.clamp(0.0, 120.0);
            w.homing = (w.homing > 0.5) as u8 as f32;
            w.lobbed = (w.lobbed > 0.5) as u8 as f32;
            w.must_stop = (w.must_stop > 0.5) as u8 as f32;
            if w.min_range > w.range {
                w.min_range = w.range;
            }
        }
        for (i, v) in self.vehicles.iter_mut().enumerate() {
            let d = defaults.vehicles[i];
            v.hp = v.hp.max(1.0);
            // 0.5 m/s^2 / m/s is the floor that keeps `physics`'s divisions finite; a field the
            // compiled table leaves at zero (the submarine, and any future emplacement) only
            // has to stay non-negative.
            v.speed = if d.speed > 0.0 { v.speed.max(0.5) } else { v.speed.max(0.0) };
            v.reverse = v.reverse.clamp(0.0, v.speed);
            v.accel = if d.accel > 0.0 { v.accel.max(0.5) } else { v.accel.max(0.0) };
            v.brake = if d.brake > 0.0 { v.brake.max(0.5) } else { v.brake.max(0.0) };
            v.turn_lo = v.turn_lo.max(0.0);
            v.turn_hi = v.turn_hi.max(0.0);
            v.fuel_time = v.fuel_time.clamp(1.0, 100000.0);
            v.fuel_max = v.fuel_max.max(1.0);
            v.idle_burn = v.idle_burn.clamp(0.0, 1.0);
            v.ammo0_max = v.ammo0_max.max(0.0);
            v.ammo1_max = v.ammo1_max.max(0.0);
            v.mine_max = v.mine_max.max(0.0);
            v.turret_speed = v.turret_speed.max(0.0);
            v.turret_arc = v.turret_arc.max(0.0);
            v.radius = v.radius.clamp(0.3, 20.0);
            v.length = v.length.clamp(0.5, 40.0);
            v.width = v.width.clamp(0.5, 40.0);
            v.height = v.height.clamp(0.5, 40.0);
            v.cruise_alt = v.cruise_alt.clamp(0.0, 400.0);
            v.climb_rate = v.climb_rate.clamp(0.0, 200.0);
            v.build_time = v.build_time.clamp(0.0, 600.0);
            v.sight = v.sight.clamp(1.0, 2000.0);
            v.cam_scale = v.cam_scale.clamp(0.1, 5.0);
            v.engine = v.engine.max(0.0).round();
            v.can_carry_flag = (v.can_carry_flag > 0.5) as u8 as f32;
            v.amphibious = (v.amphibious > 0.5) as u8 as f32;
            v.flying = (v.flying > 0.5) as u8 as f32;
        }
    }

    /// The rules the rest of the simulation reads. Convenience for tests and tools.
    pub fn rules(&self) -> &RulesTune {
        &self.rules
    }

    /// The weapon a hull mounts in slot 0 or 1, as a `WeaponSpec` ready to fire.
    pub fn weapon(&self, index: usize) -> WeaponSpec {
        self.weapons[index.min(wkind::COUNT - 1)].to_spec(&weapon::ALL[index.min(wkind::COUNT - 1)])
    }

    /// Build a hull's spec from the tuned numbers: identity (`name`, `kind`, its guns' identity
    /// and models) from `spec.rs`, everything else from here.
    pub fn spec(&self, kind: u8) -> VehicleSpec {
        let base = crate::spec::vehicle::spec(kind);
        self.vehicles[(kind as usize).min(vkind::COUNT - 1)].to_spec(base, &self.weapons)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::vkind;

    /// The layout is a promise to the config file: one name per value, in order. If a field is
    /// ever added on one side only, this is what fails.
    #[test]
    fn the_layout_names_every_value_once() {
        let l = Tuning::layout();
        assert_eq!(l.len(), Tuning::slots(), "layout length drifted from the field lists");
        assert_eq!(l.len(), Tuning::default().values().len(), "values() disagrees with layout()");
        let mut seen = std::collections::HashSet::new();
        for name in &l {
            assert!(name.contains('.') && !name.ends_with('.'), "malformed key {name}");
            assert!(seen.insert(name.clone()), "duplicate key {name}");
        }
        // The three sections the config file documents, and the names it uses for hulls/guns.
        assert!(l.contains(&"rules.rounds_to_win".to_string()));
        assert!(l.contains(&"weapons.heli_cannon.life".to_string()));
        assert!(l.contains(&"vehicles.tank.hp".to_string()));
        assert!(l.iter().any(|n| n == "weapons.none.damage"), "the shared `none` slot must exist");
    }

    /// Compare two tunings slot by slot and name what differs - `assert_eq!` on a struct this
    /// size prints thousands of characters and hides the one field that moved.
    fn differences(a: &Tuning, b: &Tuning) -> Vec<String> {
        let layout = Tuning::layout();
        let (va, vb) = (a.values(), b.values());
        layout
            .iter()
            .zip(va.iter().zip(vb.iter()))
            .filter(|(_, (x, y))| x != y)
            .map(|(name, (x, y))| format!("{name}: {x} != {y}"))
            .collect()
    }

    fn slot(name: &str) -> usize {
        Tuning::layout()
            .iter()
            .position(|n| n == name)
            .unwrap_or_else(|| panic!("no slot {name}"))
    }

    /// A config file is sparse: it lists what it changes. Everything else must keep the
    /// compiled-in default, which is what lets it stay a short file.
    #[test]
    fn an_empty_or_partial_config_changes_nothing_else() {
        let base = Tuning::default();

        let mut untouched = Tuning::default();
        untouched.apply(&[]);
        assert!(differences(&untouched, &base).is_empty(), "an empty config changed {:?}", differences(&untouched, &base));

        let mut nans = Tuning::default();
        nans.apply(&vec![f32::NAN; Tuning::slots()]);
        assert!(differences(&nans, &base).is_empty(), "NaN slots changed {:?}", differences(&nans, &base));

        let mut one = Tuning::default();
        let mut values = vec![f32::NAN; Tuning::slots()];
        values[slot("weapons.heli_cannon.life")] = 9.5;
        one.apply(&values);
        assert_eq!(one.weapons[wkind::HELI_CANNON].life, 9.5);
        assert_eq!(one.rules, base.rules);
        assert_eq!(one.vehicles, base.vehicles);
        assert_eq!(one.weapons[wkind::TANK_SHELL], base.weapons[wkind::TANK_SHELL]);
    }

    /// `values()` and `apply()` are inverses, so a tool can read the tuning out, edit a number
    /// and put it back.
    #[test]
    fn values_round_trip_through_apply() {
        let mut t = Tuning::default();
        t.rules.rounds_to_win = 7.0;
        t.weapons[wkind::TANK_SHELL].damage = 123.0;
        t.vehicles[vkind::JEEP as usize].speed = 31.0;
        let flat = t.values();
        let mut back = Tuning::default();
        back.apply(&flat);
        assert!(differences(&back, &t).is_empty(), "round trip lost {:?}", differences(&back, &t));
    }

    /// A hand-edited file is the one place garbage can enter, so `apply` clamps rather than
    /// trusting: nothing may reach the physics as zero/negative/NaN.
    #[test]
    fn absurd_values_are_clamped_not_propagated() {
        let mut values = vec![f32::NAN; Tuning::slots()];
        for (name, v) in [
            ("vehicles.tank.radius", -5.0),
            ("vehicles.tank.speed", 0.0),
            ("vehicles.tank.hp", -100.0),
            ("weapons.tank_shell.cooldown", 0.0),
            ("weapons.tank_shell.speed", -40.0),
            ("weapons.tank_shell.life", 0.0),
            ("weapons.tank_shell.range", 0.0),
            ("weapons.tank_shell.min_range", 900.0),
            ("rules.rounds_to_win", 0.0),
            ("rules.flag_pickup_range", -3.0),
            ("rules.ram_damage", f32::INFINITY),
        ] {
            values[slot(name)] = v;
        }
        let mut t = Tuning::default();
        t.apply(&values);
        let tank = t.vehicles[vkind::TANK as usize];
        assert!(tank.radius >= 0.3, "radius {0}", tank.radius);
        assert!(tank.speed >= 0.5, "speed {}", tank.speed);
        assert!(tank.hp >= 1.0, "hp {}", tank.hp);
        let shell = t.weapons[wkind::TANK_SHELL];
        assert!(shell.cooldown >= 0.02, "cooldown {}", shell.cooldown);
        assert!(shell.speed >= 1.0, "speed {}", shell.speed);
        assert!(shell.life >= 0.05, "life {}", shell.life);
        assert!(shell.range >= 1.0, "range {}", shell.range);
        assert!(shell.min_range <= shell.range, "min {} > range {}", shell.min_range, shell.range);
        assert_eq!(t.rules.rounds_to_win, 1.0);
        assert!(t.rules.flag_pickup_range >= 0.5);
        assert!(t.rules.ram_damage.is_finite(), "infinity must not survive");
        for value in t.values() {
            assert!(value.is_finite(), "a non-finite value reached the tuning table");
        }
    }

    /// The tuned numbers have to reach the hull: spec identity from `spec.rs`, everything else
    /// from the table, and the guns from the weapon table (not a stale copy).
    #[test]
    fn a_hull_spec_is_built_from_the_tuning() {
        let mut t = Tuning::default();
        let mut values = vec![f32::NAN; Tuning::slots()];
        values[slot("vehicles.tank.hp")] = 1234.0;
        values[slot("weapons.tank_shell.damage")] = 7.0;
        t.apply(&values);

        let tank = t.spec(vkind::TANK);
        assert_eq!(tank.hp, 1234.0);
        assert_eq!(tank.weapon0.damage, 7.0, "the hull's gun must come from the weapon table");
        assert_eq!(tank.name, crate::spec::vehicle::TANK.name, "identity stays compiled in");
        assert_eq!(tank.kind, vkind::TANK);
        assert_eq!(tank.weapon0.pkind, crate::spec::weapon::TANK_SHELL.pkind);
        // ...and a hull whose guns were never touched keeps exactly the defaults.
        assert_eq!(t.spec(vkind::HELI).weapon0.speed, crate::spec::weapon::HELI_CANNON.speed);
    }

    /// End to end through the world: the config file changes what is simulated, on hulls that
    /// are already in the field as well as on new ones.
    #[test]
    fn the_world_simulates_the_tuned_numbers() {
        let mut map = crate::mapgen::generate(3, 0);
        crate::normalize_map(&mut map);
        let mut w = crate::world::World::new_with_map(3, map, [0, -1]);
        assert_eq!(w.rounds, crate::spec::rules::ROUNDS_TO_WIN);

        let id = w.spawn_vehicle(vkind::TANK, 1, 0);
        let vi = w.vehicle_index(id).unwrap();
        let stock = w.vehicles[vi].spec().hp;

        let mut values = vec![f32::NAN; Tuning::slots()];
        values[slot("rules.rounds_to_win")] = 1.0;
        values[slot("vehicles.tank.hp")] = stock + 250.0;
        values[slot("vehicles.tank.speed")] = 3.0;
        w.apply_tuning(&values);

        assert_eq!(w.rounds, 1.0, "a round must end after the configured number of captures");
        let v = &w.vehicles[vi];
        assert_eq!(v.spec().hp, stock + 250.0, "hulls in the field are re-issued their spec");
        assert_eq!(v.spec().speed, 3.0);
        assert!(v.hp <= v.spec().hp);

        // A hull spawned after the change is built with it from the start.
        let id2 = w.spawn_vehicle(vkind::TANK, 1, 0);
        if let Some(vi2) = w.vehicle_index(id2) {
            assert_eq!(w.vehicles[vi2].spec().speed, 3.0);
            assert_eq!(w.vehicles[vi2].hp, stock + 250.0);
        }
    }
}
