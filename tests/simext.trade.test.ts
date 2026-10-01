import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS } from '../src/core/constants';
import { RESOURCES } from '../src/core/defs';
import type { MerchantOffer } from '../src/core/types';
import { generateOffers, randomMerchantKind } from '../src/sim/ext/merchants';
import { Rng } from '../src/core/rng';
import {
  executeTrade, inventoryValue, offerLabel, offersValue, requestMerchant, summonMerchant, updateTrade,
} from '../src/sim/trade';
import { advanceTime, createFakeGame, type FakeGame } from './simext.fake';

function run(g: FakeGame, seconds: number, dt = 0.25): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    advanceTime(g, dt);
    updateTrade(g.asGame(), dt);
  }
}

function setupTown(g: FakeGame) {
  const post = g.addBuilding('tradingPost', 20, 20);
  const trader = g.addCitizen({ profession: 'trader', workplaceId: post.id });
  post.workerIds.push(trader.id);
  const barn = g.addBuilding('storageBarn', 5, 5, { inventory: { tool: 30, herbs: 40, wheat: 200 } });
  const pile = g.addBuilding('stockpile', 5, 12, { inventory: { log: 200, stone: 100 } });
  return { post, barn, pile };
}

describe('merchant visits', () => {
  it('no merchant without a staffed trading post; the first visit is delayed', () => {
    const g = createFakeGame();
    g.state.trade.nextArrival = 0;
    run(g, 60);
    expect(g.state.trade.merchant).toBeNull();
    expect(g.state.trade.nextArrival).toBeGreaterThanOrEqual(1.5 * MONTH_SECONDS);
  });

  it('arrives with a staffed post, animates in, stays two months and leaves', () => {
    const g = createFakeGame();
    const { post } = setupTown(g);
    g.state.trade.nextArrival = 10;
    run(g, 11);
    const m = g.state.trade.merchant;
    expect(m).not.toBeNull();
    expect(m!.postId).toBe(post.id);
    expect(m!.offers.length).toBeGreaterThan(0);
    expect(g.emitted.some((e) => e.type === 'merchantArrived')).toBe(true);
    run(g, 10);
    expect(g.state.trade.merchant!.arrive).toBe(1);
    run(g, 2 * MONTH_SECONDS);
    expect(g.state.trade.merchant).toBeNull();
    expect(g.emitted.some((e) => e.type === 'merchantLeft')).toBe(true);
    expect(g.state.trade.nextArrival).toBeGreaterThanOrEqual(4 * MONTH_SECONDS - 1);
    expect(g.state.trade.nextArrival).toBeLessThanOrEqual(8 * MONTH_SECONDS);
  });

  it('never arrives in winter', () => {
    const g = createFakeGame();
    setupTown(g);
    g.state.time.elapsed = 9 * MONTH_SECONDS; // early winter
    g.state.trade.nextArrival = 1;
    run(g, 2 * MONTH_SECONDS);
    expect(g.state.trade.merchant).toBeNull();
    run(g, MONTH_SECONDS + 5); // spring
    expect(g.state.trade.merchant).not.toBeNull();
  });

  it('leaves if the trading post is destroyed', () => {
    const g = createFakeGame();
    const { post } = setupTown(g);
    summonMerchant(g.asGame(), 'goods');
    g.removeBuilding(post.id, 'fire');
    run(g, 1);
    expect(g.state.trade.merchant).toBeNull();
  });

  it('requested kind is used for the next visit and then cleared', () => {
    const g = createFakeGame();
    setupTown(g);
    requestMerchant(g.asGame(), 'seeds');
    expect(g.state.trade.requested).toBe('seeds');
    g.state.trade.nextArrival = 1;
    run(g, 2);
    expect(g.state.trade.merchant?.kind).toBe('seeds');
    expect(g.state.trade.requested).toBeNull();
  });
});

describe('offers', () => {
  it('unlock offers are only for items not yet unlocked', () => {
    const g = createFakeGame();
    g.state.unlocked = { crops: ['wheat', 'corn'], orchards: ['apple'], livestock: ['chicken'] };
    const rng = new Rng(9);
    for (let k = 0; k < 30; k++) {
      for (const kind of ['seeds', 'livestock', 'general'] as const) {
        for (const o of generateOffers(rng, g.state, kind)) {
          if (o.kind === 'crop') expect(['potato', 'beans']).toContain(o.id);
          if (o.kind === 'orchard') expect(['pear', 'cherry']).toContain(o.id);
          if (o.kind === 'livestock') expect(['sheep', 'cattle']).toContain(o.id);
          expect(o.amount).toBeGreaterThan(0);
          expect(o.price).toBeGreaterThan(0);
          if (o.kind === 'resource') {
            expect(RESOURCES[o.id as keyof typeof RESOURCES]).toBeDefined();
            expect(o.price).toBeGreaterThanOrEqual(RESOURCES[o.id as keyof typeof RESOURCES].value);
          } else {
            expect(o.amount).toBe(1);
          }
        }
      }
    }
  });

  it('seed/livestock merchants are not picked at random once everything is unlocked', () => {
    const g = createFakeGame();
    g.state.unlocked = { crops: ['wheat', 'corn', 'potato', 'beans'], orchards: ['apple', 'pear', 'cherry'], livestock: ['sheep', 'cattle', 'chicken'] };
    const rng = new Rng(1);
    for (let k = 0; k < 200; k++) expect(['general', 'food', 'goods']).toContain(randomMerchantKind(rng, g.state));
  });

  it('labels offers', () => {
    expect(offerLabel({ kind: 'crop', id: 'corn' })).toBe('Corn seeds');
    expect(offerLabel({ kind: 'orchard', id: 'pear' })).toBe('Pear saplings');
    expect(offerLabel({ kind: 'livestock', id: 'sheep' })).toBe('Sheep');
    expect(offerLabel({ kind: 'resource', id: 'tool' })).toBe('Tools');
  });
});

