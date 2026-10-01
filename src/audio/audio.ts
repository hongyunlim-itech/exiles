/**
 * AudioManager — procedural WebAudio (no asset files): ambient wind/birds/crickets by season & time of day,
 * positional-ish work sounds from GameEvents.sound, UI clicks. OWNER: input agent.
 *
 * - The AudioContext is created lazily in unlock() (browser autoplay policy). Without WebAudio (headless tests, old
 *   browsers) every method is a silent no-op; no method ever throws.
 * - Mix: master → limiter → speakers; sfx bus and ambient bus feed master (volumes from settings).
 * - Event sounds are attenuated by distance from the camera focus and by zoom, rate-limited per cue and capped at
 *   MAX_VOICES concurrent voices (lower-priority/older voices are stolen for important cues).
 */
import type { GameEvents } from '../core/types';
import type { Game } from '../sim/game';
import { AmbientBed } from './ambient';
import { AudioEngine, audioContextCtor, type Voice } from './engine';
import { clamp01, computeAmbientTargets, envRadius, positionalGain, sampleEnvironment, type AmbientTargets, type EnvSample } from './environment';
import * as sfx from './sfx';

export type UiCue = 'click' | 'place' | 'error' | 'open' | 'close' | 'notify' | 'danger';

/** Every event sound the manager can play (GameEvents 'sound' cues plus event-driven extras). */
export type SfxCue = GameEvents['sound']['cue'] | 'alarm' | 'merchant';

/** Max concurrent sfx/UI voices. */
export const MAX_VOICES = 8;

interface CueDef {
  play: (v: Voice, t: number) => void;
  /** Base loudness. */
  gain: number;
  /** Minimum seconds between two plays of this cue. */
  cooldown: number;
  /** Voice-stealing priority (higher wins). */
  priority: number;
  /** Cooldown group (cues in the same group rate-limit each other); defaults to the cue name. */
  group?: string;
}

/**
 * Event cue table. Gains are calibrated (dev/input/audiolevels.mjs, default volumes, source at the listener) to peak
 * around -12 dBFS for work sounds and -9 dBFS for alarms/tolls.
 */
export const SFX_CUES: Readonly<Record<SfxCue, Readonly<CueDef>>> = {
  chop: { play: sfx.chop, gain: 1.0, cooldown: 0.09, priority: 1 },
  hammer: { play: sfx.hammer, gain: 1.1, cooldown: 0.08, priority: 1 },
  dig: { play: sfx.dig, gain: 0.45, cooldown: 0.12, priority: 1 },
  splash: { play: sfx.splash, gain: 0.7, cooldown: 0.2, priority: 1 },
  fire: { play: sfx.fire, gain: 0.19, cooldown: 0.35, priority: 2 },
  // The sim rings 'bell' when a fire starts (alongside fireStarted): both map to the alarm bell and share a cooldown.
  bell: { play: sfx.alarmBell, gain: 0.85, cooldown: 3, priority: 3, group: 'alarm' },
  alarm: { play: sfx.alarmBell, gain: 0.85, cooldown: 3, priority: 3, group: 'alarm' },
  birth: { play: sfx.birthChime, gain: 0.7, cooldown: 1.0, priority: 2 },
  death: { play: sfx.deathToll, gain: 0.55, cooldown: 2.5, priority: 3 },
  build: { play: sfx.buildComplete, gain: 1.1, cooldown: 0.4, priority: 2 },
  merchant: { play: sfx.merchantHorn, gain: 0.75, cooldown: 5, priority: 3 },
};

/** UI cue table (calibrated to peak around -18..-14 dBFS at default volumes). */
export const UI_CUE_DEFS: Readonly<Record<UiCue, Readonly<{ play: (v: Voice, t: number) => void; gain: number; cooldown: number }>>> = {
  click: { play: sfx.uiClick, gain: 1.0, cooldown: 0.03 },
  place: { play: sfx.uiPlace, gain: 0.85, cooldown: 0.05 },
  error: { play: sfx.uiError, gain: 1.3, cooldown: 0.15 },
  open: { play: sfx.uiOpen, gain: 1.4, cooldown: 0.05 },
  close: { play: sfx.uiClose, gain: 1.4, cooldown: 0.05 },
  notify: { play: sfx.uiNotify, gain: 1.0, cooldown: 0.3 },
  danger: { play: sfx.uiDanger, gain: 1.2, cooldown: 0.5 },
};

const CUES = SFX_CUES;
const UI_CUES = UI_CUE_DEFS;

/** UI voices always win against world sounds. */
const UI_PRIORITY = 4;
/** Below this final gain a sound is not worth a voice. */
const MIN_AUDIBLE = 0.012;
/** Seconds between environment samples around the camera focus. */
const ENV_INTERVAL = 0.5;

