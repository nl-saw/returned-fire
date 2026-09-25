/**
 * Audio preview + verification page.
 *
 * Left column: live controls for every SFX, engine, loop and theme (real AudioContext,
 * started by the first click). Right column: the offline render report — every SFX and
 * theme rendered through an OfflineAudioContext, measured, asserted, and printed to the
 * console / `window.__AUDIO_REPORT__`. `window.__READY__` flips to true when the report is
 * complete so the headless screenshot harness can wait for it.
 */
import type { EngineKind, SfxName, ThemeName } from '../src/assets/types';
import { createGameAudio, MAX_VOICES, type GameAudioHandle } from '../src/audio/audio';
import { SFX_NAMES } from '../src/audio/sfx';
import { THEME_DEFS, THEME_ORDER, themeLoopSeconds } from '../src/audio/music';
import { formatReport, runAudioChecks, type AudioReport } from './audio-check';

declare global {
  interface Window {
    __READY__?: boolean;
    __AUDIO_REPORT__?: AudioReport;
    __LIVE__?: { state: string; voices: number; maxVoices: number; engine: string; theme: string | null; demo: boolean };
  }
}

const ENGINE_KINDS: readonly EngineKind[] = ['none', 'jeep', 'tank', 'hrsv', 'heli', 'drone'];
const LOOP_NAMES = ['rotor', 'tracks', 'drone'] as const;

const audio: GameAudioHandle = createGameAudio();
let engineKind: EngineKind = 'none';
let load = 0.7;
let throttle = 0.7;
let loopName: (typeof LOOP_NAMES)[number] | null = null;
let loopLoad = 0.7;
let theme: ThemeName | null = null;
let demoTimers: number[] = [];
let demoRunning = false;

/* ------------------------------------------------------------------- helpers */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; text?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, text, ...rest } = props as { class?: string; text?: string };
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  Object.assign(node, rest);
  for (const c of children) node.append(c);
  return node;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: cls, text: label });
  b.addEventListener('click', () => {
    void audio.resume().then(onClick);
  });
  return b;
}

function section(title: string, kids: (Node | string)[]): HTMLElement {
  return el('section', { class: 'card' }, [el('h2', { text: title }), ...kids]);
}

const status = el('div', { class: 'status', text: 'booting…' });
function setStatus(msg: string): void {
  status.textContent = msg;
}

/* ---------------------------------------------------------------- live panel */

const sfxGrid = el('div', { class: 'grid' });
for (const name of SFX_NAMES) {
  sfxGrid.append(
    button(name, () => {
      // positional: somewhere in the 256 m world, listener parked 55 m up
      const a = Math.random() * Math.PI * 2;
      const r = 20 + Math.random() * 90;
      audio.setListener({ x: 0, y: 55, z: 0 }, 0);
      audio.play(name as SfxName, { x: Math.cos(a) * r, y: 2, z: Math.sin(a) * r });
      setStatus(`sfx ${name} @ ${r.toFixed(0)} m`);
    }),
  );
}

const NON_POSITIONAL: readonly SfxName[] = ['uiClick', 'uiHover', 'laugh', 'alarm', 'buildDone', 'resupply'];
const sfxFlat = el('div', { class: 'grid' });
for (const name of NON_POSITIONAL) {
  sfxFlat.append(
    button(`${name} (2D)`, () => {
      audio.play(name);
      setStatus(`sfx ${name} (non-positional)`);
    }),
  );
}

const engineGrid = el('div', { class: 'grid' });
for (const kind of ENGINE_KINDS) {
  engineGrid.append(
    button(kind, () => {
      engineKind = kind;
      setStatus(`engine ${kind}`);
    }, kind === 'none' ? 'warn' : ''),
  );
}

const loopGrid = el('div', { class: 'grid' });
for (const name of LOOP_NAMES) {
  loopGrid.append(
    button(name, () => {
      loopName = name;
      setStatus(`loop ${name}`);
    }),
  );
}
loopGrid.append(
  button('loop off', () => {
    loopName = null;
    setStatus('loop off');
  }, 'warn'),
);

