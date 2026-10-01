/**
 * InputManager — tools (select, build placement with ghost & rotation, zone drag, road drag, clear/unclear area drag,
 * remove roads, demolish), overlays (tile validity, work radius rings, marked area), hotkeys. OWNER: input agent.
 *
 * Structure:
 *  - pointer & keyboard listeners live here; the per-tool behaviour lives in ./tools/* (one ToolHandler per tool).
 *  - overlays (./overlay/*) are shared by the tools and live under renderer.overlayGroup (never cast shadows).
 *  - the terrain pick is refreshed only when the pointer or the camera moved; tools recompute their previews only when
 *    their key (tile / rotation / size / throttled game revisions) changes.
 *  - town mutations go through AppContext.dispatch (co-op safe); every frame the pointer, camera, build ghost and tool
 *    label are published as co-op presence (./presence.ts).
 */
import * as THREE from 'three';
import type { UiCue } from '../audio/audio';
import type { AppContext, Tool } from '../core/app';
import { BUILDINGS } from '../core/defs';
import type { GameSpeed, Rotation } from '../core/types';
import { CLICK_SLOP_PX } from './geometry';
import { hotkeyAction, isTypingTarget, sameTool, type HotkeyAction } from './hotkeys';
import { GhostManager } from './overlay/ghost';
import { PresenceTracker, toolPresenceLabel, type PresenceInput } from './presence';
import { ToolLabel } from './overlay/label';
import { RingSet, ringWidthForDistance } from './overlay/rings';
import { TileOverlay } from './overlay/tileOverlay';
import { BuildTool } from './tools/buildTool';
import { confirmDemolish, DemolishTool } from './tools/demolishTool';
import { ClearTool, RemoveRoadTool, UnclearTool } from './tools/rectTools';
import { RoadTool } from './tools/roadTool';
import { SelectTool } from './tools/selectTool';
import { createPointerState, type PointerState, type ToolHandler, type ToolHost } from './tools/types';

/** Minimum seconds between preview refreshes caused only by game-state revisions. */
const REV_REFRESH_INTERVAL = 0.2;
/** Minimum seconds between two non-null hoverInfo emissions. */
const HOVER_INTERVAL = 0.1;

export class InputManager {
  tool: Tool = { kind: 'select' };

  private readonly app: AppContext;
  private readonly canvas: HTMLElement;
  private readonly root = new THREE.Group();
  private readonly overlay: TileOverlay;
  private readonly marked: TileOverlay;
  private readonly rings: RingSet;
  private readonly ghost: GhostManager;
  private readonly label: ToolLabel;
  private readonly pointer: PointerState = createPointerState();
  private readonly host: ToolHost;
  private handler: ToolHandler;

  /** Current build rotation (kept between build tools). */
  private rotation: Rotation = 0;
  private revStamp = 0;
  private ringWidth = 0.2;
  private time = 0;

  // pointer bookkeeping
  private overCanvas = false;
  private pointerDirty = true;
  private rightDown = false;
  private rightDownX = 0;
  private rightDownY = 0;
  private rightMoved = 0;
  private captureId = -1;
  /** The left button went down under a different tool (or game): don't forward its release. */
  private ignoreRelease = false;
  private readonly camSig = new Float64Array(8);

  // game revision tracking
  private revTerrain = -1;
  private revFeatures = -1;
  private revRoads = -1;
  private revBuildings = -1;
  private revFields = -1;
  private revTime = -1e9;

  // hover info
  private hoverPending: string | null = null;
  private hoverEmitted: string | null = null;
  private hoverTime = -1e9;

  // hotkey state
  private prevSpeed: GameSpeed = 1;
  private gridVisible = false;

  // co-op presence (scratch objects: publishing runs every frame)
  private readonly presence = new PresenceTracker();
  private readonly presCursor = { x: 0, z: 0 };
  private readonly presCamera = { x: 0, z: 0, yaw: 0, dist: 0 };
  private readonly presInput: PresenceInput = { cursor: null, camera: null, ghost: null, tool: '' };
  private presToolRef: Tool | null = null;
  private presToolLabel = '';
  private presMenu = false;
  private presInspecting = false;
  private presenceWarned = false;

