/**
 * Demolish tool: hover highlights the building under the cursor (red footprint), click → confirm → 'demolish' command.
 */
import { BUILDINGS } from '../../core/defs';
import type { Building } from '../../core/types';
import { CLICK_SLOP_PX } from '../geometry';
import { OverlayAlpha, OverlayColor } from '../overlay/colors';
import { BaseTool } from './base';
import type { ToolHost } from './types';

/** Confirmation text for demolishing / cancelling a building. */
export function demolishPrompt(b: Building): { message: string; confirm: string } {
  const name = BUILDINGS[b.type].name;
  switch (b.state) {
    case 'clearing':
    case 'construction':
      return { message: `Cancel construction of the ${name}? Delivered materials are returned to storage.`, confirm: 'Cancel construction' };
    case 'ruin':
      return { message: `Clear the ruins of the ${name}?`, confirm: 'Clear ruins' };
    case 'demolishing':
      return { message: `The ${name} is already being demolished.`, confirm: 'OK' };
    default:
      return { message: `Demolish the ${name}? Laborers will tear it down and recover part of the materials.`, confirm: 'Demolish' };
  }
}

/** Ask for confirmation, then demolish (shared by the tool and the Delete hotkey). */
export function confirmDemolish(host: Pick<ToolHost, 'app' | 'playUi'>, id: number): void {
  const app = host.app;
  const game = app.game;
  const b = game.getBuilding(id);
  if (!b) return;
  if (b.state === 'demolishing') {
    app.ui.toast(`The ${BUILDINGS[b.type].name} is already being demolished`, 'info');
    return;
  }
  const { message, confirm } = demolishPrompt(b);
  let pending: Promise<boolean>;
  try {
    pending = app.ui.confirm(message, confirm);
  } catch (err) {
    console.warn('[input] ui.confirm failed', err);
    return;
  }
  host.playUi('open');
  pending.then(
    (ok) => {
      if (!ok || app.game !== game || !game.getBuilding(id)) return;
      let res: { ok: boolean; reason?: string };
      try {
        res = app.dispatch({ op: 'demolish', id });
      } catch (err) {
        console.warn('[input] demolish failed', err);
        res = { ok: false };
      }
      if (res.ok) {
        host.playUi('place');
      } else {
        if (res.reason) app.ui.toast(res.reason, 'warning');
        host.playUi('error');
      }
    },
    () => undefined,
  );
}

export class DemolishTool extends BaseTool {
  readonly kind = 'demolish' as const;

  update(): void {
    const p = this.host.pointer;
    if (!p.inside || !p.hasTile) {
      if (this.keyChanged(-1)) {
        this.host.overlay.clear();
        this.host.setHover(null);
      }
      return;
    }
    const st = this.state;
    const id = st.tiles.building[p.tz * st.W + p.tx];
    if (!this.keyChanged(id, this.host.revStamp)) return;
    const b = id >= 0 ? this.game.getBuilding(id) : undefined;
    const ov = this.host.overlay;
    if (!b) {
      ov.begin(st);
      ov.add(p.tx, p.tz, OverlayColor.demolish, OverlayAlpha.faint);
      ov.end();
      this.host.setHover('Demolish — click a building');
      return;
    }
    ov.begin(st);
    for (let z = b.z; z < b.z + b.h; z++) {
      for (let x = b.x; x < b.x + b.w; x++) ov.add(x, z, OverlayColor.demolish, OverlayAlpha.normal);
    }
    ov.end();
    const name = BUILDINGS[b.type].name;
    const verb = b.state === 'construction' || b.state === 'clearing' ? 'Cancel' : b.state === 'ruin' ? 'Clear ruins of' : 'Demolish';
    this.host.setHover(`${verb} ${name}`);
  }

  override pointerUp(): void {
    const p = this.host.pointer;
    if (p.moved >= CLICK_SLOP_PX || !p.hasTile) return;
    const st = this.state;
    const id = st.tiles.building[p.tz * st.W + p.tx];
    if (id < 0 || !this.game.getBuilding(id)) {
      this.host.playUi('error');
      return;
    }
    confirmDemolish(this.host, id);
  }
}
