/**
 * Application-level contract shared by main.ts, UI, input, renderer and audio. Architect-owned.
 */
import type { AudioManager } from '../audio/audio';
import type { InputManager } from '../input/input';
import type { GameRenderer } from '../render/renderer';
import type { Game } from '../sim/game';
import type { UIManager } from '../ui/ui';
import type { NetSession } from '../net/session';
import type { Command, CommandResult } from '../net/types';
import type { EventBus } from './events';
import type { BuildingType, GameSpeed, NewGameSettings, RemovalFilter } from './types';

export type Tool =
  | { kind: 'select' }
  | { kind: 'build'; type: BuildingType }
  | { kind: 'road'; road: 'dirt' | 'stone' }
  | { kind: 'removeRoad' }
  | { kind: 'clear'; filter: RemovalFilter }
  | { kind: 'unclear' }
  | { kind: 'demolish' };

export type Selection = { kind: 'building'; id: number } | { kind: 'citizen'; id: number } | null;

export interface AppSettings {
  shadows: boolean;
  /** 'auto' = tier from the detected GPU + dynamic resolution. */
  quality: 'auto' | 'low' | 'medium' | 'high';
  /** Frame-rate cap: 30, 60 or 0 = unlimited (display refresh). Idle (menu / paused & still) renders ≤ 30 fps. */
  fpsCap: 0 | 30 | 60;
  masterVolume: number; // 0..1
  sfxVolume: number; // 0..1
  ambientVolume: number; // 0..1
  edgeScroll: boolean;
  autosave: boolean;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  shadows: true,
  quality: 'auto',
  fpsCap: 60,
  masterVolume: 0.7,
  sfxVolume: 0.8,
  ambientVolume: 0.6,
  edgeScroll: false,
  autosave: true,
  showFps: false,
};

/**
 * Stored settings from before the performance pass have no fpsCap; their quality 'high' was the old default, so
 * move those players onto 'auto' (GPU tier + dynamic resolution). Explicit low/medium choices are kept.
 */
export function migrateSettings(saved: Partial<AppSettings>): Partial<AppSettings> {
  const out = { ...saved };
  if (out.fpsCap === undefined && out.quality === 'high') out.quality = 'auto';
  if (out.fpsCap !== undefined && out.fpsCap !== 0 && out.fpsCap !== 30 && out.fpsCap !== 60) out.fpsCap = 60;
  if (out.quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(out.quality)) out.quality = 'auto';
  return out;
}

export interface SaveSlotInfo {
  slot: string;
  townName: string;
  year: number;
  month: number;
  population: number;
  /** Date.now() when saved. */
  savedAt: number;
}

export interface AppEvents {
  gameChanged: { game: Game };
  toolChanged: { tool: Tool };
  selectionChanged: { selection: Selection };
  settingsChanged: { settings: AppSettings };
  speedChanged: { speed: GameSpeed };
  /** Hover info from the input layer for the UI tooltip/status line. */
  hoverInfo: { text: string | null };
}

export interface AppContext {
  /** Current game (replaced on new game / load — listen to `gameChanged`). */
  game: Game;
  readonly renderer: GameRenderer;
  readonly input: InputManager;
  readonly ui: UIManager;
  readonly audio: AudioManager;
  readonly events: EventBus<AppEvents>;
  settings: AppSettings;
  selection: Selection;
  /** True while the main menu (title screen) is open — the simulation is frozen. */
  inMenu: boolean;
  /** Co-op session (always present; mode 'solo' when no room is available). */
  readonly net: NetSession;

  /** THE way UI/input mutate the town (solo: immediate; co-op: routed through the lockstep session). */
  dispatch(cmd: Command): CommandResult;

  newGame(settings: NewGameSettings): void;
  saveGame(slot: string): boolean;
  loadGame(slot: string): boolean;
  listSaves(): SaveSlotInfo[];
  deleteSave(slot: string): void;
  setTool(tool: Tool): void;
  select(sel: Selection): void;
  setSpeed(speed: GameSpeed): void;
  /** Move the camera to look at world position (x, z). */
  focusOn(wx: number, wz: number): void;
  updateSettings(patch: Partial<AppSettings>): void;
  /** Open the main menu (pauses). */
  openMenu(): void;
  /** Close the main menu (resume). */
  closeMenu(): void;
}
