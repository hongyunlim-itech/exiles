/**
 * Performance policy helpers (render/app performance) — pure logic, unit-tested in tests/render.perf.test.ts:
 *  - GPU tier detection from the WebGL renderer string (quality 'auto'),
 *  - per-tier pixel-ratio caps,
 *  - dynamic resolution controller (render scale from smoothed frame times),
 *  - frame pacer (FPS cap + idle throttling) used by the main loop.
 */

export type QualityTier = 'low' | 'medium' | 'high';
export type QualitySetting = QualityTier | 'auto';

/**
 * Tier for a GPU from its (unmasked) WebGL renderer string, e.g.
 * "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" → medium,
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 …)" → high, SwiftShader / llvmpipe → low.
 * Integrated GPUs (Intel, AMD APUs "Radeon(TM) Graphics"/"Vega 8 Graphics"/"780M", Apple base M-chips, mobile)
 * are medium; discrete GPUs are high; unknown strings are medium.
 */
export function classifyGpu(renderer: string | null | undefined): QualityTier {
  const r = (renderer ?? '').toLowerCase();
  if (!r) return 'medium';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen|virgl/.test(r)) return 'low';
  // discrete NVIDIA / AMD / Intel Arc (A-series) GPUs
  if (/nvidia|geforce|quadro|rtx|gtx|tesla|titan/.test(r)) return 'high';
  if (/radeon\s*(\(tm\)\s*)?(rx|pro|r9|r7|vii|hd\s*[78]\d{3})/.test(r) && !/radeon\s*(\(tm\)\s*)?rx\s*vega\s*\d+\s*graphics/.test(r)) return 'high';
  if (/\barc\b.*\ba\d{3}/.test(r)) return 'high';
  if (/apple m\d+\s*(pro|max|ultra)/.test(r)) return 'high';
  // integrated / mobile
  if (/intel|iris|uhd|hd graphics|\barc\b/.test(r)) return 'medium';
  if (/radeon|vega|amd/.test(r)) return 'medium';
  if (/apple|mali|adreno|powervr|videocore|tegra|immortalis/.test(r)) return 'medium';
  return 'medium';
}

/** Resolve the quality setting to a tier ('auto' → detected GPU tier). */
export function resolveQuality(setting: QualitySetting | string | undefined, detected: QualityTier): QualityTier {
  if (setting === 'low' || setting === 'medium' || setting === 'high') return setting;
  return detected;
}

/** Device pixel ratio cap per tier: high min(dpr, 1.5), medium 1.0, low 0.75. */
export function pixelRatioForTier(tier: QualityTier, dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  if (tier === 'high') return Math.min(d, 1.5);
  if (tier === 'medium') return 1;
  return 0.75;
}

/** Shadow-map resolution per tier (low has no shadows). */
export function shadowMapSizeForTier(tier: QualityTier): number {
  return tier === 'high' ? 2048 : 1024;
}

export interface DynResOptions {
  /** Lowest render scale (relative to the tier's pixel ratio). */
  min: number;
  /** Seconds the smoothed frame time must stay above budget before stepping down. */
  downAfter: number;
  /** Seconds of headroom before stepping up. */
  upAfter: number;
  stepDown: number;
  stepUp: number;
}

const DYNRES_DEFAULTS: DynResOptions = { min: 0.6, downAfter: 1.5, upAfter: 5, stepDown: 0.1, stepUp: 0.05 };

/**
 * Dynamic resolution: tracks an exponentially smoothed frame time; when it stays above `overMs` for `downAfter`
 * seconds the render scale steps down (min 0.6), when it stays below `underMs` for `upAfter` seconds it steps back up
 * (slowly; a scale that had to be abandoned is retried only after 4× longer). Frames that are CPU-bound (most of the
 * interval spent in our own frame code) never lower the resolution — a smaller canvas would not help them.
 */
