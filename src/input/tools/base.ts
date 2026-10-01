/**
 * BaseTool — shared plumbing for tool handlers (host access, preview cache key, hiding overlays, command dispatch).
 */
import type { Tool } from '../../core/app';
import type { GameState } from '../../core/types';
import type { Command, CommandResult } from '../../net/types';
import type { Game } from '../../sim/game';
import type { ToolHandler, ToolHost } from './types';

const KEY_SLOTS = 8;

export abstract class BaseTool implements ToolHandler {
  abstract readonly kind: Tool['kind'];
  /** Numeric preview key; a change triggers a recompute. Fixed-size to avoid per-frame allocations. */
  private readonly lastKey = new Float64Array(KEY_SLOTS);
  private dirty = true;

  constructor(protected readonly host: ToolHost) {}

  protected get game(): Game {
    return this.host.app.game;
  }

  protected get state(): GameState {
    return this.host.app.game.state;
  }

  /** True when any key part differs from the previous call (or invalidate() was called). Stores the new key. */
  protected keyChanged(a: number, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0): boolean {
    const k = this.lastKey;
    const changed = this.dirty || k[0] !== a || k[1] !== b || k[2] !== c || k[3] !== d || k[4] !== e || k[5] !== f || k[6] !== g || k[7] !== h;
    if (changed) {
      k[0] = a;
      k[1] = b;
      k[2] = c;
      k[3] = d;
      k[4] = e;
      k[5] = f;
      k[6] = g;
      k[7] = h;
      this.dirty = false;
    }
    return changed;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Issue a player command (solo: applied now; co-op: queued for the host — `pending`). Never throws: an exception is
   * reported as a refused command.
   */
  protected dispatch(cmd: Command): CommandResult {
    try {
      const res = this.host.app.dispatch(cmd);
      return res && typeof res.ok === 'boolean' ? res : { ok: false, reason: 'That could not be done right now' };
    } catch (err) {
      console.warn(`[input] dispatch ${cmd.op} failed`, err);
      return { ok: false, reason: 'That could not be done right now' };
    }
  }

  activate(): void {
    this.invalidate();
  }

  deactivate(): void {
    this.hideAll();
    this.host.setHover(null);
  }

  /** Hide the overlays this tool may use. */
  protected hideAll(): void {
    this.host.overlay.clear();
    this.host.marked.clear();
    this.host.ghost.hide();
    this.host.rings.cursor.hide();
    this.host.rings.hideFaint();
    this.host.label.hide();
  }

  abstract update(realDt: number): void;

  pointerDown(): void {}

  pointerUp(): void {}

  cancelDrag(): boolean {
    return false;
  }

  rotate(): void {}
}
