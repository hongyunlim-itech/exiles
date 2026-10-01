/**
 * Transport abstraction over the Claude artifact `room` capability (see vendor/claude-artifact-types/0.2.54/room.d.ts).
 * CONTRACT — architect-owned signatures; implementations are owned by the net-core agent.
 *
 * Semantics mirror `room`: presence = one small JSON object per peer (≤ 4 KiB), latest-wins, shared ~30 Hz, handed to
 * newcomers, cleared on leave. Events = moments on topics (≤ 4 KiB each), may be DROPPED, never replayed, only admins
 * may emit (guests cannot). Everyone receives everything, including their own emits (isMe && sameTab).
 */
import { connectClaudeRoom } from './transport-claude';
import { LocalTransport } from './transport-local';
import { RelayTransport, relayBase, roomCodeFromParam } from './transport-relay';

export interface TransportPeer {
  peer: string;
  /** Durable user id when available (user capability), else null. */
  by: string | null;
  isMe: boolean;
  sameTab: boolean;
  guest: boolean;
  presence: Readonly<Record<string, unknown>>;
  /** Local ms timestamp of the peer's last presence change. */
  updatedAt: number;
}

export interface TransportMessage {
  topic: string;
  data: unknown;
  peer: string;
  isMe: boolean;
  sameTab: boolean;
}

export interface Transport {
  /** 'claude' (artifact room), 'local' (BroadcastChannel between tabs of one browser, dev), 'memory' (tests),
   *  'relay' (public room on the Exiles relay: Cloudflare Worker + Durable Object, `?room=<code>`). */
  readonly kind: 'claude' | 'local' | 'memory' | 'relay';
  /** This tab's peer label (known once connected; '' before). */
  selfPeer(): string;
  connected(): boolean;
  /** Admin level (may emit events / host). */
  canEmit(): Promise<boolean>;
  /** Display name for a peer's durable id (user capability), '' if unknown. */
  displayName(peer: TransportPeer): Promise<string>;
  /** Merge a patch into this tab's presence (top-level null deletes a field). Rejects on > 4 KiB. */
  setPresence(patch: Record<string, unknown>): Promise<void>;
  peers(): readonly TransportPeer[];
  onPeers(fn: (peers: readonly TransportPeer[]) => void): () => void;
  /** Broadcast a moment (≤ 4 KiB JSON). Resolves on hand-off; delivery NOT guaranteed. */
  emit(topic: string, data: unknown): Promise<void>;
  on(topic: string, fn: (msg: TransportMessage) => void): () => void;
  onConnection(fn: (connected: boolean) => void): () => void;
  dispose(): void;

  // ---- optional (relay rooms; additive) -------------------------------------------------------
  /** The relay decides who holds the host seat (the only admin): fires with whether THIS tab holds it, on every
   *  change (the first hello included). Not fired on a mere disconnect — the seat is kept through reconnects. */
  onAdminChange?(fn: (admin: boolean) => void): () => void;
  /** Peer label of the current host seat ('' while unknown). Present ⇒ exactly one admin (use it instead of the
   *  peers' presence `ad` flags). */
  adminPeer?(): string;
  /** Host seat only: remove a peer from the room (the relay closes it and bans its client id for the room's life). */
  kick?(peer: string): void;
  /** Link others can open to join this room (relay: https://<host>/?room=<code>), else null. */
  inviteUrl?(): string | null;
  /** Why the transport stopped for good ('kicked' | 'room_full' | 'bad_request'), null while it is (re)connecting. */
  closeReason?(): string | null;
}

/** Max UTF-8 bytes of JSON per event / presence object (platform limit is 4096; keep headroom). */
export const MAX_PAYLOAD_BYTES = 3800;

/**
 * Resolve the best transport for this page (first match wins):
 *  - `?net=off` → null (solo)
 *  - `?net=local` → BroadcastChannel transport (two tabs of the same browser can play together; dev/testing)
 *  - `?room=<code>` → public relay room (`wss://<page host>/api/room/<code>`; `&relay=ws://localhost:8787` points a
 *    `vite` dev page at `wrangler dev`). Returned at once; it connects (and reconnects) in the background. An invalid
 *    code → null. Ignored inside a Claude artifact (`window.claude`: the platform blocks outside connections there).
 *  - else `window.claude.use('room')` resolves → Claude room transport
 *  - else null (solo).
 * Must never throw; must resolve within ~11 s even if the host frame never answers.
 */
export async function connectTransport(): Promise<Transport | null> {
  try {
    if (typeof window === 'undefined') return null;
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(window.location?.search ?? '');
    } catch {
      params = new URLSearchParams();
    }
    const net = params.get('net');
    if (net === 'off') return null;
    if (net === 'local') {
      if (typeof BroadcastChannel === 'undefined') return null;
      const drop = Number.parseFloat(params.get('drop') ?? '0');
      return new LocalTransport({ admin: params.get('role') !== 'guest', drop: Number.isFinite(drop) ? drop : 0 });
    }
    const roomParam = params.get('room');
    const inClaude = typeof (globalThis as { claude?: unknown }).claude !== 'undefined';
    if (roomParam !== null && !inClaude) {
      const room = roomCodeFromParam(roomParam);
      if (!room) {
        console.warn('[net] invalid room code (3–32 of a-z, 0-9, -):', roomParam);
        return null;
      }
      if (typeof WebSocket === 'undefined') return null;
      let page: string | null = null;
      try {
        page = window.location?.href ?? null;
      } catch {
        page = null;
      }
      const relayParam = params.get('relay');
      const base = relayBase(page, relayParam);
      if (!base) return null;
      // invite links carry the development relay override only when it is in use
      const carried = relayParam && base !== relayBase(page, null) ? relayParam : null;
      return new RelayTransport({ room, base, relayParam: carried, pageUrl: page });
    }
    return await connectClaudeRoom(11_000);
  } catch (err) {
    console.warn('[net] no transport', err);
    return null;
  }
}
