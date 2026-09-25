/**
 * Tilted top-down camera, in the spirit of the 1995 original but in real 3D:
 * the view keeps a fixed compass heading (readable, like the original's fixed
 * top-down framing) while the terrain, models and shadows carry the depth. Players can
 * rotate the view and zoom; the camera leads the vehicle slightly in its direction of travel.
 * `Tab` switches between the default framing and a second, steeper tilt of the same framing.
 */
import * as THREE from 'three';
import { clamp, lerp } from './math.js';

export type CameraMode = 'fixed' | 'tilt';

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** Compass heading the camera looks along (radians, 0 = +Z). */
  yaw: number;
  zoom: number;
  mode: CameraMode;
  /**
   * Current down-tilt below horizontal (radians). Read-only and derived from `mode`, so a
   * harness can assert that the second mode really is framed further over rather than
   * trusting a screenshot.
   */
  readonly elevation: number;
  update(dt: number, target: THREE.Vector3, targetYaw: number, speed: number, focus: number): void;
  rotateBy(radians: number): void;
  setYaw(y: number): void;
  zoomBy(delta: number): void;
  shake(amount: number): void;
  setMode(m: CameraMode): void;
  /** Ground point under the mouse, used for mouse aiming. */
  groundPoint(ndc: THREE.Vector2, heightAt: (x: number, z: number) => number, out: THREE.Vector3): THREE.Vector3;
  readonly height: number;
}

/**
 * Default framing: 58 deg below horizontal, north-up, vehicle led along its travel direction.
 */
const ELEVATION = THREE.MathUtils.degToRad(58);
/**
 * Second mode: the same north-up framing, tilted further over **and** pulled back, because on a
 * perspective rig the two halves of the request pull against each other. Tilted alone, 66 deg
 * shows *less* ground than the default 58 deg (58.8 m of view-axis ground against 65.7 m at
 * zoom 1 — a steeper camera sees less far, and a straight-down one only 51.8 m), so "tilt it
 * more so more terrain is visible" can only be honoured by paying for the tilt with distance.
 * At `TILT_DISTANCE` this mode covers 79.5 m along the view axis (+21 % over the default) while
 * still being 8 deg more top-down.
 *
 * 66 deg specifically is the largest tilt that still keeps the whole frame looking forward: at
 * 66 deg the bottom-of-frame ray is 89 deg below horizontal (just short of vertical), whereas
 * at 67 deg and beyond it swings past vertical and the near edge of the ground patch ends up
 * behind the camera.
 *
 * It kept the two-mode shape and `Tab`; manual rotation (`Q`/`E`) and zoom work in both.
 */
const ELEVATION_TILT = THREE.MathUtils.degToRad(66);
/** Extra camera distance in the tilt mode, so the steeper framing still shows more ground. */
const TILT_DISTANCE = 1.35;
/** Default camera distance at zoom 1. Exported so the editor's overview can size a frame. */
export const BASE_DISTANCE = 61;
/**
 * Metres of ground the rig is biased along the vehicle's *direction of travel*, so the road
 * ahead stays in frame whichever way the player is driving.
 *
 * This used to be a bias along the *view* axis (`LOOK_AHEAD = 11`), which is a fixed compass
 * direction: the frame showed a fixed window and the vehicle simply sat in it. Because the
 * view is north-up and the camera looks down the map at ~57 deg, that window reaches only
 * ~5 m of ground behind the vehicle and ~50 m ahead of it along the view axis. Driving north
 * looks into the 50 m half; driving south looks into the 5 m half, so a southbound player saw
 * almost nothing of the road — 8 m by measurement, against 51 m northbound.
 *
 * Biasing along the travel direction instead keeps the window centred on where the vehicle is
 * going: measured across all four compass headings the ground ahead of the hull is 31-52 m
 * (~1.3x spread) against 8-51 m (6.4x) before, and it no longer depends on speed, which used
 * to steepen the swing further. The bias is 12 m and does not grow with speed, so the hull's
 * screen position is steady through acceleration. At zoom 1 the hull sits 32 % (southbound) to
 * 80 % (northbound) of the way down the frame — low in frame, as the original requested, but
 * never at the bottom edge with the road hidden.
 */
const TRAVEL_BIAS = 12;
/**
 * Zoom limits. `BASE_DISTANCE * ZOOM_MAX` is the camera distance at full zoom-out: 61 * 5 =
 * 305 m, which frames roughly 260 x 460 m of ground — most of the 512 m world, so a player can
 * actually take in the map and plan a route. The old 2.4 cap showed ~120 m of a 256 m world
 * (a fifth of it) and is a large part of why the maps read as "too small".
 */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5.0;
/**
 * How much of the travel bias survives at full zoom-out. At `ZOOM_MIN` the whole frame is only
 * ~30 m of ground deep, so an un-faded 12 m would push the vehicle right off the bottom: the
 * fade keeps it in frame (89 % from the top, 22 m of road ahead) while leaving the framing at
 * normal zoom untouched.
 */
const TRAVEL_BIAS_FADE = 0.45;

/**
 * `?zoom=N` starts the rig at a fixed zoom, clamped to the normal limits.
 *
 * It exists for reproducible framing: the wheel path depends on frame timing, so a headless
 * capture cannot replay a zoom-out exactly. `capture.mjs`-style harnesses use it to put the
 * same camera distance on two builds (e.g. `?zoom=2.4` is the old zoom-out limit).
 */