/**
 * Stereo pan (-1..1) for a sound offset (dx, dz) from the listener with ground-plane right vector (rx, rz).
 * Nearby sounds stay near the centre; without an orientation a slight random spread is used.
 */
export function stereoPan(dx: number, dz: number, rx: number, rz: number): number {
  if (rx === 0 && rz === 0) return (Math.random() - 0.5) * 0.3;
  const side = dx * rx + dz * rz;
  const p = side / Math.max(8, Math.hypot(dx, dz));
  return Math.max(-0.8, Math.min(0.8, p * 0.8));
}

export class AudioManager {
  private engine: AudioEngine | null = null;
  private ambient: AmbientBed | null = null;
  private game: Game | null = null;
  private readonly offs: Array<() => void> = [];
  private masterVol = 0.7;
  private sfxVol = 0.8;
  private ambientVol = 0.6;
  private focusX = 0;
  private focusZ = 0;
  private distance = 40;
  /** Listener's right direction on the ground plane (unit); 0,0 = unknown (no directional panning). */
  private rightX = 0;
  private rightZ = 0;
  private envTimer = 0;
  private readonly env: EnvSample = { water: 0, trees: 0 };
  private readonly targets: AmbientTargets = { wind: 0, windBright: 0, rain: 0, water: 0, birdRate: 0, cricketRate: 0 };
  private readonly lastPlayed: Record<string, number> = {};
  private unavailable = false;
  private disposed = false;
  private warned = false;
  private visibilityBound = false;

  constructor() {
    // Nothing to do until unlock(): creating an AudioContext before a user gesture yields a suspended context and a
    // console warning in most browsers.
  }

  /** Must be called from a user gesture before sound can play (browser autoplay policy). Safe to call repeatedly. */
  unlock(): void {
    this.guard(() => {
      if (this.disposed || this.unavailable) return;
      if (!this.engine) {
        const Ctor = audioContextCtor();
        if (!Ctor) {
          this.unavailable = true;
          return;
        }
        const ctx = new Ctor({ latencyHint: 'interactive' });
        this.engine = new AudioEngine(ctx, MAX_VOICES);
        this.applyVolumes(true);
        this.ambient = new AmbientBed(this.engine);
        this.bindVisibility();
      }
      const ctx = this.engine.ctx;
      if (ctx.state === 'suspended' && !this.pageHidden()) void ctx.resume().catch(() => undefined);
    });
  }

  /** Bind to a game's events (unbinding the previous one). */
  attach(game: Game): void {
    this.guard(() => {
      this.detach();
      this.game = game;
      this.envTimer = 0;
      const ev = game.events;
      this.offs.push(ev.on('sound', (e) => this.playAt(e.cue, e.x, e.z)));
      this.offs.push(ev.on('buildingCompleted', ({ id }) => {
        const b = game.getBuilding(id);
        if (b) this.playAt('build', b.x + b.w / 2, b.z + b.h / 2, 0.3);
      }));
      this.offs.push(ev.on('citizenBorn', ({ id }) => {
        const c = game.getCitizen(id);
        if (c) this.playAt('birth', c.x, c.z, 0.3);
        else this.playGlobal('birth', 0.4);
      }));
      this.offs.push(ev.on('citizenDied', () => this.playGlobal('death', 0.6)));
      this.offs.push(ev.on('fireStarted', ({ buildingId }) => {
        const b = game.getBuilding(buildingId);
        if (b) this.playAt('alarm', b.x + b.w / 2, b.z + b.h / 2, 0.65);
        else this.playGlobal('alarm', 0.8);
      }));
      this.offs.push(ev.on('merchantArrived', () => this.playGlobal('merchant', 0.7)));
    });
  }

  setVolumes(master: number, sfxVolume: number, ambient: number): void {
    this.guard(() => {
      this.masterVol = clamp01(Number.isFinite(master) ? master : 0.7);
      this.sfxVol = clamp01(Number.isFinite(sfxVolume) ? sfxVolume : 0.8);
      this.ambientVol = clamp01(Number.isFinite(ambient) ? ambient : 0.6);
      this.applyVolumes(false);
    });
  }

  /** Per frame: listener focus (camera target) and zoom distance for attenuation; ambient crossfades. */
  update(realDt: number, focusX: number, focusZ: number, cameraDistance: number): void {
    try {
      if (Number.isFinite(focusX)) this.focusX = focusX;
      if (Number.isFinite(focusZ)) this.focusZ = focusZ;
      if (Number.isFinite(cameraDistance) && cameraDistance > 0) this.distance = cameraDistance;
      const engine = this.engine;
      const game = this.game;
      if (!engine || !this.ambient || !game || engine.ctx.state !== 'running') return;
      const dt = Math.min(0.25, Math.max(0, realDt || 0));
      const state = game.state;
      this.envTimer -= dt;
      if (this.envTimer <= 0) {
        this.envTimer = ENV_INTERVAL;
        sampleEnvironment(state, this.focusX, this.focusZ, envRadius(this.distance), this.env);
      }
      computeAmbientTargets(state, this.env, this.distance, this.targets);
      this.ambient.update(dt, this.targets);
    } catch (err) {
      this.report(err);
    }
  }

