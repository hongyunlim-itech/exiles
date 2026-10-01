/**
 * Input-owned hotkeys (ARCHITECTURE.md §7 is the single source of truth):
 *   R rotate (Shift+R counter-clockwise) · Esc cancel drag → cancel tool → deselect → open menu · Space pause toggle ·
 *   1/2/3/4 speeds 1×/2×/5×/10× · C clear tool · V dirt road tool · G grid toggle · Delete demolish selected.
 * Camera keys (W/A/S/D, arrows, Q/E, =/−, Home) belong to render-scene; P/O/N/L/K/H belong to the UI.
 */
import type { Tool } from '../core/app';
import type { GameSpeed } from '../core/types';

export type HotkeyAction =
  | { kind: 'rotate'; dir: 1 | -1 }
  | { kind: 'escape' }
  | { kind: 'pause' }
  | { kind: 'speed'; speed: GameSpeed }
  | { kind: 'tool'; tool: Tool }
  | { kind: 'grid' }
  | { kind: 'demolishSelected' };

const SPEED_KEYS: Record<string, GameSpeed> = {
  Digit1: 1, Numpad1: 1,
  Digit2: 2, Numpad2: 2,
  Digit3: 5, Numpad3: 5,
  Digit4: 10, Numpad4: 10,
};

/** Map a KeyboardEvent.code (layout-independent) to an input action, or null if input doesn't own the key. */
export function hotkeyAction(code: string, shift: boolean): HotkeyAction | null {
  switch (code) {
    case 'KeyR': return { kind: 'rotate', dir: shift ? -1 : 1 };
    case 'Escape': return { kind: 'escape' };
    case 'Space': return { kind: 'pause' };
    case 'KeyC': return { kind: 'tool', tool: { kind: 'clear', filter: 'all' } };
    case 'KeyV': return { kind: 'tool', tool: { kind: 'road', road: 'dirt' } };
    case 'KeyG': return { kind: 'grid' };
    case 'Delete': return { kind: 'demolishSelected' };
  }
  const speed = SPEED_KEYS[code];
  return speed !== undefined ? { kind: 'speed', speed } : null;
}

/** True when keyboard focus is in a text field (hotkeys must not fire while typing). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { tagName?: unknown }).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    // Buttons/checkboxes/ranges don't take text; everything else does.
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
  }
  return el.isContentEditable === true;
}

/** Whether two tools are the same (used to toggle a hotkey tool off). */
export function sameTool(a: Tool, b: Tool): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'build': return a.type === (b as typeof a).type;
    case 'road': return a.road === (b as typeof a).road;
    case 'clear': return a.filter === (b as typeof a).filter;
    default: return true;
  }
}
