//! World state, the fixed-step update loop, capture-the-flag logic, the garage and the
//! per-frame mirror of everything the renderer reads.

use crate::ai;
use crate::combat;
use crate::mapgen::{self, from_local, to_local};
use crate::math::*;
use crate::nav;
use crate::physics;
use crate::spec::{rules, vehicle, VehicleSpec};
use crate::types::*;

/// One player's (or AI's) control input for a single tick.
#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    /// -1 = full reverse, +1 = full throttle.
    pub throttle: f32,
    /// -1 = left, +1 = right.
    pub steer: f32,
    /// Absolute world yaw (radians) the turret/aim should point at.
    pub aim: f32,
    /// Gun elevation in radians (positive = up).
    pub aim_pitch: f32,
    /// True when `aim` is meaningful (mouse aiming); otherwise the turret follows the hull.
    pub has_aim: bool,
    /// Primary trigger held.
    pub fire0: bool,
    /// Secondary trigger held.
    pub fire1: bool,
    /// Edge-triggered secondary (rockets, mines).
    pub fire1_edge: bool,
    /// Handbrake / tight turn / helicopter descend.
    pub brake: bool,
    /// Helicopter ascend.
    pub ascend: bool,
    /// Helicopter lateral strafe, -1..1.
    pub strafe: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct AiState {
    pub goal: u8,
    /// Last position sampled when checking for progress.
    pub last_pos: Vec2,
    /// Seconds without making progress towards the objective.
    pub stuck_t: f32,
    /// Remaining seconds of an escape manoeuvre.
    pub escape_t: f32,
    /// Which way to swing while escaping.
    pub escape_dir: f32,
    /// Seconds until this unit may jink again.
    pub evade_cd: f32,
    /// Seconds until an MLRS may drop another mine (advance trails and retreat hedges).
    pub mine_cd: f32,
    pub target: i32,
    pub struct_target: i32,
    pub think_t: f32,
    pub field: u8,
    pub wander: f32,
    pub skill: f32,
    pub last_seen: f32,
    pub jitter: f32,
    pub strafe_dir: f32,
    /// Seconds left in the current strafe run. The direction is held for the whole run
    /// instead of being re-drawn every think: a hull that flips its lateral command every
    /// few tenths of a second oscillates around its own position and translates nowhere
    /// (measured on the helicopter: 0.5 m/s mean speed in a 30 m engagement, which is what
    /// "it does not strafe enough" looks like from the outside).
    pub strafe_t: f32,
}

pub mod aigoal {
    pub const IDLE: u8 = 0;
    pub const TO_FLAG: u8 = 1;
    pub const HOME_WITH_FLAG: u8 = 2;
    pub const HUNT: u8 = 3;
    pub const ATTACK_STRUCT: u8 = 4;
    pub const PATROL: u8 = 5;
    pub const EVADE: u8 = 6;
    pub const SUPPORT: u8 = 7;
    /// No land route to the objective exists (every crossing is down): hold near the spawn
    /// pad and mill around until a rebuilt flow field reaches the hull again.
    pub const HOLD: u8 = 8;
}

#[derive(Clone, Debug)]
pub struct Vehicle {
    pub id: u32,
    pub kind: u8,
    /// The numbers this hull was built with (see `Vehicle::spec`).
    pub spec: VehicleSpec,
    pub team: u8,
    pub state: f32,
    pub pos: Vec2,
    pub y: f32,
    pub yaw: f32,
    pub vel: Vec2,
    pub fwd_speed: f32,
    pub hp: f32,
    pub fuel: f32,
    pub ammo0: f32,
    pub ammo1: f32,
    pub mines: f32,
    pub turret_yaw: f32,
    pub gun_pitch: f32,
    pub reload0: f32,
    pub reload1: f32,
    pub burst: u32,
    pub burst_t: f32,
    pub anim: f32,
    pub flags: u32,
    pub build_t: f32,
    pub player: u8, // 0 = AI, else player index + 1
    pub ai: AiState,
    pub pitch: f32,
    pub roll: f32,
    pub hit_flash: f32,
    pub wreck_t: f32,
    /// Vertical speed (m/s) of a flyer whose lift is gone. `physics` is skipped for
    /// wrecks, so a knocked-down helicopter carries its own fall here; cleared on impact.
    pub wreck_vy: f32,
    /// The nav cell this wreck's hulk is blocking, or `usize::MAX` when it is not blocking
    /// one. A wreck of a heavy vehicle shuts the road while it lies there
    /// (`kill_vehicle`), and this is the handle `cull` needs to hand that cell back when the
    /// wreck is removed - without it the cell stayed blocked for the rest of the round, and
    /// on a narrow deck or ford lane three or four wrecks were enough to seal the only
    /// route the AI had. That was the reported "the tank does not use the intact bridge".
    pub wreck_block: usize,
    pub idle_t: f32,
    pub airborne: bool,
    pub alt: f32,
    pub last_fire: f32,
    /// Aim wobble so AI shots are not laser accurate.
    pub aim_err: f32,
    pub smoke_t: f32,
    pub engine_load: f32,
    /// Seconds of spawn protection left.
    pub spawn_guard: f32,
    /// Seconds of home-zone protection left. Only counts down while the vehicle is inside
    /// its own base zone (`World::in_home_zone`), so falling back home pauses it.
    pub home_safe: f32,
    /// Input produced by the AI brain this tick (used when `player == 0`).
    pub ai_input: Input,
}

impl Vehicle {
    /// This hull's spec, as it was built (see `World::spawn_vehicle`). A copy rather than a
    /// lookup into the tuning table so every physics/AI call site keeps working without a
    /// `&World` in hand; `World::apply_tuning` re-issues it when the config changes.
    pub fn spec(&self) -> &VehicleSpec {
        &self.spec
    }
    #[inline]
    pub fn alive(&self) -> bool {
        self.state == vstate::ACTIVE
    }
    #[inline]
    pub fn carrying_flag(&self) -> bool {
        self.flags & vflag::CARRYING_FLAG != 0
    }
    /// Centre of mass height (used for aiming and projectile spawns).
    #[inline]
    pub fn center_y(&self) -> f32 {
        self.y + self.spec().height * 0.5
    }
}

#[derive(Clone, Debug)]
pub struct Projectile {
    pub id: u32,
    pub kind: u8,
    pub team: u8,
    pub owner: u32,
    pub owner_kind: u8,
    pub pos: Vec3,
    pub vel: Vec3,
    pub life: f32,
    pub damage: f32,
    pub splash: f32,
    pub splash_damage: f32,
    pub gravity: f32,
    pub homing: bool,
    /// Seconds of guided flight left (0 = ballistic). Missiles lose the lock, which is what
    /// makes a fast, jinking vehicle able to dodge a turret.
    pub homing_t: f32,
    pub target: i32,
    pub seed: f32,
}

#[derive(Clone, Debug)]
pub struct Mine {
    pub id: u32,
    pub team: u8,
    pub pos: Vec2,
    pub y: f32,
    pub armed: f32,
    pub blink: f32,
}

#[derive(Clone, Debug)]
pub struct Turret {
    pub struct_id: u32,
    pub team: u8,
    pub pos: Vec2,
    pub y: f32,
    pub yaw: f32,
    pub reload: f32,
    pub target: i32,
    pub alive: bool,
    /// Seconds the current target has been tracked; the launcher will not fire before it has
    /// held a solution for `ACQUIRE_TIME`, which gives fast vehicles a window to slip past.
    pub acquire: f32,
}

#[derive(Clone, Debug)]
pub struct Flag {
    pub team: u8,
    pub state: f32,
    pub pos: Vec2,
    pub home: Vec2,
    pub carrier: i32,
    pub drop_t: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Garage {
    pub parked: [f32; 4],
    pub building: [f32; 4],
}

/// Uniform spatial hash over solid structures, rebuilt when the map changes.
pub struct StructGrid {
    pub cell: f32,
    pub dim: i32,
    pub buckets: Vec<Vec<u32>>,
}

impl StructGrid {
    pub fn build(map: &MapData) -> StructGrid {
        let cell = 8.0f32;
        let dim = (map.world_size / cell).ceil() as i32 + 2;
        let mut g = StructGrid {
            cell,
            dim,
            buckets: vec![Vec::new(); (dim * dim) as usize],
        };
        for (i, s) in map.structures.iter().enumerate() {
            if !s.solid() {
                continue;
            }
            let (min, max) = s.bounds();
            let x0 = ((min.x / cell).floor() as i32 + 1).clamp(0, dim - 1);
            let z0 = ((min.y / cell).floor() as i32 + 1).clamp(0, dim - 1);
            let x1 = ((max.x / cell).floor() as i32 + 1).clamp(0, dim - 1);
            let z1 = ((max.y / cell).floor() as i32 + 1).clamp(0, dim - 1);
            for z in z0..=z1 {
                for x in x0..=x1 {
                    g.buckets[(z * dim + x) as usize].push(i as u32);
                }
            }
        }
        g
    }

    /// Allocation-free query used by the hot physics path.
    pub fn query_into<const N: usize>(&self, p: Vec2, r: f32, out: &mut [u32; N]) -> usize {
        let mut count = 0usize;
        let x0 = (((p.x - r) / self.cell).floor() as i32 + 1).clamp(0, self.dim - 1);
        let z0 = (((p.y - r) / self.cell).floor() as i32 + 1).clamp(0, self.dim - 1);
        let x1 = (((p.x + r) / self.cell).floor() as i32 + 1).clamp(0, self.dim - 1);
        let z1 = (((p.y + r) / self.cell).floor() as i32 + 1).clamp(0, self.dim - 1);
        for z in z0..=z1 {
            for x in x0..=x1 {
                for id in &self.buckets[(z * self.dim + x) as usize] {
                    if count >= N {
                        return count;
                    }
                    let mut dup = false;
                    for k in 0..count {
                        if out[k] == *id {
                            dup = true;
                            break;
                        }
                    }
                    if !dup {
                        out[count] = *id;
                        count += 1;
                    }
                }
            }
        }
        count
    }

