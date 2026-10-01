/** Reusable UI widgets that update in place. */
import { RESOURCES, RESOURCE_TYPES } from '../core/defs';
import type { Inventory, ResourceType } from '../core/types';
import { h, setClass, setDisabled, setFrac, setText, show } from './dom';
import { fmtCompact, fmtInt } from './format';

export type Tone = 'good' | 'warn' | 'bad' | 'gold' | 'info' | 'neutral';

/** Tone for a 0..1 "higher is better" value. */
export function toneFor(frac: number, low = 0.3, mid = 0.6): Tone {
  return frac < low ? 'bad' : frac < mid ? 'warn' : 'good';
}

// ---- progress bar ------------------------------------------------------------------------------

export class Bar {
  readonly el: HTMLDivElement;
  private fill: HTMLDivElement;
  private label: HTMLSpanElement;
  private tone: Tone | null = null;

  constructor(opts: { tone?: Tone; className?: string; label?: boolean } = {}) {
    this.fill = h('div', { class: 'bar-fill' });
    this.label = h('span', { class: 'bar-label' });
    this.el = h('div', { class: `bar ${opts.className ?? ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' },
      this.fill, opts.label === false ? null : this.label);
    this.setTone(opts.tone ?? 'gold');
  }

  set(frac: number, text?: string, tone?: Tone): void {
    setFrac(this.fill, frac);
    if (text !== undefined) setText(this.label, text);
    if (tone) this.setTone(tone);
    const v = String(Math.round(Math.max(0, Math.min(1, frac || 0)) * 100));
    if (this.el.getAttribute('aria-valuenow') !== v) this.el.setAttribute('aria-valuenow', v);
  }

  setTone(tone: Tone): void {
    if (tone === this.tone) return;
    if (this.tone) this.el.classList.remove(`tone-${this.tone}`);
    this.tone = tone;
    this.el.classList.add(`tone-${tone}`);
  }
}

// ---- −/+ stepper -------------------------------------------------------------------------------

export class Stepper {
  readonly el: HTMLDivElement;
  readonly dec: HTMLButtonElement;
  readonly inc: HTMLButtonElement;
  private val: HTMLSpanElement;

  constructor(opts: { onStep: (delta: number) => void; decLabel?: string; incLabel?: string; className?: string }) {
    const step = (sign: number) => (e: MouseEvent) => {
      const mult = e.shiftKey ? 5 : 1;
      opts.onStep(sign * mult);
    };
    this.dec = h('button', { class: 'step-btn', type: 'button', 'aria-label': opts.decLabel ?? 'Decrease', tip: `${opts.decLabel ?? 'Decrease'} (Shift: ×5)`, onclick: step(-1) }, '−');
    this.inc = h('button', { class: 'step-btn', type: 'button', 'aria-label': opts.incLabel ?? 'Increase', tip: `${opts.incLabel ?? 'Increase'} (Shift: ×5)`, onclick: step(1) }, '+');
    this.val = h('span', { class: 'step-val' });
    this.el = h('div', { class: `stepper ${opts.className ?? ''}` }, this.dec, this.val, this.inc);
  }

  set(text: string, canDec: boolean, canInc: boolean): void {
    setText(this.val, text);
    setDisabled(this.dec, !canDec);
    setDisabled(this.inc, !canInc);
  }
}

// ---- resource chips ----------------------------------------------------------------------------

export function resIcon(type: ResourceType): string {
  return RESOURCES[type]?.icon ?? '•';
}

export function resName(type: ResourceType): string {
  return RESOURCES[type]?.name ?? type;
}

/** A static chip: icon + amount. */
export function chip(icon: string, text: string, opts: { tip?: string; className?: string } = {}): HTMLSpanElement {
  return h('span', { class: `chip ${opts.className ?? ''}`, tip: opts.tip }, h('span', { class: 'chip-i' }, icon), h('span', { class: 'chip-n' }, text));
}

/** Cost chips with shortage marking (red when `have` < need). */
export function costChips(cost: Inventory, have?: Record<ResourceType, number>, mult = 1, suffix = ''): HTMLSpanElement {
  const wrap = h('span', { class: 'cost' });
  let any = false;
  for (const k of RESOURCE_TYPES) {
    const n = cost[k];
    if (!n) continue;
    any = true;
    const need = n * mult;
    const short = have ? have[k] + 1e-6 < need : false;
    wrap.appendChild(chip(resIcon(k), `${fmtInt(n)}${suffix}`, {
      className: short ? 'short' : '',
      tip: `${resName(k)}: ${fmtInt(need)}${have ? ` (have ${fmtInt(have[k])})` : ''}`,
    }));
  }
  if (!any) wrap.appendChild(h('span', { class: 'cost-free' }, 'Free'));
  return wrap;
}

interface ChipSlot {
  el: HTMLSpanElement;
  num: HTMLSpanElement;
  value: number;
}

/**
 * Keyed chip grid for an inventory. Only resources with amount > 0 (or in `compare`) are shown; chips are created
 * once per resource and updated in place. With `compare` it renders "have / need" (construction materials).
 */
export class ResourceChips {
  readonly el: HTMLDivElement;
  private slots = new Map<ResourceType, ChipSlot>();
  private empty: HTMLSpanElement;
  private order = '';
  private sort: boolean;

  constructor(opts: { empty?: string; className?: string; sort?: boolean } = {}) {
    this.empty = h('span', { class: 'chips-empty' }, opts.empty ?? 'Empty');
    this.el = h('div', { class: `chips ${opts.className ?? ''}` }, this.empty);
    this.sort = opts.sort ?? true;
  }

  set(inv: Inventory, compare?: Inventory): void {
    const keys: ResourceType[] = [];
    for (const k of RESOURCE_TYPES) {
      const v = inv[k] ?? 0;
      if (v >= 0.5 || (compare && (compare[k] ?? 0) > 0)) keys.push(k);
    }
    if (this.sort && !compare) keys.sort((a, b) => (inv[b] ?? 0) - (inv[a] ?? 0));
    const keep = new Set(keys);
    for (const [k, slot] of this.slots) {
      if (!keep.has(k)) {
        slot.el.remove();
        this.slots.delete(k);
      }
    }
    for (const k of keys) {
      let slot = this.slots.get(k);
      if (!slot) {
        const num = h('span', { class: 'chip-n' });
        const el = h('span', { class: 'chip', tip: resName(k) }, h('span', { class: 'chip-i' }, resIcon(k)), num);
        slot = { el, num, value: NaN };
        this.slots.set(k, slot);
      }
      const v = inv[k] ?? 0;
      if (compare) {
        const need = compare[k] ?? 0;
        setText(slot.num, `${fmtInt(v)}/${fmtInt(need)}`);
        setClass(slot.el, 'done', v + 1e-6 >= need);
      } else setText(slot.num, fmtCompact(v));
      slot.value = v;
    }
    const order = keys.join(',');
    if (order !== this.order) {
      this.order = order;
      for (const k of keys) this.el.appendChild(this.slots.get(k)!.el);
    }
    show(this.empty, keys.length === 0);
  }
}

// ---- segmented selector ------------------------------------------------------------------------

export interface SegOption<T> {
  id: T;
  label: string;
  icon?: string;
  tip?: string;
  disabled?: boolean;
}

export class Segmented<T extends string | number> {
  readonly el: HTMLDivElement;
  private buttons = new Map<T, HTMLButtonElement>();
  private key = '';
  private active: T | null = null;

  constructor(options: SegOption<T>[], private readonly onSelect: (id: T) => void, opts: { className?: string; label?: string } = {}) {
    this.el = h('div', { class: `seg ${opts.className ?? ''}`, role: 'radiogroup', 'aria-label': opts.label });
    this.setOptions(options);
  }

  setOptions(options: SegOption<T>[]): void {
    const key = options.map((o) => `${o.id}|${o.label}|${o.disabled ? 1 : 0}`).join(';');
    if (key === this.key) return;
    this.key = key;
    this.buttons.clear();
    this.el.replaceChildren();
    for (const o of options) {
      const b = h('button', {
        class: 'seg-btn', type: 'button', role: 'radio', 'aria-checked': 'false', tip: o.tip, disabled: o.disabled,
        onclick: () => {
          if (this.active === o.id) return;
          this.onSelect(o.id);
        },
      }, o.icon ? h('span', { class: 'seg-i' }, o.icon) : null, h('span', { class: 'seg-l' }, o.label));
      this.buttons.set(o.id, b);
      this.el.appendChild(b);
    }
    const a = this.active;
    this.active = null;
    this.set(a);
  }

  set(active: T | null): void {
    if (active === this.active) return;
    this.active = active;
    for (const [id, b] of this.buttons) {
      const on = id === active;
      setClass(b, 'on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
}

// ---- toggle switch -----------------------------------------------------------------------------

export class Toggle {
  readonly el: HTMLLabelElement;
  readonly input: HTMLInputElement;

  constructor(label: string, onChange: (on: boolean) => void, opts: { tip?: string; desc?: string } = {}) {
    this.input = h('input', { type: 'checkbox', class: 'tgl-input', onchange: () => onChange(this.input.checked) });
    this.el = h('label', { class: 'tgl', tip: opts.tip },
      this.input,
      h('span', { class: 'tgl-track', 'aria-hidden': 'true' }, h('span', { class: 'tgl-knob' })),
      h('span', { class: 'tgl-text' }, h('span', { class: 'tgl-label' }, label), opts.desc ? h('span', { class: 'tgl-desc' }, opts.desc) : null),
    );
  }

  set(on: boolean): void {
    if (this.input.checked !== on) this.input.checked = on;
  }
}

// ---- misc builders -----------------------------------------------------------------------------

/** Panel section with a small caps heading. */
export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  const s = h('section', { class: 'sec' }, h('h4', { class: 'sec-h' }, title));
  for (const c of children) if (c) s.appendChild(c);
  return s;
}

/** A link-styled button (names in lists). */
export function linkBtn(text: string, onClick: () => void, tip?: string): HTMLButtonElement {
  return h('button', { class: 'link', type: 'button', tip, onclick: onClick }, text);
}

/** Label/value row. Returns the row and the value element. */
export function kv(label: string, valueClass = ''): { row: HTMLDivElement; value: HTMLSpanElement; label: HTMLSpanElement } {
  const l = h('span', { class: 'kv-l' }, label);
  const value = h('span', { class: `kv-v ${valueClass}` });
  return { row: h('div', { class: 'kv' }, l, value), value, label: l };
}

export function iconButton(icon: string, label: string, onClick: (e: MouseEvent) => void, opts: { className?: string; tip?: string } = {}): HTMLButtonElement {
  return h('button', {
    class: `ibtn ${opts.className ?? ''}`, type: 'button', 'aria-label': label, tip: opts.tip ?? label, onclick: onClick,
  }, h('span', { class: 'ibtn-i', 'aria-hidden': 'true' }, icon));
}
