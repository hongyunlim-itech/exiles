/**
 * Resource & industry models: forester's lodge, woodcutter, quarry, mine, blacksmith, tailor, herbalist, brewery.
 */
import type { ModelBuilder } from '../builder';
import { C } from '../palette';
import {
  barrel, bush, cart, chimney, crate, doorAt, gableHouse, hangingSign, ladder, logLines, logPile, plinth, profileRoof,
  roofYAt, sack, smallTree, stump, table, timberFace, windowAt, woodStack,
} from '../parts';
import { quoins } from './housing';
import { body, bodyC, type ModelFn } from '../spec';

const PI = Math.PI;

export const foresterLodge: ModelFn = (b, { variant }) => {
  const ph = 0.1;
  const bx = -0.3;
  const bz = -0.3;
  const len = 1.85;
  const depth = 1.6;
  const wallTop = 1.0;
  const ridge = 1.85;
  const front = bz + depth / 2;
  plinth(b, len + 0.12, depth + 0.12, ph, bx, bz, C.stoneDark);
  gableHouse(b, {
    x: bx, z: bz, len, depth, y0: ph, wallTop, ridge, axis: 'x', wall: C.log, roof: variant === 2 ? C.shingle : C.mossRoof,
    gable: C.plank, corners: C.timberDark, thick: 0.12, over: 0.2, endOver: 0.14, ridgeCap: C.leafDark,
  });
  logLines(b, bx, front, 'pz', len - 0.14, ph, wallTop);
  logLines(b, bx - len / 2, bz, 'nx', depth - 0.14, ph, wallTop);
  doorAt(b, bx + 0.35, ph, front, 'pz', { h: 0.66, color: C.doorGreen });
  windowAt(b, bx - 0.4, 0.45, front, 'pz', { w: 0.22, h: 0.24, shutters: C.doorGreen });
  windowAt(b, bx - len / 2, 0.45, bz, 'nx', { w: 0.22, h: 0.24 });
  const top = chimney(b, bx - 0.5, bz - 0.35, ph, Math.max(2.0, roofYAt(wallTop, ridge, depth, 0.35) + 0.5), 0.26, C.stone);
  // sapling nursery (rows of young conifers) on the right
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 5; i++) {
      const x = 0.98 + r * 0.34;
      const z = -1.15 + i * 0.52;
      b.box(0.24, 0.04, 0.24, x, 0, z, C.soil, { snow: true });
      smallTree(b, x, 0.04, z, b.range(0.28, 0.5), 'conifer', r === 0 ? C.conifer : C.leaf);
    }
  }
  stump(b, -0.9, 0, 1.05, 0.14, 0.2, true);
  logPile(b, -0.25, 0, 1.15, 0.9, 2, 0.07, 0);
  return { chimneys: [top], body: bodyC(bx, bz, len, depth, wallTop) };
};

