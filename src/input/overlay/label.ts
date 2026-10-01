/**
 * Small world-anchored DOM label used by the drag tools (zone size "8 × 8", road length/cost, clear counts).
 * Positioned each frame via `renderer.worldToScreen`; only touches the DOM when text or position changes.
 */

export type WorldToScreen = (wx: number, wy: number, wz: number) => { x: number; y: number; visible: boolean };

const STYLE_ID = 'exiles-input-style';

const CSS = `
.exiles-tool-label {
  position: fixed; left: 0; top: 0; z-index: 40; pointer-events: none; user-select: none;
  padding: 3px 9px 4px; border-radius: 5px; white-space: nowrap;
  font: 600 13px/1.25 "Alegreya Sans", "Segoe UI", Georgia, sans-serif; letter-spacing: 0.02em;
  color: #efe3c6; background: rgba(28, 22, 16, 0.86); border: 1px solid rgba(201, 164, 92, 0.65);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6);
  will-change: transform; display: none;
}
.exiles-tool-label.bad { border-color: rgba(232, 69, 60, 0.8); color: #ffd9d2; }
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

export class ToolLabel {
  private readonly el: HTMLDivElement | null;
  private text = '';
  private bad = false;
  private shown = false;
  private wx = 0;
  private wy = 0;
  private wz = 0;
  private px = NaN;
  private py = NaN;

  constructor(private readonly project: WorldToScreen) {
    if (typeof document === 'undefined') {
      this.el = null;
      return;
    }
    ensureStyle(document);
    const el = document.createElement('div');
    el.className = 'exiles-tool-label';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    this.el = el;
  }

  /** Show `text` anchored at world position (wx, wy, wz). */
  show(text: string, wx: number, wy: number, wz: number, bad = false): void {
    this.wx = wx;
    this.wy = wy;
    this.wz = wz;
    if (!this.el) return;
    if (text !== this.text) {
      this.text = text;
      this.el.textContent = text;
    }
    if (bad !== this.bad) {
      this.bad = bad;
      this.el.classList.toggle('bad', bad);
    }
    this.shown = true;
    this.reposition();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    if (this.el) this.el.style.display = 'none';
    this.px = NaN;
  }

  /** Re-project the anchor (call whenever the camera/viewport changed while shown). */
  reposition(): void {
    if (!this.shown || !this.el) return;
    let p: { x: number; y: number; visible: boolean };
    try {
      p = this.project(this.wx, this.wy, this.wz);
    } catch {
      return;
    }
    if (!p.visible) {
      if (this.el.style.display !== 'none') this.el.style.display = 'none';
      this.px = NaN;
      return;
    }
    if (this.el.style.display !== 'block') this.el.style.display = 'block';
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x === this.px && y === this.py) return;
    this.px = x;
    this.py = y;
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -120%)`;
  }

  dispose(): void {
    this.el?.remove();
  }
}
