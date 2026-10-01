/**
 * Command execution — the ONLY place that turns a Command into Game mutations. OWNER: net-core agent.
 * Must be deterministic: same game state + same command → same result on every peer.
 *
 * Commands from other peers are untrusted: {@link sanitizeCommand} normalises every field (integers, enums, bounded
 * arrays) and is applied on every peer before execution, so a malformed command is rejected identically everywhere.
 */
import { GAME_SPEEDS } from '../core/constants';
import { BUILDINGS, CROPS, LIVESTOCK, ORCHARDS, RESOURCES } from '../core/defs';
import type { BuildingType, GameSpeed, Inventory, MerchantKind, RemovalFilter, ResourceType, Rotation } from '../core/types';
import { Road } from '../core/types';
import type { Game, TradeTake } from '../sim/game';
import { inventoryValue } from '../sim/trade';
import type { Command, CommandResult } from './types';

/** Largest tile list accepted in one road command (the session splits longer drags into several commands). */
export const MAX_ROAD_TILES = 400;
const MERCHANT_KINDS: readonly MerchantKind[] = ['food', 'goods', 'livestock', 'seeds', 'general'];
const FILTERS: readonly RemovalFilter[] = ['all', 'trees', 'stone', 'iron'];

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const int = (v: unknown, lo: number, hi: number): number | null => (isInt(v) && v >= lo && v <= hi ? v : null);

/**
 * Validate & normalise a command received from anywhere (UI or another peer). Returns a fresh plain object with only
 * the known fields, or null when malformed. Pure (no game access) so every peer agrees.
 */
export function sanitizeCommand(raw: unknown): Command | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const BIG = 1 << 20;
  switch (c.op) {
    case 'place': {
      if (typeof c.type !== 'string' || !Object.prototype.hasOwnProperty.call(BUILDINGS, c.type)) return null;
      const x = int(c.x, -BIG, BIG);
      const z = int(c.z, -BIG, BIG);
      const rot = int(c.rot, 0, 3);
      if (x === null || z === null || rot === null) return null;
      const out: Command = { op: 'place', type: c.type as BuildingType, x, z, rot: rot as Rotation };
      if (c.w !== undefined && c.w !== null) {
        const w = int(c.w, 1, 64);
        if (w === null) return null;
        out.w = w;
      }
      if (c.h !== undefined && c.h !== null) {
        const h = int(c.h, 1, 64);
        if (h === null) return null;
        out.h = h;
      }
      return out;
    }
    case 'road':
    case 'removeRoad': {
      if (!Array.isArray(c.tiles) || c.tiles.length > MAX_ROAD_TILES) return null;
      const tiles: number[] = [];
      for (const t of c.tiles) {
        const i = int(t, 0, BIG * 4);
        if (i === null) return null;
        tiles.push(i);
      }
      if (c.op === 'removeRoad') return { op: 'removeRoad', tiles };
      if (c.kind !== 'dirt' && c.kind !== 'stone') return null;
      return { op: 'road', kind: c.kind, tiles };
    }
    case 'mark':
    case 'unmark': {
      const v = [c.x0, c.z0, c.x1, c.z1].map((n) => int(n, -BIG, BIG));
      if (v.some((n) => n === null)) return null;
      const [x0, z0, x1, z1] = v as number[];
      if (c.op === 'unmark') return { op: 'unmark', x0, z0, x1, z1 };
      if (!FILTERS.includes(c.filter as RemovalFilter)) return null;
      return { op: 'mark', x0, z0, x1, z1, filter: c.filter as RemovalFilter };
    }
    case 'demolish': {
      const id = int(c.id, 0, 2 ** 31);
      return id === null ? null : { op: 'demolish', id };
    }
    case 'workers': {
      const id = int(c.id, 0, 2 ** 31);
      const n = int(c.n, 0, 999);
      return id === null || n === null ? null : { op: 'workers', id, n };
    }
    case 'builders': {
      const n = int(c.n, 0, 999);
      return n === null ? null : { op: 'builders', n };
    }
    case 'crop': {
      const id = int(c.id, 0, 2 ** 31);
      const ch = c.choice;
      if (id === null || typeof ch !== 'string') return null;
      const own = Object.prototype.hasOwnProperty;
      if (!own.call(CROPS, ch) && !own.call(ORCHARDS, ch) && !own.call(LIVESTOCK, ch)) return null;
      return { op: 'crop', id, choice: ch as Extract<Command, { op: 'crop' }>['choice'] };
    }
    case 'recipe': {
      const id = int(c.id, 0, 2 ** 31);
      const r = int(c.recipe, -1, 64);
      return id === null || r === null ? null : { op: 'recipe', id, recipe: r };
    }
    case 'pause':
    case 'priority': {
      const id = int(c.id, 0, 2 ** 31);
      const flag = c.op === 'pause' ? c.paused : c.priority;
      if (id === null || typeof flag !== 'boolean') return null;
      return c.op === 'pause' ? { op: 'pause', id, paused: flag } : { op: 'priority', id, priority: flag };
    }
    case 'trade': {
      if (!c.give || typeof c.give !== 'object' || Array.isArray(c.give) || !Array.isArray(c.take) || c.take.length > 64) return null;
      const give: Inventory = {};
      for (const [k, v] of Object.entries(c.give as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(RESOURCES, k)) return null;
        const n = int(v, 0, 1e7);
        if (n === null) return null;
        if (n > 0) give[k as ResourceType] = n;
      }
      const take: TradeTake[] = [];
      for (const t of c.take) {
        if (!t || typeof t !== 'object') return null;
        const o = t as Record<string, unknown>;
        const offerIndex = int(o.offerIndex, 0, 255);
        const amount = int(o.amount, 0, 1e7);
        if (offerIndex === null || amount === null) return null;
        take.push({ offerIndex, amount });
      }
      return { op: 'trade', give, take };
    }
    case 'requestMerchant': {
      if (c.kind === null) return { op: 'requestMerchant', kind: null };
      return MERCHANT_KINDS.includes(c.kind as MerchantKind) ? { op: 'requestMerchant', kind: c.kind as MerchantKind } : null;
    }
    case 'nomads':
      return typeof c.accept === 'boolean' ? { op: 'nomads', accept: c.accept } : null;
    case 'speed':
      return (GAME_SPEEDS as readonly number[]).includes(c.speed as number) ? { op: 'speed', speed: c.speed as GameSpeed } : null;
    default:
      return null;
  }
}