  private readonly offs: Array<() => void> = [];
  private disposed = false;

  constructor(app: AppContext, canvas: HTMLElement) {
    this.app = app;
    this.canvas = canvas;
    this.root.name = 'input.overlays';
    app.renderer.overlayGroup.add(this.root);
    this.marked = new TileOverlay(this.root, 256, 9, 'input.markedOverlay');
    this.overlay = new TileOverlay(this.root);
    this.rings = new RingSet(this.root);
    this.ghost = new GhostManager(this.root);
    this.label = new ToolLabel((x, y, z) => this.app.renderer.worldToScreen(x, y, z));
    try {
      this.gridVisible = !!app.renderer.settings?.showGrid;
    } catch {
      this.gridVisible = false;
    }
    const speed0 = this.sharedSpeed();
    if (speed0 > 0) this.prevSpeed = speed0;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.host = {
      get app() { return self.app; },
      get pointer() { return self.pointer; },
      get overlay() { return self.overlay; },
      get marked() { return self.marked; },
      get rings() { return self.rings; },
      get ghost() { return self.ghost; },
      get label() { return self.label; },
      get rotation() { return self.rotation; },
      get revStamp() { return self.revStamp; },
      get ringWidth() { return self.ringWidth; },
      setHover: (text) => { self.hoverPending = text; },
      playUi: (cue) => self.playUi(cue),
      toast: (text, severity) => self.toast(text, severity),
    };
    this.handler = this.createHandler(this.tool);
    this.handler.activate();

    this.offs.push(app.events.on('speedChanged', ({ speed }) => {
      if (speed > 0) this.prevSpeed = speed;
    }));
    this.listen(canvas, 'pointerdown', this.onPointerDown as EventListener);
    this.listen(canvas, 'pointermove', this.onPointerMove as EventListener);
    this.listen(canvas, 'pointerenter', this.onPointerEnter as EventListener);
    this.listen(canvas, 'pointerleave', this.onPointerLeave as EventListener);
    this.listen(canvas, 'contextmenu', this.onContextMenu);
    if (typeof window !== 'undefined') {
      this.listen(window, 'pointerup', this.onWindowPointerUp as EventListener);
      this.listen(window, 'pointercancel', this.onPointerCancel as EventListener);
      this.listen(window, 'keydown', this.onKeyDown as EventListener);
      this.listen(window, 'blur', this.onBlur);
    }
  }

  // ---- public API ------------------------------------------------------------------------------

  /** Switch tools. Called by AppContext.setTool (which also emits toolChanged) — never calls app.setTool. */
  setTool(tool: Tool): void {
    if (this.disposed) return;
    if (this.pointer.leftDown) this.ignoreRelease = true;
    this.handler.cancelDrag();
    this.handler.deactivate();
    this.tool = tool;
    this.handler = this.createHandler(tool);
    this.handler.activate();
    this.pointerDirty = true;
  }

  /** Per-frame: update ghost/overlays from the last pointer position. */
  update(realDt: number): void {
    if (this.disposed) return;
    this.time += realDt;
    const app = this.app;
    const p = this.pointer;
    const camMoved = this.cameraMoved();
    const usable = !app.inMenu && (p.leftDown || (this.overCanvas && !this.overUI()));
    if (!usable) {
      p.inside = false;
      p.hasTile = false;
      // re-pick as soon as the pointer is usable again, even if it didn't move
      this.pointerDirty = true;
    } else {
      p.inside = true;
      if (this.pointerDirty || camMoved) this.pick();
      this.pointerDirty = false;
    }
    this.refreshRevisions();
    this.refreshRingWidth();
    this.handler.update(realDt);
    this.updateSelectionRing();
    this.rings.animate(this.time);
    if (camMoved) {
      // label.show() positions the label itself; only re-project when the view changed
      this.label.reposition();
      this.feedListenerOrientation();
    }
    this.flushHover();
    this.publishPresence();
  }

