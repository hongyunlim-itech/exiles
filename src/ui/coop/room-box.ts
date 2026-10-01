/**
 * Public online room card, shown in the main-menu co-op box and in the Players window: the room code and "Copy invite
 * link" (relay rooms; the clipboard is written inside the click — without clipboard access the link is shown selected
 * for Ctrl+C), and the player's name (relay and local dev rooms, which have no profiles; stored in localStorage
 * 'exiles.nick' and applied through the session). Hidden in Claude rooms and single player.
 */
import type { UIContext } from '../context';
import { h, setText, show } from '../dom';
import type { CoopController } from './controller';
import { NICK_MAX, sanitizeNickname } from './rooms';

/** How long the "Copied!" confirmation stays (ms). */
const COPIED_MS = 2200;
/** Typing pause before a changed name is applied (ms); leaving the field or Enter applies at once. */
const NICK_APPLY_MS = 600;

let boxSeq = 0;

export class RoomBox {
  readonly el: HTMLElement;
  private code: HTMLElement;
  private copyBtn: HTMLButtonElement;
  private copyLabel: HTMLElement;
  private link: HTMLInputElement;
  private feedback: HTMLElement;
  private nick: HTMLInputElement;
  private inviteRow: HTMLElement;
  private copiedTimer: number | null = null;
  private nickTimer: number | null = null;
  /** The name applied last from this field (focus / apply): unchanged names are not re-applied or stored. */
  private nickBase = '';

  constructor(private readonly ui: UIContext, private readonly coop: CoopController, opts: { className?: string } = {}) {
    const id = `room-nick-${++boxSeq}`;
    this.code = h('span', { class: 'rb-code' });
    this.copyLabel = h('span', null, 'Copy invite link');
    this.copyBtn = h('button', {
      class: 'btn small rb-copy', type: 'button', onclick: () => this.copy(),
      tip: 'Copy a link to this room — send it to friends so they can join',
    }, h('span', { 'aria-hidden': 'true' }, '🔗'), this.copyLabel);
    this.link = h('input', {
      class: 'input mono rb-link', type: 'text', readonly: true, 'aria-label': 'Invite link', spellcheck: 'false',
      onfocus: () => this.link.select(),
    });
    this.link.hidden = true;
    this.feedback = h('div', { class: 'rb-feedback', role: 'status', 'aria-live': 'polite' });
    this.feedback.hidden = true;
    this.nick = h('input', {
      class: 'input rb-nick', id, type: 'text', maxlength: String(NICK_MAX), autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Your name', 'aria-label': 'Your name (shown to other players)',
      onfocus: () => {
        this.nickBase = sanitizeNickname(this.nick.value);
      },
      oninput: () => this.scheduleNick(),
      onchange: () => this.applyNick(),
      onblur: () => {
        this.applyNick();
        this.syncNick(true);
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          this.applyNick();
          this.nick.blur();
        }
      },
    });
    this.inviteRow = h('div', { class: 'rb-row' }, h('span', { class: 'rb-l' }, 'Room'), this.code, this.copyBtn);
    this.el = h('div', { class: `room-box ${opts.className ?? ''}` },
      this.inviteRow, this.link, this.feedback,
      h('div', { class: 'rb-row' },
        h('label', { class: 'rb-l', for: id }, 'Name'), this.nick));
    this.el.hidden = true;
  }

  /** Show in rooms without profiles (invite row: relay rooms); keep the code and (unless being edited) the name current. */
  refresh(): void {
    const on = this.coop.nicknameEditable;
    show(this.el, on);
    if (!on) return;
    const relay = this.coop.isRelayRoom;
    show(this.inviteRow, relay);
    if (relay) setText(this.code, this.coop.roomCode ?? '—');
    else {
      show(this.link, false);
      show(this.feedback, false);
    }
    this.syncNick(false);
  }

  private syncNick(force: boolean): void {
    if (!force && document.activeElement === this.nick) return;
    const name = this.coop.nickname();
    if (this.nick.value !== name) this.nick.value = name;
  }

  private scheduleNick(): void {
    if (this.nickTimer !== null) window.clearTimeout(this.nickTimer);
    this.nickTimer = window.setTimeout(() => {
      this.nickTimer = null;
      this.applyNick();
    }, NICK_APPLY_MS);
  }

  private applyNick(): void {
    if (this.nickTimer !== null) {
      window.clearTimeout(this.nickTimer);
      this.nickTimer = null;
    }
    const name = sanitizeNickname(this.nick.value);
    if (!name || name === this.nickBase) return; // empty (still typing, or reverted on blur) / unchanged
    this.nickBase = this.coop.setNickname(name);
  }

  /** Copy the invite link. The clipboard call stays inside the click handler (browsers require a user gesture). */
  private copy(): void {
    const link = this.coop.inviteLink();
    if (!link) {
      this.say('The invite link is not ready yet — try again in a moment.');
      this.ui.sound('error');
      return;
    }
    this.link.value = link;
    let clip: Clipboard | undefined;
    try {
      clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    } catch {
      clip = undefined;
    }
    if (clip && typeof clip.writeText === 'function') {
      try {
        clip.writeText(link).then(() => this.copied(), () => this.selectFallback());
        return;
      } catch {
        /* fall through */
      }
    }
    this.selectFallback();
  }

  /** No clipboard access: show the link selected (and try the legacy copy command while still in the click). */
  private selectFallback(): void {
    show(this.link, true);
    this.link.focus();
    this.link.select();
    let ok = false;
    try {
      ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    } catch {
      ok = false;
    }
    if (ok) this.copied();
    else this.say('Press Ctrl+C (⌘C) to copy the selected link.');
  }

  private copied(): void {
    this.ui.sound('click');
    setText(this.copyLabel, 'Copied!');
    this.copyBtn.classList.add('ok');
    this.say('Invite link copied — send it to your friends.');
    if (this.copiedTimer !== null) window.clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => {
      this.copiedTimer = null;
      setText(this.copyLabel, 'Copy invite link');
      this.copyBtn.classList.remove('ok');
      this.say('');
    }, COPIED_MS);
  }

  private say(text: string): void {
    setText(this.feedback, text);
    show(this.feedback, !!text);
  }
}
