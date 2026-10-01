/**
 * Build tool: placement ghost + per-tile validity overlay + work-radius rings, for fixed-size buildings and resizable
 * zones (drag a rectangle; single click = default size). Stays active after placing.
 */
import { WATER_LEVEL } from '../../core/constants';
import type { BuildingDef } from '../../core/defs';
import { BUILDINGS } from '../../core/defs';
import type { BuildingType, GameState, PlacementCheck } from '../../core/types';
import { Road } from '../../core/types';
import type { Command, PlayerInfo } from '../../net/types';
import { cornerHeight, isLandTerrain, rotationAngle } from '../../core/world';
import { centredFootprint, CLICK_SLOP_PX, modelDims, zoneRectFromDrag, type Footprint } from '../geometry';
import { OverlayAlpha, OverlayColor } from '../overlay/colors';
import { BaseTool } from './base';
import type { ToolHost } from './types';

/** Footprint tile classes for the validity overlay. */
const MARK_OK = 0;
const MARK_CLEAR = 1;
const MARK_BLOCKED = 2;

/** Suppress repeated failure toasts for a click right after a successful placement at the same spot (double-click). */
const DOUBLE_CLICK_MS = 600;
/** Co-op: how long a queued placement blocks its footprint locally (until the host's turn places it). */
const PENDING_PLACE_MS = 3000;

/** Whether a door tile can be walked through (land or bridge, not occupied by a building). */
function isDoorTileUsable(st: GameState, x: number, z: number): boolean {
  const i = z * st.W + x;
  if (st.tiles.building[i] >= 0) return false;
  return isLandTerrain(st.tiles.terrain[i]) || st.tiles.road[i] === Road.Bridge;
}

function failedCheck(reason: string): PlacementCheck {
  return { ok: false, reason, blocked: [], clearing: [], doorX: -1, doorZ: -1 };
}

export class BuildTool extends BaseTool {
  readonly kind = 'build' as const;
  readonly type: BuildingType;
  private readonly def: BuildingDef;
  private readonly zone: { min: number; max: number } | undefined;
  private dragging = false;
  private anchorX = 0;
  private anchorZ = 0;
  private readonly fp: Footprint = { x: 0, z: 0, w: 1, h: 1 };
  /** Per-footprint-tile classification scratch (reused). */
  private marks = new Uint8Array(256);
  private lastPlaceAt = -1e9;
  private lastPlaceX = -1;
  private lastPlaceZ = -1;
  private faintBuildingsRev = -1;
  private faintTerrainRev = -1;
  private faintWidth = -1;
  /** Co-op: placements queued for the host but not applied yet (never read in solo). */
  private pendingPlacements: { x: number; z: number; w: number; h: number; at: number }[] = [];
  /** What the ghost currently shows (shared with other players as presence). */
  private ghostInfo: PlayerInfo['ghost'] = null;

  constructor(host: ToolHost, type: BuildingType) {
    super(host);
    this.type = type;
    this.def = BUILDINGS[type];
    this.zone = this.def.resizable;
  }

  override activate(): void {
    super.activate();
    this.dragging = false;
    this.faintBuildingsRev = -1;
  }

  override deactivate(): void {
    this.dragging = false;
    this.ghostInfo = null;
    super.deactivate();
  }

  override cancelDrag(): boolean {
    if (!this.dragging) return false;
    this.dragging = false;
    this.invalidate();
    return true;
  }

  override rotate(): void {
    this.invalidate();
  }

  presenceGhost(): PlayerInfo['ghost'] {
    return this.ghostInfo;
  }

  update(): void {
    this.updateFaintRings();
    const p = this.host.pointer;
    if (!p.inside || !p.hasTile) {
      if (!this.dragging) {
        this.keyChanged(-1);
        this.host.overlay.clear();
        this.host.ghost.hide();
        this.host.rings.cursor.hide();
        this.host.label.hide();
        this.host.setHover(null);
        this.ghostInfo = null;
      }
      return;
    }
    this.computeFootprint(p.tx, p.tz, p.wx, p.wz, this.fp);
    const fp = this.fp;
    if (!this.keyChanged(fp.x, fp.z, fp.w, fp.h, this.host.rotation, this.host.revStamp, this.host.ringWidth)) return;
    this.preview(fp);
  }

  override pointerDown(): void {
    const p = this.host.pointer;
    if (this.zone && p.hasTile) {
      this.dragging = true;
      this.anchorX = p.tx;
      this.anchorZ = p.tz;
      this.invalidate();
    }
  }