  /** The game instance changed (new/load). */
  onGameChanged(): void {
    if (this.disposed) return;
    this.handler.cancelDrag();
    this.handler.deactivate();
    this.releaseCapture();
    const p = this.pointer;
    p.leftDown = false;
    p.hasTile = false;
    this.rightDown = false;
    this.ignoreRelease = false;
    this.ghost.clear();
    this.overlay.clear();
    this.marked.clear();
    this.rings.hideAll();
    this.label.hide();
    this.revTerrain = this.revFeatures = this.revRoads = this.revBuildings = this.revFields = -1;
    this.revStamp++;
    const speed = this.sharedSpeed();
    this.prevSpeed = speed > 0 ? speed : 1;
    this.handler = this.createHandler(this.tool);
    this.handler.activate();
    this.pointerDirty = true;
    this.hoverPending = null;
    this.flushHover(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.handler.deactivate();
    this.flushHover(true);
    this.disposed = true;
    this.releaseCapture();
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.overlay.dispose();
    this.marked.dispose();
    this.rings.dispose();
    this.ghost.dispose();
    this.label.dispose();
    this.root.parent?.remove(this.root);
  }

  /** Current build rotation (for UI display). */
  get buildRotation(): Rotation {
    return this.rotation;
  }

  /** Whether the tile grid is currently shown (toggled with G). */
  get gridShown(): boolean {
    return this.gridVisible;
  }

  /** Toggle / set the terrain grid overlay. */
  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    try {
      // go through the renderer's settings so a later applySettings (quality/shadows change) keeps the grid state
      const r = this.app.renderer;
      if (typeof r.applySettings === 'function' && r.settings) r.applySettings({ showGrid: visible });
      else r.terrain.setGridVisible(visible);
    } catch (err) {
      console.warn('[input] setGridVisible failed', err);
    }
  }

  // ---- tools -----------------------------------------------------------------------------------

  private createHandler(tool: Tool): ToolHandler {
    switch (tool.kind) {
      case 'select': return new SelectTool(this.host);
      case 'build': return new BuildTool(this.host, tool.type);
      case 'road': return new RoadTool(this.host, tool.road);
      case 'removeRoad': return new RemoveRoadTool(this.host);
      case 'clear': return new ClearTool(this.host, tool.filter);
      case 'unclear': return new UnclearTool(this.host);
      case 'demolish': return new DemolishTool(this.host);
    }
  }

  // ---- pointer ---------------------------------------------------------------------------------

  private listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.offs.push(() => target.removeEventListener(type, fn));
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onPointerEnter = (e: PointerEvent): void => {
    this.overCanvas = true;
    this.setClient(e);
  };

  private onPointerLeave = (): void => {
    this.overCanvas = false;
    this.pointerDirty = true;
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.overCanvas = true;
    this.setClient(e);
    this.handleButtons(e, true);
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.overCanvas = true;
    this.setClient(e);
    const p = this.pointer;
    if (p.leftDown) {
      const d = Math.hypot(e.clientX - p.downClientX, e.clientY - p.downClientY);
      if (d > p.moved) p.moved = d;
    }
    if (this.rightDown) {
      const d = Math.hypot(e.clientX - this.rightDownX, e.clientY - this.rightDownY);
      if (d > this.rightMoved) this.rightMoved = d;
    }
    // Chorded presses/releases (a second button while one is held) arrive as pointermove.
    if (e.buttons !== ((p.leftDown ? 1 : 0) | (this.rightDown ? 2 : 0))) this.handleButtons(e, true);
  };

  private onWindowPointerUp = (e: PointerEvent): void => {
    if (!this.pointer.leftDown && !this.rightDown) return;
    if (e.target === this.canvas || this.pointer.leftDown) this.setClient(e);
    this.handleButtons(e, false);
  };

  private onPointerCancel = (): void => {
    this.cancelPointer();
  };

  private onBlur = (): void => {
    this.cancelPointer();
  };

  private cancelPointer(): void {
    const p = this.pointer;
    if (p.leftDown) {
      p.leftDown = false;
      this.handler.cancelDrag();
    }
    this.releaseCapture();
    this.rightDown = false;
  }