const themeGrid = el('div', { class: 'grid' });
for (const t of THEME_ORDER) {
  const def = THEME_DEFS[t];
  themeGrid.append(
    button(`${t} — ${def.label}`, () => {
      theme = t;
      audio.playTheme(t);
      setStatus(`theme ${t} (${def.label}, ${def.key}, ${themeLoopSeconds(def).toFixed(1)} s loop)`);
    }),
  );
}
themeGrid.append(
  button('theme off', () => {
    theme = null;
    audio.playTheme(null);
    setStatus('theme off');
  }, 'warn'),
);
const stingGrid = el('div', { class: 'grid' });
for (const t of THEME_ORDER) {
  stingGrid.append(
    button(`sting ${t}`, () => {
      audio.sting(t);
      setStatus(`sting ${t}`);
    }),
  );
}

const loadSlider = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(load) });
loadSlider.addEventListener('input', () => {
  load = Number(loadSlider.value);
});
const thrSlider = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(throttle) });
thrSlider.addEventListener('input', () => {
  throttle = Number(thrSlider.value);
});
const loopSlider = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(loopLoad) });
loopSlider.addEventListener('input', () => {
  loopLoad = Number(loopSlider.value);
});
const masterSlider = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0.9' });
masterSlider.addEventListener('input', () => audio.setMasterVolume(Number(masterSlider.value)));
const musicSlider = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '1' });
musicSlider.addEventListener('input', () => audio.setMusicVolume(Number(musicSlider.value)));

const volRow = el('div', { class: 'row' }, [
  el('label', { text: `load ${load.toFixed(2)}` }),
  loadSlider,
  el('label', { text: `throttle ${throttle.toFixed(2)}` }),
  thrSlider,
]);
const loopRow = el('div', { class: 'row' }, [el('label', { text: 'loop load' }), loopSlider]);
const volRow2 = el('div', { class: 'row' }, [
  el('label', { text: 'master' }),
  masterSlider,
  el('label', { text: 'music' }),
  musicSlider,
]);

/* --------------------------------------------------------------- auto demo */

