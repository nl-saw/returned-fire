/**
 * Map overview: the whole battlefield in the corner of the screen.
 *
 * Two jobs, and the second is the interesting one. The obvious job is orientation — where the
 * island is, where the camera is looking, where the cursor is. The second is the **nav overlay**:
 * the overview draws the same `nav` grid the pathfinder routes on, so a lane that looks open but is
 * not drivable shows up as a colour, instead of staying invisible until a vehicle wedges itself in
 * it.
 *
 * The work is split the way the cost is. Two offscreen images are rebuilt only when the map
 * changes (`revision`): the ground, one pixel per cell, and the structures/nav layer. The camera
 * footprint and the cursor are cheap strokes drawn every frame on top.
 */
import type { MapBuffers } from '../sim/bridge.js';

export interface Minimap {
  readonly canvas: HTMLCanvasElement;
  /** Rebuild both layers: call when the map's `revision` moves. */
  refresh(map: MapBuffers): void;
  /** Redraw: base, overlay, camera footprint, cursor. */
  draw(map: MapBuffers, view: View): void;
  /**
   * Match the drawing buffer to the element's laid-out size. Safe to call often; it does nothing
   * when the size has not changed.
   */
  fit(): void;
  /**
   * Where a world point lands on the canvas, in drawing-buffer pixels.
   *
   * The overview is drawn in the *world's* own axes — `+x` right, `+z` down — which is the same
   * orientation as the ground image and the nav grid, so the three cannot disagree. The projection
   * is exposed so a harness can measure it rather than trust a screenshot.
   */
  project(x: number, z: number): [number, number];
  /**
   * Turn the overview through 180° — **on by default**.
   *
   * The map is drawn turned: world `-x` is right and `-z` is down, so walking north moves the
   * cursor *down* the overview and walking east moves it *left*. That is the way the player reads
   * it (asked for twice, in those words), and the reader is the authority on what a map looks like
   * to them. The ground image, the marks, the camera footprint, the cursor and `project()` all turn
   * together, so nothing can disagree with anything else; the toggle is there to get the unturned
   * axes back. A harness checks the turn is consistent, not which way it faces.
   */
  toggleFlip(): boolean;
  readonly flipped: boolean;
  /** Turn the drivable-ground overlay on or off. Returns the new state. */
  toggleNav(): boolean;
  readonly navOn: boolean;
}

export interface View {
  /** Camera focus, in world metres. */
  x: number;
  z: number;
  /** Half-extents of the ground the camera sees, in metres. */
  halfW: number;
  halfH: number;
  heading: number;
  /** Cursor position, in world metres. */
  cursorX: number;
  cursorZ: number;
}

/** Ground colours, sampled to match what the renderer blends. */
const SAND: [number, number, number] = [206, 186, 138];
const DIRT: [number, number, number] = [150, 122, 88];
const ROCK: [number, number, number] = [122, 122, 118];
const GRASS: [number, number, number] = [116, 138, 82];
const PAVE: [number, number, number] = [168, 168, 164];
const SHALLOW: [number, number, number] = [86, 158, 168];
const DEEP: [number, number, number] = [24, 62, 92];

/** Team colours for the structure dots: green, brown, neutral. */
const TEAM: string[] = ['#8fd06a', '#c08a55', '#cfcfcf'];