function bootZoom(): number {
  if (typeof location === 'undefined') return 1;
  const raw = new URLSearchParams(location.search).get('zoom');
  const v = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? clamp(v, ZOOM_MIN, ZOOM_MAX) : 1;
}

export function createCameraRig(camera: THREE.PerspectiveCamera): CameraRig {
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  let settled = false;
  let shakeAmount = 0;
  let shakeTime = 0;
  let manualYaw = 0;
  let manualTimer = 0;

  const rig: CameraRig = {
    camera,
    yaw: 0,
    zoom: 1,
    mode: 'fixed',
    update(dt, target, targetYaw, speed, focus) {
      // A non-finite target must never reach the follow vector. The critically damped lerp
      // below cannot recover from a NaN - `pos` would stay NaN for the rest of the match and
      // the camera would render nothing (a black screen) - so a bad frame is skipped and a
      // poisoned `pos` is re-seated instead of being averaged.
      if (!Number.isFinite(target.x + target.y + target.z + targetYaw + speed + focus)) return;
      // Bias the whole rig along the vehicle's travel direction, so the visible ground ahead
      // is the same whichever compass heading the player is driving (see TRAVEL_BIAS). The
      // bias is a constant, not a speed term: it must not drift the framing as the player
      // accelerates. Zoomed out it is faded, because at ZOOM_MIN the frame is only ~30 m of
      // ground deep and an un-faded 12 m would put the vehicle at its bottom edge.
      const zoomOut = clamp((rig.zoom - 1) / (ZOOM_MAX - 1), 0, 1);
      const travelBias = TRAVEL_BIAS * lerp(1, TRAVEL_BIAS_FADE, zoomOut);
      look.set(
        target.x + Math.sin(targetYaw) * travelBias,
        target.y,
        target.z + Math.cos(targetYaw) * travelBias,
      );

      manualTimer -= dt;
      // Both modes are north-up: the compass heading is a fixed framing, never the vehicle's
      // travel direction (that was the old 'chase' mode, which the player reported as not
      // making sense). Manual Q/E rotation holds for a moment, then the view eases home.
      if (manualTimer <= 0) {
        rig.yaw = angleLerp(rig.yaw, 0, 1 - Math.exp(-dt * 0.8));
      }

      const elevation = rig.mode === 'tilt' ? ELEVATION_TILT : ELEVATION;
      const dist = BASE_DISTANCE * rig.zoom * focus * (rig.mode === 'tilt' ? TILT_DISTANCE : 1);
      const horiz = Math.cos(elevation) * dist;
      const vert = Math.sin(elevation) * dist;
      desired.set(
        look.x - Math.sin(rig.yaw) * horiz,
        look.y + vert,
        look.z - Math.cos(rig.yaw) * horiz,
      );

      // Critically damped follow: snappy but never jittery. The first update snaps, so a
      // match never opens with the camera swooping in from nowhere.
      if (!settled || !Number.isFinite(pos.x + pos.y + pos.z)) {
        pos.copy(desired);
        settled = true;
      } else {
        pos.lerp(desired, 1 - Math.exp(-dt * 6.5));
      }
      camera.position.copy(pos);

      shakeTime += dt;
      if (shakeAmount > 0.0005) {
        const s = shakeAmount;
        camera.position.x += Math.sin(shakeTime * 47.0) * s;
        camera.position.y += Math.sin(shakeTime * 61.0) * s * 0.7;
        camera.position.z += Math.cos(shakeTime * 53.0) * s;
        shakeAmount *= Math.exp(-dt * 3.4);
      }
      camera.lookAt(look.x, look.y + 1.5, look.z);
    },
    rotateBy(radians) {
      manualYaw = rig.yaw + radians;
      rig.yaw = manualYaw;
      manualTimer = 2.2;
    },
    setYaw(y) {
      rig.yaw = y;
      manualTimer = 2.2;
    },
    zoomBy(delta) {
      rig.zoom = clamp(rig.zoom * (1 + delta), ZOOM_MIN, ZOOM_MAX);
    },
    shake(amount) {
      shakeAmount = Math.min(1.6, shakeAmount + amount);
    },
    setMode(m) {
      rig.mode = m;
    },
    groundPoint(ndc, heightAt, out) {
      ray.setFromCamera(ndc, camera);
      // March the ray until it dips under the terrain, then bisect: cheap and robust. The
      // reach follows the zoom, otherwise aiming near the top of a zoomed-out frame silently
      // clamps at the old ~150 m limit and every long shot falls short.
      const reach = 220 + rig.zoom * 170;
      const step = reach / 96;
      const origin = ray.ray.origin;
      const dir = ray.ray.direction;
      let t = 0;
      let prevAbove = true;
      let hit = reach;
      for (let i = 0; i < 96; i++) {
        t += step;
        const x = origin.x + dir.x * t;
        const y = origin.y + dir.y * t;
        const z = origin.z + dir.z * t;
        const above = y > heightAt(x, z);
        if (prevAbove && !above) {
          hit = t;
          break;
        }
        prevAbove = above;
      }
      out.set(origin.x + dir.x * hit, origin.y + dir.y * hit, origin.z + dir.z * hit);
      out.y = heightAt(out.x, out.z);
      return out;
    },
    get height() {
      return camera.position.y;
    },
    get elevation() {
      return rig.mode === 'tilt' ? ELEVATION_TILT : ELEVATION;
    },
  };

  pos.set(0, 80, -40);
  rig.zoom = bootZoom();
  return rig;
}

function angleLerp(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export { lerp };
