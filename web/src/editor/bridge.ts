/**
 * Editor bridge: the wasm map editor behind the same pointer-and-view pattern the game uses.
 *
 * Two things differ from `Sim` and are worth knowing here:
 *
 * * **The map is writable.** Layers are read through views into wasm memory, so the scene has to
 *   re-read them after an edit rather than holding copies. `heights` is a live view (the terrain
 *   reads it every frame anyway); the ground *masks* are copied into fresh arrays on `refresh()`
 *   because a `DataTexture` keeps its array and wasm memory can grow underneath a view.
 * * **There is no simulation.** No vehicles, no projectiles, no flow fields: an edit is a change
 *   to the map plus a nav rebuild, and everything else the renderer needs it reads straight from
 *   the layers.
 */
import init, { Editor } from '../sim/pkg/rf_core.js';
import { S, STRIDE, type StructureView } from '../sim/layout.js';

export interface EditorMapBuffers {
  name: string;
  worldSize: number;
  grid: number;
  cell: number;
  waterLevel: number;
  /** Live view: (grid+1)^2 heights, metres. */
  heights: Float32Array;
  /** Owned copies, refreshed by `refresh()`. */
  splat: Uint8Array;
  road: Uint8Array;
  sandVar: Uint8Array;
  grassVar: Uint8Array;
  pave: Uint8Array;
  nav: Uint8Array;
  /** Live view of the structure records. */
  structures: Float32Array;
}

export interface CatalogEntry {
  kind: number;
  name: string;
  w: number;
  d: number;
  h: number;
}

export class EditorSim {
  readonly ed: Editor;
  readonly catalog: CatalogEntry[];
  readonly map: EditorMapBuffers;
  private memory: WebAssembly.Memory;
  private buffer: ArrayBufferLike;
  private f32 = new Float32Array(0);
  private u8 = new Uint8Array(0);
  /** Reused structure views, so a rebuild allocates nothing. */
  private structPool: StructureView[] = [];
  private ptrs = {
    heights: 0,
    splat: 0,
    road: 0,
    sandVar: 0,
    grassVar: 0,
    pave: 0,
    nav: 0,
    structs: 0,
  };
  /** Bumped on every refresh: the scene's cheap "has the map changed" test. */
  revision = 0;
  /** Live views, re-derived whenever wasm memory moves (see `sync`). */
  private heightsView = new Float32Array(0);
  private structsView = new Float32Array(0);

  private constructor(ed: Editor, memory: WebAssembly.Memory) {
    this.ed = ed;
    this.memory = memory;
    this.buffer = memory.buffer;
    this.f32 = new Float32Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
    this.catalog = JSON.parse(Editor.catalog_json()) as CatalogEntry[];
    const self = this;
    this.map = {
      name: ed.map_name(),
      worldSize: ed.world_size(),
      grid: ed.grid(),
      cell: ed.cell(),
      waterLevel: ed.water_level(),
      splat: new Uint8Array(0),
      road: new Uint8Array(0),
      sandVar: new Uint8Array(0),
      grassVar: new Uint8Array(0),
      pave: new Uint8Array(0),
      nav: new Uint8Array(0),
      // The two *live* views are getters, and that is load-bearing: any wasm call can grow linear
      // memory, which detaches every view into it. Saving a map does exactly that (a `.rfmap` is
      // a megabyte), and the next brush stroke then read `NaN` heights — the ray march fell
      // through the terrain on its first sample and the brush painted where the camera was
      // standing instead of under the cursor. A getter that re-derives on the way out cannot be
      // forgotten by a caller.
      get heights() {
        self.sync();
        return self.heightsView;
      },
      get structures() {
        self.sync();
        return self.structsView;
      },
    } as EditorMapBuffers;
    this.refresh();
  }

  static async create(seed: number, index: number, mode: number, size: number): Promise<EditorSim> {
    const out = await init();
    return new EditorSim(new Editor(seed, index, mode, size), out.memory);
  }

  static async fromBytes(bytes: Uint8Array): Promise<EditorSim> {
    const out = await init();
    return new EditorSim(Editor.fromBytes(bytes), out.memory);
  }

  /**
   * Re-derive views if wasm memory has moved.
   *
   * Growth detaches every `ArrayBuffer` view into linear memory (their `length` becomes 0 and
   * reads give nothing), so this has to run before *any* read of the map — which is why the live
   * views are getters rather than fields.
   */
  private sync(): void {
    if (this.memory.buffer === this.buffer) return;
    this.buffer = this.memory.buffer;
    this.f32 = new Float32Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
    this.deriveViews();
  }

  private deriveViews(): void {
    if (!this.map || !this.ptrs.heights) return;
    const verts = (this.map.grid + 1) * (this.map.grid + 1);
    this.heightsView = this.f32.subarray(this.ptrs.heights >> 2, (this.ptrs.heights >> 2) + verts);
    const n = this.ed.structure_count() * STRIDE.structure;
    this.structsView = this.f32.subarray(this.ptrs.structs >> 2, (this.ptrs.structs >> 2) + n);
  }