const INVALID: CommandResult = { ok: false, reason: 'Invalid command.' };

function mustBuilding(game: Game, id: number): CommandResult | null {
  return game.getBuilding(id) ? null : { ok: false, reason: 'That building no longer exists.' };
}

/** Apply a command to the game right now and report the real outcome. */
export function applyCommand(game: Game, raw: Command): CommandResult {
  const cmd = sanitizeCommand(raw);
  if (!cmd) return INVALID;
  switch (cmd.op) {
    case 'place': {
      const b = game.placeBuilding(cmd.type, cmd.x, cmd.z, cmd.rot, cmd.w, cmd.h);
      if (!b) {
        const chk = game.checkPlacement(cmd.type, cmd.x, cmd.z, cmd.rot, cmd.w, cmd.h);
        return { ok: false, reason: chk.reason ?? 'Cannot build here.' };
      }
      return { ok: true, buildingId: b.id };
    }
    case 'road': {
      const n = game.placeRoad(cmd.tiles, cmd.kind);
      if (n > 0) return { ok: true, count: n };
      // nothing new: blocked everywhere, already a road, or not affordable (the sim posts a message for that)
      return game.checkRoad(cmd.tiles, cmd.kind).ok.length > 0 ? { ok: true, count: 0 } : { ok: false, count: 0, reason: 'A road cannot be built there.' };
    }
    case 'removeRoad': {
      const n = game.removeRoad(cmd.tiles);
      return { ok: true, count: n };
    }
    case 'mark':
      return { ok: true, count: game.markForRemoval(cmd.x0, cmd.z0, cmd.x1, cmd.z1, cmd.filter) };
    case 'unmark':
      return { ok: true, count: game.unmarkRemoval(cmd.x0, cmd.z0, cmd.x1, cmd.z1) };
    case 'demolish': {
      const e = mustBuilding(game, cmd.id);
      if (e) return e;
      game.demolish(cmd.id);
      return { ok: true };
    }
    case 'workers': {
      const e = mustBuilding(game, cmd.id);
      if (e) return e;
      game.setWorkers(cmd.id, cmd.n);
      return { ok: true };
    }
    case 'builders':
      game.setBuilders(cmd.n);
      return { ok: true };
    case 'crop': {
      const pre = precheckCommand(game, cmd);
      if (!pre.ok) return pre;
      game.setCrop(cmd.id, cmd.choice);
      return { ok: true };
    }
    case 'recipe': {
      const pre = precheckCommand(game, cmd);
      if (!pre.ok) return pre;
      game.setRecipe(cmd.id, cmd.recipe);
      return { ok: true };
    }
    case 'pause': {
      const e = mustBuilding(game, cmd.id);
      if (e) return e;
      game.setPaused(cmd.id, cmd.paused);
      return { ok: true };
    }
    case 'priority': {
      const e = mustBuilding(game, cmd.id);
      if (e) return e;
      game.setPriority(cmd.id, cmd.priority);
      return { ok: true };
    }
    case 'trade': {
      const r = game.executeTrade(cmd.give, cmd.take);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'Trade failed.' };
    }
    case 'requestMerchant':
      game.requestMerchant(cmd.kind);
      return { ok: true };
    case 'nomads': {
      if (!game.state.nomads) return { ok: false, reason: 'The nomads have already left.' };
      game.respondToNomads(cmd.accept);
      return { ok: true };
    }
    case 'speed':
      // the shared clock is the session's business; applied directly only in solo play
      game.speed = cmd.speed;
      return { ok: true };
  }
}

