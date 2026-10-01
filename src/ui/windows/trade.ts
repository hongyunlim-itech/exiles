/**
 * Trade dialog: barter town goods (from storage) for a docked merchant's offers. Shows the value balance live and
 * dispatches the 'trade' command (give, take). Also lets the player request the kind of the next merchant. In co-op
 * the host settles the trade at its next turn (a refusal arrives as a 'rejected' toast).
 */
import { CROPS, LIVESTOCK, ORCHARDS, RESOURCES, RESOURCE_TYPES } from '../../core/defs';
import type { CropType, Inventory, LivestockType, MerchantKind, MerchantOffer, OrchardType, ResourceCategory, ResourceType } from '../../core/types';
import type { TradeTake } from '../../sim/game';
import type { UIContext } from '../context';
import { clamp, h, setClass, setDisabled, setFrac, setText, show } from '../dom';
import { fmtInt, fmtMonths } from '../format';
import { ICON, MERCHANT_KINDS } from '../icons';
import { pendingKey } from '../pending';
import { simBridge } from '../sim-bridge';
import { Segmented } from '../widgets';
import { UIWindow } from './window';

type GiveFilter = 'all' | 'food' | 'materials' | 'goods';

const LIVESTOCK_ICONS: Record<LivestockType, string> = { sheep: '🐑', cattle: '🐄', chicken: '🐔' };

const FILTER_CATS: Record<GiveFilter, ResourceCategory[] | null> = {
  all: null,
  food: ['food'],
  materials: ['material', 'fuel'],
  goods: ['tool', 'textile', 'clothing', 'health', 'luxury'],
};

export function offerInfo(o: MerchantOffer): { name: string; icon: string; unlock: boolean } {
  switch (o.kind) {
    case 'crop': {
      const c = CROPS[o.id as CropType];
      return { name: `${c?.name ?? o.id} seeds`, icon: RESOURCES[c?.resource ?? 'wheat']?.icon ?? '🌱', unlock: true };
    }
    case 'orchard': {
      const c = ORCHARDS[o.id as OrchardType];
      return { name: `${c?.name ?? o.id} saplings`, icon: RESOURCES[c?.resource ?? 'apple']?.icon ?? '🌳', unlock: true };
    }
    case 'livestock': {
      const l = LIVESTOCK[o.id as LivestockType];
      return { name: l?.name ?? String(o.id), icon: LIVESTOCK_ICONS[o.id as LivestockType] ?? '🐾', unlock: true };
    }
    default: {
      const r = RESOURCES[o.id as ResourceType];
      return { name: r?.name ?? String(o.id), icon: r?.icon ?? '•', unlock: false };
    }
  }
}

/** Numeric quantity control: − [input] + (Shift ×10, Ctrl ×100) with optional Max button. */
class Qty {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private dec: HTMLButtonElement;
  private inc: HTMLButtonElement;
  value = 0;
  max = 0;

  constructor(private readonly onChange: (v: number) => void, withMax = true) {
    const step = (sign: number) => (e: MouseEvent) => {
      const m = e.ctrlKey || e.metaKey ? 100 : e.shiftKey ? 10 : 1;
      this.setValue(this.value + sign * m, true);
    };
    this.dec = h('button', { class: 'step-btn', type: 'button', 'aria-label': 'Less', tip: 'Less (Shift ×10, Ctrl ×100)', onclick: step(-1) }, '−');
    this.inc = h('button', { class: 'step-btn', type: 'button', 'aria-label': 'More', tip: 'More (Shift ×10, Ctrl ×100)', onclick: step(1) }, '+');
    this.input = h('input', {
      class: 'qty-input', type: 'number', min: '0', step: '1', value: '0', inputmode: 'numeric', 'aria-label': 'Amount',
      oninput: () => this.setValue(Math.floor(Number(this.input.value) || 0), true, false),
      onblur: () => (this.input.value = String(this.value)),
    });
    const maxBtn = withMax
      ? h('button', { class: 'qty-max', type: 'button', tip: 'All available', onclick: () => this.setValue(this.value >= this.max ? 0 : this.max, true) }, 'Max')
      : null;
    this.el = h('div', { class: 'qty' }, this.dec, this.input, this.inc, maxBtn);
  }