export const woodcutter: ModelFn = (b, { variant }) => {
  const ph = 0.1;
  // small workshop hut (ridge along Z, gable toward the front)
  const hx = -0.72;
  const hz = -0.45;
  const sx = 1.25;
  const lz = 1.5;
  plinth(b, sx + 0.1, lz + 0.1, ph, hx, hz, C.stoneDark);
  gableHouse(b, {
    x: hx, z: hz, len: lz, depth: sx, y0: ph, wallTop: 0.95, ridge: 1.62, axis: 'z', wall: C.plank,
    roof: variant === 1 ? C.thatch : C.shingle, gable: C.plank, corners: C.timberDark, thick: 0.1, over: 0.12, endOver: 0.12,
    ridgeCap: C.shingleDark,
  });
  doorAt(b, hx, ph, hz + lz / 2, 'pz', { h: 0.66 });
  windowAt(b, hx - sx / 2, 0.45, hz, 'nx', { w: 0.22, h: 0.22 });
  const top = chimney(b, hx + 0.3, hz - 0.45, ph, 1.95, 0.24, C.stone);
  // open lean-to shed on the right
  const x0 = 0.05;
  const x1 = 1.35;
  const z0 = -1.3;
  const z1 = 0.35;
  for (const z of [z0 + 0.05, z1 - 0.05]) {
    b.box(0.08, 1.2, 0.08, x0 + 0.05, 0, z, C.timberDark);
    b.box(0.08, 0.9, 0.08, x1 - 0.05, 0, z, C.timberDark);
  }
  profileRoof(b, [[x0 - 0.05, 1.28], [x1 + 0.1, 0.92]], z1 - z0 + 0.1, { z: (z0 + z1) / 2, axis: 'z', color: variant === 1 ? C.thatch : C.shingle, thick: 0.07, endOver: 0.05 });
  woodStack(b, (x0 + x1) / 2, 0, z0 + 0.22, 1.15, 0.6, 0.32, 0, false);
  stump(b, 0.7, 0, -0.1, 0.16, 0.24, true);
  for (let i = 0; i < 5; i++) b.box(0.07, 0.07, 0.24, 0.5 + b.range(-0.25, 0.25), 0, 0.15 + b.range(-0.1, 0.1), C.logEnd, { ry: b.rand() * PI });
  // logs waiting to be split
  logPile(b, 0.2, 0, 1.05, 1.5, 2, 0.085, 0);
  woodStack(b, -0.9, 0, 0.75, 0.7, 0.38, 0.26, 0, false);
  return { chimneys: [top], body: body(-1.35, 1.35, -1.3, 0.35, 0.95) };
};

/** Quarry: a U-shaped stepped pit wall (rock terraces) open toward the door, cut blocks, crane, cart. */
export const quarry: ModelFn = (b, { w, h }) => {
  const hx = w / 2 - 0.12;
  const hz = h / 2 - 0.12;
  const levels = 3;
  const band = 0.62;
  const stepH = 0.34;
  const frontZ = hz - 0.9;
  // gravel floor
  b.box(w - 0.4, 0.02, h - 0.4, 0, 0, 0, 0x9e988c, { jitter: 0.02 });
  for (let l = 0; l < levels; l++) {
    const hgt = stepH * (levels - l);
    const ox = hx - l * band;
    const oz = hz - l * band;
    const ix = ox - band;
    const topC = l === 0 ? C.grassTuft : C.stoneDark;
    const faceC = l === 0 ? C.mountainDark : C.rockFresh;
    const ze = frontZ - l * 0.35;
    // back band, chunked
    const chunks = Math.max(2, Math.round((ox * 2) / 1.1));
    for (let i = 0; i < chunks; i++) {
      const cx = -ox + ((i + 0.5) * (ox * 2)) / chunks;
      const hh = hgt * b.range(0.94, 1.06);
      b.box((ox * 2) / chunks + 0.01, hh, band, cx, 0, -oz + band / 2, faceC, { jitter: 0.06 });
      b.box((ox * 2) / chunks - 0.02, 0.05, band - 0.04, cx, hh, -oz + band / 2, topC, { jitter: 0.05 });
    }
    // side bands
    for (const s of [-1, 1]) {
      const zs = -oz + band;
      const zl = ze - zs;
      const n = Math.max(2, Math.round(zl / 1.1));
      for (let i = 0; i < n; i++) {
        const cz = zs + ((i + 0.5) * zl) / n;
        const hh = hgt * b.range(0.94, 1.06) * (i === n - 1 ? 0.8 : 1);
        b.box(band, hh, zl / n + 0.01, s * (ix + band / 2), 0, cz, faceC, { jitter: 0.06 });
        b.box(band - 0.04, 0.05, zl / n - 0.02, s * (ix + band / 2), hh, cz, topC, { jitter: 0.05 });
      }
    }
  }
  // grass lip boulders on the outer rim
  for (let i = 0; i < 6; i++) b.blob(b.range(0.15, 0.25), 0.12, b.range(0.15, 0.25), b.range(-hx + 0.3, hx - 0.3), stepH * levels + 0.05, -hz + 0.3, C.mountain);
  // cut blocks stacked on the floor
  const floorX = hx - levels * band;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) b.box(0.34, 0.26, 0.34, -floorX + 0.35 + i * 0.37, 0, 1.2 + j * 0.37, C.stoneLight, { ry: b.range(-0.05, 0.05) });
  }
  b.box(0.34, 0.26, 0.34, -floorX + 0.54, 0.26, 1.38, C.stoneLight, { ry: 0.1 });
  b.box(0.5, 0.35, 0.45, 0.4, 0, -floorX + 0.6, C.rockFresh, { ry: 0.3 });
  // wooden crane (derrick)
  b.at(floorX - 0.35, 0, -0.2, 0, () => {
    b.box(0.12, 2.3, 0.12, 0, 0, 0, C.timberDark);
    b.beam(0, 0, 0.5, 0, 1.2, 0.05, 0.07, C.timber);
    b.beam(0, 0, -0.5, 0, 1.2, -0.05, 0.07, C.timber);
    b.beam(0, 2.1, 0, -1.3, 1.75, 0.3, 0.07, C.timber);
    b.beam(0, 2.3, 0, -1.25, 1.8, 0.3, 0.02, C.rope, { snow: false });
    b.cyl(0.012, 0.9, -1.25, 0.85, 0.3, C.rope, { seg: 3 });
    b.box(0.3, 0.22, 0.3, -1.25, 0.63, 0.3, C.stoneLight);
  });
  ladder(b, -floorX + 0.3, 0, -floorX + 0.22, stepH * 2 + 0.2, 0, 0.2);
  cart(b, 0.9, 0, 1.6, 0.4, C.stoneLight);
  table(b, -0.2, 0, 1.9, 0.6, 0.35, 0.36, 0.2, C.plankGrey);
  return { chimneys: [], body: body(-hx, hx, -hz, hz, stepH * levels) };
};

