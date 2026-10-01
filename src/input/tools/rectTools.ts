/**
 * Rectangle-drag area tools: Remove road, Clear (mark trees/rocks/iron for removal), Unclear.
 * Hover shows the single tile under the cursor; dragging previews the whole rectangle with a count label.
 */
import type { RemovalFilter } from '../../core/types';
import { Feature, Road } from '../../core/types';
import { tileHeight } from '../../core/world';
import { chunkTiles, clampRectToMap, CLICK_SLOP_PX, normalizeRect, rectHeight, rectWidth, type TileRect } from '../geometry';
import { OverlayAlpha, OverlayColor } from '../overlay/colors';
import { BaseTool } from './base';
import type { ToolHost } from './types';

/** Largest rectangle side accepted by area tools (keeps previews cheap). */
const MAX_SIDE = 128;

abstract class RectTool extends BaseTool {
  /** Show every tile currently marked for removal (map-wide, faint) while this tool is active. */
  protected readonly showMarked: boolean = false;
  private markedStamp = -1;
  protected dragging = false;
  private anchorX = 0;
  private anchorZ = 0;
  private lastX = 0;
  private lastZ = 0;
  private readonly rect: TileRect = { x0: 0, z0: 0, x1: 0, z1: 0 };

  override activate(): void {
    super.activate();
    this.dragging = false;
    this.markedStamp = -1;
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

  /** Rebuild the map-wide marked-tiles layer when the (throttled) game revisions change. */
  private refreshMarked(): void {
    if (!this.showMarked || this.markedStamp === this.host.revStamp) return;
    this.markedStamp = this.host.revStamp;
    const st = this.state;
    const t = st.tiles;
    const layer = this.host.marked;
    layer.begin(st);
    const n = st.W * st.H;
    for (let i = 0; i < n; i++) {
      if (t.marked[i] && t.feature[i] !== Feature.None && t.building[i] < 0) layer.addIndex(i, OverlayColor.marked, OverlayAlpha.soft);
    }
    layer.end();
  }

  update(): void {
    this.refreshMarked();
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
    if (!this.keyChanged(this.dragging ? this.anchorX : p.tx, this.dragging ? this.anchorZ : p.tz, p.tx, p.tz, this.dragging ? 1 : 0, this.host.revStamp)) return;
    this.lastX = p.tx;
    this.lastZ = p.tz;
    const r = this.computeRect(p.tx, p.tz);
    if (!r) {
      this.host.overlay.clear();
      this.host.label.hide();
      return;
    }
    this.previewRect(r);
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
    const bx = p.hasTile ? p.tx : this.lastX;
    const bz = p.hasTile ? p.tz : this.lastZ;
    const single = p.moved < CLICK_SLOP_PX && bx === this.anchorX && bz === this.anchorZ;
    const r = this.computeRect(bx, bz);
    this.dragging = false;
    if (r) this.apply(r, single);
    this.invalidate();
  }

  private computeRect(bx: number, bz: number): TileRect | null {
    const st = this.state;
    let r: TileRect;
    if (this.dragging) {
      // limit the side length relative to the anchor
      const cx = Math.max(this.anchorX - MAX_SIDE + 1, Math.min(this.anchorX + MAX_SIDE - 1, bx));
      const cz = Math.max(this.anchorZ - MAX_SIDE + 1, Math.min(this.anchorZ + MAX_SIDE - 1, bz));
      r = normalizeRect(this.anchorX, this.anchorZ, cx, cz);
    } else {
      r = normalizeRect(bx, bz, bx, bz);
    }
    const c = clampRectToMap(r, st.W, st.H);
    if (!c) return null;
    this.rect.x0 = c.x0;
    this.rect.z0 = c.z0;
    this.rect.x1 = c.x1;
    this.rect.z1 = c.z1;
    return this.rect;
  }

  private previewRect(r: TileRect): void {
    const st = this.state;
    const ov = this.host.overlay;
    this.resetCounts();
    ov.begin(st);
    const W = st.W;
    for (let z = r.z0; z <= r.z1; z++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = z * W + x;
        if (!this.paintTile(i, x, z)) {
          if (this.dragging) ov.add(x, z, OverlayColor.rectFill, OverlayAlpha.faint);
        }
      }
    }
    ov.end();
    const summary = this.summary();
    if (this.dragging) {
      const cx = (r.x0 + r.x1 + 1) / 2;
      const cz = (r.z0 + r.z1 + 1) / 2;
      const y = tileHeight(st, Math.floor(cx), Math.floor(cz)) + 0.8;
      this.host.label.show(`${rectWidth(r)} × ${rectHeight(r)} · ${summary}`, cx, Math.max(0, y), cz);
    } else {
      this.host.label.hide();
    }
    this.host.setHover(this.hoverText(summary));
  }

  /** Reset per-preview counters. */
  protected abstract resetCounts(): void;
  /** Paint tile i if relevant (and count it). Returns true if painted. */
  protected abstract paintTile(i: number, x: number, z: number): boolean;
  /** "12 trees · 3 rocks" */
  protected abstract summary(): string;
  protected abstract hoverText(summary: string): string;
  /** Apply the tool to the rectangle. */
  protected abstract apply(r: TileRect, single: boolean): void;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// -----------------------------------------------------------------------------------------------

export class RemoveRoadTool extends RectTool {
  readonly kind = 'removeRoad' as const;
  private roads = 0;

