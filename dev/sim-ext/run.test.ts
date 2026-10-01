/** Dev probe (not part of the test suite: lives under dev/): run a real game and dump sim-ext observations. */
import { it } from 'vitest';
import { YEAR_SECONDS, MONTH_SECONDS } from '../../src/core/constants';
import type { Rotation, BuildingType } from '../../src/core/types';
import { Game } from '../../src/sim/game';
import { igniteBuilding, startOutbreak } from '../../src/sim/disasters';
import { summonMerchant, executeTrade } from '../../src/sim/trade';
import { summonNomads, respondToNomads } from '../../src/sim/nomads';
import { happinessFactors, healthFactors } from '../../src/sim/wellbeing';

function placeNear(game: Game, type: BuildingType, w?: number, h?: number): boolean {
  const s = game.state;
  let cx = 0, cz = 0;
  for (const b of s.buildings) { cx += b.x + b.w / 2; cz += b.z + b.h / 2; }
  cx /= Math.max(1, s.buildings.length); cz /= Math.max(1, s.buildings.length);
  for (let r = 3; r <= 40; r++) for (let a = 0; a < 16; a++) {
    const x = Math.round(cx + Math.cos((a / 16) * Math.PI * 2) * r), z = Math.round(cz + Math.sin((a / 16) * Math.PI * 2) * r);
    for (const rot of [0, 1, 2, 3] as Rotation[]) if (game.checkPlacement(type, x, z, rot, w, h).ok) return game.placeBuilding(type, x, z, rot, w, h) !== null;
  }
  return false;
}

it('probe real game', () => {
  const game = Game.create({ seed: Number(process.env.SEED ?? 20240917), townName: 'Ashbrook', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: (process.env.DIFF as 'easy') ?? 'medium', disasters: true });
  const s = game.state;
  console.log('start pop', s.citizens.length, 'buildings', s.buildings.map((b) => b.type).join(','));
  const plan: [BuildingType, number?, number?][] = process.env.PLAN === 'big'
    ? [['woodenHouse'], ['woodenHouse'], ['gathererHut'], ['woodcutter'], ['woodenHouse'], ['hunterCabin'], ['well'], ['cemetery', 4, 4], ['cropField', 8, 8], ['woodenHouse'], ['townHall'], ['herbalist'], ['hospital'], ['chapel'], ['school']]
    : [['gathererHut'], ['hunterCabin'], ['fishingDock'], ['woodcutter'], ['tradingPost']];
  for (const [t, w, h] of plan) console.log('place', t, placeNear(game, t, w, h));
  game.setBuilders(3);
  const dt = 0.25;
  const years = Number(process.env.YEARS ?? 4);
  let lastMsg = 0;
  let ignited = false;
  for (let i = 0; i < (years * YEAR_SECONDS) / dt; i++) {
    game.step(dt);
    if (!ignited && s.time.elapsed > 8 * MONTH_SECONDS) {
      const h = s.buildings.find((b) => b.type === 'woodenHouse' && b.state === 'active');
      if (h) { igniteBuilding(game, h.id); ignited = true; }
    }
    if (s.time.monthProgress < dt / MONTH_SECONDS && s.time.month % 3 === 0) {
      const n = s.citizens.length || 1;
      const avg = (f: (c: typeof s.citizens[0]) => number) => (s.citizens.reduce((a, c) => a + f(c), 0) / n).toFixed(1);
      console.log(`Y${s.time.year} M${s.time.month} pop ${s.citizens.length} health ${avg((c) => c.health)} happy ${avg((c) => c.happiness)} food ${avg((c) => c.food)} warmth ${avg((c) => c.warmth)} sick ${s.citizens.filter((c) => c.sick > 0).length} homeless ${s.citizens.filter((c) => c.homeId < 0).length} storedFood ${Math.round(game.foodTotal())} unburied ${s.unburied}`);
    }
    if (s.gameOver) break;
    if (i === Math.round((10 * MONTH_SECONDS) / dt)) {
      const post = s.buildings.find((b) => b.type === 'tradingPost');
      console.log('trading post state', post?.state, 'workers', post?.workerIds.length, 'merchant', !!s.trade.merchant, 'nextArrival', s.trade.nextArrival.toFixed(0));
      if (!s.trade.merchant && summonMerchant(game, 'seeds')) {
        const m = s.trade.merchant!;
        console.log('merchant', m.name, m.kind, JSON.stringify(m.offers));
        const idx = m.offers.findIndex((o) => o.kind === 'crop');
        if (idx >= 0) console.log('trade result', JSON.stringify(executeTrade(game, { tool: 10, log: Math.ceil(m.offers[idx].price) }, [{ offerIndex: idx, amount: 1 }])), JSON.stringify(s.unlocked));
      }
      startOutbreak(game);
    }
    if (i === Math.round((11 * MONTH_SECONDS) / dt)) {
      // nomads need a town hall; fake one only for this probe if none is active
      console.log('nomads summon', summonNomads(game, 5), JSON.stringify(s.nomads));
      if (s.nomads) respondToNomads(game, true);
    }
  }
  for (const m of s.messages.slice(lastMsg)) console.log(`  [Y${m.year} M${m.month}] ${m.severity}: ${m.text}`);
  lastMsg = s.messages.length;
  const c = s.citizens[0];
  if (c) {
    console.log('sample citizen', c.name, 'health', c.health.toFixed(1), JSON.stringify(healthFactors(game, c)));
    console.log('happiness', c.happiness.toFixed(1), JSON.stringify(happinessFactors(game, c)));
  }
  console.log('history', s.history.length, JSON.stringify(s.history.at(-1)));
}, 600000);
