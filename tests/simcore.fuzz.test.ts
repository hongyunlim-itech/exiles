/**
 * Fuzz: a chaotic "player" issues random commands (build anything anywhere, demolish, roads, bridges, marking,
 * worker counts, crops, recipes, pause/priority, fires, spawns, kills) while the town runs. Nothing may throw
 * and every invariant must hold throughout.
 */
import { describe, expect, it } from 'vitest';
import { BUILDING_TYPES, BUILDINGS, CROPS, LIVESTOCK, ORCHARDS } from '../src/core/defs';
import { Rng } from '../src/core/rng';
import type { CropType, LivestockType, OrchardType, Rotation } from '../src/core/types';
import { igniteBuilding } from '../src/sim/disasters';
import { Game } from '../src/sim/game';
import { log, settings } from './simcore.helpers';

describe('simcore fuzz', () => {
  for (const seed of [1, 2, 3]) {
    it(`random commands keep the simulation consistent (seed ${seed})`, () => {
      const g = Game.create(settings({ seed: 500 + seed, difficulty: 'easy', mapSize: 'small', terrain: seed === 2 ? 'lakes' : 'valleys', disasters: true }));
      const rng = new Rng(seed * 7919);
      const s = g.state;
      const c0 = g.townCenter();
      // plenty of materials so construction actually happens
      for (const r of ['log', 'stone', 'iron'] as const) g.addToStorage(r, 300, c0.x, c0.z);
      g.state.unlocked.crops = Object.keys(CROPS) as CropType[];
      g.state.unlocked.orchards = Object.keys(ORCHARDS) as OrchardType[];
      g.state.unlocked.livestock = Object.keys(LIVESTOCK) as LivestockType[];
      let commands = 0;
      const steps = 4 * 720 * 4; // ~4 years at dt 0.25... trimmed below
      for (let i = 0; i < steps / 2; i++) {
        g.step(0.25);
        if (i % 12 !== 0) continue;
        commands++;
        const roll = rng.next();
        const x = Math.floor(c0.x + rng.range(-30, 30));
        const z = Math.floor(c0.z + rng.range(-30, 30));
        const any = s.buildings.length ? s.buildings[rng.int(0, s.buildings.length - 1)] : null;
        if (roll < 0.3) {
          const type = rng.pick(BUILDING_TYPES);
          const def = BUILDINGS[type];
          const w = def.resizable ? rng.int(def.resizable.min, def.resizable.max) : undefined;
          const h = def.resizable ? rng.int(def.resizable.min, def.resizable.max) : undefined;
          g.placeBuilding(type, x, z, rng.int(0, 3) as Rotation, w, h);
        } else if (roll < 0.38 && any) g.demolish(any.id);
        else if (roll < 0.42 && any) g.removeBuilding(any.id, rng.chance(0.5) ? 'fire' : 'tornado');
        else if (roll < 0.46 && any) igniteBuilding(g, any.id);
        else if (roll < 0.52) {
          const tiles: number[] = [];
          const len = rng.int(3, 20);
          const horiz = rng.chance(0.5);
          for (let k = 0; k < len; k++) {
            const tx = horiz ? x + k : x;
            const tz = horiz ? z : z + k;
            if (tx >= 0 && tz >= 0 && tx < s.W && tz < s.H) tiles.push(tz * s.W + tx);
          }
          if (rng.chance(0.8)) g.placeRoad(g.checkRoad(tiles, 'dirt').ok, rng.chance(0.7) ? 'dirt' : 'stone');
          else g.removeRoad(tiles);
        } else if (roll < 0.6) g.markForRemoval(x, z, x + rng.int(0, 10), z + rng.int(0, 10), rng.pick(['all', 'trees', 'stone', 'iron'] as const));
        else if (roll < 0.63) g.unmarkRemoval(x, z, x + rng.int(0, 10), z + rng.int(0, 10));
        else if (roll < 0.7 && any) g.setWorkers(any.id, rng.int(-1, 9));
        else if (roll < 0.73) g.setBuilders(rng.int(0, 8));
        else if (roll < 0.77 && any) g.setCrop(any.id, rng.pick([...Object.keys(CROPS), ...Object.keys(ORCHARDS), ...Object.keys(LIVESTOCK)]) as CropType);
        else if (roll < 0.8 && any) g.setRecipe(any.id, rng.int(-1, 4));
        else if (roll < 0.84 && any) g.setPaused(any.id, rng.chance(0.5));
        else if (roll < 0.87 && any) g.setPriority(any.id, rng.chance(0.5));
        else if (roll < 0.9) g.spawnCitizen({ x, z, age: rng.range(0, 60) });
        else if (roll < 0.91 && s.citizens.length > 8) g.killCitizen(rng.pick(s.citizens).id, 'accident');
        else if (roll < 0.93) g.takeFromStorage(rng.pick(['log', 'wheat', 'tool', 'firewood'] as const), rng.int(1, 50));
        if (commands % 25 === 0) {
          const v = g.validate();
          if (v.length) log(`fuzz ${seed} step ${i}:`, v.slice(0, 5));
          expect(v).toEqual([]);
        }
      }
      const v = g.validate();
      log(`fuzz ${seed}: ${commands} commands, pop ${s.citizens.length}, buildings ${s.buildings.length}, errors ${JSON.stringify(g.moduleErrors())}, deaths ${JSON.stringify(s.tally.deaths)} t=${s.time.elapsed}`);
      expect(v).toEqual([]);
      expect(g.moduleErrors()).toEqual({});
      // save/load still works after the chaos
      const h = Game.fromSave(g.save());
      expect(h.validate()).toEqual([]);
      for (let k = 0; k < 200; k++) h.step(0.25);
      expect(h.validate()).toEqual([]);
    });
  }
});