    pub fn query(&self, p: Vec2, r: f32, out: &mut Vec<u32>) {
        out.clear();
        let x0 = (((p.x - r) / self.cell).floor() as i32 + 1).clamp(0, self.dim - 1);
        let z0 = (((p.y - r) / self.cell).floor() as i32 + 1).clamp(0, self.dim - 1);
        let x1 = (((p.x + r) / self.cell).floor() as i32 + 1).clamp(0, self.dim - 1);
        let z1 = (((p.y + r) / self.cell).floor() as i32 + 1).clamp(0, self.dim - 1);
        for z in z0..=z1 {
            for x in x0..=x1 {
                for id in &self.buckets[(z * self.dim + x) as usize] {
                    if !out.contains(id) {
                        out.push(*id);
                    }
                }
            }
        }
    }
}

/// Seconds a team must wait between two *field* vehicle reinforcements (three, after four proved
/// a touch slow for the commander's own pressure).
///
/// Nothing may drop a batch of hulls on the pad: with a raised [`World::vehicle_cap`] the
/// commander used to do exactly that, which reads as a glitch rather than a battle. The clock is
/// per team, so both sides open a round on the same tick, and it is owned by the commander -
/// `spawn_vehicle` itself never refuses, it only restarts the clock, so a human's deploy, the
/// opening garrison pair and the map editor are all unaffected. It is armed by every field hull
/// that appears, which is what keeps the CPU from following a human's deploy inside the window.
pub const CPU_SPAWN_DELAY: f32 = 3.0;

/// Hard ceiling for [`World::vehicle_cap`]: 64 hulls a team, 128 on the field. Well past what
/// the map can hold before the pad jams, and low enough that the O(n^2) passes (collision,
/// targeting, avoidance rays) stay in a frame.
pub const MAX_VEHICLE_CAP: usize = 64;

pub struct World {
    pub map: MapData,
    /// Every rule, weapon and hull number the simulation reads. Compiled-in defaults from
    /// `spec.rs` unless the game's config file overrode them (`apply_tuning`).
    pub tuning: crate::tuning::Tuning,
    pub rng: Rng,
    pub time: f32,
    pub tick: u32,
    pub vehicles: Vec<Vehicle>,
    pub projs: Vec<Projectile>,
    pub mines: Vec<Mine>,
    pub turrets: Vec<Turret>,
    /// Indices of every structure that can resupply (fuel, ammo or repair). These are NOT
    /// all solid (a helipad is deliberately flat), so they need their own list: the solid
    /// collision grid would never return them.
    pub supply: Vec<u32>,
    pub flags: [Flag; 2],
    pub grid: StructGrid,
    /// Dynamic blocking overlay (bridges blow up, wrecks pile up).
    pub dyn_block: Vec<bool>,
    pub fields: nav::Fields,
    pub garage: [Garage; 2],
    pub score: [f32; 2],
    pub rounds: f32,
    pub state: f32,
    pub round_winner: i32,
    pub round_over_t: f32,
    pub drone_count: u32,
    pub sub_cd: [f32; 2],
    pub next_id: u32,
    pub player_of_team: [i32; 2],
    /// Player slots driven by the CPU instead of a human. Attract/demo mode hands the
    /// "player's" hull to the simulation's own AI so it fights like a real driver, and this
    /// is the seam for later CPU-controlled allies (the commander will field them). A
    /// vehicle whose slot is set here takes `ai_input` in physics, goes through
    /// `think_vehicle` in the AI loop, and never counts as an idle player for the
    /// anti-camping drones.
    pub cpu_driven: [bool; 2],
    /// CPU-controlled allied vehicles: when set, a human team fields its own AI garrison — the
    /// same tank + jeep `initial_spawn` gives a CPU-held team — so one player is not alone
    /// against the whole enemy force. The garrison is fielded on the option's edge (see
    /// `set_options`) and re-fielded after every round restart, because `new_round` clears the
    /// vehicles and calls back into `initial_spawn` with this flag still set. Replacements come
    /// from the commander's independent supply line (`ally_cd`), never the player's garage.
    pub cpu_allies: bool,
    /// Seconds until the next CPU ally may spawn for each team: the pacing of that independent
    /// supply line. Set to the replacement's `build_time` when one spawns, so an ally force
    /// rebuilds at exactly the rate a garage would — never faster than the player's own rules.
    pub ally_cd: [f32; 2],
    /// Seconds until each team may field another *field* vehicle (see [`CPU_SPAWN_DELAY`]).
    /// Restarted by every spawn of that team's field kinds, however it was asked for.
    pub spawn_cd: [f32; 2],
    /// Per-team ceiling on concurrent CPU hulls, overriding the field strength the rules ask
    /// for: `0` (the default) means "use the rules" — 2 / 3 / 6 by difficulty for a CPU team,
    /// 2 for CPU allies on a human team — while a stress test sets it higher (`?maxveh=24`, or
    /// `set_vehicle_cap`).
    ///
    /// Setting it moves two things:
    ///
    ///  * the ceiling itself, for the CPU commander and for a human team's ally garrison;
    ///  * the *yard rule* — with a cap set, a base counts as busy once two of that team's hulls
    ///    are inside its own zone rather than one. At a field of sixteen someone is always
    ///    rotating home to refuel, so the strict rule held the whole force at the size of a
    ///    garrison; two is still enough to stop a queue forming in the gateway.
    ///
    /// What it deliberately does *not* do is spawn faster than [`CPU_SPAWN_DELAY`]: one field
    /// vehicle a team every three seconds, so a raised cap fills as a steady stream instead of a
    /// batch on the pad. A large cap therefore settles at whatever the fight can sustain — about
    /// six a side in a knife fight, more when hulls live longer.
    ///
    /// The ceiling is clamped to [`MAX_VEHICLE_CAP`]: physics, AI and targeting all walk the
    /// vehicle list per tick, and the point of the dial is a heavier *match*, not a frozen tab.
    pub vehicle_cap: usize,
    /// CPU force level: `0` = easy (1.0x), `1` = medium (1.5x), `2` = hard (3.0x).
    ///
    /// The multiplier means *unit availability* — how fast the AI's garage rebuilds a lost
    /// hull and how large a reserve it may bank — and nothing else. 1.0x is deliberately
    /// exactly the rules a human plays under (`build_time` per hull, `parked` capped at 3),
    /// so easy is a fair fight and the player's team is never scaled at all. It exists so
    /// the reported "the CPU player seems to have infinite respawns" becomes a dial instead
    /// of a constant.
    pub difficulty: u8,
    /// Test / practice range: when set, no enemy units and no defence towers ever exist.
    ///
    /// Set through `World::set_options`; `step` then skips `ai::update` entirely (which is
    /// what spawns the commander's hulls, the drones and the towers' fire control) and the
    /// spawn funnels refuse a CPU-held team, because infantry also arrive from destroyed
    /// buildings (`combat.rs`) and bail-outs (`physics.rs`), paths that do not run through
    /// `ai::update`. Structures, the flags and the player's own garage stay live, so it is a
    /// usable driving and gunnery range.
    pub sandbox: bool,
    pub pending_request: [i32; 2],
    pub kills: [f32; 2],
    pub deaths: [f32; 2],
    pub captures: [f32; 2],
    pub ai_cmd_t: f32,
    // ---- renderer mirrors (rebuilt every tick) ----
    pub vviews: Vec<VehicleView>,
    pub pviews: Vec<ProjectileView>,
    pub mviews: Vec<MineView>,
    pub tviews: Vec<TurretView>,
    pub fviews: [FlagView; 2],
    pub events: Vec<EventView>,
    pub player_hud: [PlayerHud; 2],
    pub team_hud: [TeamHud; 2],
    pub terrain_rev: u32,
    /// First non-finite kinematic event seen by `physics::step_vehicle`, kept for the debug
    /// seam (`Game::nan_debug`): which hull, where it was a tick earlier, and what drove it.
    pub nan_debug: Option<crate::physics::NanHit>,
    scratch: Vec<u32>,
}

impl World {
    pub fn new(seed: u32, map_index: u32, players: [i32; 2]) -> World {
        let mut map = mapgen::generate(seed, map_index);
        crate::normalize_map(&mut map);
        World::new_with_map(seed, map, players)
    }

    /// Build a world around an already generated (and normalized) map.
    pub fn new_with_map(seed: u32, map: MapData, players: [i32; 2]) -> World {
        let grid = StructGrid::build(&map);
        let dyn_block = vec![false; (map.grid * map.grid) as usize];
        let flag_home = map.flag_home;
        let mut w = World {
            map,
            tuning: crate::tuning::Tuning::default(),
            rng: Rng::new(seed ^ 0x5bf0_3635),
            time: 0.0,
            tick: 0,
            vehicles: Vec::with_capacity(64),
            projs: Vec::with_capacity(256),
            mines: Vec::with_capacity(64),
            turrets: Vec::new(),
            supply: Vec::new(),
            flags: [
                Flag {
                    team: 0,
                    state: flagstate::HOME,
                    pos: flag_home[0],
                    home: flag_home[0],
                    carrier: -1,
                    drop_t: 0.0,
                },
                Flag {
                    team: 1,
                    state: flagstate::HOME,
                    pos: flag_home[1],
                    home: flag_home[1],
                    carrier: -1,
                    drop_t: 0.0,
                },
            ],
            grid,
            dyn_block,
            fields: nav::Fields::new(),
            garage: [
                Garage {
                    parked: [1.0, 1.0, 1.0, 1.0],
                    building: [0.0; 4],
                },
                Garage {
                    parked: [1.0, 1.0, 1.0, 1.0],
                    building: [0.0; 4],
                },
            ],
            score: [0.0, 0.0],
            rounds: 0.0, // set from `tuning` below, once the struct exists
            state: matchstate::PLAYING,
            round_winner: -1,
            round_over_t: 0.0,
            drone_count: 0,
            sub_cd: [0.0; 2],
            next_id: 1,
            player_of_team: players,
            cpu_driven: [false, false],
            // Both match options default off; the web layer re-applies its choices through
            // `set_options` after every load, which is what fields (or strips) the allies.
            cpu_allies: false,
            ally_cd: [0.0, 0.0],
            spawn_cd: [0.0, 0.0],
            vehicle_cap: 0,
            // Default to medium: the report that started this treated the CPU's respawns as
            // effectively infinite, so the out-of-the-box fight should be the 1.5x one.
            difficulty: 1,
            sandbox: false,
            pending_request: [-1, -1],
            kills: [0.0; 2],
            deaths: [0.0; 2],
            captures: [0.0; 2],
            ai_cmd_t: 1.0,
            vviews: Vec::with_capacity(64),
            pviews: Vec::with_capacity(256),
            mviews: Vec::with_capacity(64),
            tviews: Vec::with_capacity(32),
            fviews: [FlagView::default(); 2],
            events: Vec::with_capacity(512),
            player_hud: [PlayerHud::default(); 2],
            team_hud: [TeamHud::default(); 2],
            terrain_rev: 1,
            nan_debug: None,
            scratch: Vec::with_capacity(64),
        };
        w.rounds = w.tuning.rules.rounds_to_win;
        w.spawn_turrets();
        w.rebuild_supply();
        w.initial_spawn();
        w.sync_views();
        w
    }

