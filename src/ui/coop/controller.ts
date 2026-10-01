/**
 * Co-op UI glue: binds the NetSession's events (status, players, rejected commands, chat) to toasts, keeps the chat
 * history for the Players window, drives the net banner (joining progress, waiting for the host, reconnecting) and the
 * chat bar (Enter opens it while co-op is active; Esc closes it). Everything reads `app.net` lazily, so the session
 * may be replaced at any time (solo → room upgrade); UIManager calls `bind()` again then.
 */
import type { NetSession } from '../../net/session';
import type { Transport } from '../../net/transport';
import type { ChatLine, NetStatus, PlayerInfo } from '../../net/types';
import type { UIContext } from '../context';
import { h, setClass, setFrac, setStyle, setText, show } from '../dom';
import { pendingKeyFor, rejectionText } from './describe';
import {
  buildInviteUrl, closeReasonInfo, generateRoomCode, hasRoomParam, joinHint, lowerFirst, NICK_KEY, normalizeRoomCode, probeRelay,
  readRoomParam, relayHealthUrl, sanitizeNickname, shouldProbeRelay, withRoom, type CloseInfo, type FetchLike, type RoomKind,
} from './rooms';

/** Chat lines kept for the Players window. */
const CHAT_HISTORY = 60;
/** Max characters per chat message. */
export const CHAT_MAX_CHARS = 160;
/** Seconds without game-time progress (while running) before a guest is told it is waiting for the host. */
const WAIT_HOST_AFTER = 2.5;
/** Ticks behind the host before the banner says "catching up". */
const CATCHUP_TICKS = 24;
/** Grace period after the room connects before offering to share a town that is already running (seconds). */
const SHARE_OFFER_DELAY = 3;

const SOLO_STATUS: NetStatus = {
  mode: 'solo', connected: false, canHost: false, joinProgress: 0, ticksBehind: 0, resyncs: 0, pendingCommands: 0, label: 'Single player',
};

export type HostedTown = { hostName: string; townName: string; year: number; population: number };

/** Optional members of a relay transport / session that this UI reads when present (duck-typed, never required). */
interface CloseReasonSource {
  closeReason?: () => string | null | undefined;
}

/** The page's location, or null (tests / unusual hosts). */
function pageLocation(): { href: string; search: string; protocol: string } | null {
  try {
    const l = typeof window !== 'undefined' ? window.location : null;
    return l ? { href: l.href, search: l.search, protocol: l.protocol } : null;
  } catch {
    return null;
  }
}

/** Running inside a Claude artifact (the platform injects `window.claude`)? */
function inClaudeArtifact(): boolean {
  try {
    return typeof (globalThis as { claude?: unknown }).claude !== 'undefined';
  } catch {
    return false;
  }
}

function readStoredNick(): string {
  try {
    return sanitizeNickname(localStorage.getItem(NICK_KEY) ?? '');
  } catch {
    return '';
  }
}

function storeNick(nick: string): void {
  try {
    localStorage.setItem(NICK_KEY, nick);
  } catch {
    /* private mode / quota: the name still applies for this visit */
  }
}

export class CoopController {
  /** Newest last. */
  readonly chat: ChatLine[] = [];
  /** Bumped whenever `chat` changes (cheap change detection for views). */
  chatVersion = 0;
  readonly bannerEl: HTMLElement;
  readonly chatEl: HTMLElement;

  private status: NetStatus = SOLO_STATUS;
  private offs: (() => void)[] = [];
  private knownPeers = new Map<string, string>();
  private playersPrimed = false;
  private leavingOnPurpose = false;
  private lastResyncs = 0;
  private lastElapsed = -1;
  private stalledFor = 0;
  /** Guest whose host is gone and nobody took over (the session's waitingForHost). */
  private hostGone = false;
  private disconnectedFor = 0;
  private connectedFor = 0;
  private shareOffered = false;
  private logged = new Set<string>();

