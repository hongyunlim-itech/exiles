/**
 * Select tool: click a citizen/building to select it, click empty ground to deselect; hover → tile description.
 */
import type { Selection } from '../../core/app';
import { describeTile } from '../describe';
import { CLICK_SLOP_PX } from '../geometry';
import { BaseTool } from './base';

/** Seconds between hover-text refreshes while the pointer rests on a tile (building progress/stock changes). */
const HOVER_REFRESH = 0.5;

export class SelectTool extends BaseTool {
  readonly kind = 'select' as const;
  private time = 0;

  update(realDt: number): void {
    this.time += realDt;
    const p = this.host.pointer;
    if (!p.inside || !p.hasTile) {
      this.keyChanged(-1);
      this.host.setHover(null);
      return;
    }
    if (!this.keyChanged(p.tx, p.tz, this.host.revStamp, Math.floor(this.time / HOVER_REFRESH))) return;
    const game = this.game;
    this.host.setHover(describeTile(game.state, (id) => game.getBuilding(id), p.tx, p.tz));
  }

  override pointerUp(): void {
    const p = this.host.pointer;
    if (p.moved >= CLICK_SLOP_PX) return;
    const app = this.host.app;
    let pick: Selection = null;
    try {
      pick = app.renderer.pickEntity(p.clientX, p.clientY);
    } catch (err) {
      console.warn('[input] pickEntity failed', err);
      pick = null;
    }
    if (pick) {
      const same = app.selection && app.selection.kind === pick.kind && app.selection.id === pick.id;
      if (!same) this.host.playUi('click');
      app.select({ kind: pick.kind, id: pick.id } as Selection);
    } else if (app.selection) {
      app.select(null);
    }
  }
}