/** Mine: timber-framed tunnel mouth in a rocky hill (-Z), rails, ore cart, spoil heap, tool shed. */
export const mine: ModelFn = (b, { variant }) => {
  // the hill
  b.box(2.6, 1.55, 1.3, 0, 0, -1.2, C.mountainDark, { jitter: 0.05 });
  b.blob(1.2, 1.45, 1.0, -1.25, 0.5, -1.4, C.mountain);
  b.blob(1.2, 1.3, 0.95, 1.25, 0.45, -1.45, C.mountainDark);
  b.blob(1.5, 1.2, 0.9, 0.1, 1.2, -1.55, C.mountain);
  b.blob(0.6, 0.5, 0.5, -1.7, 0.2, -0.45, C.mountainDark);
  b.blob(0.55, 0.45, 0.5, 1.75, 0.15, -0.5, C.mountain);
  b.blob(0.45, 0.14, 0.35, 0.3, 2.3, -1.75, C.grassTuft, { snow: true });
  b.blob(0.3, 0.1, 0.25, -1.4, 1.85, -1.5, C.grassTuft);
  // tunnel mouth
  const fz = -0.52;
  b.box(0.92, 1.1, 0.5, 0, 0, fz - 0.2, C.black, { snow: false, jitter: 0 });
  for (const s of [-1, 1]) {
    b.box(0.14, 1.18, 0.14, s * 0.52, 0, fz + 0.05, C.timberDark);
    b.beam(s * 0.52, 0.8, fz + 0.05, s * 0.3, 1.12, fz + 0.05, 0.08, C.timber);
  }
  b.box(1.36, 0.16, 0.18, 0, 1.12, fz + 0.05, C.timberDark);
  b.boxc(1.5, 0.05, 0.6, 0, 1.42, fz + 0.1, C.shingle, { rx: 0.35 });
  b.box(0.08, 0.1, 0.08, 0.66, 0.85, fz + 0.14, C.window, { glow: 1, snow: false });
  // rails & sleepers
  const z0 = fz - 0.1;
  const z1 = 2.25;
  for (let z = z0 + 0.1; z < z1; z += 0.3) b.box(0.62, 0.04, 0.1, 0, 0, z, C.timberDark, { jitter: 0.08 });
  for (const s of [-1, 1]) b.box(0.035, 0.05, z1 - z0, s * 0.19, 0.04, (z0 + z1) / 2, C.ironDark, { snow: false });
  // ore cart on the rails
  b.at(0, 0.09, 1.0, 0, () => {
    b.box(0.5, 0.32, 0.62, 0, 0.1, 0, C.timber);
    b.box(0.54, 0.05, 0.66, 0, 0.36, 0, C.ironDark);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) b.cyl(0.08, 0.04, sx * 0.21, 0.08, sz * 0.2, C.ironDark, { rz: PI / 2, seg: 7 });
    }
    b.blob(0.2, 0.12, 0.25, 0, 0.42, 0, C.rust, { jitter: 0.1 });
  });
  // spoil heap & ore pile
  b.blob(0.6, 0.38, 0.55, 1.55, 0, 1.25, C.mountainDark);
  b.blob(0.3, 0.2, 0.3, 1.25, 0.1, 1.7, C.rust);
  for (let i = 0; i < 5; i++) b.blob(0.1, 0.08, 0.1, -1.0 + b.range(-0.25, 0.25), 0.05, 1.9 + b.range(-0.15, 0.15), i % 2 ? C.rust : C.ironDark);
  // tool shed
  const sx = -1.55;
  const sz = 1.05;
  plinth(b, 1.0, 0.9, 0.08, sx, sz, C.stoneDark);
  gableHouse(b, {
    x: sx, z: sz, len: 0.9, depth: 0.8, y0: 0.08, wallTop: 0.72, ridge: 1.22, axis: 'x', wall: variant === 1 ? C.plankGrey : C.plank,
    roof: C.shingle, gable: C.plank, corners: C.timberDark, thick: 0.08, over: 0.14, endOver: 0.1, ridgeCap: C.shingleDark,
  });
  doorAt(b, sx, 0.08, sz + 0.4, 'pz', { w: 0.34, h: 0.55, step: null });
  crate(b, -0.7, 0, 1.95, 0.24, C.plankGrey, 0.4);
  barrel(b, 0.75, 0, 2.05, 0.11, 0.28);
  return { chimneys: [], body: body(-1.4, 1.4, -2.4, 0.2, 1.55) };
};