  setValue(v: number, notify: boolean, writeInput = true): void {
    const nv = clamp(Math.floor(v), 0, Math.max(0, Math.floor(this.max)));
    const changed = nv !== this.value;
    this.value = nv;
    if (writeInput && this.input.value !== String(nv)) this.input.value = String(nv);
    setDisabled(this.dec, nv <= 0);
    setDisabled(this.inc, nv >= Math.floor(this.max));
    setClass(this.el, 'nonzero', nv > 0);
    if (changed && notify) this.onChange(nv);
  }

  setMax(max: number): void {
    this.max = Math.max(0, Math.floor(max));
    this.input.max = String(this.max);
    if (this.value > this.max) this.setValue(this.max, true);
    else this.setValue(this.value, false, document.activeElement !== this.input);
  }
}

interface GiveRow {
  type: ResourceType;
  el: HTMLElement;
  stock: HTMLElement;
  qty: Qty;
}

interface TakeRow {
  index: number;
  el: HTMLElement;
  avail: HTMLElement;
  qty: Qty | null;
  buy: HTMLButtonElement | null;
  unlockOwned: boolean;
}

export class TradeWindow extends UIWindow {
  private merchantId = -1;
  private give = new Map<ResourceType, number>();
  private take = new Map<number, number>();
  private filter: GiveFilter = 'all';
  private giveRows = new Map<ResourceType, GiveRow>();
  private giveKey = '';
  private takeRows: TakeRow[] = [];

  private headName!: HTMLElement;
  private headSub!: HTMLElement;
  private content!: HTMLElement;
  private empty!: HTMLElement;
  private emptyText!: HTMLElement;
  private giveList!: HTMLElement;
  private takeList!: HTMLElement;
  private giveVal!: HTMLElement;
  private takeVal!: HTMLElement;
  private balFill!: HTMLElement;
  private balText!: HTMLElement;
  private tradeBtn!: HTMLButtonElement;
  private filterSeg!: Segmented<GiveFilter>;
  private requestSeg!: Segmented<string>;

  constructor(ui: UIContext) {
    super(ui, { id: 'trade', title: 'Trading Post', icon: ICON.trade, width: 92, dialog: true, className: 'w-trade' });
  }

