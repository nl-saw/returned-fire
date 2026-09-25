//! Shared test scaffolding, as a module rather than a crate so a test file can `mod common;`.
//!
//! These are the pieces more than one audit needs: a map through the editor's own save format, and
//! a round that lets the *game's* AI play it while the human does nothing.

use rf_core::editor::EditorMap;
use rf_core::mapgen::MapMode;
use rf_core::types::*;
use rf_core::world::World;

/// A battlefield as a `World`, with team 1 played by the computer.
///
/// Built through `EditorMap` even when nothing is edited, and that matters: `mapgen::generate`
/// defaults to *mirror* mode while the editor opens in classic, so a baseline taken from the
/// generator is a different island from the one an edit is applied to. Every comparison in this
/// file is between this and `edited`, which is the only pair that differs by the edits alone.
pub fn generated(seed: u32, index: u32) -> World {
    let e = EditorMap::new(seed, index, MapMode::Classic, MapSize::Small);
    let mut map = e.into_map();
    rf_core::normalize_map(&mut map);
    World::new_with_map(seed, map, [0, -1])
}

/// The same battlefield with edits applied, taken through the editor's save format — the path
/// "play this map" takes, so what is played is byte-for-byte what the editor would hand over.
pub fn edited(seed: u32, index: u32, edit: impl FnOnce(&mut EditorMap)) -> (World, EditorMap) {
    let mut e = EditorMap::new(seed, index, MapMode::Classic, MapSize::Small);
    edit(&mut e);
    let bytes = e.to_bytes();
    let back = EditorMap::from_bytes(&bytes).expect("an edited map reopens");
    let mut map = back.into_map();
    rf_core::normalize_map(&mut map);
    (World::new_with_map(seed, map, [0, -1]), e)
}

/// Warm every flow field, so the AI has a route on its first tick.
pub fn warm(w: &mut World) {
    for _ in 0..8 {
        rf_core::nav::update_fields(w, 1.0);
    }
}

/// Is there a land route from this team's base to the enemy flag at all?
///
/// The flow field is a distance field: finite where a route exists, infinite where it does not.
/// Reading it directly is the difference between "the driver was slow" and "the map has no route".
pub fn route_cost(w: &mut World, team: usize) -> f32 {
    warm(w);
    let from = w.flags[team].home;
    w.fields.to_flag[team].cost(&w.map, from)
}

/// What the AI did in a round it played by itself.
pub struct AiRound {
    pub captured: bool,
    pub capture_secs: f32,
    /// The longest any AI hull spent alive, wanting to move, and not moving.
    pub longest_stall: f32,
    pub log: Vec<String>,
}

/// Let the game's own commander play a whole round against an idle human, and report what happened.
///
/// Nothing here pokes the simulation: the human's jeep is parked and never touched, and the AI
/// drives its own garage. That is the only way to answer "does this map *play*", which is the
/// question an edited map raises — the AI's route preference comes from the generator's protected
/// lanes, and an edited map has none.
pub fn idle_player_round(w: &mut World, max_secs: f32) -> AiRound {
    let _jeep = w.spawn_vehicle(vkind::JEEP, 0, 1);
    warm(w);
    let start = w.score[1];
    let blank = rf_core::world::Input::default();
    let mut log = Vec::new();
    let mut last_sample = -99.0f32;
    let mut stalls: Vec<u32> = Vec::new();
    let mut capture_secs = 0.0f32;
    let mut captured = false;
    let max_ticks = (max_secs * 60.0) as u32;
    for tick in 0..max_ticks {
        w.step(1.0 / 60.0, &[blank, blank]);
        let t = tick as f32 / 60.0;
        if w.score[1] > start {
            captured = true;
            capture_secs = t;
            break;
        }
        if t - last_sample >= 20.0 {
            last_sample = t;
            let ai: Vec<String> = w
                .vehicles
                .iter()
                .filter(|v| v.team == 1 && v.player == 0 && v.alive() && v.kind != vkind::TROOP)
                .map(|v| {
                    format!(
                        "{}@({:.0},{:.0}) goal={} spd={:.1}",
                        v.kind as u32,
                        v.pos.x,
                        v.pos.y,
                        v.ai.goal,
                        v.vel.len()
                    )
                })
                .collect();
            log.push(format!("t={t:5.0}s  {}", ai.join("  |  ")));
        }
        // A hull that is alive and *not moving* is the failure mode that matters: it means the
        // route the AI was given is not one it can drive. Troops walk and are excluded; a hull
        // parked in its own garage is excluded by the speed test being about movement at all.
        for v in w.vehicles.iter() {
            if v.team == 1 && v.player == 0 && v.alive() && v.kind != vkind::TROOP && v.vel.len() < 0.2
            {
                let sec = tick as usize / 60;
                while stalls.len() <= sec {
                    stalls.push(0);
                }
                if let Some(slot) = stalls.get_mut(sec) {
                    *slot += 1;
                }
            }
        }
    }
    // The longest run of consecutive seconds with a stalled hull.
    let longest_stall = {
        let mut best = 0u32;
        let mut run = 0u32;
        for s in &stalls {
            if *s > 0 {
                run += 1;
                best = best.max(run);
            } else {
                run = 0;
            }
        }
        best as f32
    };
    AiRound {
        captured,
        capture_secs,
        longest_stall,
        log,
    }
}
