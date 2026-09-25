/**
 * Front-end overlays: title screen, garage / vehicle select, round-end, boot progress
 * and a corner toast.
 *
 * All wiring that the frozen `Menus` interface does not cover is exposed as window
 * events instead of interface changes:
 *   - `rf:settings`      { quality: 'low'|'medium'|'high', master: 0..1, music: 0..1,
 *                          cpu: 'easy'|'medium'|'hard', sandbox: boolean, allies: boolean }
 *                        dispatched on every settings interaction (the optional
 *                        `onSettings` callback, when supplied, is pinged as well);
 *   - `rf:garage-close`  when the player dismisses the garage with Esc. The game loop
 *                        owns the authoritative state — re-show the overlay if the
 *                        player must still pick.
 *
 * Everything is plain DOM + CSS, created once, and only text/class/style values are
 * touched afterwards.
 */
import './style.css';

import type { GarageState, Menus } from './types.js';
import { GLYPH, VEHICLE_NAME, VEHICLE_ROLE, silhouetteSvg } from './icons.js';
import { TEAM_COLORS } from '../assets/types.js';
import { VKIND } from '../sim/layout.js';

const hex6 = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

function lighten(n: number, t: number): string {
  const r = Math.round((n >> 16) & 255);
  const g = Math.round((n >> 8) & 255);
  const b = Math.round(n & 255);
  const m = (v: number): number => Math.round(v + (255 - v) * t);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

/**
 * Control cheat sheet. Kept in sync with the real input map in `src/main.ts`
 * (`buildInputs` / `handleGlobalKeys`): WASD or arrows drive, mouse aims, LMB/F and
 * RMB/Space fire, Q/E rotate the camera in every vehicle (including the helicopter),
 * Z/C strafe a helicopter, Shift brakes, Ctrl makes a helicopter climb, the wheel zooms,
 * Tab toggles the camera rig. Player two uses arrows/,/./[/] in split screen.
 * Respawn is not a key: dying or losing a round opens this garage, and 1-4 picks a bay.
 */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['W A S D', 'DRIVE / ARROWS'],
  ['MOUSE', 'AIM TURRET'],
  ['LMB / F', 'PRIMARY FIRE'],
  ['RMB / SPACE', 'SECONDARY'],
  ['Q / E', 'ROTATE CAMERA'],
  ['Z / C', 'STRAFE (HELI)'],
  ['SHIFT', 'BRAKE'],
  ['CTRL', 'ASCEND (HELI)'],
  ['WHEEL', 'ZOOM'],
  ['TAB', 'CAMERA MODE'],
  ['1 - 4', 'PICK VEHICLE'],
  ['ESC', 'PAUSE / GARAGE'],
  ['M', 'MUTE'],
];

const ROLES: ReadonlyArray<number> = [VKIND.JEEP, VKIND.TANK, VKIND.HRSV, VKIND.HELI];

const off = (el: HTMLElement, hidden: boolean): void => {
  el.classList.toggle('rf-off', hidden);
};

/**
 * The garage panel's readiness data lives in the simulation, so the card states have to be
 * re-read while the panel is open. `Menus` (hud/types.ts) has no refresh entry point and is
 * shared with the HUD, so the extra method is added by extension here rather than by
 * widening that interface.
 */
export interface MenusWithGarage extends Menus {
  /**
   * Re-read the garage state into the existing card nodes. Cheap and idempotent: it never
   * rebuilds the DOM, so it is safe to call every frame while the garage is open.
   */
  updateGarage(): void;
}