  protected build(): void {
    this.headName = h('div', { class: 'tr-name' });
    this.headSub = h('div', { class: 'tr-sub' });
    const head = h('div', { class: 'tr-head' }, h('span', { class: 'tr-boat', 'aria-hidden': 'true' }, ICON.merchant), h('div', {}, this.headName, this.headSub));

    this.filterSeg = new Segmented<GiveFilter>([
      { id: 'all', label: 'All' }, { id: 'food', label: 'Food' }, { id: 'materials', label: 'Materials' }, { id: 'goods', label: 'Goods' },
    ], (id) => {
      this.filter = id;
      this.filterSeg.set(id);
      this.giveKey = '';
      this.refresh();
    }, { className: 'small', label: 'Filter goods' });
    this.filterSeg.set('all');
    this.giveList = h('div', { class: 'tr-list' });
    this.takeList = h('div', { class: 'tr-list' });
    const cols = h('div', { class: 'tr-cols' },
      h('div', { class: 'tr-col' },
        h('div', { class: 'tr-col-h' }, h('span', {}, 'Your goods'), this.filterSeg.el),
        h('div', { class: 'tr-row tr-hdr' }, h('span', {}, 'Resource'), h('span', {}, 'In stock'), h('span', {}, 'Value'), h('span', {}, 'Offer')),
        this.giveList),
      h('div', { class: 'tr-col' },
        h('div', { class: 'tr-col-h' }, h('span', {}, "Merchant's wares")),
        h('div', { class: 'tr-row tr-hdr' }, h('span', {}, 'Item'), h('span', {}, 'Available'), h('span', {}, 'Price'), h('span', {}, 'Buy')),
        this.takeList));

    this.giveVal = h('span', { class: 'tr-v give' });
    this.takeVal = h('span', { class: 'tr-v take' });
    this.balFill = h('div', { class: 'tr-bal-fill' });
    this.balText = h('div', { class: 'tr-bal-text' });
    this.tradeBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => this.execute() }, 'Trade');
    const reset = h('button', { class: 'btn', type: 'button', onclick: () => this.resetAmounts() }, 'Clear');
    const foot = h('div', { class: 'tr-foot' },
      h('div', { class: 'tr-vals' },
        h('div', { class: 'tr-vbox' }, h('span', { class: 'tr-vl' }, 'You offer'), this.giveVal),
        h('div', { class: 'tr-bal' }, h('div', { class: 'tr-bal-track' }, this.balFill), this.balText),
        h('div', { class: 'tr-vbox' }, h('span', { class: 'tr-vl' }, 'You receive'), this.takeVal)),
      h('div', { class: 'tr-actions' }, reset, this.tradeBtn));
    this.content = h('div', { class: 'tr-content' }, cols, foot);

    this.emptyText = h('p', { class: 'tr-empty-t' });
    this.empty = h('div', { class: 'tr-empty' }, h('div', { class: 'tr-empty-i', 'aria-hidden': 'true' }, '🌊'), this.emptyText);

    this.requestSeg = new Segmented<string>([
      { id: 'any', label: 'Any', tip: 'No preference' },
      ...MERCHANT_KINDS.map((k) => ({ id: k.id as string, label: k.name, icon: k.icon, tip: k.desc })),
    ], (id) => {
      const res = this.ui.dispatch({ op: 'requestMerchant', kind: id === 'any' ? null : (id as MerchantKind) });
      if (!res.ok) return;
      if (res.pending) this.ui.pending.set(pendingKey.merchant(), id);
      this.requestSeg.set(id);
      this.ui.sound('click');
    }, { className: 'small', label: 'Request merchant' });
    const req = h('div', { class: 'tr-request' }, h('span', { class: 'tr-req-l', tip: 'Ask traders to send this kind of merchant next time.' }, 'Request next merchant:'), this.requestSeg.el);

    this.body.append(head, this.content, this.empty, req);
  }

  protected override onOpen(): void {
    this.giveKey = '';
  }

  private resetAmounts(): void {
    this.give.clear();
    this.take.clear();
    for (const r of this.giveRows.values()) r.qty.setValue(0, false);
    for (const r of this.takeRows) {
      r.qty?.setValue(0, false);
      if (r.buy) setClass(r.buy, 'on', false);
    }
    this.updateBalance();
  }

  private execute(): void {
    const m = this.ui.game.state.trade.merchant;
    if (!m) return;
    const give: Inventory = {};
    for (const [k, v] of this.give) if (v > 0) give[k] = v;
    const take: TradeTake[] = [];
    for (const [i, v] of this.take) if (v > 0) take.push({ offerIndex: i, amount: v });
    if (!take.length) return;
    const res = this.ui.dispatch({ op: 'trade', give, take }, { toastFailure: false, errorSound: false });
    if (res.ok && res.pending) {
      this.ui.toast('Trade offered — the merchant is weighing it up…', 'info', { silent: true });
      this.ui.sound('click');
      this.resetAmounts();
      this.refresh();
    } else if (res.ok) {
      this.ui.toast('Trade complete. The goods will be unloaded at the trading post.', 'good');
      this.resetAmounts();
      this.merchantId = -1; // offers may have changed: rebuild
      this.ui.data.invalidate();
      this.refresh();
    } else {
      this.ui.toast(res.reason ?? 'The merchant refused the trade.', 'warning');
      this.ui.sound('error');
    }
  }

  override refresh(): void {
    if (!this.content) return;
    const s = this.ui.game.state;
    const m = s.trade.merchant;
    this.requestSeg.set(this.ui.pending.get<string>(pendingKey.merchant(), s.trade.requested ?? 'any'));
    show(this.content, !!m);
    show(this.empty, !m);
    if (!m) {
      const hasPost = this.ui.data.buildingsOfType('tradingPost').some((b) => b.state === 'active');
      setText(this.headName, 'No merchant in port');
      setText(this.headSub, hasPost ? `Next merchant expected in about ${fmtMonths(s.trade.nextArrival)} (not in winter).` : 'Build a Trading Post on the water\'s edge to attract merchants.');
      setText(this.emptyText, hasPost
        ? 'The docks are quiet. Merchants arrive every few months outside winter and stay for about two months.'
        : 'Merchants only visit towns with a staffed Trading Post.');
      this.merchantId = -1;
      return;
    }
    const kind = MERCHANT_KINDS.find((k) => k.id === m.kind);
    setText(this.headName, m.name);
    setText(this.headSub, `${kind ? `${kind.icon} ${kind.name} merchant` : 'Merchant'} · leaves in ${fmtMonths(m.leavesIn)}`);

    if (m.id !== this.merchantId) {
      this.merchantId = m.id;
      this.give.clear();
      this.take.clear();
      this.buildOffers();
      this.giveKey = '';
    } else if (m.offers.length !== this.takeRows.length) {
      // offers changed under us (co-op: another player's trade was settled) — indices shifted
      this.take.clear();
      this.buildOffers();
    }
    this.refreshGive();
    this.refreshOffers();
    this.updateBalance();
  }

  private buildOffers(): void {
    const m = this.ui.game.state.trade.merchant;
    this.takeList.replaceChildren();
    this.takeRows = [];
    if (!m) return;
    m.offers.forEach((o, index) => {
      const info = offerInfo(o);
      const avail = h('span', { class: 'tr-stock' });
      let qty: Qty | null = null;
      let buy: HTMLButtonElement | null = null;
      if (info.unlock) {
        buy = h('button', {
          class: 'btn small tr-buy', type: 'button', 'aria-pressed': 'false',
          onclick: () => {
            const on = !(this.take.get(index) ?? 0);
            this.take.set(index, on ? 1 : 0);
            setClass(buy!, 'on', on);
            buy!.setAttribute('aria-pressed', String(on));
            this.updateBalance();
          },
        }, 'Buy');
      } else {
        qty = new Qty((v) => {
          this.take.set(index, v);
          this.updateBalance();
        });
      }
      const el = h('div', { class: `tr-row ${info.unlock ? 'unlock' : ''}` },
        h('span', { class: 'tr-item' }, h('span', { class: 'tr-i' }, info.icon), h('span', { class: 'tr-n' }, info.name, info.unlock ? h('span', { class: 'tr-tag' }, 'unlock') : null)),
        avail,
        h('span', { class: 'tr-price' }, fmtPrice(o.price)),
        h('span', { class: 'tr-ctl' }, qty ? qty.el : buy));
      this.takeList.appendChild(el);
      this.takeRows.push({ index, el, avail, qty, buy, unlockOwned: false });
    });
    if (!m.offers.length) this.takeList.appendChild(h('div', { class: 'tr-none' }, 'Sold out.'));
  }

  private refreshOffers(): void {
    const m = this.ui.game.state.trade.merchant;
    if (!m) return;
    const un = this.ui.game.state.unlocked;
    for (const r of this.takeRows) {
      const o = m.offers[r.index];
      if (!o) continue;
      if (r.qty) {
        r.qty.setMax(o.amount);
        setText(r.avail, fmtInt(o.amount));
      } else if (r.buy) {
        const owned = (o.kind === 'crop' && un.crops.includes(o.id as CropType))
          || (o.kind === 'orchard' && un.orchards.includes(o.id as OrchardType))
          || (o.kind === 'livestock' && un.livestock.includes(o.id as LivestockType));
        setText(r.avail, owned ? 'Owned' : 'New!');
        setClass(r.avail, 't-good', !owned);
        setDisabled(r.buy, owned || o.amount <= 0);
        if (owned && this.take.get(r.index)) {
          this.take.set(r.index, 0);
          setClass(r.buy, 'on', false);
        }
      }
    }
  }

  private refreshGive(): void {
    const t = this.ui.data.totals();
    const cats = FILTER_CATS[this.filter];
    const types = RESOURCE_TYPES.filter((r) => (t[r] >= 1 || (this.give.get(r) ?? 0) > 0) && (!cats || cats.includes(RESOURCES[r].category)));
    const key = types.join(',');
    if (key !== this.giveKey) {
      this.giveKey = key;
      this.giveList.replaceChildren();
      for (const r of types) {
        let row = this.giveRows.get(r);
        if (!row) {
          const stock = h('span', { class: 'tr-stock' });
          const qty = new Qty((v) => {
            this.give.set(r, v);
            this.updateBalance();
          });
          const el = h('div', { class: 'tr-row' },
            h('span', { class: 'tr-item' }, h('span', { class: 'tr-i' }, RESOURCES[r].icon), h('span', { class: 'tr-n' }, RESOURCES[r].name)),
            stock,
            h('span', { class: 'tr-price' }, fmtPrice(RESOURCES[r].value)),
            h('span', { class: 'tr-ctl' }, qty.el));
          row = { type: r, el, stock, qty };
          this.giveRows.set(r, row);
        }
        this.giveList.appendChild(row.el);
      }
      if (!types.length) this.giveList.appendChild(h('div', { class: 'tr-none' }, 'Nothing to offer.'));
    }
    for (const r of types) {
      const row = this.giveRows.get(r)!;
      setText(row.stock, fmtInt(t[r]));
      row.qty.setMax(t[r]);
      if ((this.give.get(r) ?? 0) !== row.qty.value) this.give.set(r, row.qty.value);
    }
  }

  private updateBalance(): void {
    const m = this.ui.game.state.trade.merchant;
    if (!m || !this.tradeBtn) return;
    const give: Inventory = {};
    for (const [k, v] of this.give) if (v > 0) give[k] = v;
    const giveV = simBridge.inventoryValue(give);
    let takeV = 0;
    let takeN = 0;
    for (const [i, v] of this.take) {
      const o = m.offers[i];
      if (o && v > 0) {
        takeV += o.price * v;
        takeN += v;
      }
    }
    setText(this.giveVal, fmtPrice(giveV));
    setText(this.takeVal, fmtPrice(takeV));
    const total = giveV + takeV;
    setFrac(this.balFill, total > 0 ? giveV / total : 0.5);
    const ok = takeN > 0 && giveV + 1e-6 >= takeV;
    let msg: string;
    if (takeN === 0) msg = 'Choose what you would like to buy.';
    else if (!ok) msg = `Offer ${fmtPrice(takeV - giveV)} more in value.`;
    else if (giveV - takeV > 0.5) msg = `The merchant accepts — ${fmtPrice(giveV - takeV)} surplus is not refunded.`;
    else msg = 'A fair trade. The merchant accepts.';
    setText(this.balText, msg);
    setClass(this.balText, 't-good', ok);
    setClass(this.balText, 't-bad', takeN > 0 && !ok);
    setDisabled(this.tradeBtn, !ok);
  }

  override onGameChanged(): void {
    this.merchantId = -1;
    this.give.clear();
    this.take.clear();
    this.giveKey = '';
  }
}

function fmtPrice(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? fmtInt(r) : r.toFixed(1);
}
