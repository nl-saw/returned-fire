/**
 * Map editor.
 *
 * The whole app is three things wired together: the wasm map ([`EditorSim`]), the same terrain
 * and scene the game draws, and a toolbar. There is no simulation — an edit is a change to the
 * map layers plus a nav rebuild — so this page boots in a fraction of the game's time and can
 * afford to refresh the terrain after every brush dab.
 *
 * Controls
 *   left drag            apply the active tool
 *   right / middle drag  pan the camera
 *   wheel                zoom, `Q`/`E` rotate, `Tab` tilt
 *   `[` / `]`            brush size, `R`/`T` placement yaw
 *   `ctrl+Z` / `ctrl+shift+Z`  undo / redo
 *   `1`..`9`, `0`, `-`   tool shortcuts
 */
import * as THREE from 'three';
import { createSurfaceLibrary, warmupLibrary } from '../assets/textures/index.js';
import type { MatKey, SurfaceLibrary } from '../assets/types.js';
import { createGameScene, type GameScene, type Quality } from '../render/scene.js';
import { BASE_DISTANCE, createCameraRig, type CameraRig } from '../render/camera.js';
import { createTerrain, type GroundRect, type Terrain } from '../render/terrain.js';
import { EditorSim } from './bridge.js';
import { createEditorStructures, type EditorStructures } from './structures.js';
import { createMinimap, type Minimap } from './minimap.js';

type Tool =
  | 'land'
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'paint'
  | 'pave'
  | 'road'
  | 'place'
  | 'select'
  | 'scatter'
  | 'copy'
  | 'erase'
  | 'movebase'
  | 'placebase';

/** The ground material the paint tool lays: one swatch, one family and variant. */
interface Material {
  family: number;
  variant: number;
  label: string;
}

/**
 * The paint palette. Family 0 is sand and 1 is grass, whose *variant* picks the stop on the ramp;
 * 2 and 3 are dirt and rock, which have a single recipe each.
 */
const MATERIALS: { key: MatKey | 'dirt' | 'rock' | 'paveTiles' | 'paveStrip'; family: number; variant: number; label: string }[] = [
  { key: 'sand', family: 0, variant: 0, label: 'dune' },
  { key: 'sandGrit', family: 0, variant: 1, label: 'grit' },
  { key: 'sandCoral', family: 0, variant: 2, label: 'coral' },
  { key: 'dirt', family: 2, variant: 0, label: 'dirt' },
  { key: 'rock', family: 3, variant: 0, label: 'rock' },
  { key: 'grassLush', family: 1, variant: 0, label: 'lush' },
  { key: 'grass', family: 1, variant: 1, label: 'scrub' },
  { key: 'grassDry', family: 1, variant: 2, label: 'dry' },
];

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'land', label: 'island', hint: 'paint land and sea (the land-height slider)' },
  { id: 'raise', label: 'raise', hint: 'lift the ground' },
  { id: 'lower', label: 'lower', hint: 'dig the ground' },
  { id: 'smooth', label: 'smooth', hint: 'average the ground with its neighbours' },
  { id: 'paint', label: 'paint', hint: 'paint the ground material picked in the palette' },
  { id: 'pave', label: 'pavement', hint: 'lay slabs or a strip (alt erases)' },
  { id: 'road', label: 'road', hint: 'drag a road of the road width (alt erases)' },
  { id: 'place', label: 'place', hint: 'drop the selected structure (refuses an occupied spot)' },
  { id: 'select', label: 'select', hint: 'click a structure to move it, R/T to turn it, delete to erase' },
  { id: 'scatter', label: 'scatter', hint: 'sprinkle the scenery group picked in the palette' },
  { id: 'copy', label: 'copy', hint: 'drag a rectangle to copy; click to paste what was copied' },
  { id: 'erase', label: 'erase', hint: 'remove structures and pavement under the brush' },
  { id: 'movebase', label: 'move base', hint: 'pick up the team\u2019s main base and put it down whole' },
  { id: 'placebase', label: 'place base', hint: 'build the team\u2019s main base here (replaces the old one)' },
];

const SHORTCUTS: Record<string, Tool> = {
  '1': 'land',
  '2': 'raise',
  '3': 'lower',
  '4': 'smooth',
  '5': 'paint',
  '6': 'pave',
  '7': 'road',
  '8': 'place',
  '9': 'erase',
  '0': 'movebase',
  '-': 'placebase',
  v: 'select',
  b: 'scatter',
  c: 'copy',
};

/**
 * Why a placement was refused, in the words the status line uses.
 *
 * The numbers are the Rust `PlaceBlock` enum: the ghost's tint and the refusal come from the same
 * call, so the colour, the message and the click can never disagree.
 */
const BLOCK_TEXT: Record<number, string> = {
  1: 'off the map',
  2: 'that is water',
  3: 'something is already there',
  4: 'the editor does not know that kind',
  5: 'that structure is gone',
};

/** Brush size is a **radius** in metres: the slider says what it reaches, not its diameter. */