    /// True when some human player slot defends `team`.
    ///
    /// This is the gate for every CPU-force multiplier: a team with a human on it always runs
    /// the stock garage rules, whether or not that human has a hull out at the moment.
    fn team_has_human(&self, team: u8) -> bool {
        (0..2).any(|p| self.player_of_team[p] == team as i32)
    }

    /// CPU unit availability, as a multiple of the rules a human plays under.
    ///
    /// `1.0` (easy) is *exactly* the player's rules — `build_time` per hull with `parked`
    /// capped at 3 — so it is a fair baseline rather than a weakened AI. Medium and hard buy
    /// the CPU faster rebuilds and a deeper reserve, which is what "infinite respawns" was
    /// really reporting: at 1x the commander still refills a lost hull every `build_time`,
    /// so a player who kills faster than that never makes progress.
    pub fn unit_scale(&self) -> f32 {
        match self.difficulty {
            0 => 1.0,
            2 => 3.0,
            _ => 1.5, // 1 = medium, and any out-of-range value fails safe to the default.
        }
    }

    /// Apply the player-facing match options. Cheap and idempotent: safe to call after every
    /// `Sim.load`/restart and from the title screen's settings column.
    ///
    /// `difficulty` is clamped to 0..=2 (easy/medium/hard). Enabling `sandbox` tears down any
    /// force already on the field, so flipping it on from an in-progress match really does
    /// leave an empty range; switching it back off re-seeds the towers (the AI commander
    /// refills its own hulls on the next tick). Enabling `cpu_allies` fields a tank + jeep
    /// garrison on every human team immediately — like the range, the option acts on the live
    /// world, not just the next match; disabling it strips those ally hulls again. Entering
    /// allies while the range is up fields nothing: the range stays empty until it is switched
    /// off, and the commander refills the ally force from there on.
    pub fn set_options(&mut self, difficulty: u32, sandbox: bool, cpu_allies: bool) {
        self.difficulty = difficulty.min(2) as u8;
        let entering = sandbox && !self.sandbox;
        let leaving = !sandbox && self.sandbox;
        self.sandbox = sandbox;
        if entering {
            self.turrets.clear();
            // Every CPU hull (garrison, commander's field, drones, infantry) carries
            // `player == 0`; the player's own vehicles are never removed.
            self.vehicles.retain(|v| v.player > 0);
            self.drone_count = 0;
        } else if leaving {
            self.spawn_turrets();
        }
        let allies_in = cpu_allies && !self.cpu_allies;
        let allies_out = !cpu_allies && self.cpu_allies;
        self.cpu_allies = cpu_allies;
        if allies_in && !self.sandbox {
            for team in 0..2u8 {
                if self.team_has_human(team) {
                    self.spawn_garrison(vkind::TANK, team);
                    self.spawn_garrison(vkind::JEEP, team);
                }
            }
        } else if allies_out {
            for team in 0..2u8 {
                if !self.team_has_human(team) {
                    continue;
                }
                // The only CPU hulls a human team ever has are its allies: `player == 0` and
                // this team. The player's own vehicles (and any troops) stay put.
                self.vehicles.retain(|v| v.player > 0 || v.team != team);
                self.ally_cd[team as usize] = 0.0;
            }
        }
    }

    /// The ceiling the commander should hold for one team: the explicit [`Self::vehicle_cap`]
    /// when one is set, otherwise what the rules ask for.
    pub fn vehicle_ceiling(&self, rules: usize) -> usize {
        if self.vehicle_cap > 0 {
            self.vehicle_cap
        } else {
            rules
        }
    }

    /// Set the per-team ceiling on concurrent CPU hulls: `0` restores the rules (2 / 3 / 6 by
    /// difficulty, 2 for allies). Clamped to [`MAX_VEHICLE_CAP`].
    pub fn set_vehicle_cap(&mut self, cap: usize) {
        self.vehicle_cap = cap.min(MAX_VEHICLE_CAP);
    }

    /// True when this vehicle's owning player slot is CPU-driven (a demo hull). CPU vehicles
    /// never own a slot — that includes the CPU allies, which are plain `player == 0` hulls —
    /// so they report false.
    pub fn vehicle_cpu_driven(&self, vi: usize) -> bool {
        match self.vehicles.get(vi) {
            Some(v) if v.player > 0 => self.cpu_driven[(v.player - 1) as usize],
            _ => false,
        }
    }

    /// CPU-drive a player slot: the simulation's own AI flies that hull instead of taking
    /// human input. Attract/demo mode uses this so the "player" vehicle navigates, targets and
    /// fights like any other driver. (CPU-controlled *allies* are plain `player == 0` hulls
    /// fielded by the commander — see `cpu_allies`.)
    pub fn set_cpu_driven(&mut self, slot: usize, on: bool) {
        if slot < 2 {
            self.cpu_driven[slot] = on;
        }
    }

    /// Collect the supply structures once per round (they are static, only hp changes).
    pub fn rebuild_supply(&mut self) {
        self.supply.clear();
        for (i, s) in self.map.structures.iter().enumerate() {
            if s.alive() && (s.flag(sflag::FUEL) || s.flag(sflag::AMMO) || s.flag(sflag::REPAIR)) {
                self.supply.push(i as u32);
            }
        }
    }

    pub fn spawn_turrets(&mut self) {
        self.turrets.clear();
        // The practice range has no defence towers, so the tower fire control in `ai.rs` has
        // nothing to drive and the renderer has nothing to draw.
        if self.sandbox {
            return;
        }
        for (i, s) in self.map.structures.iter().enumerate() {
            if s.kind as u8 == skind::TURRET_TOWER {
                self.turrets.push(Turret {
                    struct_id: i as u32,
                    team: s.team as u8,
                    pos: s.pos(),
                    y: s.y,
                    yaw: self.rng.range(-3.14, 3.14),
                    reload: self.rng.range(0.5, 2.5),
                    target: -1,
                    alive: true,
                    acquire: 0.0,
                });
            }
        }
    }

    /// Field one half of a garrison pair — the opening force of a round, or the ally garrison
    /// when CPU allies are switched on — **if that team's spawn clock allows it**. The pair is a
    /// matched opening, but it is still two vehicles: the second waits for the commander, which
    /// tops the field back up to its target on its own cadence.
    ///
    /// Without that wait a round used to open with three hulls on one pad at once: the pair,
    /// plus the demo (CPU-driven) slot's own hull, all on the same tick.
    fn spawn_garrison(&mut self, kind: u8, team: u8) -> u32 {
        if self.spawn_cd[(team as usize).min(1)] > 0.0 {
            return 0;
        }
        self.spawn_vehicle(kind, team, 0)
    }

    fn initial_spawn(&mut self) {
        // Human players choose their first vehicle in the garage; the AI fields a garrison.
        // The range stays empty on purpose. With CPU allies on, a human team fields the same
        // garrison too — which is also how it comes back after every round restart: `new_round`
        // clears the vehicles and calls back here with `cpu_allies` still set.
        for team in 0..2u8 {
            let human = (0..2).any(|p| self.player_of_team[p] == team as i32);
            if !self.sandbox && (!human || self.cpu_allies) {
                self.spawn_garrison(vkind::TANK, team);
                self.spawn_garrison(vkind::JEEP, team);
            }
        }
    }

    /// Team that a player slot defends.
    pub fn player_team(&self, player: usize) -> u8 {
        if self.player_of_team[player] < 0 {
            1
        } else {
            player as u8
        }
    }

    /// Install a config file's tuning overrides, as the flat array `tuning::Tuning::layout()`
    /// describes. Missing or non-finite slots keep their compiled-in defaults, so this is safe
    /// to call with a partial config, and safe to call twice.
    ///
    /// Live hulls are re-issued their specs so a change is visible immediately rather than only
    /// on the next spawn - that is what makes "edit the config, watch the sim" possible. Their
    /// mutable state is not reset, only clamped into the new ranges (hp into the new maximum,
    /// fuel into the new tank), so re-applying the same config is a no-op.
    pub fn apply_tuning(&mut self, values: &[f32]) {
        self.tuning.apply(values);
        self.rounds = self.tuning.rules.rounds_to_win;
        for v in self.vehicles.iter_mut() {
            let spec = self.tuning.spec(v.kind);
            // A hull that was at full health stays at full health, rather than being left at the
            // old maximum it happened to spawn with: at boot the opening garrison is built before
            // the config file is applied, so without this a tuned-up tank would report 1234 hp
            // and sit at 300 - the compiled-in value - for the rest of the round.
            let was_full = v.hp >= v.spec.hp - 1e-3;
            v.hp = if was_full { spec.hp } else { v.hp.min(spec.hp) };
            v.fuel = if v.fuel >= v.spec.fuel_max - 1e-3 { spec.fuel_max } else { v.fuel.min(spec.fuel_max) };
            v.ammo0 = v.ammo0.min(spec.ammo0_max);
            v.ammo1 = v.ammo1.min(spec.ammo1_max);
            v.mines = v.mines.min(spec.mine_max);
            if spec.flying && !v.spec.flying {
                v.alt = spec.cruise_alt;
            }
            v.spec = spec;
        }
        self.rebuild_supply();
    }

    pub fn spawn_pos_for(&mut self, team: u8) -> Vec2 {
        // There are two spawn pads and there is nothing else to index: `team` is a `u8` here, and
        // a neutral (2) owner reaches this through a destroyed prop's defender spawn. Callers that
        // mean a neutral hull place it themselves; clamping keeps that path from panicking.
        let base = self.map.spawn[(team as usize).min(1)];
        let a = self.rng.range(-3.0, 3.0);
        base + v2(a, self.rng.range(-3.0, 3.0))
    }

