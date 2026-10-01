/**
 * BridgeLayer — wooden bridges on Road.Bridge tiles: plank deck at WATER_LEVEL + 0.25 (citizen walking height),
 * stringers, piles into the water, railings on open sides and ramps onto the banks. One merged world-space mesh,
 * rebuilt (throttled) when rev.roads / rev.terrain change.
 */
import * as THREE from 'three';
import { WATER_LEVEL } from '../../../core/constants';
import type { GameState } from '../../../core/types';
import { Road } from '../../../core/types';
import { hash2 } from '../../../core/rng';
import { heightAt, isLandTerrain } from '../../../core/world';
import { ModelBuilder } from '../builder';
import type { BuildingMaterial } from '../material';
import { C } from '../palette';

export const BRIDGE_DECK_Y = WATER_LEVEL + 0.25;

export class BridgeLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private roadsRev = -1;
  private terrainRev = -1;
  private lastBuild = -1e9;
  private readonly material: BuildingMaterial;

  constructor(material: BuildingMaterial) {
    this.material = material;
    this.group.name = 'bridges';
  }

  reset(): void {
    this.roadsRev = -1;
    this.terrainRev = -1;
    this.lastBuild = -1e9;
    this.clear();
  }

  update(s: GameState, time: number): void {
    if (s.rev.roads === this.roadsRev && s.rev.terrain === this.terrainRev) return;
    // throttle heavy rebuilds (roads change in bursts while dragging)
    if (time - this.lastBuild < 0.25 && this.roadsRev !== -1) return;
    this.roadsRev = s.rev.roads;
    this.terrainRev = s.rev.terrain;
    this.lastBuild = time;
    this.rebuild(s);
  }

  private clear(): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
  }

  private rebuild(s: GameState): void {
    this.clear();
    const { W, H } = s;
    const road = s.tiles.road;
    const terrain = s.tiles.terrain;
    const b = new ModelBuilder(97);
    let any = false;
    const isBridge = (x: number, z: number) => x >= 0 && z >= 0 && x < W && z < H && road[z * W + x] === Road.Bridge;
    const isLand = (x: number, z: number) => x >= 0 && z >= 0 && x < W && z < H && isLandTerrain(terrain[z * W + x]);
    const deck = BRIDGE_DECK_Y;
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        if (road[z * W + x] !== Road.Bridge) continue;
        any = true;
        const bx = (isBridge(x - 1, z) ? 2 : isLand(x - 1, z) ? 1 : 0) + (isBridge(x + 1, z) ? 2 : isLand(x + 1, z) ? 1 : 0);
        const bz = (isBridge(x, z - 1) ? 2 : isLand(x, z - 1) ? 1 : 0) + (isBridge(x, z + 1) ? 2 : isLand(x, z + 1) ? 1 : 0);
        const alongX = bx >= bz;
        const cx = x + 0.5;
        const cz = z + 0.5;
        // local frame: run along local X
        b.at(cx, 0, cz, alongX ? 0 : Math.PI / 2, () => {
          // planks across the run
          for (let i = 0; i < 5; i++) {
            const px = -0.4 + i * 0.2;
            b.box(0.18, 0.05, 0.98, px, deck - 0.05, 0, hash2(x * 5 + i, z, 11) < 0.25 ? C.plankGrey : C.plank, { jitter: 0.07 });
          }
          // stringers
          for (const sz of [-0.33, 0.33]) b.box(1.0, 0.1, 0.1, 0, deck - 0.15, sz, C.timberDark, { snow: false });
          // piles at the tile start edge
          for (const sz of [-0.42, 0.42]) b.cyl(0.06, 1.9, -0.5, deck - 1.95, sz, C.timberDark, { seg: 6 });
          b.box(0.08, 0.08, 0.96, -0.5, deck - 0.26, 0, C.timberDark, { snow: false });
          // railings on open sides
          const sides: [number, boolean][] = alongX
            ? [[-1, isBridge(x, z - 1)], [1, isBridge(x, z + 1)]]
            : [[-1, isBridge(x - 1, z)], [1, isBridge(x + 1, z)]];
          for (const [side, closed] of sides) {
            if (closed) continue;
            const rz = side * 0.47;
            b.box(0.06, 0.42, 0.06, -0.45, deck, rz, C.timber);
            b.beam(-0.5, deck + 0.38, rz, 0.5, deck + 0.38, rz, 0.05, C.timberLight);
            b.beam(-0.5, deck + 0.18, rz, 0.5, deck + 0.18, rz, 0.035, C.timberLight);
          }
        });
        // ramps onto the banks at run ends (only where the bank is notably higher than the deck)
        const ends: [number, number][] = alongX ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
        for (const [dx, dz] of ends) {
          if (!isLand(x + dx, z + dz)) continue;
          const fx = cx + dx * 1.2;
          const fz = cz + dz * 1.2;
          const landY = heightAt(s, fx, fz) + 0.03;
          if (landY < deck + 0.08) continue;
          const ex = cx + dx * 0.42;
          const ez = cz + dz * 0.42;
          if (alongX) b.beam(ex, deck - 0.02, ez, fx, landY, fz, 0.07, C.plank, { t2: 0.9 });
          else b.beam(ex, deck - 0.02, ez, fx, landY, fz, 0.9, C.plank, { t2: 0.07 });
        }
      }
    }
    if (!any) return;
    const g = b.build();
    g.name = 'bridges';
    const mesh = new THREE.Mesh(g, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'bridges';
    this.mesh = mesh;
    this.group.add(mesh);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
