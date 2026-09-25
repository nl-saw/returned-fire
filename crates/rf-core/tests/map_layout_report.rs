//! Layout invariants of the procedural (classic) battlefields, plus the numbers behind them.
//!
//! These are the two things that are easy to break by accident when a new authored constant is
//! added, because both used to be wrong in the same way: a *length* written in the 256 m design
//! space is multiplied by the map scale, so a bigger battlefield stretched the layout instead of
//! holding it and adding more of it.
//!
//! * **City blocks are the same size everywhere.** The pitch is 52-64 m on every battlefield. In
//!   design units it was 26-32, which came out as 229 m between streets on a big map — with the
//!   same four 13 m sheds in the blocks.
//! * **The bases sit at the ends of the island.** The road runs gate to gate, so the bases set
//!   its length; placed as close to the middle as the pad allowed, the two gates came out 57
//!   design units apart and every town on the road was crammed into the middle of the island.
//!
//! Run `cargo test -p rf-core --test map_layout_report -- --nocapture` to print the table.

use rf_core::mapgen::{generate_sized, MapMode};
use rf_core::types::{MapData, MapSize};

/// A town is the only place where team 2 structures at yaw 0 come in a 2 x 2 lattice, so a
/// diagonal pair of them is `|dx| == |dz|` and that distance is the block pitch. Roadside hamlet
/// buildings sit in a line along the road (they take the road's angle) and landmarks take a random
/// one, so neither can produce such a pair.
fn town_pitch(m: &MapData) -> Option<f32> {
    let pts: Vec<(f32, f32)> = m
        .structures
        .iter()
        .filter(|s| s.team == 2.0 && s.yaw == 0.0)
        .map(|s| (s.x, s.z))
        .collect();
    let mut found: Vec<f32> = Vec::new();
    for (i, a) in pts.iter().enumerate() {
        for b in pts.iter().skip(i + 1) {
            let (dx, dz) = ((a.0 - b.0).abs(), (a.1 - b.1).abs());
            if (20.0..120.0).contains(&dx) && (dx - dz).abs() < 2.0 {
                found.push(dx);
            }
        }
    }
    found.iter().cloned().fold(None, |a: Option<f32>, b| Some(a.map_or(b, |a| a.min(b))))
}

/// Team 2 structures at yaw 0: the town blocks, plus the roadside buildings on a horizontal road.
fn town_marks(m: &MapData) -> usize {
    m.structures
        .iter()
        .filter(|s| s.team == 2.0 && s.yaw == 0.0)
        .count()
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

const SEEDS: [u32; 8] = [1, 7, 9, 42, 100, 555, 1337, 90210];

#[test]
fn town_blocks_are_the_same_size_on_every_battlefield() {
    for size in [MapSize::Small, MapSize::Medium, MapSize::Big] {
        let mut pitches = Vec::new();
        let mut towns = 0;
        for seed in SEEDS {
            let m = generate_sized(seed, 0, MapMode::Classic, size);
            if let Some(p) = town_pitch(&m) {
                pitches.push(p);
                towns += 1;
            }
            // Nothing may ever be twice the pitch: that is the map scale leaking into the layout.
            if let Some(p) = town_pitch(&m) {
                assert!(
                    (44.0..76.0).contains(&p),
                    "{} seed {seed}: town block pitch {p:.1} m is not the small map's 52-64 m",
                    size.name()
                );
            }
        }
        if size != MapSize::Small {
            assert_eq!(towns, SEEDS.len(), "{}: a town per seed", size.name());
        }
        assert!(towns >= SEEDS.len() - 1, "{}: a town in all but one seed", size.name());
    }
    // The same blocks, more of them: a big map has several towns along the road, not wider ones.
    let pitches: Vec<f32> = [MapSize::Small, MapSize::Medium, MapSize::Big]
        .iter()
        .map(|s| {
            median(
                SEEDS
                    .iter()
                    .filter_map(|seed| town_pitch(&generate_sized(*seed, 0, MapMode::Classic, *s)))
                    .collect(),
            )
        })
        .collect();
    assert!(
        (pitches[0] - pitches[2]).abs() < 6.0,
        "block pitch drifts with the map size: small {:.1} m vs big {:.1} m",
        pitches[0],
        pitches[2]
    );
    let marks: Vec<f32> = [MapSize::Small, MapSize::Medium, MapSize::Big]
        .iter()
        .map(|s| {
            median(
                SEEDS
                    .iter()
                    .map(|seed| town_marks(&generate_sized(*seed, 0, MapMode::Classic, *s)) as f32)
                    .collect(),
            )
        })
        .collect();
    assert!(
        marks[0] < marks[1] && marks[1] < marks[2],
        "towns do not multiply with the battlefield: {marks:?} marks on small/medium/big"
    );
}

#[test]
fn the_bases_sit_at_the_ends_of_the_island() {
    for size in [MapSize::Small, MapSize::Medium, MapSize::Big] {
        for seed in SEEDS {
            let m = generate_sized(seed, 0, MapMode::Classic, size);
            let apart = m.spawn[0].dist(m.spawn[1]);
            // The old anchor search stopped at the first offset from a fixed 50-70 units that had
            // pad room, which put the bases 37 % of the world apart on every size. The search now
            // walks out to the coast first: measured p50 72 / 75 / 76 %, worst seed 52 %.
            assert!(
                apart > m.world_size * 0.45,
                "{} seed {seed}: the bases are {apart:.0} m apart in a {:.0} m world, so the road \
                 between their gates cannot cross the island",
                size.name(),
                m.world_size
            );
        }
    }
}

#[test]
fn layout_report() {
    for size in [MapSize::Small, MapSize::Medium, MapSize::Big] {
        let mut pitches = Vec::new();
        let mut marks = Vec::new();
        let mut apart = Vec::new();
        for seed in SEEDS {
            let m = generate_sized(seed, 0, MapMode::Classic, size);
            if let Some(p) = town_pitch(&m) {
                pitches.push(p);
            }
            marks.push(town_marks(&m) as f32);
            apart.push(m.spawn[0].dist(m.spawn[1]));
        }
        println!(
            "{:<7} | town pitch p50 {:.1} m (n {}) | town marks p50 {:.0} | bases {:.0} m apart = {:.0}% of the world",
            size.name(),
            median(pitches.clone()),
            pitches.len(),
            median(marks),
            median(apart.clone()),
            median(apart) / size.world() * 100.0
        );
    }
}