export class DynamicResolution {
  scale = 1;
  /** Smoothed frame interval (ms). */
  avgMs = 16.7;
  private over = 0;
  private under = 0;
  private hold = 0;
  private failedAt = 2;
  private readonly o: DynResOptions;

  constructor(opts: Partial<DynResOptions> = {}) {
    this.o = { ...DYNRES_DEFAULTS, ...opts };
  }

  reset(scale = 1): void {
    this.scale = scale;
    this.over = 0;
    this.under = 0;
    this.hold = 1;
    this.failedAt = 2;
  }

  /**
   * Feed one rendered frame. frameMs = interval since the previous rendered frame, cpuMs = time spent in our frame
   * code, overMs / underMs = budget thresholds (e.g. 22 / 18 at a 60 fps target). Returns true if the scale changed.
   */
  sample(frameMs: number, cpuMs: number, overMs: number, underMs: number): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return false;
    const dt = Math.min(frameMs, 250) / 1000;
    if (frameMs > 250) return false; // hitch / tab switch: ignore
    this.avgMs += (frameMs - this.avgMs) * Math.min(1, dt * 4);
    if (this.hold > 0) {
      this.hold -= dt;
      return false;
    }
    const o = this.o;
    const cpuBound = cpuMs > this.avgMs * 0.7;
    if (this.avgMs > overMs && !cpuBound) {
      this.over += dt;
      this.under = 0;
      if (this.over >= o.downAfter && this.scale > o.min + 1e-6) {
        this.failedAt = this.scale;
        this.scale = Math.max(o.min, Math.round((this.scale - o.stepDown) * 100) / 100);
        this.over = 0;
        this.hold = 1;
        return true;
      }
    } else if (this.avgMs < underMs) {
      this.under += dt;
      this.over = Math.max(0, this.over - dt);
      const wait = this.scale + o.stepUp >= this.failedAt - 1e-6 ? o.upAfter * 4 : o.upAfter;
      if (this.under >= wait && this.scale < 1 - 1e-6) {
        this.scale = Math.min(1, Math.round((this.scale + o.stepUp) * 100) / 100);
        this.under = 0;
        this.hold = 1;
        if (this.scale >= this.failedAt - 1e-6) this.failedAt = 2;
        return true;
      }
    } else {
      this.over = Math.max(0, this.over - dt);
      this.under = Math.max(0, this.under - dt * 0.5);
    }
    return false;
  }
}

/** Frame-time budget thresholds (ms) for a target interval: over = consistently too slow, under = headroom. */
export function frameBudget(targetMs: number): { over: number; under: number } {
  return { over: Math.max(22, targetMs * 1.3), under: Math.max(12, targetMs * 1.08) };
}

/**
 * Frame pacer for requestAnimationFrame loops: renders at most `fps` frames per second (0 = every callback),
 * keeping the phase so e.g. 60 fps on a 144 Hz display averages 60 (alternating 2 and 3 refreshes).
 */
export class FramePacer {
  private next = 0;

  /** True if a frame should be rendered at `now` (ms) for the given cap. */
  shouldRender(now: number, fps: number): boolean {
    if (!(fps > 0)) {
      this.next = now;
      return true;
    }
    const interval = 1000 / fps;
    // 1.5 ms tolerance absorbs rAF jitter (a 60 Hz display with a 60 fps cap renders every refresh)
    if (now < this.next - 1.5) return false;
    this.next = Math.max(this.next + interval, now + interval * 0.5);
    return true;
  }

  /** Render on the very next callback (input happened). */
  wake(): void {
    this.next = 0;
  }
}

/** The effective frame cap: idle (menu, or paused with a still camera) → ≤ 30 fps, else the setting (0 = none). */
export function effectiveFpsCap(settingCap: number, idle: boolean): number {
  const cap = settingCap > 0 ? settingCap : 0;
  if (idle) return cap > 0 ? Math.min(cap, 30) : 30;
  return cap;
}
