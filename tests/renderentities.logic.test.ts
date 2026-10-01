import { describe, expect, it } from 'vitest';
import type { Activity, GameState } from '../src/core/types';
import { Feature, Road } from '../src/core/types';
import { featureKey, rockScale, treeGrowthScale } from '../src/render/nature';
import {
  CARRY_LOG, CARRY_NONE, CARRY_SACK, TOOL_AXE, TOOL_BOW, TOOL_BUCKET, TOOL_HAMMER, TOOL_HOE, TOOL_NONE, TOOL_PICK, TOOL_ROD,
} from '../src/render/entities/citizenModel';
import { computePose, createPose, type PoseInput } from '../src/render/entities/citizenPose';
import { carryKindOf } from '../src/render/entities/citizenLook';
import { BRIDGE_DECK_Y, entityGroundY, tilePlane } from '../src/render/entities/ground';
import { HERD_PARAMS, Herd } from '../src/render/entities/livestockSim';
import { lerpAngle, wrapAngle } from '../src/render/entities/math';
import { createFoliageParams, evalCurve, foliageAt } from '../src/render/entities/palette';

const ACTIVITIES: Activity[] = [
  'idle', 'walking', 'working', 'building', 'hauling', 'gathering', 'chopping', 'mining', 'farming', 'fishing', 'hunting',
  'eating', 'warming', 'studying', 'healing', 'praying', 'firefighting', 'playing', 'sick',
];

function poseInput(p: Partial<PoseInput> = {}): PoseInput {
  return {
    activity: 'idle', moving: false, walkPhase: 0, t: 1.3, seed: 0.4, elderly: false, child: false, carry: CARRY_NONE,
    profession: 'laborer', sick: 0, ...p,
  };
}

describe('palette', () => {
  it('evaluates cyclic month-centre curves', () => {
    const keys = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(evalCurve(keys, 0.5 / 12)).toBeCloseTo(0);
    expect(evalCurve(keys, 5.5 / 12)).toBeCloseTo(5);
    expect(evalCurve(keys, 6 / 12)).toBeCloseTo(5.5);
    // wraps from December back to January
    expect(evalCurve(keys, 0)).toBeCloseTo(5.5);
    expect(evalCurve(keys, 1)).toBeCloseTo(5.5);
  });

  it('deciduous trees are bare in winter, full in summer, turned in autumn', () => {
    const p = createFoliageParams();
    expect(foliageAt('deciduous', 10.5 / 12, p).leaf).toBe(0);
    expect(foliageAt('deciduous', 4.5 / 12, p).leaf).toBe(1);
    expect(foliageAt('deciduous', 4.5 / 12, p).autumn).toBe(0);
    expect(foliageAt('deciduous', 7.5 / 12, p).autumn).toBeGreaterThan(0.9);
    expect(foliageAt('birch', 10.5 / 12, p).leaf).toBe(0);
  });

  it('conifers stay green all year and orchards blossom in spring', () => {
    const p = createFoliageParams();
    for (let m = 0; m < 12; m++) {
      expect(foliageAt('conifer', (m + 0.5) / 12, p).leaf).toBe(1);
      expect(p.autumn).toBe(0);
    }
    expect(foliageAt('orchard', 1.5 / 12, p).blossom).toBe(1);
    expect(foliageAt('orchard', 6.5 / 12, p).blossom).toBe(0);
  });
});