export function createMinimap(): Minimap {
  // A second mount (a hot reload, a double boot) must not leave two maps stacked on the page:
  // the old one keeps its own size and shows through from underneath.
  document.querySelectorAll('#minimap').forEach((old) => old.remove());
  const canvas = document.createElement('canvas');
  canvas.id = 'minimap';
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  /** One pixel per ground cell: the ground, drawn once per edit. */
  const ground = document.createElement('canvas');
  const gctx = ground.getContext('2d') as CanvasRenderingContext2D;
  /** Structures and the nav overlay, on their own layer because they change together. */
  const marks = document.createElement('canvas');
  const mctx = marks.getContext('2d') as CanvasRenderingContext2D;

  const size = 176;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let grid = 0;
  let worldSize = 1;
  let nav = false;
  // Turned, as asked. One flag, read by `project` and by the drawing transform, so every layer
  // turns together: a flip that only moved the image would leave the camera box and the cursor
  // pointing the wrong way.
  let flipped = true;

  /**
   * Match the drawing buffers to the element's on-screen size.
   *
   * The canvas is laid out by CSS (so a resize is a stylesheet change), and this only has to run
   * when that laid-out size or the device pixel ratio changes. Without it the canvas keeps its
   * default 300x150 backing store and draws into the top-left corner of its box — which is what a
   * "black box above the minimap" turned out to be.
   */
  let bufW = 0;
  let bufH = 0;
  const fit = (): void => {
    if (grid > 0) {
      for (const c of [ground, marks]) {
        if (c.width !== grid || c.height !== grid) {
          c.width = grid;
          c.height = grid;
        }
      }
    }
    const css = canvas.clientWidth || size;
    const want = Math.round(css * dpr);
    if (want !== bufW) {
      canvas.width = want;
      bufW = want;
    }
    if (want !== bufH) {
      canvas.height = want;
      bufH = want;
    }
  };

  const refresh = (m: MapBuffers): void => {
    grid = m.grid;
    worldSize = m.worldSize;
    fit();
    if (ground.width !== grid) fit();
    const verts = grid + 1;
    // --- ground ---------------------------------------------------------------------
    const img = gctx.createImageData(grid, grid);
    const px = img.data;
    for (let iz = 0; iz < grid; iz++) {
      for (let ix = 0; ix < grid; ix++) {
        const vi = iz * verts + ix;
        const h = m.heights[vi];
        let r: number;
        let g: number;
        let b: number;
        if (h <= m.waterLevel) {
          // Deeper water darker: that is what makes a coastline legible at this size.
          const t = Math.min(1, (m.waterLevel - h) / 12);
          r = SHALLOW[0] + (DEEP[0] - SHALLOW[0]) * t;
          g = SHALLOW[1] + (DEEP[1] - SHALLOW[1]) * t;
          b = SHALLOW[2] + (DEEP[2] - SHALLOW[2]) * t;
        } else if (m.road[vi] > 90) {
          [r, g, b] = PAVE;
        } else {
          const s = vi * 4;
          const sum = Math.max(1, m.splat[s] + m.splat[s + 1] + m.splat[s + 2] + m.splat[s + 3]);
          const ws = m.splat[s] / sum;
          const wd = m.splat[s + 1] / sum;
          const wr = m.splat[s + 2] / sum;
          const wg = m.splat[s + 3] / sum;
          r = SAND[0] * ws + DIRT[0] * wd + ROCK[0] * wr + GRASS[0] * wg;
          g = SAND[1] * ws + DIRT[1] * wd + ROCK[1] * wr + GRASS[1] * wg;
          b = SAND[2] * ws + DIRT[2] * wd + ROCK[2] * wr + GRASS[2] * wg;
        }
        const o = (iz * grid + ix) * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
    }
    gctx.putImageData(img, 0, 0);

    // --- structures -----------------------------------------------------------------
    mctx.clearRect(0, 0, grid, grid);
    const k = grid / m.worldSize;
    const st = m.structures;
    const stride = 14;
    if ((window as unknown as { rfMinimapDebug?: boolean }).rfMinimapDebug) {
      console.log('minimap marks', { len: st.length, stride, grid, worldSize: m.worldSize });
    }
    for (let i = 0; i + stride <= st.length; i += stride) {
      const x = st[i] * k;
      const z = st[i + 2] * k;
      const team = st[i + 8] | 0;
      mctx.fillStyle = TEAM[team] ?? TEAM[2] ?? '#cfcfcf';
      // A wall is a line, not a dot; everything else is a dot sized by its footprint.
      const w = Math.max(1, st[i + 4] * k);
      const d = Math.max(1, st[i + 5] * k);
      mctx.fillRect(x - w * 0.5, z - d * 0.5, w, d);
    }
  };

  const draw = (m: MapBuffers, v: View): void => {
    // Cheap, and it catches a stylesheet change or a window move between two monitors.
    if (Math.round((canvas.clientWidth || size) * dpr) !== bufW) fit();
    const w = canvas.width;
    const h = canvas.height;
    const k = w / Math.max(1, m.worldSize);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    if (flipped) {
      // One transform rather than mirrored maths in every branch below: the ground, the marks,
      // the footprint and the cursor all come out turned together.
      ctx.save();
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(ground, 0, 0, w, h);
    if (nav) {
      // The nav grid, cell by cell, as a wash over the ground: green where a land hull may drive,
      // red water, dark solid. The point is to see a lane that looks open and is not.
      const n = m.nav;
      const cellPx = w / m.grid;
      for (let iz = 0; iz < m.grid; iz++) {
        for (let ix = 0; ix < m.grid; ix++) {
          const t = n[iz * m.grid + ix];
          const solid = t === 2 || t === 5;
          const water = t === 0 || t === 1;
          ctx.fillStyle = solid
            ? 'rgba(20,20,20,0.75)'
            : water
              ? 'rgba(210,70,70,0.45)'
              : t === 4
                ? 'rgba(200,180,120,0.45)'
                : 'rgba(110,230,120,0.42)';
          ctx.fillRect(ix * cellPx, iz * cellPx, cellPx + 0.5, cellPx + 0.5);
        }
      }
    } else {
      ctx.drawImage(marks, 0, 0, w, h);
    }
    // The camera's footprint: the ground the frame covers, turned with the heading.
    ctx.save();
    ctx.translate(v.x * k, v.z * k);
    ctx.rotate(-v.heading);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.4 * dpr;
    ctx.strokeRect(-v.halfW * k, -v.halfH * k, v.halfW * 2 * k, v.halfH * 2 * k);
    ctx.restore();
    // The cursor.
    ctx.fillStyle = '#ffe08a';
    ctx.beginPath();
    ctx.arc(v.cursorX * k, v.cursorZ * k, 2.4 * dpr, 0, Math.PI * 2);
    ctx.fill();
    if (flipped) ctx.restore();
  };

  const project = (x: number, z: number): [number, number] => {
    const k = canvas.width / Math.max(1, worldSize);
    const w = canvas.width;
    const h = canvas.height;
    return flipped ? [w - x * k, h - z * k] : [x * k, z * k];
  };

  return {
    canvas,
    refresh,
    draw,
    project,
    /** Size the backing store to the element. Call once the canvas is in the document. */
    fit,
    toggleNav() {
      nav = !nav;
      return nav;
    },
    get navOn() {
      return nav;
    },
    toggleFlip() {
      flipped = !flipped;
      return flipped;
    },
    get flipped() {
      return flipped;
    },
  };
}
