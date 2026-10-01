import { describe, expect, it } from 'vitest';
import { PresenceTracker, quantize, toolPresenceLabel, type PresenceInput } from '../src/input/presence';

describe('toolPresenceLabel', () => {
  it('names every tool for the Players list', () => {
    expect(toolPresenceLabel({ kind: 'select' })).toBe('Selecting');
    expect(toolPresenceLabel({ kind: 'select' }, { inspecting: true })).toBe('Inspecting');
    expect(toolPresenceLabel({ kind: 'build', type: 'woodenHouse' })).toMatch(/^Building: /);
    expect(toolPresenceLabel({ kind: 'road', road: 'dirt' })).toBe('Laying dirt roads');
    expect(toolPresenceLabel({ kind: 'road', road: 'stone' })).toBe('Laying stone roads');
    expect(toolPresenceLabel({ kind: 'removeRoad' })).toBe('Removing roads');
    expect(toolPresenceLabel({ kind: 'clear', filter: 'trees' })).toBe('Clearing trees');
    expect(toolPresenceLabel({ kind: 'unclear' })).toBe('Cancelling clearing orders');
    expect(toolPresenceLabel({ kind: 'demolish' })).toBe('Demolishing');
    expect(toolPresenceLabel({ kind: 'demolish' }, { inMenu: true })).toBe('In the menu');
  });
});

describe('PresenceTracker', () => {
  const input = (over: Partial<PresenceInput> = {}): PresenceInput => ({
    cursor: { x: 10.01, z: 20.02 },
    camera: { x: 50, z: 60, yaw: 0.5, dist: 40 },
    ghost: null,
    tool: 'Selecting',
    ...over,
  });

  it('returns the same object while nothing visible changed (cheap per-frame publishing)', () => {
    const t = new PresenceTracker();
    const a = t.next(input());
    expect(a.cursor).toEqual([10, 20]);
    expect(a.camera).toEqual({ x: 50, z: 60, yaw: 0.5, dist: 40 });
    // sub-quantum jitter → unchanged
    expect(t.next(input({ cursor: { x: 10.012, z: 20.018 } }))).toBe(a);
    const b = t.next(input({ cursor: { x: 11, z: 20 } }));
    expect(b).not.toBe(a);
    expect(b.cursor).toEqual([11, 20]);
  });

  it('tracks cursor loss, ghosts and tool labels', () => {
    const t = new PresenceTracker();
    const a = t.next(input());
    const b = t.next(input({ cursor: null }));
    expect(b).not.toBe(a);
    expect(b.cursor).toBeNull();
    const ghost = { type: 'woodenHouse' as const, x: 3, z: 4, rot: 1 as const, w: 3, h: 3, valid: true };
    const c = t.next(input({ cursor: null, ghost }));
    expect(c.ghost).toEqual(ghost);
    expect(c.ghost).not.toBe(ghost); // copied: the tool may mutate its own object
    expect(t.next(input({ cursor: null, ghost: { ...ghost } }))).toBe(c);
    const d = t.next(input({ cursor: null, ghost: { ...ghost, valid: false } }));
    expect(d.ghost?.valid).toBe(false);
    const e = t.next(input({ cursor: null, ghost: { ...ghost, valid: false }, tool: 'Demolishing' }));
    expect(e.tool).toBe('Demolishing');
  });

  it('keeps quantised numbers short in JSON', () => {
    const t = new PresenceTracker();
    const p = t.next(input({ cursor: { x: 0.1 * 3, z: 1 / 3 }, camera: { x: 12.345678, z: 0.3, yaw: 1.23456, dist: 33.3 } }));
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/\d{5,}/);
    expect(quantize(0.3, 0.05)).toBeCloseTo(0.3);
  });
});
