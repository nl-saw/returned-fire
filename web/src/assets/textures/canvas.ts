/**
 * Pixel buffers and texture plumbing.
 *
 * All surfaces are generated into an `ImageData` (`Uint8ClampedArray`) with an explicit
 * pixel loop and handed to `THREE.DataTexture`. Two reasons for `DataTexture` over a
 * canvas: there is no `putImageData`/`getImageData` round trip, and — more importantly —
 * `DataTexture` has `flipY = false`, so albedo, normal and ORM all share one row order.
 * A `CanvasTexture` (flipY = true) mixed with a data texture would silently flip the
 * V axis and make the normal map disagree with the colour map.
 */
import * as THREE from 'three';

/** Palette helper: sRGB hex -> linear-light triple, matching how the renderer reads `map`. */
export interface LinearRGB {
  r: number;
  g: number;
  b: number;
}

/** Exact sRGB -> linear for one 0..255 channel (setup-time only, never per pixel). */
export function srgbToLinear255(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Palette hex (as authored in the art bible) -> linear-light colour. */
export function hexToLinear(hex: number): LinearRGB {
  return {
    r: srgbToLinear255((hex >> 16) & 255),
    g: srgbToLinear255((hex >> 8) & 255),
    b: srgbToLinear255(hex & 255),
  };
}

/*
 * Linear -> sRGB lookup table. The output pass needs this three times per texel, and
 * `Math.pow` there would cost more than the entire noise budget, so we precompute the
 * curve once. 13 bits keeps the quantisation error below half an 8-bit step.
 */
const SRGB_LUT_BITS = 13;
const SRGB_LUT_SIZE = 1 << SRGB_LUT_BITS;
const SRGB_LUT = new Uint8Array(SRGB_LUT_SIZE);
for (let i = 0; i < SRGB_LUT_SIZE; i++) {
  const l = i / (SRGB_LUT_SIZE - 1);
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  SRGB_LUT[i] = Math.round(s * 255);
}

/** Linear-light 0..1 -> sRGB 0..255, via the precomputed curve. */
export function srgb8(linear: number): number {
  const i = (linear * (SRGB_LUT_SIZE - 1)) | 0;
  return SRGB_LUT[i < 0 ? 0 : i >= SRGB_LUT_SIZE ? SRGB_LUT_SIZE - 1 : i] as number;
}

/** Allocates an RGBA pixel buffer. `ImageData` gives us a `Uint8ClampedArray` for free. */
export function createRGBA(size: number): ImageData {
  return new ImageData(size, size);
}

/** Fills a buffer with one colour (flat fallbacks, debug sheets). */
export function fillRGBA(img: ImageData, r: number, g: number, b: number, a = 255): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }
}

export interface TextureOptions {
  /** True for colour maps (albedo/sky), false for data maps (normal/ORM). */
  srgb: boolean;
  /** Defaults to repeat; fx decals clamp so their soft edges do not bleed across. */
  wrap?: THREE.Wrapping;
  anisotropy?: number;
  mipmaps?: boolean;
  name?: string;
}

/**
 * Wraps a pixel buffer in a mip-mapped, anisotropically filtered `DataTexture`.
 * Mipmaps matter here: the game views these surfaces from 40-80 m, where an
 * un-mip-mapped 512px texture shimmers into noise.
 */
export function dataTexture(img: ImageData, opts: TextureOptions): THREE.DataTexture {
  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = opts.name ?? 'procedural';
  tex.wrapS = opts.wrap ?? THREE.RepeatWrapping;
  tex.wrapT = opts.wrap ?? THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = opts.mipmaps === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = opts.mipmaps !== false;
  tex.anisotropy = Math.max(1, opts.anisotropy ?? 1);
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** A shared 1x1 flat normal map, used when the library runs in non-`full` mode. */
let flatNormal: THREE.DataTexture | null = null;
export function flatNormalTexture(): THREE.DataTexture {
  if (!flatNormal) {
    const img = createRGBA(1);
    img.data[0] = 128;
    img.data[1] = 128;
    img.data[2] = 255;
    img.data[3] = 255;
    flatNormal = dataTexture(img, { srgb: false, wrap: THREE.RepeatWrapping, mipmaps: false, name: 'flat-normal' });
  }
  return flatNormal;
}

/** Same, for a 1x1 white ORM (AO=1, roughness=1, metalness=1) when maps are skipped. */
let flatOrm: THREE.DataTexture | null = null;
export function flatOrmTexture(): THREE.DataTexture {
  if (!flatOrm) {
    const img = createRGBA(1);
    img.data[0] = 255;
    img.data[1] = 255;
    img.data[2] = 255;
    img.data[3] = 255;
    flatOrm = dataTexture(img, { srgb: false, wrap: THREE.RepeatWrapping, mipmaps: false, name: 'flat-orm' });
  }
  return flatOrm;
}

/** Debug helper: renders a pixel buffer into a 2D canvas (used by the preview page). */
export function pixelsToCanvas(img: ImageData): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext('2d');
  if (ctx) ctx.putImageData(img, 0, 0);
  return cv;
}
