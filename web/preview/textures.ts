/**
 * Texture library review sheet.
 *
 *   node tools/shot.mjs preview/textures.html shots/textures.png --w 1600 --h 1000 --wait 20000
 *
 * Four viewports, one canvas:
 *   - middle: every material on a sphere + crate, lit by the sky IBL and the same
 *     directional sun the game uses. Geometry UVs are scaled by `worldScale`, so every
 *     tile shows the material at its true in-world tiling density (~3 screen px per texel
 *     here, i.e. the fine grain is visible rather than mip-averaged away).
 *   - top: the environment strip - sun, horizon haze and materials at 40-80 m through a
 *     telephoto framing, which is where the game camera actually sits.
 *   - bottom left: sand / rock / concrete / dirt tiled 3x3, to prove the seams.
 *   - bottom right: a 2x zoomed close-up strip (two texels per screen pixel).
 *
 * `?view=tiling|closeup|env|grid|ramps` renders one of those full-frame instead; `ramps` is the
 * paintable ground set (three sands, three grasses, two pavements) with the two ramp blends.
 * iteration screenshots. `?ss=2` supersamples, `?aa=1` enables MSAA.
 */
import * as THREE from 'three';
import {
  MAT_KEYS,
  createSkyTexture,
  createSurfaceLibrary,
  libraryTimings,
  sunColor,
  sunDirection,
  sunIntensity,
} from '../src/assets/textures/index';
import type { MatKey, SurfaceLibrary } from '../src/assets/types';

declare global {
  interface Window {
    __READY__?: boolean;
  }
}

type ViewName = 'all' | 'tiling' | 'closeup' | 'env' | 'grid' | 'sky' | 'ramps';

interface View {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Viewport rect in CSS pixels, origin bottom-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Frames the camera for the viewport aspect ratio. */
  fit(camera: THREE.PerspectiveCamera, aspect: number): void;
}

const params = new URLSearchParams(location.search);
const viewName = (params.get('view') ?? 'all') as ViewName;
const supersample = Math.max(1, Math.min(2, Number(params.get('ss') ?? 1)));
const useAA = params.get('aa') === '1';

const canvas = document.getElementById('view') as HTMLCanvasElement | null;
if (!canvas) throw new Error('missing #view canvas');
const hud = document.getElementById('hud');

const W = Math.max(320, window.innerWidth);
const H = Math.max(240, window.innerHeight);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: useAA, powerPreference: 'high-performance' });
renderer.setPixelRatio(supersample);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.88;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

/* --------------------------------------------------------------- calibration --- */

/**
 * Reference micro-benchmark: the exact loop the generator budget was sized against on a
 * quiet machine (7 bilinear samples from 128^2 planes + 4 buffer writes over 512^2 texels
 * = 5.8 ms on a dev laptop). Dividing the measured generation time by this factor gives a
 * load-independent number, which matters because this harness is often run while other
 * software renders on the same CPU.
 */
const CALIBRATION_BASELINE_MS = 5.8;

function cpuCalibration(): number {
  const N = 512;
  const R = 128;
  const planes: Float32Array[] = [];
  for (let c = 0; c < 8; c++) {
    const a = new Float32Array(R * R);
    for (let i = 0; i < a.length; i++) a[i] = ((i * 2654435761) % 1000) / 1000;
    planes.push(a);
  }
  const out = [new Uint8ClampedArray(N * N * 4), new Uint8ClampedArray(N * N * 4)];
  let best = Infinity;
  let checksum = 0;
  for (let it = 0; it < 3; it++) {
    const t = performance.now();
    const step = R / N;
    for (let y = 0; y < N; y++) {
      const fy = y * step;
      const y0 = fy | 0;
      const ty = fy - y0;
      const y1 = (y0 + 1) & (R - 1);
      const r0 = y0 * R;
      const r1 = y1 * R;
      for (let x = 0; x < N; x++) {
        const fx = x * step;
        const x0 = fx | 0;
        const tx = fx - x0;
        const x1 = (x0 + 1) & (R - 1);
        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;
        const i00 = r0 + x0;
        const i10 = r0 + x1;
        const i01 = r1 + x0;
        const i11 = r1 + x1;
        let acc = 0;
        for (let c = 0; c < 7; c++) {
          const a = planes[c] as Float32Array;
          acc += w00 * a[i00] + w10 * a[i10] + w01 * a[i01] + w11 * a[i11];
        }
        const o = (y * N + x) << 2;
        out[0][o] = acc * 40;
        out[1][o] = acc * 20;
      }
    }
    const dt = performance.now() - t;
    if (dt < best) best = dt;
    checksum += out[0][(it * 977) & 262143] as number;
  }
  if (checksum < 0) console.log('calibration', checksum);
  return best / CALIBRATION_BASELINE_MS;
}