  private setClient(e: PointerEvent): void {
    const p = this.pointer;
    if (p.clientX !== e.clientX || p.clientY !== e.clientY) {
      p.clientX = e.clientX;
      p.clientY = e.clientY;
      this.pointerDirty = true;
    }
  }

  /**
   * Detect press/release transitions of the left and right buttons from `e.buttons`.
   * Presses count only when they start on the canvas: from a pointerdown, or (right button) chorded while the left
   * button is held. A press that began on a UI panel and was dragged onto the canvas is ignored.
   */
  private handleButtons(e: PointerEvent, fromCanvas: boolean): void {
    const isDown = e.type === 'pointerdown';
    const left = (e.buttons & 1) !== 0;
    const right = (e.buttons & 2) !== 0;
    const p = this.pointer;
    if (right && !this.rightDown && fromCanvas && (isDown || p.leftDown)) {
      this.rightDown = true;
      this.rightDownX = e.clientX;
      this.rightDownY = e.clientY;
      this.rightMoved = 0;
    } else if (!right && this.rightDown) {
      this.rightDown = false;
      this.onRightRelease();
    }
    if (left && !p.leftDown && fromCanvas && isDown) this.onLeftPress(e);
    else if (!left && p.leftDown) this.onLeftRelease();
  }

  private onLeftPress(e: PointerEvent): void {
    if (this.app.inMenu || this.overUI() || this.rightDown) return;
    const p = this.pointer;
    p.inside = true;
    this.pick();
    p.leftDown = true;
    p.downClientX = e.clientX;
    p.downClientY = e.clientY;
    p.downHasTile = p.hasTile;
    p.downTx = p.tx;
    p.downTz = p.tz;
    p.downWx = p.wx;
    p.downWz = p.wz;
    p.moved = 0;
    this.ignoreRelease = false;
    try {
      this.canvas.setPointerCapture(e.pointerId);
      this.captureId = e.pointerId;
    } catch {
      this.captureId = -1;
    }
    this.handler.pointerDown();
  }

  private onLeftRelease(): void {
    const p = this.pointer;
    p.leftDown = false;
    this.releaseCapture();
    if (this.ignoreRelease || this.app.inMenu) {
      this.ignoreRelease = false;
      this.handler.cancelDrag();
      this.pointerDirty = true;
      return;
    }
    const d = Math.hypot(p.clientX - p.downClientX, p.clientY - p.downClientY);
    if (d > p.moved) p.moved = d;
    this.pick();
    this.handler.pointerUp();
    this.pointerDirty = true;
  }

  private onRightRelease(): void {
    let camMoved = 0;
    try {
      camMoved = this.app.renderer.cameraController.rightDragMoved;
    } catch {
      camMoved = 0;
    }
    const moved = Math.max(this.rightMoved, Number.isFinite(camMoved) ? camMoved : 0);
    if (moved >= CLICK_SLOP_PX || this.app.inMenu) return;
    // Right click: cancel drag → cancel tool → deselect.
    if (this.pointer.leftDown) {
      this.pointer.leftDown = false;
      this.releaseCapture();
    }
    if (this.handler.cancelDrag()) {
      this.playUi('close');
      return;
    }
    if (this.tool.kind !== 'select') {
      this.app.setTool({ kind: 'select' });
      this.playUi('close');
      return;
    }
    if (this.app.selection) this.app.select(null);
  }

  private releaseCapture(): void {
    if (this.captureId < 0) return;
    try {
      if (this.canvas.hasPointerCapture(this.captureId)) this.canvas.releasePointerCapture(this.captureId);
    } catch {
      /* ignore */
    }
    this.captureId = -1;
  }

  /** Refresh the terrain pick under the pointer. */
  private pick(): void {
    const p = this.pointer;
    let r: { x: number; z: number; wx: number; wz: number } | null = null;
    try {
      r = this.app.renderer.pickTile(p.clientX, p.clientY);
    } catch {
      r = null;
    }
    const st = this.app.game.state;
    if (r && r.x >= 0 && r.z >= 0 && r.x < st.W && r.z < st.H) {
      p.hasTile = true;
      p.tx = r.x;
      p.tz = r.z;
      p.wx = r.wx;
      p.wz = r.wz;
    } else {
      p.hasTile = false;
    }
  }

