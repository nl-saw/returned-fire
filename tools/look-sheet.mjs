#!/usr/bin/env node
/**
 * Photograph the four vehicle "looks" side by side.
 *
 *   node tools/look-sheet.mjs [--port 5191] [--out shots/vehicle-looks.png]
 *
 * `runtime.look` (or `?look=N`) chooses how each vehicle carries its team identity:
 *
 *   0 stock         the original small painted marks, nothing added
 *   1 bold bands    a thick team-coloured band along each hull side
 *   2 pennants      a team pennant on a pole, at a per-vehicle spot the turret cannot sweep
 *   3 ground rings  a flat unlit team-coloured ellipse under every *ground* vehicle (default)
 *
 * The look is read when a rig is built, so one page load can only show one of them: this boots
 * the game once per look, frames the same two hulls from the same camera every time (a tank for
 * the ground vehicles, a helicopter for the fliers - which look 3 deliberately leaves alone), and
 * then composes the eight frames into one sheet in a browser canvas, because Node has no image
 * library here.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = resolve(ROOT, 'web');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const PORT = Number(flag('port', 5191));
const OUT = resolve(ROOT, flag('out', 'shots/vehicle-looks.png'));
const SEED = flag('seed', '11');
const LOOKS = [0, 1, 2, 3];
/** vkind ids: 2 = tank (ground), 4 = helicopter (flier). */
const HULLS = [
  { kind: 2, label: 'tank (ground)' },
  { kind: 4, label: 'helicopter (flier)' },
];