export const blacksmith: ModelFn = (b, { variant }) => {
  const ph = 0.12;
  const bx = -0.72;
  const bz = -0.32;
  const sx = 2.0;
  const lz = 2.3;
  const wallTop = 1.28;
  const ridge = 2.35;
  const front = bz + lz / 2;
  plinth(b, sx + 0.12, lz + 0.12, ph, bx, bz, C.stoneDark);
  gableHouse(b, {
    x: bx, z: bz, len: lz, depth: sx, y0: ph, wallTop, ridge, axis: 'z', wall: C.stone, roof: variant === 1 ? C.slate : C.shingle,
    gable: C.plankGrey, corners: null, thick: 0.1, over: 0.2, endOver: 0.12, ridgeCap: C.shingleDark,
  });
  quoins(b, bx, bz, sx, lz, ph, wallTop);
  doorAt(b, bx - 0.3, ph, front, 'pz', { h: 0.72, w: 0.46 });
  windowAt(b, bx + 0.45, 0.55, front, 'pz', { shutters: C.timberDark });
  windowAt(b, bx - sx / 2, 0.55, bz, 'nx');
  // forge lean-to on the right
  const x0 = bx + sx / 2;
  const x1 = 1.8;
  const z0 = -1.45;
  const z1 = 0.62;
  for (const z of [z0 + 0.06, z1 - 0.06]) b.box(0.1, 0.92, 0.1, x1 - 0.08, 0, z, C.timberDark);
  profileRoof(b, [[x0 - 0.05, 1.34], [x1 + 0.1, 0.95]], z1 - z0 + 0.1, { z: (z0 + z1) / 2, axis: 'z', color: variant === 1 ? C.slate : C.shingle, thick: 0.08, endOver: 0.05 });
  // forge hearth with glowing coals + big chimney
  const fx = x0 + 0.42;
  const fz = -1.05;
  b.box(0.8, 0.62, 0.7, fx, 0, fz, C.stoneDark);
  b.box(0.6, 0.03, 0.5, fx, 0.62, fz + 0.02, C.ember, { ember: 1, snow: false });
  b.box(0.7, 0.3, 0.45, fx, 0.82, fz - 0.1, C.stone, { rx: -0.2 });
  b.box(0.56, 1.1, 0.56, fx, 0.62, fz - 0.2, C.stoneDark);
  const top = chimney(b, fx, fz - 0.2, 1.72, 2.75, 0.4, C.stoneDark);
  // bellows
  b.box(0.26, 0.12, 0.36, fx + 0.56, 0.38, fz, C.hide, { rz: -0.15 });
  // anvil on a stump
  b.at(x0 + 0.62, 0, 0.08, 0.3, () => {
    b.cyl(0.14, 0.32, 0, 0, 0, C.log, { seg: 7 });
    b.box(0.1, 0.1, 0.1, 0, 0.32, 0, C.ironDark);
    b.box(0.32, 0.08, 0.13, 0, 0.42, 0, C.iron);
    b.cone(0.05, 0.14, 0.16, 0.46, 0, C.iron, { rz: -PI / 2, seg: 5 });
  });
  // quench trough
  b.box(0.3, 0.26, 0.55, x1 - 0.2, 0, -0.35, C.plank);
  b.box(0.24, 0.01, 0.47, x1 - 0.2, 0.25, -0.35, C.waterDark, { snow: false });
  // grindstone + iron bars out front
  b.at(0.55, 0, 1.3, 0.4, () => {
    b.box(0.05, 0.35, 0.05, -0.1, 0, 0, C.timberDark);
    b.box(0.05, 0.35, 0.05, 0.1, 0, 0, C.timberDark);
    b.cyl(0.2, 0.08, -0.04, 0.33, 0, C.stoneLight, { rz: PI / 2, seg: 10 });
  });
  for (let i = 0; i < 4; i++) b.box(0.5, 0.04, 0.06, -0.55, i * 0.04, 1.35 + (i % 2) * 0.07, C.iron, { ry: 0.1 * i, snow: i === 3 });
  barrel(b, -1.62, 0, 1.3, 0.12, 0.3);
  return { chimneys: [top], body: body(bx - sx / 2, x1, bz - lz / 2, front, wallTop) };
};