  // ---- public online rooms (relay) ----
  /** Room code of this page (`?room=<code>`, public relay rooms) — never set inside a Claude artifact. */
  readonly roomCode: string | null;
  /** A `?room=` parameter is present but is not a valid code. */
  private readonly badRoomParam: boolean;
  /** connectTransport(): still resolving, resolved with a room, or resolved without one. */
  private connectPhase: 'pending' | 'connected' | 'none' = 'pending';
  /** Relay reachable from this page (main menu "Play online"): null while probing / not probed. */
  private relayOnline: boolean | null = null;
  /** The attached room transport (read-only use: kind, close reason, who holds the host seat). */
  private transport: Transport | null = null;
  /** The terminal close state was announced (toast) already. */
  private closeAnnounced = false;
  /** Seconds the relay room has been unreachable (the transport keeps retrying; there is no terminal state for that). */
  private roomDownFor = 0;

  // banner
  private bannerText: HTMLElement;
  private bannerBar: HTMLElement;
  private bannerFill: HTMLElement;
  // chat bar
  private chatInput: HTMLInputElement;
  private chatFeed: HTMLElement;
  private chatFeedVersion = -1;

  constructor(private readonly ui: UIContext) {
    this.bannerText = h('span', { class: 'nb-text' });
    this.bannerFill = h('div', { class: 'nb-fill' });
    this.bannerBar = h('div', { class: 'nb-bar', 'aria-hidden': 'true' }, this.bannerFill);
    this.bannerEl = h('div', { class: 'net-banner', role: 'status', 'aria-live': 'polite' },
      h('span', { class: 'nb-spin', 'aria-hidden': 'true' }), this.bannerText, this.bannerBar);
    this.bannerEl.hidden = true;

    this.chatInput = h('input', {
      class: 'chat-input', type: 'text', maxlength: String(CHAT_MAX_CHARS), placeholder: 'Say something to the other players…',
      'aria-label': 'Chat message', autocomplete: 'off', spellcheck: 'false',
      onkeydown: (e: KeyboardEvent) => this.onChatKey(e),
      onblur: () => {
        // clicking back into the world closes an empty chat bar
        window.setTimeout(() => {
          if (!this.chatEl.hidden && document.activeElement !== this.chatInput && !this.chatInput.value.trim()) this.closeChat();
        }, 0);
      },
    });
    this.chatFeed = h('div', { class: 'chat-feed', 'aria-live': 'polite' });
    this.chatEl = h('div', { class: 'chat-bar' },
      this.chatFeed,
      h('div', { class: 'chat-row' },
        h('span', { class: 'chat-i', 'aria-hidden': 'true' }, '💬'),
        this.chatInput,
        h('span', { class: 'chat-hint', 'aria-hidden': 'true' }, 'Enter ↵ send · Esc close')));
    this.chatEl.hidden = true;

    const loc = pageLocation();
    const inClaude = inClaudeArtifact();
    this.roomCode = !inClaude && loc ? readRoomParam(loc.search) : null;
    this.badRoomParam = !inClaude && !!loc && hasRoomParam(loc.search) && !this.roomCode;
    if (loc && shouldProbeRelay({ inClaude, search: loc.search, protocol: loc.protocol })) void this.probeRelay(loc.search);
    else this.relayOnline = false;
  }

  // =============================================================================================
  // session binding
  // =============================================================================================

  private get net(): NetSession | null {
    try {
      return this.ui.app.net ?? null;
    } catch {
      return null;
    }
  }

