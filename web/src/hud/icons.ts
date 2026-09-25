/**
 * Inline SVG art used by the DOM UI: vehicle silhouettes (HUD + garage cards),
 * the taunt skull and a handful of 12px HUD glyphs.
 *
 * Everything is a plain string so it can be dropped into a template literal once at
 * construction time — nothing here is ever touched inside `update()`.
 */
import { VKIND } from '../sim/layout.js';

/* ------------------------------------------------------------- silhouettes (side view) */

/** All silhouettes are authored on a 64x32 grid, +x = forward (to the right). */
const SIL: Record<number, string> = {
  /* M151 MUTT — open-top scout jeep with a pintle gun. */
  [VKIND.JEEP]: `
    <circle cx="16" cy="24.5" r="5.2"/><circle cx="47" cy="24.5" r="5.2"/>
    <path d="M4.5 21.4 L7 15.6 L21.5 14.8 L25.6 8.8 L30.4 8.8 L31.4 14.8 L57 15.8 L59.5 21.4 Z"/>
    <path d="M31.6 8.2 L45 5.4 L45.4 6.6 L32.4 9.4 Z"/>`,
  /* M60 Patton — hull, turret, long 120mm barrel, track run. */
  [VKIND.TANK]: `
    <rect x="4.5" y="19" width="55" height="9.4" rx="4.7"/>
    <path d="M10.5 19 L13.5 12.6 L50.5 12.6 L54 19 Z"/>
    <path d="M23.5 12.6 L26.5 6.6 L41.5 6.6 L44 12.6 Z"/>
    <rect x="42" y="7.6" width="20" height="2.6" rx="1.3"/>`,
  /* M270 MLRS — boxy tracked launcher with a raised rocket pack. */
  [VKIND.HRSV]: `
    <rect x="4.5" y="19.5" width="55" height="8.8" rx="4.4"/>
    <path d="M6.5 19.5 L8.5 12.4 L51 12.4 L56.5 19.5 Z"/>
    <path d="M11 12.4 L13.8 5.6 L25 5.6 L26.6 12.4 Z"/>
    <rect x="28.5" y="4.6" width="21" height="7.8" rx="1.6"/>
    <rect x="30" y="6" width="18" height="1.5" rx="0.75"/>
    <rect x="30" y="9" width="18" height="1.5" rx="0.75"/>`,
  /* AH-1 Cobra — gunship: nose right, tail boom left, rotor disc line. */
  [VKIND.HELI]: `
    <path d="M29 11.6 L46 11.6 L54 15.4 L57 19.6 L46 22.2 L29 22.2 L23.6 18.4 L23.6 14.2 Z"/>
    <path d="M23.6 16.4 L6 14.2 L6 17.4 L23.6 19.6 Z"/>
    <path d="M6 14.2 L2.6 8.4 L6.2 8.4 L9 14.2 Z"/>
    <rect x="35.5" y="5.4" width="2.2" height="6.4"/>
    <rect x="22" y="4.4" width="30" height="1.7" rx="0.85"/>
    <rect x="33" y="18" width="12" height="4.4" rx="1.4"/>
    <rect x="29" y="24" width="20" height="1.6" rx="0.8"/>
    <rect x="32" y="22.2" width="1.6" height="2.4"/>
    <rect x="44" y="22.2" width="1.6" height="2.4"/>`,
};

/** Fallback for kinds the HUD has no art for (troop, drone, sub, none). */
const SIL_OTHER = `
  <path d="M8 21 L12 13 L52 13 L56 21 Z"/>
  <circle cx="17" cy="24.5" r="4.6"/><circle cx="47" cy="24.5" r="4.6"/>`;

