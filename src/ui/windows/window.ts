/**
 * Floating window base class: title bar (drag to move), close button, scrollable body, z-order focus, remembered
 * position (localStorage). Content is built lazily on first open; `refresh()` is called at ~4 Hz while open.
 */
import type { UIContext, WindowId } from '../context';
import { h } from '../dom';
import { ICON } from '../icons';
import { placeDialogX, TOAST_COLUMN_RIGHT_REM } from '../scale';

const POS_KEY = 'exiles.ui.windows';

function loadPositions(): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Record<string, { x: number; y: number }>;
  } catch {
    return {};
  }
}

function savePosition(id: string, x: number, y: number): void {
  try {
    const all = loadPositions();
    all[id] = { x, y };
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

let zTop = 20;
let cascade = 0;

/** Right edge (px) of the toast column (top-left; 1rem + 38rem wide in hud.css), measured when possible. */
function toastColumnRight(rem: number): number {
  const fallback = TOAST_COLUMN_RIGHT_REM * rem;
  try {
    const col = document.querySelector<HTMLElement>('.exiles-ui .toasts');
    if (!col || col.closest('.ui-menu-open')) return fallback;
    const r = col.getBoundingClientRect();
    return r.width > 0 && r.left < window.innerWidth / 2 ? Math.max(fallback * 0.5, r.right) : fallback;
  } catch {
    return fallback;
  }
}
const allWindows: UIWindow[] = [];

/** Keep z-indices small (below toasts/menus) by renumbering when they grow large. */
function normalizeZ(): void {
  const sorted = allWindows.slice().sort((a, b) => a.zIndex - b.zIndex);
  zTop = 20;
  for (const w of sorted) w.el.style.zIndex = String(++zTop);
}

export interface WindowOptions {
  id: WindowId;
  title: string;
  icon: string;
  /** Width in rem. */
  width: number;
  hotkey?: string;
  /** Modal-ish dialog: centred, Esc closes it before anything else, not persisted. */
  dialog?: boolean;
  className?: string;
}

export abstract class UIWindow {
  readonly id: WindowId;
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly dialog: boolean;
  protected readonly titleText: HTMLElement;
  protected readonly headerExtra: HTMLElement;
  private built = false;
  private _open = false;
  private positioned = false;
  /** Called by the manager when open state changes. */
  onToggle: ((open: boolean) => void) | null = null;

  constructor(protected readonly ui: UIContext, protected readonly opts: WindowOptions) {
    this.id = opts.id;
    this.dialog = !!opts.dialog;
    this.titleText = h('span', { class: 'win-title-t', id: `win-title-${opts.id}` }, opts.title);
    this.headerExtra = h('div', { class: 'win-extra' });
    const close = h('button', { class: 'win-close', type: 'button', 'aria-label': `Close ${opts.title}`, tip: opts.hotkey ? `Close [${opts.hotkey} / Esc]` : 'Close [Esc]', onclick: () => this.close() }, ICON.close);
    const titleBar = h('div', { class: 'win-titlebar' },
      h('span', { class: 'win-icon', 'aria-hidden': 'true' }, opts.icon),
      this.titleText,
      opts.hotkey ? h('span', { class: 'win-hotkey', 'aria-hidden': 'true' }, opts.hotkey) : null,
      this.headerExtra,
      close);
    this.body = h('div', { class: 'win-body' });
    this.el = h('section', {
      class: `win panel ${this.dialog ? 'dialog' : ''} ${opts.className ?? ''}`, role: 'dialog', 'aria-labelledby': `win-title-${opts.id}`,
      style: `width: ${opts.width}rem`,
    }, titleBar, this.body);
    this.el.hidden = true;
    this.el.addEventListener('pointerdown', () => this.focus());
    this.enableDrag(titleBar);
    allWindows.push(this);
  }

  get isOpen(): boolean {
    return this._open;
  }

  /** Build the window content (called once, lazily). */
  protected abstract build(): void;

  /** Refresh live values (~4 Hz while open). */
  refresh(): void {}

  /** Game instance changed: drop cached per-game state. */
  onGameChanged(): void {}

  /** Called just before the window becomes visible. */
  protected onOpen(): void {}

  protected onClose(): void {}

  open(): void {
    if (!this.built) {
      this.built = true;
      this.build();
    }
    if (this._open) {
      this.focus();
      return;
    }
    this._open = true;
    this.onOpen();
    this.el.hidden = false;
    this.el.classList.remove('closing');
    this.el.classList.add('opening');
    window.setTimeout(() => this.el.classList.remove('opening'), 200);
    if (!this.positioned || this.dialog) this.placeInitially();
    else this.clampIntoView();
    this.focus();
    try {
      this.refresh();
    } catch (err) {
      console.warn(`[ui] window ${this.id} refresh failed`, err);
    }
    this.ui.sound('open');
    this.onToggle?.(true);
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.el.hidden = true;
    this.onClose();
    this.ui.sound('close');
    this.onToggle?.(false);
  }

  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  /** Release resources (the element is removed by the owner). */
  dispose(): void {
    const i = allWindows.indexOf(this);
    if (i >= 0) allWindows.splice(i, 1);
  }

  focus(): void {
    if (this.el.style.zIndex === String(zTop)) return;
    if (zTop > 2000) normalizeZ();
    this.el.style.zIndex = String(++zTop);
  }

  get zIndex(): number {
    return Number(this.el.style.zIndex) || 0;
  }

  /** Re-run the initial placement of an open dialog (e.g. after the viewport was resized). */
  recenter(): void {
    if (this._open && this.dialog) this.placeInitially();
  }

  private placeInitially(): void {
    this.positioned = true;
    if (this.dialog) this.el.style.width = `${this.opts.width}rem`;
    let w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!this.dialog) {
      const saved = loadPositions()[this.id];
      if (saved) {
        this.setPos(saved.x, saved.y);
        this.clampIntoView();
        return;
      }
    }
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
    let x = (vw - w) / 2;
    let y = Math.max(6.4 * rem, (vh - hgt) / 2 - vh * 0.05);
    if (this.dialog) {
      // Dialogs (trade, nomads) sit above the toast column: keep them to its right so new messages stay readable.
      // With the UI scale (1rem ≤ viewport width / 134) a 92rem dialog always fits beside the 39rem column.
      const p = placeDialogX(vw, w, rem, toastColumnRight(rem));
      x = p.x;
      if (p.width !== w) {
        w = p.width;
        this.el.style.width = `${w}px`;
      }
    } else {
      // start right of the toast column (left edge) and cascade
      x = Math.max(16, Math.min(vw - w - 16, Math.max(40 * rem, vw * 0.2) + (cascade % 5) * 28));
      y = 6.4 * rem + (cascade % 5) * 22;
      cascade++;
    }
    this.setPos(x, y);
    this.clampIntoView();
  }

  private setPos(x: number, y: number): void {
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
    this.fitHeight(y);
  }

  /** Limit the height so the window never runs under the bottom toolbar (dialogs may use the full height). */
  private fitHeight(top: number): void {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
    const reserve = (this.dialog ? 2 : 8.6) * rem;
    const mh = Math.max(18 * rem, window.innerHeight - Math.max(0, top) - reserve);
    this.el.style.maxHeight = `${Math.round(mh)}px`;
  }

  /** Keep at least the title bar reachable inside the viewport. */
  clampIntoView(): void {
    if (this.el.hidden) return;
    const r = this.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(8 - r.width + 80, Math.min(vw - 80, r.left));
    const y = Math.max(8, Math.min(vh - 48, r.top));
    if (x !== r.left || y !== r.top) this.setPos(x, y);
    else this.fitHeight(r.top);
  }

  private enableDrag(handle: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const r = this.el.getBoundingClientRect();
      origX = r.left;
      origY = r.top;
      handle.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const x = Math.max(80 - this.el.offsetWidth, Math.min(vw - 80, origX + e.clientX - startX));
      const y = Math.max(4, Math.min(vh - 40, origY + e.clientY - startY));
      this.setPos(x, y);
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('dragging');
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      if (!this.dialog) {
        const r = this.el.getBoundingClientRect();
        savePosition(this.id, r.left, r.top);
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

/** Keeps track of registered windows (z-order, Esc handling, refresh of open windows). */
export class WindowManager {
  private windows = new Map<WindowId, UIWindow>();

  constructor(private readonly host: HTMLElement, private readonly onToggle: (id: WindowId, open: boolean) => void) {
    window.addEventListener('resize', this.onResize);
  }

  private onResize = (): void => {
    for (const w of this.windows.values()) {
      if (!w.isOpen) continue;
      if (w.dialog) w.recenter();
      else w.clampIntoView();
    }
  };

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    for (const w of this.windows.values()) w.dispose();
  }

  register(w: UIWindow): void {
    this.windows.set(w.id, w);
    w.onToggle = (open) => this.onToggle(w.id, open);
    this.host.appendChild(w.el);
  }

  get(id: WindowId): UIWindow | undefined {
    return this.windows.get(id);
  }

  open(id: WindowId): void {
    this.windows.get(id)?.open();
  }

  close(id: WindowId): void {
    this.windows.get(id)?.close();
  }

  toggle(id: WindowId): void {
    this.windows.get(id)?.toggle();
  }

  isOpen(id: WindowId): boolean {
    return !!this.windows.get(id)?.isOpen;
  }

  anyOpen(): boolean {
    for (const w of this.windows.values()) if (w.isOpen) return true;
    return false;
  }

  /** Close the top-most open window (dialogs first if `dialogsOnly`). Returns true if one was closed. */
  closeTop(dialogsOnly = false): boolean {
    let top: UIWindow | null = null;
    for (const w of this.windows.values()) {
      if (!w.isOpen || (dialogsOnly && !w.dialog)) continue;
      if (!top || w.zIndex > top.zIndex) top = w;
    }
    if (!top) return false;
    top.close();
    return true;
  }

  closeAll(): void {
    for (const w of this.windows.values()) w.close();
  }

  refreshOpen(): void {
    for (const w of this.windows.values()) {
      if (!w.isOpen) continue;
      try {
        w.refresh();
      } catch (err) {
        console.warn(`[ui] window ${w.id} refresh failed`, err);
      }
    }
  }

  onGameChanged(): void {
    for (const w of this.windows.values()) {
      try {
        w.onGameChanged();
      } catch (err) {
        console.warn(`[ui] window ${w.id} reset failed`, err);
      }
    }
  }
}
