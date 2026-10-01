/**
 * RTS camera controller. OWNER: render-scene agent.
 * Controls: WASD/arrows pan, Q/E rotate, wheel zoom, right-drag rotate/tilt, middle-drag pan, optional edge scroll.
 * Keyboard input must be ignored while focus is in an <input>/<textarea>.
 *
 * Behaviour
 * - Orbit camera around a ground target with smooth exponential damping of target, yaw, pitch and distance.
 * - Hotkeys owned here (see ARCHITECTURE §7): W/A/S/D + arrows pan (Shift = faster), Q/E rotate, = / - zoom,
 *   Home focuses the town. Keys are ignored while typing and when Ctrl/Alt/Meta is held.
 * - Wheel zooms toward the point under the cursor. Right-drag rotates & tilts (rightDragMoved lets INPUT tell a
 *   right-click from a drag). Middle-drag grabs & pans the ground.
 * - Pitch is clamped to ~[17°..28°]-80° (the lower bound relaxes when zoomed in so the horizon can be admired),
 *   distance to 8–120, the target stays inside the map and the camera never dips below the terrain.
 */
import type * as THREE from 'three';
import { WATER_LEVEL } from '../core/constants';
import { heightAt } from '../core/world';
import type { Game } from '../sim/game';
import { gameTownCenter } from './scene/townCenter';

export const CAMERA_MIN_DISTANCE = 8;
export const CAMERA_MAX_DISTANCE = 120;
export const CAMERA_MAX_PITCH = (80 * Math.PI) / 180;
const PITCH_MIN_NEAR = (17 * Math.PI) / 180;
const PITCH_MIN_FAR = (28 * Math.PI) / 180;

/** Minimum pitch for a camera distance: lower when close (cinematic), higher when far (no void beyond the map). */
export function minPitchFor(distance: number): number {
  const t = Math.max(0, Math.min(1, (distance - 12) / (70 - 12)));
  const s = t * t * (3 - 2 * t);
  return PITCH_MIN_NEAR + (PITCH_MIN_FAR - PITCH_MIN_NEAR) * s;
}

const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1], ArrowUp: [0, 1],
  KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
const HANDLED = new Set([
  ...Object.keys(PAN_KEYS), 'KeyQ', 'KeyE', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Home', 'ShiftLeft', 'ShiftRight',
]);

function isTyping(target: EventTarget | null): boolean {
  const el = (target instanceof HTMLElement ? target : null) ?? (document.activeElement as HTMLElement | null);
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
  }
  return false;
}

