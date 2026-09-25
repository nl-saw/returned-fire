/**
 * Renderer bootstrap: WebGL context, sky + sun + shadows, post-processing chain and the
 * quality presets the settings menu toggles.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createSkyTexture, sunColor, sunDirection as skySun, sunIntensity } from '../assets/textures/library.js';

export type Quality = 'low' | 'medium' | 'high';

/**
 * Half-width of the sun's orthographic shadow box, in metres, at the default zoom. The box
 * follows the camera, so it only has to cover the visible neighbourhood — a tighter box means
 * crisper contact shadows at the same shadow-map resolution.
 */
export const SHADOW_HALF = 58;
/**
 * The box grows with the camera height (up to this), so a zoomed-out view still has lit
 * shadows across the frame instead of a 58 m patch under the vehicle. Beyond ~150 m the
 * shadow texel gets coarser than the detail it is casting, so it stops there.
 */
export const SHADOW_HALF_MAX = 150;
/** Camera height the default box is tuned for (`BASE_DISTANCE * sin(58 deg)`). */
const SHADOW_REF_HEIGHT = 52;

export interface QualityPreset {
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  msaa: number;
  terrainBake: number;
  effects: Quality;
}

export const QUALITY: Record<Quality, QualityPreset> = {
  low: { pixelRatio: 0.85, shadows: false, shadowMapSize: 1024, bloom: false, msaa: 0, terrainBake: 1024, effects: 'low' },
  medium: { pixelRatio: 1, shadows: true, shadowMapSize: 2048, bloom: true, msaa: 0, terrainBake: 1536, effects: 'medium' },
  high: { pixelRatio: 1.35, shadows: true, shadowMapSize: 2048, bloom: true, msaa: 4, terrainBake: 2048, effects: 'high' },
};

/**
 * Sun + sky parameters. The sky texture generator owns the equirect mapping, so the light
 * direction, its colour and its intensity all come from the same source of truth — the
 * painted sun and the shadows can never disagree.
 */
export const SUN_OPTS = {
  sunAzimuth: 38,
  sunElevation: 41,
  turbidity: 0.35,
  haze: 0.5,
  exposure: 1.0,
} as const;

export const SKY_EXPOSURE = 0.82;
export const SUN_COLOR = new THREE.Color(sunColor(SUN_OPTS));

export function sunDirection(): THREE.Vector3 {
  const d = skySun(SUN_OPTS);
  return new THREE.Vector3(d.x, d.y, d.z).normalize();
}

export interface GameScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  sunTarget: THREE.Object3D;
  composer: EffectComposer | null;
  quality: Quality;
  setQuality(q: Quality): void;
  setSize(w: number, h: number): void;
  render(): void;
  dispose(): void;
}

