/**
 * Players window (J): who is in the shared town — colour swatch, name, host crown, "you", idle dimming and what each
 * player is doing — plus the session status line, join progress, resync / pending-command counters, the co-op
 * actions (join / leave / share / stop sharing) and a small chat log with an input.
 *
 * Public relay rooms add the room card (code, Copy invite link, your name), who holds the host seat, and — for the
 * seat holder — a remove (kick) button next to every other player.
 */
import type { PlayerInfo } from '../../net/types';
import type { UIContext } from '../context';
import { h, setAttr, setClass, setDisabled, setFrac, setStyle, setText, show } from '../dom';
import { UIWindow } from '../windows/window';
import { CHAT_MAX_CHARS, chatLineEl, CROWN, PLAYERS_ICON, playerSwatch, type CoopController } from './controller';
import { RoomBox } from './room-box';
import { lowerFirst } from './rooms';

/** Players whose presence has not changed for this long are shown as idle. */
export const IDLE_AFTER_MS = 45_000;

interface Row {
  el: HTMLElement;
  swatch: HTMLElement;
  name: HTMLElement;
  tags: HTMLElement;
  tool: HTMLElement;
  go: HTMLButtonElement;
  kick: HTMLButtonElement;
}

export function idleLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 90) return `idle ${s}s`;
  return `idle ${Math.floor(s / 60)} min`;
}

export class PlayersWindow extends UIWindow {
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private progress!: HTMLElement;
  private progressFill!: HTMLElement;
  private meta!: HTMLElement;
  private list!: HTMLElement;
  private empty!: HTMLElement;
  private actions!: HTMLElement;
  private joinBtn!: HTMLButtonElement;
  private leaveBtn!: HTMLButtonElement;
  private shareBtn!: HTMLButtonElement;
  private note!: HTMLElement;
  private chatBox!: HTMLElement;
  private chatLog!: HTMLElement;
  private chatInput!: HTMLInputElement;
  private chatSend!: HTMLButtonElement;
  private room!: RoomBox;
  private shareTip = '';
  private rows = new Map<string, Row>();
  private rowKey = '';
  private chatVersion = -1;
  private players: PlayerInfo[] = [];

  constructor(ui: UIContext, private readonly coop: CoopController) {
    super(ui, { id: 'players', title: 'Players', icon: PLAYERS_ICON, width: 34, hotkey: 'J', className: 'w-players' });
  }

  protected build(): void {
    this.statusDot = h('span', { class: 'pl-dot', 'aria-hidden': 'true' });
    this.statusText = h('span', { class: 'pl-status-t' });
    this.progressFill = h('div', { class: 'bar-fill' });
    this.progress = h('div', { class: 'bar tone-info pl-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.progressFill);
    this.meta = h('div', { class: 'pl-meta' });
    this.list = h('div', { class: 'pl-list', role: 'list' });
    this.empty = h('div', { class: 'pl-empty' });
    this.joinBtn = h('button', { class: 'btn primary small', type: 'button', onclick: () => void this.coop.join(!this.ui.app.inMenu) });
    this.leaveBtn = h('button', { class: 'btn small danger', type: 'button', onclick: () => void this.coop.leave(true) });
    this.shareBtn = h('button', { class: 'btn small', type: 'button', onclick: () => this.coop.shareCurrentTown() }, '📡 Share this town');
    this.room = new RoomBox(this.ui, this.coop, { className: 'pl-room' });
    this.actions = h('div', { class: 'pl-actions' }, this.joinBtn, this.shareBtn, this.leaveBtn);
    this.note = h('div', { class: 'pl-note' });

    this.chatLog = h('div', { class: 'pl-chat-log', 'aria-live': 'polite' });
    this.chatInput = h('input', {
      class: 'pl-chat-input', type: 'text', maxlength: String(CHAT_MAX_CHARS), placeholder: 'Message…', 'aria-label': 'Chat message',
      autocomplete: 'off', spellcheck: 'false',
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          this.send();
        }
      },
    });
    this.chatSend = h('button', { class: 'btn small', type: 'button', onclick: () => this.send() }, 'Send');
    this.chatBox = h('div', { class: 'pl-chat' },
      h('div', { class: 'pl-sec' }, 'Chat'), this.chatLog, h('div', { class: 'pl-chat-row' }, this.chatInput, this.chatSend));

    this.body.append(
      h('div', { class: 'pl-status' }, this.statusDot, this.statusText),
      this.progress, this.meta, this.room.el,
      h('div', { class: 'pl-sec' }, 'In this town'),
      this.list, this.empty, this.actions, this.note, this.chatBox,
      h('div', { class: 'win-foot-note' }, 'J players · Enter chat · click a player to look where they are'));
  }

