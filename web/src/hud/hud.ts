/**
 * In-game DOM HUD: slim bottom band (vehicle, bars, weapons, minimap, score, clock),
 * top-left round readout, notification feed, centre banner, respawn card and the
 * "laughing skull" taunt.
 *
 * Performance contract: `update()` runs every animation frame and must not allocate or
 * force layout. Every write is guarded by a cached previous value, all animation is done
 * with `transform`/`opacity` + CSS transitions, and the only layout reads in the whole
 * module happen on construction and on window resize.
 */
import './style.css';

import type { Hud, HudFrame, Notification } from './types.js';
import { createMinimap } from './minimap.js';
import { GLYPH, SKULL_SVG, VEHICLE_NAME, VEHICLE_ROLE, silhouetteSvg } from './icons.js';
import { FLAGSTATE, VKIND, type VehicleView } from '../sim/layout.js';
import { TEAM_COLORS } from '../assets/types.js';

/* ------------------------------------------------------------------ small helpers */

const hex6 = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

/** Blend a packed 0xRRGGBB toward white by `t` (0..1); used for the team accent variants. */
function lighten(n: number, t: number): string {
  const r = Math.round((n >> 16) & 255);
  const g = Math.round((n >> 8) & 255);
  const b = Math.round(n & 255);
  const m = (v: number): number => Math.round(v + (255 - v) * t);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function mmss(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toString().padStart(2, '0')}`;
}

/** Damage band: 0 = ok, 1 = warn, 2 = critical. Two thresholds so the eye catches both. */
const band = (v: number): number => (v <= 0.25 ? 2 : v <= 0.5 ? 1 : 0);
const BAND_CLS = ['', 'is-warn', 'is-crit'] as const;

const FLAG_LABEL: Record<number, string> = {
  [FLAGSTATE.HOME]: 'SECURE',
  [FLAGSTATE.CARRIED]: 'TAKEN',
  [FLAGSTATE.DROPPED]: 'DROPPED',
  [FLAGSTATE.EXPOSED]: 'EXPOSED',
  [FLAGSTATE.CAPTURED]: 'LOST',
};
const FLAG_CLS: Record<number, string> = {
  [FLAGSTATE.HOME]: 'var(--green)',
  [FLAGSTATE.CARRIED]: 'var(--red)',
  [FLAGSTATE.DROPPED]: 'var(--amber)',
  [FLAGSTATE.EXPOSED]: 'var(--amber)',
  [FLAGSTATE.CAPTURED]: 'var(--red)',
};

/**
 * Real loadouts per vehicle kind, straight from `crates/rf-core/src/spec.rs`.
 * The HUD frame carries counts but no capacities or weapon names, so these are the
 * authoritative defaults; the AMMO bar still self-corrects upward if a bigger magazine is
 * ever seen (a resupplied or modified vehicle), and never shrinks below the default.
 */
interface Loadout {
  main: string;
  alt: string;
  altCap: number;
  mines: number;
}

const LOADOUT: Record<number, Loadout> = {
  [VKIND.JEEP]: { main: 'GRENADE', alt: '', altCap: 0, mines: 0 },
  [VKIND.TANK]: { main: '120MM', alt: '', altCap: 0, mines: 0 },
  [VKIND.HRSV]: { main: 'MLRS', alt: '', altCap: 0, mines: 10 },
  [VKIND.HELI]: { main: '20MM', alt: 'ROCKET', altCap: 50, mines: 0 },
};
const DEFAULT_LOADOUT: Loadout = { main: 'MAIN', alt: 'ALT', altCap: 0, mines: 0 };
const loadoutFor = (kind: number): Loadout => LOADOUT[kind] ?? DEFAULT_LOADOUT;

const FEED_ROWS = 4;
const SKULL_MS = 1600;
const SKULL_COOLDOWN_MS = 2500;

const NOTIFY_ICON: Record<Notification['kind'], string> = {
  flag: GLYPH.flag,
  kill: GLYPH.turret,
  warn: GLYPH.warn,
  info: GLYPH.rounds,
};

function feedColor(kind: Notification['kind'], team: number): string {
  if (kind === 'kill') return team === 1 ? 'var(--red)' : 'var(--green)';
  if (kind === 'warn') return 'var(--amber)';
  if (kind === 'flag') return team === 1 ? 'var(--red)' : 'var(--cyan)';
  return 'rgba(233,239,245,.55)';
}

/* ------------------------------------------------------------------ module */

export function createHud(container: HTMLElement): Hud {
  /* ---- team palette straight from the frozen asset contract ------------------ */
  const t0 = TEAM_COLORS[0];
  const t1 = TEAM_COLORS[1];

  const root = document.createElement('div');
  root.className = 'rf-hud';
  root.style.setProperty('--t0', hex6(t0));
  root.style.setProperty('--t0-hi', lighten(t0, 0.42));
  root.style.setProperty('--t1', hex6(t1));
  root.style.setProperty('--t1-hi', lighten(t1, 0.42));

  root.innerHTML = `
    <div class="rf-vig"></div>
    <div class="rf-top">
      <div class="rf-stat">
        <span class="rf-stat-k">SCORE</span>
        <span class="rf-num"><b class="rf-sc-t0">0</b><span class="rf-sc-dash">—</span><b class="rf-sc-t1">0</b></span>
      </div>
      <div class="rf-stat">
        ${GLYPH.clock}
        <span class="rf-num rf-timer">0:00</span>
      </div>
      <div class="rf-stat">
        ${GLYPH.turret}
        <span class="rf-num rf-turrets">0</span>
        <span class="rf-stat-k">TOWERS</span>
      </div>
    </div>
    <div class="rf-dbg"></div>
    <div class="rf-banner"><div class="rf-banner-in">
      <span class="rf-banner-title"></span>
      <span class="rf-banner-rule"></span>
      <span class="rf-banner-sub"></span>
    </div></div>
    <div class="rf-skull">${SKULL_SVG}</div>
    <div class="rf-respawn">
      <div class="rf-rsp-head">
        <span class="rf-rsp-title">VEHICLE DESTROYED</span>
        <span class="rf-rsp-tag"></span>
        <span class="rf-rsp-clock rf-num">0:00</span>
      </div>
      <div class="rf-rsp-sub">WAITING FOR A REBUILD — PICK A VEHICLE IN THE GARAGE</div>
      <div class="rf-rsp-grid"></div>
    </div>
    <div class="rf-feed"></div>
    <div class="rf-bar">
      <div class="rf-bar-l">
        <div class="rf-veh">
          <div class="rf-veh-ico"></div>
          <div class="rf-veh-txt">
            <span class="rf-veh-name">—</span>
            <span class="rf-veh-role"></span>
          </div>
        </div>
        <span class="rf-sep"></span>
        <div class="rf-rows">
          <div class="rf-row">
            <span class="rf-row-lab">ARMOUR</span>
            <span class="rf-row-track"><i class="rf-row-fill"></i></span>
            <span class="rf-row-val rf-num">100</span>
          </div>
          <div class="rf-row">
            <span class="rf-row-lab">FUEL</span>
            <span class="rf-row-track"><i class="rf-row-fill"></i></span>
            <span class="rf-row-val rf-num">100</span>
          </div>
          <div class="rf-row">
            <span class="rf-row-lab">AMMO</span>
            <span class="rf-row-track"><i class="rf-row-fill"></i></span>
            <span class="rf-row-val rf-num">0</span>
          </div>
        </div>
        <span class="rf-sep"></span>
        <div class="rf-wpn">
          <div class="rf-wpn-row"><span class="rf-wpn-k">MAIN</span><span class="rf-wpn-v rf-num">0</span></div>
          <div class="rf-wpn-row"><span class="rf-wpn-k">ALT</span><span class="rf-wpn-v rf-num">0</span></div>
          <div class="rf-wpn-row"><span class="rf-wpn-k">${GLYPH.mine}MINES</span><span class="rf-wpn-v rf-num">0</span></div>
        </div>
      </div>
      <div class="rf-bar-c"></div>
      <div class="rf-bar-r">
        <div class="rf-chip">
          <span class="rf-chip-ico">${GLYPH.flag}</span>
          <span class="rf-chip-txt">
            <span class="rf-chip-k">YOUR FLAG</span>
            <span class="rf-chip-v">SECURE</span>
          </span>
        </div>
        <span class="rf-sep"></span>
        <div class="rf-score">
          <span class="rf-score-v is-t0">0</span>
          <span class="rf-score-dash">—</span>
          <span class="rf-score-v is-t1">0</span>
          <span class="rf-score-cap">TO 3</span>
        </div>
        <span class="rf-sep"></span>
        <div class="rf-clock">
          <div class="rf-clock-v">${GLYPH.clock}<span class="rf-num">0:00</span></div>
          <div class="rf-clock-bar"><i></i></div>
          <div class="rf-clock-cap">ELAPSED</div>
        </div>
      </div>
    </div>
  `;

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const qa = (sel: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel));

  const elTopScore0 = q('.rf-top .rf-sc-t0');
  const elTopScore1 = q('.rf-top .rf-sc-t1');
  const elTopTimer = q('.rf-top .rf-timer');
  const elTopTurrets = q('.rf-top .rf-turrets');
  const elDbg = q('.rf-dbg');
  const elBannerIn = q('.rf-banner-in');
  const elBannerTitle = q('.rf-banner-title');
  const elBannerSub = q('.rf-banner-sub');
  const elSkull = q('.rf-skull');
  const elRespawn = q('.rf-respawn');
  const elRspClock = q('.rf-rsp-clock');
  const elRspTag = q('.rf-rsp-tag');
  const elRspGrid = q('.rf-rsp-grid');
  const elFeed = q('.rf-feed');
  const elVehIco = q('.rf-veh-ico');
  const elVehName = q('.rf-veh-name');
  const elVehRole = q('.rf-veh-role');
  const elFlagChip = q('.rf-chip');
  const elFlagVal = q('.rf-chip-v');
  const elBarScore0 = q('.rf-score .is-t0');
  const elBarScore1 = q('.rf-score .is-t1');
  const elScoreCap = q('.rf-score-cap');
  const elClockVal = q('.rf-clock-v .rf-num');
  const elClockFill = q('.rf-clock-bar > i');
  const elClockBar = q('.rf-clock-bar');
  const elClockCap = q('.rf-clock-cap');

  const rowTrack = qa('.rf-row-track');
  const rowFill = qa('.rf-row-fill');
  const rowVal = qa('.rf-row-val');
  /* Hoisted once — querying inside update() would allocate every frame. */
  const wpnRow = qa('.rf-wpn-row');
  const wpnVal = qa('.rf-wpn-v');
  const wpnKey = qa('.rf-wpn-k');

  /**
   * Minimap edge length. The bar is `94 * scale` tall and the map sits inside it with a
   * 4 px breathing gap, so it grows with the bar — at 1080p+ it is a genuinely readable
   * tactical display rather than a thumbnail.
   */
  const minimapSize = (scale: number): number => {
    /* Mirrors the `@media (min-height: 880px)` bar bump in style.css. */
    const base = window.innerHeight >= 880 ? 102 : 94;
    return Math.round(base * scale - 9);
  };

  /* ---- minimap (sized from the resolved --hud-scale length) ------------------ */
  const probe = document.createElement('i');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:var(--hud-scale);height:0;';
  root.appendChild(probe);
  const mini = createMinimap(84);
  q('.rf-bar-c').appendChild(mini.el);

  /* ---- notification feed pool ------------------------------------------------ */
  interface FeedRow {
    el: HTMLDivElement;
    ico: HTMLSpanElement;
    txt: HTMLSpanElement;
    sub: HTMLSpanElement;
    text: string;
    subText: string;
    color: string;
    icon: string;
    state: number; // -1 hidden, 0 out, 1 in, 2 fading
    key: string;
    age: number;
  }
  const feed: FeedRow[] = [];
  for (let i = 0; i < FEED_ROWS; i++) {
    const el = document.createElement('div');
    el.className = 'rf-feed-row';
    const ico = document.createElement('span');
    ico.className = 'rf-feed-ico';
    const txt = document.createElement('span');
    txt.className = 'rf-feed-txt';
    const sub = document.createElement('span');
    sub.className = 'rf-feed-sub';
    el.append(ico, txt, sub);
    elFeed.appendChild(el);
    feed.push({ el, ico, txt, sub, text: '', subText: '', color: '', icon: '', state: -1, key: '', age: 0 });
  }

  /* ---- respawn card garage slots -------------------------------------------- */
  interface RspSlot {
    el: HTMLDivElement;
    fill: HTMLElement;
    lab: HTMLSpanElement;
  }
  const slotKinds = [VKIND.JEEP, VKIND.TANK, VKIND.HRSV, VKIND.HELI];
  const rspSlots: RspSlot[] = [];
  for (let i = 0; i < slotKinds.length; i++) {
    const kind = slotKinds[i];
    const el = document.createElement('div');
    el.className = 'rf-rsp-slot';
    el.innerHTML = `${silhouetteSvg(kind, 'rf-rsp-svg')}
      <span class="rf-rsp-lab"><span>${(VEHICLE_NAME[kind] ?? '').split(' ')[0]}</span><span class="rf-num">0%</span></span>
      <span class="rf-rsp-bar"><i></i></span>`;
    elRspGrid.appendChild(el);
    rspSlots.push({
      el,
      fill: el.querySelector('.rf-rsp-bar > i') as HTMLElement,
      lab: el.querySelector('.rf-rsp-lab .rf-num') as HTMLSpanElement,
    });
  }

  /* ---- cached previous values (everything written only on change) ------------ */
  const c = {
    score0: -1,
    score1: -1,
    timerSec: -1,
    timerLow: false,
    turrets: -1,
    rounds: -1,
    flagState: -1,
    vehKind: -1,
    vehName: '',
    vehRole: '',
    roleSuffix: '',
    hpV: -1,
    fuelV: -1,
    ammoV: -1,
    bandHp: -1,
    bandFuel: -1,
    bandAmmo: -1,
    hpTxt: '',
    fuelTxt: '',
    ammoTxt: '',
    ammo0: -1,
    ammo1: -1,
    mines: -1,
    mainEmpty: false,
    mainReload: false,
    altEmpty: false,
    altReload: false,
    clockV: -1,
    timeMax: 300,
    clockCaption: '',
    clockBarOn: -1,
    wpnLabels: ['', '', ''],
    wpnRowsOn: [-1, -1, -1],
    dead: false,
    rspSec: -1,
    rspTag: '',
    slotP: [-1, -1, -1, -1],
    slotReady: [false, false, false, false],
    bannerKey: '',
    bannerPhase: -1,
    skullUntil: 0,
    lastSkull: -1e9,
    dbgTxt: '',
    dbgNext: 0,
  };

  let scalePx = 1;
  let lastNow = performance.now();
  let disposed = false;

  /* ---- banner clock (local, so it is robust whether or not the sim ages it) --- */
  let bannerAge = 0;
  let bannerLife = 2.4;

  function applyScale(): void {
    /* One layout read, only on construction/resize: resolve --hud-scale to px. */
    const w = probe.getBoundingClientRect().width;
    if (w > 0.1 && Math.abs(w - scalePx) > 0.01) {
      scalePx = w;
      mini.setSize(minimapSize(w));
    }
  }

  function setVehKind(kind: number): void {
    /* No live vehicle (dead / waiting in the garage): keep the last identity and loadout
       rather than falling back to generic MAIN/ALT rows for a vehicle we are not in. */
    if (kind <= VKIND.NONE) return;
    if (kind === c.vehKind) return;
    c.vehKind = kind;
    elVehIco.innerHTML = silhouetteSvg(kind, 'rf-veh-svg');
    c.vehName = VEHICLE_NAME[kind] ?? 'VEHICLE';
    elVehName.textContent = c.vehName;
    const role = VEHICLE_ROLE[kind] ?? '';
    c.vehRole = role.split('.')[0].toUpperCase();
    elVehRole.textContent = c.vehRole;
    applyWeaponLabels(kind);
  }

  /**
   * Weapon rows are per-vehicle: a jeep has grenades and nothing else, the MLRS carries
   * mines, only the helicopter has a secondary. Rows that do not apply are hidden rather
   * than shown as a permanent zero.
   */
  function applyWeaponLabels(kind: number): void {
    const lo = loadoutFor(kind);
    const labels = [lo.main, lo.alt, 'MINES'];
    const on = [true, lo.altCap > 0, lo.mines > 0];
    for (let i = 0; i < 3; i++) {
      if (labels[i] !== c.wpnLabels[i]) {
        c.wpnLabels[i] = labels[i];
        if (labels[i]) wpnKey[i].textContent = i === 2 ? labels[i] : labels[i];
        if (i === 2) wpnKey[2].innerHTML = `${GLYPH.mine}${labels[2]}`;
      }
      const flag = on[i] ? 1 : 0;
      if (flag !== c.wpnRowsOn[i]) {
        c.wpnRowsOn[i] = flag;
        wpnRow[i].classList.toggle('is-off', !on[i]);
      }
    }
  }

  function updateBanner(f: HudFrame, dt: number): void {
    const b = f.banner;
    if (!b || !b.title) {
      if (c.bannerPhase !== -1) {
        elBannerIn.className = 'rf-banner-in';
        c.bannerPhase = -1;
        c.bannerKey = '';
      }
      return;
    }
    const key = `${b.title}|${b.sub}`;
    if (key !== c.bannerKey) {
      c.bannerKey = key;
      bannerAge = 0;
      bannerLife = b.life > 0.2 ? b.life : 2.4;
      elBannerTitle.textContent = b.title;
      elBannerSub.textContent = b.sub;
      elBannerIn.className = 'rf-banner-in is-in';
      c.bannerPhase = 0;
      if (/SKULL|TAUNT|LAUGH/i.test(b.title) || /SKULL|TAUNT|LAUGH/i.test(b.sub)) triggerSkull();
    } else {
      bannerAge += dt;
      /* in -> hold -> out; the CSS animation does the easing. */
      if (bannerAge > bannerLife - 0.5 && c.bannerPhase === 0) {
        elBannerIn.className = 'rf-banner-in is-out';
        c.bannerPhase = 1;
      }
    }
  }

  function triggerSkull(): void {
    const now = performance.now();
    if (now - c.lastSkull < SKULL_COOLDOWN_MS) return;
    c.lastSkull = now;
    c.skullUntil = now + SKULL_MS;
    elSkull.classList.add('is-on');
  }

  function updateFeed(f: HudFrame, dt: number): void {
    const list = f.notifications;
    const len = list.length;
    for (let r = 0; r < FEED_ROWS; r++) {
      const row = feed[r];
      const idx = len - 1 - r;
      let want = -1;
      let eff = 0;
      if (idx >= 0) {
        const n = list[idx];
        /* `types.ts` says the UI advances `age`; a loop that ages them too (the game's
         * `tickUiTimers`) must not be double-counted, so the row keeps its own clock and
         * the effective age is whichever is further along. `n.age` is never mutated:
         * the game splices on `age > life` and would drop live entries. */
        const key = `${n.text}|${n.sub}|${n.team}|${n.kind}`;
        if (key !== row.key) {
          row.key = key;
          row.age = n.age;
        } else {
          row.age += dt;
        }
        eff = row.age > n.age ? row.age : n.age;
        const left = n.life - eff;
        want = left <= 0 ? -1 : eff < 0.05 ? 0 : left < 0.55 ? 2 : 1;
      }
      const n = idx >= 0 ? list[idx] : null;
      if (n) {
        if (n.text !== row.text) {
          row.text = n.text;
          row.txt.textContent = n.text;
        }
        if (n.sub !== row.subText) {
          row.subText = n.sub;
          row.sub.textContent = n.sub;
        }
        const col = feedColor(n.kind, n.team);
        if (col !== row.color) {
          row.color = col;
          row.el.style.setProperty('--c', col);
        }
        const icon = NOTIFY_ICON[n.kind] ?? GLYPH.rounds;
        if (icon !== row.icon) {
          row.icon = icon;
          row.ico.innerHTML = icon;
        }
      }
      if (want !== row.state) {
        row.state = want;
        row.el.className =
          want === -1 ? 'rf-feed-row' : want === 0 ? 'rf-feed-row' : want === 2 ? 'rf-feed-row is-in is-fading' : 'rf-feed-row is-in';
      }
    }
  }

  function updateRespawn(f: HudFrame): void {
    const dead = f.hud.status === 0;
    if (dead !== c.dead) {
      c.dead = dead;
      elRespawn.classList.toggle('is-on', dead);
      if (dead) {
        c.rspTag = f.twoPlayer ? `PLAYER ${f.playerIndex + 1}` : 'RESPAWN';
        elRspTag.textContent = c.rspTag;
        /* The enemy laughs when you burn — the modern nod to the 1995 taunt. */
        triggerSkull();
      }
    }
    if (!dead) return;

    const rsec = Math.ceil(f.hud.respawnT);
    if (rsec !== c.rspSec) {
      c.rspSec = rsec;
      elRspClock.textContent = mmss(f.hud.respawnT);
    }
    const ready = [f.team.readyJeep, f.team.readyTank, f.team.readyHrsv, f.team.readyHeli];
    for (let i = 0; i < rspSlots.length; i++) {
      const s = rspSlots[i];
      const v = clamp01(ready[i]);
      if (Math.abs(v - c.slotP[i]) > 0.01) {
        c.slotP[i] = v;
        s.fill.style.setProperty('--v', v.toFixed(3));
        s.lab.textContent = `${Math.round(v * 100)}%`;
      }
      const isReady = v >= 0.999;
      if (isReady !== c.slotReady[i]) {
        c.slotReady[i] = isReady;
        s.el.classList.toggle('is-ready', isReady);
      }
    }
  }

  function update(f: HudFrame): void {
    const now = performance.now();
    let dt = (now - lastNow) / 1000;
    if (dt < 0) dt = 0;
    if (dt > 0.12) dt = 0.12;
    lastNow = now;

    /* ---- player team (from the vehicle the HUD points at) ------------------ */
    let team = 0;
    let self: VehicleView | null = null;
    const vc = Math.min(f.vehicleCount, f.vehicles.length);
    for (let i = 0; i < vc; i++) {
      const v = f.vehicles[i];
      if (v.id === f.hud.vehicleId) {
        self = v;
        team = v.team === 1 ? 1 : 0;
        break;
      }
    }
    /* The simulation's `vehicleKind` is authoritative (it survives the frame where the
       vehicle list and the HUD pointer disagree); the live record only refines the team. */
    if (f.hud.vehicleKind > VKIND.NONE) setVehKind(f.hud.vehicleKind);
    else if (self) setVehKind(self.kind);
    const flip = team === 1;

    /* ---- top-left readout -------------------------------------------------- */
    const sc0 = flip ? f.score[1] : f.score[0];
    const sc1 = flip ? f.score[0] : f.score[1];
    if (sc0 !== c.score0) {
      c.score0 = sc0;
      elTopScore0.textContent = String(sc0);
      elBarScore0.textContent = String(sc0);
    }
    if (sc1 !== c.score1) {
      c.score1 = sc1;
      elTopScore1.textContent = String(sc1);
      elBarScore1.textContent = String(sc1);
    }
    if (f.roundsToWin !== c.rounds) {
      c.rounds = f.roundsToWin;
      elScoreCap.textContent = `TO ${f.roundsToWin}`;
    }
    /* The round has no time limit, so the clock counts ELAPSED time while playing and
       only becomes a countdown during the inter-round pause (matchState !== PLAYING). */
    const interRound = f.matchState !== 0;
    const clockSeconds = interRound ? Math.max(0, f.roundTimeLeft) : Math.max(0, f.time);
    const tsec = Math.ceil(clockSeconds);
    if (tsec !== c.timerSec) {
      c.timerSec = tsec;
      const tstr = mmss(clockSeconds);
      elTopTimer.textContent = tstr;
      elClockVal.textContent = tstr;
    }
    const caption = interRound ? 'NEXT ROUND' : 'ELAPSED';
    if (caption !== c.clockCaption) {
      c.clockCaption = caption;
      elClockCap.textContent = caption;
    }
    const low = interRound && f.roundTimeLeft <= 30;
    if (low !== c.timerLow) {
      c.timerLow = low;
      elTopTimer.classList.toggle('is-low', low);
      elClockVal.parentElement?.classList.toggle('is-low', low);
    }
    /* The hairline has nothing to fill while the clock counts up. */
    const barOn = interRound ? 1 : 0;
    if (barOn !== c.clockBarOn) {
      c.clockBarOn = barOn;
      elClockBar.classList.toggle('is-off', !interRound);
    }
    if (f.turretCount !== c.turrets) {
      c.turrets = f.turretCount;
      elTopTurrets.textContent = String(f.turretCount);
    }

    /* ---- armour / fuel / ammo --------------------------------------------- */
    const hud = f.hud;
    /* Every bar is a count over the capacity the *sim* reports for the vehicle we are in.
     * This used to guess: the primary magazine was "the fullest we have ever seen", falling
     * back to a generic 24 whenever the frame carried no live vehicle (dead, or waiting in the
     * garage). A jeep's sixteen grenades then read two-thirds full for the rest of the match,
     * because nothing could bring the ceiling back down - the "HUD isn't updating correctly"
     * report. `hpMax` and `fuelMax` were always authoritative; the ammo and mine capacities
     * now are too. */
    const hpF = hud.hpMax > 0 ? clamp01(hud.hp / hud.hpMax) : 0;
    const fuF = hud.fuelMax > 0 ? clamp01(hud.fuel / hud.fuelMax) : 0;
    const amF = hud.ammo0Max > 0 ? clamp01(hud.ammo0 / hud.ammo0Max) : 0;
    const bHp = band(hpF);
    const bFu = band(fuF);
    const bAm = band(amF);

    if (Math.abs(hpF - c.hpV) > 0.004) {
      c.hpV = hpF;
      rowFill[0].style.setProperty('--v', hpF.toFixed(3));
    }
    if (Math.abs(fuF - c.fuelV) > 0.004) {
      c.fuelV = fuF;
      rowFill[1].style.setProperty('--v', fuF.toFixed(3));
    }
    if (Math.abs(amF - c.ammoV) > 0.004) {
      c.ammoV = amF;
      rowFill[2].style.setProperty('--v', amF.toFixed(3));
    }
    if (bHp !== c.bandHp) {
      c.bandHp = bHp;
      if (bHp) rowTrack[0].classList.add(BAND_CLS[bHp]);
      else rowTrack[0].classList.remove('is-warn', 'is-crit');
      if (bHp) rowVal[0].classList.add(BAND_CLS[bHp]);
      else rowVal[0].classList.remove('is-warn', 'is-crit');
    }
    if (bFu !== c.bandFuel) {
      c.bandFuel = bFu;
      if (bFu) rowTrack[1].classList.add(BAND_CLS[bFu]);
      else rowTrack[1].classList.remove('is-warn', 'is-crit');
      if (bFu) rowVal[1].classList.add(BAND_CLS[bFu]);
      else rowVal[1].classList.remove('is-warn', 'is-crit');
    }
    if (bAm !== c.bandAmmo) {
      c.bandAmmo = bAm;
      if (bAm) rowTrack[2].classList.add(BAND_CLS[bAm]);
      else rowTrack[2].classList.remove('is-warn', 'is-crit');
      if (bAm) rowVal[2].classList.add(BAND_CLS[bAm]);
      else rowVal[2].classList.remove('is-warn', 'is-crit');
    }
    const hpTxt = String(Math.max(0, Math.round(hud.hp)));
    if (hpTxt !== c.hpTxt) {
      c.hpTxt = hpTxt;
      rowVal[0].textContent = hpTxt;
    }
    const fuTxt = String(Math.max(0, Math.round(hud.fuel)));
    if (fuTxt !== c.fuelTxt) {
      c.fuelTxt = fuTxt;
      rowVal[1].textContent = fuTxt;
    }
    const amTxt = String(Math.max(0, Math.round(hud.ammo0)));
    if (amTxt !== c.ammoTxt) {
      c.ammoTxt = amTxt;
      rowVal[2].textContent = amTxt;
    }

    /* ---- weapon counts ----------------------------------------------------- */
    if (hud.ammo0 !== c.ammo0) {
      c.ammo0 = hud.ammo0;
      wpnVal[0].textContent = String(hud.ammo0);
    }
    if (hud.ammo1 !== c.ammo1) {
      c.ammo1 = hud.ammo1;
      wpnVal[1].textContent = String(hud.ammo1);
    }
    if (hud.mines !== c.mines) {
      c.mines = hud.mines;
      wpnVal[2].textContent = String(hud.mines);
    }
    const mainEmpty = hud.ammo0 <= 0;
    if (mainEmpty !== c.mainEmpty) {
      c.mainEmpty = mainEmpty;
      wpnRow[0].classList.toggle('is-empty', mainEmpty);
    }
    const mainReload = self ? self.reload0 > 0 : false;
    if (mainReload !== c.mainReload) {
      c.mainReload = mainReload;
      wpnRow[0].classList.toggle('is-reloading', mainReload);
    }
    const altEmpty = hud.ammo1 <= 0;
    if (altEmpty !== c.altEmpty) {
      c.altEmpty = altEmpty;
      wpnRow[1].classList.toggle('is-empty', altEmpty);
    }
    const altReload = self ? self.reload1 > 0 : false;
    if (altReload !== c.altReload) {
      c.altReload = altReload;
      wpnRow[1].classList.toggle('is-reloading', altReload);
    }

    /* ---- vehicle tag (two-player split) ------------------------------------ */
    const roleSuffix = f.twoPlayer ? `P${f.playerIndex + 1}` : '';
    if (roleSuffix !== c.roleSuffix) {
      c.roleSuffix = roleSuffix;
      elVehRole.textContent = roleSuffix ? `${c.vehRole} · ${roleSuffix}` : c.vehRole;
    }

    /* ---- flag chip --------------------------------------------------------- */
    const fs = f.team.flagState;
    if (fs !== c.flagState) {
      c.flagState = fs;
      elFlagVal.textContent = FLAG_LABEL[fs] ?? '—';
      elFlagChip.style.setProperty('--c', FLAG_CLS[fs] ?? 'var(--ink-faint)');
      elFlagChip.classList.toggle('is-alert', fs === FLAGSTATE.CARRIED || fs === FLAGSTATE.CAPTURED);
    }

    /* ---- inter-round countdown bar (learned maximum) ----------------------- */
    if (interRound) {
      if (f.roundTimeLeft > c.timeMax + 0.5) c.timeMax = f.roundTimeLeft;
      const frac = clamp01(f.roundTimeLeft / Math.max(1, c.timeMax));
      if (Math.abs(frac - c.clockV) > 0.005) {
        c.clockV = frac;
        elClockFill.style.setProperty('--v', frac.toFixed(3));
      }
    }

    /* ---- transient layers -------------------------------------------------- */
    updateBanner(f, dt);
    updateFeed(f, dt);
    updateRespawn(f);
    mini.update(f);

    if (c.skullUntil && now > c.skullUntil) {
      c.skullUntil = 0;
      elSkull.classList.remove('is-on');
    }

    /* ---- debug chip (4 Hz) ------------------------------------------------- */
    if (f.showDebug) {
      if (!elDbg.classList.contains('is-on')) elDbg.classList.add('is-on');
      if (now > c.dbgNext) {
        c.dbgNext = now + 250;
        const txt = `${f.fps.toFixed(0)} fps  veh ${f.vehicleCount}  ${f.camera.x.toFixed(0)},${f.camera.z.toFixed(0)}  z${f.camera.zoom.toFixed(2)}  n${f.notifications.length}`;
        if (txt !== c.dbgTxt) {
          c.dbgTxt = txt;
          elDbg.textContent = txt;
        }
      }
    } else if (elDbg.classList.contains('is-on')) {
      elDbg.classList.remove('is-on');
    }
  }

  /* ---- lifecycle ----------------------------------------------------------- */
  function onResize(): void {
    applyScale();
  }
  function onSkullEvent(): void {
    triggerSkull();
  }

  container.appendChild(root);
  applyScale();
  mini.setSize(minimapSize(Math.max(0.68, scalePx)));
  window.addEventListener('resize', onResize);
  window.addEventListener('rf:skull', onSkullEvent as EventListener);

  return {
    update,
    setVisible(visible: boolean): void {
      root.classList.toggle('is-hidden', !visible);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('rf:skull', onSkullEvent as EventListener);
      mini.dispose();
      root.remove();
    },
  };
}