const QUICK_KEY = 'rf.editor.map';
const PLAY_KEY = 'rf.editor.play';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function base64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class EditorApp {
  readonly gs: GameScene;
  readonly lib: SurfaceLibrary;
  private rig: CameraRig;
  private sim!: EditorSim;
  private terrain!: Terrain;
  private structures!: EditorStructures;
  private focus = new THREE.Vector3(256, 0, 256);
  private heading = 0;
  private tool: Tool = 'land';
  private kind = 0;
  private brush = { radius: 12, strength: 0.8, hard: 0.4 };
  private material: Material = { family: 0, variant: 0, label: 'dune' };
  private team = 0;
  private roadWidth = 8;
  private roadMode: 'free' | 'straight' | 'right' = 'right';
  private yaw = 0;
  private pointer = new THREE.Vector2();
  private ndc = new THREE.Vector2();
  private ground = new THREE.Vector3();
  private overMap = false;
  private dragging: 'none' | 'paint' | 'pan' = 'none';
  private lastPaint = new THREE.Vector2();
  private roadPts: number[] = [];
  private roadAnchor = new THREE.Vector2();
  private roadPreview = new THREE.Group();
  private ghost: THREE.Object3D | null = null;
  private ghostKind = -2;
  private ghostTeam = -1;
  private ghostBase = false;
  private baseRing: THREE.Mesh;
  private ring: THREE.Mesh;
  private dirty = true;
  /** Free placement (shift) or nothing at all; see `freePlace`. */
  /**
   * The editor's state and actions, for harnesses.
   *
   * `tools/editor-probe.mjs` drives the editor through these — the same calls the toolbar and the
   * keyboard make, so a tool that stops working shows up there rather than in a screenshot nobody
   * diffs. Kept deliberately small: whatever the probe needs is what is here.
   */
  api(): Record<string, unknown> {
    return {
      sim: this.sim,
      terrain: this.terrain,
      brushRect: (x: number, z: number) => this.brushRect(x, z),
      tool: () => this.tool,
      setTool: (t: Tool) => this.setTool(t),
      kind: () => this.kind,
      setKind: (k: number) => {
        this.kind = k;
        if (this.tool !== 'place') this.setTool('place');
      },
      scatterGroup: () => this.scatterGroup,
      setScatterGroup: (g: number) => {
        this.scatterGroup = g;
      },
      select: (i: number) => {
        this.selected = i;
      },
      selected: () => this.selected,
      selectAt: (x: number, z: number) => this.selectAt(x, z),
      turnSelected: (q: number) => this.turnSelected(q),
      eraseSelected: () => this.eraseSelected(),
      copyOrPaste: (x: number, z: number, first: boolean) => this.copyOrPaste(x, z, first),
      finishCopy: () => this.finishCopy(),
      ghostNote: () => this.ghostNote,
      minimapNav: () => this.minimapNav,
      toggleMinimapNav: () => this.toggleMinimapNav(),
      minimap: () => this.minimap?.canvas ?? null,
      drawMinimap: () => this.drawMinimap(),
      moveBase: (team: number, x: number, z: number, yaw: number) => this.sim.moveBase(team, x, z, yaw),
      baseAt: (team: number) => this.sim.baseAt(team),
      teamCanOwnBase: (team: number) => this.sim.teamCanOwnBase(team),
      minimapProject: (x: number, z: number) => this.minimap?.project(x, z) ?? null,
      minimapFlip: () => this.minimap?.toggleFlip() ?? false,
      /** Read the overview's pixels: what the harness checks the projection against. */
      minimapPixels: () => {
        const c = this.minimap?.canvas;
        if (!c) return null;
        const g = c.getContext('2d');
        const d = g?.getImageData(0, 0, c.width, c.height);
        return d ? { w: c.width, h: c.height, data: Array.from(d.data) } : null;
      },
    };
  }

  /** Whether the ghost's current spot would be accepted, and the select tool's note. */
  /** Why the ghost's current spot would be refused, or empty when it would be accepted. */
  private ghostNote = '';
  /** The structure the select tool has hold of, and the last "cannot move there" reason. */
  private selected = -1;
  private selectNote = '';
  /** Where a copy drag started, and where a paste would land. */
  private copyAnchor: THREE.Vector2 | null = null;
  private copyDrag = false;
  private copyRect: { x0: number; z0: number; x1: number; z1: number } | null = null;
  /** The rubber band the copy tool draws, and the outline around a selected structure. */
  private band: THREE.Mesh;
  private marker: THREE.Mesh;
  /** Which scatter group the brush sprinkles, and the seed of the stroke in progress. */
  private scatterGroup = 0;
  private strokeSeed = 1;
  /** What one frame's edits touched, in metres. `null` means "assume the whole map". */
  private dirtyRect: GroundRect | null = null;
  /** Set by an edit that can touch more than any rectangle knows about — a base stamp, a paste,
   *  an undo, a loaded map. The frame takes the full pass even if a rect is pending. (A revision
   *  check cannot do this job: nothing but `refresh()` bumps the revision, and `endStroke` does
   *  that for every ordinary stroke too, so the check could never tell the two apart.) */
  private dirtyFull = false;
  private last = performance.now();
  /** The corner overview, and the revision its layers were built from. */
  private minimap: Minimap | null = null;
  private minimapRevision = -1;
  private minimapNav = false;

  constructor(canvas: HTMLCanvasElement) {
    const quality: Quality = 'medium';
    // `?capture=1` keeps the drawing buffer alive so a harness can read the frame back out of the
    // canvas (the same switch the game's screenshot harness uses).
    const keep = new URLSearchParams(location.search).has('capture');
    this.gs = createGameScene(canvas, quality, keep);
    this.lib = createSurfaceLibrary({
      anisotropy: this.gs.renderer.capabilities.getMaxAnisotropy(),
      size: Number(new URLSearchParams(location.search).get('texsize') ?? 256),
    });
    this.rig = createCameraRig(this.gs.camera);
    // Editing wants a map-scale view, not the game's chase framing: `?zoom=` still wins when a
    // harness asks for an exact distance.
    if (!new URLSearchParams(location.search).has('zoom')) this.rig.zoomBy(2.4);
    // A ring on the ground is the brush: it reads the radius in metres directly, which is what
    // every tool's slider is in.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 5;
    this.gs.scene.add(this.ring);
    this.gs.scene.add(this.roadPreview);
    // A base previews as the footprint it will take: 48 x 38 m of ring, turned with R/T.
    this.baseRing = new THREE.Mesh(
      new THREE.RingGeometry(20.0, 20.6, 4),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthTest: false }),
    );
    this.baseRing.rotation.x = -Math.PI / 2;
    this.baseRing.renderOrder = 5;
    this.baseRing.visible = false;
    this.gs.scene.add(this.baseRing);
    // The copy rectangle, as a flat band on the ground while it is dragged.
    this.band = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x8ad0ff, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    this.band.renderOrder = 5;
    this.band.visible = false;
    this.gs.scene.add(this.band);
    // And the outline around whatever the select tool has hold of.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.98, 1.0, 4),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.renderOrder = 6;
    this.marker.visible = false;
    this.gs.scene.add(this.marker);
    // The overview lives in the DOM, over the canvas: a small canvas is cheaper and sharper than
    // a second render target, and it can be read back for a screenshot.
    const host = document.getElementById('overview');
    if (host) {
      this.minimap = createMinimap();
      host.appendChild(this.minimap.canvas);
      // The element has to be in the document before it has a laid-out size to match.
      this.minimap.fit();
      this.minimapRevision = -1;
    }
  }

  /** Toggle the drivable-ground overlay: `M` cycles it, and the panel button does the same. */
  toggleMinimapNav(): void {
    if (!this.minimap) return;
    this.minimapNav = this.minimap.toggleNav();
    this.flash(this.minimapNav ? 'nav overlay on' : '');
  }

  /** Load (or replace) the map and rebuild everything that depends on its layers. */
  private async install(sim: EditorSim): Promise<void> {
    this.sim = sim;
    this.terrain?.dispose();
    this.gs.scene.remove(this.terrain?.group ?? new THREE.Object3D());
    this.terrain = createTerrain(this.sim.map, this.gs, this.lib, 'medium');
    this.gs.scene.add(this.terrain.group);
    if (!this.structures) {
      this.structures = createEditorStructures(this.lib);
      this.gs.scene.add(this.structures.group);
    }
    this.rebuildStructures();
    this.focus.set(this.sim.map.worldSize * 0.5, 0, this.sim.map.worldSize * 0.5);
    this.ring.position.y = this.terrain.heightAt(this.focus.x, this.focus.z) + 0.3;
    this.syncUi();
  }

  private rebuildStructures(): void {
    this.structures.rebuild(this.sim.structures(), this.sim.structureCount());
  }

  private syncUi(): void {
    el<HTMLInputElement>('seed').value = String(this.sim.seed());
    el<HTMLSelectElement>('size').value = String(this.sim.sizeIndex());
    el<HTMLSelectElement>('mode').value = String(this.sim.mode());
    const canU = this.sim.canUndo();
    const canR = this.sim.canRedo();
    el<HTMLButtonElement>('undo').disabled = !canU;
    el<HTMLButtonElement>('redo').disabled = !canR;
    el('history').textContent = `${this.sim.historyLen()} / 20`;
    const err = this.sim.validate();
    const status = el('status');
    status.textContent = err === '' ? `ok · ${this.sim.structureCount()} structures` : `check: ${err}`;
    status.className = err === '' ? 'good' : 'bad';
  }

  private pick(): boolean {
    this.rig.groundPoint(this.ndc, (x, z) => this.terrain.heightAt(x, z), this.ground);
    // The ray march has no miss to report: outside the map it clamps to the heightfield's edge,
    // so "over the map" is a bounds test on the result.
    const w = this.sim.map.worldSize;
    this.overMap = this.ground.x >= 0 && this.ground.z >= 0 && this.ground.x <= w && this.ground.z <= w;
    return this.overMap;
  }

  /** One dab of the active tool at the picked ground point. */
  private dab(x: number, z: number, first: boolean, alt: boolean): void {
    const r = this.brush.radius;
    const s = this.brush.strength;
    const h = this.brush.hard;
    switch (this.tool) {
      case 'land':
        this.sim.level(x, z, r, Number(el<HTMLInputElement>('landh').value), s, h);
        break;
      case 'raise':
        this.sim.raise(x, z, r, (0.6 + s * 4) * (first ? 1 : 0.7), h);
        break;
      case 'lower':
        this.sim.raise(x, z, r, -(0.6 + s * 4) * (first ? 1 : 0.7), h);
        break;
      case 'smooth':
        this.sim.smooth(x, z, r, s, h);
        break;
      case 'paint':
        this.sim.paintMaterial(this.material.family, this.material.variant, x, z, r, s, h);
        break;
      case 'pave':
        if (alt) {
          this.sim.paintPave(x, z, r, 0, 0, s, h);
        } else {
          this.sim.paintPave(x, z, r, 235, Number(el<HTMLSelectElement>('pave').value), s, h);
        }
        break;
      case 'road':
        this.pushRoad(x, z, alt);
        break;
      case 'scatter':
        this.sim.scatter(this.scatterGroup, x, z, r, s, this.scatterSeed(x, z));
        break;
      case 'erase':
        this.sim.eraseStructures(x, z, r, true, true);
        break;
      case 'place': {
        // Checked: an occupied or waterlogged spot is refused rather than written over, and the
        // ghost has been saying so all along.
        const block = this.sim.placeChecked(this.kind, this.team, x, z, this.yaw, this.snapping());
        this.selectNote = block === 0 ? '' : BLOCK_TEXT[block] ?? 'cannot place there';
        this.flash(block === 0 ? '' : `cannot place: ${this.selectNote}`);
        break;
      }
      case 'select':
        this.selectAt(x, z);
        break;
      case 'copy':
        this.copyOrPaste(x, z, first);
        break;
      case 'movebase':
      case 'placebase': {
        // Only the two playing teams own a base. Neutral is a scenery team, and mapping it onto
        // green — which is what `team % 2` did — silently moved the *player's* base instead.
        if (this.team > 1) {
          this.flash('only green and brown can own a main base');
          break;
        }
        // Moving is a different operation from stamping: a move clears the complex at the old
        // anchor first, and rebuilds both bases so their perimeters stay in step.
        if (this.tool === 'movebase') this.sim.moveBase(this.team, x, z, this.yaw);
        else this.sim.stampBase(this.team, x, z, this.yaw);
        // A base stamp rewrites the ground over its whole footprint, far beyond the brush rect.
        this.dirtyFull = true;
        break;
      }
    }
    this.dirty = true;
    // Scenery and pavement do not move the ground, so only the tools that do need a rect.
    if (this.tool !== 'place' && this.tool !== 'scatter') this.markDirty(x, z, r);
  }

  /**
   * The scatter stroke's seed.
   *
   * Quantised from the dab's own position, so the same stroke lays the same props every time and a
   * second dab never reshuffles what the first one put down — the props already on the map are not
   * the seed's business, but the *placements* it asks for have to be stable.
   */
  private scatterSeed(x: number, z: number): number {
    const q = (((x * 8) | 0) * 73856093) ^ (((z * 8) | 0) * 19349663) ^ (this.strokeSeed >>> 0);
    return (q >>> 0) | 1;
  }

  /**
   * Select a structure, or put the one already held down here.
   *
   * The index is re-read every frame rather than cached: erasing something renumbers the list, and
   * a stale index would move the wrong building. That is also why a selection that no longer
   * resolves simply clears itself.
   */
  /** A catalogue kind's name, for the status line. */
  private kindName(kind: number): string {
    return this.sim.catalog.find((c) => c.kind === kind)?.name ?? `kind ${kind}`;
  }

  private selectAt(x: number, z: number): void {
    if (this.selected < 0) {
      const hit = this.sim.pick(x, z);
      if (hit < 0) {
        this.flash('nothing under the cursor');
        return;
      }
      this.selected = hit;
      const s = this.sim.structureAt(hit);
      this.flash(`selected ${s ? this.kindName(s[6]) : 'structure'} — click to move, R/T to turn, delete to erase`);
      this.dirty = true;
      return;
    }
    const held = this.sim.structureAt(this.selected);
    if (!held) {
      this.selected = -1;
      return;
    }
    const block = this.sim.moveStructure(this.selected, x, z, held[2]);
    this.selectNote = block === 0 ? '' : BLOCK_TEXT[block] ?? 'cannot move there';
    this.flash(block === 0 ? '' : `cannot move: ${this.selectNote}`);
    this.dirty = true;
  }

  /** Turn the selected structure a quarter turn: `R`/`T` are wired to this while selecting. */
  private turnSelected(quarter: number): void {
    if (this.selected < 0) return;
    const block = this.sim.rotateStructure(this.selected, quarter);
    this.selectNote = block === 0 ? '' : BLOCK_TEXT[block] ?? 'cannot turn it here';
    this.flash(block === 0 ? '' : `cannot turn: ${this.selectNote}`);
    this.dirty = true;
  }

  /** Delete whatever the select tool has hold of. */
  private eraseSelected(): void {
    if (this.selected < 0) return;
    const s = this.sim.structureAt(this.selected);
    if (!s) {
      this.selected = -1;
      return;
    }
    this.sim.beginStroke('erase');
    this.sim.eraseStructures(s[0], s[1], 0.6, false, true);
    this.sim.endStroke();
    this.selected = -1;
    this.dirty = true;
    this.flash('erased');
  }

  /**
   * The copy tool: drag a rectangle to take a copy, click to put it down.
   *
   * A drag is a rectangle; a click (no drag) stamps whatever was copied last, which is the rhythm
   * people already have from every other editor — mark it, then stamp it as often as you like. The
   * clipboard lives on the Rust side because it is layer bytes and a structure list.
   */
  private copyOrPaste(x: number, z: number, first: boolean): void {
    if (first) {
      if (this.copyDrag) return;
      const n = this.sim.pasteRect(x, z);
      this.flash(n > 0 ? `pasted ${n} structure${n === 1 ? '' : 's'}` : 'nothing to paste');
      this.dirty = true;
      // The clipboard's road and pavement can land anywhere in its extent, not under the cursor.
      this.dirtyFull = true;
      return;
    }
    const a = this.copyAnchor;
    if (!a) {
      this.copyAnchor = new THREE.Vector2(x, z);
      this.copyDrag = false;
      return;
    }
    // Past a couple of metres this is a rectangle, not a click.
    if (!this.copyDrag && Math.hypot(x - a.x, z - a.y) < 2.0) return;
    this.copyDrag = true;
    this.copyRect = { x0: a.x, z0: a.y, x1: x, z1: z };
    const w = Math.abs(x - a.x);
    const h = Math.abs(z - a.y);
    const y = this.terrain.heightAt((a.x + x) * 0.5, (a.y + z) * 0.5) + 0.2;
    this.band.position.set((a.x + x) * 0.5, y, (a.y + z) * 0.5);
    this.band.scale.set(Math.max(w, 0.1), 1, Math.max(h, 0.1));
    this.band.visible = true;
  }

  /** Finish a copy drag: take the rectangle, or fall back to a paste if it never became one. */
  private finishCopy(): void {
    const a = this.copyAnchor;
    this.copyAnchor = null;
    this.band.visible = false;
    if (!a) return;
    if (!this.copyDrag) {
      const n = this.sim.pasteRect(a.x, a.y);
      this.flash(n > 0 ? `pasted ${n} structure${n === 1 ? '' : 's'}` : 'nothing to paste');
      this.dirty = true;
      // The clipboard's road and pavement can land anywhere in its extent, not under the cursor.
      this.dirtyFull = true;
      return;
    }
    const r = this.copyRect;
    this.copyRect = null;
    this.copyDrag = false;
    if (!r) return;
    // Anchored where the drag started, so pasting puts that point back under the cursor.
    const n = this.sim.copyRect(r.x0, r.z0, r.x1, r.z1, a.x, a.y);
    this.flash(`copied ${n} structure${n === 1 ? '' : 's'} — click to paste`);
  }

  /** Shift held: free placement, no snapping. */
  private shift = false;

  /** Tools that place one thing where you click, rather than painting over a drag. */
  private placingTool(): boolean {
    return this.tool === 'place' || this.tool === 'movebase' || this.tool === 'placebase';
  }

  /** Tools that act once on the click that lands them, rather than over a drag. */
  private oneShotTool(): boolean {
    return this.placingTool() || this.tool === 'select' || this.tool === 'copy';
  }

  private snapping(): boolean {
    return el<HTMLInputElement>('snap').checked && !this.freePlace();
  }

  /**
   * Road segments, in the mode the toolbar asks for.
   *
   * The three modes are the three things a road network is actually made of: freehand for a track,
   * a single straight run, and the Manhattan staircase that the classic maps are built from. The
   * second and third are what "option to have straight mode / 90 degree turns" means, and they are
   * computed from the *stroke start*, so dragging left-then-down lays one L rather than a
   * staircase of every wobble the mouse made.
   */
  private pushRoad(x: number, z: number, alt: boolean): void {
    const half = this.roadWidth * 0.5;
    const pave = Number(el<HTMLSelectElement>('pave').value);
    if (this.roadMode === 'free') {
      this.roadPts.push(x, z);
      if (this.roadPts.length >= 4) this.sim.roadStroke(this.roadPts.slice(-4), half, pave, alt);
      return;
    }
    // Straight and 90-degree modes paint on release, from the stroke's anchor: re-stamping as the
    // cursor moves would leave the previous leg painted behind it when the drag changes side.
    this.roadPts = [this.roadAnchor.x, this.roadAnchor.y, x, z];
    this.updateRoadPreview();
  }

  /** The corner the 90-degree mode will take, so the preview shows the road that will be laid. */
  private roadPath(): number[] {
    if (this.roadPts.length < 4) return [];
    const [ax, az, bx, bz] = this.roadPts;
    if (this.roadMode === 'straight') return [ax, az, bx, bz];
    const dx = Math.abs(bx - ax);
    const dz = Math.abs(bz - az);
    return dx >= dz ? [ax, az, bx, az, bx, bz] : [ax, az, ax, bz, bx, bz];
  }

  private updateRoadPreview(): void {
    const path = this.roadPath();
    const show = path.length >= 4 && this.dragging === 'paint' && this.tool === 'road';
    this.roadPreview.visible = show;
    if (!show) return;
    while (this.roadPreview.children.length < path.length / 2 - 1) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.4, depthWrite: false }),
      );
      m.renderOrder = 5;
      this.roadPreview.add(m);
    }
    const w = this.roadWidth;
    for (let i = 0; i + 3 < path.length; i += 2) {
      const seg = this.roadPreview.children[i / 2] as THREE.Mesh;
      const ax = path[i] as number;
      const az = path[i + 1] as number;
      const bx = path[i + 2] as number;
      const bz = path[i + 3] as number;
      const len = Math.hypot(bx - ax, bz - az);
      const y = this.terrain.heightAt((ax + bx) * 0.5, (az + bz) * 0.5) + 0.35;
      seg.position.set((ax + bx) * 0.5, y, (az + bz) * 0.5);
      seg.rotation.y = -Math.atan2(bz - az, bx - ax);
      seg.scale.set(Math.max(len, 0.1), 1, w);
      seg.visible = true;
    }
    for (let i = path.length / 2 - 1; i < this.roadPreview.children.length; i++) {
      (this.roadPreview.children[i] as THREE.Mesh).visible = false;
    }
  }

  /**
   * Shift is free placement: while it is held, nothing snaps — walls included.
   *
   * Walls snap to the walls beside them, which is what makes a run come out joined, but it also
   * means the last few centimetres before a joint are a fight. Holding shift drops a piece exactly
   * where the cursor is, at whatever angle it is turned to, and the ghost shows the same thing the
   * click will do.
   */
  private freePlace(): boolean {
    return this.shift;
  }

  private beginStroke(x: number, z: number): void {
    this.sim.beginStroke(this.tool);
    // One seed per stroke, so a stroke is reproducible and the *next* stroke scatters afresh.
    this.strokeSeed = (this.strokeSeed * 1664525 + 1013904223) >>> 0;
    this.roadPts.length = 0;
    this.roadAnchor.set(x, z);
  }

  private endStroke(alt: boolean): void {
    // The straight and 90-degree road modes only touch the map now, once, as one undo step.
    if (this.tool === 'road' && this.roadMode !== 'free' && this.roadPts.length >= 4) {
      this.sim.roadStroke(
        this.roadPath(),
        this.roadWidth * 0.5,
        Number(el<HTMLSelectElement>('pave').value),
        alt,
      );
      this.dirty = true;
    }
    this.roadPreview.visible = false;
    this.sim.endStroke();
    this.rebuildStructures();
    this.syncUi();
    this.lastPaint.set(-1e9, -1e9);
  }

  attach(): void {
    const canvas = this.gs.renderer.domElement;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 0) {
        if (!this.pick()) return;
        this.dragging = 'paint';
        this.beginStroke(this.ground.x, this.ground.z);
        this.dab(this.ground.x, this.ground.z, true, e.altKey);
        this.lastPaint.set(this.ground.x, this.ground.z);
        // One-shot tools finish on the click; the brushes keep painting while the button is held.
        if (this.oneShotTool()) {
          this.endStroke(e.altKey);
        }
      } else {
        this.dragging = 'pan';
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      canvas.releasePointerCapture(e.pointerId);
      if (this.dragging === 'paint') {
        if (this.tool === 'copy') this.finishCopy();
        else this.endStroke(e.altKey);
      }
      this.dragging = 'none';
    });
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.pointer.set(e.clientX - rect.left, e.clientY - rect.top);
      this.ndc.set((this.pointer.x / rect.width) * 2 - 1, -(this.pointer.y / rect.height) * 2 + 1);
      if (this.dragging === 'pan') {
        // Pan in the camera's own ground plane, so a drag always moves the map with the cursor.
        const k = (this.rig.zoom * 42) / rect.height;
        const yaw = this.heading;
        const dx = -e.movementX * k;
        const dz = -e.movementY * k;
        this.focus.x += dx * Math.cos(yaw) - dz * Math.sin(yaw);
        this.focus.z += dx * Math.sin(yaw) + dz * Math.cos(yaw);
        return;
      }
      if (!this.pick()) return;
      if (this.dragging === 'paint') {
        const moved = Math.hypot(this.ground.x - this.lastPaint.x, this.ground.z - this.lastPaint.y);
        if (this.tool === 'road') {
          this.pushRoad(this.ground.x, this.ground.z, e.altKey);
        } else if (this.tool === 'copy') {
          this.copyOrPaste(this.ground.x, this.ground.z, false);
        } else if (!this.oneShotTool()) {
          if (moved > this.brush.radius * 0.12) {
            this.dab(this.ground.x, this.ground.z, false, e.altKey);
            this.lastPaint.set(this.ground.x, this.ground.z);
          }
        }
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        this.brush.radius = THREE.MathUtils.clamp(this.brush.radius * (e.deltaY > 0 ? 1.12 : 0.89), 4, 120);
        this.syncBrushUi();
      } else {
        this.rig.zoomBy(e.deltaY > 0 ? 1 : -1);
      }
    }, { passive: false });

    // Shift is free placement, so it has to be tracked as a modifier rather than a shortcut: it
    // changes what every placement does for as long as it is down, ghost included.
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.shift = false;
    });
    window.addEventListener('blur', () => {
      this.shift = false;
    });
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Shift') this.shift = true;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            if (this.sim.redo()) this.afterHistory();
          } else if (this.sim.undo()) this.afterHistory();
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          this.saveFile();
        }
        return;
      }
      if (SHORTCUTS[e.key]) this.setTool(SHORTCUTS[e.key]);
      if (e.key === '[') {
        this.brush.radius = Math.max(4, this.brush.radius - 2);
        this.syncBrushUi();
      }
      if (e.key === ']') {
        this.brush.radius = Math.min(120, this.brush.radius + 2);
        this.syncBrushUi();
      }
      if (e.key === 'q') {
        this.heading -= 0.12;
        this.rig.setYaw(this.heading);
      }
      if (e.key === 'e') {
        this.heading += 0.12;
        this.rig.setYaw(this.heading);
      }
      // Structures turn in 90 degree steps: a building's footprint is a rectangle, so the four
      // orientations are the ones that matter.
      // R/T turn what is about to be placed, or what the select tool is holding.
      if (e.key === 'r') {
        if (this.tool === 'select') this.turnSelected(1);
        else this.yaw += Math.PI / 2;
      }
      if (e.key === 't') {
        if (this.tool === 'select') this.turnSelected(-1);
        else this.yaw -= Math.PI / 2;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.tool === 'select') {
          e.preventDefault();
          this.eraseSelected();
        }
      }
      if (e.key === 'm') this.toggleMinimapNav();
      if (e.key === 'Escape' && this.tool === 'select' && this.selected >= 0) {
        this.selected = -1;
        this.flash('');
        this.dirty = true;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.rig.setMode(this.rig.mode === 'fixed' ? 'tilt' : 'fixed');
      }
      if (e.key === 'Delete' && this.pick()) {
        this.sim.beginStroke('clear');
        this.sim.eraseStructures(this.ground.x, this.ground.z, this.brush.radius, true, true);
        this.sim.endStroke();
        this.rebuildStructures();
        this.dirty = true;
        // This erase has no `markDirty` of its own, so a pending rect cannot be trusted to cover it.
        this.dirtyFull = true;
      }
    });
  }

  private afterHistory(): void {
    this.sim.refresh();
    this.dirty = true;
    // An undo or redo can touch anywhere on the map; never trust a pending rect for it.
    this.dirtyFull = true;
    this.rebuildStructures();
    this.syncUi();
  }

  private syncBrushUi(): void {
    el('osize').textContent = `${Math.round(this.brush.radius)} m`;
    el<HTMLInputElement>('bsize').value = String(Math.round(this.brush.radius));
  }

  setTool(t: Tool): void {
    const wasScene = this.tool === 'scatter';
    this.tool = t;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#toolgrid button')) {
      b.classList.toggle('on', b.dataset.tool === t);
    }
    el('coord').textContent = TOOLS.find((x) => x.id === t)?.hint ?? '';
    // The palette is whatever this tool paints with: buildings for `place`, scenery for `scatter`.
    // Rebuilding on the change rather than showing both keeps the swatch you click meaning one
    // thing — the same reason the team buttons sit next to it.
    if (wasScene !== (t === 'scatter')) this.buildPalette();
    this.markSwatch();
    // A selection only means something to the select tool.
    if (t !== 'select' && this.selected >= 0) {
      this.selected = -1;
      this.flash('');
    }
    this.updateUiNotes();
  }

  /** Whatever the bottom bar should say about the current tool. */
  private updateUiNotes(): void {
    const clip = el('clipnote');
    if (clip) clip.textContent = this.sim.hasClip() ? 'clipboard: ready to paste' : 'clipboard: empty';
    const sel = el('selnote');
    if (sel) {
      const s = this.selected >= 0 ? this.sim.structureAt(this.selected) : null;
      sel.textContent = s ? `selected: ${this.kindName(s[6])}` : '';
    }
  }

  /**
   * The palette: the structures to build, or the scenery to scatter.
   *
   * Scenery is a *group* rather than a kind — a vegetation dab should mix palms, bushes and tufts,
   * not tile one prop — so the buttons pick a group and the brush does the mixing.
   */
  private buildPalette(): void {
    const palette = el('palette');
    palette.replaceChildren();
    const title = el('palettetitle');
    if (this.tool === 'scatter') {
      title.textContent = 'Scenery';
      const names = this.sim.scatterNames();
      names.forEach((name, i) => {
        const b = document.createElement('button');
        b.textContent = name;
        b.title = `scatter ${name}`;
        b.dataset.scatter = String(i);
        b.onclick = () => {
          this.scatterGroup = i;
          for (const other of palette.querySelectorAll<HTMLButtonElement>('button')) {
            other.classList.toggle('on', other === b);
          }
        };
        palette.appendChild(b);
        if (i === this.scatterGroup) b.classList.add('on');
      });
      return;
    }
    title.textContent = `Structures — ${['green', 'brown', 'neutral'][this.team] ?? 'green'}`;
    for (const c of this.sim.catalog) {
      const b = document.createElement('button');
      b.textContent = `${c.name}`;
      b.title = `${c.name}: ${c.w} x ${c.d} m`;
      b.dataset.kind = String(c.kind);
      b.onclick = () => {
        this.kind = c.kind;
        for (const other of palette.querySelectorAll<HTMLButtonElement>('button')) {
          other.classList.toggle('on', other === b);
        }
        if (this.tool !== 'place') this.setTool('place');
      };
      palette.appendChild(b);
      if (c.kind === this.kind) b.classList.add('on');
    }
  }

  /**
   * The paint palette is the textures themselves.
   *
   * Each swatch is drawn straight out of the surface library, so what you click is what the brush
   * lays down — and clicking one picks both the channel and the variant, which is the pair the
   * ground shader actually blends.
   */
  private buildSwatches(): void {
    const wrap = el('swatches');
    const items: { key: MatKey; label: string; apply: () => void }[] = MATERIALS.map((m) => ({
      key: m.key as MatKey,
      label: m.label,
      apply: () => this.pickGround(m.family, m.variant, m.label),
    }));
    items.push(
      { key: 'paveTiles', label: 'slabs', apply: () => this.pickPave(1) },
      { key: 'paveStrip', label: 'strip', apply: () => this.pickPave(2) },
    );
    for (const it of items) {
      const b = document.createElement('button');
      b.title = it.label;
      b.dataset.key = it.key;
      const tex = this.lib.surfaces[it.key].map;
      const img = tex.image as { data: Uint8ClampedArray; width: number; height: number };
      const cv = document.createElement('canvas');
      cv.width = cv.height = 48;
      const ctx = cv.getContext('2d');
      const src = document.createElement('canvas');
      src.width = img.width;
      src.height = img.height;
      src.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      // One repeat of the material, scaled down: enough to read grain, colour and joints.
      ctx?.drawImage(src, 0, 0, 48, 48);
      const tag = document.createElement('span');
      tag.textContent = it.label;
      b.append(cv, tag);
      b.onclick = () => {
        it.apply();
        this.markSwatch();
      };
      wrap.appendChild(b);
    }
  }

  /// Selecting a swatch is selecting a *material*: the paint tool then lays exactly that.
  private pickGround(family: number, variant: number, label: string): void {
    this.material = { family, variant, label };
    this.setTool('paint');
    this.markSwatch();
  }

  private pickPave(shape: number): void {
    el<HTMLSelectElement>('pave').value = String(shape);
    this.setTool('pave');
    this.markSwatch();
  }

  /// Highlight the swatch the paint tool would lay down.
  private markSwatch(): void {
    const active =
      this.tool === 'paint'
        ? MATERIALS.find((m) => m.family === this.material.family && m.variant === this.material.variant)?.key
        : this.tool === 'pave' || this.tool === 'road'
          ? el<HTMLSelectElement>('pave').value === '1'
            ? 'paveTiles'
            : 'paveStrip'
          : undefined;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#swatches button')) {
      b.classList.toggle('on', b.dataset.key === active);
    }
  }

  /// The team a placement belongs to, shown where the palette is.
  private setTeam(team: number): void {
    this.team = team;
    // A base needs a *playing* team. Rather than refusing the click later, the tools say now that
    // neutral cannot own one.
    const baseTools = ['movebase', 'placebase'];
    for (const id of baseTools) {
      const b = document.querySelector<HTMLButtonElement>(`#toolgrid button[data-tool="${id}"]`);
      if (!b) continue;
      b.disabled = team > 1;
      b.title = team > 1 ? 'only green and brown can own a main base' : (TOOLS.find((t) => t.id === id)?.hint ?? '');
    }
    if (team > 1 && baseTools.includes(this.tool)) this.setTool('place');
    for (const b of document.querySelectorAll<HTMLButtonElement>('#teams button')) {
      b.classList.toggle('on', Number(b.dataset.team) === team);
    }
    const name = ['green (player)', 'brown (enemy)', 'neutral'][team] ?? 'neutral';
    if (this.tool !== 'scatter') el('palettetitle').textContent = `Structures — ${name}`;
  }

  buildUi(): void {
    this.buildSwatches();
    const grid = el('toolgrid');
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.dataset.tool = t.id;
      b.title = t.hint;
      b.onclick = () => this.setTool(t.id);
      grid.appendChild(b);
    }
    this.buildPalette();
    this.setTool('land');

    for (const b of document.querySelectorAll<HTMLButtonElement>('#teams button')) {
      b.onclick = () => this.setTeam(Number(b.dataset.team));
    }
    this.setTeam(this.team);

    el('navtoggle').onclick = () => {
      this.toggleMinimapNav();
      el('navtoggle').classList.toggle('on', this.minimapNav);
    };
    el('fliptoggle').onclick = () => {
      const on = this.minimap?.toggleFlip() ?? false;
      el('fliptoggle').classList.toggle('on', on);
      this.dirty = true;
      this.minimapRevision = -1;
    };

    const roadw = el<HTMLInputElement>('roadw');
    roadw.oninput = () => {
      this.roadWidth = Number(roadw.value);
      el('oroadw').textContent = `${roadw.value} m`;
    };
    const roadmode = el<HTMLSelectElement>('roadmode');
    roadmode.onchange = () => {
      this.roadMode = roadmode.value as 'free' | 'straight' | 'right';
    };

    const size = el<HTMLInputElement>('bsize');
    const strength = el<HTMLInputElement>('bstrength');
    const hard = el<HTMLInputElement>('bhard');
    size.oninput = () => {
      this.brush.radius = Number(size.value);
      el('osize').textContent = `${size.value} m`;
    };
    strength.oninput = () => {
      this.brush.strength = Number(strength.value);
      el('ostrength').textContent = strength.value;
    };
    hard.oninput = () => {
      this.brush.hard = Number(hard.value);
      el('ohard').textContent = hard.value;
    };
    el('osize').textContent = `${this.brush.radius} m`;
    el('ostrength').textContent = String(this.brush.strength);
    el('ohard').textContent = String(this.brush.hard);
    el<HTMLInputElement>('landh').oninput = (e) => {
      el('oland').textContent = `${(e.target as HTMLInputElement).value} m`;
    };

    el('undo').onclick = () => {
      if (this.sim.undo()) this.afterHistory();
    };
    el('redo').onclick = () => {
      if (this.sim.redo()) this.afterHistory();
    };
    el('new').onclick = async () => {
      const seed = Number(el<HTMLInputElement>('seed').value) | 0;
      this.sim.reseed(seed, 0);
      this.dirty = true;
      // A reseeded island is a brand-new map: nothing about a pending rect applies to it.
      this.dirtyFull = true;
      this.rebuildStructures();
      this.syncUi();
    };
    el('size').onchange = async () => {
      await this.reload(Number(el<HTMLSelectElement>('size').value), Number(el<HTMLSelectElement>('mode').value));
    };
    el('mode').onchange = async () => {
      await this.reload(Number(el<HTMLSelectElement>('size').value), Number(el<HTMLSelectElement>('mode').value));
    };
    el('save').onclick = () => this.saveFile();
    el('quick').onclick = () => {
      try {
        localStorage.setItem(QUICK_KEY, base64(this.sim.toBytes()));
        this.flash('quick saved');
      } catch (err) {
        this.flash(`quick save failed: ${String(err)}`);
      }
    };
    el('quickload').onclick = async () => {
      const raw = localStorage.getItem(QUICK_KEY);
      if (!raw) {
        this.flash('nothing quick saved yet');
        return;
      }
      await this.install(await EditorSim.fromBytes(fromBase64(raw)));
      this.dirty = true;
      this.dirtyFull = true; // a loaded map is not the one any pending rect was measured against
      this.flash('quick loaded');
    };
    el('load').onclick = () => el<HTMLInputElement>('file').click();
    el<HTMLInputElement>('file').onchange = async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      try {
        await this.install(await EditorSim.fromBytes(bytes));
        this.dirty = true;
        this.dirtyFull = true; // a loaded map is not the one any pending rect was measured against
        this.flash(`loaded ${f.name}`);
      } catch (err) {
        this.flash(`load failed: ${String(err)}`);
      }
    };
    el('play').onclick = () => {
      try {
        localStorage.setItem(PLAY_KEY, base64(this.sim.toBytes()));
      } catch (err) {
        this.flash(`too big for the browser store: ${String(err)}`);
        return;
      }
      location.href = `index.html?map=play&seed=${this.sim.seed()}`;
    };
  }

  private async reload(size: number, mode: number): Promise<void> {
    const seed = Number(el<HTMLInputElement>('seed').value) | 0;
    await this.install(await EditorSim.create(seed, 0, mode, size));
    this.dirty = true;
    this.dirtyFull = true; // a regenerated map is not the one any pending rect was measured against
  }

  private saveFile(): void {
    const bytes = this.sim.toBytes();
    const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.sim.map.name.toLowerCase().replace(/\s+/g, '-')}-${this.sim.seed()}.rfmap`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.flash(`saved ${(bytes.length / 1024).toFixed(0)} KiB`);
  }

  private flash(msg: string): void {
    const c = el('coord');
    const prev = c.textContent;
    c.textContent = msg;
    window.setTimeout(() => {
      c.textContent = prev;
    }, 2600);
  }

  /**
   * The placement ghost.
   *
   * It is drawn from `preview()` — the same call `place` builds from — so the model sits exactly
   * where the click will put it, wall snapping included, and turns with `R`/`T`. The tint says
   * whether the spot is usable: on the map, on dry ground.
   */
  private updateGhost(): void {
    const want = this.overMap && this.placingTool();
    if (!want) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    const kind = this.tool === 'place' ? this.kind : -1;
    const isBase = this.tool !== 'place';
    if (!this.ghost || this.ghostKind !== kind || this.ghostTeam !== this.team || isBase !== this.ghostBase) {
      if (this.ghost) this.structures.group.remove(this.ghost);
      this.ghost = null;
      if (!isBase) {
        this.ghost = this.structures.ghost(kind, this.team, true);
        this.structures.group.add(this.ghost);
      }
      this.ghostKind = kind;
      this.ghostTeam = this.team;
      this.ghostBase = isBase;
    }
    if (isBase) {
      // A base is a blueprint rather than one model, so its preview is the ring it will occupy.
      this.baseRing.visible = true;
      this.baseRing.position.set(this.ground.x, this.ground.y + 0.25, this.ground.z);
      this.baseRing.rotation.y = -this.yaw;
      return;
    }
    this.baseRing.visible = false;
    if (!this.ghost) return;
    const [px, pz, pyaw] = this.sim.preview(kind, this.ground.x, this.ground.z, this.yaw, this.snapping());
    const spec = this.sim.catalog.find((c) => c.kind === kind);
    const y = this.terrain.heightAt(px, pz);
    this.ghost.visible = true;
    this.ghost.position.set(px, y, pz);
    this.ghost.rotation.y = -pyaw;
    if (spec) this.ghost.scale.set(spec.w, spec.h, spec.d);
    // The tint is the *placement rule*, not a bounds test: this is the same call the click makes,
    // so a green ghost is a spot the click will accept.
    const [block] = this.sim.canPlace(kind, px, pz, pyaw);
    this.ghostNote = block === 0 ? '' : BLOCK_TEXT[block] ?? 'cannot place there';
    this.ghost.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (m && 'color' in m) m.color.setHex(block === 0 ? 0x9fe07a : 0xe07a5a);
    });
  }

  /**
   * Accumulate the area an op touched, for the frame's terrain refresh.
   *
   * A refresh walks the mesh and repacks the ground textures, so doing it over the whole map after
   * every dab is 48 ms at `?size=big` — the difference between painting and watching it paint.
   * Unioning a frame's dabs into one rectangle keeps a stroke's cost proportional to the brush.
   */
  private markDirty(x: number, z: number, radius: number): void {
    const r = radius + 2;
    const next: GroundRect = { x0: x - r, z0: z - r, x1: x + r, z1: z + r };
    const d = this.dirtyRect;
    this.dirtyRect = d
      ? {
          x0: Math.min(d.x0, next.x0),
          z0: Math.min(d.z0, next.z0),
          x1: Math.max(d.x1, next.x1),
          z1: Math.max(d.z1, next.z1),
        }
      : next;
  }

  /** The rectangle a brush of this radius at (x, z) touches — what the harness measures with. */
  brushRect(x: number, z: number): GroundRect {
    const r = this.brush.radius + 2;
    return { x0: x - r, z0: z - r, x1: x + r, z1: z + r };
  }

  /**
   * The corner overview: the ground is redrawn only when the map changes, the camera every frame.
   *
   * The camera's ground footprint is derived from the rig's own numbers rather than guessed: the
   * distance the camera sits back and the field of view give the size of the frame where it meets
   * the ground, and the heading turns it.
   */
  private drawMinimap(): void {
    const mm = this.minimap;
    if (!mm || !mm.canvas.isConnected) return;
    if (this.minimapRevision !== this.sim.revision) {
      mm.refresh(this.sim.map);
      this.minimapRevision = this.sim.revision;
      this.updateUiNotes();
    }
    // Camera → focus distance, then the frame that projects onto the ground: half the field of
    // view at that distance, divided by the sine of the tilt, because a tilted camera's footprint
    // is longer than the perpendicular one.
    const dist = BASE_DISTANCE * this.rig.zoom;
    const halfH = (dist * Math.tan((this.rig.camera.fov * Math.PI) / 360)) / Math.max(0.3, Math.sin(this.rig.elevation));
    const halfW = halfH * (window.innerWidth / Math.max(1, window.innerHeight));
    mm.draw(this.sim.map, {
      x: this.focus.x,
      z: this.focus.z,
      halfW,
      halfH,
      heading: this.heading,
      cursorX: this.ground.x,
      cursorZ: this.ground.z,
    });
  }

  /** One frame: camera, terrain refresh, brush cursor, render. */
  frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.dirty) {
      // A structural edit renumbers what the scene draws, and a base stamp or a paste moves more
      // than any rectangle knows about: those get the full pass. Everything else is a rect.
      const rect = this.dirtyFull ? null : this.dirtyRect;
      this.sim.refresh();
      this.terrain.updateFromMap(this.sim.map, rect ?? undefined);
      this.dirty = false;
      this.dirtyRect = null;
      this.dirtyFull = false;
    }
    this.focus.y = this.terrain.heightAt(this.focus.x, this.focus.z);
    // The rig's last argument is a *distance* multiplier (`dist = BASE * zoom * focus`): passing
    // zero parks the camera on the ground, which looks like a bug in the sky shader.
    this.rig.update(dt, this.focus, this.heading, 0, 1);
    if (this.overMap && !this.placingTool()) {
      this.ring.visible = true;
      this.ring.position.set(this.ground.x, this.ground.y + 0.3, this.ground.z);
      this.ring.scale.setScalar(this.brush.radius);
    } else {
      this.ring.visible = false;
    }
    this.updateGhost();
    el('coord').textContent =
      `${this.sim.map.name} · ${Math.round(this.ground.x)}, ${Math.round(this.ground.z)} m · ` +
      `${TOOLS.find((t) => t.id === this.tool)?.hint ?? ''}` +
      // The ghost's own verdict, in words: the tint is small and the reason is worth reading.
      (this.ghostNote ? ` · cannot place here: ${this.ghostNote}` : '');
    this.drawMinimap();
    this.gs.render();
    requestAnimationFrame(() => this.frame());
  }
}

async function boot(): Promise<void> {
  // The editor mounts a renderer, a wasm module and a DOM panel: a second boot would leave two of
  // everything, and the visible symptom is one canvas showing through another.
  if ((window as unknown as { rfReady?: boolean }).rfReady) return;
  const params = new URLSearchParams(location.search);
  // Size the renderer to the window before anything is built, and keep it there: the game does
  // the same from its own resize handler.
  const onResize = (): void => app.gs.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  const seed = Number(params.get('seed') ?? 7) | 0;
  const index = Number(params.get('map') ?? 0) | 0;
  const mode = params.get('mode') === 'mirror' ? 1 : 0;
  const size = params.get('size') === 'big' ? 2 : params.get('size') === 'medium' ? 1 : 0;
  const canvas = el<HTMLCanvasElement>('view');
  const app = new EditorApp(canvas);
  onResize();
  await warmupLibrary(app['lib'] as SurfaceLibrary).catch(() => undefined);
  const sim = await EditorSim.create(seed, index, mode, size);
  await app['install'](sim);
  app.buildUi();
  app.attach();
  el('boot').classList.add('gone');
  (window as unknown as { rfEditor: EditorApp }).rfEditor = app;
  (window as unknown as { rfReady: boolean }).rfReady = true;
  app.frame();
}

void boot();