  /** (Re)subscribe to the current session's events. */
  bind(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.knownPeers.clear();
    this.playersPrimed = false;
    this.shareOffered = false;
    this.connectedFor = 0;
    const net = this.net;
    if (!net) return;
    try {
      const ev = net.events;
      this.offs.push(
        ev.on('status', (s) => this.onStatus(s)),
        ev.on('players', (p) => this.onPlayers(p)),
        ev.on('rejected', ({ cmd, reason }) => {
          const key = pendingKeyFor(cmd);
          if (key) this.ui.pending.delete(key);
          this.ui.toast(rejectionText(cmd, reason), 'warning');
        }),
        ev.on('chat', (line) => this.onChat(line)),
      );
    } catch (err) {
      this.warnOnce('bind', err);
    }
    this.status = this.readStatus();
    this.lastResyncs = this.status.resyncs;
    // public rooms have no profiles: the player's remembered name travels as the presence nickname (not applied in
    // local dev rooms, whose tabs share one localStorage and would all get the same name)
    if (this.isRelayRoom) {
      const nick = readStoredNick();
      if (nick) this.applyNickname(nick);
    }
  }

  /** main.ts attached a room transport to the session (or null: none — solo). */
  attachRoom(transport: Transport | null): void {
    this.transport = transport;
    this.connectPhase = transport ? 'connected' : 'none';
    this.closeAnnounced = false;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Latest known status (polled at the UI tick and updated from events). */
  get current(): NetStatus {
    return this.status;
  }

  /** Is a shared session active (hosting, following a host, or joining)? */
  get inCoop(): boolean {
    const m = this.status.mode;
    return m === 'host' || m === 'guest' || m === 'joining';
  }

  /** Can this peer chat right now? */
  get chatAvailable(): boolean {
    return this.status.connected && this.status.mode !== 'solo';
  }

  readStatus(): NetStatus {
    const net = this.net;
    if (!net) return SOLO_STATUS;
    try {
      return net.status();
    } catch (err) {
      this.warnOnce('status', err);
      return SOLO_STATUS;
    }
  }

  players(): PlayerInfo[] {
    const net = this.net;
    if (!net) return [];
    try {
      return net.players();
    } catch (err) {
      this.warnOnce('players', err);
      return [];
    }
  }

  hostedTown(): HostedTown | null {
    const net = this.net;
    if (!net) return null;
    try {
      return net.hostedTown();
    } catch (err) {
      this.warnOnce('hostedTown', err);
      return null;
    }
  }

  // =============================================================================================
  // public online rooms (relay): state reads
  // =============================================================================================

  /** Kind of the attached room (null = solo / still connecting). */
  roomKind(): RoomKind | null {
    const net = this.net;
    if (net) {
      try {
        const k = net.transportKind();
        if (k) return k;
      } catch (err) {
        this.warnOnce('transportKind', err);
      }
    }
    return this.transport?.kind ?? null;
  }

  /** In a public relay room (invite links, nicknames, host seat, kicking)? */
  get isRelayRoom(): boolean {
    return this.roomKind() === 'relay';
  }

  /** Can the player pick their own name here (relay rooms; local dev rooms have no profiles either)? */
  get nicknameEditable(): boolean {
    const k = this.roomKind();
    return k === 'relay' || k === 'local';
  }

  /** "Play online" (host / join with code) is offered: the relay answers and this page is not in a room. */
  get onlineAvailable(): boolean {
    return this.relayOnline === true && !this.roomCode && !this.transport;
  }

  /** The page was opened with a room link and the room transport is still being resolved. */
  get connectingToRoom(): boolean {
    return (!!this.roomCode || this.badRoomParam) && this.connectPhase === 'pending';
  }

  /** A relay room link whose relay has not answered for a while (still retrying in the background). */
  get roomUnreachable(): boolean {
    return this.roomDownFor > 8;
  }

  /** "Anyone with the invite link can join." etc. — who can join a town hosted in this room. */
  joinHint(): string {
    return joinHint(this.roomKind());
  }

  /** Link that brings friends into this room (relay rooms), else null. */
  inviteLink(): string | null {
    if (!this.isRelayRoom) return null;
    try {
      const link = this.net?.inviteLink();
      if (link) return link;
    } catch (err) {
      this.warnOnce('inviteLink', err);
    }
    const loc = pageLocation();
    return loc && this.roomCode ? buildInviteUrl(loc.href, this.roomCode) : null;
  }

  /** May this player remove others (relay room + this player holds the host seat)? */
  canKick(): boolean {
    if (!this.isRelayRoom) return false;
    try {
      return this.net?.canKick() === true;
    } catch (err) {
      this.warnOnce('canKick', err);
      return false;
    }
  }

  /**
   * Peers holding the host seat of a relay room (exactly one: the relay makes its oldest player the admin). Read from
   * the relay itself (`transport.adminPeer()`) — presence is written by the players, so its admin flag (`ad`, §9.3) is
   * only a fallback. Empty outside relay rooms.
   */
  hostSeatPeers(): ReadonlySet<string> {
    const out = new Set<string>();
    const t = this.transport;
    if (!t || !this.isRelayRoom) return out;
    try {
      if (typeof t.adminPeer === 'function') {
        const seat = t.adminPeer();
        if (seat) out.add(seat);
        return out;
      }
      for (const p of t.peers()) {
        if (p.sameTab ? this.status.canHost : (p.presence as { ad?: unknown }).ad === 1) out.add(p.peer);
      }
    } catch (err) {
      this.warnOnce('hostSeat', err);
    }
    return out;
  }

  /**
   * The connection to the room closed for good (kicked, room full, invalid code, relay unreachable…) → what to tell the
   * player, else null. Reads `closeReason()` of the session or transport when they provide it.
   */
  closeInfo(): CloseInfo | null {
    for (const src of [this.net, this.transport] as (CloseReasonSource | null)[]) {
      if (!src || typeof src.closeReason !== 'function') continue;
      try {
        const info = closeReasonInfo(src.closeReason());
        if (info) return info;
      } catch (err) {
        this.warnOnce('closeReason', err);
      }
    }
    if (this.connectPhase === 'none' && this.badRoomParam) return closeReasonInfo('bad_room');
    if (this.connectPhase === 'none' && this.roomCode) return closeReasonInfo('unreachable');
    return null;
  }

  /** The player's name in a public room: the one the session uses (default "Settler NN"), else the remembered one. */
  nickname(): string {
    try {
      const n = this.net?.getNickname();
      if (n) return n;
    } catch (err) {
      this.warnOnce('getNickname', err);
    }
    return readStoredNick() || (this.players().find((p) => p.isMe)?.name ?? '');
  }

  /** Set (and remember) the player's name. An empty name changes nothing. Returns the name now in use. */
  setNickname(raw: string): string {
    const nick = sanitizeNickname(raw);
    if (!nick) return this.nickname();
    storeNick(nick);
    this.applyNickname(nick);
    return nick;
  }

  private applyNickname(nick: string): void {
    try {
      this.net?.setNickname(nick);
    } catch (err) {
      this.warnOnce('setNickname', err);
    }
  }

  private async probeRelay(search: string): Promise<void> {
    const f: FetchLike | null = typeof fetch === 'function' ? (url, init) => fetch(url, init) : null;
    let href: string | null = null;
    try {
      href = window.location.href;
    } catch {
      href = null;
    }
    const ok = await probeRelay(relayHealthUrl(search, href), f);
    this.relayOnline = ok;
  }

  // =============================================================================================
  // public online rooms: actions
  // =============================================================================================

  /**
   * Main menu "Host an online game": reload into a fresh room (`?room=<new code>`, other parameters kept). The first
   * player in a room holds its host seat and hosts the town they start or continue. From a running game the town is
   * saved first (autosave slot) so "Continue" picks it up in the room.
   */
  async hostOnline(inGame: boolean): Promise<void> {
    if (inGame) {
      const ok = await this.ui.confirm(
        'Host your town online? The page reloads into a new online room — your town is saved first, so press Continue there to host it. Anyone with the invite link can join.',
        'Host online', { title: 'Host an online game' });
      if (!ok) return;
      if (!this.ui.app.saveGame('autosave')) return;
    }
    this.navigate(generateRoomCode());
  }

  /** Main menu "Join with code": validate and reload into that room. Returns an error text for an invalid code. */
  async joinOnline(input: string, inGame: boolean): Promise<string | null> {
    const code = normalizeRoomCode(input);
    if (!code) return 'Room codes are 3–32 letters, digits or dashes (or paste the invite link).';
    if (inGame) {
      const ok = await this.ui.confirm(
        `Join the online room “${code}”? The page reloads — save your town first if you want to keep it.`,
        'Join room', { title: 'Join an online game' });
      if (!ok) return null;
    }
    this.navigate(code);
    return null;
  }

  /** Leave the room for good: reload this page without `?room=` (single player; "Play online" is offered again). */
  async playSolo(confirmFirst: boolean): Promise<void> {
    if (confirmFirst) {
      const ok = await this.ui.confirm(
        'Leave this online room and play on your own? The page reloads — save your town first if you want to keep it.',
        'Leave room', { title: 'Play solo', danger: true });
      if (!ok) return;
    }
    this.navigate(null);
  }

  /** Try the room link again (after a full room or a failed connection). */
  retryRoom(): void {
    try {
      window.location.reload();
    } catch (err) {
      console.error('[ui] reload failed', err);
    }
  }

  /** Remove a player from the relay room (host seat only): confirm, then kick (the relay also bans their id). */
  async kick(peer: string, name: string): Promise<void> {
    if (!this.canKick()) return;
    const ok = await this.ui.confirm(
      `Remove ${name} from this room? They are disconnected and cannot come back while the room stays open.`,
      'Remove', { title: 'Remove player', danger: true });
    if (!ok || !this.canKick()) return;
    try {
      this.net?.kick(peer);
      this.ui.toast(`${name} was removed from the room.`, 'info', { silent: true, duration: 4 });
    } catch (err) {
      console.error('[ui] kick failed', err);
      this.ui.toast('Could not remove that player.', 'warning');
    }
  }

  private navigate(code: string | null): void {
    const loc = pageLocation();
    if (!loc) return;
    try {
      this.ui.sound('click');
      window.location.assign(withRoom(loc.href, code));
    } catch (err) {
      console.error('[ui] navigation failed', err);
      this.ui.toast('Could not open the online room.', 'danger');
    }
  }

  // =============================================================================================
  // actions (Players window, main menu, toasts)
  // =============================================================================================

  /** Guest: join the town hosted in the room. From a running solo game the player confirms first. */
  async join(confirmFirst: boolean): Promise<void> {
    const town = this.hostedTown();
    if (!town) {
      this.ui.toast('Nobody is hosting a town right now.', 'info');
      return;
    }
    if (confirmFirst) {
      const ok = await this.ui.confirm(
        `Join ${town.hostName}'s town “${town.townName}”? Your current game will be replaced — save it first if you want to keep it.`,
        'Join town', { title: 'Join shared town' });
      if (!ok) return;
    }
    try {
      this.net?.join();
      this.ui.sound('click');
    } catch (err) {
      console.error('[ui] join failed', err);
      this.ui.toast('Could not join the shared town.', 'danger');
    }
  }

  /** Guest: leave the shared town (keep playing a solo copy). Host: stop sharing. */
  async leave(confirmFirst: boolean): Promise<void> {
    const mode = this.status.mode;
    if (confirmFirst && mode !== 'joining') {
      const msg = mode === 'host'
        ? 'Stop sharing your town? Other players will be disconnected from it; you keep playing on your own.'
        : 'Leave the shared town? You keep playing your own copy of it as a single-player game.';
      const ok = await this.ui.confirm(msg, mode === 'host' ? 'Stop sharing' : 'Leave town', { title: mode === 'host' ? 'Stop sharing' : 'Leave shared town', danger: true });
      if (!ok) return;
    }
    this.leavingOnPurpose = true;
    // a host who just stopped sharing does not want to be asked to share again
    if (mode === 'host') this.shareOffered = true;
    try {
      this.net?.leave();
      this.ui.sound('close');
    } catch (err) {
      console.error('[ui] leave failed', err);
    }
  }

  /** Admin in a solo/lobby game: start sharing the running town. */
  shareCurrentTown(): void {
    const st = this.readStatus();
    if (!st.connected || !st.canHost) {
      this.ui.toast(this.isRelayRoom ? 'Only the player holding the host seat can host the town.' : 'Only the owner or an editor of this page can host a shared town.', 'info');
      return;
    }
    if (this.hostedTown()) {
      this.ui.toast('Someone is already hosting a town here — join it from the Players window.', 'info');
      return;
    }
    try {
      this.net?.hostGame(this.ui.app.game);
      this.ui.sound('notify');
    } catch (err) {
      console.error('[ui] hostGame failed', err);
      this.ui.toast('Could not share the town.', 'danger');
    }
  }

  sendChat(text: string): boolean {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_CHARS);
    if (!t) return false;
    try {
      this.net?.sendChat(t);
      return true;
    } catch (err) {
      console.error('[ui] sendChat failed', err);
      this.ui.toast('Message could not be sent.', 'warning');
      return false;
    }
  }

