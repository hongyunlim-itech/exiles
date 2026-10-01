/**
 * Main-menu co-op block (below the navigation): a prominent "Join <host>'s town" button when someone hosts a town in
 * the room, join progress, the hosting notice, and "Leave shared town" for guests. Hidden in plain single player.
 *
 * Public online rooms (the Cloudflare relay): on a plain web page whose relay answers, "Play online" offers
 * [Host an online game] (reload into a fresh `?room=<code>`) and [Join with code]; inside a relay room the room card
 * (code, Copy invite link, your name) and "Leave room"; when the room closed for good (kicked, full, unreachable…)
 * the reason and [Play solo]. Inside a Claude artifact none of the online parts appear.
 */
import type { UIContext } from '../context';
import { h, setFrac, setText, show } from '../dom';
import type { CoopController } from './controller';
import { RoomBox } from './room-box';
import { lowerFirst } from './rooms';

export class MenuCoop {
  readonly el: HTMLElement;
  private icon: HTMLElement;
  private title: HTMLElement;
  private text: HTMLElement;
  private joinBtn: HTMLButtonElement;
  private joinLabel: HTMLElement;
  private joinSub: HTMLElement;
  private progress: HTMLElement;
  private progressFill: HTMLElement;
  private leaveBtn: HTMLButtonElement;
  private soloBtn: HTMLButtonElement;
  private retryBtn: HTMLButtonElement;
  private actions: HTMLElement;
  private room: RoomBox;
  // "Play online"
  private online: HTMLElement;
  private codeInput: HTMLInputElement;
  private codeError: HTMLElement;

  /** `inGame`: the menu was opened from a running game (joining replaces it → ask first). */
  constructor(private readonly ui: UIContext, private readonly coop: CoopController, private readonly inGame: () => boolean = () => false) {
    this.icon = h('span', { class: 'mc-i', 'aria-hidden': 'true' }, '👥');
    this.title = h('div', { class: 'mc-title' });
    this.text = h('div', { class: 'mc-text' });
    this.joinLabel = h('span', { class: 'menu-btn-l' });
    this.joinSub = h('span', { class: 'menu-btn-sub' });
    this.joinBtn = h('button', {
      class: 'menu-btn mc-join', type: 'button',
      onclick: () => {
        this.ui.sound('click');
        void this.coop.join(this.inGame());
      },
    }, this.joinLabel, this.joinSub);
    this.progressFill = h('div', { class: 'bar-fill' });
    this.progress = h('div', { class: 'bar tone-gold mc-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.progressFill);
    this.leaveBtn = h('button', { class: 'btn small mc-leave', type: 'button', onclick: () => void this.coop.leave(this.coop.current.mode !== 'joining') });
    this.soloBtn = h('button', { class: 'btn small mc-solo', type: 'button', onclick: () => this.playSolo() });
    this.retryBtn = h('button', { class: 'btn small mc-retry', type: 'button', onclick: () => this.coop.retryRoom() }, 'Try again');
    this.actions = h('div', { class: 'mc-actions' }, this.leaveBtn, this.retryBtn, this.soloBtn);
    this.room = new RoomBox(ui, coop, { className: 'mc-room' });

    // ---- Play online (host / join with code) ----
    const hostBtn = h('button', {
      class: 'menu-btn mc-host', type: 'button',
      onclick: () => void this.coop.hostOnline(this.inGame()),
    }, h('span', { class: 'menu-btn-l' }, 'Host an online game'), h('span', { class: 'menu-btn-sub' }, 'Get a link your friends can open to join'));
    this.codeInput = h('input', {
      class: 'input mono mc-code', type: 'text', maxlength: '200', placeholder: 'Room code or invite link', 'aria-label': 'Room code',
      autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
      oninput: () => this.showError(''),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          void this.joinWithCode();
        }
      },
    });
    const joinCodeBtn = h('button', { class: 'btn mc-code-go', type: 'button', onclick: () => void this.joinWithCode() }, 'Join');
    this.codeError = h('div', { class: 'mc-error', role: 'alert' });
    this.codeError.hidden = true;
    this.online = h('div', { class: 'mc-online' },
      hostBtn,
      h('div', { class: 'mc-code-l', 'aria-hidden': 'true' }, 'Join with code'),
      h('div', { class: 'input-row mc-code-row' }, this.codeInput, joinCodeBtn),
      this.codeError);
    this.online.hidden = true;

    this.el = h('section', { class: 'menu-coop', 'aria-label': 'Co-op', 'aria-live': 'polite' },
      h('div', { class: 'mc-head' }, this.icon, this.title),
      this.room.el, this.online, this.joinBtn, this.progress, this.text, this.actions);
    this.el.hidden = true;
  }

  /** True while the player follows a host's town (New Game / Load are locked then). */
  get guestLocked(): boolean {
    const m = this.coop.current.mode;
    return m === 'guest' || m === 'joining';
  }

