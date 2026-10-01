/**
 * Integration: run a real game for a few years with disasters on and check that the sim-ext systems keep every
 * value sane. Skips itself while Game.create is not implemented yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MONTH_SECONDS, YEAR_SECONDS } from '../src/core/constants';
import type { BuildingType, GameState, NewGameSettings, Rotation } from '../src/core/types';
import { igniteBuilding, spawnTornado, startOutbreak } from '../src/sim/disasters';
import { Game } from '../src/sim/game';
import { summonNomads, respondToNomads } from '../src/sim/nomads';
import { summonMerchant, executeTrade } from '../src/sim/trade';
import { happinessFactors, healthFactors, wellbeingEfficiency } from '../src/sim/wellbeing';

const SETTINGS: NewGameSettings = {
  seed: 20240917,
  townName: 'Ashbrook',
  mapSize: 'small',
  terrain: 'valleys',
  climate: 'fair',
  difficulty: 'easy',
  disasters: true,
};

function tryCreate(settings: NewGameSettings): Game | null {
  try {
    return Game.create(settings);
  } catch (err) {
    if (err instanceof Error && /not implemented/.test(err.message)) return null;
    throw err;
  }
}

function townCenter(s: GameState): [number, number] {
  if (s.buildings.length === 0) return [s.W / 2, s.H / 2];
  let x = 0;
  let z = 0;
  for (const b of s.buildings) {
    x += b.x + b.w / 2;
    z += b.z + b.h / 2;
  }
  return [x / s.buildings.length, z / s.buildings.length];
}

/** Place a building at the first valid spot spiralling out from the town center. */
function placeNear(game: Game, type: BuildingType, maxR = 40, w?: number, h?: number): boolean {
  const [cx, cz] = townCenter(game.state);
  for (let r = 3; r <= maxR; r++) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(ang) * r);
      const z = Math.round(cz + Math.sin(ang) * r);
      for (const rot of [0, 1, 2, 3] as Rotation[]) {
        if (game.checkPlacement(type, x, z, rot, w, h).ok) {
          return game.placeBuilding(type, x, z, rot, w, h) !== null;
        }
      }
    }
  }
  return false;
}

function assertSane(game: Game): void {
  const s = game.state;
  for (const c of s.citizens) {
    expect(Number.isFinite(c.health), `health of ${c.name}`).toBe(true);
    expect(c.health).toBeGreaterThanOrEqual(0);
    expect(c.health).toBeLessThanOrEqual(100);
    expect(c.happiness).toBeGreaterThanOrEqual(0);
    expect(c.happiness).toBeLessThanOrEqual(100);
    expect(c.education).toBeGreaterThanOrEqual(0);
    expect(c.education).toBeLessThanOrEqual(1);
    expect(c.sick).toBeGreaterThanOrEqual(0);
    expect(c.sick).toBeLessThanOrEqual(1);
    expect(c.grief).toBeGreaterThanOrEqual(0);
    const e = wellbeingEfficiency(c);
    expect(e).toBeGreaterThanOrEqual(0.35);
    expect(e).toBeLessThanOrEqual(1.3);
  }
  for (const b of s.buildings) {
    expect(b.fire).toBeGreaterThanOrEqual(0);
    expect(b.fire).toBeLessThanOrEqual(1);
  }
  for (const h of s.history) {
    for (const v of Object.values(h)) expect(Number.isFinite(v)).toBe(true);
    expect(h.avgHealth).toBeGreaterThanOrEqual(0);
    expect(h.avgHealth).toBeLessThanOrEqual(100);
    expect(h.avgHappiness).toBeGreaterThanOrEqual(0);
    expect(h.avgHappiness).toBeLessThanOrEqual(100);
    expect(h.avgEducation).toBeGreaterThanOrEqual(0);
    expect(h.avgEducation).toBeLessThanOrEqual(1);
  }
  expect(s.unburied).toBeGreaterThanOrEqual(0);
  if (s.trade.merchant) {
    expect(s.trade.merchant.arrive).toBeGreaterThanOrEqual(0);
    expect(s.trade.merchant.arrive).toBeLessThanOrEqual(1);
  }
}

/** sim-core guards module calls and logs "[sim] <name> threw" — collect those for sim-ext modules. */
const SIM_EXT_MODULES = /updateWellbeing|updateDisasters|updateTrade|updateNomads|updateStats|executeTrade|requestMerchant|respondToNomads|wellbeingEfficiency/;

describe('sim-ext integration (real Game)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs several years with disasters on and keeps wellbeing values sane', (ctx) => {
    const game = tryCreate(SETTINGS);
    if (!game) {
      ctx.skip();
      return;
    }
    const moduleErrors: unknown[][] = [];
    const realError = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && SIM_EXT_MODULES.test(args[0])) moduleErrors.push(args);
      realError(...args);
    });
    const s = game.state;
    // A sensible little build order around the start.
    for (let i = 0; i < 4; i++) placeNear(game, 'woodenHouse');
    placeNear(game, 'gathererHut');
    placeNear(game, 'woodcutter');
    placeNear(game, 'well');
    placeNear(game, 'hunterCabin');
    placeNear(game, 'cemetery', 40, 4, 4);
    placeNear(game, 'townHall');
    placeNear(game, 'hospital');
    placeNear(game, 'cropField', 40, 6, 6);
    game.setBuilders(4);

    const dt = 0.25;
    let firedDebug = false;
    let tornadoDebug = false;
    let outbreakDebug = false;
    const years = 3;
    const steps = Math.round((years * YEAR_SECONDS) / dt);
    const t0 = Date.now();
    for (let i = 0; i < steps; i++) {
      game.step(dt);
      if (s.gameOver) break;
      const el = s.time.elapsed;
      // Exercise the event paths on the real game.
      if (!firedDebug && el > 6 * MONTH_SECONDS) {
        const house = s.buildings.find((b) => b.type === 'woodenHouse' && b.state === 'active');
        if (house) igniteBuilding(game, house.id);
        firedDebug = true;
      }
      if (!outbreakDebug && el > 14 * MONTH_SECONDS) {
        startOutbreak(game);
        outbreakDebug = true;
      }
      if (!tornadoDebug && el > 20 * MONTH_SECONDS) {
        spawnTornado(game);
        tornadoDebug = true;
      }
      if (i % 400 === 0) assertSane(game);
    }
    const ms = Date.now() - t0;
    assertSane(game);

    // Monthly history (one per month + the initial sample), unless the town died out.
    if (!s.gameOver) expect(s.history.length).toBeGreaterThanOrEqual(years * 12);
    expect(s.messages.length).toBeGreaterThan(0);
    // Factor tooltips work on real citizens.
    for (const c of s.citizens.slice(0, 5)) {
      expect(healthFactors(game, c)[0].label).toBe('Base health');
      expect(happinessFactors(game, c)[0].label).toBe('Base happiness');
    }
    // Nomads & trade on the real game.
    if (summonNomads(game, 4)) {
      const before = s.citizens.length;
      respondToNomads(game, true);
      expect(s.citizens.length).toBe(before + 4);
    }
    if (summonMerchant(game, 'goods')) {
      const res = executeTrade(game, { log: 1 }, [{ offerIndex: 0, amount: 1 }]);
      expect(typeof res.ok).toBe('boolean');
    }
    for (let i = 0; i < 200; i++) game.step(dt);
    assertSane(game);
    expect(moduleErrors).toEqual([]);
    console.log(`[simext.integration] ${years}y in ${ms} ms, pop ${s.citizens.length}, history ${s.history.length}, messages ${s.messages.length}`);
  });
});
