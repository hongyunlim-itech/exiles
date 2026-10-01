/**
 * Tooltips.
 * - TooltipManager: one shared tooltip element for UI elements. Static text via `data-tip` (or `tip` attr in h()),
 *   dynamic/rich content via `tips.set(el, () => string | Node)`; dynamic tips refresh at the UI tick rate.
 * - HoverInfo: the world hover text from the input layer (`hoverInfo` app event), following the pointer.
 */
import { h } from './dom';

export type TipContent = string | (() => string | Node | null);

const SHOW_DELAY = 320;
const WARM_WINDOW = 450;

export class TooltipManager {
  readonly el: HTMLDivElement;
  private fns = new WeakMap<Element, () => string | Node | null>();
  private target: HTMLElement | null = null;
  private timer = 0;
  private visible = false;
  private lastHide = 0;
  private lastText: string | null = null;

  constructor(private readonly root: HTMLElement) {
    this.el = h('div', { class: 'ui-tip', role: 'tooltip', 'aria-hidden': 'true' });
    this.el.hidden = true;
    root.appendChild(this.el);
    root.addEventListener('pointerover', this.onOver);
    root.addEventListener('pointerout', this.onOut);
    root.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('blur', this.onBlur);
  }

  private onBlur = (): void => this.hide();

  dispose(): void {
    this.hide();
    window.removeEventListener('blur', this.onBlur);
  }

  /** Attach tooltip content to an element (replaces previous). */
  set(el: HTMLElement, content: TipContent | null): void {
    if (content === null) {
      delete el.dataset.tip;
      delete el.dataset.tipfn;
      this.fns.delete(el);
    } else if (typeof content === 'string') {
      el.dataset.tip = content;
      delete el.dataset.tipfn;
      this.fns.delete(el);
    } else {
      this.fns.set(el, content);
      el.dataset.tipfn = '1';
      delete el.dataset.tip;
    }
    if (el === this.target && this.visible) this.render();
  }

  /** Re-render dynamic content of the visible tooltip (called at the UI tick rate). */
  refresh(): void {
    if (!this.visible || !this.target) return;
    if (!this.target.isConnected || this.target.closest('[hidden]')) {
      this.hide();
      return;
    }
    if (this.target.dataset.tipfn) this.render();
  }

