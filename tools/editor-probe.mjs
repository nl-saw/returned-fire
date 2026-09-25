#!/usr/bin/env node
/**
 * Headless editor check: boot `editor.html`, drive the tools through `window.rfEditor`, and
 * report what the map looks like afterwards.
 *
 *   node tools/editor-probe.mjs [--out shots/editor.png]
 *
 * The point is that the *editor's own API* is exercised — the same calls the toolbar makes — so a
 * brush that stops working shows up here rather than in a screenshot nobody diffs.
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
const PORT = Number(flag('port', 5197));
const OUT = resolve(ROOT, flag('out', 'shots/editor-probe.png'));

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
    const r = await fetch(`http://127.0.0.1:${PORT}/editor.html`);
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
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('console', (m) => {
  // Warnings matter here: the game's `?map=play` path deliberately falls back to a generated map
  // and says why on the console.
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/editor.html?seed=7&capture=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.rfReady === true, null, { timeout: 120000 });
await sleep(1500);

const report = await page.evaluate(async () => {
  const app = window.rfEditor;
  const sim = app.sim;
  const h = (x, z) => sim.map.heights[(Math.round(z / sim.map.cell)) * (sim.map.grid + 1) + Math.round(x / sim.map.cell)];
  const before = { h: h(200, 200), structures: sim.structureCount(), nav: sim.map.nav[Math.round(200 / sim.map.cell) * sim.map.grid + Math.round(200 / sim.map.cell)] };
  // Raise a hill, paint it as coral sand, lay a road across it, drop a bunker, and build a base.
  sim.beginStroke('probe raise');
  sim.raise(200, 200, 40, 9, 0.4);
  sim.endStroke();
  // Paint a whole material over whatever was there, then re-paint it as another sand: the round
  // that came back with "cannot re-paint the terrain" is exactly this, so it is checked here too.
  sim.beginStroke('probe paint');
  sim.paintMaterial(3, 0, 200, 200, 40, 1, 0.5);
  sim.paintMaterial(0, 2, 200, 200, 40, 1, 0.5);
  sim.paintMaterial(0, 0, 200, 200, 40, 1, 0.5);
  sim.endStroke();
  const gi = Math.round(200 / sim.map.cell) * (sim.map.grid + 1) + Math.round(200 / sim.map.cell);
  const painted = {
    sand: sim.map.splat[gi * 4],
    rock: sim.map.splat[gi * 4 + 2],
    sandVar: sim.map.sandVar[gi],
  };
  sim.beginStroke('probe road');
  sim.roadStroke([140, 140, 200, 140, 200, 200], 4, 2, false);
  sim.endStroke();
  // Walls: place one, then ask where a second would snap to.
  const wall = sim.catalog.find((c) => c.name === 'wall').kind;
  sim.place(wall, 0, 420, 200, 0, true);
  const snapped = sim.preview(wall, 428, 202, 0.09, true);
  sim.place(wall, 0, 428, 202, 0, true);
  const walls = sim.structureCount();
  // Walls are joined by a piece's *end*: turned square at the end of the run, the new piece's
  // face has to land on the wall's face — half a piece from where the old piece's centre is, not
  // a whole one, which is what the centre lattice used to jump past.
  const corner = sim.preview(wall, 424, 204, Math.PI / 2, true);
  // And the click the user could not make: cursor just past the wall's face, next piece turned
  // square. Its centre belongs half a piece beyond the end, so its face is flush with the wall's.
  const butt = sim.preview(wall, 432.2, 204, Math.PI / 2, true);
  // Free placement (shift in the editor) is the cursor, untouched.
  const free = sim.preview(wall, 424.35, 204.2, 0.37, false);
  // The report: a wall put down free, then joined. Shift-place one off the lattice, well clear of
  // the pair above, and ask where the next piece goes in line and turned square.
  sim.beginStroke('probe free walls');
  sim.place(wall, 0, 500.4, 260.7, 0.31, false);
  sim.endStroke();
  const freeWall = { x: 500.4, z: 260.7, yaw: 0.31 };
  const freeEnd = { x: freeWall.x + Math.cos(freeWall.yaw) * 3.86, z: freeWall.z + Math.sin(freeWall.yaw) * 3.86 };
  // In line with it: one segment along, so the two ends meet.
  const freeInLine = sim.preview(wall, freeEnd.x + Math.cos(freeWall.yaw) * 1.2, freeEnd.z + Math.sin(freeWall.yaw) * 1.2, freeWall.yaw, true);
  // Turned square at its end: the corner joint.
  const freeSquare = sim.preview(wall, freeEnd.x + 0.5, freeEnd.z + 0.5, freeWall.yaw + Math.PI / 2, true);
  // And a third piece continuing the second, which is where the old rule used to stack.
  sim.place(wall, 0, freeEnd.x + Math.cos(freeWall.yaw) * 1.2, freeEnd.z + Math.sin(freeWall.yaw) * 1.2, freeWall.yaw, true);
  const joined = { x: freeInLine[0], z: freeInLine[1] };
  const secondEnd = { x: joined.x + Math.cos(freeWall.yaw) * 3.86, z: joined.z + Math.sin(freeWall.yaw) * 3.86 };
  const third = sim.preview(wall, secondEnd.x + Math.cos(freeWall.yaw) * 1.5, secondEnd.z + Math.sin(freeWall.yaw) * 1.5, freeWall.yaw, true);
  // Each new piece must *join* the one it was aimed at: half a segment from its centre when it
  // butts onto an end, a whole segment when it continues the run. Neither may land on top of it.
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const freeAt = [freeWall.x, freeWall.z];
  const secondAt = [joined.x, joined.z];
  const joinsCheck = {
    inLineFromFree: Math.round(dist(freeInLine, freeAt) * 100) / 100,
    squareFromFree: Math.round(dist(freeSquare, freeAt) * 100) / 100,
    thirdFromSecond: Math.round(dist(third, secondAt) * 100) / 100,
    // 7.72 = one segment (a run continuation), 3.86 = half (a butt joint onto an end)
    ok:
      Math.abs(dist(freeInLine, freeAt) - 7.72) < 0.2 &&
      Math.abs(dist(freeSquare, freeAt) - 3.86) < 0.2 &&
      Math.abs(dist(third, secondAt) - 7.72) < 0.2,
  };
  sim.place(8, 0, 210, 190, 0.6, true);
  sim.stampBase(0, 300, 300, 0.5);
  const oneBase = sim.structureCount();
  sim.stampBase(0, 360, 300, 0.5);
  const movedBase = sim.structureCount();
  // Erase has to take pavement with it.
  sim.beginStroke('probe erase');
  sim.eraseStructures(200, 140, 6, true, true);
  sim.endStroke();
  const roadAfterErase = sim.map.road[Math.round(140 / sim.map.cell) * (sim.map.grid + 1) + Math.round(200 / sim.map.cell)];
  const after = { h: h(200, 200), structures: sim.structureCount() };
  const undone = sim.undo();
  const afterUndo = sim.structureCount();
  sim.redo();
  const bytes = sim.toBytes();
  return {
    worldSize: sim.map.worldSize,
    grid: sim.map.grid,
    sizeIndex: sim.sizeIndex(),
    before,
    painted,
    snapped: snapped.map((n) => Math.round(n * 100) / 100),
    corner: corner.map((n) => Math.round(n * 100) / 100),
    butt: butt.map((n) => Math.round(n * 100) / 100),
    free: free.map((n) => Math.round(n * 100) / 100),
    freeWall,
    freeInLine: freeInLine.map((n) => Math.round(n * 100) / 100),
    freeSquare: freeSquare.map((n) => Math.round(n * 100) / 100),
    third: third.map((n) => Math.round(n * 100) / 100),
    joinsCheck,
    walls,
    oneBase,
    movedBase,
    roadAfterErase,
    after,
    undone,
    afterUndo,
    afterRedo: sim.structureCount(),
    bytes: bytes.length,
    validate: sim.validate(),
    catalog: sim.catalog.length,
    history: sim.historyLen(),
  };
});

// Two captures: the scene itself (canvas readback, so it is exactly what the terrain renders) and
// the whole page, which is the only way to see the panels — swatches, palette, brush settings.
const shot = await page.evaluate(() => {
  const c = document.getElementById('view');
  return c.toDataURL('image/png');
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.split(',')[1], 'base64'));
// Hover the middle of the view with the place tool active, so the page capture shows the ghost —
// the thing you cannot check without a mouse.
const ghost = await page.evaluate(async () => {
  const app = window.rfEditor;
  const building = app.sim.catalog.find((c) => c.name === 'building').kind;
  app.kind = building;
  app.setTool('place');
  return building;
});
await page.mouse.move(640, 420);
await sleep(900);
const pickCheck = await page.evaluate(() => {
  const app = window.rfEditor;
  const cam = app.gs.camera;
  // Serialising the map allocates a megabyte inside wasm, which grows linear memory and detaches
  // every view into it. Saving a map and *then* painting used to put the brush where the camera
  // stood: the terrain's height lookups returned NaN, so the cursor ray fell through the ground on
  // its first sample. This is that sequence, checked.
  app.sim.toBytes();
  const sample = () => {
    const o = cam.position.clone();
    const dir = new o.constructor(0, 0, 0.5).unproject(cam).sub(o).normalize();
    // Where the cursor ray crosses the ground *by hand*, as an independent answer.
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += 2;
      const x = o.x + dir.x * t;
      const z = o.z + dir.z * t;
      const y = o.y + dir.y * t;
      if (y <= app.terrain.heightAt(x, z)) break;
    }
    return { cam: [Math.round(o.x), Math.round(o.y), Math.round(o.z)], hand: [Math.round(o.x + dir.x * t), Math.round(o.z + dir.z * t)] };
  };
  const before = sample();
  return {
    ground: [Math.round(app.ground.x), Math.round(app.ground.z)],
    heightsLen: app.sim.map.heights.length,
    camAt: before.cam,
    handPick: before.hand,
  };
});
const roadPath = await page.evaluate(() => {
  const app = window.rfEditor;
  app.roadMode = 'right';
  app.roadAnchor.set(100, 100);
  app.roadPts = [100, 100, 160, 130];
  const l = app.roadPath();
  app.roadMode = 'straight';
  const straight = app.roadPath();
  return { corner: l, straight };
});
const ghostCheck = await page.evaluate((kind) => {
  const app = window.rfEditor;
  const g = app.ghost;
  if (!g) return { visible: false };
  const p = app.sim.preview(kind, app.ground.x, app.ground.z, app.yaw, true);
  return {
    visible: g.visible,
    at: [Math.round(g.position.x * 10) / 10, Math.round(g.position.z * 10) / 10],
    preview: [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10],
  };
}, ghost);
// Set the view up on an L of walls with the ghost butted onto the end of the run, so the UI shot
// shows the join the editor is for rather than whatever the camera happened to be over.
const joint = await page.evaluate((kind) => {
  const app = window.rfEditor;
  const seg = 7.72;
  const base = { x: 150, z: 150 };
  // A run of two pieces, a wall dropped *free* just past its end (the shift case), and the ghost
  // turned square onto that wall's end — the join the old lattice rule could not make, because it
  // only ever counted whole segments from a wall's centre.
  app.setTool('place');
  app.kind = kind;
  app.beginStroke(base.x, base.z);
  app.dab(base.x, base.z, true, false);
  app.dab(base.x + seg, base.z, true, false);
  app.sim.place(kind, 0, base.x + seg * 2 + 1.4, base.z, 0, false);
  app.endStroke(false);
  const freeWall = { x: base.x + seg * 2 + 1.4, z: base.z };
  const freeEnd = { x: freeWall.x + seg * 0.5, z: freeWall.z };
  // Framed on the joint the report was about, with the island's own base in the same frame: the
  // perimeter is the thing to eyeball for walls that meet rather than cross.
  app.focus.set(freeEnd.x - 7, 0, freeEnd.z + 12);
  app.ground.set(freeEnd.x + 0.5, 0, freeEnd.z + 4);
  app.yaw = Math.PI / 2;
  app.rig.setYaw(0);
  // Framed on the team's own base: the perimeter is what to eyeball for walls that meet rather
  // than cross, and this is the last thing to touch the camera before the screenshot.
  const home = window.rfHomeBase ?? app.sim.baseAt(0);
  app.focus.set(home[0], 0, home[1] + 6);
  app.heading = 0;
  app.rig.setYaw(0);
  app.rig.zoom = 1.0;
  return {
    end: freeEnd,
    preview: app.sim.preview(kind, freeEnd.x + 0.5, freeEnd.z + 4, Math.PI / 2, true),
  };
}, ghost);
// The tools added for the second round: select/move/rotate, scatter, copy/paste, and the overview.
const tools = await page.evaluate(() => {
  const app = window.rfEditor;
  const api = app.api();
  // Where the island's own base is *now*: the base test below moves it, and the UI shot is taken
  // after that, so the camera has to be told a position that is still true then.
  window.rfHomeBase = api.baseAt(0);
  const sim = api.sim;
  const out = {};

  // --- select, move, turn, erase -------------------------------------------------
  const kind = sim.catalog.find((c) => c.name === 'tent').kind;
  api.setKind(kind);
  const spot = { x: 120, z: 300 };
  sim.placeChecked(kind, 0, spot.x, spot.z, 0, false);
  const picked = sim.pick(spot.x, spot.z);
  api.select(picked);
  api.selectAt(spot.x, spot.z + 0.5); // second click: put it down here
  const moved = sim.structureAt(picked);
  out.select = {
    picked,
    from: [spot.x, spot.z],
    to: [Math.round(moved[0] * 10) / 10, Math.round(moved[1] * 10) / 10],
    moved: Math.abs(moved[1] - (spot.z + 0.5)) < 0.2,
  };
  api.turnSelected(1);
  out.select.turned = sim.structureAt(picked)[2];
  // A move into another structure is refused, and the reason comes back.
  const other = sim.pick(spot.x + 1, spot.z + 0.5);
  out.select.occupied = sim.moveStructure(other, moved[0], moved[1], 0);
  api.eraseSelected();
  out.select.gone = sim.structureAt(picked) === null;

  // --- place is checked ----------------------------------------------------------
  const wallKind = sim.catalog.find((c) => c.name === 'wall').kind;
  sim.placeChecked(wallKind, 0, 140, 300, 0, false);
  const firstWall = sim.pick(140, 300);
  out.checkedPlace = {
    first: firstWall >= 0,
    again: sim.placeChecked(wallKind, 0, 140, 300, 0, false),
    free: sim.canPlace(wallKind, 140, 300, 0)[0],
    water: sim.canPlace(wallKind, 20, 20, 0)[0],
  };

  // --- scatter -------------------------------------------------------------------
  const before = sim.structureCount();
  api.setTool('scatter');
  const names = sim.scatterNames();
  const made = sim.scatter(0, 200, 320, 16, 1, 99);
  out.scatter = { names, made, added: sim.structureCount() - before, tool: api.tool() };

  // --- copy and paste ------------------------------------------------------------
  // Inland, with room for the paste to land whole.
  const camp = { x: 250, z: 250 };
  const drop = { x: camp.x + 90, z: camp.z + 90 };
  api.setTool('place');
  sim.beginStroke('probe camp');
  sim.placeChecked(kind, 0, camp.x, camp.z, 0, false);
  sim.placeChecked(kind, 0, camp.x + 12, camp.z, 0, false);
  sim.paintPave(camp.x + 6, camp.z + 6, 7, 210, 1, 1, 0.9);
  sim.endStroke();
  const campCount = sim.structureCount();
  const copied = sim.copyRect(camp.x - 4, camp.z - 4, camp.x + 16, camp.z + 16, camp.x, camp.z);
  const beforePaste = [sim.pick(camp.x, camp.z), sim.pick(camp.x + 12, camp.z)];
  const nonZero = () => {
    let n = 0;
    for (let i = 0; i < sim.map.road.length; i++) if (sim.map.road[i] > 0) n++;
    return n;
  };
  const roadBefore = nonZero();
  const clipInfo = sim.clipInfo();
  const pasted = sim.pasteRect(drop.x, drop.z);
  // The bridge hands the browser *copies* of the layers, refreshed on demand: read them stale and
  // the paste looks like it did nothing.
  sim.refresh();
  const roadAfter = nonZero();
  // Every paved cell in the pasted rectangle, so the offsets can be compared with the clipboard's
  // own report rather than guessed at. A sample can land on a joint; a list cannot.
  const pavedList = (x0, z0, x1, z1) => {
    const g = sim.map.grid + 1;
    const cell = sim.map.cell;
    const out = [];
    for (let iz = Math.floor(z0 / cell); iz <= Math.ceil(z1 / cell); iz++) {
      for (let ix = Math.floor(x0 / cell); ix <= Math.ceil(x1 / cell); ix++) {
        const v = sim.map.road[iz * g + ix];
        // The camp's own slabs, not the faint fade of a road that happens to cross the window.
        if (v > 120) out.push([ix * cell, iz * cell, v]);
      }
    }
    return out;
  };
  const pastedPave = pavedList(drop.x - 20, drop.z - 20, drop.x + 30, drop.z + 30);
  const sourcePave = pavedList(camp.x - 20, camp.z - 20, camp.x + 30, camp.z + 30);

  const afterPaste = [sim.pick(drop.x, drop.z), sim.pick(drop.x + 12, drop.z)];
  const pastedAt = sim.structureAt(sim.pick(drop.x, drop.z));
  const paveAt = (x, z) => {
    const ix = Math.round(x / sim.map.cell);
    const iz = Math.round(z / sim.map.cell);
    return sim.map.road[iz * (sim.map.grid + 1) + ix];
  };
  out.copy = {
    copied,
    pasted,
    anchored: pastedAt ? Math.hypot(pastedAt[0] - drop.x, pastedAt[1] - drop.z) < 0.3 : false,
    hasClip: sim.hasClip(),
    campCount,
    total: sim.structureCount(),
    secondLanded: sim.pick(camp.x + 12 + 90, camp.z + 90) >= 0,
    // The slab value at the copy anchor, and at the paste anchor: a single cell, and the paste
    // puts that cell back under the cursor.
    pavement: [paveAt(camp.x + 6, camp.z + 6), paveAt(drop.x + 6, drop.z + 6)],
    clipInfo,
    // The first paved cell in the source rectangle and in the pasted one: the same value, offset by
    // the paste. A single sample can land on a joint between slabs; a list cannot.
    // The clipboard's own first paved cell, and what the map holds where the paste should have put
    // it: equal means the pavement travelled with the structures, offset and all.
    clipCellAtDest: [clipInfo[3], paveAt(clipInfo[1] + 90, clipInfo[2] + 90)],
    pavedCount: [sourcePave.length, pastedPave.length],
    roadCells: [roadBefore, roadAfter],
    tentsBefore: beforePaste,
    tentsAfter: afterPaste,
  };

  // --- the overview --------------------------------------------------------------
  // The map must be drawn in the world's own axes. Checked by placing a bright marker structure at
  // a known offset from the island's centre and looking for the pixel the projection predicts —
  // "the minimap is inverted" is not something a screenshot can settle.
  const centre = { x: sim.map.worldSize * 0.5, z: sim.map.worldSize * 0.5 };
  const marks = [
    ['east', centre.x + 60, centre.z],
    ['south', centre.x, centre.z + 60],
  ];
  const seen = {};
  for (const [name, x, z] of marks) {
    api.setTool('place');
    const hq = sim.catalog.find((c) => c.name === 'hq').kind;
    api.setKind(hq);
    // A marker that refuses to land would make this check lie, so the placement is verified first.
    const block = sim.placeChecked(hq, 0, x, z, 0, false);
    if (block !== 0) {
      seen[name] = { block, hit: false };
      continue;
    }
    sim.refresh();
    app.minimapRevision = -1;
    app.drawMinimap();
    const px = api.minimapPixels();
    const [sx, sy] = api.minimapProject(x, z);
    // Look in a small window around the predicted point for the structure dot. Alpha is the test:
    // the dots are drawn in their team's colour, so "a bright pixel" would find the ground instead.
    let hit = false;
    for (let dy = -3; dy <= 3 && !hit; dy++) {
      for (let dx = -3; dx <= 3 && !hit; dx++) {
        const i = ((Math.round(sy) + dy) * px.w + Math.round(sx) + dx) * 4;
        if (px.data[i + 3] > 200) hit = true;
      }
    }
    // What is actually at and around the predicted pixel, for a failure worth reading.
    const at = (x, y) => {
      const i = (y * px.w + x) * 4;
      return [px.data[i], px.data[i + 1], px.data[i + 2]];
    };
    seen[name] = { predicted: [Math.round(sx), Math.round(sy)], hit, pixel: at(Math.round(sx), Math.round(sy)) };
  }
  // A second, independent image of the same grid, drawn from the *bridge's own copy* of the map
  // with no shared code: if the overview were flipped, these two would disagree.
  const reference = (() => {
    const g = sim.map.grid;
    const cell = sim.map.cell;
    const c = document.createElement('canvas');
    c.width = 174;
    c.height = 174;
    const ctx2 = c.getContext('2d');
    const img = ctx2.createImageData(g, g);
    for (let iz = 0; iz < g; iz++) {
      for (let ix = 0; ix < g; ix++) {
        const vi = iz * (g + 1) + ix;
        const land = sim.map.heights[vi] > sim.map.waterLevel;
        const o = (iz * g + ix) * 4;
        img.data[o] = land ? 200 : 20;
        img.data[o + 1] = land ? 190 : 60;
        img.data[o + 2] = land ? 120 : 120;
        img.data[o + 3] = 255;
      }
    }
    ctx2.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  })();
  out.reference = reference;
  // The turn toggle: it puts the axes back the way the world has them (+x right, +z down), and
  // toggling again restores the turned default.
  const unturned = {};
  // `minimapFlip()` toggles and returns the new state, so this starts turned: toggle to unturn,
  // read, toggle back.
  const wasTurned = api.minimapFlip();
  for (const [name, x, z] of marks) {
    unturned[name] = api.minimapProject(x, z).map(Math.round);
  }
  api.minimapFlip();
  out.turnToggle = {
    wasTurned,
    unturnedEast: unturned.east,
    unturnedSouth: unturned.south,
    restoredEast: api.minimapProject(marks[0][1], marks[0][2]).map(Math.round),
    ok:
      !!unturned.east &&
      unturned.east[0] > unturned.south[0] &&
      unturned.south[1] > unturned.east[1] &&
      api.minimapProject(marks[0][1], marks[0][2])[0] < unturned.east[0],
  };
  out.overview = {
    present: !!api.minimap(),
    navOn: api.minimapNav(),
    toggled: (api.toggleMinimapNav(), api.minimapNav()),
    marks: seen,
    // The overview is drawn **turned** (west is right, north is down) — how the map is read, so
    // walking north moves the cursor *down* it. The orientation itself is the reader's call, so
    // what is checked here is that the marks are drawn where `project` says they are: the ground,
    // the marks, the camera box and the cursor share that one function, and a flip applied to the
    // image alone would leave the box pointing the wrong way.
    axesOk: seen.east.hit && seen.south.hit,
  };

  // --- bases: only two teams, and a move is one step ---------------------------------
  const readOne = {};
  const baseBefore = sim.baseAt(0);
  // Neutral cannot own a base: the request must do nothing at all.
  sim.moveBase(2, baseBefore[0] + 80, baseBefore[1] + 80, 0);
  const neutralRefused =
    Math.hypot(sim.baseAt(0)[0] - baseBefore[0], sim.baseAt(0)[1] - baseBefore[1]) < 0.01 &&
    api.teamCanOwnBase(0) &&
    api.teamCanOwnBase(1) &&
    !api.teamCanOwnBase(2);
  // Moving green takes its old complex out and puts a new one at the site, in one undo step.
  // `structure(i, out)` is the bridge's own reader; poking at the float view would depend on the
  // stride and the field order, which is exactly what the bridge exists to hide.
  // A base's own footprint is about 50 x 40 m, so 30 m of radius is "at this base" and no more:
  // a wider window catches the *other* base, which is all this measurement would then be reading.
  const wallsAt = (x, z) => {
    let n = 0;
    for (let i = 0; i < sim.structureCount(); i++) {
      sim.structure(i, readOne);
      if (readOne.kind === 7 && Math.hypot(readOne.x - x, readOne.z - z) < 30) n++;
    }
    return n;
  };
  const wallsPerTeam = () => {
    const n = [0, 0, 0];
    for (let i = 0; i < sim.structureCount(); i++) {
      sim.structure(i, readOne);
      if (readOne.kind === 7) n[Math.min(2, Math.round(readOne.team))]++;
    }
    return n;
  };
  const wallsBefore = wallsAt(baseBefore[0], baseBefore[1]);
  const wallsPerTeamBefore = wallsPerTeam();
  const site = [baseBefore[0] - 70, baseBefore[1] + 40];
  void wallsBefore;
  sim.moveBase(0, site[0], site[1], 0.3);
  sim.refresh();
  out.bases = {
    neutralRefused,
    // Walls per team, before and after a move: green's old perimeter has to be gone and its new
    // one standing, and brown's has to still be there — the pair is rebuilt so they stay in step.
    wallsPerTeamBefore: wallsPerTeamBefore,
    wallsPerTeamAfter: wallsPerTeam(),
    nearNew: (() => {
      const list = [];
      for (let i = 0; i < sim.structureCount(); i++) {
        sim.structure(i, readOne);
        const d = Math.hypot(readOne.x - site[0], readOne.z - site[1]);
        if (d < 70) list.push([Math.round(d), readOne.kind, Math.round(readOne.x), Math.round(readOne.z)]);
      }
      list.sort((a, b) => a[0] - b[0]);
      return list.slice(0, 6);
    })(),
    wallsAtOld: wallsAt(baseBefore[0], baseBefore[1]),
    wallsAtNew: wallsAt(site[0], site[1]),
    anchorMoved: Math.hypot(sim.baseAt(0)[0] - site[0], sim.baseAt(0)[1] - site[1]) < 1,
  };
  const undoOk = sim.undo();
  sim.refresh();
  out.bases.undoRestored = undoOk && Math.hypot(sim.baseAt(0)[0] - baseBefore[0], sim.baseAt(0)[1] - baseBefore[1]) < 1;
  api.setTool('place');
  return out;
});
const uiOut = resolve(ROOT, flag('out-ui', 'shots/editor-ui.png'));
await page.screenshot({ path: uiOut });

// Then: does the stored map actually play in the game?
const play = await page.evaluate(async () => {
  const app = window.rfEditor;
  const b64 = (() => {
    const bytes = app.sim.toBytes();
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  })();
  localStorage.setItem('rf.editor.play', b64);
  return b64.length;
});

// Then play it: the same browser context, so the stored map is the one the editor wrote. The
// game's `?map=play` path has to come up on the edited battlefield rather than a generated one.
await page.goto(`http://127.0.0.1:${PORT}/index.html?map=play&auto=1&capture=1&warmup=2`, { waitUntil: 'load' });
let played = null;
try {
  await page.waitForFunction(() => typeof window.rfProbe === 'function', null, { timeout: 120000 });
  await sleep(2500);
  played = await page.evaluate(() => {
    const p = window.rfProbe();
    return { mapName: p.mapName, structures: p.structures, mapSize: p.mapSize, phase: p.phase };
  });
  const playShot = await page.evaluate(() => document.getElementById('view').toDataURL('image/png'));
  const playOut = resolve(ROOT, flag('out-play', 'shots/editor-play.png'));
  mkdirSync(dirname(playOut), { recursive: true });
  writeFileSync(playOut, Buffer.from(playShot.split(',')[1], 'base64'));
} catch (err) {
  played = { error: String(err) };
}

console.log(
  JSON.stringify({ ...report, pickCheck, roadPath, ghostCheck, joint, tools, storedBase64: play, played, errors }, null, 2),
);
await browser.close();
stop();