const DEMO: { label: string; ms: number; run: () => void }[] = [
  { label: 'ui click', ms: 250, run: () => audio.play('uiClick') },
  { label: 'ui hover', ms: 250, run: () => audio.play('uiHover') },
  { label: 'jeep engine + william tell', ms: 4000, run: () => { engineKind = 'jeep'; theme = 'jeep'; audio.setEngine('jeep', 0.6, 0.7); audio.playTheme('jeep'); } },
  { label: 'tank gun', ms: 900, run: () => { audio.play('gunTank', { x: 8, y: 1, z: 10 }); } },
  { label: 'chain gun', ms: 900, run: () => audio.play('gunChain', { x: 12, y: 2, z: 6 }) },
  { label: 'tank engine + mars', ms: 4500, run: () => { engineKind = 'tank'; theme = 'tank'; audio.setEngine('tank', 0.7, 0.6); audio.setLoop('tracks', 0.6); audio.playTheme('tank'); } },
  { label: 'rocket launch', ms: 1200, run: () => audio.play('rocketLaunch', { x: -14, y: 2, z: 12 }) },
  { label: 'explosion small', ms: 900, run: () => audio.play('explosionSmall', { x: -18, y: 0, z: 16 }) },
  { label: 'explosion big (ducks music)', ms: 1800, run: () => audio.play('explosionBig', { x: -20, y: 0, z: 18 }) },
  { label: 'hrsv engine + dies irae', ms: 4500, run: () => { engineKind = 'hrsv'; theme = 'hrsv'; audio.setLoop(null, 0); audio.setEngine('hrsv', 0.8, 0.5); audio.playTheme('hrsv'); } },
  { label: 'mine drop + mine blast', ms: 2200, run: () => { audio.play('mineDrop', { x: 6, y: 0, z: 6 }); audio.play('mineBlast', { x: 10, y: 0, z: 10 }); } },
  { label: 'heli engine + valkyries', ms: 4500, run: () => { engineKind = 'heli'; theme = 'heli'; audio.setLoop('rotor', 0.7); audio.setEngine('heli', 0.6, 0.8); audio.playTheme('heli'); } },
  { label: 'tower fire + impacts', ms: 1600, run: () => { audio.play('towerFire', { x: 30, y: 6, z: -20 }); audio.play('impactMetal', { x: 4, y: 1, z: -4 }); audio.play('impactGround', { x: -6, y: 0, z: -8 }); } },
  { label: 'water impact + sub launch', ms: 2600, run: () => { audio.play('impactWater', { x: 40, y: 0, z: 40 }); audio.play('subLaunch', { x: 60, y: 0, z: 20 }); } },
  { label: 'flag pickup + william tell', ms: 3500, run: () => { theme = 'flag'; audio.play('flagPickup'); audio.playTheme('flag'); } },
  { label: 'flag capture', ms: 1800, run: () => { audio.play('flagCapture'); audio.sting('victory'); } },
  { label: 'drone + laugh + alarm', ms: 3500, run: () => { engineKind = 'drone'; audio.setLoop('drone', 0.6); audio.setEngine('drone', 0.7, 0.7); audio.play('laugh'); audio.play('alarm'); } },
  { label: 'bail out + resupply + build + bridge', ms: 3500, run: () => { audio.play('bailOut'); audio.play('resupply'); audio.play('buildDone'); audio.play('bridgeCollapse', { x: -30, y: 0, z: -30 }); } },
  { label: 'defeat sting + title theme', ms: 4000, run: () => { engineKind = 'none'; audio.setEngine('none', 0, 0); audio.setLoop(null, 0); audio.sting('defeat'); theme = 'title'; audio.playTheme('title'); } },
  { label: 'demo complete', ms: 500, run: () => { audio.playTheme(null); theme = null; } },
];

function stopDemo(): void {
  for (const t of demoTimers) window.clearTimeout(t);
  demoTimers = [];
  demoRunning = false;
}

async function runDemo(): Promise<void> {
  stopDemo();
  demoRunning = true;
  await audio.resume();
  audio.setMasterVolume(Number(masterSlider.value));
  audio.setMusicVolume(Number(musicSlider.value));
  audio.setListener({ x: 0, y: 55, z: 0 }, 0);
  let at = 0;
  DEMO.forEach((step, i) => {
    at += i === 0 ? 0 : DEMO[i - 1].ms;
    demoTimers.push(
      window.setTimeout(() => {
        setStatus(`demo: ${step.label}`);
        step.run();
      }, at),
    );
  });
  demoTimers.push(
    window.setTimeout(() => {
      demoRunning = false;
      setStatus('demo complete — engine idle, theme stopped');
    }, at + DEMO[DEMO.length - 1].ms + 100),
  );
}

const demoBtn = button('▶ auto demo', () => {
  void runDemo();
});
const suspendBtn = button('⏸ suspend()', () => {
  stopDemo();
  audio.suspend();
  setStatus('suspended — context frozen, timers cleared');
}, 'warn');
const resumeBtn = button('⏵ resume()', () => {
  void audio.resume().then(() => setStatus('resumed'));
});
const stopBtn = button('■ stop all', () => {
  stopDemo();
  engineKind = 'none';
  loopName = null;
  theme = null;
  audio.setEngine('none', 0, 0);
  audio.setLoop(null, 0);
  audio.playTheme(null);
  setStatus('stopped');
}, 'warn');

/* ------------------------------------------------------------- report panel */

const reportPre = el('pre', { class: 'report', text: 'running offline render checks…' });
const summary = el('div', { class: 'summary', text: 'offline checks: running' });