describe('executeTrade', () => {
  function withMerchant(offers: MerchantOffer[]) {
    const g = createFakeGame();
    const town = setupTown(g);
    summonMerchant(g.asGame(), 'general');
    g.state.trade.merchant!.offers = offers;
    return { g, ...town };
  }

  it('values inventories by def value', () => {
    expect(inventoryValue({ log: 10, tool: 2 })).toBe(10 * RESOURCES.log.value + 2 * RESOURCES.tool.value);
    expect(inventoryValue({})).toBe(0);
  });

  it('rejects without a merchant', () => {
    const g = createFakeGame();
    expect(executeTrade(g.asGame(), { log: 5 }, [{ offerIndex: 0, amount: 1 }]).ok).toBe(false);
  });

  it('rejects an offer worth less than the goods taken', () => {
    const { g } = withMerchant([{ kind: 'resource', id: 'iron', amount: 50, price: 3 }]);
    const res = executeTrade(g.asGame(), { log: 20 }, [{ offerIndex: 0, amount: 10 }]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/worth/);
  });

  it('rejects giving more than the town has', () => {
    const { g } = withMerchant([{ kind: 'resource', id: 'iron', amount: 50, price: 2 }]);
    const res = executeTrade(g.asGame(), { tool: 500 }, [{ offerIndex: 0, amount: 1 }]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Not enough Tools/);
  });

  it('rejects taking more than offered and bad indices', () => {
    const { g } = withMerchant([{ kind: 'resource', id: 'iron', amount: 5, price: 2 }]);
    expect(executeTrade(g.asGame(), { log: 100 }, [{ offerIndex: 0, amount: 6 }]).ok).toBe(false);
    expect(executeTrade(g.asGame(), { log: 100 }, [{ offerIndex: 3, amount: 1 }]).ok).toBe(false);
    expect(executeTrade(g.asGame(), { log: 100 }, []).ok).toBe(false);
    expect(executeTrade(g.asGame(), {}, [{ offerIndex: 0, amount: 1 }]).ok).toBe(false);
  });

  it('barters goods: takes ours, delivers theirs into storage and reduces the offer', () => {
    const { g, pile } = withMerchant([
      { kind: 'resource', id: 'iron', amount: 50, price: 2.5 },
      { kind: 'crop', id: 'corn', amount: 1, price: 200 },
    ]);
    const before = g.resourceTotals();
    const res = executeTrade(g.asGame(), { tool: 30, log: 50 }, [{ offerIndex: 0, amount: 20 }, { offerIndex: 1, amount: 1 }]);
    expect(res).toEqual({ ok: true });
    const after = g.resourceTotals();
    expect(after.tool).toBe(before.tool - 30);
    expect(after.log).toBe(before.log - 50);
    expect(after.iron).toBe(before.iron + 20);
    expect(g.state.unlocked.crops).toContain('corn');
    const m = g.state.trade.merchant!;
    expect(m.offers[0].amount).toBe(30);
    expect(m.offers[1].amount).toBe(0);
    expect(pile.inventory.iron ?? 0).toBeGreaterThanOrEqual(0);
    // Buying an owned unlock again fails.
    const again = executeTrade(g.asGame(), { log: 100, stone: 100, herbs: 40 }, [{ offerIndex: 1, amount: 1 }]);
    expect(again.ok).toBe(false);
    expect(offersValue(m, [{ offerIndex: 0, amount: 4 }])).toBe(10);
  });

  it('refuses a purchase that does not fit into storage', () => {
    const { g, pile, post } = withMerchant([{ kind: 'resource', id: 'stone', amount: 5000, price: 1.5 }]);
    post.inventory = { log: 3000 }; // trading post full
    const res = executeTrade(g.asGame(), { tool: 30, herbs: 40, wheat: 200 }, [{ offerIndex: 0, amount: 300 }]);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/room|space/);
    expect(g.resourceTotals().tool).toBe(30);
    expect(pile.inventory.stone).toBe(100);
  });

  it('rolls everything back if storing the purchase fails midway', () => {
    const { g, post } = withMerchant([{ kind: 'resource', id: 'iron', amount: 100, price: 2 }]);
    // the trading post itself is full, so the purchase has to go to the other storages
    post.inventory.log = 3000;
    const before = g.resourceTotals();
    const realAdd = g.addToStorage.bind(g);
    let calls = 0;
    g.addToStorage = (type, amount, x, z) => {
      calls++;
      // the purchase only half fits; restores (later calls) work normally
      return calls === 1 ? realAdd(type, Math.floor(amount / 2), x, z) : realAdd(type, amount, x, z);
    };
    const res = executeTrade(g.asGame(), { tool: 20 }, [{ offerIndex: 0, amount: 50 }]);
    expect(res.ok).toBe(false);
    const after = g.resourceTotals();
    expect(after.tool).toBe(before.tool);
    expect(after.iron).toBe(before.iron);
    expect(g.state.trade.merchant!.offers[0].amount).toBe(100);
  });

  it('unloads purchased goods into the trading post first (spec 3.9)', () => {
    const { g, post, barn } = withMerchant([{ kind: 'resource', id: 'herbs', amount: 50, price: 2 }]);
    const barnHerbs = barn.inventory.herbs ?? 0;
    const res = executeTrade(g.asGame(), { tool: 10 }, [{ offerIndex: 0, amount: 20 }]);
    expect(res.ok).toBe(true);
    expect(post.inventory.herbs).toBe(20);
    expect(barn.inventory.herbs ?? 0).toBe(barnHerbs);
  });
});