/** Outer markup for a 64x32 silhouette; `cls` styles it (colour, size). */
export function silhouetteSvg(kind: number, cls: string): string {
  const body = SIL[kind] ?? SIL_OTHER;
  return `<svg class="${cls}" viewBox="0 0 64 32" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Short display names, mirroring the Rust spec table (`spec.rs`). */
export const VEHICLE_NAME: Record<number, string> = {
  [VKIND.JEEP]: 'M151 MUTT',
  [VKIND.TANK]: 'M60 PATTON',
  [VKIND.HRSV]: 'M270 MLRS',
  [VKIND.HELI]: 'AH-1 COBRA',
  [VKIND.TROOP]: 'INFANTRY',
  [VKIND.DRONE]: 'RECON DRONE',
  [VKIND.SUB]: 'SUBMARINE',
  [VKIND.NONE]: 'ON FOOT',
};

/** One-line role blurb used by the garage cards and the HUD tooltip. */
export const VEHICLE_ROLE: Record<number, string> = {
  [VKIND.JEEP]: 'Fast recon. Light armour, chain gun, carries the flag.',
  [VKIND.TANK]: 'Main battle. Heavy plate, 120mm, slow but unstoppable.',
  [VKIND.HRSV]: 'Rocket support. Heat-seeking missiles, mines, thin skin.',
  [VKIND.HELI]: 'Air cavalry. Flies over water, rockets and chain gun.',
  [VKIND.TROOP]: 'Dismounted crew. Fragile, but hard to spot.',
  [VKIND.DRONE]: 'Unarmed eye in the sky.',
  [VKIND.SUB]: 'Coastal raider.',
  [VKIND.NONE]: 'No vehicle assigned.',
};

/* ------------------------------------------------------------------------ skull (taunt) */

/** Clean vector skull, 64x64 grid. Filled with `currentColor`, sockets knocked out. */
export const SKULL_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <path class="rf-skull-bone" d="M32 3.4c-14.7 0-24.6 10.4-24.6 24 0 7.8 3.5 13.6 8.9 17.1l1.2.8v6.9c0 2.9 2.4 5.3 5.3 5.3h3.6l1.7-4.9h7.8l1.7 4.9h3.6c2.9 0 5.3-2.4 5.3-5.3v-6.9l1.2-.8c5.4-3.5 8.9-9.3 8.9-17.1 0-13.6-9.9-24-24.6-24Z"/>
  <ellipse class="rf-skull-hole" cx="22.6" cy="27.2" rx="6.9" ry="7.8"/>
  <ellipse class="rf-skull-hole" cx="41.4" cy="27.2" rx="6.9" ry="7.8"/>
  <path class="rf-skull-hole" d="M32 33.6l4 8.4h-8l4-8.4Z"/>
  <path class="rf-skull-teeth" d="M25.4 46.6v5.6M32 46.6v5.6M38.6 46.6v5.6"/>
</svg>`;

/* ------------------------------------------------------------------------ HUD glyphs (12x12) */

const glyph = (body: string): string =>
  `<svg class="rf-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">${body}</svg>`;

export const GLYPH = {
  clock: glyph('<circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.2V6l2 1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'),
  turret: glyph('<path d="M3 4.6h6l1.2 2.2H1.8L3 4.6Z"/><rect x="4.4" y="7.6" width="3.2" height="2.6" rx="0.6"/><rect x="5.4" y="2.2" width="6" height="1.4" rx="0.7"/>'),
  flag: glyph('<path d="M2.6 11V1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M3.4 1.8h6.4L7.6 4.4l2.2 2.6H3.4V1.8Z"/>'),
  mine: glyph('<circle cx="6" cy="6" r="2.9"/><path d="M6 1v1.6M6 9.4V11M1 6h1.6M9.4 6H11M2.5 2.5l1.1 1.1M8.4 8.4l1.1 1.1M9.5 2.5L8.4 3.6M3.6 8.4 2.5 9.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" fill="none"/>'),
  shield: glyph('<path d="M6 1.2 10.2 2.6v3.6c0 2.6-1.8 4.2-4.2 5-2.4-.8-4.2-2.4-4.2-5V2.6L6 1.2Z" fill="none" stroke="currentColor" stroke-width="1.2"/>'),
  drop: glyph('<path d="M6 1.4s3.4 4 3.4 6.1A3.4 3.4 0 0 1 6 10.9a3.4 3.4 0 0 1-3.4-3.4C2.6 5.4 6 1.4 6 1.4Z" fill="none" stroke="currentColor" stroke-width="1.2"/>'),
  rounds: glyph('<rect x="1.4" y="3.6" width="9.2" height="4.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.6 3.6v4.8M6 3.6v4.8M8.4 3.6v4.8" stroke="currentColor" stroke-width="1"/>'),
  warn: glyph('<path d="M6 1.6 11 10.4H1L6 1.6Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 4.6v2.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6" cy="9" r="0.7"/>'),
  close: glyph('<path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'),
} as const;

export type GlyphName = keyof typeof GLYPH;