  /** Re-read the map: pointers, live views, the mask copies, and the header fields. */
  refresh(): void {
    this.sync();
    const ed = this.ed;
    const grid = ed.grid();
    const verts = (grid + 1) * (grid + 1);
    this.ptrs = {
      heights: ed.heights_ptr(),
      splat: ed.splat_ptr(),
      road: ed.road_ptr(),
      sandVar: ed.sand_var_ptr(),
      grassVar: ed.grass_var_ptr(),
      pave: ed.pave_ptr(),
      nav: ed.nav_ptr(),
      structs: ed.structures_ptr(),
    };
    const m = this.map;
    m.name = ed.map_name();
    m.worldSize = ed.world_size();
    m.grid = grid;
    m.cell = ed.cell();
    m.waterLevel = ed.water_level();
    this.deriveViews();
    const at = (ptr: number, len: number): Uint8Array => this.u8.subarray(ptr, ptr + len);
    // Copied, not aliased: a `DataTexture` holds the array for the material's lifetime, and a
    // view into wasm memory is detached by the next growth.
    m.splat = at(this.ptrs.splat, verts * 4).slice();
    m.road = at(this.ptrs.road, verts).slice();
    m.sandVar = at(this.ptrs.sandVar, verts).slice();
    m.grassVar = at(this.ptrs.grassVar, verts).slice();
    m.pave = at(this.ptrs.pave, verts).slice();
    m.nav = at(this.ptrs.nav, grid * grid).slice();
    this.revision++;
  }

  /** Bytes of the `.rfmap` for the current map. */
  toBytes(): Uint8Array {
    return this.ed.toBytes();
  }

  structureCount(): number {
    return this.ed.structure_count();
  }

  structure(i: number, out: StructureView): StructureView {
    const b = this.map.structures;
    const o = i * STRIDE.structure;
    out.x = b[o + S.X];
    out.y = b[o + S.Y];
    out.z = b[o + S.Z];
    out.yaw = b[o + S.YAW];
    out.w = b[o + S.W];
    out.d = b[o + S.D];
    out.h = b[o + S.H];
    out.kind = b[o + S.KIND];
    out.team = b[o + S.TEAM];
    out.hp = b[o + S.HP];
    out.flags = b[o + S.FLAGS];
    return out;
  }

  /** Structure views, reused across calls (call after `refresh`). */
  structures(): StructureView[] {
    const n = this.structureCount();
    while (this.structPool.length < n) this.structPool.push({} as StructureView);
    for (let i = 0; i < n; i++) this.structure(i, this.structPool[i]);
    return this.structPool;
  }

  // -- history ----------------------------------------------------------

  beginStroke(label: string): void {
    this.ed.beginStroke(label);
  }
  endStroke(): void {
    this.ed.endStroke();
    this.refresh();
  }
  undo(): boolean {
    const ok = this.ed.undo();
    this.refresh();
    return ok;
  }
  redo(): boolean {
    const ok = this.ed.redo();
    this.refresh();
    return ok;
  }
  canUndo(): boolean {
    return this.ed.canUndo();
  }
  canRedo(): boolean {
    return this.ed.canRedo();
  }
  historyLen(): number {
    return this.ed.historyLen();
  }
  undoLabel(): string {
    return this.ed.undoLabel();
  }
  redoLabel(): string {
    return this.ed.redoLabel();
  }

  // -- ops ---------------------------------------------------------------

  raise(x: number, z: number, r: number, amount: number, hard: number): void {
    this.ed.raise(x, z, r, amount, hard);
  }
  level(x: number, z: number, r: number, target: number, amount: number, hard: number): void {
    this.ed.level(x, z, r, target, amount, hard);
  }
  smooth(x: number, z: number, r: number, amount: number, hard: number): void {
    this.ed.smooth(x, z, r, amount, hard);
  }
  paintSplat(channel: number, x: number, z: number, r: number, amount: number, hard: number): void {
    this.ed.paintSplat(channel, x, z, r, amount, hard);
  }
  /** Paint a whole material: family 0 sand, 1 grass, 2 dirt, 3 rock (+ the ramp variant). */
  paintMaterial(family: number, variant: number, x: number, z: number, r: number, amount: number, hard: number): void {
    this.ed.paintMaterial(family, variant, x, z, r, amount, hard);
  }
  paintVariant(family: number, variant: number, x: number, z: number, r: number, amount: number, hard: number): void {
    this.ed.paintVariant(family, variant, x, z, r, amount, hard);
  }
  paintPave(x: number, z: number, r: number, level: number, pave: number, amount: number, hard: number): void {
    this.ed.paintPave(x, z, r, level, pave, amount, hard);
  }
  roadStroke(pts: number[], halfWidth: number, pave: number, erase: boolean): void {
    this.ed.roadStroke(new Float32Array(pts), halfWidth, pave, erase);
  }
  place(kind: number, team: number, x: number, z: number, yaw: number, snap: boolean): boolean {
    return this.ed.place(kind, team, x, z, yaw, snap);
  }
  /** Where a placement would land after snapping: `[x, z, yaw]`. */
  /** Scatter scenery through the brush: returns how many props landed. */
  scatter(group: number, x: number, z: number, radius: number, density: number, seed: number): number {
    return this.ed.scatter(group, x, z, radius, density, seed >>> 0);
  }

