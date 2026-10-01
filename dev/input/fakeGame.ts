/**
 * Sandbox-only stand-in for the sim's Game: a real generated world plus simplified placement/road/clear rules, so the
 * input tools can be exercised before (and independently of) sim-core.
 */
import { BUILDINGS, ROAD_DEFS } from '../../src/core/defs';
import { EventBus } from '../../src/core/events';
import { Rng } from '../../src/core/rng';
import type {
  Building, BuildingType, GameEvents, GameSpeed, GameState, NewGameSettings, PlacementCheck, RemovalFilter, Rotation,
} from '../../src/core/types';
import { Feature, Road, Terrain } from '../../src/core/types';
import { computeDoor, footprintSize, inBounds, isLandTerrain, isTileBuildable } from '../../src/core/world';
import { generateWorld } from '../../src/sim/worldgen';

export class FakeGame {
  state: GameState;
  readonly events = new EventBus<GameEvents>();
  speed: GameSpeed = 1;
  readonly buildingById = new Map<number, Building>();
  startX: number;
  startZ: number;

  constructor(seed = 424242) {
    const settings: NewGameSettings = {
      seed, townName: 'Sandbox', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'medium', disasters: false,
    };
    let nextId = 1;
    const world = generateWorld(settings, new Rng(seed), () => nextId++);
    this.startX = world.startX;
    this.startZ = world.startZ;
    this.state = {
      version: 1,
      settings,
      W: world.W,
      H: world.H,
      tiles: world.tiles,
      time: { elapsed: 0, year: 1, month: 4, monthProgress: 0.3, dayTime: 0.5 },
      weather: { temperature: 18, snow: 0, precipitation: 'none', precipIntensity: 0, windDir: 0.5, windStrength: 0.4 },
      citizens: [],
      buildings: [],
      animals: world.animals,
      nextId: nextId + 1,
      unlocked: { crops: ['wheat'], orchards: ['apple'], livestock: ['chicken'] },
      buildersDesired: 2,
      trade: { merchant: null, nextArrival: 100, requested: null },
      nomads: null,
      nextNomads: 1000,
      messages: [],
      history: [],
      tally: { births: 0, deaths: {}, monthBirths: 0, monthDeaths: 0 },
      rngState: 1,
      rev: { terrain: 1, features: 1, roads: 1, buildings: 1, fields: 1 },
      unburied: 0,
      gameOver: false,
      tornado: null,
    };
  }

  getBuilding(id: number): Building | undefined {
    return this.buildingById.get(id);
  }

  getCitizen(): undefined {
    return undefined;
  }

  buildingAtTile(x: number, z: number): Building | undefined {
    const id = this.state.tiles.building[z * this.state.W + x];
    return id >= 0 ? this.buildingById.get(id) : undefined;
  }

  checkPlacement(type: BuildingType, x: number, z: number, rotation: Rotation, w?: number, h?: number): PlacementCheck {
    const s = this.state;
    const def = BUILDINGS[type];
    const [fw, fh] = def.resizable ? [w ?? def.size[0], h ?? def.size[1]] : footprintSize(type, rotation);
    const blocked: number[] = [];
    const clearing: number[] = [];
    let water = 0;
    let land = 0;
    for (let zz = z; zz < z + fh; zz++) {
      for (let xx = x; xx < x + fw; xx++) {
        if (!inBounds(s, xx, zz)) continue;
        const i = zz * s.W + xx;
        const t = s.tiles.terrain[i];
        if (def.placement === 'shore' && t === Terrain.Water) {
          water++;
          if (s.tiles.building[i] >= 0) blocked.push(i);
          continue;
        }
        if (!isTileBuildable(s, xx, zz)) blocked.push(i);
        else {
          land++;
          if (s.tiles.feature[i] !== Feature.None) clearing.push(i);
        }
      }
    }
    const [doorX, doorZ] = computeDoor(type, x, z, fw, fh, rotation);
    let reason: string | undefined;
    if (x < 0 || z < 0 || x + fw > s.W || z + fh > s.H) reason = 'Outside the map';
    else if (blocked.length) reason = 'The site is blocked';
    else if (def.placement === 'shore' && (water < fw * fh * 0.25 || land < fw * fh * 0.4)) reason = "Must be built on the water's edge";
    else if (def.resizable && (fw < def.resizable.min || fh < def.resizable.min || fw > def.resizable.max || fh > def.resizable.max)) reason = 'Invalid size';
    else if (!def.walkable && (!inBounds(s, doorX, doorZ) || !isLandTerrain(s.tiles.terrain[doorZ * s.W + doorX]) || s.tiles.building[doorZ * s.W + doorX] >= 0)) {
      reason = 'The entrance is blocked';
    }
    return { ok: !reason, reason, blocked, clearing, doorX, doorZ };
  }

