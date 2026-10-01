/**
 * Focused scenario tests for individual professions and mechanics (fire fighting, workshops, farming, hunting,
 * fishing, markets, schools, demolition, roads/bridges, placement rules, equipment, deaths).
 */
import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS, TOOL_LIFETIME, YEAR_SECONDS } from '../src/core/constants';
import { BUILDINGS } from '../src/core/defs';
import type { Building, BuildingType, Citizen } from '../src/core/types';
import { Feature, Road, Terrain } from '../src/core/types';
import { igniteBuilding } from '../src/sim/disasters';
import { completeConstruction } from '../src/sim/core/buildings';
import { Game } from '../src/sim/game';
import { findPlacement, log, run, settings } from './simcore.helpers';

/** Place a building near (cx, cz) and finish it instantly. */
function buildNow(g: Game, type: BuildingType, cx: number, cz: number, opts: { w?: number; h?: number; maxR?: number } = {}): Building {
  const p = findPlacement(g, type, cx, cz, { allowClearing: true, maxR: opts.maxR ?? 40, w: opts.w, h: opts.h });
  if (!p) throw new Error(`no spot for ${type}`);
  const def = BUILDINGS[type];
  const b = g.placeBuilding(type, p.x, p.z, p.rot, def.resizable ? opts.w ?? def.size[0] : undefined, def.resizable ? opts.h ?? def.size[1] : undefined)!;
  const s = g.state;
  for (let z = b.z; z < b.z + b.h; z++) for (let x = b.x; x < b.x + b.w; x++) {
    const i = z * s.W + x;
    if (s.tiles.feature[i] !== Feature.None) g.removeFeature(i);
  }
  b.delivered = { ...b.cost };
  b.workRemaining = 0;
  completeConstruction(g, b);
  return b;
}

function newGame(over: Parameters<typeof settings>[0] = {}): Game {
  return Game.create(settings({ seed: 1234, difficulty: 'easy', mapSize: 'medium', disasters: false, ...over }));
}

function center(g: Game): { x: number; z: number } {
  return g.townCenter();
}

function adults(g: Game): Citizen[] {
  return g.state.citizens.filter((c) => c.age >= 10);
}

