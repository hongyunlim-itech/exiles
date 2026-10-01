import { describe, expect, it } from 'vitest';
import { hotkeyAction, isTypingTarget, sameTool } from '../src/input/hotkeys';
import { describeBuilding, describeTile } from '../src/input/describe';
import type { Building, GameState } from '../src/core/types';
import { Feature, Road, Terrain } from '../src/core/types';

function fakeState(W = 8, H = 8): GameState {
  const n = W * H;
  return {
    W,
    H,
    tiles: {
      height: new Float32Array((W + 1) * (H + 1)),
      terrain: new Uint8Array(n),
      feature: new Uint8Array(n),
      featureAmount: new Float32Array(n),
      variant: new Uint8Array(n),
      road: new Uint8Array(n),
      building: new Int32Array(n).fill(-1),
      marked: new Uint8Array(n),
      region: new Int32Array(n),
    },
  } as unknown as GameState;
}

function fakeBuilding(patch: Partial<Building>): Building {
  return {
    id: 1, type: 'woodenHouse', x: 0, z: 0, w: 3, h: 3, rotation: 0, doorX: 1, doorZ: 3, state: 'active', progress: 1,
    cost: {}, delivered: {}, incoming: {}, workRemaining: 0, priority: false, paused: false, workersDesired: 0,
    workerIds: [], residentIds: [], inventory: {}, reservedOut: {}, reservedIn: 0, fire: 0, fireFighters: 0,
    smoking: false, producedThisYear: {}, producedLastYear: {}, builtAt: 0,
    ...patch,
  };
}

describe('describeTile', () => {
  it('describes terrain, roads and features', () => {
    const s = fakeState();
    const i = (x: number, z: number) => z * s.W + x;
    s.tiles.terrain[i(1, 1)] = Terrain.Water;
    expect(describeTile(s, () => undefined, 1, 1)).toBe('Shallow water');
    s.tiles.road[i(2, 1)] = Road.Stone;
    expect(describeTile(s, () => undefined, 2, 1)).toBe('Stone road');
    s.tiles.feature[i(3, 1)] = Feature.Tree;
    s.tiles.featureAmount[i(3, 1)] = 0.4;
    s.tiles.variant[i(3, 1)] = 2;
    expect(describeTile(s, () => undefined, 3, 1)).toBe('Grassland · Birch sapling (40% grown)');
    s.tiles.featureAmount[i(3, 1)] = 1;
    s.tiles.marked[i(3, 1)] = 1;
    expect(describeTile(s, () => undefined, 3, 1)).toBe('Grassland · Birch tree · marked for removal');
    s.tiles.feature[i(4, 1)] = Feature.Iron;
    s.tiles.featureAmount[i(4, 1)] = 12.3;
    expect(describeTile(s, () => undefined, 4, 1)).toBe('Grassland · Iron deposit (13 left)');
  });

  it('returns null outside the map', () => {
    const s = fakeState();
    expect(describeTile(s, () => undefined, -1, 0)).toBeNull();
    expect(describeTile(s, () => undefined, 8, 0)).toBeNull();
  });

  it('describes buildings on their tiles', () => {
    const s = fakeState();
    const b = fakeBuilding({ id: 7, residentIds: [1, 2, 3] });
    s.tiles.building[2 * s.W + 2] = 7;
    const text = describeTile(s, (id) => (id === 7 ? b : undefined), 2, 2);
    expect(text).toBe('🏠 Wooden House — 3/5 residents');
  });

  it('building status variants', () => {
    expect(describeBuilding(fakeBuilding({ state: 'construction', progress: 0.456, cost: { log: 16, stone: 8 }, delivered: { log: 10 } })))
      .toBe('🏠 Wooden House — under construction 46%, materials 10/24');
    expect(describeBuilding(fakeBuilding({ state: 'clearing' }))).toContain('cleared');
    expect(describeBuilding(fakeBuilding({ state: 'ruin' }))).toContain('ruins');
    expect(describeBuilding(fakeBuilding({ type: 'gathererHut', workersDesired: 4, workerIds: [1, 2] }))).toBe("🧺 Gatherer's Hut — 2/4 workers");
    expect(describeBuilding(fakeBuilding({ fire: 0.5 }))).toContain('on fire!');
    expect(describeBuilding(fakeBuilding({ type: 'pasture', w: 10, h: 10 }))).toContain('no livestock');
    expect(describeBuilding(fakeBuilding({ type: 'storageBarn', w: 4, h: 5, inventory: { wheat: 100, tool: 20.4 } }))).toBe('🛖 Storage Barn — 120/4000 stored');
    expect(describeBuilding(fakeBuilding({ type: 'stockpile', w: 4, h: 4, inventory: { log: 50 } }))).toBe('📦 Stockpile — 50/400 stored');
  });
});

describe('hotkeys', () => {
  it('maps the input-owned keys', () => {
    expect(hotkeyAction('KeyR', false)).toEqual({ kind: 'rotate', dir: 1 });
    expect(hotkeyAction('KeyR', true)).toEqual({ kind: 'rotate', dir: -1 });
    expect(hotkeyAction('Escape', false)).toEqual({ kind: 'escape' });
    expect(hotkeyAction('Space', false)).toEqual({ kind: 'pause' });
    expect(hotkeyAction('Digit1', false)).toEqual({ kind: 'speed', speed: 1 });
    expect(hotkeyAction('Digit2', false)).toEqual({ kind: 'speed', speed: 2 });
    expect(hotkeyAction('Digit3', false)).toEqual({ kind: 'speed', speed: 5 });
    expect(hotkeyAction('Numpad4', false)).toEqual({ kind: 'speed', speed: 10 });
    expect(hotkeyAction('KeyC', false)).toEqual({ kind: 'tool', tool: { kind: 'clear', filter: 'all' } });
    expect(hotkeyAction('KeyV', false)).toEqual({ kind: 'tool', tool: { kind: 'road', road: 'dirt' } });
    expect(hotkeyAction('KeyG', false)).toEqual({ kind: 'grid' });
    expect(hotkeyAction('Delete', false)).toEqual({ kind: 'demolishSelected' });
  });

  it('leaves camera and UI keys alone', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'Home', 'KeyP', 'KeyO', 'KeyN', 'KeyL', 'KeyK', 'KeyH', 'Digit5']) {
      expect(hotkeyAction(code, false)).toBeNull();
    }
  });

  it('detects text fields', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'CANVAS' } as unknown as EventTarget)).toBe(false);
  });

  it('compares tools', () => {
    expect(sameTool({ kind: 'clear', filter: 'all' }, { kind: 'clear', filter: 'all' })).toBe(true);
    expect(sameTool({ kind: 'clear', filter: 'all' }, { kind: 'clear', filter: 'trees' })).toBe(false);
    expect(sameTool({ kind: 'road', road: 'dirt' }, { kind: 'road', road: 'stone' })).toBe(false);
    expect(sameTool({ kind: 'build', type: 'well' }, { kind: 'build', type: 'well' })).toBe(true);
    expect(sameTool({ kind: 'select' }, { kind: 'demolish' })).toBe(false);
  });
});