  private send(): void {
    const text = this.chatInput.value;
    if (!text.trim()) return;
    if (this.coop.sendChat(text)) {
      this.chatInput.value = '';
      this.ui.sound('click');
    }
  }

  override refresh(): void {
    if (!this.statusText) return;
    const st = this.coop.readStatus();
    const town = this.coop.hostedTown();
    const coop = st.mode === 'host' || st.mode === 'guest' || st.mode === 'joining';

    // ---- status ----
    const closed = this.coop.closeInfo();
    setText(this.statusText, closed ? closed.text : st.mode === 'solo' ? 'Single player' : st.label || modeLabel(st.mode));
    this.statusDot.className = `pl-dot ${closed || !st.connected ? 'off' : coop ? 'on' : 'idle'}`;
    show(this.progress, st.mode === 'joining');
    if (st.mode === 'joining') {
      setFrac(this.progressFill, st.joinProgress);
      this.progress.setAttribute('aria-valuenow', String(Math.round(st.joinProgress * 100)));
    }
    const meta: string[] = [];
    if (st.mode === 'guest' && st.ticksBehind > 4) meta.push(`${st.ticksBehind} steps behind the host`);
    if (st.pendingCommands > 0) meta.push(`${st.pendingCommands} order${st.pendingCommands === 1 ? '' : 's'} waiting for the host`);
    if (st.resyncs > 0) meta.push(`${st.resyncs} resync${st.resyncs === 1 ? '' : 's'}`);
    setText(this.meta, meta.join(' · '));
    show(this.meta, meta.length > 0);

    // ---- players ----
    this.players = st.mode === 'solo' ? [] : this.coop.players();
    this.renderPlayers(this.players);
    let empty = '';
    if (closed) empty = 'Open the main menu (Esc) to play solo or try again.';
    else if (st.mode === 'solo' && this.coop.connectingToRoom) empty = 'Connecting to the online room…';
    else if (st.mode === 'solo' && this.coop.onlineAvailable) empty = 'Play online: host a game or join one with a code from the main menu (Esc).';
    else if (st.mode === 'solo') empty = 'Co-op is not available here. Open this page as a shared Claude artifact (signed in) to build a town together.';
    else if (!st.connected) empty = 'Connecting to the room…';
    else if (this.players.length <= 1) empty = 'Nobody else is here right now.';
    setText(this.empty, empty);
    show(this.empty, !!empty);

    // ---- actions ----
    const canJoin = st.connected && !coop && !!town;
    show(this.joinBtn, canJoin);
    if (canJoin && town) setText(this.joinBtn, `Join ${town.hostName}'s town`);
    show(this.shareBtn, st.connected && st.canHost && st.mode === 'lobby' && !town && !this.ui.app.inMenu && !this.ui.game.state.gameOver);
    const hint = this.coop.joinHint();
    const shareTip = `Host the running town — ${lowerFirst(hint)}`;
    if (shareTip !== this.shareTip) {
      this.shareTip = shareTip;
      this.ui.tips.set(this.shareBtn, shareTip);
    }
    show(this.leaveBtn, coop);
    setText(this.leaveBtn, st.mode === 'host' ? 'Stop sharing' : st.mode === 'joining' ? 'Cancel' : 'Leave shared town');
    let note = '';
    if (st.mode === 'host') note = `Hosting — ${lowerFirst(hint)} Your autosaves keep the shared town.`;
    else if (st.mode === 'guest') note = town ? `You are in ${town.hostName}'s town. New Game and Load are off until you leave.` : 'You are in a shared town.';
    else if (st.mode === 'lobby' && town) note = `${town.hostName} is hosting “${town.townName}” (Year ${town.year}, ${town.population} people).`;
    else if (st.mode === 'lobby' && st.canHost) note = `Start or load a town to host it for everyone here. ${hint}`;
    else if (st.mode === 'lobby') note = 'Nobody is hosting yet — you can play on your own meanwhile.';
    setText(this.note, note);
    show(this.note, !!note);
    if (closed) show(this.room.el, false);
    else this.room.refresh();

    // ---- chat ----
    const chatOn = this.coop.chatAvailable;
    show(this.chatBox, chatOn || this.coop.chat.length > 0);
    setDisabled(this.chatInput, !chatOn);
    setDisabled(this.chatSend, !chatOn);
    if (this.chatVersion !== this.coop.chatVersion) {
      this.chatVersion = this.coop.chatVersion;
      const atBottom = this.chatLog.scrollTop + this.chatLog.clientHeight >= this.chatLog.scrollHeight - 4;
      this.chatLog.replaceChildren(...this.coop.chat.map((l) => chatLineEl(l)));
      if (!this.coop.chat.length) this.chatLog.appendChild(h('div', { class: 'pl-chat-empty' }, 'No messages yet.'));
      if (atBottom) this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }
  }