  /** The scatter groups the palette offers. */
  scatterNames(): string[] {
    return JSON.parse(this.ed.scatterNames()) as string[];
  }

  /**
   * Can a structure stand here? `[block, seat height]`, where block 0 means yes.
   *
   * The ghost's tint and a checked placement read the same answer, so the colour cannot promise a
   * spot the click will refuse.
   */
  canPlace(kind: number, x: number, z: number, yaw: number): [number, number] {
    const v = this.ed.canPlace(kind, x, z, yaw);
    return [v[0] as number, v[1] as number];
  }

  /** Place only if the spot is good: 0 on success, otherwise the block reason. */
  placeChecked(kind: number, team: number, x: number, z: number, yaw: number, snap: boolean): number {
    return this.ed.placeChecked(kind, team, x, z, yaw, snap);
  }

  /** A team's base anchor, as `[x, z]`. */
  baseAt(team: number): [number, number] {
    const v = this.ed.basePos(team);
    return [v[0] as number, v[1] as number];
  }

  teamCanOwnBase(team: number): boolean {
    // A static on the wasm side: it is a property of the rules, not of the map.
    return Editor.teamCanOwnBase(team);
  }

  /** The structure under a point, or -1. */
  pick(x: number, z: number): number {
    return this.ed.pick(x, z);
  }

  /** One structure's `[x, z, yaw, w, d, h, kind, team]`, or `null` for a stale index. */
  structureAt(index: number): [number, number, number, number, number, number, number, number] | null {
    const v = this.ed.structureAt(index);
    return v.length === 8
      ? ([v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]] as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ])
      : null;
  }

  /** Move a structure: 0 on success, otherwise why not. */
  moveStructure(index: number, x: number, z: number, yaw: number): number {
    return this.ed.moveStructure(index, x, z, yaw);
  }

  /**
   * Move a team's base: clear the complex at the old anchor, then build the same blueprint at the
   * new one, rebuilding both bases so their perimeters stay in step. One undo step.
   */
  moveBase(team: number, x: number, z: number, yaw: number): void {
    this.ed.moveBase(team, x, z, yaw);
  }

  /** Turn a structure a quarter turn in place: 0 on success. */
  rotateStructure(index: number, quarter: number): number {
    return this.ed.rotateStructure(index, quarter);
  }

  /**
   * Copy a rectangle of the map, anchored at the cursor: the point under `(cx, cz)` ends up under
   * the cursor again when it is pasted. Returns how many structures the clipboard carries.
   */
  copyRect(x0: number, z0: number, x1: number, z1: number, cx: number, cz: number): number {
    return this.ed.copyRect(x0, z0, x1, z1, cx, cz);
  }

  /** Debug: `[paved cells, first paved x, first paved z, its value]` in the clipboard. */
  clipInfo(): number[] {
    return Array.from(this.ed.clipInfo());
  }

  hasClip(): boolean {
    return this.ed.hasClip();
  }

  /** Paste with the clipboard's origin at (x, z): how many structures landed. */
  pasteRect(x: number, z: number): number {
    return this.ed.pasteRect(x, z);
  }

  preview(kind: number, x: number, z: number, yaw: number, snap: boolean): [number, number, number] {
    const p = this.ed.preview(kind, x, z, yaw, snap);
    return [p[0] as number, p[1] as number, p[2] as number];
  }
  /** Remove what the brush covers: pavement and/or structures. */
  eraseStructures(x: number, z: number, r: number, pavement: boolean, structures: boolean): number {
    return this.ed.erase(x, z, r, pavement, structures);
  }
  setBase(team: number, x: number, z: number, yaw: number): void {
    this.ed.setBase(team, x, z, yaw);
  }
  stampBase(team: number, x: number, z: number, yaw: number): void {
    this.ed.stampBase(team, x, z, yaw);
  }
  base(team: number): { x: number; z: number; yaw: number } {
    return { x: this.ed.base_x(team), z: this.ed.base_z(team), yaw: this.ed.base_yaw(team) };
  }
  validate(): string {
    return this.ed.validate();
  }
  reseed(seed: number, index: number): void {
    this.ed.reseed(seed, index);
    this.refresh();
  }
  seed(): number {
    return this.ed.seed();
  }
  mode(): number {
    return this.ed.mode();
  }
  sizeIndex(): number {
    return this.ed.size_index();
  }
}