export const tailor: ModelFn = (b, { variant }) => {
  const ph = 0.12;
  const bx = -0.62;
  const bz = -0.3;
  const len = 2.35;
  const depth = 1.7;
  const wallTop = 1.15;
  const ridge = 2.1;
  const front = bz + depth / 2;
  const wall = variant === 1 ? C.plasterWarm : C.plaster;
  plinth(b, len + 0.12, depth + 0.12, ph, bx, bz, C.stoneDark);
  gableHouse(b, {
    x: bx, z: bz, len, depth, y0: ph, wallTop, ridge, axis: 'x', wall, roof: variant === 2 ? C.shingle : C.thatch,
    gable: wall, corners: C.timberDark, thick: variant === 2 ? 0.1 : 0.15, over: 0.2, endOver: 0.14, ridgeCap: C.thatchDark,
  });
  timberFace(b, bx, front, 'pz', len, ph, wallTop, C.timberDark, 4);
  timberFace(b, bx, bz - depth / 2, 'nz', len, ph, wallTop, C.timberDark, 4);
  timberFace(b, bx - len / 2, bz, 'nx', depth, ph, wallTop, C.timberDark, 3);
  timberFace(b, bx + len / 2, bz, 'px', depth, ph, wallTop, C.timberDark, 3);
  doorAt(b, bx + 0.45, ph, front, 'pz', { h: 0.7, color: C.clothPurple });
  windowAt(b, bx - 0.5, 0.5, front, 'pz', { w: 0.32, shutters: C.clothPurple });
  hangingSign(b, bx + 0.95, 1.0, front, 'pz', C.plank, C.clothPurple);
  const top = chimney(b, bx - 0.6, bz - 0.35, ph, Math.max(2.2, roofYAt(wallTop, ridge, depth, 0.35) + 0.55), 0.26, C.stone);
  // clothes line with hanging cloth
  const lx0 = 0.78;
  const lx1 = 1.82;
  const lz = -0.6;
  for (const x of [lx0, lx1]) {
    b.box(0.06, 1.1, 0.06, x, 0, lz, C.timber);
    b.box(0.3, 0.04, 0.04, x, 1.05, lz, C.timber);
  }
  for (const dz of [-0.12, 0.12]) {
    b.beam(lx0, 1.05, lz + dz, lx1, 1.03, lz + dz, 0.012, C.rope, { snow: false });
  }
  const cloths = [C.clothRed, C.clothBlue, C.cloth, C.clothYellow, C.clothGreen];
  for (let i = 0; i < 4; i++) {
    const x = lx0 + 0.2 + i * 0.22;
    b.box(0.17, 0.34, 0.015, x, 0.7, lz + (i % 2 ? 0.12 : -0.12), cloths[(i + variant) % cloths.length], { snow: false, rz: b.range(-0.05, 0.05) });
  }
  // wool bales and crates
  for (let i = 0; i < 3; i++) b.blob(0.16, 0.13, 0.14, 0.95 + i * 0.3, 0.12, 0.8 + (i % 2) * 0.12, C.white, { jitter: 0.04 });
  crate(b, 1.7, 0, 1.05, 0.24, C.plank, 0.2);
  return { chimneys: [top], body: bodyC(bx, bz, len, depth, wallTop) };
};

