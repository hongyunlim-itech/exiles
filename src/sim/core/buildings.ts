/**
 * Building lifecycle: creation/placement, clearing -> construction -> active, completion, demolition, ruins,
 * removal, house heating. ARCHITECTURE §3.6 + §3.1 step 3. OWNER: sim-core.
 */
import { COLD_TEMP, FIREWOOD_BURN_RATE } from '../../core/constants';
import { BUILDINGS } from '../../core/defs';
import type { Building, BuildingType, FieldTile, Inventory, ResourceType, Rotation } from '../../core/types';
import { Feature } from '../../core/types';
import type { Game } from '../game';
import { flattenFootprint, markFootprintFeatures, checkPlacementImpl, resolveFootprint } from './placement';
import { addToStorageNow } from './storage';
import { buildingName, clamp, deliveredFraction, invAdd, invGet, invKeys, invTake, totalBuildWork } from './util';

/** Builder-seconds needed to demolish, as a fraction of the construction work. */
const DEMOLISH_WORK_FACTOR = 0.35;
const RUIN_WORK_FACTOR = 0.2;
/** Share of a building's contents that survives a fire / tornado as salvage in the ruin (laborers haul it out). */
export const RUIN_SALVAGE = 0.5;

export function makeFieldTiles(n: number, stage = 0): FieldTile[] {
  const out: FieldTile[] = [];
  for (let i = 0; i < n; i++) out.push({ stage, growth: 0 });
  return out;
}

/** Create a building object (not yet registered). */
export function createBuilding(
  g: Game, type: BuildingType, x: number, z: number, w: number, h: number, rotation: Rotation, doorX: number, doorZ: number,
): Building {
  const def = BUILDINGS[type];
  const tiles = w * h;
  const cost: Inventory = {};
  for (const k in def.cost) {
    const r = k as ResourceType;
    const v = invGet(def.cost, r);
    const n = def.costPerTile ? Math.ceil(v * tiles) : v;
    if (n > 0) cost[r] = n;
  }
  const b: Building = {
    id: g.newId(),
    type, x, z, w, h, rotation, doorX, doorZ,
    state: 'construction',
    progress: 0,
    cost,
    delivered: {},
    incoming: {},
    workRemaining: 0,
    priority: false,
    paused: false,
    workersDesired: def.defaultWorkers,
    workerIds: [],
    residentIds: [],
    inventory: {},
    reservedOut: {},
    reservedIn: 0,
    fire: 0,
    fireFighters: 0,
    smoking: false,
    producedThisYear: {},
    producedLastYear: {},
    builtAt: -1,
  };
  b.workRemaining = totalBuildWork(b);
  const un = g.state.unlocked;
  if (type === 'cropField') {
    b.crop = un.crops[0] ?? 'wheat';
    b.fieldTiles = makeFieldTiles(tiles, 0);
  } else if (type === 'orchard') {
    // no fruit trees until an orchard type is unlocked (seeds from a merchant); setCrop plants them later
    const ot = un.orchards[0];
    if (ot) b.orchard = { type: ot, maturity: 0, fruit: 0 };
    b.fieldTiles = makeFieldTiles(tiles, 2);
  } else if (type === 'pasture') {
    const lt = un.livestock[0];
    if (lt) b.livestock = { type: lt, count: 2, breed: 0, product: 0 };
  } else if (type === 'cemetery') {
    b.graves = 0;
  }
  if (def.recipes && def.recipes.length > 0) b.recipe = def.recipes.length > 1 ? -1 : 0;
  return b;
}

/** Register a building in state + indexes and occupy its tiles. */
export function registerBuilding(g: Game, b: Building): void {
  const s = g.state;
  for (let zz = b.z; zz < b.z + b.h; zz++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) s.tiles.building[zz * s.W + xx] = b.id;
  }
  s.buildings.push(b);
  g.buildingById.set(b.id, b);
  g.rt.addDoor(s, b);
  g.rt.dirty = true;
  s.rev.buildings++;
}