/* ------------------------------------------------------------------ timing ---- */

// Measured before anything else runs, so the factor reflects the conditions the library
// was generated under rather than competing with the software rasteriser.
const cpuFactor = cpuCalibration();

const tLib = performance.now();
// `?full=0` runs the reduced path (256px, albedo only) that ships for low-end devices.
const fullMode = params.get('full') !== '0';
const lib: SurfaceLibrary = createSurfaceLibrary({ full: fullMode, anisotropy: 8 });
const libMs = performance.now() - tLib;
// Sun overrides exist so the light rig can be sanity-checked from the URL
// (`?sunel=70&sunaz=200`), including whether shadows land where they should.
const sunOpts = {
  sunAzimuth: params.has('sunaz') ? Number(params.get('sunaz')) : undefined,
  sunElevation: params.has('sunel') ? Number(params.get('sunel')) : undefined,
};
const tSky = performance.now();
const skyTexture = createSkyTexture({ width: 1024, ...sunOpts });
const skyMs = performance.now() - tSky;

// PMREM turns the painted sky into the image-based light the materials are lit by.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envRT = pmrem.fromEquirectangular(skyTexture);
pmrem.dispose();
const envMap = envRT.texture;

const debugLights: THREE.DirectionalLight[] = [];
const sun = sunDirection(sunOpts);
const lightColor = sunColor(sunOpts);
const lightPower = sunIntensity(sunOpts);

/* ------------------------------------------------------------------ helpers ---- */

/** Scales a geometry's UVs so one texture repeat covers `worldScale` metres. */
function scaleUV(geom: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = geom.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) as number) * su, (uv.getY(i) as number) * sv);
  uv.needsUpdate = true;
  return geom;
}

/**
 * three only exposes a vertical FOV, and these viewports range from 1.6:1 to 8:1, so the
 * camera is framed from the world extents it has to cover at its distance instead.
 */
function fitView(camera: THREE.PerspectiveCamera, aspect: number, targetW: number, targetH: number, dist: number): void {
  const vForH = 2 * Math.atan(targetH / (2 * dist));
  const vForW = 2 * Math.atan(targetW / (2 * dist) / aspect);
  camera.aspect = aspect;
  camera.fov = Math.max(vForH, vForW) * (180 / Math.PI);
  camera.updateProjectionMatrix();
}