    pub fn spawn_vehicle(&mut self, kind: u8, team: u8, player: u8) -> u32 {
        // Sandbox range: a CPU-held team never gets a hull, whatever asks for one. Gating the
        // funnel (rather than only `initial_spawn`/`ai::update`) is what closes the side doors:
        // destroying a building spawns infantry from `combat.rs` and a bailed-out driver spawns
        // one from `physics.rs`, and neither path runs through `ai::update`. Returns the
        // never-used id 0 because callers treat a missing id as "no vehicle".
        if self.sandbox && !self.team_has_human(team) {
            return 0;
        }
        // Every field spawn restarts that team's clock, so the commander's cadence is measured
        // from the last hull to appear however it got there (its own spawn, the opening
        // garrison, or a human's deploy - the human is never made to wait). Troops, crews and
        // the counter-battery drones are not "the field" and do not touch it.
        if matches!(kind, vkind::JEEP | vkind::TANK | vkind::HRSV | vkind::HELI) {
            self.spawn_cd[(team as usize).min(1)] = CPU_SPAWN_DELAY;
        }
        // The tuned spec for this kind, and the copy the hull keeps for life: a hull is
        // simulated against the numbers it was built with, so a config change mid-round cannot
        // half-apply (see `apply_tuning`, which re-issues them on purpose).
        let spec = self.tuning.spec(kind);
        let id = self.next_id;
        self.next_id += 1;
        let mut pos = self.spawn_pos_for(team);
        // A fresh spawn must not start in contact with an existing friendly hull: two hulls
        // that spawn touching push each other every tick and stall (measured: map 0 seed 3 —
        // a tank and a jeep came out of the pad at exactly their radii sum, and neither left
        // the base in 45 s). Nudge the new hull away from every same-team ground hull until
        // clear; the pad is open ground, so a few extra metres put it against nothing.
        for _ in 0..8 {
            let Some(oi) = self.vehicles.iter().position(|v| {
                v.team == team
                    && v.alive()
                    && !v.spec().flying
                    && v.pos.dist(pos) < spec.radius + v.spec().radius + 0.6
            }) else {
                break;
            };
            let other = &self.vehicles[oi];
            let need = spec.radius + other.spec().radius + 0.6;
            let away = pos - other.pos;
            pos += if away.len_sq() > 1e-4 {
                away.norm() * need - away
            } else {
                v2(1.0, 0.3).norm() * need
            };
        }
        // Parked facing out of its own gateway: the front of the hull points at the base's
        // front gate, so a driver who deploys can drive straight and out. The user asked for
        // exactly this, and it is what the spawn bay was laid out for — the pad sits 19.5 m
        // behind the opening on the same axis, with nothing solid between them.
        //
        // Two earlier attempts at "facing out" wedged map 2 seed 7 (the AI tank's base-exit
        // audit drives a hull out of its own base on every map and seed): the flow field's
        // direction points at whatever the AI is attacking, and the base axis left a hull with
        // no lateral error to correct against the gateway jamb. What makes the gate itself safe
        // now is that `ai.rs` steers at the gate for as long as the hull is inside the walls
        // (the exit corridor) and tests short rays against the nav grid before following the
        // field, so a jamb or a building in the lane is turned away from before contact. The
        // fixed 0.7 rad heading stays only where no base was ever recorded. `tests/bridge_audit.rs`
        // is the check.
        let yaw = match self.gate_pos(team) {
            Some(gate) => (gate - pos).heading(),
            None => 0.7,
        };

        let y = self.map.height_at(pos.x, pos.y).max(self.map.water_level);
        let v = Vehicle {
            id,
            kind,
            spec,
            team,
            state: vstate::ACTIVE,
            pos,
            y,
            yaw,
            vel: Vec2::ZERO,
            fwd_speed: 0.0,
            hp: spec.hp,
            fuel: spec.fuel_max,
            ammo0: spec.ammo0_max,
            ammo1: spec.ammo1_max,
            mines: spec.mine_max,
            turret_yaw: yaw,
            gun_pitch: 0.0,
            reload0: 0.0,
            reload1: 0.0,
            burst: 0,
            burst_t: 0.0,
            anim: 0.0,
            flags: if player > 0 { vflag::IS_PLAYER } else { 0 },
            build_t: 0.0,
            player,
            ai: AiState {
                last_pos: pos,
                escape_dir: if self.rng.chance(0.5) { 1.0 } else { -1.0 },
                skill: self.rng.range(0.45, 0.95),
                jitter: self.rng.range(0.0, 6.28),
                strafe_dir: if self.rng.chance(0.5) { 1.0 } else { -1.0 },
                ..Default::default()
            },
            pitch: 0.0,
            roll: 0.0,
            hit_flash: 0.0,
            wreck_t: 0.0,
            wreck_vy: 0.0,
            wreck_block: usize::MAX,
            idle_t: 0.0,
            airborne: spec.flying,
            alt: if spec.flying { spec.cruise_alt } else { 0.0 },
            last_fire: -99.0,
            aim_err: 0.0,
            smoke_t: 0.0,
            engine_load: 0.2,
            spawn_guard: self.tuning.rules.spawn_guard,
            home_safe: self.tuning.rules.home_safe_time,
            ai_input: Input::default(),
        };
        self.vehicles.push(v);
        self.sound(sfx::ENGINE_START, pos, spec.height * 0.5, 0.8);
        id
    }