  override pointerUp(): void {
    const p = this.host.pointer;
    if (this.zone) {
      if (!this.dragging) return;
      this.dragging = false;
      const fp: Footprint = { x: 0, z: 0, w: 1, h: 1 };
      if (p.moved < CLICK_SLOP_PX || !p.hasTile || (p.tx === this.anchorX && p.tz === this.anchorZ)) {
        // Single click → default size centred on the cursor.
        this.defaultFootprint(p.downHasTile ? p.downWx : p.wx, p.downHasTile ? p.downWz : p.wz, fp);
      } else {
        this.computeFootprint(p.tx, p.tz, p.wx, p.wz, fp, true);
      }
      this.place(fp);
    } else {
      if (!p.hasTile) return;
      const fp: Footprint = { x: 0, z: 0, w: 1, h: 1 };
      this.computeFootprint(p.tx, p.tz, p.wx, p.wz, fp);
      this.place(fp);
    }
    this.invalidate();
  }

  // ---------------------------------------------------------------------------------------------

  /** Footprint under the cursor (default size centred) or of the current zone drag. Allocation-free. */
  private computeFootprint(tx: number, tz: number, wx: number, wz: number, out: Footprint, forceDrag = false): void {
    const st = this.state;
    if (this.zone && (this.dragging || forceDrag)) {
      zoneRectFromDrag(this.anchorX, this.anchorZ, tx, tz, this.zone.min, this.zone.max, st.W, st.H, out);
      return;
    }
    this.defaultFootprint(wx, wz, out);
  }

  /** Default-size footprint (def.size rotated) centred on (wx, wz). */
  private defaultFootprint(wx: number, wz: number, out: Footprint): void {
    const st = this.state;
    const [sw, sh] = this.def.size;
    const odd = this.host.rotation % 2 === 1;
    centredFootprint(wx, wz, odd ? sh : sw, odd ? sw : sh, st.W, st.H, out);
  }

  private runCheck(fp: Footprint): PlacementCheck {
    try {
      return this.zone
        ? this.game.checkPlacement(this.type, fp.x, fp.z, this.host.rotation, fp.w, fp.h)
        : this.game.checkPlacement(this.type, fp.x, fp.z, this.host.rotation);
    } catch (err) {
      console.warn('[input] checkPlacement failed', err);
      return failedCheck('Cannot check placement');
    }
  }

  /** Approximate ground height of the (flattened) footprint: average of its corner heights, never below water. */
  private groundY(fp: Footprint): number {
    const st = this.state;
    let sum = 0;
    let n = 0;
    for (let z = fp.z; z <= fp.z + fp.h; z++) {
      for (let x = fp.x; x <= fp.x + fp.w; x++) {
        sum += cornerHeight(st, x, z);
        n++;
      }
    }
    const avg = n > 0 ? sum / n : 0;
    return Math.max(avg, WATER_LEVEL);
  }

  private preview(fp: Footprint): void {
    const host = this.host;
    const st = this.state;
    const check = this.runCheck(fp);

    // ---- per-tile validity overlay ----
    const n = fp.w * fp.h;
    if (this.marks.length < n) this.marks = new Uint8Array(n);
    const marks = this.marks;
    marks.fill(MARK_OK, 0, n);
    const W = st.W;
    for (const i of check.clearing) {
      const lx = (i % W) - fp.x;
      const lz = Math.floor(i / W) - fp.z;
      if (lx >= 0 && lz >= 0 && lx < fp.w && lz < fp.h) marks[lz * fp.w + lx] = MARK_CLEAR;
    }
    for (const i of check.blocked) {
      const lx = (i % W) - fp.x;
      const lz = Math.floor(i / W) - fp.z;
      if (lx >= 0 && lz >= 0 && lx < fp.w && lz < fp.h) marks[lz * fp.w + lx] = MARK_BLOCKED;
    }
    // Invalid without specific tiles (e.g. "must be next to water"): tint the whole footprint red.
    const wholeBad = !check.ok && check.blocked.length === 0;
    const ov = host.overlay;
    ov.begin(st);
    for (let lz = 0; lz < fp.h; lz++) {
      for (let lx = 0; lx < fp.w; lx++) {
        const m = marks[lz * fp.w + lx];
        if (m === MARK_BLOCKED) ov.add(fp.x + lx, fp.z + lz, OverlayColor.blocked, OverlayAlpha.strong);
        else if (m === MARK_CLEAR) ov.add(fp.x + lx, fp.z + lz, OverlayColor.clearing, OverlayAlpha.normal);
        else if (wholeBad) ov.add(fp.x + lx, fp.z + lz, OverlayColor.blocked, OverlayAlpha.soft);
        else ov.add(fp.x + lx, fp.z + lz, OverlayColor.ok, OverlayAlpha.normal);
      }
    }
    // Door / entrance tile (outside the footprint for regular buildings).
    const dx = check.doorX;
    const dz = check.doorZ;
    const doorOutside = dx < fp.x || dz < fp.z || dx >= fp.x + fp.w || dz >= fp.z + fp.h;
    if (dx >= 0 && dz >= 0 && dx < st.W && dz < st.H && doorOutside) {
      ov.add(dx, dz, isDoorTileUsable(st, dx, dz) ? OverlayColor.door : OverlayColor.blocked, OverlayAlpha.strong);
    }
    ov.end();

    // ---- ghost ----
    const rot = host.rotation;
    const [mw, mh] = modelDims(fp.w, fp.h, rot);
    const y = this.groundY(fp);
    const cx = fp.x + fp.w / 2;
    const cz = fp.z + fp.h / 2;
    host.ghost.show(this.type, mw, mh, cx, y, cz, rotationAngle(rot), check.ok);
    this.ghostInfo = { type: this.type, x: fp.x, z: fp.z, rot, w: fp.w, h: fp.h, valid: check.ok };

    // ---- work radius ----
    if (this.def.workRadius) host.rings.cursor.show(st, cx, cz, this.def.workRadius, host.ringWidth);
    else host.rings.cursor.hide();

    // ---- size label (zones) ----
    if (this.zone) {
      const text = `${fp.w} × ${fp.h}`;
      host.label.show(text, cx, y + 0.6, cz, !check.ok);
    } else {
      host.label.hide();
    }

    // ---- hover text ----
    const name = this.def.name;
    if (!check.ok) {
      host.setHover(`${name} — ${check.reason ?? 'cannot be placed here'}`);
    } else {
      const hint = this.zone ? 'drag to resize' : 'R to rotate';
      const clearing = check.clearing.length > 0 ? `${check.clearing.length} tile${check.clearing.length === 1 ? '' : 's'} to clear first · ` : '';
      host.setHover(`${name} — ${clearing}click to place · ${hint}`);
    }
  }