  protected resetCounts(): void {
    this.roads = 0;
  }

  protected paintTile(i: number): boolean {
    if (this.state.tiles.road[i] === Road.None) return false;
    this.roads++;
    this.host.overlay.addIndex(i, OverlayColor.remove, OverlayAlpha.strong);
    return true;
  }

  protected summary(): string {
    return this.roads > 0 ? `remove ${plural(this.roads, 'road tile', 'road tiles')}` : 'no roads';
  }

  protected hoverText(summary: string): string {
    return this.dragging ? `Remove roads — ${summary}` : 'Remove roads — click or drag over roads';
  }

  protected apply(r: TileRect): void {
    const st = this.state;
    const tiles: number[] = [];
    for (let z = r.z0; z <= r.z1; z++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = z * st.W + x;
        if (st.tiles.road[i] !== Road.None) tiles.push(i);
      }
    }
    if (tiles.length === 0) {
      this.host.playUi('click');
      return;
    }
    let removed = 0;
    let queued = false;
    let refused: string | undefined;
    for (const chunk of chunkTiles(tiles)) {
      const res = this.dispatch({ op: 'removeRoad', tiles: chunk });
      if (!res.ok) refused = res.reason;
      else if (res.pending) queued = true;
      else removed += res.count ?? chunk.length;
    }
    if (removed > 0 || queued) this.host.playUi('place');
    else {
      this.host.toast(refused ?? 'Those roads cannot be removed', 'warning');
      this.host.playUi('error');
    }
  }
}

// -----------------------------------------------------------------------------------------------

function featureMatches(feature: number, filter: RemovalFilter): boolean {
  switch (filter) {
    case 'all': return feature !== Feature.None;
    case 'trees': return feature === Feature.Tree;
    case 'stone': return feature === Feature.Rock;
    case 'iron': return feature === Feature.Iron;
  }
}

const FILTER_LABEL: Record<RemovalFilter, string> = {
  all: 'Clear area',
  trees: 'Clear trees',
  stone: 'Clear stone',
  iron: 'Clear iron',
};

export class ClearTool extends RectTool {
  readonly kind = 'clear' as const;
  protected override readonly showMarked = true;
  private trees = 0;
  private rocks = 0;
  private iron = 0;
  private already = 0;

  constructor(host: ToolHost, readonly filter: RemovalFilter) {
    super(host);
  }

  protected resetCounts(): void {
    this.trees = 0;
    this.rocks = 0;
    this.iron = 0;
    this.already = 0;
  }

  protected paintTile(i: number): boolean {
    const t = this.state.tiles;
    const f = t.feature[i];
    if (!featureMatches(f, this.filter)) return false;
    if (t.building[i] >= 0) return false;
    if (t.marked[i]) {
      this.already++;
      this.host.overlay.addIndex(i, OverlayColor.marked, OverlayAlpha.soft);
      return true;
    }
    if (f === Feature.Tree) this.trees++;
    else if (f === Feature.Rock) this.rocks++;
    else if (f === Feature.Iron) this.iron++;
    this.host.overlay.addIndex(i, OverlayColor.mark, OverlayAlpha.strong);
    return true;
  }

  protected summary(): string {
    const parts: string[] = [];
    if (this.trees) parts.push(plural(this.trees, 'tree', 'trees'));
    if (this.rocks) parts.push(plural(this.rocks, 'rock', 'rocks'));
    if (this.iron) parts.push(plural(this.iron, 'iron deposit', 'iron deposits'));
    if (parts.length === 0) return this.already > 0 ? `${this.already} already marked` : 'nothing to clear';
    return parts.join(' · ');
  }

  protected hoverText(summary: string): string {
    return this.dragging ? `${FILTER_LABEL[this.filter]} — ${summary}` : `${FILTER_LABEL[this.filter]} — drag to mark for removal`;
  }

  protected apply(r: TileRect): void {
    const res = this.dispatch({ op: 'mark', x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, filter: this.filter });
    if (!res.ok && res.reason) this.host.toast(res.reason, 'warning');
    this.host.playUi(res.ok && (res.pending || (res.count ?? 0) > 0) ? 'place' : 'click');
  }
}

// -----------------------------------------------------------------------------------------------

export class UnclearTool extends RectTool {
  readonly kind = 'unclear' as const;
  protected override readonly showMarked = true;
  private marked = 0;

  protected resetCounts(): void {
    this.marked = 0;
  }

  protected paintTile(i: number): boolean {
    const t = this.state.tiles;
    if (!t.marked[i] || t.feature[i] === Feature.None) return false;
    // Features inside building footprints are cleared for construction; leave them alone.
    if (t.building[i] >= 0) return false;
    this.marked++;
    this.host.overlay.addIndex(i, OverlayColor.unmark, OverlayAlpha.strong);
    return true;
  }

  protected summary(): string {
    return this.marked > 0 ? `unmark ${this.marked}` : 'nothing marked';
  }

  protected hoverText(summary: string): string {
    return this.dragging ? `Unclear — ${summary}` : 'Unclear — drag to cancel removal orders';
  }

  protected apply(r: TileRect): void {
    const res = this.dispatch({ op: 'unmark', x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 });
    if (!res.ok && res.reason) this.host.toast(res.reason, 'warning');
    this.host.playUi(res.ok && (res.pending || (res.count ?? 0) > 0) ? 'place' : 'click');
  }
}
