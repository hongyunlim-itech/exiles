/**
 * Co-op front end: the RemotePlayersRenderer layer, headless (three.js scene graph only, no WebGL, no DOM labels).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerInfo } from '../src/net/types';
import { footprintGroundY, hashPhase, RemotePlayersRenderer } from '../src/render/remotePlayers';
import type { FrameContext } from '../src/render/types';
import { Game } from '../src/sim/game';

function player(over: Partial<PlayerInfo>): PlayerInfo {
  return {
    peer: 'p1', name: 'Alice', color: '#e0703a', isMe: false, isHost: true, guest: false,
    cursor: null, camera: null, ghost: null, tool: 'Selecting', idleMs: 0, ...over,
  };
}

function ctxFor(game: Game, camera: THREE.PerspectiveCamera): FrameContext {
  return {
    game, camera, realTime: 0, realDt: 1 / 60, gameDt: 0, daylight: 1, snow: 0, season: 'spring', yearProgress: 0,
    focusX: 20, focusZ: 20, cameraDistance: 40, quality: 'low',
  };
}

describe('RemotePlayersRenderer', () => {
  const game = Game.create({ seed: 4242, townName: 'Coop', mapSize: 'small', terrain: 'valleys', climate: 'fair', difficulty: 'easy', disasters: false });

  it('draws other players (not me) with a marker and a tinted ghost, and cleans up when they leave', () => {
    const scene = new THREE.Scene();
    const r = new RemotePlayersRenderer(scene, game);
    const root = scene.getObjectByName('remote-players')!;
    expect(root).toBeTruthy();
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.5, 2500);
    camera.position.set(20, 40, 60);
    camera.lookAt(20, 0, 20);

    let players: PlayerInfo[] = [
      player({ peer: 'me', isMe: true, cursor: [10, 10] }),
      player({
        peer: 'p1', cursor: [30.5, 22.25],
        ghost: { type: 'woodenHouse', x: 29, z: 21, rot: 1, w: 3, h: 3, valid: true },
      }),
    ];
    r.setSource(() => players);
    r.update(ctxFor(game, camera));
    const markers = root.children.filter((o) => o.name.startsWith('remote-player:'));
    expect(markers.map((m) => m.name)).toEqual(['remote-player:p1']);
    expect(markers[0].visible).toBe(true);
    expect(markers[0].position.x).toBeCloseTo(30.5);
    const ghosts = root.children.filter((o) => o.name.startsWith('ghost:'));
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].visible).toBe(true);
    expect(ghosts[0].position.x).toBeCloseTo(29 + 1.5);
    // nothing casts shadows
    let casts = 0;
    root.traverse((o) => { if (o.castShadow) casts++; });
    expect(casts).toBe(0);

    // cursor gone → hidden; malformed ghost ignored
    players = [player({ peer: 'p1', cursor: [Number.NaN, 3], ghost: { type: 'woodenHouse', x: 1, z: 1, rot: 0, w: 5000, h: 3, valid: true } })];
    for (let i = 0; i < 5; i++) r.update(ctxFor(game, camera));
    expect(root.children.find((o) => o.name === 'remote-player:p1')!.visible).toBe(false);
    expect(root.children.filter((o) => o.name.startsWith('ghost:') && o.visible)).toHaveLength(0);

    // left the room → everything removed
    players = [];
    for (let i = 0; i < 5; i++) r.update(ctxFor(game, camera));
    expect(root.children).toHaveLength(0);
    r.dispose();
    expect(scene.getObjectByName('remote-players')).toBeUndefined();
  });

  it('survives a throwing source and a game swap', () => {
    const scene = new THREE.Scene();
    const r = new RemotePlayersRenderer(scene, game);
    r.setSource(() => {
      throw new Error('boom');
    });
    const camera = new THREE.PerspectiveCamera();
    expect(() => r.update(ctxFor(game, camera))).not.toThrow();
    r.setGame(game);
    r.dispose();
  });

  it('helpers: stable phases and a ground height on the map', () => {
    expect(hashPhase('abc')).toBe(hashPhase('abc'));
    expect(hashPhase('abc')).not.toBe(hashPhase('abd'));
    expect(hashPhase('x')).toBeGreaterThanOrEqual(0);
    expect(hashPhase('x')).toBeLessThan(Math.PI * 2);
    const y = footprintGroundY(game.state, 10, 10, 3, 3);
    expect(Number.isFinite(y)).toBe(true);
    expect(y).toBeGreaterThanOrEqual(0);
  });
});