  private place(fp: Footprint): void {
    const host = this.host;
    const check = this.runCheck(fp);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const repeat = now - this.lastPlaceAt < DOUBLE_CLICK_MS && fp.x === this.lastPlaceX && fp.z === this.lastPlaceZ;
    if (!check.ok) {
      if (!repeat) {
        host.toast(check.reason ?? `Cannot place ${this.def.name} here`, 'warning');
        host.playUi('error');
      }
      return;
    }
    // co-op: the footprint of a placement still waiting for the host looks free locally — don't order it twice
    if (this.overlapsPending(fp, now)) {
      if (!repeat) {
        host.toast(`A ${this.def.name} is already ordered there — waiting for the host`, 'info');
        host.playUi('error');
      }
      return;
    }
    const cmd: Command = this.zone
      ? { op: 'place', type: this.type, x: fp.x, z: fp.z, rot: host.rotation, w: fp.w, h: fp.h }
      : { op: 'place', type: this.type, x: fp.x, z: fp.z, rot: host.rotation };
    const res = this.dispatch(cmd);
    if (res.ok) {
      this.lastPlaceAt = now;
      this.lastPlaceX = fp.x;
      this.lastPlaceZ = fp.z;
      if (res.pending) this.pendingPlacements.push({ x: fp.x, z: fp.z, w: fp.w, h: fp.h, at: now });
      host.playUi('place');
    } else {
      host.toast(res.reason ?? check.reason ?? `Cannot place ${this.def.name} here`, 'warning');
      host.playUi('error');
    }
  }

  /** Does `fp` overlap a placement queued in co-op within the last PENDING_PLACE_MS? (drops expired entries) */
  private overlapsPending(fp: Footprint, now: number): boolean {
    const list = this.pendingPlacements;
    if (list.length === 0) return false;
    let hit = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const q = list[i];
      if (now - q.at > PENDING_PLACE_MS) {
        list.splice(i, 1);
        continue;
      }
      if (fp.x < q.x + q.w && q.x < fp.x + fp.w && fp.z < q.z + q.h && q.z < fp.z + fp.h) hit = true;
    }
    return hit;
  }

  /** Faint rings around existing buildings of the same type (rebuilt when buildings/terrain/zoom change). */
  private updateFaintRings(): void {
    const r = this.def.workRadius;
    if (!r) return;
    const st = this.state;
    const width = this.host.ringWidth * 0.8;
    if (st.rev.buildings === this.faintBuildingsRev && st.rev.terrain === this.faintTerrainRev && width === this.faintWidth) return;
    this.faintBuildingsRev = st.rev.buildings;
    this.faintTerrainRev = st.rev.terrain;
    this.faintWidth = width;
    const rings = this.host.rings;
    rings.beginFaint();
    for (const b of st.buildings) {
      if (b.type !== this.type || b.state === 'ruin') continue;
      rings.addFaint(st, b.x + b.w / 2, b.z + b.h / 2, r, width);
    }
    rings.endFaint();
  }
}
