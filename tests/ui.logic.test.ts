import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../src/core/defs';
import type { Building, BuildingType, MerchantOffer } from '../src/core/types';
import type { UIContext } from '../src/ui/context';
import { DataCache, emptyTotals } from '../src/ui/data';
import {
  dateLabel, fmtCompact, fmtInt, fmtMonths, fmtRelTime, fmtSigned, fmtSignedDec, fmtTemp, monthName, pct, plural,
} from '../src/ui/format';
import { toolKey } from '../src/ui/hud/toolbar';
import { localInventoryValue } from '../src/ui/sim-bridge';
import { adjustProfession, workplacesFor } from '../src/ui/windows/professions';
import { offerInfo } from '../src/ui/windows/trade';
import type { Command } from '../src/net/types';
import type { Game } from '../src/sim/game';
import { PendingValues } from '../src/ui/pending';

describe('format', () => {
  it('formats integers with separators and a real minus sign', () => {
    expect(fmtInt(0)).toBe('0');
    expect(fmtInt(999)).toBe('999');
    expect(fmtInt(1234.9)).toBe('1,234');
    expect(fmtInt(1234567)).toBe('1,234,567');
    expect(fmtInt(-42)).toBe('−42');
    expect(fmtInt(NaN)).toBe('–');
  });

  it('formats compact numbers', () => {
    expect(fmtCompact(9999)).toBe('9,999');
    expect(fmtCompact(12345)).toBe('12.3k');
    expect(fmtCompact(456789)).toBe('457k');
    expect(fmtCompact(1_234_567)).toBe('1.2M');
  });

  it('formats signed values', () => {
    expect(fmtSigned(3.4)).toBe('+3');
    expect(fmtSigned(-2)).toBe('−2');
    expect(fmtSigned(0)).toBe('0');
    expect(fmtSignedDec(7.5)).toBe('+7.5');
    expect(fmtSignedDec(-15)).toBe('−15');
    expect(fmtSignedDec(0.01)).toBe('0');
  });

  it('formats percentages, temperatures and dates', () => {
    expect(pct(0.456)).toBe('46%');
    expect(fmtTemp(-4.6)).toBe('−5°C');
    expect(fmtTemp(18.2)).toBe('18°C');
    expect(monthName(0)).toBe('Early Spring');
    expect(monthName(13)).toBe('Spring');
    expect(monthName(-1)).toBe('Late Winter');
    expect(dateLabel(3, 7)).toBe('Year 3, Autumn');
  });

  it('formats game durations in months/days', () => {
    expect(fmtMonths(60 * 3)).toBe('3 months');
    expect(fmtMonths(60)).toBe('1 month');
    expect(fmtMonths(30)).toBe('15 days');
    expect(fmtMonths(1)).toBe('1 day');
  });

  it('formats relative wall-clock times and plurals', () => {
    const now = 1_000_000_000;
    expect(fmtRelTime(now - 10_000, now)).toBe('just now');
    expect(fmtRelTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(fmtRelTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(fmtRelTime(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(plural(1, 'person', 'people')).toBe('1 person');
    expect(plural(3, 'person', 'people')).toBe('3 people');
  });
});

describe('trade helpers', () => {
  it('values inventories from resource definitions', () => {
    expect(localInventoryValue({ log: 10, tool: 2 })).toBe(10 * 1 + 2 * 8);
    expect(localInventoryValue({})).toBe(0);
  });

  it('describes merchant offers', () => {
    const seed: MerchantOffer = { kind: 'crop', id: 'corn', amount: 1, price: 50 };
    expect(offerInfo(seed)).toMatchObject({ name: 'Corn seeds', unlock: true });
    const sap: MerchantOffer = { kind: 'orchard', id: 'cherry', amount: 1, price: 50 };
    expect(offerInfo(sap)).toMatchObject({ name: 'Cherry saplings', unlock: true });
    const cows: MerchantOffer = { kind: 'livestock', id: 'cattle', amount: 1, price: 50 };
    expect(offerInfo(cows)).toMatchObject({ name: 'Cattle', icon: '🐄', unlock: true });
    const res: MerchantOffer = { kind: 'resource', id: 'tool', amount: 20, price: 9 };
    expect(offerInfo(res)).toMatchObject({ name: 'Tools', unlock: false });
  });
});

describe('toolbar', () => {
  it('builds stable tool keys', () => {
    expect(toolKey({ kind: 'build', type: 'woodenHouse' })).toBe('build:woodenHouse');
    expect(toolKey({ kind: 'road', road: 'stone' })).toBe('road:stone');
    expect(toolKey({ kind: 'clear', filter: 'trees' })).toBe('clear:trees');
    expect(toolKey({ kind: 'demolish' })).toBe('demolish');
  });
});

// ---- professions distribution & data cache with a tiny fake game -------------------------------

function mkBuilding(id: number, type: BuildingType, desired: number, state: Building['state'] = 'active'): Building {
  return {
    id, type, x: 0, z: 0, w: 3, h: 3, rotation: 0, doorX: 0, doorZ: 0, state, progress: 1, cost: {}, delivered: {}, incoming: {},
    workRemaining: 0, priority: false, paused: false, workersDesired: desired, workerIds: [], residentIds: [], inventory: {},
    reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0, smoking: false, producedThisYear: {}, producedLastYear: {}, builtAt: 0,
  };
}

function fakeUi(buildings: Building[]): UIContext {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const game = {
    state: { buildings },
    setWorkers(id: number, n: number) {
      const b = byId.get(id)!;
      b.workersDesired = Math.max(0, Math.min(BUILDINGS[b.type].maxWorkers, n));
    },
    resourceTotals: () => ({ ...emptyTotals(), log: 50, stone: 5, wheat: 30, apple: 12 }),
    populationSummary: () => { throw new Error('not implemented'); },
  } as unknown as Game;
  const data = new DataCache(() => game);
  // solo semantics: commands apply immediately (no pending values)
  const dispatch = (cmd: Command) => {
    if (cmd.op !== 'workers') return { ok: false, reason: 'unsupported' };
    (game as unknown as { setWorkers(id: number, n: number): void }).setWorkers(cmd.id, cmd.n);
    return { ok: true };
  };
  return { game, data, dispatch, pending: new PendingValues() } as unknown as UIContext;
}

describe('professions', () => {
  it('lists workplaces of a profession, excluding ruins', () => {
    const ui = fakeUi([mkBuilding(1, 'cropField', 2), mkBuilding(2, 'orchard', 1), mkBuilding(3, 'cropField', 0, 'ruin'), mkBuilding(4, 'quarry', 2)]);
    expect(workplacesFor(ui, 'farmer').map((b) => b.id)).toEqual([1, 2]);
  });

  it('adds workers to the least staffed workplace and removes from the most staffed', () => {
    const a = mkBuilding(1, 'gathererHut', 4); // max 4
    const b = mkBuilding(2, 'gathererHut', 1);
    const ui = fakeUi([a, b]);
    expect(adjustProfession(ui, 'gatherer', 1)).toBe(true);
    expect(b.workersDesired).toBe(2);
    expect(adjustProfession(ui, 'gatherer', 2)).toBe(true);
    expect(b.workersDesired).toBe(4);
    expect(adjustProfession(ui, 'gatherer', 1)).toBe(false); // everything full
    expect(adjustProfession(ui, 'gatherer', -3)).toBe(true);
    expect(a.workersDesired + b.workersDesired).toBe(5);
    expect(adjustProfession(ui, 'gatherer', -20)).toBe(true);
    expect(a.workersDesired + b.workersDesired).toBe(0);
    expect(adjustProfession(ui, 'gatherer', -1)).toBe(false);
  });
});

describe('DataCache', () => {
  it('memoizes totals per tick and derives food', () => {
    const ui = fakeUi([]);
    const t1 = ui.data.totals();
    expect(ui.data.totals()).toBe(t1);
    expect(ui.data.food()).toBe(42);
    expect(ui.data.canAfford({ log: 16, stone: 5 })).toBe(true);
    expect(ui.data.canAfford({ log: 16, stone: 8 })).toBe(false);
    ui.data.invalidate();
    expect(ui.data.totals()).not.toBe(t1);
  });

  it('falls back to neutral data when a game query throws', () => {
    const ui = fakeUi([]);
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(ui.data.population().total).toBe(0);
    } finally {
      console.warn = origWarn;
    }
  });

  it('summarises housing from active houses', () => {
    const h1 = mkBuilding(1, 'woodenHouse', 0);
    h1.residentIds = [10, 11];
    const h2 = mkBuilding(2, 'woodenHouse', 0);
    const h3 = mkBuilding(3, 'stoneHouse', 0, 'construction');
    const ui = fakeUi([h1, h2, h3]);
    expect(ui.data.housing()).toEqual({ capacity: 10, residents: 2, houses: 2, emptyHouses: 1, planned: 1 });
  });
});