export function placeBuildingImpl(g: Game, type: BuildingType, x: number, z: number, rotation: Rotation, w?: number, h?: number): Building | null {
  const chk = checkPlacementImpl(g, type, x, z, rotation, w, h);
  if (!chk.ok) return null;
  const rot = ((((rotation | 0) % 4) + 4) % 4) as Rotation;
  const fp = resolveFootprint(type, rot, w, h);
  const b = createBuilding(g, type, Math.floor(x), Math.floor(z), fp.w, fp.h, rot, chk.doorX, chk.doorZ);
  const def = BUILDINGS[type];
  registerBuilding(g, b);
  if (!def.walkable && def.placement !== 'shore') flattenFootprint(g, b);
  const marked = markFootprintFeatures(g, b);
  b.state = marked > 0 || chk.clearing.length > 0 ? 'clearing' : 'construction';
  g.events.emit('buildingPlaced', { id: b.id });
  if (b.state === 'construction') maybeCompleteInstantly(g, b);
  return b;
}

/** Zones with no cost and no work become active as soon as they are cleared. */
function maybeCompleteInstantly(g: Game, b: Building): void {
  if (b.state === 'construction' && b.workRemaining <= 0 && deliveredFraction(b) >= 1) completeConstruction(g, b);
}

export function completeConstruction(g: Game, b: Building): void {
  const s = g.state;
  b.state = 'active';
  b.progress = 1;
  b.workRemaining = 0;
  b.incoming = {};
  b.builtAt = s.time.elapsed;
  g.rt.dirty = true;
  s.rev.buildings++;
  g.events.emit('buildingCompleted', { id: b.id });
  const [cx, cz] = [b.x + b.w / 2, b.z + b.h / 2];
  g.sound('build', cx, cz);
  if (!BUILDINGS[b.type].walkable) g.addMessage(`${buildingName(b)} has been completed.`, 'info', { kind: 'building', id: b.id });
}

/** Release workers and residents (they become laborers / homeless). */
export function releasePeople(g: Game, b: Building): void {
  for (const id of b.workerIds) {
    const c = g.citizenById.get(id);
    if (c && c.workplaceId === b.id) {
      c.workplaceId = -1;
      if (c.profession !== 'child' && c.profession !== 'student') c.profession = 'laborer';
      g.onJobChanged(c);
    }
  }
  b.workerIds = [];
  for (const id of b.residentIds) {
    const c = g.citizenById.get(id);
    if (c && c.homeId === b.id) c.homeId = -1;
  }
  b.residentIds = [];
}

/**
 * Move a building's stored goods into other storages (contents that do not fit are lost). Everything is moved —
 * goods reserved for a pickup too (the pickup then fails and is re-planned at the new place).
 */
function evacuateInventory(g: Game, b: Building): void {
  const [cx, cz] = [b.x + b.w / 2, b.z + b.h / 2];
  for (const r of invKeys(b.inventory)) {
    const n = invGet(b.inventory, r);
    if (n > 0) addToStorageNow(g, r, n, cx, cz, b.id);
  }
  b.inventory = {};
}