/** Cheap local pre-check without mutating (e.g. checkPlacement for 'place'); used by guests before sending. */
export function precheckCommand(game: Game, raw: Command): CommandResult {
  const cmd = sanitizeCommand(raw);
  if (!cmd) return INVALID;
  const s = game.state;
  switch (cmd.op) {
    case 'place': {
      const chk = game.checkPlacement(cmd.type, cmd.x, cmd.z, cmd.rot, cmd.w, cmd.h);
      return chk.ok ? { ok: true } : { ok: false, reason: chk.reason ?? 'Cannot build here.' };
    }
    case 'road': {
      const chk = game.checkRoad(cmd.tiles, cmd.kind);
      const fresh = chk.ok.filter((i) => s.tiles.road[i] === Road.None || (cmd.kind === 'stone' && s.tiles.road[i] === Road.Dirt));
      if (chk.ok.length === 0) return { ok: false, reason: 'A road cannot be built there.' };
      return { ok: true, count: fresh.length };
    }
    case 'removeRoad': {
      let n = 0;
      for (const i of cmd.tiles) if (i < s.tiles.road.length && s.tiles.road[i] !== Road.None) n++;
      return { ok: true, count: n };
    }
    case 'mark':
    case 'unmark':
      return { ok: true };
    case 'demolish':
    case 'workers':
    case 'pause':
    case 'priority':
      return mustBuilding(game, cmd.id) ?? { ok: true };
    case 'builders':
      return { ok: true };
    case 'crop': {
      const b = game.getBuilding(cmd.id);
      if (!b) return { ok: false, reason: 'That building no longer exists.' };
      const un = s.unlocked;
      const ch = cmd.choice;
      if (b.type === 'cropField') return un.crops.includes(ch as never) ? { ok: true } : { ok: false, reason: 'That crop is not available yet.' };
      if (b.type === 'orchard') return un.orchards.includes(ch as never) ? { ok: true } : { ok: false, reason: 'That orchard tree is not available yet.' };
      if (b.type === 'pasture') return un.livestock.includes(ch as never) ? { ok: true } : { ok: false, reason: 'That livestock is not available yet.' };
      return { ok: false, reason: 'This building has no crop choice.' };
    }
    case 'recipe': {
      const b = game.getBuilding(cmd.id);
      if (!b) return { ok: false, reason: 'That building no longer exists.' };
      const recipes = BUILDINGS[b.type].recipes;
      if (!recipes || !(cmd.recipe === -1 || cmd.recipe < recipes.length)) return { ok: false, reason: 'Unknown recipe.' };
      return { ok: true };
    }
    case 'trade': {
      const m = s.trade.merchant;
      if (!m || m.leavesIn <= 0) return { ok: false, reason: 'There is no merchant at the trading post.' };
      let takeValue = 0;
      let any = false;
      for (const t of cmd.take) {
        if (t.amount <= 0) continue;
        const offer = m.offers[t.offerIndex];
        if (!offer) return { ok: false, reason: 'That offer is no longer available.' };
        const qty = offer.kind === 'resource' ? t.amount : 1;
        if (qty > offer.amount) return { ok: false, reason: 'The merchant does not have that many.' };
        takeValue += qty * offer.price;
        any = true;
      }
      if (!any) return { ok: false, reason: 'Choose something to buy from the merchant.' };
      const giveValue = inventoryValue(cmd.give);
      if (giveValue + 1e-6 < takeValue) return { ok: false, reason: 'Your offer is worth less than what you ask for.' };
      const totals = game.resourceTotals();
      for (const k of Object.keys(cmd.give) as ResourceType[]) {
        if (Math.floor(totals[k] ?? 0) < (cmd.give[k] ?? 0)) return { ok: false, reason: 'Not enough goods in storage.' };
      }
      return { ok: true };
    }
    case 'requestMerchant':
      return { ok: true };
    case 'nomads':
      return s.nomads ? { ok: true } : { ok: false, reason: 'The nomads have already left.' };
    case 'speed':
      return { ok: true };
  }
}