    pub fn vehicle_index(&self, id: u32) -> Option<usize> {
        self.vehicles.iter().position(|v| v.id == id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn push_event(&mut self, kind: u8, p: Vec2, y: f32, z: f32, a: f32, b: f32, c: f32, d: f32) {
        if self.events.len() < 8192 {
            self.events.push(EventView {
                kind: kind as f32,
                x: p.x,
                y,
                z: if z != 0.0 { z } else { p.y },
                a,
                b,
                c,
                d,
            });
        }
    }

    pub fn sound(&mut self, id: f32, p: Vec2, y: f32, gain: f32) {
        self.push_event(ekind::SOUND, p, y, 0.0, id, gain, 0.0, 0.0);
    }

    pub fn notify(&mut self, id: f32, team: u8) {
        self.push_event(ekind::NOTIFY, Vec2::ZERO, 0.0, 0.0, id, team as f32, 0.0, 0.0);
    }

    pub fn explosion(&mut self, p: Vec2, y: f32, scale: f32) {
        let kind = if scale > 1.6 {
            ekind::BIG_EXPLOSION
        } else {
            ekind::EXPLOSION
        };
        self.push_event(kind, p, y, 0.0, scale, 0.0, 0.0, 0.0);
        let jitter = self.rng.f32();
        self.push_event(ekind::SCORCH, p, y, 0.0, scale * 1.4, jitter, 0.0, 0.0);
        let s = if scale > 1.6 {
            sfx::EXPLOSION_BIG
        } else {
            sfx::EXPLOSION_SMALL
        };
        self.sound(s, p, y, (0.6 + scale * 0.25).min(1.0));
    }

    /// Fixed timestep update.
    pub fn step(&mut self, dt: f32, inputs: &[Input; 2]) {
        self.events.clear();
        self.time += dt;
        self.tick = self.tick.wrapping_add(1);

        if self.state != matchstate::PLAYING {
            self.round_over_t -= dt;
            if self.round_over_t <= 0.0 {
                self.new_round();
            }
            self.sync_views();
            return;
        }

        self.update_garage(dt);
        self.update_resupply(dt);
        self.update_flags(dt);
        // The AI thinks first so `ai_input` is fresh when physics runs. On the practice range
        // there is no AI at all: `ai::update` is the only thing that spawns the commander's
        // hulls, flies the drones and runs tower fire control, so skipping it is what keeps
        // the range empty (the per-hull AI *movement* is skipped with it). `update_garage`
        // above still runs, so the player's own garage keeps working.
        if !self.sandbox {
            ai::update(self, dt);
        }
        physics::drive_vehicles(self, dt, inputs);
        combat::update_projectiles(self, dt);
        combat::update_mines(self, dt);
        physics::resolve_vehicle_collisions(self, dt);
        self.update_bounds(dt);
        self.cull(dt);
        nav::update_fields(self, dt);
        self.sync_views();
    }

    pub fn new_round(&mut self) {
        // A fresh round opens with a clean spawn clock on both sides, so the garrison pair comes
        // out on the same tick it always did and only the *reinforcements* wait their turn.
        self.spawn_cd = [0.0, 0.0];
        if self.state == matchstate::MATCH_OVER {
            self.score = [0.0, 0.0];
            self.kills = [0.0; 2];
            self.deaths = [0.0; 2];
            self.captures = [0.0; 2];
        }
        self.state = matchstate::PLAYING;
        self.round_winner = -1;
        self.nan_debug = None; // the old hulls are gone with the vehicles
        self.vehicles.clear();
        self.projs.clear();
        self.mines.clear();
        for s in self.map.structures.iter_mut() {
            s.hp = s.hp_max;
            s.flags = (s.flags as u32 & !sflag::DEAD) as f32;
        }
        self.dyn_block.iter_mut().for_each(|b| *b = false);
        self.grid = StructGrid::build(&self.map);
        self.spawn_turrets();
        self.rebuild_supply();
        for f in self.flags.iter_mut() {
            f.state = flagstate::HOME;
            f.pos = f.home;
            f.carrier = -1;
            f.drop_t = 0.0;
        }
        for g in self.garage.iter_mut() {
            g.parked = [1.0, 1.0, 1.0, 1.0];
            g.building = [0.0; 4];
        }
        self.next_id = 1;
        self.drone_count = 0;
        self.pending_request = [-1, -1];
        // A fresh round just re-fielded the garrison above: its supply line starts clean too.
        self.ally_cd = [0.0, 0.0];
        self.initial_spawn();
        self.terrain_rev += 1;
    }

    /// Test/console seam: end the current round as a capture would, for `winner`.
    ///
    /// This is the *real* round-over flow — score and capture count, both flags returned home,
    /// `end_round` with its notification and sting, and a match win once the score reaches
    /// `rounds`. `force_next_round` skips all of that (it only restarts the round), so the
    /// console commands use this one when what they want to see is the round *ending*.
    /// No gameplay code calls it.
    pub fn force_round_for(&mut self, winner: u8) {
        if self.state != matchstate::PLAYING {
            return;
        }
        let w = (winner as usize).min(1);
        self.score[w] += 1.0;
        self.captures[w] += 1.0;
        // A capture leaves both flags on their stands; do the same, so the round-over seconds
        // do not show a flag still in someone's hands.
        for f in self.flags.iter_mut() {
            f.state = flagstate::HOME;
            f.pos = f.home;
            f.carrier = -1;
        }
        self.end_round(w as u8);
    }

    pub fn end_round(&mut self, winner: u8) {
        self.round_winner = winner as i32;
        self.state = matchstate::ROUND_OVER;
        self.round_over_t = 5.5;
        if winner == 0 {
            self.notify(notify::ROUND_WON, 0);
        } else {
            self.notify(notify::ROUND_LOST, 0);
        }
        self.sound(sfx::FLAG_CAPTURE, self.flags[winner as usize].home, 2.0, 1.0);
        if self.score[winner as usize] >= self.rounds {
            self.state = matchstate::MATCH_OVER;
            self.round_over_t = 7.0;
        }
    }

    fn update_garage(&mut self, dt: f32) {
        for t in 0..2 {
            // A CPU-held team gets the difficulty's unit availability; a human team is always
            // 1x, so two-player split screen keeps both players on identical garage rules and
            // easy really is "the same as the player". `scale` drives both halves of the
            // multiplier: the countdown advances `scale` times as fast, and the reserve cap
            // grows with it so the faster build has somewhere to go.
            let scale = if self.team_has_human(t as u8) {
                1.0
            } else {
                self.unit_scale()
            };
            let parked_cap = (3.0 * scale).min(9.0);
            for slot in 0..4 {
                let b = self.garage[t].building[slot];
                if b > 0.0 {
                    let nb = b - dt * scale;
                    self.garage[t].building[slot] = nb.max(0.0);
                    if nb <= 0.0 {
                        self.garage[t].parked[slot] =
                            (self.garage[t].parked[slot] + 1.0).min(parked_cap);
                        let p = self.map.spawn[t];
                        self.sound(sfx::BUILD_DONE, p, 1.0, 0.6);
                    }
                }
            }
        }
        // Pending player requests are honoured as soon as a hull is available.
        for p in 0..2 {
            let kind = self.pending_request[p];
            if kind < 0 {
                continue;
            }
            let team = self.player_team(p);
            let slot = vehicle::GARAGE.iter().position(|k| *k == kind as u8).unwrap_or(0);
            // A CPU-driven slot (attract/demo mode) is part of the same cadence as the
            // commander it fights beside: one field vehicle a team every `CPU_SPAWN_DELAY`,
            // whichever of them asks first. A human's own deploy never waits - that is the
            // whole point of the clock being checked here rather than inside `spawn_vehicle`.
            if self.cpu_driven[p] && self.spawn_cd[(team as usize).min(1)] > 0.0 {
                continue;
            }
            if self.garage[team as usize].parked[slot] >= 1.0 {
                self.garage[team as usize].parked[slot] -= 1.0;
                self.garage[team as usize].building[slot] = vehicle::spec(kind as u8).build_time;
                self.spawn_vehicle(kind as u8, team, p as u8 + 1);
                self.pending_request[p] = -1;
            }
        }
    }

    /// Ask for a vehicle for player `player`; queued until the garage has a hull ready.
    /// Any vehicle the player is currently driving is retired so a player never owns two.
    pub fn request_vehicle(&mut self, player: usize, kind: u8) {
        if player >= 2 {
            return;
        }
        let slot = player as u8 + 1;
        for v in self.vehicles.iter_mut() {
            if v.player == slot && v.alive() {
                v.state = vstate::WRECK;
                v.wreck_t = 0.0;
            }
        }
        self.pending_request[player] = kind as i32;
    }

    /// Fuel depots, ammo tents and the base helipad refill whatever is parked on them.
    ///
    /// As in the original: land vehicles can use any depot they can reach (including the
    /// enemy's), while the helicopter may only rearm at its own base, and mines are the one
    /// thing that can never be restocked.
    fn update_resupply(&mut self, dt: f32) {
        for v in self.vehicles.iter_mut() {
            v.flags &= !vflag::RESUPPLYING;
        }
        for vi in 0..self.vehicles.len() {
            if !self.vehicles[vi].alive() {
                continue;
            }
            let spec = *self.vehicles[vi].spec();
            if matches!(spec.kind, vkind::TROOP | vkind::DRONE | vkind::SUBMARINE) {
                continue;
            }
            let pos = self.vehicles[vi].pos;
            let team = self.vehicles[vi].team;
            let (mut fuel, mut ammo, mut repair) = (false, false, false);
            for k in 0..self.supply.len() {
                // Copy the record so the borrow checker lets us mutate vehicles below.
                let s = self.map.structures[self.supply[k] as usize];
                if !s.alive() || s.dist_to(pos) > 6.0 {
                    continue;
                }
                // The helicopter is tied to its own base; everyone else can steal supplies.
                if spec.flying && (s.team >= 2.0 || s.team as u8 != team) {
                    continue;
                }
                fuel |= s.flag(sflag::FUEL);
                ammo |= s.flag(sflag::AMMO);
                repair |= s.flag(sflag::REPAIR);
            }
            if !(fuel || ammo || repair) {
                continue;
            }
            let v = &mut self.vehicles[vi];
            let want_fuel = fuel && v.fuel < spec.fuel_max - 0.01;
            let want_ammo = ammo && (v.ammo0 < spec.ammo0_max - 0.01 || v.ammo1 < spec.ammo1_max - 0.01);
            let want_fix = repair && v.hp < spec.hp - 0.01;
            if !(want_fuel || want_ammo || want_fix) {
                continue;
            }
            if want_fuel {
                v.fuel = (v.fuel + 26.0 * dt).min(spec.fuel_max);
            }
            if want_ammo {
                v.ammo0 = (v.ammo0 + 22.0 * dt).min(spec.ammo0_max);
                v.ammo1 = (v.ammo1 + 7.0 * dt).min(spec.ammo1_max);
            }
            if want_fix {
                v.hp = (v.hp + 24.0 * dt).min(spec.hp);
            }
            v.flags |= vflag::RESUPPLYING;
            v.smoke_t -= dt;
            if v.smoke_t <= 0.0 {
                v.smoke_t = 0.75;
                self.sound(sfx::RESUPPLY, pos, 1.2, 0.45);
            }
        }
    }

    fn update_flags(&mut self, dt: f32) {
        for i in 0..2 {
            if self.flags[i].state == flagstate::CARRIED {
                let c = self.flags[i].carrier;
                let alive = self
                    .vehicle_index(c as u32)
                    .map(|vi| self.vehicles[vi].alive())
                    .unwrap_or(false);
                if alive {
                    let p = self.vehicles[self.vehicle_index(c as u32).unwrap()].pos;
                    self.flags[i].pos = p;
                } else {
                    self.flags[i].state = flagstate::DROPPED;
                    self.flags[i].carrier = -1;
                    self.flags[i].drop_t = self.tuning.rules.flag_return_time;
                    self.notify(notify::FLAG_DROPPED, i as u8);
                }
            }
            if self.flags[i].state == flagstate::DROPPED {
                let d = self.flags[i].drop_t - dt;
                self.flags[i].drop_t = d;
                if d <= 0.0 {
                    self.flags[i].state = flagstate::HOME;
                    self.flags[i].pos = self.flags[i].home;
                    self.notify(notify::FLAG_RETURNED, i as u8);
                }
            }
        }

        for vi in 0..self.vehicles.len() {
            if !self.vehicles[vi].alive() {
                continue;
            }
            let spec = self.vehicles[vi].spec();
            let team = self.vehicles[vi].team;
            let pos = self.vehicles[vi].pos;
            let enemy = (1 - team) as usize;
            let est = self.flags[enemy].state;
            if spec.can_carry_flag
                && (est == flagstate::HOME || est == flagstate::DROPPED)
                && pos.dist(self.flags[enemy].pos) < self.tuning.rules.flag_pickup_range
            {
                self.flags[enemy].state = flagstate::CARRIED;
                self.flags[enemy].carrier = self.vehicles[vi].id as i32;
                self.vehicles[vi].flags |= vflag::CARRYING_FLAG;
                self.notify(notify::FLAG_TAKEN, team);
                self.sound(sfx::FLAG_PICKUP, pos, 1.0, 1.0);
                self.push_event(ekind::FLAG_TAKEN, pos, 1.0, 0.0, team as f32, 0.0, 0.0, 0.0);
            }
            let own = team as usize;
            if self.flags[own].state == flagstate::DROPPED
                && pos.dist(self.flags[own].pos) < self.tuning.rules.flag_pickup_range + 1.2
            {
                self.flags[own].state = flagstate::HOME;
                self.flags[own].pos = self.flags[own].home;
                self.notify(notify::FLAG_RETURNED, team);
                self.sound(sfx::FLAG_PICKUP, pos, 1.0, 0.8);
            }
        }

        // Score: bring the enemy flag inside your own walls while your own flag is on its stand.
        //
        // The bar is the *compound*, not a circle around the stand: any part of the enemy flag
        // carried inside your own perimeter counts, so a runner who gets through the gate has
        // scored whether it drives to the stand or stops in the yard. That is what "make capping
        // easier" means now that the walls are breachable — the gate is the objective, and the
        // last twenty metres across the plaza are not a separate challenge.
        //
        // A map with no recorded base frame (an old `.rfmap`) has no perimeter to test against,
        // so those fall back to the old 7 m around the stand rather than becoming uncapturable.
        for vi in 0..self.vehicles.len() {
            if !self.vehicles[vi].alive() || !self.vehicles[vi].carrying_flag() {
                continue;
            }
            let team = self.vehicles[vi].team;
            let pos = self.vehicles[vi].pos;
            let own = team as usize;
            let home_ = self.inside_base_walls(team, pos);
            let legacy = !self.has_base_frame(team) && pos.dist(self.flags[own].home) < 7.0;
            if self.flags[own].state == flagstate::HOME && (home_ || legacy) {
                self.vehicles[vi].flags &= !vflag::CARRYING_FLAG;
                let enemy = 1 - own;
                self.flags[enemy].state = flagstate::HOME;
                self.flags[enemy].pos = self.flags[enemy].home;
                self.flags[enemy].carrier = -1;
                self.score[own] += 1.0;
                self.captures[own] += 1.0;
                self.notify(notify::FLAG_CAPTURED, team);
                self.push_event(ekind::FLAG_CAPTURED, pos, 1.0, 0.0, team as f32, 0.0, 0.0, 0.0);
                self.end_round(team);
                return;
            }
        }
    }

    fn update_bounds(&mut self, dt: f32) {
        let mut want_sub: [Option<Vec2>; 2] = [None, None];
        for v in self.vehicles.iter() {
            if !v.alive() || v.player == 0 {
                continue;
            }
            let p = v.pos;
            let world = self.map.world_size;
            if p.x < -rules::BORDER
                || p.y < -rules::BORDER
                || p.x > world + rules::BORDER
                || p.y > world + rules::BORDER
            {
                want_sub[v.team as usize] = Some(p);
            }
        }
        // Every hull is leashed to the playable box, every tick, whatever drove it out there —
        // AI, a collision, or the water shove in `physics.rs::step_vehicle`. Vehicles that
        // wander out are reported by the submarine rule above; this only guarantees that the
        // terrain lookup never sees a coordinate it cannot answer for, because a NaN position
        // is unrecoverable and spreads into y, aim, projectiles and the camera.
        //
        // A non-finite state must also *heal*, not just be hidden: clamping the position alone
        // leaves a NaN vel/fwd_speed/yaw behind, and the next integration re-poisons the
        // position from it (a lerp or product with a NaN operand is NaN) — the hull then sits
        // pinned at map centre, invisible if its y is also gone, for the rest of the match.
        // That was the "vehicles no longer spawn" report: every ground hull pinned at once,
        // while helis (a separate integration path) kept flying. Re-seat and zero the motion
        // so the hull comes back as a stopped, visible vehicle the AI or player can drive off.
        for vi in 0..self.vehicles.len() {
            // Decide the healed state from a read-only pass, then apply it: the ground-height
            // lookup borrows `self`, so it must not run while a vehicle is mutably borrowed.
            let ws = self.map.world_size;
            let pos = self.vehicles[vi].pos;
            let reseat = !pos.x.is_finite() || !pos.y.is_finite();
            let healed_pos = if reseat {
                v2(ws * 0.5, ws * 0.5)
            } else {
                physics::clamp_to_playable(pos, ws, self.tuning.rules.border)
            };
            let yaw = self.vehicles[vi].yaw;
            let vel = self.vehicles[vi].vel;
            let spd = self.vehicles[vi].fwd_speed;
            let y = self.vehicles[vi].y;
            let ground = if !y.is_finite() {
                Some(self.ground_height(healed_pos))
            } else {
                None
            };

            let v = &mut self.vehicles[vi];
            v.pos = healed_pos;
            if reseat {
                v.vel = Vec2::ZERO;
                v.fwd_speed = 0.0;
            }
            if !yaw.is_finite() {
                v.yaw = 0.0;
            }
            if !vel.x.is_finite() || !vel.y.is_finite() {
                v.vel = Vec2::ZERO;
            }
            if !spd.is_finite() {
                v.fwd_speed = 0.0;
            }
            if let Some(g) = ground {
                v.y = g;
            }
        }
        for t in 0..2 {
            self.sub_cd[t] = (self.sub_cd[t] - dt).max(0.0);
            // The range never calls in the out-of-bounds submarine: it is an enemy hull, and
            // launching it happens here in `world.rs` rather than in the skipped `ai::update`.
            if self.sandbox {
                continue;
            }
            if let Some(p) = want_sub[t] {
                if self.sub_cd[t] <= 0.0 {
                    self.sub_cd[t] = self.tuning.rules.sub_cooldown;
                    ai::launch_submarine(self, t as u8, p);
                    self.notify(notify::OUT_OF_BOUNDS, t as u8);
                }
            }
        }
    }

    /// Keep destroyed hulls moving. A ground wreck ploughs straight on, shedding speed
    /// until it stops; a flyer has lost its lift, so it falls under gravity, keeps its
    /// forward momentum and tumbles, then bursts on contact and becomes a ground wreck.
    ///
    /// Called from `cull`, which runs after `physics::drive_vehicles` and before the
    /// wreck-lifetime retain, so this never fights the live physics step. The hull never
    /// steers: `vel` is only ever scaled, so a wreck keeps the heading it died on.
    fn integrate_wrecks(&mut self, dt: f32) {
        for vi in 0..self.vehicles.len() {
            if self.vehicles[vi].state != vstate::WRECK {
                continue;
            }
            if self.vehicles[vi].airborne {
                // ---- falling flyer ---------------------------------------------------
                self.vehicles[vi].wreck_vy -= self.tuning.rules.wreck_gravity * dt;
                self.vehicles[vi].y += self.vehicles[vi].wreck_vy * dt;
                let step = self.vehicles[vi].vel * dt;
                self.vehicles[vi].pos += step;
                // Tumble: yaw plus the pitch/roll the view already carries. Wrapped so a
                // 14 s burn does not accumulate tens of radians of attitude.
                self.vehicles[vi].yaw =
                    wrap_angle(self.vehicles[vi].yaw + self.tuning.rules.wreck_tumble_yaw * dt);
                self.vehicles[vi].pitch =
                    wrap_angle(self.vehicles[vi].pitch + self.tuning.rules.wreck_tumble_pitch * dt);
                self.vehicles[vi].roll =
                    wrap_angle(self.vehicles[vi].roll + self.tuning.rules.wreck_tumble_roll * dt);
                let ground = self.ground_height(self.vehicles[vi].pos);
                if self.vehicles[vi].y <= ground {
                    // Ground impact: one explosion, then it lies still as a ground wreck.
                    self.vehicles[vi].y = ground;
                    self.vehicles[vi].airborne = false;
                    self.vehicles[vi].wreck_vy = 0.0;
                    self.vehicles[vi].vel = Vec2::ZERO;
                    self.vehicles[vi].fwd_speed = 0.0;
                    self.vehicles[vi].pitch = 0.0;
                    self.vehicles[vi].roll = 0.0;
                    let pos = self.vehicles[vi].pos;
                    let scale = 1.0 + self.vehicles[vi].spec().hp / 300.0;
                    self.explosion(pos, self.vehicles[vi].y + 0.8, scale);
                    self.push_event(ekind::DEBRIS, pos, self.vehicles[vi].y, 0.0, 14.0, 0.35, 0.0, 0.0);
                    // The crash blast: where a downed Cobra hits, what stood there goes with it -
                    // hulls, wall sections, buildings (see `combat::heli_crash_blast`). Drones are
                    // too small to bring one down with them.
                    if self.vehicles[vi].kind == vkind::HELI {
                        combat::heli_crash_blast(self, pos, self.vehicles[vi].y, self.vehicles[vi].team);
                    }
                }
            } else {
                // ---- coasting ground wreck -------------------------------------------
                if self.vehicles[vi].vel.len() > 0.05 {
                    let keep = (1.0 - self.tuning.rules.wreck_drag * dt).max(0.0);
                    self.vehicles[vi].vel = self.vehicles[vi].vel * keep;
                    self.vehicles[vi].fwd_speed = self.vehicles[vi].vel.len();
                    let step = self.vehicles[vi].vel * dt;
                    self.vehicles[vi].pos += step;
                    if self.vehicles[vi].vel.len() < 0.15 {
                        self.vehicles[vi].vel = Vec2::ZERO;
                        self.vehicles[vi].fwd_speed = 0.0;
                    }
                }
                // Stay on the surface: a wreck that rolls off a slope must not hover.
                let ground = self.ground_height(self.vehicles[vi].pos);
                self.vehicles[vi].y = lerp(self.vehicles[vi].y, ground, (dt * 8.0).min(1.0));
            }
        }
    }

    /// True when some **destroyed** structure's footprint still blocks nav `cell`.
    ///
    /// Mirrors the predicate `combat::block_footprint` writes with, so a cell shared by a
    /// wreck and a destroyed bridge cannot be unblocked by the wreck's departure: the bridge
    /// rubble is still there.
    fn destroyed_structure_blocks(&self, cell: usize) -> bool {
        let g = self.map.grid as i32;
        let cx = (cell as i32) % g;
        let cz = (cell as i32) / g;
        let p = v2((cx as f32 + 0.5) * self.map.cell, (cz as f32 + 0.5) * self.map.cell);
        let mut buf = [0u32; 32];
        let n = self.grid.query_into(p, self.map.cell * 2.0, &mut buf);
        for i in 0..n {
            let s = &self.map.structures[buf[i] as usize];
            if s.alive() {
                continue;
            }
            if s.dist_to(p) < self.map.cell * 0.75 {
                return true;
            }
        }
        false
    }

    fn cull(&mut self, dt: f32) {
        // Wreck motion runs here rather than in `physics.rs`: `drive_vehicles` only touches
        // `alive()` hulls, and `cull` already runs after it, so this is the one place a
        // destroyed vehicle can be moved without teaching the physics step about wrecks.
        self.integrate_wrecks(dt);
        // Indexed rather than `iter_mut`: the home-zone test needs `&self.map` at the same
        // time as `&mut self.vehicles`.
        for vi in 0..self.vehicles.len() {
            let (team, pos) = (self.vehicles[vi].team, self.vehicles[vi].pos);
            let at_home = self.in_home_zone(team, pos);
            let v = &mut self.vehicles[vi];
            if v.spawn_guard > 0.0 {
                v.spawn_guard = (v.spawn_guard - dt).max(0.0);
            }
            // Only burns while the driver is actually at home: breaking contact by falling
            // back is what buys the rest of the grace period.
            if v.home_safe > 0.0 && at_home {
                v.home_safe = (v.home_safe - dt).max(0.0);
            }
            if v.state == vstate::WRECK {
                v.wreck_t -= dt;
            }
            if v.hit_flash > 0.0 {
                v.hit_flash = (v.hit_flash - dt * 3.0).max(0.0);
            }
        }
        // Hand back the road a disappearing wreck was blocking, *before* it is dropped -
        // `retain` is the only place the hulk goes away, so this is the only chance to clear
        // its flag. A cell is only released when nothing else needs it shut: a second wreck
        // still registered on the same cell, or a destroyed structure whose footprint covers
        // it (`combat::block_footprint` uses the same 0.75-cell radius), keeps it blocked.
        for vi in 0..self.vehicles.len() {
            let v = &self.vehicles[vi];
            if v.state != vstate::WRECK || v.wreck_t > 0.0 || v.wreck_block == usize::MAX {
                continue;
            }
            let cell = v.wreck_block;
            let id = v.id;
            let others = self.vehicles.iter().any(|o| {
                o.id != id && o.state == vstate::WRECK && o.wreck_block == cell
            });
            if !others && !self.destroyed_structure_blocks(cell) {
                self.dyn_block[cell] = false;
            }
            self.vehicles[vi].wreck_block = usize::MAX;
        }
        self.vehicles
            .retain(|v| !(v.state == vstate::WRECK && v.wreck_t <= 0.0));
        self.projs.retain(|p| p.life > 0.0);
        self.mines.retain(|m| m.armed >= 0.0);
    }

    /// Destroy a vehicle, spawn a wreck and (for players) start the garage rebuild.
    pub fn kill_vehicle(&mut self, vi: usize, by: i32) {
        let spec = vehicle::spec(self.vehicles[vi].kind);
        let pos = self.vehicles[vi].pos;
        let team = self.vehicles[vi].team as usize;
        let kind = self.vehicles[vi].kind;
        let scale = 1.0 + spec.hp / 300.0;
        self.explosion(pos, self.vehicles[vi].y + 0.8, scale);
        self.push_event(ekind::DEBRIS, pos, self.vehicles[vi].y, 0.0, 18.0, 0.4, 0.0, 0.0);
        self.vehicles[vi].state = vstate::WRECK;
        self.vehicles[vi].hp = 0.0;
        self.vehicles[vi].wreck_t = self.tuning.rules.wreck_time;
        // Momentum, not a handbrake. `kill_vehicle` used to zero `vel`/`fwd_speed` here,
        // which is the reported "destroyed vehicles freeze the instant they die". A ground
        // hull now keeps most of its impact speed and bleeds it off in `integrate_wrecks`;
        // a flyer keeps all of its forward momentum and loses lift instead.
        let falling = spec.flying && self.vehicles[vi].airborne;
        self.vehicles[vi].wreck_vy = 0.0;
        if falling {
            // Flyer: keep `airborne`, which `integrate_wrecks` reads to mean "still falling".
        } else {
            self.vehicles[vi].airborne = false;
            self.vehicles[vi].vel = self.vehicles[vi].vel * self.tuning.rules.wreck_coast;
            self.vehicles[vi].fwd_speed *= self.tuning.rules.wreck_coast;
        }
        // A helicopter that dies on the ground (low hover, fuel out at deck level) never gets an
        // impact moment, so its fireball lands here; the falling case is answered at ground
        // contact in `integrate_wrecks`. One blast per crash, always at the spot that hits.
        if kind == vkind::HELI && !falling {
            combat::heli_crash_blast(self, pos, self.vehicles[vi].y, self.vehicles[vi].team);
        }
        self.vehicles[vi].flags &= !vflag::CARRYING_FLAG;
        if by >= 0 && by < 2 {
            self.kills[by as usize] += 1.0;
        }
        if self.vehicles[vi].player > 0 {
            self.deaths[team] += 1.0;
            self.notify(notify::VEHICLE_LOST, team as u8);
            self.sound(sfx::LAUGH, pos, 2.0, 0.9);
            self.push_event(ekind::SKULL, pos, 2.0, 0.0, 1.0, 0.0, 0.0, 0.0);
        }
        // Wrecks of large vehicles briefly block the road.
        if spec.hp >= 300.0 {
            let ci = self.cell_index(pos);
            self.dyn_block[ci] = true;
            self.vehicles[vi].wreck_block = ci;
        }
        let slot = vehicle::GARAGE.iter().position(|k| *k == kind).unwrap_or(0);
        self.garage[team].building[slot] = (self.garage[team].building[slot]).max(spec.build_time * 0.6);
    }

    /// Intact bridge deck height at a point, if any (vehicles drive on these).
    pub fn bridge_deck(&self, p: Vec2) -> Option<f32> {
        let mut buf = [0u32; 16];
        let n = self.grid.query_into(p, 3.0, &mut buf);
        let mut best: Option<f32> = None;
        for i in 0..n {
            let s = &self.map.structures[buf[i] as usize];
            if s.kind as u8 != skind::BRIDGE || !s.alive() {
                continue;
            }
            if s.dist_to(p) <= 0.6 {
                let top = s.y + s.h;
                best = Some(best.map_or(top, |b: f32| b.max(top)));
            }
        }
        best
    }

    /// Drivable surface height: terrain, or a bridge deck when one spans this point.
    pub fn ground_height(&self, p: Vec2) -> f32 {
        let terrain = self.map.height_at(p.x, p.y);
        let g = match self.bridge_deck(p) {
            Some(deck) => terrain.max(deck),
            None => terrain,
        };
        g.max(self.map.water_level)
    }

    /// True when a vehicle at `p` would be floating rather than on a deck or dry land.
    pub fn in_water(&self, p: Vec2) -> bool {
        self.map.height_at(p.x, p.y) <= self.map.water_level && self.bridge_deck(p).is_none()
    }

    /// The centre of `team`'s home zone: its own spawn pad, which is where the garage door
    /// opens onto. Taken from `map.spawn` so this follows the map whatever its size.
    pub fn home_center(&self, team: u8) -> Vec2 {
        self.map.spawn[team.min(1) as usize]
    }

    /// True when `p` is inside `team`'s home zone. The zone is a disc of
    /// `rules::HOME_SAFE_RADIUS` metres around that team's spawn pad — about the width of the
    /// base complex itself (`mapgen::BASE_HX`), deliberately not large enough to cover the
    /// flag stand, so the objective is never inside the bubble.
    pub fn in_home_zone(&self, team: u8, p: Vec2) -> bool {
        p.dist(self.home_center(team)) <= rules::HOME_SAFE_RADIUS
    }

    /// The world position of `team`'s front gate — the opening in its base perimeter that faces
    /// the enemy. Spawned hulls point at it so they can drive straight out of the base, and the
    /// AI's exit corridor steers at it while a hull is still inside the walls.
    ///
    /// The position comes from the recorded base anchor (`map.base_anchor`, written wherever a
    /// base is built). When a gate structure actually stands there it wins over the prediction:
    /// on a map whose anchor was never recorded (an old `.rfmap`) the prediction can be off by
    /// half a base, and the front gate is still recognisable as the team's own gate nearest the
    /// predicted point — the sally port sits 38 m away on the other side of the perimeter.
    pub fn gate_pos(&self, team: u8) -> Option<Vec2> {
        let t = (team as usize).min(1);
        let (anchor, yaw) = self.map.base_anchor[t];
        if anchor.len_sq() < 0.01 {
            return None;
        }
        let predicted = from_local(mapgen::GATE_LOCAL, anchor, yaw);
        let mut best: Option<Vec2> = None;
        let mut bd = f32::INFINITY;
        for s in self.map.structures.iter() {
            if !s.alive() || s.kind as u8 != skind::GATE || (s.team as u8) != t as u8 {
                continue;
            }
            let p = s.pos();
            let d = p.dist(predicted);
            if d < bd {
                bd = d;
                best = Some(p);
            }
        }
        best.or(Some(predicted))
    }

    /// Base-local coordinates of `p` in `team`'s recorded base frame (x to the right of the
    /// enemy axis, z towards the enemy), or `None` when the map never recorded that base.
    pub fn base_local(&self, team: u8, p: Vec2) -> Option<Vec2> {
        let t = (team as usize).min(1);
        let (anchor, yaw) = self.map.base_anchor[t];
        if anchor.len_sq() < 0.01 {
            return None;
        }
        Some(to_local(p, anchor, yaw))
    }

    /// True when `p` is inside `team`'s base *perimeter* — the walled compound itself, with no
    /// margin. `inside_own_base` above deliberately allows 6 m past the wall line, because it
    /// answers "is this hull still clearing my gateway"; this one answers "is this hull inside my
    /// walls", which is what the flag capture asks.
    pub fn inside_base_walls(&self, team: u8, p: Vec2) -> bool {
        match self.base_local(team, p) {
            Some(l) => l.x.abs() <= mapgen::BASE_HX && l.y.abs() <= mapgen::BASE_HZ,
            None => false,
        }
    }

    /// Whether the map recorded a base frame for `team` at all (an old `.rfmap` may not have).
    pub fn has_base_frame(&self, team: u8) -> bool {
        let t = (team as usize).min(1);
        self.map.base_anchor[t].0.len_sq() >= 0.01
    }

    /// A point 12 m past `team`'s front gate, on the line from the spawn pad through the
    /// opening — where the AI's exit corridor steers at. The pad, not the base centre: the
    /// anchor sits several metres to one side of the drivable lane, and a target on the
    /// anchor-gate line pulls fresh spawns out at an angle into the jamb (measured: map 0
    /// seed 3 crossed up to 5.6 m off-centre). The pad-gate line is also what spawn yaw faces,
    /// so "drive straight and out" and this target agree.
    ///
    /// Not the gate itself: the frame stands *on* the wall line, so a hull that has half driven
    /// through the opening finds "drive at the gate" pointing back into the base and oscillates
    /// on the jamb (measured: map 0 seed 7 sat spinning in the gateway for 60 s). A target past
    /// the wall keeps pulling outward for as long as the hull is inside the perimeter margin.
    pub fn gate_exit_target(&self, team: u8) -> Option<Vec2> {
        let t = (team as usize).min(1);
        let gate = self.gate_pos(team)?;
        let pad = self.map.spawn[t];
        let axis = (gate - pad).norm();
        if axis.len_sq() < 0.01 {
            return None;
        }
        Some(gate + axis * 12.0)
    }

    /// True when `p` is inside — or still clearing — `team`'s base perimeter. The margin past
    /// the wall line is what hands a hull over to the flow field only after it has actually
    /// driven through the gateway, not while it is still threading it.
    pub fn inside_own_base(&self, team: u8, p: Vec2) -> bool {
        match self.base_local(team, p) {
            Some(l) => l.x.abs() <= mapgen::BASE_HX + 6.0 && l.y.abs() <= mapgen::BASE_HZ + 6.0,
            None => false,
        }
    }

    /// True while this vehicle may not be hurt at all: either the hard spawn shield is still
    /// running, or it is sitting inside its own home zone with protection left on the clock.
    ///
    /// Attackers (AI gunners, missile towers, drone guns) all route their targeting through
    /// this, and `combat::damage_vehicle` refuses the damage as well, so the two mechanisms
    /// cannot be defeated by a shot that was already in the air.
    pub fn protected_from_attack(&self, vi: usize) -> bool {
        match self.vehicles.get(vi) {
            Some(v) => {
                v.alive()
                    && (v.spawn_guard > 0.0
                        || (v.home_safe > 0.0 && self.in_home_zone(v.team, v.pos)))
            }
            None => false,
        }
    }

    pub fn cell_index(&self, p: Vec2) -> usize {
        let g = self.map.grid as i32;
        let cx = clamp((p.x / self.map.cell).floor(), 0.0, (g - 1) as f32) as i32;
        let cz = clamp((p.y / self.map.cell).floor(), 0.0, (g - 1) as f32) as i32;
        (cz * g + cx) as usize
    }

    pub fn take_scratch(&mut self) -> Vec<u32> {
        core::mem::take(&mut self.scratch)
    }
    pub fn give_scratch(&mut self, mut v: Vec<u32>) {
        v.clear();
        self.scratch = v;
    }

    /// Rebuild the mirrors the renderer reads out of wasm memory.
    pub fn sync_views(&mut self) {
        self.vviews.clear();
        for v in self.vehicles.iter() {
            let spec = v.spec();
            let mut flags = v.flags & !vflag::RESUPPLYING;
            if v.airborne {
                flags |= vflag::AIRBORNE;
            }
            if v.hit_flash > 0.01 {
                flags |= vflag::HIT_FLASH;
            }
            if v.spawn_guard > 0.0 || (v.home_safe > 0.0 && self.in_home_zone(v.team, v.pos)) {
                // The renderer draws its shield effect off this flag; the home zone grants
                // exactly the same protection, so the player must be able to see it.
                flags |= vflag::SPAWN_GUARD;
            }
            if v.state == vstate::WRECK && v.kind != vkind::DRONE {
                // `BURNING` doubles as "this wreck should keep smoking soot": the renderer
                // reads it to drive the column. The player was explicit that the drone is
                // the one hull that must not smoke, so the flag is refused for it. Wrecks
                // still read as charred regardless — the renderer keys blackening off the
                // WRECK state, not this flag.
                flags |= vflag::BURNING;
            }
            if v.fuel <= 0.0 && !spec.flying {
                flags |= vflag::DRIVER_BAILED;
            }
            if self.in_water(v.pos) && !v.airborne {
                flags |= vflag::IN_WATER;
            }
            if v.reload0 > 0.0 {
                flags |= vflag::RELOADING0;
            }
            if v.reload1 > 0.0 {
                flags |= vflag::RELOADING1;
            }
            self.vviews.push(VehicleView {
                id: v.id as f32,
                kind: v.kind as f32,
                team: v.team as f32,
                state: v.state,
                x: v.pos.x,
                y: v.y,
                z: v.pos.y,
                yaw: v.yaw,
                turret_yaw: v.turret_yaw,
                gun_pitch: v.gun_pitch,
                speed: v.fwd_speed,
                hp: v.hp,
                hp_max: spec.hp,
                fuel: v.fuel,
                fuel_max: spec.fuel_max,
                ammo0: v.ammo0,
                ammo1: v.ammo1,
                mines: v.mines,
                anim: v.anim,
                flags: flags as f32,
                reload0: v.reload0,
                reload1: v.reload1,
                build_t: v.player as f32,
                pitch: v.pitch,
                roll: v.roll,
                _pad: v.alt,
                wreck: v.wreck_t.max(0.0),
            });
        }
        self.pviews.clear();
        for p in self.projs.iter() {
            self.pviews.push(ProjectileView {
                id: p.id as f32,
                kind: p.kind as f32,
                team: p.team as f32,
                owner: p.owner as f32,
                x: p.pos.x,
                y: p.pos.y,
                z: p.pos.z,
                vx: p.vel.x,
                vy: p.vel.y,
                vz: p.vel.z,
                life: p.life,
                power: p.damage,
                seed: p.seed,
                _pad: 0.0,
            });
        }
        self.mviews.clear();
        for m in self.mines.iter() {
            self.mviews.push(MineView {
                x: m.pos.x,
                y: m.y,
                z: m.pos.y,
                team: m.team as f32,
                armed: m.armed,
                blink: m.blink,
                id: m.id as f32,
                _pad: 0.0,
            });
        }
        self.tviews.clear();
        for t in self.turrets.iter() {
            self.tviews.push(TurretView {
                x: t.pos.x,
                y: t.y,
                z: t.pos.y,
                yaw: t.yaw,
                team: t.team as f32,
                alive: if t.alive { 1.0 } else { 0.0 },
                struct_id: t.struct_id as f32,
                reload: t.reload,
            });
        }
        for i in 0..2 {
            let f = &self.flags[i];
            self.fviews[i] = FlagView {
                x: f.pos.x,
                y: self.map.height_at(f.pos.x, f.pos.y).max(self.map.water_level),
                z: f.pos.y,
                state: f.state,
                team: f.team as f32,
                carrier: f.carrier as f32,
                drop_t: f.drop_t,
                wave: self.time,
            };
        }

        for p in 0..2 {
            let team = self.player_team(p);
            let vid = self
                .vehicles
                .iter()
                .find(|v| v.player == p as u8 + 1 && v.alive())
                .map(|v| v.id);
            let kills = self.kills[team as usize];
            let deaths = self.deaths[team as usize];
            let captures = self.captures[team as usize];
            let vi = vid.and_then(|id| self.vehicle_index(id));
            let hud = &mut self.player_hud[p];
            match vi {
                Some(vi) => {
                    let v = &self.vehicles[vi];
                    let spec = v.spec();
                    let enemy_flag = &self.flags[1 - team as usize];
                    let bearing = (enemy_flag.pos - v.pos).heading();
                    *hud = PlayerHud {
                        vehicle_id: v.id as f32,
                        vehicle_kind: v.kind as f32,
                        hp: v.hp,
                        hp_max: spec.hp,
                        fuel: v.fuel,
                        fuel_max: spec.fuel_max,
                        ammo0: v.ammo0,
                        ammo0_max: spec.ammo0_max,
                        ammo1: v.ammo1,
                        ammo1_max: spec.ammo1_max,
                        mines: v.mines,
                        mine_max: spec.mine_max,
                        kills,
                        deaths,
                        flags: captures,
                        respawn_t: 0.0,
                        aim_yaw: v.turret_yaw,
                        bearing_to_flag: wrap_angle(bearing - v.yaw),
                        status: 1.0,
                    };
                }
                None => {
                    hud.vehicle_id = -1.0;
                    hud.vehicle_kind = -1.0;
                    hud.status = 0.0;
                    hud.kills = kills;
                    hud.deaths = deaths;
                    hud.flags = captures;
                    let wait = self.garage[team as usize]
                        .building
                        .iter()
                        .cloned()
                        .fold(f32::INFINITY, f32::min);
                    hud.respawn_t = if wait.is_finite() { wait } else { 0.0 };
                }
            }
            let g = &self.garage[team as usize];
            let f = &self.flags[team as usize];
            let turrets_alive = self
                .turrets
                .iter()
                .filter(|t| t.team == team && t.alive)
                .count() as f32;
            self.team_hud[p] = TeamHud {
                ready_jeep: g.parked[0],
                ready_tank: g.parked[1],
                ready_hrsv: g.parked[2],
                ready_heli: g.parked[3],
                build_jeep: g.building[0],
                build_tank: g.building[1],
                build_hrsv: g.building[2],
                build_heli: g.building[3],
                score: self.score[team as usize],
                flag_state: f.state,
                turrets_alive,
                _pad: self.score[1 - team as usize],
            };
        }
    }
}

impl Structure {
    /// Axis aligned bounds in world XZ (rotated footprints use the enclosing AABB).
    pub fn bounds(&self) -> (Vec2, Vec2) {
        let hw = self.w * 0.5;
        let hd = self.d * 0.5;
        let (s, c) = self.yaw.sin_cos();
        let ex = hw * c.abs() + hd * s.abs();
        let ez = hw * s.abs() + hd * c.abs();
        let p = self.pos();
        (v2(p.x - ex, p.y - ez), v2(p.x + ex, p.y + ez))
    }

    /// Horizontal distance from a point to the structure's oriented rectangle.
    pub fn dist_to(&self, p: Vec2) -> f32 {
        let d = p - self.pos();
        let (s, c) = (-self.yaw).sin_cos();
        let lx = d.x * c - d.y * s;
        let lz = d.x * s + d.y * c;
        let dx = (lx.abs() - self.w * 0.5).max(0.0);
        let dz = (lz.abs() - self.d * 0.5).max(0.0);
        (dx * dx + dz * dz).sqrt()
    }

    /// Vehicle circle at `p` with radius `r` vs this box: world-space push-out vector.
    pub fn circle_push(&self, p: Vec2, r: f32) -> Option<Vec2> {
        let d = p - self.pos();
        let (s, c) = (-self.yaw).sin_cos();
        let lx = d.x * c - d.y * s;
        let lz = d.x * s + d.y * c;
        let hw = self.w * 0.5;
        let hd = self.d * 0.5;
        let cx = lx.clamp(-hw, hw);
        let cz = lz.clamp(-hd, hd);
        let dx = lx - cx;
        let dz = lz - cz;
        let dist_sq = dx * dx + dz * dz;
        if dist_sq > r * r {
            return None;
        }
        let (nx, nz, pen) = if dist_sq > 1e-6 {
            let dist = dist_sq.sqrt();
            (dx / dist, dz / dist, r - dist)
        } else {
            let px = hw - lx.abs();
            let pz = hd - lz.abs();
            if px < pz {
                (lx.signum(), 0.0, px + r)
            } else {
                (0.0, lz.signum(), pz + r)
            }
        };
        let (s2, c2) = self.yaw.sin_cos();
        let wx = nx * c2 - nz * s2;
        let wz = nx * s2 + nz * c2;
        Some(v2(wx, wz) * pen)
    }
}
