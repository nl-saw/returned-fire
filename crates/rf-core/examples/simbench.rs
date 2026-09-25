//! Native simulation cost probe (profiling aid).
//!
//! Measures, per battlefield size: map generation, world build, the per-tick `World::step`
//! cost with *both* teams under AI command (the worst case for the sim), a forced flow-field
//! rebuild, and the per-call `sync_views` cost. Run in release:
//!
//!   cargo run --release --example simbench [seconds]

use std::time::Instant;

fn pct(v: &[f64], p: f64) -> f64 {
    let i = ((v.len() as f64) * p) as usize;
    v[i.min(v.len() - 1)]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let secs = args.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(60);
    let sizes = [
        ("small", rf_core::types::MapSize::Small),
        ("medium", rf_core::types::MapSize::Medium),
        ("big", rf_core::types::MapSize::Big),
    ];
    for (name, size) in sizes {
        let t0 = Instant::now();
        let _map = rf_core::mapgen::generate_sized(1337, 0, rf_core::mapgen::MapMode::Classic, size);
        let gen_ms = t0.elapsed().as_secs_f64() * 1e3;

        let t0 = Instant::now();
        let mut map2 = rf_core::mapgen::generate_sized(1337, 0, rf_core::mapgen::MapMode::Classic, size);
        rf_core::normalize_map(&mut map2);
        let mut w = rf_core::world::World::new_with_map(1337, map2, [-1, -1]);
        let build_ms = t0.elapsed().as_secs_f64() * 1e3;

        // Warm every flow field so the first ticks are not paying a cold rebuild.
        for _ in 0..8 {
            rf_core::nav::update_fields(&mut w, 1.0);
        }

        let blank = [rf_core::world::Input::default(); 2];
        let ticks = secs * 60;
        let mut per_tick = Vec::with_capacity(ticks as usize);
        let t_all = Instant::now();
        for _ in 0..ticks {
            let t = Instant::now();
            w.step(1.0 / 60.0, &blank);
            per_tick.push(t.elapsed().as_secs_f64() * 1e3);
        }
        let total_ms = t_all.elapsed().as_secs_f64() * 1e3;
        per_tick.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "{name}: gen={gen_ms:.0}ms build={build_ms:.0}ms ticks={} total={total_ms:.0}ms avg={:.2}ms p50={:.2}ms p95={:.2}ms max={:.2}ms",
            ticks,
            total_ms / ticks as f64,
            pct(&per_tick, 0.5),
            pct(&per_tick, 0.95),
            per_tick.last().copied().unwrap_or(0.0)
        );

        // Forced flow-field rebuild (the periodic cost the AI pays).
        let t0 = Instant::now();
        rf_core::nav::update_fields(&mut w, 1e9);
        let ff_ms = t0.elapsed().as_secs_f64() * 1e3;

        // Per-call view sync (runs every tick).
        let t0 = Instant::now();
        for _ in 0..200 {
            w.sync_views();
        }
        let sv_ms = t0.elapsed().as_secs_f64() * 1e3 / 200.0;

        println!(
            "  flow-field forced rebuild: {ff_ms:.2}ms   sync_views: {sv_ms:.4}ms/call   vehicles={} projs={} mines={}",
            w.vehicles.len(),
            w.projs.len(),
            w.mines.len()
        );
    }
}