export class CameraController {
  /** Ground point the camera orbits/looks at. */
  readonly target: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  /** Orbit yaw (radians), pitch (radians above horizontal), distance (world units). */
  yaw = 0;
  pitch = 0.9;
  distance = 40;
  enabled = true;
  edgeScroll = false;
  /** Optional ground picker (set by GameRenderer) used for zoom-toward-cursor. */
  pickGround: ((clientX: number, clientY: number) => { wx: number; wz: number } | null) | null = null;
  /**
   * Optional visible-ground sampler (set by GameRenderer; includes the border ring outside the map) used to keep
   * the camera above the terrain. Falls back to the map heightfield.
   */
  groundHeightAt: ((wx: number, wz: number) => number) | null = null;
  /**
   * How fast the view changed during the last update, as an approximate fraction of the screen per second
   * (pan relative to the zoom + rotation + zoom rate). ~0 when still; > ~0.15 is a fast move.
   */
  viewSpeed = 0;
  /** Performance.now() of the last user input the camera reacted to (keys, drag, wheel). */
  lastInputAt = 0;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;
  private game: Game;
  /** Desired values; the visible camera eases toward them. */
  private readonly goal = { x: 0, z: 0, yaw: 0, pitch: 0.9, distance: 40 };
  private groundY = 0;
  private readonly keys = new Set<string>();
  private rightDown = false;
  private middleDown = false;
  private rightMoved = 0;
  private lastX = 0;
  private lastY = 0;
  private pointerX = -1;
  private pointerY = -1;
  private pointerInWindow = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, game: Game) {
    this.camera = camera;
    this.dom = dom;
    this.game = game;
    this.bind();
    this.setGame(game);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  setGame(game: Game): void {
    this.game = game;
    const c = gameTownCenter(game);
    this.jumpTo(c.x, c.z, 42);
  }

  /** Instantly place the camera (no easing). */
  jumpTo(wx: number, wz: number, distance?: number): void {
    this.focusOn(wx, wz, distance);
    const g = this.goal;
    this.target.x = g.x;
    this.target.z = g.z;
    this.yaw = g.yaw;
    this.pitch = g.pitch;
    this.distance = g.distance;
    this.groundY = this.sampleGround(g.x, g.z);
    this.target.y = this.groundY;
    this.apply();
    this.viewSpeed = 10; // a jump counts as a fast move (fresh shadows, re-cull)
  }

  /**
   * Instantly restore a full view (focus, distance and orientation) — e.g. after a co-op resync rebuilt the same town,
   * or to look where another player is looking. Pitch is clamped like any other goal.
   */
  jumpToView(wx: number, wz: number, view: { distance?: number; yaw?: number; pitch?: number }): void {
    if (view.yaw !== undefined && Number.isFinite(view.yaw)) this.goal.yaw = view.yaw;
    if (view.pitch !== undefined && Number.isFinite(view.pitch)) this.goal.pitch = view.pitch;
    this.jumpTo(wx, wz, view.distance !== undefined && Number.isFinite(view.distance) ? view.distance : undefined);
  }

  /** True while the camera is still easing towards its goal or the user is steering it (keys / drag). */
  get isMoving(): boolean {
    if (this.keys.size > 0 || this.rightDown || this.middleDown) return true;
    const g = this.goal;
    return Math.abs(g.x - this.target.x) > 0.01 || Math.abs(g.z - this.target.z) > 0.01
      || Math.abs(g.yaw - this.yaw) > 1e-4 || Math.abs(g.pitch - this.pitch) > 1e-4
      || Math.abs(g.distance - this.distance) > 0.01 * this.distance;
  }

  focusOn(wx: number, wz: number, distance?: number): void {
    this.goal.x = wx;
    this.goal.z = wz;
    if (distance !== undefined) this.goal.distance = distance;
    this.clampGoal();
  }

  /** Smoothly fly to the town centre. */
  focusTown(): void {
    const c = gameTownCenter(this.game);
    this.focusOn(c.x, c.z);
  }

  /** Pixels the pointer moved during the current/last right-button press (INPUT treats < 5 as a click). */
  get rightDragMoved(): number {
    return this.rightMoved;
  }

  // ---- per frame -------------------------------------------------------------------------------

  /** Apply keyboard/mouse motion and write the camera transform. */
  update(realDt: number): void {
    const dt = Math.min(0.1, Math.max(0, realDt));
    const g = this.goal;
    if (this.enabled) {
      const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 2.4 : 1;
      let mx = 0;
      let mz = 0;
      for (const k of this.keys) {
        const d = PAN_KEYS[k];
        if (d) {
          mx += d[0];
          mz += d[1];
        }
      }
      if (this.edgeScroll && this.pointerInWindow && !this.rightDown && !this.middleDown) {
        const m = 12;
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (this.pointerX >= 0 && this.pointerX < m) mx -= 1;
        else if (this.pointerX > w - m) mx += 1;
        if (this.pointerY >= 0 && this.pointerY < m) mz += 1;
        else if (this.pointerY > h - m) mz -= 1;
      }
      if (mx !== 0 || mz !== 0) {
        const len = Math.hypot(mx, mz);
        const speed = (g.distance * 0.8 + 5) * fast * dt / len;
        this.panGoal(mx * speed, mz * speed);
      }
      if (this.keys.has('KeyQ')) g.yaw += 1.7 * dt;
      if (this.keys.has('KeyE')) g.yaw -= 1.7 * dt;
      if (this.keys.has('Equal') || this.keys.has('NumpadAdd')) g.distance *= Math.exp(-1.6 * dt);
      if (this.keys.has('Minus') || this.keys.has('NumpadSubtract')) g.distance *= Math.exp(1.6 * dt);
    }
    this.clampGoal();
    const px = this.target.x;
    const pz = this.target.z;
    const pyaw = this.yaw;
    const ppitch = this.pitch;
    const pdist = this.distance;

    // exponential smoothing (frame-rate independent)
    const k = 1 - Math.exp(-dt * 10);
    const kz = 1 - Math.exp(-dt * 9);
    this.target.x += (g.x - this.target.x) * k;
    this.target.z += (g.z - this.target.z) * k;
    this.yaw += (g.yaw - this.yaw) * k;
    this.pitch += (g.pitch - this.pitch) * k;
    this.distance = Math.exp(Math.log(this.distance) + (Math.log(g.distance) - Math.log(this.distance)) * kz);
    const gy = this.sampleGround(this.target.x, this.target.z);
    this.groundY += (gy - this.groundY) * (1 - Math.exp(-dt * 6));
    this.target.y = this.groundY;
    this.apply();
    if (dt > 0) {
      const move = Math.hypot(this.target.x - px, this.target.z - pz) / Math.max(1, this.distance)
        + Math.abs(this.yaw - pyaw) + Math.abs(this.pitch - ppitch) + Math.abs(Math.log(this.distance / pdist));
      this.viewSpeed = move / dt;
    }
  }

  private apply(): void {
    const cam = this.camera;
    const cp = Math.cos(this.pitch);
    let px = this.target.x + Math.sin(this.yaw) * cp * this.distance;
    let py = this.target.y + Math.sin(this.pitch) * this.distance;
    let pz = this.target.z + Math.cos(this.yaw) * cp * this.distance;
    // keep the camera above the ground (and the decorative border hills)
    let ground = this.sampleGround(px, pz);
    if (this.groundHeightAt) {
      const g = this.groundHeightAt(px, pz);
      if (Number.isFinite(g) && g > ground) ground = g;
    }
    const floor = ground + 1.2;
    if (py < floor) py = floor;
    if (!Number.isFinite(px + py + pz)) {
      px = this.target.x;
      py = this.target.y + 40;
      pz = this.target.z + 1;
    }
    cam.position.set(px, py, pz);
    cam.lookAt(this.target.x, this.target.y, this.target.z);
    const near = Math.max(0.3, Math.min(3, this.distance * 0.03));
    if (Math.abs(cam.near - near) > 0.02) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  private sampleGround(wx: number, wz: number): number {
    const s = this.game.state;
    return Math.max(WATER_LEVEL, heightAt(s, wx, wz));
  }

  private clampGoal(): void {
    const g = this.goal;
    const s = this.game.state;
    g.distance = Math.max(CAMERA_MIN_DISTANCE, Math.min(CAMERA_MAX_DISTANCE, g.distance));
    g.pitch = Math.max(minPitchFor(g.distance), Math.min(CAMERA_MAX_PITCH, g.pitch));
    g.x = Math.max(0.5, Math.min(s.W - 0.5, g.x));
    g.z = Math.max(0.5, Math.min(s.H - 0.5, g.z));
    // keep yaw bounded while preserving the smoothing path
    if (Math.abs(g.yaw) > Math.PI * 4) {
      const wrap = Math.round(g.yaw / (Math.PI * 2)) * Math.PI * 2;
      g.yaw -= wrap;
      this.yaw -= wrap;
    }
  }

  /** Pan the goal by (right, forward) in world units relative to the view direction. */
  private panGoal(right: number, forward: number): void {
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // forward = from camera toward target, projected on the ground: (-sin yaw, -cos yaw); right = (cos yaw, -sin yaw)
    this.goal.x += cy * right - sy * forward;
    this.goal.z += -sy * right - cy * forward;
  }

  private worldPerPixel(): number {
    const h = this.dom.clientHeight || window.innerHeight || 1;
    return (2 * this.distance * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
  }

  // ---- input -----------------------------------------------------------------------------------

  private bind(): void {
    const on = <K extends keyof WindowEventMap>(t: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    const onDom = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      this.dom.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => this.dom.removeEventListener(type, fn as EventListener, opts));
    };

    on(window, 'keydown', (e) => {
      if (!HANDLED.has(e.code)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if (e.code === 'Home') {
        if (this.enabled) this.focusTown();
        e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      this.lastInputAt = performance.now();
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
    on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
    });
    on(window, 'blur', () => {
      this.keys.clear();
      this.rightDown = false;
      this.middleDown = false;
    });

    onDom('pointerdown', (e) => {
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (e.button === 2) {
        this.rightDown = true;
        this.rightMoved = 0;
      } else if (e.button === 1) {
        this.middleDown = true;
        e.preventDefault(); // no autoscroll cursor
      }
    });
    on(window, 'pointermove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.pointerInWindow = true;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.rightDown || this.middleDown) this.lastInputAt = performance.now();
      if (this.rightDown) {
        this.rightMoved += Math.abs(dx) + Math.abs(dy);
        if (this.enabled && this.rightMoved >= 3) {
          this.goal.yaw -= dx * 0.0065;
          this.goal.pitch += dy * 0.005;
          this.clampGoal();
        }
      } else if (this.middleDown && this.enabled) {
        const wpp = this.worldPerPixel();
        const tilt = 1 / Math.max(0.35, Math.sin(this.pitch));
        this.panGoal(-dx * wpp, dy * wpp * tilt);
      }
    });
    on(window, 'pointerup', (e) => {
      if (e.button === 2) this.rightDown = false;
      else if (e.button === 1) this.middleDown = false;
    });
    on(window, 'pointercancel', () => {
      this.rightDown = false;
      this.middleDown = false;
    });
    const docOut = (e: MouseEvent) => {
      if (!e.relatedTarget) this.pointerInWindow = false;
    };
    document.addEventListener('mouseout', docOut);
    this.cleanup.push(() => document.removeEventListener('mouseout', docOut));

    onDom('wheel', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      this.lastInputAt = performance.now();
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= 100;
      delta = Math.max(-300, Math.min(300, delta));
      const g = this.goal;
      const old = g.distance;
      const next = Math.max(CAMERA_MIN_DISTANCE, Math.min(CAMERA_MAX_DISTANCE, old * Math.exp(delta * 0.0014)));
      if (next === old) return;
      // zoom toward the ground point under the cursor (keeps it roughly fixed on screen)
      const p = this.pickGround?.(e.clientX, e.clientY) ?? null;
      if (p) {
        const f = 1 - next / old;
        g.x += (p.wx - g.x) * f;
        g.z += (p.wz - g.z) * f;
      }
      g.distance = next;
      this.clampGoal();
    }, { passive: false });
    onDom('contextmenu', (e) => e.preventDefault());
    onDom('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup.length = 0;
    this.keys.clear();
  }
}
