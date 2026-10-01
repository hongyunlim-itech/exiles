/**
 * Shared types between InputManager and the individual tool handlers.
 */
import type { UiCue } from '../../audio/audio';
import type { AppContext, Tool } from '../../core/app';
import type { Rotation } from '../../core/types';
import type { PlayerInfo } from '../../net/types';
import type { GhostManager } from '../overlay/ghost';
import type { ToolLabel } from '../overlay/label';
import type { RingSet } from '../overlay/rings';
import type { TileOverlay } from '../overlay/tileOverlay';

/** Live pointer state maintained by InputManager (mutated in place; never reallocated). */
export interface PointerState {
  /** Pointer is over the canvas (not over UI, not in the menu). */
  inside: boolean;
  clientX: number;
  clientY: number;
  /** A terrain tile is under the pointer (tx, tz valid; wx, wz = continuous ground point). */
  hasTile: boolean;
  tx: number;
  tz: number;
  wx: number;
  wz: number;
  /** Left button held (drag in progress). */
  leftDown: boolean;
  downClientX: number;
  downClientY: number;
  /** Tile under the pointer when the left button went down. */
  downHasTile: boolean;
  downTx: number;
  downTz: number;
  downWx: number;
  downWz: number;
  /** Max pointer travel (CSS px) since the left button went down. */
  moved: number;
}

export function createPointerState(): PointerState {
  return {
    inside: false,
    clientX: 0,
    clientY: 0,
    hasTile: false,
    tx: 0,
    tz: 0,
    wx: 0,
    wz: 0,
    leftDown: false,
    downClientX: 0,
    downClientY: 0,
    downHasTile: false,
    downTx: 0,
    downTz: 0,
    downWx: 0,
    downWz: 0,
    moved: 0,
  };
}

/** Services the InputManager exposes to tool handlers. */
export interface ToolHost {
  readonly app: AppContext;
  readonly pointer: PointerState;
  readonly overlay: TileOverlay;
  /** Second overlay layer (drawn beneath `overlay`) for context such as all tiles marked for removal. */
  readonly marked: TileOverlay;
  readonly rings: RingSet;
  readonly ghost: GhostManager;
  readonly label: ToolLabel;
  /** Current build rotation (shared between build tools; R rotates). */
  readonly rotation: Rotation;
  /** Increments (throttled) whenever the game's revision counters change: include it in preview cache keys. */
  readonly revStamp: number;
  /** Ribbon width for rings at the current zoom. */
  readonly ringWidth: number;
  /** Set the hover tooltip text (throttled & de-duplicated by the host). */
  setHover(text: string | null): void;
  playUi(cue: UiCue): void;
  toast(text: string, severity?: 'info' | 'good' | 'warning' | 'danger'): void;
}

/** A tool's behaviour. All methods are called by InputManager only. */
export interface ToolHandler {
  readonly kind: Tool['kind'];
  activate(): void;
  /** Remove every overlay this tool shows. */
  deactivate(): void;
  /** Per frame; recompute previews only when the pointer tile / rotation / revStamp changed. */
  update(realDt: number): void;
  /** Left button pressed on the canvas (pointer state already updated). */
  pointerDown(): void;
  /** Left button released (pointer state already updated; `pointer.moved` = drag distance). */
  pointerUp(): void;
  /** Abort a drag in progress. Returns true if there was one. */
  cancelDrag(): boolean;
  /** R pressed. */
  rotate(): void;
  /** Force the next update() to recompute its preview. */
  invalidate(): void;
  /** Co-op presence: the placement this tool currently previews (build tool), else null/undefined. */
  presenceGhost?(): PlayerInfo['ghost'];
}
