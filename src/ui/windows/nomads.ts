/**
 * Nomads dialog: a group has arrived at the Town Hall — accept (they join as homeless adults, possibly carrying
 * disease) or turn them away. Dispatches the 'nomads' command (in co-op the first player to answer decides).
 */
import type { UIContext } from '../context';
import { h, setClass, setText, show } from '../dom';
import { fmtInt, fmtMonths, pct } from '../format';
import { ICON } from '../icons';
import { FOOD_PER_CITIZEN_MONTH } from '../hud/topbar';
import { UIWindow } from './window';

export class NomadsWindow extends UIWindow {
  private lead!: HTMLElement;
  private risk!: HTMLElement;
  private expires!: HTMLElement;
  private town!: HTMLElement;
  private warn!: HTMLElement;
  private actions!: HTMLElement;
  private gone!: HTMLElement;

  constructor(ui: UIContext) {
    super(ui, { id: 'nomads', title: 'Nomads', icon: ICON.nomads, width: 40, dialog: true, className: 'w-nomads' });
  }

  protected build(): void {
    this.lead = h('p', { class: 'nm-lead' });
    this.risk = h('span', { class: 'kv-v' });
    this.expires = h('span', { class: 'kv-v' });
    this.town = h('p', { class: 'nm-town' });
    this.warn = h('p', { class: 'nm-warn' });
    const decline = h('button', { class: 'btn', type: 'button', onclick: () => this.respond(false) }, 'Turn them away');
    const accept = h('button', { class: 'btn primary', type: 'button', onclick: () => this.respond(true) }, 'Welcome them');
    this.actions = h('div', { class: 'dlg-actions' }, decline, accept);
    this.gone = h('p', { class: 'nm-gone' }, 'The nomads have moved on.');
    this.body.append(
      h('div', { class: 'nm-art', 'aria-hidden': 'true' }, '🏕️'),
      this.lead,
      h('div', { class: 'kv' }, h('span', { class: 'kv-l' }, 'Risk of disease'), this.risk),
      h('div', { class: 'kv' }, h('span', { class: 'kv-l' }, 'They will leave in'), this.expires),
      this.town, this.warn, this.actions, this.gone,
    );
  }

  private respond(accept: boolean): void {
    if (!this.ui.game.state.nomads) {
      this.close();
      return;
    }
    const res = this.ui.dispatch({ op: 'nomads', accept });
    if (res.ok) this.ui.sound(accept ? 'notify' : 'click');
    this.close();
  }

  override refresh(): void {
    if (!this.lead) return;
    const n = this.ui.game.state.nomads;
    show(this.actions, !!n);
    show(this.gone, !n);
    if (!n) {
      setText(this.lead, '');
      return;
    }
    setText(this.lead, `A band of ${fmtInt(n.count)} weary nomads has arrived at the Town Hall, asking to join the town. They will work, but they need homes, food and firewood.`);
    const riskTone = n.diseaseRisk > 0.4 ? 'High' : n.diseaseRisk > 0.15 ? 'Moderate' : 'Low';
    setText(this.risk, `${riskTone} (${pct(n.diseaseRisk)})`);
    setClass(this.risk, 't-bad', n.diseaseRisk > 0.4);
    setClass(this.risk, 't-warn', n.diseaseRisk > 0.15 && n.diseaseRisk <= 0.4);
    setText(this.expires, fmtMonths(n.expiresIn));
    const pop = this.ui.data.population();
    const hs = this.ui.data.housing();
    const food = this.ui.data.food();
    const after = pop.total + n.count;
    const months = after > 0 ? food / (after * FOOD_PER_CITIZEN_MONTH) : 0;
    setText(this.town, `Town: ${fmtInt(pop.total)} people · ${fmtInt(Math.max(0, hs.capacity - hs.residents))} free beds · food for about ${Math.floor(months)} months with the newcomers.`);
    const warns: string[] = [];
    if (pop.homeless + n.count > Math.max(0, hs.capacity - hs.residents)) warns.push('Not everyone will have a home.');
    if (months < 4) warns.push('Food is short.');
    setText(this.warn, warns.join(' '));
    show(this.warn, warns.length > 0);
  }
}
