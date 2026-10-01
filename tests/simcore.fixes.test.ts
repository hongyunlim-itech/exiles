/**
 * Regressions for review findings in buildings, jobs, farming and production: pasture switching, double culls,
 * cut-off workers, cancelled/paused sites, demolished storage, salvage from ruins, food without a barn, field
 * ripening with few farmers, fishing trips, protected school staff, births and food, save/load determinism.
 */
import { describe, expect, it } from 'vitest';
import { MONTH_SECONDS, YEAR_SECONDS } from '../src/core/constants';
import { BUILDINGS, CROPS, ORCHARDS } from '../src/core/defs';
import { Feature, Road } from '../src/core/types';
import { RUIN_SALVAGE } from '../src/sim/core/buildings';
import { updateBirths } from '../src/sim/core/citizens';
import { pastureCapacity } from '../src/sim/core/farming';
import { updateHousing } from '../src/sim/core/households';
import { brainOf } from '../src/sim/core/tasks';
import { planFisherman } from '../src/sim/core/work/gather';
import { invTotal } from '../src/sim/core/util';
import { Bot } from './simcore.bot';
import { couple, emptyTown, fixtureSettings, forceBuild, Game, spawnAt, steps } from './simcore.fixtures';

describe('pastures', () => {
  it('switching livestock back and forth creates neither meat nor animals', () => {
    const g = Game.create(fixtureSettings({ difficulty: 'easy' }));
    const p = forceBuild(g, 'pasture', undefined, undefined, 6, 6);
    const start = p.livestock!.count;
    for (let k = 0; k < 20; k++) {
      g.setCrop(p.id, 'sheep');
      g.setCrop(p.id, 'chicken');
    }
    expect(invTotal(p.inventory)).toBe(0);
    expect(p.livestock!.count).toBeLessThanOrEqual(Math.max(2, start));
  });

  it('two herders culling at once always leave a breeding pair', () => {
    const g = Game.create(fixtureSettings({ difficulty: 'easy' }));
    g.state.unlocked.livestock.push('cattle');
    const p = forceBuild(g, 'pasture', undefined, undefined, 6, 7);
    g.setCrop(p.id, 'cattle');
    p.livestock!.count = 3;
    expect(pastureCapacity(p)).toBeGreaterThanOrEqual(4);
    g.setWorkers(p.id, 2);
    steps(g, 90);
    expect(p.livestock!.count).toBeGreaterThanOrEqual(2);
  });
});

describe('jobs', () => {
  it('workers cut off from their workplace are released to laborer work', () => {
    const g = Game.create(fixtureSettings({ seed: 777 }));
    const wc = forceBuild(g, 'woodcutter');
    g.setWorkers(wc.id, 2);
    steps(g, 3);
    expect(wc.workerIds.length).toBe(2);
    // move the workers to walkable ground in another region (as if their bridge had been removed)
    const s = g.state;
    let spot = -1;
    for (let i = 0; i < s.W * s.H && spot < 0; i++) {
      const x = i % s.W;
      const z = Math.floor(i / s.W);
      if (g.isWalkableTile(i) && !g.sameRegionSafe(x, z, wc.doorX, wc.doorZ) && g.sameRegionSafe(x, z, x, z)) spot = i;
    }
    expect(spot).toBeGreaterThanOrEqual(0);
    const moved = wc.workerIds.map((id) => g.getCitizen(id)!);
    for (const c of moved) {
      g.abortTask(c);
      c.x = (spot % s.W) + 0.5;
      c.z = Math.floor(spot / s.W) + 0.5;
    }
    g.setWorkers(wc.id, 2);
    steps(g, 2);
    for (const c of moved) expect(c.workplaceId).not.toBe(wc.id);
  });

  it('school staff are not taken away for priority workplaces', () => {
    const g = Game.create(fixtureSettings({ seed: 99, mapSize: 'medium' }));
    g.setBuilders(0);
    const school = forceBuild(g, 'school');
    g.setWorkers(school.id, 1);
    const hut = forceBuild(g, 'gathererHut');
    g.setWorkers(hut.id, 0);
    steps(g, 3);
    expect(school.workerIds.length).toBe(1);
    g.setBuilders(999); // every other adult becomes a builder: no laborers left
    steps(g, 3);
    g.setWorkers(hut.id, 4);
    g.setPriority(hut.id, true);
    steps(g, 8);
    expect(school.workerIds.length).toBe(1);
  });
});

