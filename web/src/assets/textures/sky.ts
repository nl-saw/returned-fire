/**
 * Equirectangular sky: one procedural pass that provides both `scene.background` and the
 * PMREM environment, plus the sun vector the renderer needs so the directional light and
 * the painted sun disc agree.
 *
 * Coordinate conventions (they matter, and they are easy to get wrong):
 *  - three.js equirect sampling uses `u = atan2(z, x) / 2PI + 0.5` and
 *    `v = asin(y) / PI + 0.5`, so v = 1 is straight up.
 *  - The texture is a `DataTexture` (`flipY = false`), so row 0 is v = 0 (straight down).
 *  - Azimuth is therefore measured in the XZ plane from +X towards +Z, elevation from the
 *    horizon: `dir = (cos(el)cos(az), sin(el), cos(el)sin(az))`.
 *
 * The map is authored display-referred (sRGB): three renders an sRGB background without
 * tone mapping, so what is painted is what the player sees. PMREM converts it to linear
 * light for the environment, which keeps the IBL consistent with the backdrop.
 */
import * as THREE from 'three';
import { srgb8 } from './canvas';
import { noiseField, stretchV, type Field } from './noise';
import type { SkyOptions } from '../types';

export interface SkyTextureOptions extends SkyOptions {
  /** Equirect width; height is half of it. Default 1024. */
  width?: number;
}

const DEG = Math.PI / 180;

/** Default afternoon sun: high enough for hard shadows, low enough to stay warm. */
const DEFAULT_AZIMUTH = 38;
const DEFAULT_ELEVATION = 41;
const DEFAULT_TURBIDITY = 0.35;
const DEFAULT_HAZE = 0.5;
const DEFAULT_EXPOSURE = 1;

interface SkyParams {
  azimuth: number;
  elevation: number;
  turbidity: number;
  haze: number;
  exposure: number;
}

function params(opts?: SkyOptions): SkyParams {
  return {
    azimuth: opts?.sunAzimuth ?? DEFAULT_AZIMUTH,
    elevation: opts?.sunElevation ?? DEFAULT_ELEVATION,
    turbidity: Math.max(0, Math.min(1, opts?.turbidity ?? DEFAULT_TURBIDITY)),
    haze: Math.max(0, Math.min(1.5, opts?.haze ?? DEFAULT_HAZE)),
    exposure: opts?.exposure ?? DEFAULT_EXPOSURE,
  };
}

/**
 * Unit vector pointing from the world origin *towards* the sun. Assign it straight to the
 * directional light: `light.position.copy(sunDirection(opts)).multiplyScalar(200)`.
 */
export function sunDirection(opts?: SkyOptions): { x: number; y: number; z: number } {
  const p = params(opts);
  const az = p.azimuth * DEG;
  const el = Math.max(-5, Math.min(89.5, p.elevation)) * DEG;
  const ce = Math.cos(el);
  return { x: ce * Math.cos(az), y: Math.sin(el), z: ce * Math.sin(az) };
}

/**
 * Warm colour for the directional light (sRGB hex). A low sun is both warmer and dimmer,
 * which is what makes the 40-80 m view read as late afternoon rather than as noon.
 */