function renderReport(report: AudioReport): void {
  summary.textContent = report.ok
    ? `offline checks: ALL PASS (${report.counts.sfx} SFX, ${report.counts.themes} themes, ${report.checks.length} assertions)`
    : `offline checks: ${report.failures.length} FAILURES`;
  summary.classList.toggle('bad', !report.ok);
  reportPre.textContent = formatReport(report).join('\n');
}

/* --------------------------------------------------------------------- boot */

const app = document.getElementById('app');
if (app) {
  app.append(
    el('header', {}, [
      el('h1', { text: 'RETURNED FIRE — audio engine' }),
      status,
      el('div', { class: 'row' }, [demoBtn, stopBtn, suspendBtn, resumeBtn]),
    ]),
    el('main', {}, [
      el('div', { class: 'col' }, [
        section('SFX (positional, 256 m world)', [sfxGrid]),
        section('SFX (2D / non-positional)', [sfxFlat]),
        section('Engine (one persistent voice per kind)', [engineGrid, volRow]),
        section('Loops', [loopGrid, loopRow]),
        section('Themes', [themeGrid]),
        section('Stings (one-shot, non-looping)', [stingGrid]),
        section('Mix', [volRow2]),
      ]),
      el('div', { class: 'col' }, [section('Offline render report', [summary, reportPre])]),
    ]),
  );
}

// live status + the per-frame engine drive the game itself would do
let lastStatus = 0;
function frame(now: number): void {
  const state = audio.contextState();
  if (state === 'running') {
    audio.setEngine(engineKind, load, throttle);
    audio.setLoop(loopName, loopLoad);
  }
  window.__LIVE__ = {
    state,
    voices: audio.voiceCount(),
    maxVoices: MAX_VOICES,
    engine: engineKind,
    theme,
    demo: demoRunning,
  };
  if (now - lastStatus > 250) {
    lastStatus = now;
    if (!demoRunning) {
      document.title = `audio ${state} voices=${audio.voiceCount()}`;
      status.dataset.meta = `ctx=${state} voices=${audio.voiceCount()} engine=${engineKind} theme=${theme ?? 'none'}`;
    } else {
      status.dataset.meta = `ctx=${state} voices=${audio.voiceCount()} demo running`;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

void (async () => {
  try {
    const report = await runAudioChecks();
    window.__AUDIO_REPORT__ = report;
    renderReport(report);
    for (const line of formatReport(report)) console.log(line);
    // the shot harness only forwards warnings/errors, so surface the verdict there too
    console.warn(
      `AUDIO REPORT ${report.ok ? 'ALL CHECKS PASS' : `FAILURES: ${report.failures.length}`} | ` +
        `sfx=${report.counts.sfx} themes=${report.counts.themes} | ` +
        `centroid ${report.distinctness.minCentroid.toFixed(0)}..${report.distinctness.maxCentroid.toFixed(0)} Hz (median ${report.distinctness.medianCentroid.toFixed(0)}), ` +
        `near-identical pairs=${report.distinctness.similarPairs.length}, max band cosine=${report.distinctness.maxBandCosine.toFixed(4)} | ` +
        `pitch ok=${Object.values(report.pitch).filter((p) => p.ok).length}/${report.counts.themes}`,
    );
    if (!report.ok) console.warn(`AUDIO FAILURES: ${report.failures.join(' | ')}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    window.__AUDIO_REPORT__ = {
      ok: false,
      generatedAt: new Date().toISOString(),
      sampleRate: 0,
      counts: { sfx: 0, themes: 0 },
      sfx: {},
      themes: {},
      pitch: {},
      distinctness: { minCentroid: 0, maxCentroid: 0, medianCentroid: 0, similarPairs: [], maxBandCosine: 0, mostSimilarPair: '' },
      checks: [],
      failures: [`harness threw: ${message}`],
    };
    reportPre.textContent = `harness error: ${message}`;
    console.warn(`AUDIO HARNESS ERROR: ${message}`);
  } finally {
    window.__READY__ = true;
  }
})();