/** Place a wooden house over a clump of trees near the town (its footprint features get marked for clearing). */
function placeOnTrees(g: Game): ReturnType<Game['placeBuilding']> {
  const s = g.state;
  const c = g.townCenter();
  for (let r = 6; r < 50; r++) {
    for (let a = 0; a < 16; a++) {
      const x = Math.floor(c.x + Math.cos((a / 16) * Math.PI * 2) * r);
      const z = Math.floor(c.z + Math.sin((a / 16) * Math.PI * 2) * r);
      if (x < 2 || z < 2 || x >= s.W - 4 || z >= s.H - 4 || s.tiles.feature[z * s.W + x] !== Feature.Tree) continue;
      const chk = g.checkPlacement('woodenHouse', x - 1, z - 1, 0);
      if (chk.ok && chk.clearing.length >= 2 && g.sameRegionSafe(chk.doorX, chk.doorZ, Math.floor(c.x), Math.floor(c.z))) {
        return g.placeBuilding('woodenHouse', x - 1, z - 1, 0);
      }
    }
  }
  return null;
}

describe('construction sites', () => {
  it('cancelling a site leaves the trees it marked standing', () => {
    const g = Game.create(fixtureSettings({ seed: 4242 }));
    const s = g.state;
    const site = placeOnTrees(g);
    expect(site).toBeTruthy();
    if (!site) return;
    const tiles: number[] = [];
    for (let zz: number = site.z; zz < site.z + site.h; zz++) {
      for (let xx: number = site.x; xx < site.x + site.w; xx++) {
        const i: number = zz * s.W + xx;
        if (s.tiles.feature[i] !== Feature.None) tiles.push(i);
      }
    }
    expect(tiles.every((i) => s.tiles.marked[i] === 1)).toBe(true);
    g.demolish(site.id);
    expect(tiles.every((i) => s.tiles.marked[i] === 0 || s.tiles.road[i] !== Road.None)).toBe(true);
    steps(g, 60);
    expect(tiles.every((i) => s.tiles.feature[i] !== Feature.None)).toBe(true);
  });

  it('a paused site is not cleared', () => {
    const g = Game.create(fixtureSettings({ seed: 4242 }));
    const s = g.state;
    const site = placeOnTrees(g);
    expect(site).toBeTruthy();
    if (!site) return;
    const b = site;
    g.setPaused(b.id, true);
    const count = (): number => {
      let n = 0;
      for (let zz = b.z; zz < b.z + b.h; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) {
        if (s.tiles.feature[zz * s.W + xx] !== Feature.None) n++;
      }
      return n;
    };
    const before = count();
    steps(g, 120);
    expect(count()).toBe(before);
    expect(site.state).toBe('clearing');
  });
});

describe('storage', () => {
  it('demolishing a storage building moves everything out, goods reserved for pickup included', () => {
    const g = Game.create(fixtureSettings({ difficulty: 'easy' }));
    const barn2 = forceBuild(g, 'storageBarn');
    const barn = g.state.buildings.find((b) => b.type === 'storageBarn' && b.id !== barn2.id)!;
    const before = g.foodTotal();
    barn.reservedOut.wheat = 30; // a household fetch on its way
    g.demolish(barn.id);
    expect(g.foodTotal()).toBeCloseTo(before, 3);
  });

  it('a barn lost to fire leaves salvage in the ruin, which laborers carry to another barn', () => {
    const g = Game.create(fixtureSettings({ difficulty: 'easy', seed: 4242 }));
    const barn2 = forceBuild(g, 'storageBarn');
    const barn = g.state.buildings.find((b) => b.type === 'storageBarn' && b.id !== barn2.id)!;
    const tools = barn.inventory.tool ?? 0;
    expect(tools).toBeGreaterThan(0);
    g.removeBuilding(barn.id, 'fire');
    expect(barn.state).toBe('ruin');
    expect(barn.inventory.tool).toBe(Math.floor(tools * RUIN_SALVAGE));
    steps(g, 4 * MONTH_SECONDS);
    expect(barn2.inventory.tool ?? 0).toBeGreaterThan(0);
  });

  it('with no barn at all, households still get food from the gatherers', () => {
    const g = Game.create(fixtureSettings({ seed: 4242 }));
    const hut = forceBuild(g, 'gathererHut');
    g.setWorkers(hut.id, 0);
    const home = forceBuild(g, 'woodenHouse');
    updateHousing(g);
    for (const b of g.state.buildings) if (b.type === 'storageBarn') g.removeBuilding(b.id, 'tornado');
    for (const b of g.state.buildings) if (b.state === 'ruin') b.inventory = {};
    home.inventory = {};
    hut.inventory.berries = 60;
    steps(g, 40);
    expect(Object.keys(home.inventory).some((k) => k === 'berries')).toBe(true);
  });
});

