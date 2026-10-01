import { test } from 'vitest';
import { serializeState } from '../../src/sim/save';
import { Rng } from '../../src/core/rng';
import { Feature } from '../../src/core/types';
import { makeSettings, makeWorldState } from '../../tests/simworld.helpers';

test('save size breakdown', () => {
  for (const mapSize of ['small', 'medium', 'large'] as const) {
    const { state } = makeWorldState(makeSettings({ seed: 31, mapSize }));
    const report = (label: string) => {
      const env = JSON.parse(serializeState(state));
      const parts = Object.entries(env.tiles as Record<string, string>).map(([k, v]) => `${k}:${(v.length / 1024).toFixed(1)}K(${v.split(':')[0]})`);
      console.log(`${mapSize} ${label}: total ${(serializeState(state).length / 1024).toFixed(1)}K | state ${(JSON.stringify(env.state).length / 1024).toFixed(1)}K | ${parts.join(' ')}`);
    };
    report('fresh');
    const rng = new Rng(3);
    for (let i = 0; i < state.tiles.feature.length; i++) if (state.tiles.feature[i] === Feature.Tree && state.tiles.featureAmount[i] < 1) state.tiles.featureAmount[i] = Math.min(1, state.tiles.featureAmount[i] + rng.next() * 0.01);
    report('grown saplings');
  }
});