function label(text: string, sub = ''): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 128;
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(8,10,12,0.5)';
    ctx.fillRect(0, 26, cv.width, 76);
    ctx.fillStyle = '#f4efe6';
    ctx.font = '600 40px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cv.width / 2, sub ? 52 : 64);
    if (sub) {
      ctx.fillStyle = '#d3bb90';
      ctx.font = '400 28px ui-monospace, Menlo, monospace';
      ctx.fillText(sub, cv.width / 2, 88);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }),
  );
  sprite.scale.set(1.7, 0.42, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function lightRig(scene: THREE.Scene, span: number, aim: THREE.Vector3 = new THREE.Vector3()): void {
  const dir = new THREE.DirectionalLight(lightColor, lightPower);
  // The light sits far away on the sun vector and is aimed at the content: the shadow
  // camera's ortho box only has to cover what the scene actually contains.
  dir.position.set(aim.x + sun.x * 90, aim.y + sun.y * 90, aim.z + sun.z * 90);
  dir.target.position.copy(aim);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  const cam = dir.shadow.camera;
  cam.left = -span;
  cam.right = span;
  cam.top = span;
  cam.bottom = -span;
  cam.near = 1;
  cam.far = 260;
  cam.updateProjectionMatrix();
  dir.shadow.bias = -0.0005;
  dir.shadow.normalBias = 0.025;
  scene.add(dir);
  scene.add(dir.target);
  dir.target.updateMatrixWorld();
  if (params.get('debug') === '1') debugLights.push(dir);
  scene.environment = envMap;
  // The sky is an LDR (sRGB) map, so its specular contribution is modest; the renderer is
  // expected to lift it, and this harness does the same so polished metal reads as metal.
  // Sky IBL at ~0.85 against a sun near 6: the 5:1 ratio real sunlight has, which is what
  // makes cast shadows read instead of washing out.
  scene.environmentIntensity = 0.85;
}

/* ------------------------------------------------------------------ one tile --- */

type TileMode = 'tile' | 'world' | 'zoom2';

/**
 * `tile` maps one full texture repeat onto each sphere/face, which is what a review sheet
 * needs (you see the whole material). `world` maps it at true in-world density so the
 * label's metre figure can be judged, and `zoom2` doubles that density for the close-ups.
 */
function buildTile(key: MatKey, mode: TileMode = 'tile'): THREE.Group {
  const group = new THREE.Group();
  const ws = lib.surfaces[key].worldScale;
  const material = lib.mat(key);
  const uvFor = (metres: number): number => (mode === 'tile' ? 1 : (metres / ws) * (mode === 'zoom2' ? 2 : 1));

  if (key === 'smoke' || key === 'scorch') {
    // Decals read as alpha quads, not as solids, so they hang in front of a plain crate.
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.1, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x74777b, roughness: 0.85, metalness: 0 }),
    );
    back.position.set(0, 0.62, -0.24);
    back.castShadow = true;
    back.receiveShadow = true;
    group.add(back);
    const quad = new THREE.Mesh(scaleUV(new THREE.PlaneGeometry(1.3, 1.3), uvFor(1.3), uvFor(1.3)), material);
    quad.position.set(0, 0.68, 0.06);
    quad.rotation.x = -0.2;
    quad.renderOrder = 4;
    group.add(quad);
  } else {
    const r = 0.5;
    const sphere = new THREE.Mesh(
      scaleUV(new THREE.SphereGeometry(r, 64, 40), uvFor(2 * Math.PI * r), uvFor(Math.PI * r)),
      material,
    );
    sphere.position.set(-0.46, 0.57, 0.12);
    sphere.castShadow = true;
    sphere.receiveShadow = true;
    group.add(sphere);

    const s = 0.8;
    const box = new THREE.Mesh(scaleUV(new THREE.BoxGeometry(s, s, s), uvFor(s), uvFor(s)), material);
    box.position.set(0.52, 0.4, -0.05);
    box.rotation.y = -0.5;
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);
  }

  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(2.05, 0.05, 1.45),
    new THREE.MeshStandardMaterial({ color: 0x191c1f, roughness: 0.9, metalness: 0 }),
  );
  plate.position.set(0, 0.025, 0.02);
  plate.receiveShadow = true;
  group.add(plate);

  const sub = mode === 'tile' ? `${ws} m per repeat` : mode === 'world' ? `world scale (${ws} m)` : '2x zoom';
  const tag = label(key, sub);
  tag.position.set(0, 0.02, 0.92);
  tag.scale.set(1.75, 0.44, 1);
  group.add(tag);
  return group;
}

/* ------------------------------------------------------------------ ramps view -- */

