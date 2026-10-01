/** The services every UI component receives (implemented by UIManager). */
import type { UiCue } from '../audio/audio';
import type { AppContext } from '../core/app';
import type { GameMessage, MessageSeverity } from '../core/types';
import type { Command, CommandResult } from '../net/types';
import type { Game } from '../sim/game';
import type { DataCache } from './data';
import type { PendingValues } from './pending';
import type { TooltipManager } from './tooltip';

export type WindowId = 'professions' | 'overview' | 'citizens' | 'log' | 'stats' | 'trade' | 'nomads' | 'help' | 'players';

export type FocusTarget = NonNullable<GameMessage['target']>;

export interface ToastOptions {
  /** Clicking the toast (or its go-to button) focuses this target. */
  target?: FocusTarget;
  /** Extra action button. */
  action?: { label: string; run: () => void };
  /** Override display time in seconds. */
  duration?: number;
  /** Don't play a sound. */
  silent?: boolean;
  /** CSS colour for the toast's accent edge (e.g. a co-op player's colour for chat lines). */
  accent?: string;
}

export interface DispatchOptions {
  /** Toast the reason when the command is refused (default true). */
  toastFailure?: boolean;
  /** Play the error cue when refused (default true). */
  errorSound?: boolean;
}

export interface ConfirmOptions {
  title?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

export interface UIContext {
  readonly app: AppContext;
  readonly root: HTMLElement;
  readonly game: Game;
  readonly data: DataCache;
  readonly tips: TooltipManager;
  /** Values the player requested in co-op that the shared game has not applied yet (see pending.ts). */
  readonly pending: PendingValues;
  /**
   * Issue a player command through AppContext.dispatch. Refusals are toasted (with the error cue); in co-op an accepted
   * command may still be `pending` — the effect appears when the host applies it.
   */
  dispatch(cmd: Command, opts?: DispatchOptions): CommandResult;
  toast(text: string, severity?: MessageSeverity, opts?: ToastOptions): void;
  confirm(message: string, confirmLabel?: string, opts?: ConfirmOptions): Promise<boolean>;
  sound(cue: UiCue): void;
  /** Move the camera to a message target and select it. */
  goTo(target: FocusTarget, select?: boolean): void;
  selectBuilding(id: number, focus?: boolean): void;
  selectCitizen(id: number, focus?: boolean): void;
  openWindow(id: WindowId): void;
  closeWindow(id: WindowId): void;
  toggleWindow(id: WindowId): void;
  isWindowOpen(id: WindowId): boolean;
}