const server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: WEB,
  stdio: 'ignore',
});
const stop = () => {
  try {
    server.kill('SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(500);
}

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const errors = [];
const shots = [];

for (const look of LOOKS) {
  for (const hull of HULLS) {
    const page = await browser.newPage({ viewport: { width: 460, height: 340 } });
    page.on('pageerror', (e) => errors.push(`${look}/${hull.kind}: ${String(e)}`));
    // The practice range keeps the fight away and leaves the pad clear, and the hull is spawned
    // in the garage slot the boot parameter asks for. `?look=N` is the override the config's
    // `runtime.look` feeds at boot, so this is the shipping path, not a private one.
    await page.goto(
      `http://127.0.0.1:${PORT}/index.html?auto=1&seed=${SEED}&map=0&size=small&sandbox=1&allies=1` +
        `&look=${look}&vehicle=${hull.kind}`,
      { waitUntil: 'load' },
    );
    await page.waitForFunction(() => typeof window.rfStats === 'function', null, { timeout: 180000 });
    await sleep(1200);
    // Settle, then drive out of the base: the spawn pad and the helipad are team-coloured ellipses
    // of their own, and a hull parked on one hides exactly what the sheet is meant to show. The
    // helicopter also lifts off, so its rotor disc and skids are seen against the sky rather than
    // against a pad it is sitting on.
    await page.keyboard.down('KeyW');
    if (hull.kind === 4) await page.keyboard.down('ControlLeft');
    // `rfStep` advances the simulation and the cameras but *not* the world view: the rigs are
    // posed by `world.update`, which the frame loop calls. Without this the hull would be framed
    // where the simulation says it is while the model is still drawn back on the spawn pad.
    await page.evaluate((steps) => {
      const g = window.rfGame;
      window.rfStep(steps);
      g.world.update(0, g.sim, g.time);
    }, hull.kind === 4 ? 300 : 260);
    await page.keyboard.up('KeyW');
    if (hull.kind === 4) await page.keyboard.up('ControlLeft');
    await page.evaluate(() => {
      const g = window.rfGame;
      window.rfStep(30);
      g.world.update(0, g.sim, g.time);
    });
    const inventory = await page.evaluate(() => {
      // What the model builders actually attached, straight out of the scene: a part is named
      // `<look part>:<material>` by `Parts.build`, and the ring is the one mesh named `teamRing`.
      // Counting these is what makes the sheet a proof rather than a picture.
      //
      // Two wrinkles worth knowing when reading the counts. `band:` appears in the *pennant* look
      // too, because infantry have no hull side to stripe: a troop wears a helmet band in look 1
      // and an armband in look 2, and the builders name both of them `band`. And a ring's parent
      // carries no vehicle id, so rings are attributed by position instead.
      const g = window.rfGame;
      // Pooled rigs that are not in use stay in the scene with `visible = false`, and their look
      // parts come with them, so anything counted here has to be *drawn* to mean anything.
      g.gs.scene.updateMatrixWorld(true);
      const counts = { band: 0, pennant: 0, ring: 0, pooled: 0 };
      const ringsOn = [];
      const ringFits = [];
      const kinds = ['?', 'jeep', 'tank', 'mlrs', 'heli', 'troop', 'drone', 'sub'];
      const kindAt = (x, z) => {
        let best = null;
        let bd = 6; // metres: rings sit under their own hull, and hulls are not that close
        for (const v of g.sim.vehicles) {
          const d = Math.hypot(v.x - x, v.z - z);
          if (d < bd) {
            bd = d;
            best = v;
          }
        }
        return best ? kinds[best.kind] ?? String(best.kind) : '?';
      };
      // World-space span of an object along one of the rig's own axes, from its meshes' bounding
      // boxes. Used below to check that a ring actually hugs the hull it is drawn under: the
      // ellipse was fitted to the wrong axes once (long side across the hull), which no assertion
      // caught because the ring was still *an* ellipse of roughly the right area.
      const spanAlong = (obj, axis, origin) => {
        let lo = Infinity;
        let hi = -Infinity;
        const walk = (o) => {
          if (o.isMesh && o.geometry) {
            if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
            const b = o.geometry.boundingBox;
            const m = o.matrixWorld.elements;
            for (const px of [b.min.x, b.max.x]) {
              for (const py of [b.min.y, b.max.y]) {
                for (const pz of [b.min.z, b.max.z]) {
                  const wx = m[0] * px + m[4] * py + m[8] * pz + m[12] - origin[0];
                  const wy = m[1] * px + m[5] * py + m[9] * pz + m[13] - origin[1];
                  const wz = m[2] * px + m[6] * py + m[10] * pz + m[14] - origin[2];
                  const d = wx * axis[0] + wy * axis[1] + wz * axis[2];
                  if (d < lo) lo = d;
                  if (d > hi) hi = d;
                }
              }
            }
          }
          for (const c of o.children) walk(c);
        };
        walk(obj);
        return hi - lo;
      };
      const fitOf = (ring) => {
        const root = ring.parent;
        const e = root.matrixWorld.elements;
        const ax = [e[0], e[1], e[2]]; // across the hull
        const az = [e[8], e[9], e[10]]; // along it (rigs are authored +Z forward)
        const at = [e[12], e[13], e[14]];
        const hull = { children: root.children.filter((c) => c !== ring) };
        return {
          hullAcross: spanAlong(hull, ax, at),
          hullAlong: spanAlong(hull, az, at),
          ringAcross: spanAlong(ring, ax, at),
          ringAlong: spanAlong(ring, az, at),
        };
      };
      const drawn = (o) => {
        for (let p = o; p; p = p.parent) if (p.visible === false) return false;
        return true;
      };
      g.gs.scene.traverse((o) => {
        const name = o.name || '';
        const isLookPart = name === 'teamRing' || name.startsWith('band:') || name.startsWith('pennant:');
        if (!isLookPart) return;
        if (!drawn(o)) {
          counts.pooled++;
          return;
        }
        if (name === 'teamRing') {
          counts.ring++;
          // The ring sits at its local origin under the rig root, so its own `position` says
          // nothing about where it is: take the root's world position (or the ring's own matrix
          // when the root is the vehicle itself).
          const e = (o.parent ?? o).matrixWorld.elements;
          ringsOn.push(kindAt(e[12], e[14]));
          ringFits.push({ kinds: kindAt(e[12], e[14]), ...fitOf(o) });
        } else if (name.startsWith('band:')) counts.band++;
        else counts.pennant++;
      });
      return { ...counts, ringsOn, ringFits };
    });

    const shot = await page.evaluate(
      ({ kind }) => {
        const g = window.rfGame;
        const v = g.sim.vehicles.find((x) => x.kind === kind && x.hp > 0);
        if (!v) return { error: `no hull of kind ${kind}` };
        const cam = g.gs.camera;
        const cx = v.x;
        const cz = v.z;
        const cy = (v.y ?? 0) + (kind === 4 ? 1.0 : 1.1);
        // Close enough to read the details being compared: a 0.42 m band, a 0.7 m pennant pole,
        // and the ground under the hull where the ring is drawn.
        const ground = kind !== 4;
        // Ground hull: a close three-quarter view so a 0.42 m band and a 0.7 m pennant pole are
        // both legible, with the ground under the hull in frame (that is where the ring goes).
        // Flier: level with the hull and looking level, so the sky is the backdrop and neither a
        // pad nor a helipad decal can be mistaken for a team ring.
        const d = ground ? 5.6 : 9.5;
        const h = ground ? 2.1 : 0.1;
        cam.position.set(cx + d * 0.72, cy + h, cz + d * 0.69);
        cam.lookAt(cx, cy + (ground ? -0.15 : 0.1), cz);
        cam.updateMatrixWorld(true);
        // Pose the rigs from the current simulation state (see the note above the drive).
        g.world.update(0, g.sim, g.time);
        g.gs.render();
        return {
          png: window.rfCapture(),
          look: window.rfLook().id,
          name: window.rfLook().info.name,
          at: [Math.round(cx), Math.round(cz)],
        };
      },
      { kind: hull.kind },
    );
    await page.close();
    if (shot.error) {
      errors.push(`${look}/${hull.kind}: ${shot.error}`);
      continue;
    }
    shots.push({ look, hull, ...shot, inventory });
    console.log(
      `captured look ${look} (${shot.name}) ${hull.label} at (${shot.at[0]}, ${shot.at[1]})` +
        ` - drawn: ${inventory.ring} ring(s) ${JSON.stringify(inventory.ringsOn)}, ` +
        `${inventory.band} band(s), ${inventory.pennant} pennant(s) ` +
        `(${inventory.pooled} look part(s) on pooled rigs)` +
        (inventory.ringFits ?? [])
          .map(
            (f) =>
              ` | ring fit ${f.kinds}: hull ${f.hullAcross.toFixed(1)}x${f.hullAlong.toFixed(1)} ` +
              `ring ${f.ringAcross.toFixed(1)}x${f.ringAlong.toFixed(1)}`,
          )
          .join('') +
        (shot.look === look ? '' : `  <- WARNING: builders were on look ${shot.look}`),
    );
    if (shot.look !== look) errors.push(`look ${look} did not reach the builders (${shot.look})`);
  }
}

if (!shots.length) {
  await browser.close();
  stop();
  console.error('no frames captured', errors.slice(0, 3));
  process.exit(1);
}

// Compose the sheet. Node has no image library here, so the composition happens in the browser
// that just took the frames: one row per look, one column per hull, labelled down the left.
const sheet = await browser.newPage({ viewport: { width: 100, height: 100 } });
const dataUrl = await sheet.evaluate(
  async (frames) => {
    const COL = 460;
    const ROW = 340;
    const PAD = 12;
    // Wide enough for the captions to be read in the image itself: the look's name, the two hull
    // labels and the part counts the builders reported.
    const LABEL = 268;
    // Left gutter for the labels, then one column per hull (two of them).
    const c = document.createElement('canvas');
    c.width = LABEL + (COL + PAD) * 2;
    c.height = 72 + ((ROW + PAD) * frames.length) / 2;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, c.width, c.height);
    const names = [
      ['0  stock', 'nothing added: painted marks only'],
      ['1  bold bands', 'a band down each hull side'],
      ['2  pennants', 'a team flag on a pole'],
      ['3  ground rings', 'a ring under each ground hull'],
    ];
    const load = (src) =>
      new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
      });
    // Rows in look order, cells in hull order — `frames` was pushed in exactly that order, but
    // sorting here keeps the sheet readable if a capture ever fails and leaves a gap.
    const rows = [...new Set(frames.map((f) => f.look))].sort((a, b) => a - b);
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.fillStyle = '#e8e6e1';
    ctx.fillText('same hull, same camera, four team-identity looks', LABEL, 26);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = '#8b9096';
    ctx.fillText('runtime.look in rf.config.json (or ?look=N) — counts are the parts the builders drew', LABEL, 44);
    for (let r = 0; r < rows.length; r++) {
      const look = rows[r];
      const y = 72 + r * (ROW + PAD);
      // Look name, what it does, the hull each column shows, then the part counts.
      const [title, detail] = names[look] ?? [String(look), ''];
      ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillStyle = '#e8e6e1';
      ctx.fillText(title, 14, y + 24);
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = '#8b9096';
      ctx.fillText(detail, 14, y + 42);
      const cells = frames.filter((f) => f.look === look);
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillStyle = '#c8ccd1';
      cells.forEach((f, i) => ctx.fillText(f.hull.label, 14, y + 66 + i * 18));
      // The counts the builders reported for this row, printed under the look's name.
      const inv = cells[0]?.inventory;
      if (inv) {
        ctx.font = '12px ui-monospace, monospace';
        ctx.fillStyle = '#7fb3a0';
        const parts =
          `drawn: ${inv.ring} ring` +
          (inv.ring ? ` (under ${[...new Set(inv.ringsOn)].sort().join('/') || '?'})` : 's') +
          `  ${inv.band} band${inv.band === 1 ? '' : 's'}  ${inv.pennant} pennant${inv.pennant === 1 ? '' : 's'}`;
        ctx.fillText(parts, 14, y + 66 + cells.length * 18 + 6);
      }
      for (const f of cells) {
        const col = cells.indexOf(f);
        const img = await load(f.png);
        ctx.drawImage(img, LABEL + col * (COL + PAD), y, COL, ROW);
        ctx.strokeStyle = '#33383f';
        ctx.strokeRect(LABEL + col * (COL + PAD) + 0.5, y + 0.5, COL - 1, ROW - 1);
      }
    }
    return c.toDataURL('image/png');
  },
  shots,
);
await browser.close();
stop();

