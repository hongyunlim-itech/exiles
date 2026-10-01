/**
 * Game-over overlay shown when the population reaches zero: epitaph, survival stats and next steps.
 */
import type { CauseOfDeath } from '../../core/types';
import type { UIContext } from '../context';
import { h } from '../dom';
import { fmtInt, monthName, plural } from '../format';
import { DEATH_CAUSE_LABELS } from '../icons';

export class GameOverOverlay {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private shownFor: unknown = null;

  constructor(private readonly ui: UIContext, private readonly actions: { newGame: () => void; load: () => void }) {
    this.body = h('div', { class: 'go-body' });
    const box = h('div', { class: 'go-box panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'go-title' },
      h('div', { class: 'go-emblem', 'aria-hidden': 'true' }, '🕯️'),
      h('h2', { class: 'go-title', id: 'go-title' }, 'The Settlement Has Fallen'),
      this.body,
      h('div', { class: 'dlg-actions center' },
        h('button', { class: 'btn', type: 'button', onclick: () => this.hide() }, 'Keep watching'),
        h('button', { class: 'btn', type: 'button', onclick: () => this.actions.load() }, 'Load game'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => this.actions.newGame() }, 'New game')));
    this.el = h('div', { class: 'go-overlay' }, box);
    this.el.hidden = true;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Show once per game instance. */
  maybeShow(): void {
    const game = this.ui.game;
    if (!game.state.gameOver || this.shownFor === game) return;
    this.shownFor = game;
    this.show();
  }

  show(): void {
    const s = this.ui.game.state;
    const peak = s.history.reduce((m, x) => Math.max(m, x.population), 0);
    const deaths = Object.entries(s.tally.deaths) as [CauseOfDeath, number][];
    const totalDeaths = deaths.reduce((a, [, n]) => a + (n ?? 0), 0);
    const yearsSurvived = Math.max(0, s.time.year - 1 + s.time.month / 12);
    const causes = deaths.filter(([, n]) => (n ?? 0) > 0).sort((a, b) => b[1] - a[1]);
    const parts: (HTMLElement | null)[] = [
      h('p', { class: 'go-epitaph' }, `The last of the exiles of ${s.settings.townName} passed away in ${monthName(s.time.month)} of year ${s.time.year}. The fields return to the wild.`),
      h('div', { class: 'go-stats' },
        stat(yearsSurvived < 1 ? '< 1' : fmtInt(yearsSurvived), 'years survived'),
        stat(fmtInt(peak), 'peak population'),
        stat(fmtInt(s.tally.births), 'births'),
        stat(fmtInt(totalDeaths), 'deaths')),
      causes.length
        ? h('div', { class: 'go-causes' }, h('h4', { class: 'sec-h' }, 'Causes of death'),
          ...causes.map(([c, n]) => h('div', { class: 'kv' }, h('span', { class: 'kv-l' }, DEATH_CAUSE_LABELS[c] ?? c), h('span', { class: 'kv-v' }, plural(n, 'person', 'people')))))
        : null,
    ];
    this.body.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
    this.el.hidden = false;
    this.ui.sound('danger');
  }

  hide(): void {
    this.el.hidden = true;
  }

  reset(): void {
    this.shownFor = null;
    this.hide();
  }
}

function stat(value: string, label: string): HTMLElement {
  return h('div', { class: 'go-stat' }, h('span', { class: 'go-stat-v' }, value), h('span', { class: 'go-stat-l' }, label));
}