  /**
   * Listener orientation for stereo panning of world sounds: the camera's right vector projected on the ground
   * (e.g. camera.matrixWorld.elements[0], [2]). InputManager feeds this whenever the camera moves.
   */
  setListenerOrientation(rightX: number, rightZ: number): void {
    const len = Math.hypot(rightX, rightZ);
    if (!Number.isFinite(len) || len < 1e-6) return;
    this.rightX = rightX / len;
    this.rightZ = rightZ / len;
  }

  playUi(cue: UiCue): void {
    this.guard(() => {
      // UI cues come from user gestures, so this is a good moment to (re)unlock.
      if (!this.engine || this.engine.ctx.state === 'suspended') this.unlock();
      const engine = this.engine;
      const def = UI_CUES[cue];
      if (!engine || !def || engine.ctx.state !== 'running') return;
      const now = engine.now;
      const key = `ui:${cue}`;
      if (now - (this.lastPlayed[key] ?? -1e9) < def.cooldown) return;
      this.lastPlayed[key] = now;
      const v = engine.voice(UI_PRIORITY, def.gain);
      if (v) def.play(v, now + 0.003);
    });
  }

  /** Play a world sound at (x, z): attenuated by distance from the camera focus and zoom (never below `minGain`). */
  playAt(cue: SfxCue, x: number, z: number, minGain = 0): void {
    try {
      if (!this.engine) return;
      const g = positionalGain(x, z, this.focusX, this.focusZ, this.distance);
      this.play(cue, Math.max(minGain, g), stereoPan(x - this.focusX, z - this.focusZ, this.rightX, this.rightZ));
    } catch (err) {
      this.report(err);
    }
  }

  /** Play a non-positional world sound at a fixed relative level. */
  playGlobal(cue: SfxCue, level = 1): void {
    try {
      this.play(cue, level, 0);
    } catch (err) {
      this.report(err);
    }
  }

  /** Voices currently sounding (for debugging/tests). */
  get activeVoices(): number {
    try {
      return this.engine?.activeVoices ?? 0;
    } catch {
      return 0;
    }
  }

  /** True once an AudioContext exists and is running. */
  get running(): boolean {
    return !!this.engine && this.engine.ctx.state === 'running';
  }

  dispose(): void {
    this.guard(() => {
      if (this.disposed) return;
      this.disposed = true;
      this.detach();
      if (this.visibilityBound && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
      this.ambient?.dispose();
      this.ambient = null;
      if (this.engine) {
        this.engine.stopAll();
        void this.engine.ctx.close().catch(() => undefined);
        this.engine = null;
      }
    });
  }

  // ---------------------------------------------------------------------------------------------

  private play(cue: SfxCue, level: number, pan: number): void {
    const engine = this.engine;
    const def = CUES[cue];
    if (!engine || !def || engine.ctx.state !== 'running') return;
    const gain = def.gain * clamp01(level);
    if (gain < MIN_AUDIBLE) return;
    const now = engine.now;
    const key = def.group ?? cue;
    if (now - (this.lastPlayed[key] ?? -1e9) < def.cooldown) return;
    const v = engine.voice(def.priority, gain, pan);
    if (!v) return;
    this.lastPlayed[key] = now;
    def.play(v, now + 0.005);
  }

  private pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  /** Silence everything while the tab is hidden (the game loop stops too) and resume when it returns. */
  private bindVisibility(): void {
    if (this.visibilityBound || typeof document === 'undefined') return;
    this.visibilityBound = true;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onVisibility = (): void => {
    const ctx = this.engine?.ctx;
    if (!ctx || this.disposed || ctx.state === 'closed') return;
    if (this.pageHidden()) void ctx.suspend().catch(() => undefined);
    else void ctx.resume().catch(() => undefined);
  };

  private detach(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.game = null;
  }

  private applyVolumes(immediate: boolean): void {
    const e = this.engine;
    if (!e) return;
    const now = e.now;
    const set = (p: AudioParam, v: number) => {
      if (immediate) p.setValueAtTime(v, now);
      else p.setTargetAtTime(v, now, 0.05);
    };
    // perceptual (squared) volume curve
    set(e.master.gain, this.masterVol * this.masterVol);
    set(e.sfx.gain, this.sfxVol * this.sfxVol);
    set(e.ambient.gain, this.ambientVol * this.ambientVol * 0.9);
  }

  /** Run `fn`, swallowing (and reporting once) any error: audio must never break the game. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.report(err);
    }
  }

  private report(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    try {
      console.warn('[audio] error (audio continues where possible)', err);
    } catch {
      /* ignore */
    }
  }
}