export function createMenus(container: HTMLElement): MenusWithGarage {
  const t0 = TEAM_COLORS[0];
  const t1 = TEAM_COLORS[1];

  const root = document.createElement('div');
  root.className = 'rf-menus';
  root.style.setProperty('--t0', hex6(t0));
  root.style.setProperty('--t0-hi', lighten(t0, 0.42));
  root.style.setProperty('--t1', hex6(t1));
  root.style.setProperty('--t1-hi', lighten(t1, 0.42));

  const keyRows = KEYS.map(
    ([k, lab]) => `<div class="rf-key"><span class="rf-kbd">${k}</span><span class="rf-key-lab">${lab}</span></div>`,
  ).join('');

  root.innerHTML = `
    <!-- ------------------------------------------------------------- title -->
    <div class="rf-modal rf-title rf-off">
      <div class="rf-hangar"><div class="rf-title-grid"></div><div class="rf-scan"></div></div>
      <div class="rf-panel rf-title-panel">
        <div class="rf-brand">
          <div class="rf-logo">RETURNED<em>FIRE</em></div>
          <div class="rf-brand-meta">
            <span class="rf-brand-sub">capture the flag</span>
            <span class="rf-brand-line"></span>
          </div>
        </div>
        <div class="rf-tabs">
          <button class="rf-tab-btn is-on" type="button" data-tab="main">MATCH</button>
          <button class="rf-tab-btn" type="button" data-tab="seed">SEED / RANDOM</button>
        </div>
        <div class="rf-tabpage" data-page="main">
        <div class="rf-title-cols">
          <div class="rf-col">
            <div class="rf-eyebrow">Deployment</div>
            <button class="rf-btn is-primary" type="button" data-act="sp">
              <span>SINGLE PLAYER<span class="rf-btn-sub">You against the enemy AI</span></span>
              <span class="rf-btn-k">ENTER</span>
            </button>
            <button class="rf-btn" type="button" data-act="2p">
              <span>TWO PLAYERS<span class="rf-btn-sub">Split screen, shared keyboard</span></span>
              <span class="rf-btn-k">F2</span>
            </button>
            <div class="rf-sec-title">Theatre</div>
            <div class="rf-mapcard">
              <div class="rf-mapcard-ico"></div>
              <div class="rf-mapcard-txt">
                <div class="rf-mapcard-name">—</div>
                <div class="rf-mapcard-idx rf-num">SECTOR 01 / 01</div>
              </div>
            </div>
            <div class="rf-seg" data-set="maps"></div>
            <div class="rf-sec-title">Generator</div>
            <div class="rf-seg" data-set="mode">
              <button class="rf-seg-btn is-on" type="button" data-mode="0">CLASSIC</button>
              <button class="rf-seg-btn" type="button" data-mode="1">MIRROR</button>
            </div>
            <div class="rf-seg" data-set="size">
              <button class="rf-seg-btn is-on" type="button" data-size="0">SMALL</button>
              <button class="rf-seg-btn" type="button" data-size="1">MEDIUM</button>
              <button class="rf-seg-btn" type="button" data-size="2">BIG</button>
            </div>
          </div>
          <div class="rf-col">
            <div class="rf-sec-title">Controls</div>
            <div class="rf-keys">${keyRows}</div>
            <div class="rf-set">
              <div class="rf-set-group">
                <span class="rf-set-lab">Quality</span>
                <div class="rf-seg" data-set="quality">
                  <button class="rf-seg-btn" type="button" data-q="low">LOW</button>
                  <button class="rf-seg-btn" type="button" data-q="medium">MEDIUM</button>
                  <button class="rf-seg-btn is-on" type="button" data-q="high">HIGH</button>
                </div>
              </div>
              <div class="rf-set-group">
                <span class="rf-set-lab">CPU Force</span>
                <div class="rf-seg" data-set="cpu">
                  <button class="rf-seg-btn" type="button" data-cpu="easy">EASY</button>
                  <button class="rf-seg-btn is-on" type="button" data-cpu="medium">MEDIUM</button>
                  <button class="rf-seg-btn" type="button" data-cpu="hard">HARD</button>
                </div>
              </div>
              <div class="rf-set-group">
                <span class="rf-set-lab">Range</span>
                <button class="rf-toggle" type="button" data-set="sandbox" aria-pressed="false">
                  SANDBOX <span class="rf-toggle-state">OFF</span>
                </button>
              </div>
              <div class="rf-set-group">
                <span class="rf-set-lab">Allies</span>
                <button class="rf-toggle" type="button" data-set="allies" aria-pressed="false">
                  CPU ALLIES <span class="rf-toggle-state">OFF</span>
                </button>
              </div>
              <div class="rf-set-group">
                <span class="rf-set-lab">Master</span>
                <input class="rf-range" type="range" min="0" max="100" value="80" data-set="master" aria-label="Master volume" />
                <span class="rf-range-val rf-num">80</span>
              </div>
              <div class="rf-set-group">
                <span class="rf-set-lab">Music</span>
                <input class="rf-range" type="range" min="0" max="100" value="55" data-set="music" aria-label="Music volume" />
                <span class="rf-range-val rf-num">55</span>
              </div>
            </div>
          </div>
        </div>
        </div>
        <div class="rf-tabpage rf-off" data-page="seed">
          <div class="rf-col rf-seedpage">
            <div class="rf-eyebrow">Seed / random play</div>
            <p class="rf-seed-desc">
              Every island is generated from its seed: the same seed on the same sector always builds the same
              battlefield. Share a seed to replay an island, or let the generator pick for you.
            </p>
            <div class="rf-sec-title">Seed</div>
            <div class="rf-seedrow">
              <input
                class="rf-seed-input rf-num"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                spellcheck="false"
                data-set="seed"
                aria-label="Map seed"
              />
              <button class="rf-seg-btn rf-seed-roll" type="button" data-roll>REROLL</button>
            </div>
            <div class="rf-sec-title">Mode</div>
            <div class="rf-seg" data-set="random">
              <button class="rf-seg-btn is-on" type="button" data-random="0">FIXED</button>
              <button class="rf-seg-btn" type="button" data-random="1">RANDOM</button>
            </div>
            <p class="rf-seed-desc">
              FIXED deploys on the seed above, on the sector chosen under MATCH. RANDOM rolls a new seed and a
              random sector every time you start.
            </p>
            <div class="rf-sec-title">Size</div>
            <div class="rf-seg" data-set="size">
              <button class="rf-seg-btn is-on" type="button" data-size="0">SMALL</button>
              <button class="rf-seg-btn" type="button" data-size="1">MEDIUM</button>
              <button class="rf-seg-btn" type="button" data-size="2">BIG</button>
            </div>
            <div class="rf-sec-title">Deploy</div>
            <button class="rf-btn is-primary" type="button" data-act="sp">
              <span>SINGLE PLAYER<span class="rf-btn-sub">You against the enemy AI</span></span>
              <span class="rf-btn-k">ENTER</span>
            </button>
            <button class="rf-btn" type="button" data-act="2p">
              <span>TWO PLAYERS<span class="rf-btn-sub">Split screen, shared keyboard</span></span>
              <span class="rf-btn-k">F2</span>
            </button>
          </div>
        </div>
        <div class="rf-title-foot">
          <span>v0.1 · WEBGL BUILD</span>
          <span>·</span>
          <span>CAPTURE THE ENEMY FLAG AND BRING IT HOME</span>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------------ garage -->
    <div class="rf-modal rf-garage rf-off">
      <div class="rf-hangar"><div class="rf-title-grid"></div><div class="rf-scan"></div></div>
      <div class="rf-panel rf-garage-panel">
        <button class="rf-panel-x" type="button" aria-label="Close vehicle selection (Esc)">${GLYPH.close}</button>
        <div class="rf-panel-head">
          <span class="rf-eyebrow">Hangar bay</span>
          <span class="rf-panel-title">SELECT VEHICLE</span>
          <span class="rf-panel-tag"></span>
        </div>
        <div class="rf-garage-grid"></div>
        <div class="rf-garage-foot">
          <span class="rf-kbd">1-4</span><span>SELECT</span>
          <span class="rf-kbd">ENTER</span><span>DEPLOY</span>
          <span class="rf-kbd">ESC</span><span>CLOSE</span>
          <span class="rf-panel-tag">REBUILD QUEUE IS SHARED WITH YOUR TEAM</span>
        </div>
      </div>
    </div>

    <!-- --------------------------------------------------------- round end -->
    <div class="rf-modal rf-round rf-off">
      <div class="rf-hangar"><div class="rf-title-grid"></div><div class="rf-scan"></div></div>
      <div class="rf-panel rf-round-panel">
        <div class="rf-eyebrow rf-round-eyebrow">Round complete</div>
        <div class="rf-round-title">—</div>
        <div class="rf-round-score">
          <span class="rf-round-score-v is-t0 rf-num">0</span>
          <span class="rf-round-score-dash">—</span>
          <span class="rf-round-score-v is-t1 rf-num">0</span>
        </div>
        <div class="rf-round-teams"><span>GREEN</span><span>RED</span></div>
        <div class="rf-round-sub"></div>
        <div class="rf-round-actions">
          <button class="rf-btn is-primary" type="button" data-act="continue">
            <span>CONTINUE</span><span class="rf-btn-k">ENTER</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ---------------------------------------------------------- loading -->
    <div class="rf-loading">
      <div class="rf-load-in">
        <div class="rf-load-logo">RETURNED FIRE</div>
        <div class="rf-load-lab">Booting field manual…</div>
        <div class="rf-load-bar"><i></i></div>
        <div class="rf-load-pct rf-num">0%</div>
      </div>
    </div>

    <div class="rf-toast"><span class="rf-toast-ico">${GLYPH.shield}</span><span class="rf-toast-txt"></span></div>
  `;

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;

  const elTitle = q('.rf-title');
  const elMapName = q('.rf-mapcard-name');
  const elMapIdx = q('.rf-mapcard-idx');
  const elMapSeg = q('[data-set="maps"]');
  const elModeSeg = q('[data-set="mode"]');
  const elSeedInput = q<HTMLInputElement>('[data-set="seed"]');
  const elSeedRoll = q<HTMLElement>('[data-roll]');
  const elRandomSeg = q('[data-set="random"]');
  const elTabs = q('.rf-tabs');
  const elQuality = q('[data-set="quality"]');
  const elCpu = q('[data-set="cpu"]');
  const elSandbox = q<HTMLElement>('[data-set="sandbox"]');
  const elSandboxState = elSandbox.querySelector('.rf-toggle-state') as HTMLElement;
  const elAllies = q<HTMLElement>('[data-set="allies"]');
  const elAlliesState = elAllies.querySelector('.rf-toggle-state') as HTMLElement;
  const elMaster = q<HTMLInputElement>('[data-set="master"]');
  const elMusic = q<HTMLInputElement>('[data-set="music"]');
  const elSetVals = Array.from(root.querySelectorAll<HTMLElement>('.rf-range-val'));

  const elGarage = q('.rf-garage');
  const elGarageTag = q('.rf-garage .rf-panel-tag');
  const elGarageGrid = q('.rf-garage-grid');
  const elGarageX = q('.rf-garage .rf-panel-x');

  const elRound = q('.rf-round');
  const elRoundEyebrow = q('.rf-round-eyebrow');
  const elRoundTitle = q('.rf-round-title');
  const elRoundScore = [q('.rf-round .is-t0'), q('.rf-round .is-t1')];
  const elRoundSub = q('.rf-round-sub');

  const elLoading = q('.rf-loading');
  const elLoadLab = q('.rf-load-lab');
  const elLoadFill = q('.rf-load-bar > i');
  const elLoadPct = q('.rf-load-pct');

  const elToast = q('.rf-toast');
  const elToastTxt = q('.rf-toast-txt');

  /* ---- state ---------------------------------------------------------------- */
  let titleOpts: Parameters<Menus['showTitle']>[0] | null = null;
  let garageState: GarageState | null = null;
  let garageSpecsRef: GarageState['specs'] | null = null;
  let garageTeamId = -1;
  let onPickCb: ((kind: number) => void) | null = null;
  let onContinueCb: (() => void) | null = null;
  let toastTimer = 0;
  // The settings column's state. It does not read the config file or the URL itself: `main.ts`
  // owns precedence (config file -> stored player changes -> URL overrides) and pushes the
  // values that won through `applyInitial`, so the panel cannot show a setting the match is not
  // actually using.
  let quality: 'low' | 'medium' | 'high' = 'high';
  let cpu: 'easy' | 'medium' | 'hard' = 'medium';
  let sandbox = false;
  let allies = false;
  let disposed = false;

  interface Card {
    el: HTMLDivElement;
    kind: number;
    state: HTMLElement;
    fill: HTMLElement;
    note: HTMLElement;
    ready: number;
    locked: boolean;
  }
  let cards: Card[] = [];
  let focusIdx = -1;

  /* ---- settings ------------------------------------------------------------- */
  function syncCpu(): void {
    for (const btn of Array.from(elCpu.querySelectorAll<HTMLElement>('[data-cpu]'))) {
      btn.classList.toggle('is-on', btn.dataset.cpu === cpu);
    }
  }
  function syncSandbox(): void {
    elSandbox.classList.toggle('is-on', sandbox);
    elSandbox.setAttribute('aria-pressed', sandbox ? 'true' : 'false');
    elSandboxState.textContent = sandbox ? 'ON' : 'OFF';
  }
  function syncAllies(): void {
    elAllies.classList.toggle('is-on', allies);
    elAllies.setAttribute('aria-pressed', allies ? 'true' : 'false');
    elAlliesState.textContent = allies ? 'ON' : 'OFF';
  }
  function dispatchSettings(): void {
    const detail = {
      quality,
      master: Number(elMaster.value) / 100,
      music: Number(elMusic.value) / 100,
      cpu,
      sandbox,
      allies,
    };
    /* mirrored onto <html> so the stylesheet can drop the expensive glass on "low" */
    document.documentElement.classList.remove('rf-q-low', 'rf-q-medium', 'rf-q-high');
    document.documentElement.classList.add(`rf-q-${quality}`);
    window.dispatchEvent(new CustomEvent('rf:settings', { detail }));
    titleOpts?.onSettings?.();
  }

  syncCpu();
  syncSandbox();
  syncAllies();

  /** Adopt the settings in force without dispatching them back as a player change. */
  function applyInitial(settings: {
    quality: 'low' | 'medium' | 'high';
    master: number;
    music: number;
    cpu: 'easy' | 'medium' | 'hard';
    sandbox: boolean;
    allies: boolean;
  }): void {
    quality = settings.quality;
    cpu = settings.cpu;
    sandbox = settings.sandbox;
    allies = settings.allies;
    for (const b of Array.from(elQuality.querySelectorAll<HTMLElement>('[data-q]'))) {
      b.classList.toggle('is-on', b.dataset.q === quality);
    }
    elMaster.value = String(Math.round(settings.master * 100));
    elMusic.value = String(Math.round(settings.music * 100));
    syncCpu();
    syncSandbox();
    syncAllies();
    document.documentElement.classList.remove('rf-q-low', 'rf-q-medium', 'rf-q-high');
    document.documentElement.classList.add(`rf-q-${quality}`);
  }

  elQuality.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-q]');
    if (!b) return;
    quality = (b.dataset.q as 'low' | 'medium' | 'high') ?? 'high';
    for (const btn of Array.from(elQuality.querySelectorAll<HTMLElement>('[data-q]'))) {
      btn.classList.toggle('is-on', btn.dataset.q === quality);
    }
    dispatchSettings();
  });

  elCpu.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-cpu]');
    if (!b) return;
    cpu = (b.dataset.cpu as 'easy' | 'medium' | 'hard') ?? 'medium';
    syncCpu();
    dispatchSettings();
  });

  elSandbox.addEventListener('click', () => {
    sandbox = !sandbox;
    syncSandbox();
    dispatchSettings();
  });

  elAllies.addEventListener('click', () => {
    allies = !allies;
    syncAllies();
    dispatchSettings();
  });

  for (const r of [elMaster, elMusic]) {
    r.addEventListener('input', () => {
      elSetVals[r === elMaster ? 0 : 1].textContent = r.value;
      dispatchSettings();
    });
  }

  /* ---- title ---------------------------------------------------------------- */
  let mapNamesCache: string[] = [];
  let mapNamesSig = '';

  function renderMapSeg(names: string[]): void {
    const sig = names.join('|');
    if (sig === mapNamesSig) return;
    mapNamesSig = sig;
    elMapSeg.textContent = '';
    names.forEach((n, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rf-seg-btn';
      b.dataset.i = String(i);
      b.textContent = n;
      elMapSeg.appendChild(b);
    });
  }

  function applyMap(index: number): void {
    for (const b of Array.from(elMapSeg.children) as HTMLElement[]) {
      b.classList.toggle('is-on', Number(b.dataset.i) === index);
    }
    elMapName.textContent = mapNamesCache[index] ?? '—';
    elMapIdx.textContent = `SECTOR ${String(index + 1).padStart(2, '0')} / ${String(mapNamesCache.length).padStart(2, '0')}`;
  }

  elMapSeg.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!b || !titleOpts) return;
    const i = Number(b.dataset.i);
    titleOpts.onMapChange(i);
    applyMap(i);
  });

  /** Highlight the active generator mode. `mirror` is a different battlefield for the same
   *  sector name, so the sector card is refreshed too (mirror maps ignore the seed). */
  function applyMode(mode: number): void {
    for (const b of Array.from(elModeSeg.children) as HTMLElement[]) {
      b.classList.toggle('is-on', Number(b.dataset.mode) === mode);
    }
  }

  elModeSeg.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-mode]');
    if (!b || !titleOpts) return;
    const m = Number(b.dataset.mode);
    titleOpts.onModeChange(m);
    applyMode(m);
  });

  /**
   * Highlight the active battlefield size. It takes effect on START (the world's dimensions are
   * fixed when it is built), which is why it sits with the other pre-match choices. Both tabs
   * carry a size control — MATCH and SEED/RANDOM each deploy their own matches — so every
   * segment renders one shared value; changing either updates all of them.
   */
  const sizeSegs = Array.from(root.querySelectorAll<HTMLElement>('.rf-seg[data-set="size"]'));

  function applySize(size: number): void {
    for (const seg of sizeSegs) {
      for (const b of Array.from(seg.children) as HTMLElement[]) {
        b.classList.toggle('is-on', Number(b.dataset.size) === size);
      }
    }
  }

  for (const seg of sizeSegs) {
    seg.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-size]');
      if (!b || !titleOpts) return;
      const sz = Number(b.dataset.size);
      titleOpts.onSizeChange(sz);
      applySize(sz);
    });
  }

  /* ---- seed / random play ------------------------------------------------------ */
  let seed = 0;
  let randomPlay = false;

  function syncRandom(): void {
    for (const b of Array.from(elRandomSeg.children) as HTMLElement[]) {
      b.classList.toggle('is-on', (b.dataset.random === '1') === randomPlay);
    }
  }

  /** A seed only counts once committed: Enter or leaving the field. Invalid input snaps back
   *  to the last valid value, so a typo can never start a match on an unparseable island. */
  function commitSeed(): void {
    const n = Number.parseInt(elSeedInput.value.trim(), 10);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) {
      elSeedInput.value = String(seed);
      return;
    }
    if (n !== seed) {
      seed = n;
      titleOpts?.onSeedChange(n);
    }
  }

  elSeedInput.addEventListener('change', commitSeed);
  elSeedInput.addEventListener('keydown', (ev) => {
    // Keys typed into the field must not reach the window-level listeners: InputState would
    // bank them as drive keys and the title handler below would treat Enter as "start".
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commitSeed();
      elSeedInput.blur();
    }
  });

  elSeedRoll.addEventListener('click', (ev) => {
    seed = 1 + Math.floor(Math.random() * 0xffffffff); // non-zero u32, like `?seed=`
    elSeedInput.value = String(seed);
    titleOpts?.onSeedChange(seed);
    // Blur so a follow-up Enter (the "start" key) does not re-fire this button: the browser
    // activates a focused button on Enter, and a second roll would change the seed AFTER the
    // match already started with the first one.
    (ev.currentTarget as HTMLElement).blur();
  });

  elRandomSeg.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-random]');
    if (!b || !titleOpts) return;
    randomPlay = b.dataset.random === '1';
    syncRandom();
    titleOpts.onRandomPlayChange(randomPlay);
    // Same Enter-after-click guard as REROLL: without it the toggle would flip back after the
    // match already started with the first value. `b` is the focused button (the listener sits
    // on the segment container).
    b.blur();
  });

  /* ---- tabs ------------------------------------------------------------------ */
  /** Show one tab page, hide the other. The title always re-opens on MATCH so a return from a
   *  round lands where the player starts a match, not mid-seed-editing. */
  function applyTab(name: string): void {
    for (const b of Array.from(elTabs.children) as HTMLElement[]) {
      b.classList.toggle('is-on', b.dataset.tab === name);
    }
    for (const p of Array.from(root.querySelectorAll<HTMLElement>('.rf-tabpage'))) {
      off(p, p.dataset.page !== name);
    }
  }

  elTabs.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (!b) return;
    applyTab(b.dataset.tab ?? 'main');
    // Enter-after-click guard: a focused tab button would re-fire on Enter (harmless for a
    // tab, but it would also let the window handler start the match from a stale focus).
    b.blur();
  });

  elTitle.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b || !titleOpts) return;
    titleOpts.onStart(b.dataset.act === '2p');
  });

  /* ---- garage --------------------------------------------------------------- */
  function buildCards(state: GarageState): void {
    elGarageGrid.textContent = '';
    cards = [];
    const specs = state.specs;
    let maxHp = 1;
    let maxSpd = 1;
    let maxAmmo = 1;
    for (const s of specs) {
      if (s.hp > maxHp) maxHp = s.hp;
      if (s.speed > maxSpd) maxSpd = s.speed;
      if (s.ammo0 > maxAmmo) maxAmmo = s.ammo0;
    }

    specs.forEach((spec, i) => {
      const kind = spec.kind;
      const name = (state.vehicleNameFor ? state.vehicleNameFor(kind) : '') || VEHICLE_NAME[kind] || `KIND ${kind}`;
      const role = VEHICLE_ROLE[kind] ?? 'Field vehicle.';
      const el = document.createElement('div');
      el.className = 'rf-gcard';
      el.tabIndex = 0;
      el.dataset.kind = String(kind);
      el.innerHTML = `
        <div class="rf-gcard-top">
          <span class="rf-gcard-key">${i + 1}</span>
          <span class="rf-gcard-state">READY</span>
        </div>
        <div class="rf-gcard-art">${silhouetteSvg(kind, 'rf-gcard-svg')}</div>
        <div class="rf-gcard-name">${name}</div>
        <div class="rf-gcard-role">${role}</div>
        <div class="rf-gcard-stats">
          <div class="rf-gstat"><span class="rf-gstat-k">ARM</span><span class="rf-gstat-track"><i style="--v:${(spec.hp / maxHp).toFixed(3)}"></i></span><span class="rf-gstat-v rf-num">${Math.round(spec.hp)}</span></div>
          <div class="rf-gstat"><span class="rf-gstat-k">SPD</span><span class="rf-gstat-track"><i style="--v:${(spec.speed / maxSpd).toFixed(3)}"></i></span><span class="rf-gstat-v rf-num">${Math.round(spec.speed)}</span></div>
          <div class="rf-gstat"><span class="rf-gstat-k">AMMO</span><span class="rf-gstat-track"><i style="--v:${(spec.ammo0 / maxAmmo).toFixed(3)}"></i></span><span class="rf-gstat-v rf-num">${Math.round(spec.ammo0)}</span></div>
        </div>
        <div class="rf-gcard-wpn">
          <span>MAIN <b>${spec.w0.name}</b></span>
          <span>ALT <b>${spec.w1.name}</b></span>
          <span>${spec.mines > 0 ? `MINES <b>${spec.mines}</b>` : ''}${spec.flag ? ' · CARRIES FLAG' : ''}${spec.flying ? ' · AIRBORNE' : ''}${spec.amphibious ? ' · AMPHIBIOUS' : ''}</span>
        </div>
        <div class="rf-gcard-foot">
          <div class="rf-gcard-bar"><i style="--v:0"></i></div>
          <div class="rf-gcard-note"><span>REBUILD</span><span class="rf-num">0%</span></div>
        </div>`;
      elGarageGrid.appendChild(el);
      cards.push({
        el,
        kind,
        state: el.querySelector('.rf-gcard-state') as HTMLElement,
        fill: el.querySelector('.rf-gcard-bar > i') as HTMLElement,
        note: el.querySelector('.rf-gcard-note .rf-num') as HTMLElement,
        ready: -1,
        locked: false,
      });
    });
  }

  function refreshCards(): void {
    const st = garageState;
    if (!st) return;
    const ready = [st.team.readyJeep, st.team.readyTank, st.team.readyHrsv, st.team.readyHeli];
    const build = [st.team.buildJeep, st.team.buildTank, st.team.buildHrsv, st.team.buildHeli];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const idx = ROLES.indexOf(card.kind);
      const slot = idx >= 0 ? idx : i;
      const raw = Number(ready[slot] ?? 0);
      const v = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const locked = v < 0.999;
      if (Math.abs(v - card.ready) > 0.004) {
        card.ready = v;
        card.fill.style.setProperty('--v', v.toFixed(3));
        card.note.textContent = `${Math.round(v * 100)}%`;
      }
      if (locked !== card.locked) {
        card.locked = locked;
        card.el.classList.toggle('is-locked', locked);
        card.state.textContent = locked ? (Number(build[slot] ?? 0) > 0 ? 'IN BUILD' : 'UNAVAILABLE') : 'READY';
      }
    }
  }

  function pick(kind: number): void {
    const card = cards.find((c) => c.kind === kind);
    if (!card || card.locked) return;
    for (const c of cards) c.el.classList.toggle('is-picked', c === card);
    onPickCb?.(kind);
  }

  elGarageGrid.addEventListener('click', (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('.rf-gcard');
    if (!card) return;
    const kind = Number(card.dataset.kind);
    if (Number.isNaN(kind)) return;
    for (const c of cards) c.el.classList.toggle('is-focus', c.el === card);
    focusIdx = cards.findIndex((c) => c.el === card);
    pick(kind);
  });

  elGarageGrid.addEventListener('pointerover', (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('.rf-gcard');
    if (!card) return;
    focusIdx = cards.findIndex((c) => c.el === card);
    for (const c of cards) c.el.classList.toggle('is-focus', c.el === card);
  });

  /* ---- round end ------------------------------------------------------------ */
  elRound.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-act="continue"]')) onContinueCb?.();
  });

  /* ---- keyboard ------------------------------------------------------------- */
  function onKey(ev: KeyboardEvent): void {
    const titleOn = !elTitle.classList.contains('rf-off');
    const garageOn = !elGarage.classList.contains('rf-off');
    const roundOn = !elRound.classList.contains('rf-off');

    if (roundOn && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      onContinueCb?.();
      return;
    }
    if (garageOn) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeGarage();
        return;
      }
      if (ev.key >= '1' && ev.key <= '4') {
        const i = Number(ev.key) - 1;
        const card = cards[i];
        if (card) {
          focusIdx = i;
          for (const c of cards) c.el.classList.toggle('is-focus', c === card);
          pick(card.kind);
        }
        return;
      }
      if (ev.key === 'Enter' && focusIdx >= 0 && cards[focusIdx]) {
        pick(cards[focusIdx].kind);
        return;
      }
    }
    if (titleOn) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        titleOpts?.onStart(false);
      } else if (ev.key === 'F2') {
        ev.preventDefault();
        titleOpts?.onStart(true);
      }
    }
  }
  window.addEventListener('keydown', onKey);

  /* ---- interface ------------------------------------------------------------ */
  /** The in-game HUD has no business showing through the title/boot screens; the flag
   *  lives on <html> so the stylesheet can fade it out without an interface change. */
  function syncShellFlags(): void {
    const boot = !elTitle.classList.contains('rf-off') || !elLoading.classList.contains('rf-off');
    document.documentElement.classList.toggle('rf-shell-boot', boot);
  }

  function showTitle(opts: Parameters<Menus['showTitle']>[0]): void {
    titleOpts = opts;
    mapNamesCache = opts.mapNames.slice();
    renderMapSeg(opts.mapNames);
    applyMap(opts.mapIndex);
    applyMode(opts.mapMode);
    applySize(opts.mapSize);
    seed = opts.seed;
    // Don't clobber a value the player is mid-typing.
    if (document.activeElement !== elSeedInput) elSeedInput.value = String(seed);
    randomPlay = opts.randomPlay;
    syncRandom();
    applyTab('main');
    off(elTitle, false);
    syncShellFlags();
  }

  function hideTitle(): void {
    off(elTitle, true);
    syncShellFlags();
  }

  function showGarage(state: GarageState, onPickFn: (kind: number) => void): void {
    garageState = state;
    onPickCb = onPickFn;
    if (garageSpecsRef !== state.specs || garageTeamId !== state.teamId) {
      garageSpecsRef = state.specs;
      garageTeamId = state.teamId;
      buildCards(state);
      focusIdx = cards.length ? 0 : -1;
    }
    const teamName = state.teamId === 1 ? 'SIGNAL RED' : 'NATO GREEN';
    const tag = `${teamName} · PLAYER ${state.playerIndex + 1}`;
    if (elGarageTag.textContent !== tag) elGarageTag.textContent = tag;
    refreshCards();
    off(elGarage, false);
  }

  function hideGarage(): void {
    off(elGarage, true);
    garageState = null;
  }

  /** Close the panel and tell the game a close was requested (Esc or the ✕ button). The
   *  game decides what "cancel" means for its current state — resume play if a hull is in
   *  the field, otherwise fall back to the title screen. */
  function closeGarage(): void {
    hideGarage();
    window.dispatchEvent(new CustomEvent('rf:garage-close'));
  }

  elGarageX.addEventListener('click', () => closeGarage());

  function showRoundEnd(state: Parameters<Menus['showRoundEnd']>[0]): void {
    onContinueCb = state.onContinue;
    const winner = state.winner;
    const title = state.matchOver
      ? state.youWon
        ? 'MATCH VICTORY'
        : winner < 0
          ? 'MATCH DRAWN'
          : 'MATCH DEFEAT'
      : state.youWon
        ? 'ROUND WON'
        : winner < 0
          ? 'ROUND DRAWN'
          : 'ROUND LOST';
    elRoundEyebrow.textContent = state.matchOver ? 'Match complete' : 'Round complete';
    elRoundTitle.textContent = title;
    elRoundTitle.className = `rf-round-title ${state.youWon ? 'is-win' : 'is-lose'}`;
    elRoundScore[0].textContent = String(state.score[0]);
    elRoundScore[1].textContent = String(state.score[1]);
    elRoundSub.textContent = state.matchOver
      ? 'FINAL SCORE — PRESS ENTER TO RETURN TO THE FIELD MANUAL'
      : 'PRESS ENTER TO DEPLOY THE NEXT ROUND';
    off(elRound, false);
  }

  function hideRoundEnd(): void {
    off(elRound, true);
  }

  function showLoading(progress: number, label: string): void {
    const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
    elLoadFill.style.setProperty('--v', p.toFixed(3));
    elLoadPct.textContent = `${Math.round(p * 100)}%`;
    if (elLoadLab.textContent !== label) elLoadLab.textContent = label;
    off(elLoading, false);
  }

  function hideLoading(): void {
    elLoading.classList.add('is-hidden');
    window.setTimeout(() => {
      off(elLoading, true);
      syncShellFlags();
    }, 500);
  }

  function toast(text: string): void {
    elToastTxt.textContent = text;
    elToast.classList.add('is-on');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      elToast.classList.remove('is-on');
      toastTimer = 0;
    }, 2200);
  }

  container.appendChild(root);

  return {
    applyInitial,
    showTitle,
    hideTitle,
    showGarage,
    hideGarage,
    updateGarage(): void {
      // No-op while the panel is closed: `refreshCards` bails out without a garage state.
      refreshCards();
    },
    showRoundEnd,
    hideRoundEnd,
    showLoading,
    hideLoading,
    toast,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('keydown', onKey);
      if (toastTimer) window.clearTimeout(toastTimer);
      root.remove();
    },
  };
}