export function removeBuildingImpl(g: Game, id: number, cause: 'demolish' | 'fire' | 'tornado' | 'cancel'): void {
  const s = g.state;
  const b = g.buildingById.get(id);
  if (!b) return;
  const def = BUILDINGS[b.type];
  releasePeople(g, b);
  if ((cause === 'fire' || cause === 'tornado') && !def.walkable && b.state !== 'ruin') {
    // leave a burnt-out ruin for laborers to clear
    b.state = 'ruin';
    b.fire = 0;
    b.fireFighters = 0;
    b.smoking = false;
    b.progress = 0;
    b.workRemaining = Math.max(8, totalBuildWork(b) * RUIN_WORK_FACTOR);
    // part of the contents survives in the ruin; laborers salvage it (and the hungry may eat from it)
    const salvage: Inventory = {};
    for (const r of invKeys(b.inventory)) {
      const n = Math.floor(invGet(b.inventory, r) * RUIN_SALVAGE);
      if (n > 0) salvage[r] = n;
    }
    b.inventory = salvage;
    b.delivered = {};
    b.workersDesired = 0;
    b.priority = false;
    b.paused = false;
    delete b.livestock;
    g.rt.houseFetcher.delete(b.id);
    g.rt.dirty = true;
    s.rev.buildings++;
    g.events.emit('buildingRemoved', { id: b.id, type: b.type, cause });
    return;
  }
  for (let zz: number = b.z; zz < b.z + b.h; zz++) {
    for (let xx: number = b.x; xx < b.x + b.w; xx++) {
      const i = zz * s.W + xx;
      if (i >= 0 && i < s.tiles.building.length && s.tiles.building[i] === b.id) s.tiles.building[i] = -1;
    }
  }
  const idx = s.buildings.indexOf(b);
  if (idx >= 0) s.buildings.splice(idx, 1);
  g.buildingById.delete(b.id);
  g.rt.removeDoor(s, b);
  g.rt.houseFetcher.delete(b.id);
  g.rt.siteCount.delete(b.id);
  g.rt.shoreCache.delete(b.id);
  g.rt.dirty = true;
  s.rev.buildings++;
  if (b.fieldTiles) s.rev.fields++;
  g.events.emit('buildingRemoved', { id: b.id, type: b.type, cause });
}

export function demolishImpl(g: Game, id: number): void {
  const b = g.buildingById.get(id);
  if (!b) return;
  const def = BUILDINGS[b.type];
  const [cx, cz] = [b.x + b.w / 2, b.z + b.h / 2];
  switch (b.state) {
    case 'clearing':
    case 'construction': {
      // cancel: refund delivered materials, and leave the trees/rocks the placement marked standing
      const refund = { ...b.delivered };
      unmarkFootprint(g, b);
      removeBuildingImpl(g, id, 'cancel');
      for (const r of invKeys(refund)) addToStorageNow(g, r, invGet(refund, r), cx, cz);
      return;
    }
    case 'active': {
      releasePeople(g, b);
      if (def.walkable) {
        evacuateInventory(g, b);
        removeBuildingImpl(g, id, 'demolish');
        return;
      }
      evacuateInventory(g, b);
      b.state = 'demolishing';
      b.progress = 0;
      b.workRemaining = Math.max(6, totalBuildWork(b) * DEMOLISH_WORK_FACTOR);
      b.workersDesired = 0;
      b.smoking = false;
      g.rt.dirty = true;
      g.state.rev.buildings++;
      return;
    }
    default:
      return;
  }
}

/** Unmark the features in a footprint (placement auto-marked them), except on road tiles (roads mark too). */
function unmarkFootprint(g: Game, b: Building): void {
  const s = g.state;
  const tl = s.tiles;
  let n = 0;
  for (let zz = b.z; zz < b.z + b.h; zz++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      const i = zz * s.W + xx;
      if (!tl.marked[i] || tl.road[i] !== 0) continue;
      tl.marked[i] = 0;
      g.rt.marked.delete(i);
      n++;
    }
  }
  if (n > 0) g.bumpFeatures();
}

/** Demolition / ruin clearing finished. */
export function finishDemolition(g: Game, b: Building): void {
  const [cx, cz] = [b.x + b.w / 2, b.z + b.h / 2];
  const refund: Inventory = {};
  if (b.state === 'demolishing') {
    for (const r of invKeys(b.cost)) {
      const n = Math.floor(invGet(b.cost, r) * 0.5);
      if (n > 0) refund[r] = n;
    }
  }
  // salvage nobody carried out goes to storage if there is room
  for (const r of invKeys(b.inventory)) invAdd(refund, r, invGet(b.inventory, r));
  b.inventory = {};
  removeBuildingImpl(g, b.id, 'demolish');
  for (const r of invKeys(refund)) addToStorageNow(g, r, invGet(refund, r), cx, cz);
}