/**
 * The paintable ground set: three sand stops, three grass stops, the two pavement shapes, and
 * the two ramps *blended* the way the ground shader blends them.
 *
 * Each tile is a 12 x 12 m plane with its UVs scaled by the material's own `worldScale`, so it
 * shows a patch of ground at true in-world density rather than one stretched repeat. The two
 * `... ramp` tiles are albedo-only: they exist to show whether a three-stop ramp reads as one
 * material changing or as three materials meeting, which is the part separate swatches cannot
 * answer.
 */
function buildRampsScene(): View {
  const scene = new THREE.Scene();
  scene.background = skyTexture;
  lightRig(scene, 42);
  const bench = new THREE.Mesh(
    new THREE.PlaneGeometry(70, 46).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.92, metalness: 0 }),
  );
  bench.position.y = -0.02;
  bench.receiveShadow = true;
  scene.add(bench);

  const SIZE = 12;
  const COL = 14.5;
  const ROW = 15.5;
  const rampMat = (a: MatKey, b: MatKey, c: MatKey): THREE.ShaderMaterial => {
    const tex = (k: MatKey): THREE.Texture => {
      const t = lib.surfaces[k].map.clone();
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      return t;
    };
    return new THREE.ShaderMaterial({
      uniforms: { uA: { value: tex(a) }, uB: { value: tex(b) }, uC: { value: tex(c) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      // The ground shader's ramp, exactly: one variant index in 0..2, lerped between the two
      // stops either side of it.
      fragmentShader: `
        uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uC;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 4.0;
          float v = clamp(vUv.x, 0.0, 1.0) * 2.0;
          vec3 c = v < 1.0 ? mix(texture2D(uA, p).rgb, texture2D(uB, p).rgb, v)
                           : mix(texture2D(uB, p).rgb, texture2D(uC, p).rgb, v - 1.0);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
  };

  const rows: { keys: string[]; z: number }[] = [
    { keys: ['sand', 'sandGrit', 'sandCoral', 'sand ramp'], z: -ROW },
    { keys: ['grassLush', 'grass', 'grassDry', 'grass ramp'], z: 0 },
    { keys: ['dirt', 'rock', 'paveTiles', 'paveStrip'], z: ROW },
  ];
  for (const row of rows) {
    row.keys.forEach((key, i) => {
      const x = (i - (row.keys.length - 1) / 2) * COL;
      const ramp = key.endsWith('ramp');
      if (ramp) {
        const mats: [MatKey, MatKey, MatKey] =
          key === 'sand ramp'
            ? ['sand', 'sandGrit', 'sandCoral']
            : ['grassLush', 'grass', 'grassDry'];
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), rampMat(...mats));
        plane.position.set(x, 0.01, row.z);
        scene.add(plane);
      } else {
        const k = key as MatKey;
        const ws = lib.surfaces[k].worldScale;
        const geom = scaleUV(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), SIZE / ws, SIZE / ws);
        const plane = new THREE.Mesh(geom, lib.mat(k));
        plane.position.set(x, 0, row.z);
        plane.receiveShadow = true;
        scene.add(plane);
      }
      const tag = label(key, ramp ? 'blend, albedo only' : `${lib.surfaces[key as MatKey].worldScale} m repeat`);
      tag.position.set(x, 0.12, row.z + SIZE * 0.55);
      tag.scale.set(7.5, 1.9, 1);
      scene.add(tag);
    });
  }

  const camera = new THREE.PerspectiveCamera(38, 1.6, 0.5, 400);
  camera.position.set(0, 32, 50);
  camera.lookAt(0, 0, 0);
  return {
    scene,
    camera,
    x: 0,
    y: 0,
    w: W,
    h: H,
    fit: (cam, aspect) => fitView(cam, aspect, 74, 62 / aspect, 62),
  };
}

/* ------------------------------------------------------------------ grid view -- */

function buildGridScene(): View {
  const scene = new THREE.Scene();
  scene.background = skyTexture;
  lightRig(scene, 20);
  // A dark neutral bench: sand at world scale under this light is so bright that it
  // flattens everything standing on it, and the tiles have to be judged on their own.
  const bench = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 90).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.92, metalness: 0 }),
  );
  bench.receiveShadow = true;
  scene.add(bench);

  const cols = 7;
  const gapX = 2.7;
  const gapZ = 2.45;
  MAT_KEYS.forEach((key, i) => {
    const tile = buildTile(key);
    tile.position.set((i % cols - (cols - 1) / 2) * gapX, 0, (Math.floor(i / cols) - 1.5) * gapZ);
    scene.add(tile);
  });
  // The three spare slots carry the same materials at true world density, which is the
  // reality check for the "metres per repeat" figure each label quotes.
  const extras: MatKey[] = ['sand', 'camoGreen', 'wood'];
  extras.forEach((key, k) => {
    const i = MAT_KEYS.length + k;
    const tile = buildTile(key, 'world');
    tile.position.set((i % cols - (cols - 1) / 2) * gapX, 0, (Math.floor(i / cols) - 1.5) * gapZ);
    scene.add(tile);
  });

  const camera = new THREE.PerspectiveCamera(38, 1.6, 0.5, 400);
  camera.position.set(0, 10.2, 12.6);
  camera.lookAt(0, 0.5, -0.8);
  return {
    scene,
    camera,
    x: 0,
    y: 0,
    w: W,
    h: H,
    fit: (cam, aspect) => fitView(cam, aspect, 23.5, 10.5, 16.2),
  };
}

/* ------------------------------------------------------- environment / scale --- */

function buildEnvScene(): View {
  const scene = new THREE.Scene();
  scene.background = skyTexture;
  // Aerial perspective tinted like the horizon haze, starting beyond the outpost so the
  // buildings stay crisp.
  scene.fog = new THREE.Fog(0xb9c6c4, 220, 900);
  // Shadows only need to reach the outpost; a 120 m shadow frustum costs a lot of
  // software rasterisation for nothing.
  lightRig(scene, 34, new THREE.Vector3(-6, 1.5, -30));

  const sandWS = lib.surfaces['sand'].worldScale;
  const sandPlane = new THREE.Mesh(
    scaleUV(new THREE.PlaneGeometry(900, 900), 900 / sandWS, 900 / sandWS),
    lib.mat('sand'),
  );
  sandPlane.geometry.rotateX(-Math.PI / 2);
  sandPlane.position.set(0, 0, -180);
  sandPlane.receiveShadow = true;
  scene.add(sandPlane);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2b6b73, roughness: 0.1, metalness: 0.15 }),
  );
  water.position.set(0, -0.2, -600);
  scene.add(water);

  const place = (key: MatKey, geom: THREE.BufferGeometry, x: number, z: number, rotY = 0): THREE.Mesh => {
    const ws = lib.surfaces[key].worldScale;
    const mesh = new THREE.Mesh(scaleUV(geom, 1 / ws, 1 / ws), lib.mat(key));
    mesh.position.set(x, 0, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };
  const box = (w: number, h: number, d: number): THREE.BoxGeometry => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    return g;
  };

  place('concrete', box(16, 4.6, 11), -30, -46, 0.12);
  place('metalPanel', box(7, 3.4, 5.5), 2, -40, -0.2);
  place('sandbag', box(13, 1.6, 1.8), -8, -32, 0.03);
  place('canvasTent', box(5.4, 2.8, 4.2), -19, -33, 0.2);
  place('camoGreen', box(3.4, 1.6, 6.4), 11, -29, -0.35);
  place('camoRed', box(3.2, 1.6, 6.2), 15.6, -28, -0.3);
  place('wood', box(3.2, 1.3, 2.6), 5, -25, 0.4);
  place('rust', box(2.6, 2.1, 2.6), 20, -35, 0.1);
  place('metalDark', box(2.2, 1.4, 2.2), 8, -22, 0.25);
  place('hazard', box(10, 1.1, 0.4), -30, -28, 0);

  const pad = new THREE.Mesh(scaleUV(new THREE.PlaneGeometry(16, 16), 16 / 8, 16 / 8), lib.mat('helipad'));
  pad.geometry.rotateX(-Math.PI / 2);
  pad.position.set(4, 0.02, -52);
  pad.receiveShadow = true;
  scene.add(pad);

  // Eye-level telephoto: the horizon (and therefore the sky) stays in frame, and the
  // buildings sit 40-80 m out, exactly the range the game is played at.
  // Eye level on purpose: the horizon (and therefore the sky) stays inside the strip,
  // and the outpost sits 45-75 m out, which is the range the game is played at.
  // The camera looks *across* the sun (azimuth 38 deg -> shadows run towards -X/-Z), so
  // every object throws a readable shadow sideways instead of hiding it behind itself.
  const camera = new THREE.PerspectiveCamera(30, 8, 0.5, 2000);
  camera.position.set(-42, 8.5, 48);
  camera.lookAt(2, 4.5, -18);
  return {
    scene,
    camera,
    x: 0,
    y: 0,
    w: W,
    h: H,
    fit: (cam, aspect) => fitView(cam, aspect, 96, 96 / aspect, 90),
  };
}

/* --------------------------------------------------------------- tiling 3x3 ---- */

function buildTilingScene(): View {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171a);
  lightRig(scene, 12);
  const keys: MatKey[] = ['sand', 'rock', 'concrete'];
  keys.forEach((key, i) => {
    // 3x3 repeats: any seam in the generator shows up immediately as a visible grid of
    // discontinuities, which is exactly what this strip is for.
    const mesh = new THREE.Mesh(scaleUV(new THREE.PlaneGeometry(3, 3), 3, 3), lib.mat(key));
    mesh.position.set((i - (keys.length - 1) / 2) * 3.3, 0, 0);
    // Turned part way towards the sun: a panel lit at a grazing angle hides the very
    // relief this strip is meant to show, but facing the sun squares up the foreshortening.
    mesh.rotation.y = Math.atan2(sun.x, sun.z) * 0.55;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const tag = label(`${key} 3x3`, `${lib.surfaces[key].worldScale} m repeat`);
    tag.position.set(mesh.position.x, -1.98, 0.3);
    tag.scale.set(2.9, 0.7, 1);
    scene.add(tag);
  });
  const camera = new THREE.PerspectiveCamera(30, 1, 0.2, 200);
  camera.position.set(0, 0.2, 14);
  camera.lookAt(0, -0.1, 0);
  return {
    scene,
    camera,
    x: 0,
    y: 0,
    w: W,
    h: H,
    fit: (cam, aspect) => fitView(cam, aspect, 12.4, 4.6, 14),
  };
}

/* -------------------------------------------------------- close-up strip / 2x --- */

function buildCloseupScene(scene?: THREE.Scene, keysIn?: MatKey[], spread = 1.4, zoom = 2): View {
  const s = scene ?? new THREE.Scene();
  s.background = new THREE.Color(0x14171a);
  lightRig(s, 8);
  const keys = keysIn ?? (['camoGreen', 'camoBrown', 'sandbag', 'rust'] as MatKey[]);
  keys.forEach((key, i) => {
    const r = 0.5;
    // 2x zoom on the sheet tiles: two texels per screen pixel, so grain, weave and chips
    // are judged at their real detail instead of through the mip chain.
    const sphere = new THREE.Mesh(
      scaleUV(new THREE.SphereGeometry(r, 64, 40), 2, 2),
      lib.mat(key),
    );
    sphere.position.set((i - (keys.length - 1) / 2) * spread, 0.14, 0);
    sphere.castShadow = true;
    sphere.receiveShadow = true;
    s.add(sphere);
    const tag = label(key, `${zoom}x zoom`);
    tag.position.set(sphere.position.x, -0.78, 0.4);
    tag.scale.set(1.4, 0.34, 1);
    s.add(tag);
  });
  const camera = new THREE.PerspectiveCamera(34, 2, 0.1, 100);
  camera.position.set(0, 0.3, 3.8);
  camera.lookAt(0, 0.05, 0);
  return {
    scene: s,
    camera,
    x: 0,
    y: 0,
    w: W,
    h: H,
    fit: (cam, aspect) =>
      fitView(cam, aspect, keys.length * spread + 0.9, (keys.length * spread + 0.9) / aspect, 3.8),
  };
}

/* -------------------------------------------------------------------- layout --- */

const grid = buildGridScene();
const env = buildEnvScene();
const tiling = buildTilingScene();
const closeup = buildCloseupScene();

/** Flat, unlit view of the sky map itself: the only way to judge the sun disc and cirrus. */
function buildSkyScene(): View {
  const scene = new THREE.Scene();
  const aspect = W / H;
  const h = 2;
  const w = h * aspect;
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: skyTexture, toneMapped: false }),
  );
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 10);
  camera.position.z = 2;
  return { scene, camera: camera as unknown as THREE.PerspectiveCamera, x: 0, y: 0, w: W, h: H, fit: () => {} };
}

function layout(): View[] {
  if (viewName === 'sky') return [buildSkyScene()];
  if (viewName === 'ramps') return [buildRampsScene()];
  if (viewName === 'grid') return [grid];
  if (viewName === 'env') return [env];
  if (viewName === 'tiling') return [tiling];
  if (viewName === 'closeup') {
    const keys: MatKey[] = ['camoGreen', 'camoRed', 'vehDetail', 'sandbag', 'rust', 'wood'];
    return [buildCloseupScene(undefined, keys, 1.35, 2)];
  }
  // Review sheet: environment strip on top, material grid in the middle, tiling proof
  // and close-up strip along the bottom.
  const envH = Math.round(H * 0.24);
  const bottomH = Math.round(H * 0.21);
  const gridH = H - envH - bottomH;
  const tilingW = Math.round(W * 0.62);
  return [
    { ...grid, x: 0, y: bottomH, w: W, h: gridH },
    { ...env, x: 0, y: H - envH, w: W, h: envH },
    { ...tiling, x: 0, y: 0, w: tilingW, h: bottomH },
    { ...closeup, x: tilingW, y: 0, w: W - tilingW, h: bottomH },
  ];
}

const views = layout();

/* -------------------------------------------------------------------- render --- */

function renderViews(): void {
  for (const view of views) {
    view.fit(view.camera, view.w / view.h);
    renderer.setViewport(view.x, view.y, view.w, view.h);
    renderer.setScissor(view.x, view.y, view.w, view.h);
    renderer.setScissorTest(true);
    renderer.render(view.scene, view.camera);
  }
  renderer.setScissorTest(false);
}

/* ----------------------------------------------------------------------- HUD --- */

function writeHud(frameMs: number, cpuFactor: number): void {
  if (!hud) return;
  const records = libraryTimings(lib);
  const total = records.reduce((a, r) => a + r.ms, 0);
  const bytes = records.reduce((a, r) => a + r.bytes, 0);
  const slowest = [...records].sort((a, b) => b.ms - a.ms).slice(0, 2);
  const rows = slowest
    .map((r) => `<tr><td class="k">${r.key}</td><td>${r.ms.toFixed(1)} ms</td><td class="dim">${r.textures} maps</td></tr>`)
    .join('');
  hud.innerHTML =
    `<b>RETURNED FIRE — procedural surface library</b> <span class="dim">(no image assets on disk)</span><br>` +
    `<span class="dim">${MAT_KEYS.length} materials @ 512px · ORM packed (R=AO, G=rough, B=metal) · normals from metric height fields</span><br>` +
    `<b>${total.toFixed(0)} ms</b> for ${records.length} surfaces · <b>${skyMs.toFixed(0)} ms</b> sky (1024x512) · ` +
    `${(bytes / 1048576).toFixed(1)} MB of maps · first frame ${frameMs.toFixed(0)} ms<br>` +
    `<span class="dim">CPU factor ${cpuFactor.toFixed(2)}x (loaded machine) &rarr; ` +
    `<b>~${(total / cpuFactor).toFixed(0)} ms</b> for the library on an idle laptop</span><br>` +
    `<table>${rows}</table>` +
    `<div class="legend">top: 40-80 m game range, sun 38&deg;/41&deg; · middle: every material on a sphere + crate ` +
    `(one full repeat; last three at world scale) · bottom left: 3x3 tiling · bottom right: 2x close-up</div>`;
}

/* --------------------------------------------------------------------- start --- */

// First frame synchronously so `__READY__` never depends on rAF being scheduled.
const tFrame = performance.now();
renderViews();
const frameMs = performance.now() - tFrame;
// Second calibration sample after generation: the machine may have been busy *during*
// generation, and the slower of the two is the fairer divisor.
const cpuFactorAfter = cpuCalibration();
const loadFactor = Math.max(cpuFactor, cpuFactorAfter);
writeHud(frameMs, loadFactor);
if (params.get('debug') === '1') {
  for (const l of debugLights) {
    const sc = l.shadow.camera;
    console.log(
      `[debug] light pos ${l.position.toArray().map((n) => n.toFixed(1)).join(',')} ` +
        `target ${l.target.position.toArray().map((n) => n.toFixed(1)).join(',')} ` +
        `span ${sc.left}..${sc.right} near/far ${sc.near}/${sc.far} map ${l.shadow.map?.width}x${l.shadow.map?.height} ` +
        `castShadow=${l.castShadow} shadowMapEnabled=${renderer.shadowMap.enabled}`,
    );
  }
}
window.__READY__ = true;
const records = libraryTimings(lib);
const totalMs = records.reduce((a, r) => a + r.ms, 0);
console.log(
  `[textures] ${records.length} surfaces in ${totalMs.toFixed(0)} ms (lib call ${libMs.toFixed(1)} ms), ` +
    `sky ${skyMs.toFixed(0)} ms, first frame ${frameMs.toFixed(0)} ms, ` +
    `cpu factor ${loadFactor.toFixed(2)}x, normalised ${(totalMs / loadFactor).toFixed(0)} ms`,
);
for (const r of records) console.log(`[textures]   ${r.key.padEnd(14)} ${r.ms.toFixed(1)} ms  ${r.textures} maps`);

/*
 * `?selftest=1`: exercises the parts of the contract the sheet does not touch - clone(),
 * unlit(), and dispose() followed by a fresh lazy generation.
 */
if (params.get('selftest') === '1') {
  const cloned = lib.clone('camoGreen', { color: 0xff0000 });
  const unlit = lib.unlit('sand', 0x888888);
  const before = lib.surfaces.sand.map;
  console.log(
    `[selftest] clone is ${cloned.type} rough=${cloned.roughness} metal=${cloned.metalness} ` +
      `map=${cloned.map === lib.surfaces.camoGreen.map} | unlit ${unlit.type} map=${unlit.map === before}`,
  );
  const shared1 = lib.mat('sand');
  const shared2 = lib.mat('sand');
  const loose = lib.mat('sand', { color: 0x123456 });
  console.log(`[selftest] mat cache shared=${shared1 === shared2} override distinct=${loose !== shared1}`);
  lib.dispose();
  const t = performance.now();
  const maps = lib.surfaces.sand;
  console.log(
    `[selftest] after dispose: regenerated in ${(performance.now() - t).toFixed(0)} ms, ` +
      `fresh albedo=${maps.map !== before} normal=${maps.normalMap !== null} orm=${maps.roughnessMap !== undefined} ` +
      `ao=${maps.aoMap !== undefined} worldScale=${maps.worldScale}`,
  );
  console.log(`[selftest] aoMap is the ORM texture: ${maps.aoMap === maps.roughnessMap} channel=${maps.aoMap?.channel}`);
}

/*
 * Render a few frames and stop. The page is static, and a continuous software-rendered
 * animation loop starves the compositor badly enough that Playwright's screenshot
 * capture can time out; the composited frame stays on screen either way.
 */
let framesLeft = 4;
renderer.setAnimationLoop(() => {
  renderViews();
  if (--framesLeft <= 0) renderer.setAnimationLoop(null);
});