describe('food production', () => {
  it('an understaffed field ripens as fast as a fully staffed one', () => {
    const g = Game.create(fixtureSettings({ seed: 4242 }));
    const a = forceBuild(g, 'cropField', undefined, undefined, 8, 8);
    for (const t of a.fieldTiles!) {
      t.stage = 2;
      t.growth = 0;
    }
    g.setWorkers(a.id, 0);
    g.state.time.month = 3;
    steps(g, 60);
    const grown = a.fieldTiles![0].growth;
    expect(grown).toBeGreaterThan(0.9 * (60 / (CROPS.wheat.growMonths * MONTH_SECONDS)));
  });

  it('a mature orchard yields about as much per tile as grain', () => {
    expect(ORCHARDS.apple.yieldPerTile).toBeGreaterThanOrEqual(CROPS.wheat.yieldPerTile * 0.85);
  });

  it('fishermen cast several times per trip before carrying the catch home', () => {
    const g = Game.create(fixtureSettings({ seed: 4242, terrain: 'lakes' }));
    const dock = forceBuild(g, 'fishingDock');
    const c = g.state.citizens.find((x) => x.age >= 16)!;
    const t = planFisherman(g, c, dock, brainOf(c));
    expect(t).toBeTruthy();
    if (!t) return;
    expect(t.steps.filter((st) => st.op === 'fish').length).toBe(3);
  });
});

describe('births', () => {
  it('babies are rare while the barns are empty', () => {
    const count = (food: boolean): number => {
      const g = Game.create(fixtureSettings({ seed: 5 }));
      emptyTown(g);
      for (let k = 0; k < 8; k++) couple(g, forceBuild(g, 'woodenHouse'), [25, 24]);
      if (!food) for (const b of g.state.buildings) if (BUILDINGS[b.type].storage) b.inventory = {};
      for (const c of g.state.citizens) c.happiness = 60;
      g.rt.townFood = food ? 10000 : 0;
      for (let k = 0; k < 360; k++) updateBirths(g, 2);
      return g.state.tally.births;
    };
    expect(count(false)).toBeLessThan(count(true) * 0.4);
  });
});

describe('save / load', () => {
  it('a loaded game continues exactly like the original (weather, disasters, advisors, disease)', () => {
    const g = Game.create(fixtureSettings({ seed: 8080, disasters: true }));
    const bot = new Bot(g);
    for (let i = 0; i < 2400; i++) {
      g.step(0.25);
      bot.tick();
    }
    const h = Game.fromSave(g.save());
    for (let i = 0; i < 1200; i++) {
      g.step(0.25);
      h.step(0.25);
    }
    expect(h.rng.state).toBe(g.rng.state);
    expect(h.state.weather).toEqual(g.state.weather);
    expect(h.state.citizens.map((c) => [c.x, c.z, c.health, c.sick])).toEqual(g.state.citizens.map((c) => [c.x, c.z, c.health, c.sick]));
    expect(h.state.messages.length).toBe(g.state.messages.length);
    void YEAR_SECONDS;
    void spawnAt;
  });
});