/** Per-step building upkeep (heating), plus 1 Hz state transitions. */
export function updateBuildings(g: Game, dt: number, secondTick: boolean): void {
  const s = g.state;
  const temp = s.weather.temperature;
  const cold = temp < COLD_TEMP;
  const burnFactor = clamp(0.6 + (COLD_TEMP - temp) / 12, 0.6, 1.6);
  for (const b of g.rt.houses(s)) {
    if (b.state !== 'active') {
      b.smoking = false;
      continue;
    }
    const fw = invGet(b.inventory, 'firewood');
    if (cold && b.residentIds.length > 0 && fw > 0) {
      const eff = BUILDINGS[b.type].heatEfficiency ?? 1;
      invTake(b.inventory, 'firewood', FIREWOOD_BURN_RATE * eff * burnFactor * dt);
      b.smoking = true;
    } else {
      b.smoking = false;
    }
  }
  // workshops: `smoking` is re-asserted every step by working craftsmen (behavior)
  for (const b of g.rt.workplaces(s)) {
    if (BUILDINGS[b.type].recipes) b.smoking = false;
  }
  if (!secondTick) return;
  for (const b of [...g.rt.sites(s)]) {
    if (b.state === 'clearing') {
      if (!footprintHasFeatures(g, b)) {
        b.state = 'construction';
        g.rt.dirty = true;
        s.rev.buildings++;
      } else {
        // make sure every footprint feature is (still) marked — e.g. a tree that spread onto the site
        markFootprintFeatures(g, b);
      }
    }
    if (b.state === 'construction') {
      const frac = deliveredFraction(b);
      const total = totalBuildWork(b);
      b.progress = total > 0 ? clamp(1 - b.workRemaining / total, 0, frac) : frac;
      if (b.workRemaining <= 1e-6 && frac >= 1) completeConstruction(g, b);
    }
  }
}

export function footprintHasFeatures(g: Game, b: Building): boolean {
  const s = g.state;
  for (let zz = b.z; zz < b.z + b.h; zz++) {
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      if (s.tiles.feature[zz * s.W + xx] !== Feature.None) return true;
    }
  }
  return false;
}

/** Add a production output to a building's yearly counter. */
export function recordProduction(b: Building, r: ResourceType, n: number): void {
  if (n > 0) invAdd(b.producedThisYear, r, n);
}

/** Resource types a workplace produces (hauled from its buffer to storage). */
export function outputTypesOf(b: Building): ResourceType[] | null {
  const def = BUILDINGS[b.type];
  if (def.recipes) {
    const out = new Set<ResourceType>();
    for (const rc of def.recipes) for (const k in rc.outputs) out.add(k as ResourceType);
    return [...out];
  }
  return null; // everything in the buffer
}

/** Haulable output currently in a workplace buffer (unreserved). */
export function haulableOutputs(b: Building): { r: ResourceType; n: number }[] {
  const def = BUILDINGS[b.type];
  if (def.storage || def.housing || def.stocks) return [];
  const types = outputTypesOf(b);
  const out: { r: ResourceType; n: number }[] = [];
  for (const r of types ?? invKeys(b.inventory)) {
    const n = invGet(b.inventory, r) - invGet(b.reservedOut, r);
    if (n > 0.5) out.push({ r, n });
  }
  out.sort((a, c) => c.n - a.n);
  return out;
}

export function bufferUsed(b: Building): number {
  const types = outputTypesOf(b);
  if (!types) {
    let t = 0;
    for (const k in b.inventory) t += invGet(b.inventory, k as ResourceType);
    return t;
  }
  let t = 0;
  for (const r of types) t += invGet(b.inventory, r);
  return t;
}
