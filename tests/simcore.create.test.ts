/**
 * Game.create: every difficulty × map size × terrain style yields a valid start.
 */
import { describe, expect, it } from 'vitest';
import { BUILDINGS, FOOD_TYPES } from '../src/core/defs';
import type { Difficulty, MapSize, TerrainStyle } from '../src/core/types';
import { Game } from '../src/sim/game';
import { settings } from './simcore.helpers';

const DIFFS: Difficulty[] = ['easy', 'medium', 'hard'];
const SIZES: MapSize[] = ['small', 'medium', 'large'];
const STYLES: TerrainStyle[] = ['valleys', 'mountains', 'lakes'];

describe('simcore Game.create', () => {
  for (const difficulty of DIFFS) {
    for (const mapSize of SIZES) {
      for (const terrain of STYLES) {
        it(`${difficulty} / ${mapSize} / ${terrain}`, () => {
          const g = Game.create(settings({ seed: 4242 + SIZES.indexOf(mapSize) * 7 + STYLES.indexOf(terrain), difficulty, mapSize, terrain }));
          const s = g.state;
          expect(g.validate()).toEqual([]);
          expect(s.time.year).toBe(1);
          expect(s.time.month).toBe(0);
          expect(s.gameOver).toBe(false);
          // population: a married couple per family plus children (some families bring teenagers)
          const fam = { easy: 7, medium: 5, hard: 4 }[difficulty];
          const couples = s.citizens.filter((c) => c.spouseId >= 0);
          expect(couples.length).toBe(fam * 2);
          for (const c of s.citizens) if (c.spouseId < 0) expect(c.age).toBeLessThan(14);
          for (const c of s.citizens) {
            const i = Math.floor(c.z) * s.W + Math.floor(c.x);
            expect(g.isWalkableTile(i), `${c.name} on walkable tile`).toBe(true);
          }
          // pre-built storage
          expect(g.hasBuilding('storageBarn')).toBe(true);
          expect(g.hasBuilding('stockpile')).toBe(true);
          if (difficulty === 'easy') expect(s.buildings.filter((b) => b.type === 'woodenHouse').length).toBe(4);
          // everyone can reach the storage
          const barn = s.buildings.find((b) => b.type === 'storageBarn')!;
          for (const c of s.citizens) expect(g.sameRegionSafe(Math.floor(c.x), Math.floor(c.z), barn.doorX, barn.doorZ)).toBe(true);
          // supplies
          const food = FOOD_TYPES.reduce((a, r) => a + g.resourceTotals()[r], 0);
          expect(food).toBeGreaterThan({ easy: 800, medium: 500, hard: 300 }[difficulty]);
          expect(g.resourceTotals().firewood).toBeGreaterThan(50);
          expect(s.unlocked.crops).toContain('wheat');
          // easy: families housed immediately
          if (difficulty === 'easy') expect(s.citizens.filter((c) => c.homeId >= 0).length).toBeGreaterThan(8);
          for (const b of s.buildings) expect(BUILDINGS[b.type]).toBeTruthy();
          // a few steps run cleanly
          for (let k = 0; k < 40; k++) g.step(0.25);
          expect(g.validate()).toEqual([]);
          expect(g.moduleErrors()).toEqual({});
        });
      }
    }
  }
});
