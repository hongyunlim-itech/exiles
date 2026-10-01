/**
 * Small FPS counter (enabled via settings.showFps). Updates twice per second.
 * Line 1: frames per second · worst frame time. Line 2 (when a perf source is registered by the app): quality tier,
 * dynamic-resolution scale, draw calls & triangles (peak of the window, i.e. frames that re-rendered shadows).
 */
import { h, setClass, setText } from '../dom';

/** Renderer readout shown on the second line (see GameRenderer.perf()). */
export interface FpsPerfInfo {
  tier: string;
  quality: string;
  renderScale: number;
  pixelRatio: number;
  calls: number;
  triangles: number;
}

let perfSource: (() => FpsPerfInfo | null) | null = null;

/** Register the renderer readout (called once by the app bootstrap). */
export function setFpsPerfSource(src: (() => FpsPerfInfo | null) | null): void {
  perfSource = src;
}

function kilo(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export class FpsCounter {
  readonly el: HTMLElement;
  private frames = 0;
  private time = 0;
  private worst = 0;
  private enabled = false;
  private calls = 0;
  private tris = 0;

  constructor() {
    this.el = h('div', { class: 'fps', 'aria-hidden': 'true' });
    this.el.style.whiteSpace = 'pre';
    this.el.hidden = true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.el.hidden = !on;
    this.frames = 0;
    this.time = 0;
    this.worst = 0;
    this.calls = 0;
    this.tris = 0;
  }

  frame(dt: number): void {
    if (!this.enabled) return;
    this.frames++;
    this.time += dt;
    if (dt > this.worst) this.worst = dt;
    let p: FpsPerfInfo | null = null;
    try {
      p = perfSource?.() ?? null;
    } catch {
      p = null;
    }
    if (p) {
      if (p.calls > this.calls) this.calls = p.calls;
      if (p.triangles > this.tris) this.tris = p.triangles;
    }
    if (this.time >= 0.5) {
      const fps = this.frames / this.time;
      let text = `${Math.round(fps)} FPS · ${(this.worst * 1000).toFixed(0)} ms max`;
      if (p) {
        const q = p.quality === 'auto' ? `auto→${p.tier}` : p.tier;
        text += `\n${q} · scale ${p.renderScale.toFixed(2)} (×${p.pixelRatio.toFixed(2)}) · ${this.calls} calls · ${kilo(this.tris)} tris`;
      }
      setText(this.el, text);
      setClass(this.el, 'slow', fps < 45);
      this.frames = 0;
      this.time = 0;
      this.worst = 0;
      this.calls = 0;
      this.tris = 0;
    }
  }
}