function herbBed(b: ModelBuilder, x: number, z: number, len: number): void {
  b.box(0.3, 0.07, len, x, 0, z, C.soil);
  const n = Math.round(len / 0.22);
  for (let i = 0; i < n; i++) {
    const zz = z - len / 2 + (i + 0.5) * (len / n);
    bush(b, x, 0.05, zz, 0.08, i % 3 === 0 ? C.leafDark : C.leaf);
    if (i % 2 === 0) b.blob(0.03, 0.03, 0.03, x + b.range(-0.05, 0.05), 0.18, zz, b.pick([C.flowerPurple, C.flowerYellow, C.flowerWhite]));
  }
}

export const herbalist: ModelFn = (b, { variant }) => {
  const ph = 0.1;
  const bx = -0.35;
  const bz = -0.35;
  const len = 1.9;
  const depth = 1.6;
  const wallTop = 1.0;
  const ridge = 1.92;
  const front = bz + depth / 2;
  plinth(b, len + 0.12, depth + 0.12, ph, bx, bz, C.stoneDark);
  gableHouse(b, {
    x: bx, z: bz, len, depth, y0: ph, wallTop, ridge, axis: 'x', wall: C.plasterWarm, roof: variant === 1 ? C.thatch : C.mossRoof,
    gable: C.plasterWarm, corners: C.timber, thick: 0.15, over: 0.22, endOver: 0.14, ridgeCap: C.leafDark,
  });
  doorAt(b, bx + 0.3, ph, front, 'pz', { h: 0.66, color: C.doorGreen });
  windowAt(b, bx - 0.4, 0.45, front, 'pz', { w: 0.24, h: 0.24, shutters: C.doorGreen });
  windowAt(b, bx - len / 2, 0.45, bz, 'nx', { w: 0.22, h: 0.22 });
  // herb bundles drying under the eave
  for (let i = 0; i < 4; i++) {
    const x = bx - 0.75 + i * 0.16;
    b.cyl(0.006, 0.14, x, 0.86, front + 0.12, C.rope, { seg: 3 });
    b.blob(0.035, 0.07, 0.035, x, 0.8, front + 0.12, i % 2 ? C.leaf : C.flowerPurple, { snow: false });
  }
  const top = chimney(b, bx + 0.55, bz - 0.4, ph, Math.max(2.05, roofYAt(wallTop, ridge, depth, 0.4) + 0.5), 0.24, C.stone);
  herbBed(b, 0.95, -0.25, 2.1);
  herbBed(b, 1.32, -0.25, 2.1);
  table(b, -0.9, 0, 1.05, 0.5, 0.32, 0.32, 0.2, C.plankGrey);
  b.cyl(0.06, 0.06, -0.95, 0.36, 1.05, C.stoneLight, { seg: 7, rTop: 0.08 });
  b.blob(0.05, 0.04, 0.05, -0.78, 0.38, 1.05, C.leaf);
  sack(b, -0.1, 0, 1.05, 0x8a9a6a, 0.8);
  return { chimneys: [top], body: bodyC(bx, bz, len, depth, wallTop) };
};