  hide(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.visible) {
      this.visible = false;
      this.el.hidden = true;
      this.lastHide = performance.now();
    }
  }

  private find(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null;
    const el = node.closest<HTMLElement>('[data-tip],[data-tipfn]');
    return el && this.root.contains(el) ? el : null;
  }

  private onOver = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    const t = this.find(e.target);
    if (t === this.target) return;
    this.target = t;
    clearTimeout(this.timer);
    if (!t) {
      this.hide();
      return;
    }
    const warm = this.visible || performance.now() - this.lastHide < WARM_WINDOW;
    if (warm) this.showNow();
    else this.timer = window.setTimeout(() => this.showNow(), SHOW_DELAY);
  };

  private onOut = (e: PointerEvent): void => {
    const rel = e.relatedTarget as Node | null;
    if (this.target && rel && this.target.contains(rel)) return;
    if (!rel || !this.root.contains(rel)) {
      this.target = null;
      this.hide();
    }
  };

  private onDown = (): void => {
    this.hide();
    this.target = null;
  };

  private showNow(): void {
    this.timer = 0;
    if (!this.target || !this.target.isConnected) return;
    if (!this.render()) return;
    this.visible = true;
    this.el.hidden = false;
    this.position();
  }

  /** Returns false when there is nothing to show. */
  private render(): boolean {
    const t = this.target;
    if (!t) return false;
    const fn = this.fns.get(t);
    let content: string | Node | null;
    if (fn) {
      try {
        content = fn();
      } catch (err) {
        console.warn('[ui] tooltip provider failed', err);
        content = null;
      }
    } else content = t.dataset.tip ?? null;
    if (content === null || content === '') {
      if (this.visible) this.hide();
      return false;
    }
    if (typeof content === 'string') {
      this.el.classList.remove('rich');
      if (this.lastText !== content) {
        this.lastText = content;
        this.el.textContent = content;
      }
    } else {
      this.el.classList.add('rich');
      this.lastText = null;
      this.el.replaceChildren(content);
    }
    if (this.visible) this.position();
    return true;
  }

  private position(): void {
    const t = this.target;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const tw = this.el.offsetWidth;
    const th = this.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 8;
    const prefer = t.closest('[data-tip-pos]')?.getAttribute('data-tip-pos');
    let x: number;
    let y: number;
    if (prefer === 'left' || prefer === 'right') {
      x = prefer === 'left' ? r.left - tw - gap : r.right + gap;
      if (x < 6 || x + tw > vw - 6) x = prefer === 'left' ? r.right + gap : r.left - tw - gap;
      y = r.top + r.height / 2 - th / 2;
    } else {
      const below = prefer === 'below' || (prefer !== 'above' && r.top + r.height / 2 < vh * 0.5);
      y = below ? r.bottom + gap : r.top - th - gap;
      if (y < 4) y = r.bottom + gap;
      if (y + th > vh - 4) y = r.top - th - gap;
      x = r.left + r.width / 2 - tw / 2;
    }
    x = Math.max(6, Math.min(vw - tw - 6, x));
    y = Math.max(4, Math.min(vh - th - 4, y));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

/** Tooltip following the pointer with the input layer's hover description. */
export class HoverInfo {
  readonly el: HTMLDivElement;
  private text: string | null = null;
  private suppressed = false;
  private x = 0;
  private y = 0;
  private w = 0;
  private hgt = 0;

  constructor(root: HTMLElement) {
    this.el = h('div', { class: 'ui-hover', 'aria-live': 'off' });
    this.el.hidden = true;
    root.appendChild(this.el);
  }

  setText(text: string | null): void {
    const t = text && text.trim() ? text : null;
    if (t === this.text) return;
    this.text = t;
    if (t) {
      this.el.textContent = t;
      this.w = this.el.offsetWidth || this.w;
      this.hgt = this.el.offsetHeight || this.hgt;
    }
    this.sync();
  }

  setSuppressed(s: boolean): void {
    if (s === this.suppressed) return;
    this.suppressed = s;
    this.sync();
  }

  move(x: number, y: number): void {
    this.x = x;
    this.y = y;
    if (!this.el.hidden) this.place();
  }

  private sync(): void {
    const vis = !!this.text && !this.suppressed;
    if (this.el.hidden === vis) this.el.hidden = !vis;
    if (vis) {
      this.w = this.el.offsetWidth;
      this.hgt = this.el.offsetHeight;
      this.place();
    }
  }

  private place(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = this.x + 18;
    let y = this.y + 20;
    if (x + this.w > vw - 6) x = this.x - this.w - 12;
    if (y + this.hgt > vh - 6) y = this.y - this.hgt - 12;
    this.el.style.transform = `translate(${Math.round(Math.max(4, x))}px, ${Math.round(Math.max(4, y))}px)`;
  }
}

// ---- rich tooltip builders -------------------------------------------------------------------

export interface TipRow {
  label: string;
  value?: string;
  icon?: string;
  tone?: 'good' | 'bad' | 'warn' | 'dim' | '';
}

/** Build a rich tooltip: title, optional subtitle/description, rows, footer note. */
export function richTip(opts: { title?: string; icon?: string; sub?: string; desc?: string; rows?: TipRow[]; note?: string; noteTone?: 'good' | 'bad' | 'warn' | 'dim' }): HTMLElement {
  const el = h('div', { class: 'tip-rich' });
  if (opts.title) el.appendChild(h('div', { class: 'tip-title' }, opts.icon ? h('span', { class: 'tip-icon' }, opts.icon) : null, opts.title));
  if (opts.sub) el.appendChild(h('div', { class: 'tip-sub' }, opts.sub));
  if (opts.desc) el.appendChild(h('div', { class: 'tip-desc' }, opts.desc));
  if (opts.rows && opts.rows.length) {
    const tbl = h('div', { class: 'tip-rows' });
    for (const r of opts.rows) {
      tbl.appendChild(
        h('div', { class: `tip-row ${r.tone ? `t-${r.tone}` : ''}` },
          h('span', { class: 'tip-l' }, r.icon ? h('span', { class: 'tip-ri' }, r.icon) : null, r.label),
          r.value !== undefined ? h('span', { class: 'tip-v' }, r.value) : null),
      );
    }
    el.appendChild(tbl);
  }
  if (opts.note) el.appendChild(h('div', { class: `tip-note ${opts.noteTone ? `t-${opts.noteTone}` : ''}` }, opts.note));
  return el;
}
