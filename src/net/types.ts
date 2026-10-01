/**
 * CO-OP CONTRACT — architect-owned. Shared by src/net/** (net-core agent) and the app/UI/input/render integration.
 * Additive changes only; document them in your report.
 *
 * Model: deterministic LOCKSTEP. Every peer runs the same simulation with fixed steps of NET_STEP game seconds.
 * The HOST (an admin viewer: artifact owner/editor) owns the clock: it broadcasts TURNS ("advance to tick T, apply
 * these commands at these ticks") on admin-only room event topics. GUESTS never emit events (they may only hold the
 * `view` level); they submit commands through their room PRESENCE object (a bounded queue that the host acks).
 * Late joiners receive a gzip-compressed save snapshot in chunks, then the command log since the snapshot, and
 * fast-forward. Periodic state hashes detect desync; a desynced guest resyncs from a fresh snapshot.
 * Everything must also work with no room at all (solo) — co-op only lights up when a transport connects.
 */
import type {
  BuildingType, CropType, GameSpeed, Inventory, LivestockType, MerchantKind, OrchardType, RemovalFilter, Rotation,
} from '../core/types';
import type { TradeTake } from '../sim/game';

/** Fixed simulation step used by every peer in co-op (game seconds). One tick = one step. */
export const NET_STEP = 0.25;

// ---------------------------------------------------------------------------------------------
// Player commands — every mutation a player can make to the shared town.
// UI & input MUST go through AppContext.dispatch(cmd) instead of calling Game mutators directly.
// ---------------------------------------------------------------------------------------------

export type Command =
  | { op: 'place'; type: BuildingType; x: number; z: number; rot: Rotation; w?: number; h?: number }
  | { op: 'road'; kind: 'dirt' | 'stone'; tiles: number[] }
  | { op: 'removeRoad'; tiles: number[] }
  | { op: 'mark'; x0: number; z0: number; x1: number; z1: number; filter: RemovalFilter }
  | { op: 'unmark'; x0: number; z0: number; x1: number; z1: number }
  | { op: 'demolish'; id: number }
  | { op: 'workers'; id: number; n: number }
  | { op: 'builders'; n: number }
  | { op: 'crop'; id: number; choice: CropType | OrchardType | LivestockType }
  | { op: 'recipe'; id: number; recipe: number }
  | { op: 'pause'; id: number; paused: boolean }
  | { op: 'priority'; id: number; priority: boolean }
  | { op: 'trade'; give: Inventory; take: TradeTake[] }
  | { op: 'requestMerchant'; kind: MerchantKind | null }
  | { op: 'nomads'; accept: boolean }
  /** Shared game speed (0 = paused). In co-op any player may change it; the host applies it at a turn. */
  | { op: 'speed'; speed: GameSpeed };

export type CommandOp = Command['op'];

export interface CommandResult {
  /** Solo: the real outcome. Co-op: the local pre-validation outcome (false = rejected before sending). */
  ok: boolean;
  /** Human-readable reason when !ok (toast it). */
  reason?: string;
  /** Co-op: accepted locally and queued; the real effect happens when the host's turn applies it. */
  pending?: boolean;
  /** Solo 'place': the created building id (co-op: unknown until applied — undefined). */
  buildingId?: number;
  /** Solo 'road'/'removeRoad'/'mark'/'unmark': how many tiles were affected. */
  count?: number;
}

// ---------------------------------------------------------------------------------------------
// Session / players (read by UI & render)
// ---------------------------------------------------------------------------------------------

export type NetMode =
  /** No room available (public link, local dev without ?net=local, signed out): plain single player. */
  | 'solo'
  /** Room connected; this peer runs the shared town and broadcasts turns. */
  | 'host'
  /** Room connected; following the host's town. */
  | 'guest'
  /** Room connected but no host is running a shared town right now (guest may play solo meanwhile). */
  | 'lobby'
  /** Joining: receiving snapshot / catching up. */
  | 'joining';

export interface NetStatus {
  mode: NetMode;
  /** Transport connected right now. */
  connected: boolean;
  /** Can this viewer host (admin level: owner/editor)? */
  canHost: boolean;
  /** 0..1 progress while joining (snapshot download + catch-up). */
  joinProgress: number;
  /** Ticks this peer is behind the newest tick it knows the host reached (guests). */
  ticksBehind: number;
  /** Number of desyncs detected & repaired this session. */
  resyncs: number;
  /** Commands queued locally and not yet acknowledged by the host. */
  pendingCommands: number;
  /** Short human-readable status line for the UI ("Hosting Hollowmere · 3 players"). */
  label: string;
}

export interface PlayerInfo {
  /** Transport peer label (one per open tab). */
  peer: string;
  /** Display name (resolved via the user capability, else a nickname, else "Settler N"). */
  name: string;
  /** CSS colour assigned to the player (cursor, ghost, list swatch). */
  color: string;
  isMe: boolean;
  isHost: boolean;
  guest: boolean;
  /** Last known world cursor (tile coords, continuous) or null. */
  cursor: [number, number] | null;
  /** Camera focus point & distance, or null. */
  camera: { x: number; z: number; yaw: number; dist: number } | null;
  /** What they are about to place (render a tinted ghost), or null. */
  ghost: { type: BuildingType; x: number; z: number; rot: Rotation; w: number; h: number; valid: boolean } | null;
  /** Current tool label, e.g. "Building: Wooden House", "Clearing trees", "Selecting". */
  tool: string;
  /** Milliseconds since their presence last changed (dim idle players). */
  idleMs: number;
}

/** What the local app publishes about itself each frame (the session throttles & packs it into presence). */
export interface LocalPresence {
  cursor: [number, number] | null;
  camera: { x: number; z: number; yaw: number; dist: number } | null;
  ghost: PlayerInfo['ghost'];
  tool: string;
}

export interface ChatLine {
  peer: string;
  name: string;
  color: string;
  text: string;
  /** Local receive time (Date.now()). */
  at: number;
}

export interface NetEvents {
  status: NetStatus;
  players: PlayerInfo[];
  /** A command this peer issued was rejected when the host applied it (e.g. placement no longer valid). */
  rejected: { cmd: Command; reason: string };
  chat: ChatLine;
  /** The shared town was replaced (host started/loaded a game, or this guest joined/resynced): the app must swap
   *  its Game to `session.game` (renderer.setGame etc.). */
  gameReplaced: Record<string, never>;
}