export const brewery: ModelFn = (b, { variant }) => {
  const ph = 0.12;
  const bx = -0.45;
  const bz = -0.4;
  const len = 2.6;
  const depth = 2.05;
  const wallTop = 1.3;
  const ridge = 2.4;
  const front = bz + depth / 2;
  plinth(b, len + 0.12, depth + 0.12, ph, bx, bz, C.stoneDark);
  gableHouse(b, {
    x: bx, z: bz, len, depth, y0: ph, wallTop, ridge, axis: 'x', wall: variant === 1 ? C.stoneWarm : C.stone, roof: C.tileRed,
    gable: C.plasterWarm, corners: null, thick: 0.1, over: 0.2, endOver: 0.12, ridgeCap: C.shingleDark,
  });
  quoins(b, bx, bz, len, depth, ph, wallTop);
  doorAt(b, bx - 0.4, ph, front, 'pz', { w: 0.55, h: 0.8, arch: true });
  windowAt(b, bx + 0.45, 0.6, front, 'pz', { shutters: C.doorRed });
  windowAt(b, bx - len / 2, 0.6, bz, 'nx');
  hangingSign(b, bx + 0.95, 1.12, front, 'pz', C.plank, C.brass);
  // kiln chimney
  const top = chimney(b, bx + 0.7, bz - 0.55, ph, 3.1, 0.42, C.stoneWarm);
  // brewing vat
  b.cyl(0.36, 0.62, 1.35, 0, -0.75, C.timber, { seg: 10 });
  for (const y of [0.12, 0.5]) b.cyl(0.375, 0.04, 1.35, y, -0.75, C.ironDark, { seg: 10, noBottom: true, snow: false });
  b.cyl(0.33, 0.02, 1.35, 0.6, -0.75, 0x7a5a2a, { seg: 10, snow: false });
  ladder(b, 1.35, 0, -0.33, 0.7, 0, 0.08);
  // barrel pyramid (lying barrels)
  const bxs = [1.05, 1.36];
  for (const x of bxs) barrel(b, x, 0.14, 0.95, 0.14, 0.4, C.timber, 'z');
  barrel(b, 1.205, 0.37, 0.95, 0.14, 0.4, C.timber, 'z');
  barrel(b, -1.5, 0, 1.2, 0.12, 0.3);
  crate(b, -1.15, 0, 1.3, 0.22, C.plank, 0.3);
  sack(b, 0.35, 0, 1.3, C.hay, 0.9);
  return { chimneys: [top], body: bodyC(bx, bz, len, depth, wallTop) };
};
