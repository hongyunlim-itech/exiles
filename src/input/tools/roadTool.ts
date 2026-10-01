/**
 * Road tool: drag an L-shaped path (bend chosen by the dominant drag axis); preview valid/blocked tiles via
 * game.checkRoad; release → 'road' command(s). Shallow-water tiles become bridges.
 */
import { ROAD_DEFS } from '../../core/defs';
import { Road, Terrain } from '../../core/types';
import { tileHeight } from '../../core/world';
import { chunkTiles, roadPathIndices } from '../geometry';
import { OverlayAlpha, OverlayColor } from '../overlay/colors';
import { BaseTool } from './base';
import type { ToolHost } from './types';

export class RoadTool extends BaseTool {
  readonly kind = 'road' as const;
  private dragging = false;
  private anchorX = 0;
  private anchorZ = 0;
  private path: number[] = [];
  /** End tile of the last preview (used when the pointer leaves the terrain mid-drag). */
  private lastEndX = 0;
  private lastEndZ = 0;

  constructor(host: ToolHost, readonly road: 'dirt' | 'stone') {
    super(host);
  }

  override activate(): void {
    super.activate();
    this.dragging = false;
  }

  override deactivate(): void {
    this.dragging = false;
    super.deactivate();
  }

  override cancelDrag(): boolean {
    if (!this.dragging) return false;
    this.dragging = false;
    this.invalidate();
    return true;
  }

  update(): void {
    const p = this.host.pointer;
    if (!p.inside || !p.hasTile) {
      if (!this.dragging) {
        this.keyChanged(-1);
        this.host.overlay.clear();
        this.host.label.hide();
        this.host.setHover(null);
      }
      return;
    }
    const ax = this.dragging ? this.anchorX : p.tx;
    const az = this.dragging ? this.anchorZ : p.tz;
    if (!this.keyChanged(ax, az, p.tx, p.tz, this.dragging ? 1 : 0, this.host.revStamp)) return;
    this.preview(ax, az, p.tx, p.tz);
  }

  override pointerDown(): void {
    const p = this.host.pointer;
    if (!p.hasTile) return;
    this.dragging = true;
    this.anchorX = p.tx;
    this.anchorZ = p.tz;
    this.invalidate();
  }

  override pointerUp(): void {
    if (!this.dragging) return;
    const p = this.host.pointer;
    this.dragging = false;
    const ex = p.hasTile ? p.tx : this.lastEndX;
    const ez = p.hasTile ? p.tz : this.lastEndZ;
    this.commit(this.anchorX, this.anchorZ, ex, ez);
    this.invalidate();
  }

  // ---------------------------------------------------------------------------------------------

  /** Tiles of `ok` that actually change: new roads, or dirt → stone upgrades (never downgrade stone/bridges). */
  private buildable(ok: number[]): number[] {
    const road = this.state.tiles.road;
    const upgrade = this.road === 'stone';
    return ok.filter((i) => road[i] === Road.None || (upgrade && road[i] === Road.Dirt));
  }

  private check(tiles: number[]): { ok: number[]; blocked: number[] } {
    try {
      return this.game.checkRoad(tiles, this.road);
    } catch (err) {
      console.warn('[input] checkRoad failed', err);
      return { ok: [], blocked: tiles.slice() };
    }
  }

  private preview(ax: number, az: number, bx: number, bz: number): void {
    const st = this.state;
    const host = this.host;
    this.lastEndX = bx;
    this.lastEndZ = bz;
    this.path = roadPathIndices(ax, az, bx, bz, st.W, st.H);
    const res = this.check(this.path);
    const t = st.tiles;
    const ov = host.overlay;
    let bridges = 0;
    let paved = 0;
    const upgrade = this.road === 'stone';
    ov.begin(st);
    const baseColor = this.road === 'stone' ? OverlayColor.stoneRoad : OverlayColor.road;
    for (const i of res.ok) {
      const r = t.road[i];
      const bridge = t.terrain[i] === Terrain.Water;
      const changes = r === Road.None || (upgrade && r === Road.Dirt);
      if (changes) {
        if (bridge) bridges++;
        else paved++;
      }
      ov.addIndex(i, bridge ? OverlayColor.bridge : baseColor, changes ? OverlayAlpha.strong : OverlayAlpha.soft);
    }
    for (const i of res.blocked) ov.addIndex(i, OverlayColor.blocked, OverlayAlpha.strong);
    ov.end();

    if (this.dragging) {
      const parts: string[] = [`${this.path.length} tile${this.path.length === 1 ? '' : 's'}`];
      if (this.road === 'stone') {
        const stone = paved * (ROAD_DEFS.stone.cost.stone ?? 1);
        if (stone > 0) parts.push(`${stone} stone`);
      }
      if (bridges > 0) {
        const bc = ROAD_DEFS.bridge.cost;
        parts.push(`${bridges} bridge${bridges === 1 ? '' : 's'} (${bridges * (bc.log ?? 0)} logs, ${bridges * (bc.stone ?? 0)} stone)`);
      }
      if (res.blocked.length > 0) parts.push(`${res.blocked.length} blocked`);
      host.label.show(parts.join(' · '), bx + 0.5, tileHeight(st, bx, bz) + 0.6, bz + 0.5, res.ok.length === 0);
    } else {
      host.label.hide();
    }
    const name = this.road === 'stone' ? ROAD_DEFS.stone.name : ROAD_DEFS.dirt.name;
    host.setHover(res.ok.length > 0 || this.dragging ? `${name} — drag to lay a path` : `${name} — cannot build here`);
  }

  private commit(ax: number, az: number, bx: number, bz: number): void {
    const st = this.state;
    const host = this.host;
    const path = roadPathIndices(ax, az, bx, bz, st.W, st.H);
    const res = this.check(path);
    if (res.ok.length === 0) {
      host.toast('A road cannot be built there', 'warning');
      host.playUi('error');
      return;
    }
    const tiles = this.buildable(res.ok);
    if (tiles.length === 0) {
      host.playUi('click');
      return;
    }
    let placed = 0;
    let queued = false;
    let refused: string | undefined;
    // long paths go out in several commands (co-op payloads are small); each tile is independent
    for (const chunk of chunkTiles(tiles)) {
      const res = this.dispatch({ op: 'road', kind: this.road, tiles: chunk });
      if (!res.ok) refused = res.reason;
      else if (res.pending) queued = true;
      else placed += res.count ?? chunk.length;
    }
    if (queued) {
      // co-op: the host lays it at its next turn (a refusal arrives as a toast)
      host.playUi('place');
      if (refused) host.toast(refused, 'warning');
      return;
    }
    if (placed > 0) {
      host.playUi('place');
      if (placed < tiles.length) {
        host.toast(`Not enough materials: ${tiles.length - placed} road tile${tiles.length - placed === 1 ? '' : 's'} skipped`, 'warning');
      }
    } else {
      host.toast(refused ?? (this.road === 'stone' ? 'Not enough stone for a stone road' : 'A road cannot be built there'), 'warning');
      host.playUi('error');
    }
  }
}