  private renderPlayers(list: PlayerInfo[]): void {
    const key = list.map((p) => p.peer).join('|');
    if (key !== this.rowKey) {
      this.rowKey = key;
      this.list.replaceChildren();
      this.rows.clear();
      for (const p of list) {
        const swatch = playerSwatch(p.color);
        const name = h('span', { class: 'pl-name' });
        const tags = h('span', { class: 'pl-tags' });
        const tool = h('span', { class: 'pl-tool' });
        const peer = p.peer;
        const go = h('button', { class: 'pl-go', type: 'button', 'aria-label': 'Look where this player is', tip: 'Look where they are', onclick: () => this.goTo(peer) }, '➜');
        const kick = h('button', {
          class: 'pl-kick', type: 'button', 'aria-label': 'Remove this player from the room', tip: 'Remove from the room',
          onclick: () => this.kick(peer),
        }, '✖');
        kick.hidden = true;
        const el = h('div', { class: 'pl-row', role: 'listitem' },
          swatch, h('div', { class: 'pl-who' }, h('div', { class: 'pl-line' }, name, tags), tool), go, kick);
        el.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          this.goTo(peer);
        });
        this.list.appendChild(el);
        this.rows.set(p.peer, { el, swatch, name, tags, tool, go, kick });
      }
    }
    const relay = this.coop.isRelayRoom;
    const seat = relay ? this.coop.hostSeatPeers() : null;
    const canKick = relay && this.coop.canKick();
    for (const p of list) {
      const r = this.rows.get(p.peer);
      if (!r) continue;
      setStyle(r.swatch, 'background', p.color);
      setText(r.name, p.name);
      const seated = !!seat && seat.has(p.peer);
      // in public rooms the relay's host seat decides who may host; the guest flag is a Claude-room notion
      setText(r.tags, `${p.isHost ? ` ${CROWN}` : ''}${seated ? ' · host seat' : ''}${p.isMe ? ' (you)' : ''}${p.guest && !relay ? ' · guest' : ''}`);
      const kickable = canKick && !p.isMe;
      show(r.kick, kickable);
      if (kickable) setAttr(r.kick, 'aria-label', `Remove ${p.name} from the room`);
      const idle = p.idleMs > IDLE_AFTER_MS;
      setText(r.tool, idle ? `${idleLabel(p.idleMs)}${p.tool ? ` · ${p.tool}` : ''}` : p.tool || '—');
      setClass(r.el, 'idle', idle);
      setClass(r.el, 'me', p.isMe);
      show(r.go, !p.isMe && !!(p.cursor || p.camera));
      if (p.isHost) this.ui.tips.set(r.name, 'Host — runs the shared town');
      else if (seated) this.ui.tips.set(r.name, 'Holds the host seat — hosts the town and can remove players');
      else this.ui.tips.set(r.name, null);
    }
  }

  private kick(peer: string): void {
    const p = this.players.find((x) => x.peer === peer);
    if (!p || p.isMe) return;
    void this.coop.kick(peer, p.name);
  }

  private goTo(peer: string): void {
    const p = this.players.find((x) => x.peer === peer);
    if (!p || p.isMe) return;
    const at = p.cursor ?? (p.camera ? [p.camera.x, p.camera.z] as [number, number] : null);
    if (!at) return;
    this.ui.app.focusOn(at[0], at[1]);
    this.ui.sound('click');
  }
}

function modeLabel(mode: string): string {
  switch (mode) {
    case 'host': return 'Hosting';
    case 'guest': return 'In a shared town';
    case 'joining': return 'Joining…';
    case 'lobby': return 'Connected — nobody hosting';
    default: return 'Single player';
  }
}
