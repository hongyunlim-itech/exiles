/**
 * Toast notifications (top-left stack). Game messages arrive via Game.events 'message'. Warnings and dangers stay
 * longer; hovering pauses the timer; identical messages within a short time are merged with a counter.
 */
import type { MessageSeverity } from '../../core/types';
import type { ToastOptions, UIContext } from '../context';
import { h, setText } from '../dom';
import { ICON, SEVERITY_ICONS } from '../icons';

const DURATION: Record<MessageSeverity, number> = { info: 5, good: 6, warning: 10, danger: 14 };
const MAX_TOASTS = 6;
const MERGE_WINDOW = 8;

interface ToastItem {
  el: HTMLElement;
  text: string;
  severity: MessageSeverity;
  remaining: number;
  count: number;
  countEl: HTMLElement;
  hovered: boolean;
  leaving: boolean;
  created: number;
}

export class Toasts {
  readonly el: HTMLElement;
  private items: ToastItem[] = [];
  private lastSound = 0;

  constructor(private readonly ui: UIContext) {
    this.el = h('div', { class: 'toasts', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  }

  show(text: string, severity: MessageSeverity = 'info', opts: ToastOptions = {}): void {
    const now = performance.now();
    // merge with an identical recent toast
    const dup = this.items.find((t) => !t.leaving && t.text === text && t.severity === severity && now - t.created < MERGE_WINDOW * 1000);
    if (dup) {
      dup.count++;
      setText(dup.countEl, `×${dup.count}`);
      dup.countEl.hidden = false;
      dup.remaining = Math.max(dup.remaining, opts.duration ?? DURATION[severity]);
      dup.el.classList.remove('bump');
      void dup.el.offsetWidth;
      dup.el.classList.add('bump');
      return;
    }

    const countEl = h('span', { class: 'toast-count' });
    countEl.hidden = true;
    const actions = h('div', { class: 'toast-actions' });
    if (opts.target) {
      const target = opts.target;
      actions.appendChild(h('button', {
        class: 'toast-go', type: 'button', 'aria-label': 'Go to', tip: 'Go to',
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          this.ui.goTo(target);
        },
      }, ICON.goTo));
    }
    if (opts.action) {
      const action = opts.action;
      actions.appendChild(h('button', {
        class: 'toast-act', type: 'button',
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          action.run();
          this.dismiss(item);
        },
      }, action.label));
    }
    const close = h('button', {
      class: 'toast-x', type: 'button', 'aria-label': 'Dismiss',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        this.dismiss(item);
      },
    }, ICON.close);
    const el = h('div', { class: `toast sev-${severity} ${opts.target ? 'clickable' : ''}`, role: severity === 'danger' ? 'alert' : 'status' },
      h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, SEVERITY_ICONS[severity]),
      h('span', { class: 'toast-text' }, text, countEl),
      actions, close);
    const item: ToastItem = {
      el, text, severity, remaining: opts.duration ?? DURATION[severity], count: 1, countEl, hovered: false, leaving: false, created: now,
    };
    if (opts.accent) el.style.borderLeftColor = opts.accent;
    el.addEventListener('pointerenter', () => (item.hovered = true));
    el.addEventListener('pointerleave', () => (item.hovered = false));
    if (opts.target) {
      const target = opts.target;
      el.addEventListener('click', () => this.ui.goTo(target));
    }
    this.items.push(item);
    this.el.appendChild(el);
    // enforce max: drop the oldest non-danger first
    while (this.items.filter((t) => !t.leaving).length > MAX_TOASTS) {
      const victim = this.items.find((t) => !t.leaving && t.severity !== 'danger') ?? this.items.find((t) => !t.leaving)!;
      this.dismiss(victim);
    }
    if (!opts.silent && (severity === 'warning' || severity === 'danger' || severity === 'good')) {
      if (now - this.lastSound > 500) {
        this.lastSound = now;
        this.ui.sound(severity === 'danger' ? 'danger' : 'notify');
      }
    }
  }

  /** Per-frame countdown (cheap). */
  update(dt: number): void {
    for (const t of this.items) {
      if (t.leaving || t.hovered) continue;
      t.remaining -= dt;
      if (t.remaining <= 0) this.dismiss(t);
    }
  }

  clear(): void {
    for (const t of this.items) t.el.remove();
    this.items = [];
  }

  private dismiss(t: ToastItem): void {
    if (t.leaving) return;
    t.leaving = true;
    t.el.classList.add('leaving');
    const remove = () => {
      t.el.remove();
      this.items = this.items.filter((x) => x !== t);
    };
    t.el.addEventListener('animationend', remove, { once: true });
    window.setTimeout(remove, 400);
  }
}
