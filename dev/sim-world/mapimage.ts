/** Render a generated world to an RGB image (dev-only visual check). */
import { Feature, Terrain } from '../../src/core/types';
import type { Animal, TileData } from '../../src/core/types';

function hex(c: number): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

const COL = {
  grass: hex(0x6f8f45),
  sand: hex(0xc9b98a),
  water: hex(0x4f7f86),
  deep: hex(0x2d5566),
  mountain: hex(0x7d766c),
  snow: hex(0xe8eef2),
  conifer: hex(0x2c4a26),
  deciduous: hex(0x46702c),
  birch: hex(0x8aa55a),
  rock: hex(0xc8c6be),
  iron: hex(0xb4532a),
  deer: hex(0xff3010),
  start: hex(0xffe000),
};

export function renderWorld(W: number, H: number, tiles: TileData, animals: Animal[], startX: number, startZ: number, scale = 3): { w: number; h: number; rgb: Uint8Array } {
  const w = W * scale;
  const h = H * scale;
  const rgb = new Uint8Array(w * h * 3);
  const CW = W + 1;
  const hh = tiles.height;
  const put = (px: number, py: number, c: [number, number, number], k = 1): void => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const o = (py * w + px) * 3;
    rgb[o] = Math.max(0, Math.min(255, c[0] * k));
    rgb[o + 1] = Math.max(0, Math.min(255, c[1] * k));
    rgb[o + 2] = Math.max(0, Math.min(255, c[2] * k));
  };
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const c = z * CW + x;
      const h00 = hh[c], h10 = hh[c + 1], h01 = hh[c + CW], h11 = hh[c + CW + 1];
      const avg = (h00 + h10 + h01 + h11) / 4;
      const dx = (h10 + h11 - h00 - h01) / 2;
      const dz = (h01 + h11 - h00 - h10) / 2;
      // light from north-west
      let shade = 1 + (-dx * -0.7 + -dz * -0.7) * 0.35 * -1;
      shade = Math.max(0.55, Math.min(1.35, shade));
      let col: [number, number, number];
      const t = tiles.terrain[i];
      if (t === Terrain.DeepWater) col = COL.deep;
      else if (t === Terrain.Water) col = COL.water;
      else if (t === Terrain.Sand) col = COL.sand;
      else if (t === Terrain.Mountain) {
        const k = Math.min(1, Math.max(0, (avg - 7) / 3));
        col = [COL.mountain[0] * (1 - k) + COL.snow[0] * k, COL.mountain[1] * (1 - k) + COL.snow[1] * k, COL.mountain[2] * (1 - k) + COL.snow[2] * k];
      } else col = COL.grass;
      let k = shade;
      if (t === Terrain.Grass || t === Terrain.Sand) k *= 0.85 + Math.min(0.3, avg * 0.08);
      if (t === Terrain.Water || t === Terrain.DeepWater) k = 1 + Math.max(-0.35, avg * 0.18);
      for (let py = 0; py < scale; py++) for (let px = 0; px < scale; px++) put(x * scale + px, z * scale + py, col, k);
      const f = tiles.feature[i];
      if (f !== Feature.None) {
        let fc: [number, number, number];
        let size = Math.max(1, scale - 1);
        if (f === Feature.Tree) {
          const v = tiles.variant[i];
          fc = v === 0 ? COL.conifer : v === 1 ? COL.deciduous : COL.birch;
          if (tiles.featureAmount[i] < 0.5) size = 1;
        } else fc = f === Feature.Rock ? COL.rock : COL.iron;
        const off = Math.floor((scale - size) / 2);
        for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) put(x * scale + off + px, z * scale + off + py, fc);
      }
    }
  }
  for (const a of animals) {
    const px = Math.floor(a.x * scale);
    const py = Math.floor(a.z * scale);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(px + dx, py + dy, COL.deer);
  }
  // start square (24x24) outline
  const s0x = (startX - 12) * scale, s1x = (startX + 12) * scale, s0z = (startZ - 12) * scale, s1z = (startZ + 12) * scale;
  for (let x = s0x; x <= s1x; x++) {
    put(x, s0z, COL.start);
    put(x, s1z, COL.start);
  }
  for (let z = s0z; z <= s1z; z++) {
    put(s0x, z, COL.start);
    put(s1x, z, COL.start);
  }
  // 30-tile radius circle
  for (let a = 0; a < 720; a++) {
    const ang = (a / 720) * Math.PI * 2;
    put(Math.floor((startX + 0.5 + Math.cos(ang) * 30) * scale), Math.floor((startZ + 0.5 + Math.sin(ang) * 30) * scale), COL.start);
  }
  return { w, h, rgb };
}