  placeBuilding(type: BuildingType, x: number, z: number, rotation: Rotation, w?: number, h?: number): Building | null {
    const check = this.checkPlacement(type, x, z, rotation, w, h);
    if (!check.ok) return null;
    const def = BUILDINGS[type];
    const [fw, fh] = def.resizable ? [w ?? def.size[0], h ?? def.size[1]] : footprintSize(type, rotation);
    const b: Building = {
      id: this.state.nextId++, type, x, z, w: fw, h: fh, rotation, doorX: check.doorX, doorZ: check.doorZ,
      state: 'active', progress: 1, cost: { ...def.cost }, delivered: {}, incoming: {}, workRemaining: 0, priority: false,
      paused: false, workersDesired: def.defaultWorkers, workerIds: [], residentIds: [], inventory: {}, reservedOut: {},
      reservedIn: 0, fire: 0, fireFighters: 0, smoking: false, producedThisYear: {}, producedLastYear: {}, builtAt: 0,
    };
    this.state.buildings.push(b);
    this.buildingById.set(b.id, b);
    for (let zz = z; zz < z + fh; zz++) {
      for (let xx = x; xx < x + fw; xx++) {
        const i = zz * this.state.W + xx;
        this.state.tiles.building[i] = b.id;
        this.state.tiles.feature[i] = Feature.None;
      }
    }
    this.state.rev.buildings++;
    this.state.rev.features++;
    this.events.emit('buildingPlaced', { id: b.id });
    return b;
  }

  checkRoad(tiles: number[], kind: 'dirt' | 'stone'): { ok: number[]; blocked: number[] } {
    void kind;
    const ok: number[] = [];
    const blocked: number[] = [];
    const t = this.state.tiles;
    for (const i of tiles) {
      const land = isLandTerrain(t.terrain[i]);
      const bridge = t.terrain[i] === Terrain.Water;
      if ((land || bridge) && t.building[i] < 0) ok.push(i);
      else blocked.push(i);
    }
    return { ok, blocked };
  }

  placeRoad(tiles: number[], kind: 'dirt' | 'stone'): number {
    const { ok } = this.checkRoad(tiles, kind);
    const t = this.state.tiles;
    for (const i of ok) {
      t.road[i] = t.terrain[i] === Terrain.Water ? Road.Bridge : kind === 'stone' ? Road.Stone : Road.Dirt;
      t.feature[i] = Feature.None;
    }
    void ROAD_DEFS;
    if (ok.length) this.state.rev.roads++;
    return ok.length;
  }

  removeRoad(tiles: number[]): number {
    let n = 0;
    for (const i of tiles) {
      if (this.state.tiles.road[i] !== Road.None) {
        this.state.tiles.road[i] = Road.None;
        n++;
      }
    }
    if (n) this.state.rev.roads++;
    return n;
  }

  markForRemoval(x0: number, z0: number, x1: number, z1: number, filter: RemovalFilter): number {
    let n = 0;
    const t = this.state.tiles;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = z * this.state.W + x;
        const f = t.feature[i];
        const match = filter === 'all' ? f !== Feature.None : filter === 'trees' ? f === Feature.Tree : filter === 'stone' ? f === Feature.Rock : f === Feature.Iron;
        if (match && !t.marked[i]) {
          t.marked[i] = 1;
          n++;
        }
      }
    }
    if (n) this.state.rev.features++;
    return n;
  }

  unmarkRemoval(x0: number, z0: number, x1: number, z1: number): number {
    let n = 0;
    const t = this.state.tiles;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = z * this.state.W + x;
        if (t.marked[i]) {
          t.marked[i] = 0;
          n++;
        }
      }
    }
    if (n) this.state.rev.features++;
    return n;
  }

  demolish(id: number): void {
    const b = this.buildingById.get(id);
    if (!b) return;
    for (let zz = b.z; zz < b.z + b.h; zz++) {
      for (let xx = b.x; xx < b.x + b.w; xx++) this.state.tiles.building[zz * this.state.W + xx] = -1;
    }
    this.buildingById.delete(id);
    this.state.buildings = this.state.buildings.filter((x) => x.id !== id);
    this.state.rev.buildings++;
    this.events.emit('buildingRemoved', { id, type: b.type, cause: 'demolish' });
  }
}
