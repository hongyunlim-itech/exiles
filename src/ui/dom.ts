/**
 * Tiny DOM helpers used by every UI component. No framework: components build their DOM once and then update
 * values in place (cached setters skip redundant writes so a 4 Hz refresh never thrashes layout).
 */

export type Child = Node | string | number | null | undefined | false;
export type Children = Child | readonly Children[];
export type Attrs = Record<string, unknown>;

/**
 * Create an element. Attribute keys:
 * - `class`, `style` (string or object), `text` (textContent), `tip` (tooltip text → data-tip)
 * - `on<event>` with a function value → addEventListener(event)
 * - boolean `true` → empty attribute, `false`/null/undefined → skipped, anything else → setAttribute(String(v))
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Children[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) setAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

export function setAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const key in attrs) {
    const v = attrs[key];
    if (v === undefined || v === null || v === false) continue;
    if (key === 'class') el.className = String(v);
    else if (key === 'style') {
      if (typeof v === 'string') el.style.cssText = v;
      else Object.assign(el.style, v as Partial<CSSStyleDeclaration>);
    } else if (key === 'text') el.textContent = String(v);
    else if (key === 'tip') el.dataset.tip = String(v);
    else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(v));
  }
}

export function appendChildren(el: Node, children: readonly Children[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c as readonly Children[]);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

const textCache = new WeakMap<Node, string>();

/** Set textContent only when it changed. */
export function setText(el: Node, text: string): void {
  if (textCache.get(el) === text) return;
  textCache.set(el, text);
  el.textContent = text;
}

const styleCache = new WeakMap<HTMLElement, Map<string, string>>();

/** Set a style property only when it changed. */
export function setStyle(el: HTMLElement, prop: string, value: string): void {
  let m = styleCache.get(el);
  if (!m) {
    m = new Map();
    styleCache.set(el, m);
  }
  if (m.get(prop) === value) return;
  m.set(prop, value);
  el.style.setProperty(prop, value);
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/** Width of a fill element as a percentage (0..1 input). */
export function setFrac(el: HTMLElement, frac: number): void {
  setStyle(el, 'width', `${(clamp01(frac) * 100).toFixed(1)}%`);
}

/** Show/hide via the `hidden` attribute (CSS forces display:none). */
export function show(el: HTMLElement, visible: boolean): void {
  if (el.hidden === visible) el.hidden = !visible;
}

export function setClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function setDisabled(el: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, disabled: boolean): void {
  if (el.disabled !== disabled) el.disabled = disabled;
}

export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** True when a keyboard event target is a text-entry control (hotkeys must be ignored). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    const type = t.type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'range' && type !== 'submit';
  }
  return false;
}

/** Replace the children of an element. */
export function setChildren(el: Element, ...children: Children[]): void {
  el.replaceChildren();
  appendChildren(el, children);
}