export function sunColor(opts?: SkyOptions): number {
  const p = params(opts);
  const t = Math.max(0, Math.min(1, p.elevation / 55));
  const g = 0.62 + (0.965 - 0.62) * t;
  const b = 0.31 + (0.92 - 0.31) * t;
  return (255 << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/**
 * Suggested directional-light intensity for ACESFilmic tone mapping.
 *
 * On a clear day direct sun is roughly 4-6x the irradiance of the whole sky, and that
 * ratio is what makes shadows read as shadows. With a Lambert term of `dotNL * I / PI`
 * against an IBL irradiance of about 0.5 * envMapIntensity, an intensity near 6 is the
 * point where a shadowed wall is ~20% of a lit one instead of ~60%.
 */
export function sunIntensity(opts?: SkyOptions): number {
  const p = params(opts);
  return 3.8 + 2.2 * Math.max(0, Math.min(1, p.elevation / 50));
}

/*
 * Pow lookups. The gradient terms are `x^0.55`, `x^1.6`, `x^1.3`; calling `Math.pow`
 * three times per texel would cost more than the rest of the sky put together.
 */
const LUT_SIZE = 1024;
function powLut(exp: number): Float32Array {
  const t = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) t[i] = Math.pow(i / LUT_SIZE, exp);
  return t;
}
const POW_055 = powLut(0.55);
const POW_130 = powLut(1.3);
const POW_160 = powLut(1.6);
function lut(t: Float32Array, x: number): number {
  const i = (x * LUT_SIZE) | 0;
  return t[i < 0 ? 0 : i > LUT_SIZE ? LUT_SIZE : i] as number;
}

/** Paints the sky into an RGBA buffer. Low tens of milliseconds at 1024x512. */
export function createSkyTexture(opts?: SkyTextureOptions): THREE.Texture {
  const p = params(opts);
  const width = Math.max(64, Math.round(opts?.width ?? 1024));
  const height = Math.max(32, width >> 1);
  const sun = sunDirection(opts);
  const img = new ImageData(width, height);
  const data = img.data;

  // Cirrus: one field stretched 3:1 along longitude, so the streaks run east-west.
  const cirrus: Field = noiseField({ seed: 0x5c1c, freq: 5, res: 256, octaves: 5, gain: 0.55, warp: 2, tag: 'cirrus' });
  const cirrusFine: Field = noiseField({ seed: 0x71a3, freq: 10, res: 256, octaves: 4, kind: 'turbulence', tag: 'cirrus2' });

  // Palette, display-referred: a sun-bleached Mediterranean sky.
  const zenR = 0.145, zenG = 0.36, zenB = 0.74;
  const midR = 0.42, midG = 0.63, midB = 0.87;
  const horR = 0.8, horG = 0.86, horB = 0.88;
  // Horizon haze carries the water's teal so sea and sky agree where they meet.
  const seaR = 0.23, seaG = 0.47, seaB = 0.5;
  const gndR = 0.16, gndG = 0.15, gndB = 0.13;

  const turb = p.turbidity;
  const hazeAmt = 0.35 + 0.85 * p.haze;
  // Lower exponent = wider aureole: turbidity spreads the sun's halo through the haze.
  const aureoleExp = 360 - 180 * turb;

  for (let j = 0; j < height; j++) {
    // flipY = false: row 0 is v = 0, the nadir.
    const v = (j + 0.5) / height;
    const theta = (v - 0.5) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let i = 0; i < width; i++) {
      const u = (i + 0.5) / width;
      const phi = (u - 0.5) * Math.PI * 2;
      const dx = cosT * Math.cos(phi);
      const dz = cosT * Math.sin(phi);
      const dy = sinT;
      const up = dy > 0 ? dy : 0;

      // --- base gradient -------------------------------------------------------
      const k = lut(POW_055, up);
      let r = midR + (zenR - midR) * k;
      let g = midG + (zenG - midG) * k;
      let b = midB + (zenB - midB) * k;
      const low = 1 - (up < 0.32 ? up / 0.32 : 1);
      const horizonMix = lut(POW_160, low);
      r += (horR - r) * horizonMix;
      g += (horG - g) * horizonMix;
      b += (horB - b) * horizonMix;

      // --- sun ------------------------------------------------------------------
      const cosA = dx * sun.x + dy * sun.y + dz * sun.z;
      const cs = cosA > 0 ? cosA : 0;
      // Powers by repeated squaring: x^5 and x^26, no libm calls.
      const c2 = cs * cs;
      const c4 = c2 * c2;
      const c5 = c4 * cs;
      const c8 = c4 * c4;
      const c16 = c8 * c8;
      const c26 = c16 * c8 * c2;
      const glow = c26 * (0.55 + 0.75 * turb);
      const wide = c5 * (0.12 + 0.28 * turb) * (1 - up * 0.35);
      // Aureole and disc only exist within a couple of degrees of the sun, so the
      // expensive terms are gated behind a cheap test.
      let aureole = 0;
      let disc = 0;
      if (cs > 0.97) {
        aureole = Math.pow(cs, aureoleExp) * (0.5 + 0.5 * turb);
        const discR = 0.0046 * (1 + turb * 0.6);
        if (cs > 0.9998) {
          const ang = Math.acos(cs > 1 ? 1 : cs);
          disc = ang < discR ? 1 : ang < discR * 1.6 ? 1 - (ang - discR) / (discR * 0.6) : 0;
        }
      }

      // Haze thickens towards the horizon and towards the sun.
      const hazeF = lut(POW_130, low) * hazeAmt * (1 + 0.5 * cs);
      const hz = hazeF > 1 ? 1 : hazeF;
      r += (seaR * 0.55 + horR * 0.45 - r) * hz;
      g += (seaG * 0.55 + horG * 0.45 - g) * hz;
      b += (seaB * 0.55 + horB * 0.45 - b) * hz;

      // --- cirrus ---------------------------------------------------------------
      if (up > 0.12) {
        const ci = stretchV(cirrus, u, v, 3);
        const cf = stretchV(cirrusFine, u, v, 6);
        const band = ci * 0.72 + cf * 0.38 - 0.44;
        if (band > 0) {
          const amp = band * 2.2 * Math.min(1, (up - 0.12) / 0.35) * (1 - turb * 0.4);
          if (amp > 0.002) {
            // Forward scattering: cirrus towards the sun is far brighter than away.
            const lit = (0.75 + 0.9 * c8 + 0.35 * up) * 0.98;
            const a = amp > 1 ? 1 : amp;
            r += (lit - r) * a;
            g += (lit - g) * a;
            b += (lit * 1.02 - b) * a;
          }
        }
      }

      // --- sunlight over the sky -------------------------------------------------
      const sw = glow + wide;
      if (sw > 0.002) {
        const a = sw > 1 ? 1 : sw;
        r += (0.8 - r) * a;
        g += (0.83 - g) * a;
        b += (0.72 - b) * a;
      }
      if (aureole > 0.002) {
        const a = aureole > 1 ? 1 : aureole;
        r += (1 - r) * a;
        g += (0.97 - g) * a;
        b += (0.9 - b) * a;
      }
      if (disc > 0) {
        r += (1 - r) * disc;
        g += (0.99 - g) * disc;
        b += (0.94 - b) * disc;
      }

      // --- below the horizon ----------------------------------------------------
      if (dy < 0) {
        const below = Math.min(1, -dy / 0.25);
        r += (gndR - r) * below;
        g += (gndG - g) * below;
        b += (gndB - b) * below;
        // A thin band of sea just under the horizon keeps the lower hemisphere from
        // reading as a black void behind the water tiles.
        const sea = 1 - Math.min(1, -dy / 0.05);
        r += (seaR * 0.7 + horR * 0.3 - r) * sea;
        g += (seaG * 0.7 + horG * 0.3 - g) * sea;
        b += (seaB * 0.7 + horB * 0.3 - b) * sea;
      }

      const ex = p.exposure;
      const o = (j * width + i) << 2;
      data[o] = srgb8(r * ex);
      data[o + 1] = srgb8(g * ex);
      data[o + 2] = srgb8(b * ex);
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'procedural-sky';
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; // longitude wraps
  tex.wrapT = THREE.ClampToEdgeWrapping; // never sample past the poles
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