describe('simcore behaviours', () => {
  it('firefighters put out a fire covered by a well', () => {
    const g = newGame();
    const c = center(g);
    const house = g.state.buildings.find((b) => b.type === 'woodenHouse')!;
    buildNow(g, 'well', house.x + 1, house.z + 1, { maxR: 10 });
    run(g, 5);
    igniteBuilding(g, house.id);
    expect(house.fire).toBeGreaterThan(0);
    let maxFighters = 0;
    let t = 0;
    while (t < 90 && house.fire > 0 && g.getBuilding(house.id)?.state === 'active') {
      g.step(0.25);
      t += 0.25;
      maxFighters = Math.max(maxFighters, house.fireFighters);
    }
    log(`fire: fighters=${maxFighters} fire=${house.fire.toFixed(2)} after ${t}s state=${g.getBuilding(house.id)?.state}`);
    expect(maxFighters).toBeGreaterThan(2);
    expect(house.fire).toBe(0);
    void c;
    expect(g.validate()).toEqual([]);
  });

  it('woodcutter turns logs into firewood and it reaches storage', () => {
    const g = newGame();
    const c = center(g);
    const wc = buildNow(g, 'woodcutter', c.x, c.z);
    const before = g.resourceTotals().firewood;
    run(g, 150);
    const made = wc.producedThisYear.firewood ?? 0;
    log(`woodcutter made ${made} firewood; storage ${before} -> ${g.resourceTotals().firewood}`);
    expect(made).toBeGreaterThan(30);
    expect(g.validate()).toEqual([]);
  });

  it('farmers plant in spring and harvest before frost', () => {
    const g = newGame();
    const c = center(g);
    const f = buildNow(g, 'cropField', c.x, c.z, { w: 6, h: 6 });
    g.setPriority(f.id, true);
    run(g, 2.5 * MONTH_SECONDS);
    const planted = f.fieldTiles!.filter((t) => t.stage === 2 || t.stage === 3).length;
    log(`field planted tiles after 2.5 months: ${planted}/36`);
    expect(planted).toBeGreaterThan(30);
    run(g, 7 * MONTH_SECONDS);
    const made = f.producedThisYear.wheat ?? 0;
    log(`field harvested ${made} wheat`);
    expect(made).toBeGreaterThan(200);
    expect(g.validate()).toEqual([]);
  });

  it('hunters kill deer; fishermen catch fish; gatherers gather', () => {
    const g = newGame({ seed: 777 });
    const s = g.state;
    // hunting cabin next to the densest deer spot
    let best = { x: 0, z: 0, n: -1 };
    for (const a of s.animals) {
      const n = s.animals.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 12).length;
      if (n > best.n && g.sameRegionSafe(Math.floor(a.x), Math.floor(a.z), Math.floor(center(g).x), Math.floor(center(g).z))) best = { x: a.x, z: a.z, n };
    }
    const cabin = buildNow(g, 'hunterCabin', best.x, best.z, { maxR: 20 });
    g.setPriority(cabin.id, true);
    // fishing dock on the nearest shore
    let dock: Building | null = null;
    for (let r = 10; r <= 70 && !dock; r += 10) {
      try {
        dock = buildNow(g, 'fishingDock', center(g).x, center(g).z, { maxR: r });
      } catch {
        dock = null;
      }
    }
    if (dock) g.setPriority(dock.id, true);
    const hut = buildNow(g, 'gathererHut', center(g).x + 10, center(g).z + 10, { maxR: 30 });
    run(g, 4 * MONTH_SECONDS);
    log(`hunter made ${JSON.stringify(cabin.producedThisYear)}; dock ${dock ? JSON.stringify(dock.producedThisYear) : 'n/a'}; hut ${JSON.stringify(hut.producedThisYear)}`);
    expect(cabin.producedThisYear.venison ?? 0).toBeGreaterThan(0);
    if (dock) expect(dock.producedThisYear.fish ?? 0).toBeGreaterThan(0);
    const gathered = (hut.producedThisYear.berries ?? 0) + (hut.producedThisYear.mushrooms ?? 0) + (hut.producedThisYear.roots ?? 0);
    expect(gathered).toBeGreaterThan(0);
    expect(g.validate()).toEqual([]);
  });

  it('market vendors stock the market and households use it', () => {
    const g = newGame();
    const c = center(g);
    const m = buildNow(g, 'market', c.x, c.z, { maxR: 25 });
    run(g, 120);
    const food = Object.entries(m.inventory).filter(([r]) => ['wheat', 'beans', 'berries', 'venison', 'corn', 'potato'].includes(r)).reduce((a, [, v]) => a + (v ?? 0), 0);
    log(`market stock ${JSON.stringify(m.inventory)}`);
    expect(food).toBeGreaterThan(20);
    expect(m.inventory.firewood ?? 0).toBeGreaterThan(0);
    expect(g.validate()).toEqual([]);
  });

  it('children become students at a school with a teacher', () => {
    const g = newGame();
    const c = center(g);
    const school = buildNow(g, 'school', c.x, c.z, { maxR: 20 });
    const kid = g.state.citizens.find((x) => x.age < 10)!;
    kid.age = 9.99;
    run(g, 30);
    log(`kid ${kid.name} is ${kid.profession}, teacher count ${school.workerIds.length}`);
    expect(school.workerIds.length).toBeGreaterThan(0);
    expect(kid.profession).toBe('student');
    // attends class during the day
    let studied = false;
    for (let i = 0; i < 400 && !studied; i++) {
      g.step(0.25);
      if (kid.activity === 'studying') studied = true;
    }
    expect(studied).toBe(true);
  });

  it('demolition returns half the materials; cancelling refunds deliveries', () => {
    const g = newGame();
    const c = center(g);
    const house = buildNow(g, 'woodenHouse', c.x, c.z);
    const logs0 = g.resourceTotals().log;
    g.demolish(house.id);
    expect(house.state).toBe('demolishing');
    run(g, 90);
    expect(g.getBuilding(house.id)).toBeUndefined();
    const logs1 = g.resourceTotals().log;
    log(`demolish: logs ${logs0} -> ${logs1}`);
    expect(logs1).toBeGreaterThanOrEqual(logs0 + 8 - 20); // +8 refund (others may consume logs meanwhile)
    const p = findPlacement(g, 'woodenHouse', c.x, c.z)!;
    const site = g.placeBuilding('woodenHouse', p.x, p.z, p.rot)!;
    run(g, 20);
    const delivered = (site.delivered.log ?? 0) + (site.delivered.stone ?? 0);
    const before = g.resourceTotals().log + g.resourceTotals().stone;
    g.demolish(site.id);
    const after = g.resourceTotals().log + g.resourceTotals().stone;
    expect(g.getBuilding(site.id)).toBeUndefined();
    expect(after - before).toBeCloseTo(delivered, 5);
    run(g, 20);
    expect(g.validate()).toEqual([]);
  });

  it('roads: dirt is free, stone costs stone, bridges cross shallow water and reconnect regions', () => {
    const g = newGame();
    const s = g.state;
    const c = center(g);
    const tiles: number[] = [];
    for (let x = Math.floor(c.x) - 5; x < Math.floor(c.x) + 5; x++) tiles.push(Math.floor(c.z) + 12 >= s.H ? 0 : (Math.floor(c.z) + 12) * s.W + x);
    const chk = g.checkRoad(tiles, 'dirt');
    const placed = g.placeRoad(chk.ok, 'dirt');
    expect(placed).toBeGreaterThan(0);
    const stone0 = g.resourceTotals().stone;
    const up = g.placeRoad(chk.ok, 'stone');
    expect(g.resourceTotals().stone).toBeCloseTo(stone0 - up, 5);
    expect(s.tiles.road[chk.ok[0]]).toBe(Road.Stone);
    // bridge: find a shallow water tile
    let water = -1;
    for (let i = 0; i < s.W * s.H && water < 0; i++) if (s.tiles.terrain[i] === Terrain.Water) water = i;
    if (water >= 0) {
      const n = g.placeRoad([water], 'dirt');
      expect(n).toBe(1);
      expect(s.tiles.road[water]).toBe(Road.Bridge);
      expect(s.tiles.region[water]).toBeGreaterThan(0);
      expect(g.removeRoad([water])).toBe(1);
    }
    expect(g.removeRoad(chk.ok)).toBe(chk.ok.length);
  });

  it('placement rules: shore, mountain, blocked entrances, zone sizes', () => {
    const g = newGame({ terrain: 'mountains', seed: 99 });
    const s = g.state;
    const c = center(g);
    // dock on dry land in the middle of town is rejected
    const dry = g.checkPlacement('fishingDock', Math.floor(c.x) - 2, Math.floor(c.z) - 2, 0);
    expect(dry.ok).toBe(false);
    // zones out of range
    expect(g.checkPlacement('cropField', Math.floor(c.x), Math.floor(c.z), 0, 2, 2).ok).toBe(false);
    expect(g.checkPlacement('cropField', Math.floor(c.x), Math.floor(c.z), 0, 30, 30).ok).toBe(false);
    // mine must touch a mountain
    const mine = findPlacement(g, 'mine', c.x, c.z, { maxR: 70, allowClearing: true, gap: 0 });
    if (mine) {
      const chk = g.checkPlacement('mine', mine.x, mine.z, mine.rot);
      expect(chk.ok).toBe(true);
    }
    // cannot place on top of an existing building
    const barn = s.buildings.find((b) => b.type === 'storageBarn')!;
    expect(g.checkPlacement('woodenHouse', barn.x, barn.z, 0).ok).toBe(false);
    // cannot block the barn's entrance
    const blk = g.checkPlacement('well', barn.doorX, barn.doorZ, 0);
    expect(blk.ok).toBe(false);
  });

  it('workers without tools fetch one from storage; coats in winter', () => {
    const g = newGame();
    for (const c of adults(g)) c.toolWear = 0;
    const tools0 = g.resourceTotals().tool;
    run(g, 60);
    const equipped = adults(g).filter((c) => c.toolWear > TOOL_LIFETIME * 0.9).length;
    log(`tools: ${tools0} -> ${g.resourceTotals().tool}, equipped ${equipped}/${adults(g).length}`);
    expect(equipped).toBeGreaterThan(adults(g).length / 2);
    for (const c of adults(g)) c.coatWear = 0;
    run(g, 9 * MONTH_SECONDS);
    const coats = adults(g).filter((c) => c.coatWear > 0).length;
    expect(coats).toBeGreaterThan(adults(g).length / 2);
    expect(g.validate()).toEqual([]);
  });

  it('killCitizen: grief, graves, unburied, links cleaned', () => {
    const g = newGame();
    const c = center(g);
    const cem = buildNow(g, 'cemetery', c.x, c.z, { w: 3, h: 3 });
    const victim = g.state.citizens.find((x) => x.spouseId >= 0 && x.childIds.length > 0)!;
    const spouse = g.getCitizen(victim.spouseId)!;
    const kid = g.getCitizen(victim.childIds[0])!;
    g.killCitizen(victim.id, 'accident');
    expect(g.getCitizen(victim.id)).toBeUndefined();
    expect(spouse.spouseId).toBe(-1);
    expect(spouse.grief).toBe(100);
    expect(kid.grief).toBe(100);
    expect(cem.graves).toBe(1);
    expect(g.state.tally.deaths.accident).toBe(1);
    // fill the cemetery, then the dead remain unburied
    const cap = Math.floor(9 * (BUILDINGS.cemetery.gravesPerTile ?? 0.5));
    const others = g.state.citizens.filter((x) => x !== spouse).slice(0, cap + 1);
    const unb0 = g.state.unburied;
    for (const o of others) g.killCitizen(o.id, 'disease');
    expect(cem.graves).toBe(cap);
    expect(g.state.unburied).toBeGreaterThan(unb0);
    expect(g.validate()).toEqual([]);
  });

  it('population 0 ends the game', () => {
    const g = newGame({ difficulty: 'hard' });
    let over = false;
    g.events.on('gameOver', () => { over = true; });
    for (const c of [...g.state.citizens]) g.killCitizen(c.id, 'disease');
    expect(g.state.gameOver).toBe(true);
    expect(over).toBe(true);
    g.update(0.1);
    g.step(0.25);
  });

  it('births happen in family homes over a few years', () => {
    const g = newGame();
    // give every family a home (easy starts with 4 houses for 7 families, whose teenagers still live at home)
    const c = center(g);
    for (let k = 0; k < 4; k++) buildNow(g, 'woodenHouse', c.x, c.z);
    run(g, 2 * YEAR_SECONDS, 0.5);
    log(`births in 2 years: ${g.state.tally.births}`);
    expect(g.state.tally.births).toBeGreaterThan(0);
  });
});
