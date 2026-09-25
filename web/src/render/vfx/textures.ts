/**
 * Procedural effect textures — everything the VFX layer draws is generated on a canvas at
 * start-up, so the game ships no image assets.
 *
 * Sprite textures carry *shape* (alpha) plus a little internal luminance detail; the actual
 * colour of a particle comes from its per-particle colour ramp, which keeps every effect
 * tintable (hot fire, tan dust, white spray) from one shared shader.
 */
import * as THREE from 'three';
import { clamp, fbm2, smoothstep } from './rand.js';

export type SpriteKind = 'fire' | 'smoke' | 'dust' | 'spark' | 'spray' | 'tracer' | 'ring' | 'foam' | 'scorch';

function canvasTexture(size: number, fill: (d: Uint8ClampedArray, s: number) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('vfx: 2d canvas unavailable');
  const img = ctx.createImageData(size, size);
  fill(img.data, size);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  // Our data is authored as linear multipliers, not sRGB pixels.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 1x1 white texture, used to keep every sampler bound even when a family ignores it. */
export function makeWhiteTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export function makeSprite(kind: SpriteKind): THREE.CanvasTexture {
  switch (kind) {
    case 'fire':
      return canvasTexture(128, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;
            const px = u * 2 - 1;
            const py = v * 2 - 1;
            const r = Math.sqrt(px * px + py * py);
            // Ragged edge so the fireball is never a clean disc.
            const wob = 1 + 0.30 * (fbm2(u * 3.1, v * 3.1, 17, 3) - 0.5) * 2;
            const rr = r * wob;
            const body = Math.pow(clamp(1 - rr, 0, 1), 1.7);
            const core = Math.pow(clamp(1 - r * 2.05, 0, 1), 1.6);
            const a = clamp(body * 0.95 + core * 0.35, 0, 1);
            const lum = 1 - 0.28 * clamp(rr, 0, 1);
            const i = (y * s + x) * 4;
            d[i] = 255 * lum;
            d[i + 1] = 255 * lum * (1 - 0.10 * clamp(rr, 0, 1));
            d[i + 2] = 255 * lum * (1 - 0.20 * clamp(rr, 0, 1));
            d[i + 3] = 255 * a;
          }
        }
      });

    case 'smoke':
      return canvasTexture(128, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;
            const px = u * 2 - 1;
            const py = v * 2 - 1;
            const r = Math.sqrt(px * px + py * py);
            // Billowing structure: two noise octaves sheared so puffs read as volume.
            const n1 = fbm2(u * 3.4 + 1.3, v * 3.4 - 0.7, 91, 5);
            const n2 = fbm2(u * 7.9 - 2.1, v * 7.9 + 3.3, 23, 3);
            const n = clamp(n1 * 0.7 + n2 * 0.5, 0, 1);
            const mask = smoothstep(1.02, 0.16, r);
            const a = clamp(mask * (0.30 + 1.05 * n), 0, 1);
            const lum = 0.62 + 0.38 * n;
            const i = (y * s + x) * 4;
            d[i] = 255 * lum;
            d[i + 1] = 255 * lum;
            d[i + 2] = 255 * lum;
            d[i + 3] = 255 * a;
          }
        }
      });

    case 'dust':
      return canvasTexture(128, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;
            const px = u * 2 - 1;
            const py = v * 2 - 1;
            const r = Math.sqrt(px * px + py * py);
            const n = fbm2(u * 6.2, v * 6.2, 55, 4);
            const grain = fbm2(u * 18.0, v * 18.0, 7, 2);
            const mask = Math.pow(smoothstep(1.0, 0.02, r), 1.15);
            const a = clamp(mask * (0.66 + 0.46 * n) * (0.9 + 0.15 * grain), 0, 1);
            const lum = 0.88 + 0.12 * n;
            const i = (y * s + x) * 4;
            d[i] = 255 * lum;
            d[i + 1] = 255 * lum;
            d[i + 2] = 255 * lum;
            d[i + 3] = 255 * a;
          }
        }
      });

    case 'spark':
      return canvasTexture(64, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const px = ((x + 0.5) * inv) * 2 - 1;
            const py = ((y + 0.5) * inv) * 2 - 1;
            const r = Math.sqrt(px * px + py * py);
            const core = Math.pow(clamp(1 - r * 2.5, 0, 1), 2.0);
            const halo = Math.pow(clamp(1 - r, 0, 1), 1.5);
            const a = clamp(core + 0.20 * halo, 0, 1);
            const i = (y * s + x) * 4;
            d[i] = 255;
            d[i + 1] = 255 * (0.92 + 0.08 * core);
            d[i + 2] = 255 * (0.80 + 0.20 * core);
            d[i + 3] = 255 * a;
          }
        }
      });

    case 'spray':
      // Water: a tight droplet head with a soft mist halo.
      return canvasTexture(64, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const px = ((x + 0.5) * inv) * 2 - 1;
            const py = ((y + 0.5) * inv) * 2 - 1;
            const r = Math.sqrt(px * px + py * py);
            const core = Math.pow(clamp(1 - r * 1.75, 0, 1), 2.3);
            const halo = Math.pow(clamp(1 - r, 0, 1), 1.7);
            const a = clamp(core * 0.92 + 0.32 * halo, 0, 1);
            const lum = 0.86 + 0.14 * core;
            const i = (y * s + x) * 4;
            d[i] = 255 * lum;
            d[i + 1] = 255 * lum;
            d[i + 2] = 255;
            d[i + 3] = 255 * a;
          }
        }
      });

    case 'tracer':
      // u = across the streak, v = along it (v = 1 is the head).
      return canvasTexture(64, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const u = (x + 0.5) * inv;
            const along = (y + 0.5) * inv;
            const halfWidth = 0.30 + 0.52 * along;
            const w = Math.abs(u - 0.5) / (halfWidth * 0.5 * 2);
            const core = Math.pow(clamp(1 - w, 0, 1), 2.0);
            const glow = Math.pow(clamp(1 - w * 0.55, 0, 1), 4.0);
            const fade = 0.06 + 0.94 * Math.pow(along, 1.8);
            const tip = 0.6 * clamp((along - 0.86) / 0.14, 0, 1);
            const a = clamp((core * fade + 0.45 * glow * fade) + tip * core, 0, 1);
            const i = (y * s + x) * 4;
            d[i] = 255;
            d[i + 1] = 255 * (0.86 + 0.14 * core);
            d[i + 2] = 255 * (0.60 + 0.40 * core);
            d[i + 3] = 255 * a;
          }
        }
      });

    case 'ring':
      return canvasTexture(128, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;
            const px = u * 2 - 1;
            const py = v * 2 - 1;
            const r = Math.sqrt(px * px + py * py);
            const ang = Math.atan2(py, px);
            // Slightly irregular blast front.
            const wob = 1 + 0.05 * (fbm2(Math.cos(ang) * 2 + 4, Math.sin(ang) * 2 + 9, 31, 3) - 0.5) * 2;
            const rr = r * wob;
            const front = Math.exp(-Math.pow((rr - 0.84) / 0.085, 2));
            const wash = 0.30 * Math.exp(-Math.pow((rr - 0.52) / 0.30, 2)) * smoothstep(0.0, 0.35, rr);
            const a = clamp(front + wash, 0, 1) * smoothstep(1.0, 0.96, r);
            const i = (y * s + x) * 4;
            d[i] = 255;
            d[i + 1] = 255 * (0.86 + 0.14 * front);
            d[i + 2] = 255 * (0.66 + 0.34 * front);
            d[i + 3] = 255 * a;
          }
        }
      });

    case 'foam':
      return canvasTexture(128, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;
            const px = u * 2 - 1;
            const py = v * 2 - 1;
            const r = Math.sqrt(px * px + py * py);
            const n = fbm2(u * 8.5, v * 8.5, 71, 4);
            const band = Math.exp(-Math.pow((r - 0.70) / 0.20, 2));
            const a = clamp(band * (0.42 + 0.80 * n), 0, 1) * smoothstep(1.0, 0.94, r);
            const lum = 0.82 + 0.18 * n;
            const i = (y * s + x) * 4;
            d[i] = 255 * lum;
            d[i + 1] = 255 * lum;
            d[i + 2] = 255;
            d[i + 3] = 255 * a;
          }
        }
      });

    case 'scorch':
      // Ground burn: rgb is a *display-space* multiplier (decoded with pow 2.2 in the shader),
      // alpha is how strongly it is applied.
      return canvasTexture(256, (d, s) => {
        const inv = 1 / s;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;
            const px = u * 2 - 1;
            const py = v * 2 - 1;
            const r = Math.sqrt(px * px + py * py);
            const wob = 1 + 0.26 * (fbm2(u * 2.6, v * 2.6, 13, 4) - 0.5) * 2;
            const rr = r * wob;
            const edge = smoothstep(1.0, 0.62, rr);
            const blotch = 0.55 + 0.55 * fbm2(u * 5.5, v * 5.5, 3, 4);
            const a = clamp(edge * blotch, 0, 1);
            // Soot in the middle, a ring of scuffed dirt at the rim.
            const soot = 1 - smoothstep(0.30, 0.92, rr);
            const rim = Math.exp(-Math.pow((rr - 0.80) / 0.16, 2));
            const lum = clamp(0.30 + 0.42 * rim - 0.22 * soot + 0.10 * fbm2(u * 9, v * 9, 41, 3), 0.06, 1);
            const i = (y * s + x) * 4;
            d[i] = 255 * lum;
            d[i + 1] = 255 * lum * 0.90;
            d[i + 2] = 255 * lum * 0.78;
            d[i + 3] = 255 * a;
          }
        }
      });
  }
}

export function disposeSprite(t: THREE.Texture): void {
  t.dispose();
}