  refresh(): void {
    const st = this.coop.readStatus();
    const closed = this.coop.closeInfo();
    const connecting = !closed && this.coop.connectingToRoom;
    const offerOnline = !closed && !connecting && st.mode === 'solo' && this.coop.onlineAvailable;
    const relay = this.coop.isRelayRoom;
    if (st.mode === 'solo' && !closed && !connecting && !offerOnline) {
      show(this.el, false);
      return;
    }
    show(this.el, true);
    const town = this.coop.hostedTown();
    let icon = '👥';
    let title = 'Co-op';
    let text = '';
    let join = false;
    let leave = '';
    let solo = '';
    let retry = false;
    if (closed) {
      icon = '⚠️';
      title = closed.title;
      text = closed.text;
      solo = 'Play solo';
      retry = closed.retry;
      // still following / hosting a town the room can no longer reach: keep playing a copy of it instead
      if (st.mode === 'guest' || st.mode === 'host') leave = 'Keep playing this town';
    } else if (connecting) {
      icon = '🌐';
      title = 'Online room';
      text = this.coop.roomCode ? `Connecting to room “${this.coop.roomCode}”…` : 'Connecting to the room…';
      solo = 'Play solo';
    } else if (offerOnline) {
      icon = '🌐';
      title = 'Play online';
      text = 'Build one town together with friends — anyone with the invite link can join.';
    } else {
      const hint = this.coop.joinHint();
      switch (st.mode) {
        case 'joining':
          title = town ? `Joining ${town.hostName}'s town…` : 'Joining the shared town…';
          text = `${Math.round(Math.max(0, Math.min(1, st.joinProgress)) * 100)}% — receiving the town from the host.`;
          leave = 'Cancel';
          break;
        case 'guest':
          title = town ? `In ${town.hostName}'s town` : 'In a shared town';
          text = town ? `“${town.townName}” · Year ${town.year} · ${town.population} people. Leave the shared town to start or load your own.` : 'Leave the shared town to start or load your own.';
          leave = 'Leave shared town';
          break;
        case 'host':
          title = 'Hosting';
          text = `Hosting “${this.ui.game.state.settings.townName}” — ${lowerFirst(hint)}`;
          leave = 'Stop sharing';
          break;
        case 'lobby':
          if (!st.connected) {
            title = 'Co-op';
            text = this.coop.roomUnreachable
              ? 'Cannot reach the online room — still trying. Check your connection; you can play on your own meanwhile.'
              : 'Connecting to the room…';
          } else if (town) {
            title = 'A town is being hosted';
            join = true;
            text = st.canHost ? 'A town of your own stays single player while they host.' : '';
          } else if (st.canHost) {
            title = 'Co-op ready';
            text = `Start or continue a town to host it — ${lowerFirst(hint)}`;
          } else {
            title = 'Co-op';
            const seat = relay ? this.seatHolderName() : '';
            text = seat
              ? `Waiting for ${seat} to start a town — you can play on your own meanwhile.`
              : 'Nobody is hosting a town yet — you can play on your own meanwhile.';
          }
          break;
        case 'solo':
          break;
      }
      if (relay) {
        icon = '🌐';
        if (title === 'Co-op') title = 'Online room';
        solo = 'Leave room';
      }
    }
    setText(this.icon, icon);
    setText(this.title, title);
    setText(this.text, text);
    show(this.text, !!text);
    show(this.joinBtn, join);
    if (join && town) {
      setText(this.joinLabel, `Join ${town.hostName}'s town`);
      setText(this.joinSub, `${town.townName} · Year ${town.year} · ${town.population} people`);
    }
    show(this.progress, st.mode === 'joining' && !closed);
    if (st.mode === 'joining') setFrac(this.progressFill, st.joinProgress);
    show(this.leaveBtn, !!leave);
    if (leave) setText(this.leaveBtn, leave);
    show(this.soloBtn, !!solo);
    if (solo) setText(this.soloBtn, solo);
    show(this.retryBtn, retry);
    show(this.actions, !!leave || !!solo || retry);
    show(this.online, offerOnline);
    if (!offerOnline) this.showError('');
    if (closed || connecting) show(this.room.el, false);
    else this.room.refresh();
  }

  private seatHolderName(): string {
    const seat = this.coop.hostSeatPeers();
    if (seat.size === 0) return '';
    const p = this.coop.players().find((x) => seat.has(x.peer) && !x.isMe);
    return p?.name ?? '';
  }

  private playSolo(): void {
    const st = this.coop.current;
    // leaving a live room reloads the page: ask when a town (or a shared one) would be lost
    const live = !this.coop.closeInfo() && (st.mode === 'host' || st.mode === 'guest' || st.mode === 'joining');
    void this.coop.playSolo(this.inGame() || live);
  }

  private async joinWithCode(): Promise<void> {
    const err = await this.coop.joinOnline(this.codeInput.value, this.inGame());
    if (err) {
      this.ui.sound('error');
      this.showError(err);
      this.codeInput.focus();
    }
  }

  private showError(text: string): void {
    setText(this.codeError, text);
    show(this.codeError, !!text);
  }
}