export function createGameScene(
  canvas: HTMLCanvasElement,
  quality: Quality = 'high',
  preserveBuffer = false,
): GameScene {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
    // Only the screenshot harness needs the buffer to survive a frame.
    preserveDrawingBuffer: preserveBuffer,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = SKY_EXPOSURE;
  renderer.shadowMap.enabled = true;
  // three r186 dropped PCFSoftShadowMap; PCF is the closest supported soft-ish filter.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.6, 1200);
  camera.position.set(0, 60, -40);

  // ---- sky + environment lighting ------------------------------------------
  let envTexture: THREE.Texture | null = null;
  try {
    const sky = createSkyTexture({ ...SUN_OPTS });
    sky.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = sky;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const env = pmrem.fromEquirectangular(sky);
    envTexture = env.texture;
    scene.environment = envTexture;
    scene.environmentIntensity = 1.05;
    pmrem.dispose();
  } catch (err) {
    // The texture library is optional at boot: fall back to a flat gradient so the game
    // still renders while assets warm up.
    console.warn('sky texture unavailable, using fallback gradient', err);
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#3f7fc4');
    grad.addColorStop(0.55, '#a9cbe4');
    grad.addColorStop(1, '#d9c9a4');
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = tex;
  }

  // The sun is strong and the sky fill restrained: a bright coastal afternoon needs real
  // shadow contrast, and an ambient-dominated scene reads as flat grey.
  const sun = new THREE.DirectionalLight(SUN_COLOR, sunIntensity(SUN_OPTS) * 0.76);
  sun.castShadow = true;
  const dir = sunDirection();
  sun.position.copy(dir).multiplyScalar(160);
  sun.shadow.mapSize.set(QUALITY[quality].shadowMapSize, QUALITY[quality].shadowMapSize);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 420;
  const half = SHADOW_HALF;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  const sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  sun.target = sunTarget;

  // A touch of sky bounce so shadowed sides are not black.
  const hemi = new THREE.HemisphereLight(0xa8cdf2, 0xd8bd8c, 0.5);
  scene.add(hemi);
  // Warm fill from the sea side keeps the metal from going flat.
  const fill = new THREE.DirectionalLight(0xffd9a8, 0.22);
  fill.position.set(-dir.x * 90, 40, -dir.z * 90);
  scene.add(fill);

  /**
   * Keep the shadow frustum on what the camera is actually looking at, and scale it with the
   * camera height so zooming out does not leave most of the frame unshadowed. It used to sit
   * on the world origin for the whole match, so a base 150 m away simply had no shadows.
   */
  const sunFocus = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  let shadowHalf = SHADOW_HALF;
  const updateShadowFocus = () => {
    camera.getWorldDirection(camFwd);
    const ahead = shadowHalf * 0.45;
    const half = Math.min(
      SHADOW_HALF_MAX,
      Math.max(SHADOW_HALF, SHADOW_HALF * (camera.position.y / SHADOW_REF_HEIGHT)),
    );
    if (Math.abs(half - shadowHalf) > 1.0) {
      shadowHalf = half;
      const sc = sun.shadow.camera;
      sc.left = -half;
      sc.right = half;
      sc.top = half;
      sc.bottom = -half;
      sc.far = 160 + half * 2.6;
      sc.updateProjectionMatrix();
    }
    const texel = (shadowHalf * 2) / Math.max(1, sun.shadow.mapSize.x);
    // Snapping to the shadow texel grid stops the edges of every shadow from shimmering.
    const fx = Math.round((camera.position.x + camFwd.x * ahead) / texel) * texel;
    const fz = Math.round((camera.position.z + camFwd.z * ahead) / texel) * texel;
    sunFocus.set(fx, 0, fz);
    sunTarget.position.copy(sunFocus);
    sunTarget.updateMatrixWorld();
    sun.position.set(fx + dir.x * 150, sunFocus.y + dir.y * 150, fz + dir.z * 150);
  };

  // ---- post processing -------------------------------------------------------
  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;

  const buildComposer = (w: number, h: number, preset: QualityPreset) => {
    composer?.dispose();
    if (!preset.bloom) {
      composer = null;
      bloom = null;
      return;
    }
    const rt = new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
      type: THREE.HalfFloatType,
      samples: preset.msaa,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    // A high threshold so only genuine highlights bloom; at 0.86 the sunlit sand and the
    // sea glint smeared the whole frame into a milky haze.
    bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.24, 0.7, 1.02);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    composer.setSize(w, h);
  };

  let size = { w: 16, h: 9 };
  let currentQuality = quality;

  const applyQuality = (q: Quality) => {
    currentQuality = q;
    const preset = QUALITY[q];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatio));
    renderer.shadowMap.enabled = preset.shadows;
    sun.castShadow = preset.shadows;
    sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    buildComposer(size.w, size.h, preset);
    renderer.setSize(size.w, size.h, false);
  };
  applyQuality(quality);

  const api: GameScene = {
    renderer,
    scene,
    camera,
    sun,
    sunTarget,
    get composer() {
      return composer;
    },
    get quality() {
      return currentQuality;
    },
    setQuality: applyQuality,
    setSize(w, h) {
      size = { w, h };
      const preset = QUALITY[currentQuality];
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      composer?.setSize(w, h);
      bloom?.setSize(w, h);
      void preset;
    },
    render() {
      updateShadowFocus();
      if (composer) composer.render();
      else renderer.render(scene, camera);
    },
    dispose() {
      composer?.dispose();
      envTexture?.dispose();
      renderer.dispose();
    },
  };
  return api;
}
