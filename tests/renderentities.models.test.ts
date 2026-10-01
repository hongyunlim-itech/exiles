import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildBeans, buildCorn, buildCornCobs, buildFurrows, buildMounds, buildOrchardFruit, buildOrchardTree, buildPotato,
  buildStubble, buildWheat,
} from '../src/render/entities/cropModels';
import {
  buildArm, buildCarry, buildHairLong, buildHairShort, buildHand, buildHatCap, buildHatStraw, buildHead, buildLeg,
  buildSkirt, buildTool, buildTorso, CARRY_COUNT, TOOL_COUNT,
} from '../src/render/entities/citizenModel';
import { buildCattle, buildChicken, buildDeer, buildSheep } from '../src/render/entities/animalModels';
import { buildIron, buildMarker, buildRock, buildTree, SPECIES_TOP } from '../src/render/entities/treeModels';

function tris(g: THREE.BufferGeometry): number {
  return g.getAttribute('position').count / 3;
}

function checkAttributes(g: THREE.BufferGeometry): void {
  for (const name of ['position', 'normal', 'color', 'aPart', 'aCenter']) expect(g.getAttribute(name)).toBeTruthy();
  const pos = g.getAttribute('position').array as Float32Array;
  for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true);
}

describe('tree models', () => {
  it('stay within triangle budgets (10k trees on screen)', () => {
    for (let sp = 0; sp < 3; sp++) {
      const hi = buildTree(sp, 0);
      const lo = buildTree(sp, 1);
      checkAttributes(hi);
      checkAttributes(lo);
      expect(tris(hi)).toBeLessThanOrEqual(260);
      expect(tris(lo)).toBeLessThanOrEqual(90);
      expect(tris(lo)).toBeLessThan(tris(hi));
    }
  });

  it('have mature heights within the spec (1.8–3.5) matching SPECIES_TOP', () => {
    for (let sp = 0; sp < 3; sp++) {
      const g = buildTree(sp, 0);
      g.computeBoundingBox();
      const top = g.boundingBox!.max.y;
      expect(top).toBeGreaterThan(1.8);
      expect(top).toBeLessThan(3.5);
      expect(Math.abs(top - SPECIES_TOP[sp])).toBeLessThan(0.35);
      expect(g.boundingBox!.min.y).toBeGreaterThan(-0.05);
    }
  });

  it('builds rocks, iron and markers', () => {
    for (const g of [buildRock(), buildIron()]) {
      checkAttributes(g);
      expect(tris(g)).toBeLessThanOrEqual(120);
      g.computeBoundingBox();
      expect(g.boundingBox!.max.y).toBeGreaterThan(0.35);
      expect(g.boundingBox!.max.y).toBeLessThan(0.7);
    }
    expect(tris(buildMarker())).toBe(8);
  });
});

describe('citizen & animal models', () => {
  it('builds every body part, tool and carried good', () => {
    const parts = [buildLeg(), buildTorso(), buildSkirt(), buildHead(), buildHairShort(), buildHairLong(), buildHatStraw(), buildHatCap(), buildArm(), buildHand()];
    for (let k = 1; k < TOOL_COUNT; k++) parts.push(buildTool(k));
    for (let k = 1; k < CARRY_COUNT; k++) parts.push(buildCarry(k));
    let total = 0;
    for (const g of parts) {
      checkAttributes(g);
      total += tris(g);
    }
    // A fully dressed citizen (all parts at most once each + 2 legs/arms/hands) stays cheap.
    expect(total).toBeLessThan(1500);
  });

  it('builds all animals with 4 (or 2) legs', () => {
    for (const m of [buildDeer(), buildSheep(), buildCattle(), buildChicken()]) {
      checkAttributes(m.body);
      checkAttributes(m.head);
      checkAttributes(m.leg);
      expect([2, 4]).toContain(m.legPivots.length);
      expect(tris(m.body) + tris(m.head) + tris(m.leg) * m.legPivots.length).toBeLessThan(400);
    }
  });
});

describe('crop models', () => {
  it('keeps per-tile crops cheap', () => {
    const budget: [THREE.BufferGeometry, number][] = [
      [buildFurrows(), 60], [buildWheat(), 120], [buildCorn(), 160], [buildCornCobs(), 60], [buildPotato(), 140],
      [buildBeans(), 260], [buildStubble(), 100], [buildMounds(), 140], [buildOrchardTree(), 200], [buildOrchardFruit(), 400],
    ];
    for (const [g, max] of budget) {
      checkAttributes(g);
      expect(tris(g)).toBeLessThanOrEqual(max);
    }
  });
});