describe('citizen poses', () => {
  it('produces finite joint angles for every activity, moving or not', () => {
    const out = createPose();
    for (const activity of ACTIVITIES) {
      for (const moving of [false, true]) {
        for (const elderly of [false, true]) {
          for (let t = 0; t < 4; t += 0.37) {
            computePose(poseInput({ activity, moving, elderly, t, walkPhase: t * 3 }), out);
            for (const v of Object.values(out)) {
              if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('assigns activity tools', () => {
    const out = createPose();
    const tool = (activity: Activity, extra: Partial<PoseInput> = {}) => computePose(poseInput({ activity, ...extra }), out).tool;
    expect(tool('chopping')).toBe(TOOL_AXE);
    expect(tool('mining')).toBe(TOOL_PICK);
    expect(tool('building')).toBe(TOOL_HAMMER);
    expect(tool('farming')).toBe(TOOL_HOE);
    expect(tool('fishing')).toBe(TOOL_ROD);
    expect(tool('hunting')).toBe(TOOL_BOW);
    expect(tool('firefighting')).toBe(TOOL_BUCKET);
    expect(tool('working', { profession: 'blacksmith' })).toBe(TOOL_HAMMER);
    expect(tool('idle')).toBe(TOOL_NONE);
  });

  it('swings legs in opposition while walking and holds carried goods', () => {
    const out = createPose();
    computePose(poseInput({ moving: true, walkPhase: Math.PI / 2 }), out);
    expect(out.legL).toBeGreaterThan(0.3);
    expect(out.legR).toBeLessThan(-0.3);
    computePose(poseInput({ moving: true, walkPhase: Math.PI / 2, carry: CARRY_SACK }), out);
    expect(out.carry).toBe(CARRY_SACK);
    expect(out.armL).toBeGreaterThan(1);
    expect(out.armR).toBeGreaterThan(1);
    computePose(poseInput({ moving: true, carry: CARRY_LOG }), out);
    expect(out.armR).toBeGreaterThan(2);
  });

  it('bends the elderly forward', () => {
    const a = computePose(poseInput(), createPose()).lean;
    const b = computePose(poseInput({ elderly: true }), createPose()).lean;
    expect(b - a).toBeGreaterThan(0.2);
  });

  it('maps resources to carried-good meshes', () => {
    expect(carryKindOf('log')).toBe(CARRY_LOG);
    expect(carryKindOf('wheat')).toBe(CARRY_SACK);
  });
});

describe('livestock wandering', () => {
  const bounds = { x0: 10.6, z0: 20.6, x1: 19.4, z1: 27.4 };

  it('syncs the herd size with the pasture count', () => {
    const h = new Herd('sheep', 42);
    h.sync(7, bounds);
    expect(h.grazers.length).toBe(7);
    h.sync(3, bounds);
    expect(h.grazers.length).toBe(3);
    h.sync(0, bounds);
    expect(h.grazers.length).toBe(0);
  });

  it('keeps every animal inside the pasture and actually moves them', () => {
    for (const type of Object.keys(HERD_PARAMS) as (keyof typeof HERD_PARAMS)[]) {
      const h = new Herd(type, 7);
      h.sync(12, bounds);
      const start = h.grazers.map((g) => [g.x, g.z]);
      let moved = 0;
      for (let i = 0; i < 2000; i++) {
        h.step(0.05, bounds);
        for (const g of h.grazers) {
          expect(g.x).toBeGreaterThanOrEqual(bounds.x0 - 1e-9);
          expect(g.x).toBeLessThanOrEqual(bounds.x1 + 1e-9);
          expect(g.z).toBeGreaterThanOrEqual(bounds.z0 - 1e-9);
          expect(g.z).toBeLessThanOrEqual(bounds.z1 + 1e-9);
          expect(g.headDown).toBeGreaterThanOrEqual(-1e-9);
          expect(g.headDown).toBeLessThanOrEqual(1 + 1e-9);
        }
      }
      h.grazers.forEach((g, i) => {
        if (Math.hypot(g.x - start[i][0], g.z - start[i][1]) > 0.3) moved++;
      });
      expect(moved).toBeGreaterThan(6);
    }
  });

  it('is deterministic per seed', () => {
    const a = new Herd('cattle', 99);
    const b = new Herd('cattle', 99);
    a.sync(5, bounds);
    b.sync(5, bounds);
    for (let i = 0; i < 300; i++) {
      a.step(0.1, bounds);
      b.step(0.1, bounds);
    }
    expect(a.grazers.map((g) => [g.x, g.z])).toEqual(b.grazers.map((g) => [g.x, g.z]));
  });
});

describe('nature helpers', () => {
  it('packs feature keys that change with visible state only', () => {
    const k = featureKey(Feature.Tree, 0, 1, 0.5);
    expect(featureKey(Feature.None, 1, 2, 3)).toBe(0);
    expect(featureKey(Feature.Tree, 1, 1, 0.5)).not.toBe(k); // marked
    expect(featureKey(Feature.Tree, 0, 2, 0.5)).not.toBe(k); // species
    expect(featureKey(Feature.Tree, 0, 1, 0.6)).not.toBe(k); // visible growth step
    expect(featureKey(Feature.Tree, 0, 1, 0.501)).toBe(k); // sub-step growth ignored
    expect(featureKey(Feature.Rock, 0, 0, 12)).not.toBe(featureKey(Feature.Rock, 0, 0, 11));
    expect(featureKey(Feature.Rock, 0, 0, 12)).not.toBe(featureKey(Feature.Iron, 0, 0, 12));
    expect(featureKey(Feature.Iron, 1, 2, 400)).toBeLessThan(65536);
  });

  it('scales trees by growth and rocks by remaining amount', () => {
    expect(treeGrowthScale(1)).toBe(1);
    expect(treeGrowthScale(0)).toBeGreaterThan(0.1);
    expect(treeGrowthScale(0.5)).toBeLessThan(1);
    expect(rockScale(40)).toBeCloseTo(1.4);
    expect(rockScale(0)).toBeCloseTo(0.6);
    expect(rockScale(1000)).toBeCloseTo(1.4);
  });

  it('wraps and interpolates angles along the shortest arc', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1);
  });
});

describe('ground height', () => {
  function flatState(): GameState {
    const W = 4;
    const H = 4;
    const height = new Float32Array((W + 1) * (H + 1)).fill(1);
    // water column x = 2 (corners below water)
    for (let z = 0; z <= H; z++) {
      height[z * (W + 1) + 2] = -0.5;
      height[z * (W + 1) + 3] = -0.5;
    }
    const road = new Uint8Array(W * H);
    road[1 * W + 2] = Road.Bridge;
    return { W, H, tiles: { height, road } } as unknown as GameState;
  }

  it('stands on bridge decks over water', () => {
    const s = flatState();
    expect(entityGroundY(s, 2.5, 1.5)).toBeCloseTo(BRIDGE_DECK_Y);
    expect(entityGroundY(s, 2.5, 2.5)).toBeLessThan(0);
    expect(entityGroundY(s, 0.5, 0.5)).toBeCloseTo(1);
  });

  it('describes a tile plane as base + slopes', () => {
    const s = flatState();
    const out = [0, 0, 0];
    tilePlane(s, 1, 0, out);
    expect(out[0]).toBeCloseTo(0.25);
    expect(out[1]).toBeCloseTo(-1.5);
    expect(out[2]).toBeCloseTo(0);
  });
});