  /** True when the camera transform or aspect changed since the last call. */
  private cameraMoved(): boolean {
    const cam = this.app.renderer.camera;
    if (!cam) return false;
    const e = cam.matrixWorld.elements;
    const s = this.camSig;
    const a0 = e[12], a1 = e[13], a2 = e[14], a3 = e[8], a4 = e[9], a5 = e[10], a6 = cam.aspect, a7 = cam.fov;
    if (s[0] === a0 && s[1] === a1 && s[2] === a2 && s[3] === a3 && s[4] === a4 && s[5] === a5 && s[6] === a6 && s[7] === a7) return false;
    s[0] = a0;
    s[1] = a1;
    s[2] = a2;
    s[3] = a3;
    s[4] = a4;
    s[5] = a5;
    s[6] = a6;
    s[7] = a7;
    return true;
  }

  /** Give the audio listener the camera's ground-plane right vector (for stereo panning of world sounds). */
  private feedListenerOrientation(): void {
    const cam = this.app.renderer.camera;
    if (!cam) return;
    const e = cam.matrixWorld.elements;
    try {
      this.app.audio.setListenerOrientation(e[0], e[2]);
    } catch {
      /* audio must never break input */
    }
  }

  private overUI(): boolean {
    try {
      return !!this.app.ui?.isPointerOverUI();
    } catch {
      return false;
    }
  }

  // ---- per-frame helpers -----------------------------------------------------------------------

  /** Bump revStamp (throttled) when the game's revision counters change so tools refresh previews. */
  private refreshRevisions(): void {
    const rev = this.app.game.state.rev;
    if (
      rev.terrain === this.revTerrain && rev.features === this.revFeatures && rev.roads === this.revRoads &&
      rev.buildings === this.revBuildings && rev.fields === this.revFields
    ) return;
    if (this.time - this.revTime < REV_REFRESH_INTERVAL) return;
    this.revTerrain = rev.terrain;
    this.revFeatures = rev.features;
    this.revRoads = rev.roads;
    this.revBuildings = rev.buildings;
    this.revFields = rev.fields;
    this.revTime = this.time;
    this.revStamp++;
  }

  private refreshRingWidth(): void {
    let d = 40;
    try {
      d = this.app.renderer.cameraController.distance;
    } catch {
      d = 40;
    }
    if (Number.isFinite(d)) this.ringWidth = ringWidthForDistance(d);
  }

  /** The selected building's work radius (select tool only). */
  private updateSelectionRing(): void {
    const app = this.app;
    const sel = app.selection;
    if (!app.inMenu && sel && sel.kind === 'building' && this.tool.kind === 'select') {
      const b = app.game.getBuilding(sel.id);
      const r = b ? BUILDINGS[b.type].workRadius : undefined;
      if (b && r) {
        this.rings.selection.show(app.game.state, b.x + b.w / 2, b.z + b.h / 2, r, this.ringWidth);
        return;
      }
    }
    this.rings.selection.hide();
  }

  private flushHover(force = false): void {
    const text = this.hoverPending;
    if (text === this.hoverEmitted) return;
    if (!force && text !== null && this.time - this.hoverTime < HOVER_INTERVAL) return;
    this.hoverEmitted = text;
    this.hoverTime = this.time;
    this.app.events.emit('hoverInfo', { text });
  }