  // =============================================================================================
  // chat bar
  // =============================================================================================

  get chatOpen(): boolean {
    return !this.chatEl.hidden;
  }

  openChat(): void {
    if (!this.chatAvailable) return;
    this.chatEl.hidden = false;
    this.renderFeed(true);
    this.chatInput.focus();
  }

  closeChat(): void {
    if (this.chatEl.hidden) return;
    this.chatEl.hidden = true;
    this.chatInput.value = '';
    if (document.activeElement === this.chatInput) this.chatInput.blur();
  }

  private onChatKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const text = this.chatInput.value;
      if (text.trim() && this.sendChat(text)) this.ui.sound('click');
      this.closeChat();
    }
    // Esc is handled by UIManager (capture phase) so it never reaches the game's hotkeys
  }

  private renderFeed(force = false): void {
    if (!force && this.chatFeedVersion === this.chatVersion) return;
    this.chatFeedVersion = this.chatVersion;
    const lines = this.chat.slice(-5);
    this.chatFeed.replaceChildren(...lines.map((l) => chatLineEl(l)));
    show(this.chatFeed, lines.length > 0);
  }

  // =============================================================================================
  // events
  // =============================================================================================

  private onStatus(next: NetStatus): void {
    const prev = this.status;
    this.status = next;
    if (prev.mode === next.mode) return;
    const town = next.mode === 'guest' ? this.hostedTown() : null;
    if (this.closeInfo()) {
      // the room closed for good (kicked, full…): announceClose() tells the player — no "host closed the town" toasts
    } else if (next.mode === 'guest' && prev.mode === 'joining') {
      this.ui.toast(town ? `You joined ${town.hostName}'s town “${town.townName}”. Press Enter to chat, J for players.` : 'You joined the shared town. Press Enter to chat, J for players.', 'good');
    } else if (next.mode === 'joining' && prev.mode === 'host' && this.isRelayRoom) {
      // back after the relay's reconnect grace: another player holds the host seat now and hosts our town
      this.ui.toast('Another player took over hosting while you were disconnected — following their town.', 'warning');
    } else if (next.mode === 'host' && prev.mode === 'guest') {
      this.ui.toast('The host left — you are hosting the town now. Players: J · Chat: Enter.', 'good');
    } else if (next.mode === 'host' && prev.mode !== 'host') {
      const invite = this.inviteLink();
      this.ui.toast(`Your town is shared — ${lowerFirst(this.joinHint())} Players: J · Chat: Enter.`, 'good',
        invite ? { duration: 12, action: { label: 'Copy invite link', run: () => this.copyInvite() } } : undefined);
    } else if (prev.mode === 'guest' && (next.mode === 'lobby' || next.mode === 'solo')) {
      if (this.leavingOnPurpose) this.ui.toast('You left the shared town. You keep playing your own copy.', 'info');
      else this.ui.toast('The host closed the shared town. You keep playing your own copy of it.', 'warning');
    } else if (prev.mode === 'joining' && (next.mode === 'lobby' || next.mode === 'solo')) {
      if (!this.leavingOnPurpose) this.ui.toast('Joining the shared town failed.', 'warning');
    } else if (prev.mode === 'host' && next.mode !== 'host') {
      this.ui.toast(this.leavingOnPurpose ? 'You stopped sharing your town.' : 'Your town is no longer shared.', 'info');
    }
    this.leavingOnPurpose = false;
    if (next.mode !== 'host' && next.mode !== 'guest') {
      this.knownPeers.clear();
      this.playersPrimed = false;
    }
  }

  private onPlayers(list: PlayerInfo[]): void {
    const coop = this.inCoop;
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.peer);
      if (!this.knownPeers.has(p.peer) && this.playersPrimed && coop && !p.isMe) {
        this.ui.toast(`${p.name} joined${p.isHost ? ' (host)' : ''}.`, 'info', { silent: true, accent: p.color, duration: 4 });
      }
      this.knownPeers.set(p.peer, p.name);
    }
    for (const [peer, name] of this.knownPeers) {
      if (seen.has(peer)) continue;
      this.knownPeers.delete(peer);
      if (coop && this.playersPrimed) this.ui.toast(`${name} left.`, 'info', { silent: true, duration: 4 });
    }
    this.playersPrimed = true;
  }

  private onChat(line: ChatLine): void {
    this.chat.push(line);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.chatVersion++;
    const me = this.players().find((p) => p.isMe);
    if (me && me.peer === line.peer) return;
    this.ui.toast(`${line.name}: ${line.text}`, 'info', { silent: true, accent: line.color, duration: 8 });
    this.ui.sound('click');
  }

  // =============================================================================================
  // per UI tick (~4 Hz)
  // =============================================================================================

  tick(dt: number): void {
    const st = this.readStatus();
    // events may not cover every field change — polling keeps the view honest
    if (st.mode !== this.status.mode) this.onStatus(st);
    else this.status = st;

    if (st.resyncs > this.lastResyncs) {
      this.ui.toast('Your view drifted out of sync with the host and was repaired.', 'info', { silent: true, duration: 4 });
    }
    this.lastResyncs = st.resyncs;

    // guest: detect a stalled shared clock (host paused tab, host gone quiet)
    const game = this.ui.game;
    const elapsed = game.state.time.elapsed;
    let speed = 1;
    try {
      speed = this.ui.app.net.speed();
      // the session knows when its host is gone (speed() then reads 0, which would hide the stall)
      this.hostGone = this.ui.app.net.waitingForHost === true;
    } catch {
      speed = game.speed;
      this.hostGone = false;
    }
    if (st.mode === 'guest' && speed > 0 && !game.state.gameOver && elapsed === this.lastElapsed) this.stalledFor += dt;
    else this.stalledFor = 0;
    this.lastElapsed = elapsed;

    if ((st.mode === 'host' || st.mode === 'guest' || st.mode === 'joining') && !st.connected) this.disconnectedFor += dt;
    else this.disconnectedFor = 0;
    if (this.isRelayRoom && !st.connected && !this.closeInfo()) this.roomDownFor += dt;
    else this.roomDownFor = 0;

    this.announceClose(st);
    this.updateBanner(st);
    if (!this.chatEl.hidden) {
      if (!this.chatAvailable) this.closeChat();
      else this.renderFeed();
    }
    this.maybeOfferShare(st, dt);
  }

  /** The room closed for good (kicked, full, unreachable…): tell the player once, offer single player. */
  private announceClose(st: NetStatus): void {
    const info = this.closeInfo();
    if (!info) {
      this.closeAnnounced = false;
      return;
    }
    if (this.closeAnnounced) return;
    this.closeAnnounced = true;
    this.closeChat();
    // at boot (menu open, no town shared) the menu's co-op box says it — no toast needed
    if (this.ui.app.inMenu && st.mode !== 'host' && st.mode !== 'guest' && st.mode !== 'joining') return;
    this.ui.toast(info.text, 'danger', { duration: 20, action: { label: 'Play solo', run: () => void this.playSolo(false) } });
  }

  private updateBanner(st: NetStatus): void {
    let text = '';
    let progress = -1;
    let tone = 'info';
    const closed = (st.mode === 'host' || st.mode === 'guest' || st.mode === 'joining') ? this.closeInfo() : null;
    if (closed) {
      text = `${closed.text} Press Esc for the menu.`;
      tone = 'warn';
    } else if (st.mode === 'joining') {
      const town = this.hostedTown();
      text = town ? `Joining ${town.hostName}'s town “${town.townName}”…` : 'Joining the shared town…';
      progress = Math.max(0, Math.min(1, st.joinProgress || 0));
    } else if (this.disconnectedFor > 2) {
      text = 'Connection lost — reconnecting…';
      tone = 'warn';
    } else if (st.mode === 'guest' && (this.hostGone || this.stalledFor > WAIT_HOST_AFTER)) {
      text = 'Waiting for the host…';
      tone = 'warn';
    } else if (st.mode === 'guest' && st.ticksBehind > CATCHUP_TICKS) {
      text = `Catching up with the host… (${st.ticksBehind} steps behind)`;
    }
    show(this.bannerEl, !!text);
    if (!text) return;
    setText(this.bannerText, progress >= 0 ? `${text} ${Math.round(progress * 100)}%` : text);
    show(this.bannerBar, progress >= 0);
    if (progress >= 0) setFrac(this.bannerFill, progress);
    setClass(this.bannerEl, 'warn', tone === 'warn');
    setClass(this.bannerEl, 'final', !!closed);
  }

  /** An admin already playing when the room connects: offer (once) to share the running town. */
  private maybeOfferShare(st: NetStatus, dt: number): void {
    if (st.connected && st.mode === 'lobby') this.connectedFor += dt;
    else this.connectedFor = 0;
    if (this.shareOffered || this.ui.app.inMenu || !st.canHost || st.mode !== 'lobby') return;
    if (this.connectedFor < SHARE_OFFER_DELAY || this.hostedTown()) return;
    if (this.ui.game.state.gameOver) return;
    this.shareOffered = true;
    this.ui.toast(`Co-op is available: share this town? ${this.joinHint()}`, 'info', {
      duration: 20, silent: true, action: { label: 'Share town', run: () => this.shareCurrentTown() },
    });
  }

  /**
   * Copy the invite link from a toast button (a click, so the clipboard is allowed). Without clipboard access the
   * Players window opens — it shows the link to copy by hand.
   */
  copyInvite(): void {
    const link = this.inviteLink();
    if (!link) return;
    const fallback = () => {
      this.ui.openWindow('players');
      this.ui.toast('Copy the invite link from the Players window.', 'info', { silent: true });
    };
    try {
      const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (!clip || typeof clip.writeText !== 'function') {
        fallback();
        return;
      }
      clip.writeText(link).then(() => this.ui.toast('Invite link copied.', 'good', { silent: true, duration: 3 }), fallback);
    } catch {
      fallback();
    }
  }

  private warnOnce(what: string, err: unknown): void {
    if (this.logged.has(what)) return;
    this.logged.add(what);
    console.warn(`[ui] net.${what} failed`, err);
  }
}

/** One chat line element (shared by the chat bar feed and the Players window). */
export function chatLineEl(l: ChatLine): HTMLElement {
  const name = h('span', { class: 'cl-name' }, l.name);
  setStyle(name, 'color', l.color);
  return h('div', { class: 'chat-line' }, name, h('span', { class: 'cl-text' }, l.text));
}

/** Small colour swatch for a player. */
export function playerSwatch(color: string): HTMLElement {
  const el = h('span', { class: 'pl-swatch', 'aria-hidden': 'true' });
  setStyle(el, 'background', color);
  return el;
}

export const CROWN = '👑';
export const PLAYERS_ICON = '👥';