// The picture is nice; the assertions are the point. A look has to put exactly the parts it
// promises into the scene, and look 3 has to leave the *fliers* alone - the one asymmetry in the
// set, and the easiest thing to break while editing the model builders.
const problems = [];
const groundKinds = new Set(['jeep', 'tank', 'mlrs', 'troop', 'sub']);

// The ring has to *hug* the hull: each axis within a short margin of it, and a hull that is
// nearly square (an infantry figure) gets a circle rather than an oval. Measured through the
// rig's own axes, so authoring a model 90 degrees round cannot hide here.
const MARGIN_MIN = 0.15; // a ring that clips the hull reads as a mistake
const MARGIN_MAX = 1.4; // ...and one much wider than the hull stops marking anything
for (const shot of shots) {
  if (shot.look !== 3) continue;
  for (const f of shot.inventory.ringFits ?? []) {
    if (!groundKinds.has(f.kinds)) continue;
    const where = `look 3 / ${f.kinds}`;
    const across = f.ringAcross - f.hullAcross;
    const along = f.ringAlong - f.hullAlong;
    if (across < MARGIN_MIN || across > MARGIN_MAX || along < MARGIN_MIN || along > MARGIN_MAX) {
      problems.push(
        `${where}: ring ${f.ringAcross.toFixed(1)}x${f.ringAlong.toFixed(1)} m does not hug the ` +
          `hull ${f.hullAcross.toFixed(1)}x${f.hullAlong.toFixed(1)} m (margins ` +
          `${across.toFixed(2)}, ${along.toFixed(2)} m) - are its axes crossed?`,
      );
    }
    if (Math.abs(f.hullAcross - f.hullAlong) < 0.35 && Math.abs(f.ringAcross - f.ringAlong) > 0.35) {
      problems.push(
        `${where}: a ${f.hullAcross.toFixed(2)}x${f.hullAlong.toFixed(2)} m hull wears an oval ` +
          `ring (${f.ringAcross.toFixed(1)}x${f.ringAlong.toFixed(1)} m)`,
      );
    }
  }
}
for (const shot of shots) {
  const inv = shot.inventory;
  const where = `look ${shot.look} / ${shot.hull.label}`;
  if (shot.look === 0 && (inv.ring || inv.band || inv.pennant)) {
    problems.push(`${where}: stock added ${inv.ring} rings / ${inv.band} bands / ${inv.pennant} pennants`);
  }
  if (shot.look === 1 && (inv.band < 1 || inv.ring || inv.pennant)) {
    problems.push(`${where}: expected bands only, got ${inv.ring}/${inv.band}/${inv.pennant}`);
  }
  if (shot.look === 2 && (inv.pennant < 1 || inv.ring)) {
    problems.push(`${where}: expected pennants and no rings, got ${inv.ring}/${inv.pennant}`);
  }
  if (shot.look === 3) {
    const under = inv.ringsOn.filter((k) => groundKinds.has(k));
    if (shot.hull.kind === 4 && inv.ring !== 0) {
      problems.push(`${where}: a flier must get no ground ring, got ${inv.ring}`);
    } else if (shot.hull.kind === 4 && under.length) {
      problems.push(`${where}: a ring was attributed to a ground hull on the flier page`);
    }
    if (shot.hull.kind === 2 && (under.length < 1 || inv.band || inv.pennant)) {
      problems.push(`${where}: expected a ring under a ground hull, got ${JSON.stringify(inv.ringsOn)}`);
    }
  }
}

const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(base64, 'base64'));
console.log(`sheet: ${OUT} (${shots.length} frames)`);
for (const p of problems) console.log(`FAIL ${p}`);
if (errors.length) console.log(`problems: ${errors.slice(0, 4).join(' | ')}`);
console.log(
  problems.length || errors.length
    ? `FAIL: ${problems.length} look assertion(s), ${errors.length} capture problem(s)`
    : 'ok: every look drew exactly what it promises, and the fliers stayed bare',
);
process.exit(problems.length || errors.length ? 1 : 0);