  // ---- keyboard --------------------------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (this.app.inMenu) return;
    const action = hotkeyAction(e.code, e.shiftKey);
    if (!action) return;
    if (e.repeat && action.kind !== 'rotate') {
      e.preventDefault();
      return;
    }
    if (this.runAction(action)) e.preventDefault();
  };

  /** Execute a hotkey action. Returns true if it was handled. */
  private runAction(action: HotkeyAction): boolean {
    const app = this.app;
    switch (action.kind) {
      case 'rotate':
        if (this.tool.kind !== 'build') return false;
        this.rotation = ((this.rotation + action.dir + 4) % 4) as Rotation;
        this.handler.rotate();
        this.handler.invalidate();
        this.playUi('click');
        return true;
      case 'escape':
        if (this.pointer.leftDown) {
          this.pointer.leftDown = false;
          this.releaseCapture();
        }
        if (this.handler.cancelDrag()) {
          this.playUi('close');
          return true;
        }
        if (this.tool.kind !== 'select') {
          app.setTool({ kind: 'select' });
          this.playUi('close');
          return true;
        }
        if (app.selection) {
          app.select(null);
          return true;
        }
        app.openMenu();
        return true;
      case 'pause': {
        const speed = this.sharedSpeed();
        if (speed !== 0) {
          this.prevSpeed = speed;
          app.setSpeed(0);
        } else {
          app.setSpeed(this.prevSpeed > 0 ? this.prevSpeed : 1);
        }
        this.playUi('click');
        return true;
      }
      case 'speed':
        app.setSpeed(action.speed);
        this.playUi('click');
        return true;
      case 'tool':
        app.setTool(sameTool(this.tool, action.tool) ? { kind: 'select' } : action.tool);
        this.playUi('click');
        return true;
      case 'grid':
        this.setGridVisible(!this.gridVisible);
        this.playUi('click');
        return true;
      case 'demolishSelected': {
        const sel = app.selection;
        if (!sel || sel.kind !== 'building') return false;
        confirmDemolish(this.host, sel.id);
        return true;
      }
    }
  }

  // ---- co-op -----------------------------------------------------------------------------------

  /** The effective game speed (co-op: the shared speed the host runs). */
  private sharedSpeed(): GameSpeed {
    try {
      return this.app.net.speed();
    } catch {
      return this.app.game?.speed ?? 1;
    }
  }

  /** Share cursor / camera / build ghost / tool with the other players (the session throttles). Allocation-free. */
  private publishPresence(): void {
    const app = this.app;
    let net: AppContext['net'] | undefined;
    try {
      net = app.net;
    } catch {
      return;
    }
    if (!net) return;
    const p = this.pointer;
    const inMenu = app.inMenu;
    const inp = this.presInput;
    inp.cursor = null;
    if (!inMenu && p.inside && p.hasTile) {
      this.presCursor.x = p.wx;
      this.presCursor.z = p.wz;
      inp.cursor = this.presCursor;
    }
    inp.camera = null;
    try {
      const cc = app.renderer.cameraController;
      const cam = this.presCamera;
      cam.x = cc.target.x;
      cam.z = cc.target.z;
      cam.yaw = cc.yaw;
      cam.dist = cc.distance;
      inp.camera = cam;
    } catch {
      inp.camera = null;
    }
    inp.ghost = null;
    try {
      if (!inMenu && p.inside && this.handler.presenceGhost) inp.ghost = this.handler.presenceGhost() ?? null;
    } catch {
      inp.ghost = null;
    }
    const inspecting = !!app.selection;
    if (this.presToolRef !== this.tool || this.presMenu !== inMenu || this.presInspecting !== inspecting) {
      this.presToolRef = this.tool;
      this.presMenu = inMenu;
      this.presInspecting = inspecting;
      this.presToolLabel = toolPresenceLabel(this.tool, { inMenu, inspecting });
    }
    inp.tool = this.presToolLabel;
    const presence = this.presence.next(inp);
    try {
      net.setLocalPresence(presence);
    } catch (err) {
      if (!this.presenceWarned) {
        this.presenceWarned = true;
        console.warn('[input] setLocalPresence failed', err);
      }
    }
  }

  // ---- feedback --------------------------------------------------------------------------------

  private playUi(cue: UiCue): void {
    try {
      this.app.audio.playUi(cue);
    } catch {
      /* audio must never break input */
    }
  }

  private toast(text: string, severity: 'info' | 'good' | 'warning' | 'danger' = 'warning'): void {
    try {
      this.app.ui.toast(text, severity);
    } catch (err) {
      console.warn('[input] toast failed:', text, err);
    }
  }
}
