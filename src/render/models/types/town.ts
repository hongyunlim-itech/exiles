/**
 * Town service models: well, school, hospital, chapel, tavern, market, trading post, town hall.
 */
import type * as THREE from 'three';
import type { ModelBuilder } from '../builder';
import { C } from '../palette';
import {
  barrel, bench, bush, chimney, crate, doorAt, flagPole, gableHouse, gableRoof, hangingSign, marketStall, plinth,
  roofYAt, sack, smallTree, timberFace, wellCore, windowAt,
} from '../parts';
import { quoins } from './housing';
import { body, bodyC, type ModelFn } from '../spec';

const PI = Math.PI;

export const well: ModelFn = (b) => {
  b.cyl(0.66, 0.05, 0, 0, 0, C.cobble, { seg: 10 });
  wellCore(b, 0, 0, 1);
  b.cyl(0.08, 0.12, 0.42, 0.55, 0.26, C.timber, { seg: 7, rTop: 0.1 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + 0.4;
    b.blob(0.08, 0.05, 0.08, Math.cos(a) * 0.78, 0.02, Math.sin(a) * 0.78, C.stoneDark);
  }
  return { chimneys: [], body: body(-0.55, 0.55, -0.55, 0.55, 1.42) };
};

/** Small open bell cupola with a pyramid roof (used by the school). */
function cupola(b: ModelBuilder, x: number, y: number, z: number, s = 0.45, h = 0.55, roof: number = C.slate): void {
  b.box(s + 0.06, 0.08, s + 0.06, x, y, z, C.timberDark);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.06, h, 0.06, x + sx * (s / 2 - 0.03), y + 0.08, z + sz * (s / 2 - 0.03), C.plasterWhite);
  b.cyl(0.1, 0.14, x, y + 0.2, z, C.brass, { seg: 8, rTop: 0.05 });
  b.pyramid(s / 2 + 0.08, s / 2 + 0.08, 0.42, x, y + h + 0.08, z, roof);
  b.cyl(0.015, 0.2, x, y + h + 0.5, z, C.ironDark, { seg: 4 });
}

export const school: ModelFn = (b, { variant }) => {
  const ph = 0.14;
  const bz = -0.4;
  const sx = 2.8;
  const lz = 3.5;
  const wallTop = 1.38;
  const ridge = 2.55;
  const front = bz + lz / 2;
  plinth(b, sx + 0.12, lz + 0.12, ph, 0, bz, C.stoneDark);
  gableHouse(b, {
    z: bz, len: lz, depth: sx, y0: ph, wallTop, ridge, axis: 'z', wall: C.plasterWhite, roof: variant === 1 ? C.shingle : C.slate,
    gable: C.plasterWhite, corners: C.timberDark, thick: 0.1, over: 0.2, endOver: 0.14, ridgeCap: C.shingleDark,
  });
  timberFace(b, sx / 2, bz, 'px', lz, ph, wallTop, C.timberDark, 5);
  timberFace(b, -sx / 2, bz, 'nx', lz, ph, wallTop, C.timberDark, 5);
  doorAt(b, 0, ph, front, 'pz', { w: 0.5, h: 0.8, color: C.doorBlue });
  // porch roof over the door
  b.boxc(1.0, 0.05, 0.5, 0, 1.12, front + 0.22, C.shingle, { rx: -0.3 });
  for (const s of [-1, 1]) b.box(0.06, 1.05, 0.06, s * 0.45, 0, front + 0.42, C.timberDark);
  windowAt(b, -0.85, 0.6, front, 'pz', { w: 0.32, h: 0.4, shutters: C.doorBlue });
  windowAt(b, 0.85, 0.6, front, 'pz', { w: 0.32, h: 0.4, shutters: C.doorBlue });
  windowAt(b, 0, 1.75, front, 'pz', { w: 0.26, h: 0.26 });
  for (const z of [-1.3, -0.1, 1.0]) {
    windowAt(b, sx / 2, 0.58, bz + z, 'px', { w: 0.36, h: 0.44 });
    windowAt(b, -sx / 2, 0.58, bz + z, 'nx', { w: 0.36, h: 0.44 });
  }
  const top = chimney(b, 0.5, bz - 1.2, ph, ridge + 0.3, 0.28, C.stone);
  // bell cupola on the ridge near the front
  cupola(b, 0, ridge - 0.02, front - 0.55, 0.46, 0.5);
  // yard
  bench(b, -1.2, 0, front + 0.45, 0, 0.6);
  smallTree(b, 1.35, 0, front + 0.5, 0.95, 'round');
  return { chimneys: [top], body: bodyC(0, bz, sx, lz, wallTop) };
};

export const hospital: ModelFn = (b, { variant }) => {
  const ph = 0.14;
  // main wing along X at the back
  const mz = -1.15;
  const mlen = 4.2;
  const mdep = 1.8;
  const wallTop = 1.35;
  const ridge = 2.45;
  const wall = C.plasterWhite;
  const roof = variant === 1 ? C.shingle : C.tileRed;
  plinth(b, mlen + 0.12, mdep + 0.12, ph, 0, mz, C.stoneDark);
  gableHouse(b, {
    z: mz, len: mlen, depth: mdep, y0: ph, wallTop, ridge, axis: 'x', wall, roof, gable: wall, corners: C.timberDark,
    thick: 0.1, over: 0.2, endOver: 0.12, ridgeCap: C.shingleDark,
  });
  // front wing along Z (entrance gable)
  const fx = 0;
  const fz = 0.55;
  const fw = 1.6;
  const flen = 1.9;
  plinth(b, fw + 0.12, flen + 0.12, ph, fx, fz, C.stoneDark);
  gableHouse(b, {
    x: fx, z: fz, len: flen, depth: fw, y0: ph, wallTop: 1.3, ridge: 2.25, axis: 'z', wall, roof, gable: wall,
    corners: C.timberDark, thick: 0.1, over: 0.18, endOver: 0.14, ridgeCap: C.shingleDark,
  });
  const ffront = fz + flen / 2;
  doorAt(b, 0, ph, ffront, 'pz', { w: 0.52, h: 0.8, color: C.doorRed, arch: true });
  // red cross board above the door
  b.at(0, 1.45, ffront + 0.02, 0, () => {
    b.box(0.42, 0.42, 0.04, 0, 0, 0, C.white, { snow: false });
    b.box(0.3, 0.1, 0.06, 0, 0.16, 0, C.red, { snow: false });
    b.box(0.1, 0.3, 0.06, 0, 0.06, 0, C.red, { snow: false });
  });
  windowAt(b, fw / 2, 0.6, fz, 'px', { w: 0.3, h: 0.4 });
  windowAt(b, -fw / 2, 0.6, fz, 'nx', { w: 0.3, h: 0.4 });
  const mfront = mz + mdep / 2;
  for (const x of [-1.6, -1.05, 1.05, 1.6]) windowAt(b, x, 0.6, mfront, 'pz', { w: 0.3, h: 0.4, shutters: C.doorRed });
  for (const x of [-1.4, -0.45, 0.45, 1.4]) windowAt(b, x, 0.6, mz - mdep / 2, 'nz', { w: 0.3, h: 0.4 });
  windowAt(b, mlen / 2, 0.6, mz, 'px', { w: 0.3, h: 0.4 });
  windowAt(b, -mlen / 2, 0.6, mz, 'nx', { w: 0.3, h: 0.4 });
  const top = chimney(b, -1.3, mz - 0.4, ph, Math.max(ridge + 0.2, roofYAt(wallTop, ridge, mdep, 0.4) + 0.6), 0.3, C.stone);
  // flag with red cross
  flagPole(b, 1.75, 0, 1.75, 2.6, C.white, 0, C.red);
  bench(b, -1.3, 0, 1.2, 0, 0.7);
  bush(b, -1.85, 0, 0.3, 0.2);
  bush(b, 1.0, 0, 0.3, 0.18);
  return { chimneys: [top], body: body(-mlen / 2, mlen / 2, mz - mdep / 2, ffront, wallTop) };
};

export const chapel: ModelFn = (b, { variant }) => {
  const ph = 0.16;
  const nz = -0.95;
  const nw = 2.6;
  const nlen = 3.7;
  const wallTop = 1.95;
  const ridge = 3.35;
  const stone = variant === 1 ? C.stoneWarm : C.stone;
  const roof = variant === 2 ? C.shingle : C.slate;
  plinth(b, nw + 0.14, nlen + 0.14, ph, 0, nz, C.stoneDark);
  gableHouse(b, {
    z: nz, len: nlen, depth: nw, y0: ph, wallTop, ridge, axis: 'z', wall: stone, roof, gable: stone,
    corners: null, thick: 0.1, over: 0.2, endOver: 0.12, ridgeCap: C.shingleDark,
  });
  // buttresses & lancet windows along the nave
  const glass = [C.stainedBlue, C.stainedRed, C.stainedGold];
  for (let i = 0; i < 3; i++) {
    const z = nz - nlen / 2 + 0.55 + i * 1.2;
    for (const s of [-1, 1]) {
      b.box(0.22, 1.35, 0.24, s * (nw / 2 + 0.1), 0, z - 0.45, C.stoneDark);
      b.boxc(0.22, 0.3, 0.24, s * (nw / 2 + 0.06), 1.4, z - 0.45, C.stoneDark, { rz: s * 0.5 });
      windowAt(b, s * nw / 2, 0.75, z + 0.15, s > 0 ? 'px' : 'nx', { w: 0.24, h: 0.72, glass: glass[i % 3], frame: C.stoneLight });
    }
  }
  // round apse window at the back
  b.cyl(0.3, 0.05, 0, 1.4, nz - nlen / 2 - 0.02, C.stoneLight, { rx: -PI / 2, seg: 10 });
  b.cyl(0.24, 0.06, 0, 1.4, nz - nlen / 2 - 0.02, C.stainedBlue, { rx: -PI / 2, seg: 10, glow: 1 });
  // tower at the front
  const tz = nz + nlen / 2 + 0.62;
  const ts = 1.36;
  const tTop = 3.55;
  plinth(b, ts + 0.14, ts + 0.14, ph, 0, tz, C.stoneDark);
  b.box(ts, tTop - ph, ts, 0, ph, tz, stone);
  quoins(b, 0, tz, ts, ts, ph, tTop, C.stoneLight);
  b.box(ts + 0.12, 0.1, ts + 0.12, 0, 2.4, tz, C.stoneLight);
  b.box(ts + 0.14, 0.12, ts + 0.14, 0, tTop, tz, C.stoneLight);
  // belfry openings on all four sides
  for (const face of ['pz', 'px', 'nx', 'nz'] as const) {
    const ry = face === 'pz' ? 0 : face === 'px' ? PI / 2 : face === 'nx' ? -PI / 2 : PI;
    b.at(0, 0, tz, ry, () => {
      b.box(0.42, 0.6, 0.04, 0, 2.7, ts / 2 + 0.005, C.black, { snow: false, jitter: 0 });
      b.cyl(0.21, 0.04, 0, 3.3, ts / 2 - 0.015, C.black, { rx: PI / 2, seg: 8, snow: false, jitter: 0 });
    });
  }
  // spire + cross
  b.pyramid(ts / 2 + 0.08, ts / 2 + 0.08, 1.55, 0, tTop + 0.12, tz, roof);
  const spireTop = tTop + 0.12 + 1.55;
  b.box(0.05, 0.42, 0.05, 0, spireTop - 0.05, tz, C.gold);
  b.box(0.24, 0.05, 0.05, 0, spireTop + 0.2, tz, C.gold);
  // arched door + rose window on the tower front
  const tfront = tz + ts / 2;
  doorAt(b, 0, ph, tfront, 'pz', { w: 0.56, h: 0.9, arch: true, color: C.door, frame: C.stoneLight });
  b.cyl(0.24, 0.05, 0, 1.75, tfront, C.stoneLight, { rx: PI / 2, seg: 10 });
  b.cyl(0.19, 0.06, 0, 1.75, tfront, C.stainedRed, { rx: PI / 2, seg: 10, glow: 1, snow: false });
  // path stones & shrubs
  for (let i = 0; i < 3; i++) b.box(0.4, 0.03, 0.2, 0, 0, tfront + 0.2 + i * 0.22, C.stoneLight, { jitter: 0.06 });
  bush(b, -1.9, 0, tz - 0.2, 0.22, C.leafDark);
  bush(b, 1.9, 0, tz + 0.4, 0.2, C.leafDark);
  return {
    chimneys: [],
    body: body(-nw / 2 - 0.2, nw / 2 + 0.2, nz - nlen / 2, tfront, wallTop),
    fires: [b.point(0, wallTop + 0.6, nz - 0.8), b.point(0, wallTop + 0.6, nz + 0.9), b.point(0, tTop, tz)],
  };
};

export const tavern: ModelFn = (b, { variant }) => {
  const ph = 0.14;
  // two-storey main block at the back (ridge along X)
  const mz = -1.2;
  const mlen = 3.1;
  const mdep = 2.2;
  const g1 = 1.15;
  const up1 = 2.25;
  const ridge = 3.3;
  const plaster = variant === 1 ? C.plaster : C.plasterWarm;
  plinth(b, mlen + 0.12, mdep + 0.12, ph, 0, mz, C.stoneDark);
  b.box(mlen, g1 - ph, mdep, 0, ph, mz, C.stone);
  quoins(b, 0, mz, mlen, mdep, ph, g1);
  b.box(mlen + 0.14, 0.08, mdep + 0.14, 0, g1, mz, C.timberDark);
  b.box(mlen + 0.1, up1 - g1 - 0.08, mdep + 0.1, 0, g1 + 0.08, mz, plaster);
  timberFace(b, 0, mz + (mdep + 0.1) / 2, 'pz', mlen + 0.1, g1 + 0.08, up1, C.timberDark, 5);
  timberFace(b, 0, mz - (mdep + 0.1) / 2, 'nz', mlen + 0.1, g1 + 0.08, up1, C.timberDark, 5);
  timberFace(b, (mlen + 0.1) / 2, mz, 'px', mdep + 0.1, g1 + 0.08, up1, C.timberDark, 3);
  timberFace(b, -(mlen + 0.1) / 2, mz, 'nx', mdep + 0.1, g1 + 0.08, up1, C.timberDark, 3);
  const roof = variant === 2 ? C.thatch : C.tileRed;
  gableRoof(b, {
    z: mz, len: mlen + 0.1, depth: mdep + 0.1, wallTop: up1, ridge, axis: 'x', color: roof, gable: plaster,
    over: 0.12, endOver: 0.14, thick: variant === 2 ? 0.15 : 0.1, ridgeCap: C.shingleDark,
  });
  const mfu = mz + (mdep + 0.1) / 2;
  for (const x of [-1.05, 1.05]) windowAt(b, x, 1.55, mfu, 'pz', { w: 0.3, h: 0.34 });
  for (const x of [-0.9, 0.2, 1.0]) windowAt(b, x, 1.55, mz - (mdep + 0.1) / 2, 'nz', { w: 0.3, h: 0.34 });
  windowAt(b, (mlen + 0.1) / 2, 1.55, mz, 'px');
  windowAt(b, -(mlen + 0.1) / 2, 1.55, mz, 'nx');
  windowAt(b, mlen / 2, 0.5, mz, 'px');
  const c1 = chimney(b, -(mlen / 2) + 0.2, mz - 0.35, ph, ridge + 0.35, 0.36, C.stoneDark);
  // single-storey taproom in front (ridge along Z)
  const tz = 0.62;
  const tw = 2.3;
  const tlen = 1.55;
  const tfront = tz + tlen / 2;
  plinth(b, tw + 0.12, tlen + 0.12, ph, -0.1, tz, C.stoneDark);
  gableHouse(b, {
    x: -0.1, z: tz, len: tlen, depth: tw, y0: ph, wallTop: 1.15, ridge: 2.1, axis: 'z', wall: plaster, roof,
    gable: plaster, corners: C.timberDark, thick: variant === 2 ? 0.14 : 0.1, over: 0.16, endOver: 0.12, ridgeCap: C.shingleDark,
  });
  doorAt(b, -0.1 - 0.45, ph, tfront, 'pz', { w: 0.5, h: 0.78, color: C.doorRed });
  // bay window
  b.box(0.8, 0.5, 0.2, 0.35, 0.35, tfront, C.timberDark);
  b.box(0.7, 0.4, 0.22, 0.35, 0.4, tfront + 0.01, C.window, { glow: 1, snow: false });
  b.box(0.9, 0.05, 0.28, 0.35, 0.9, tfront + 0.02, C.shingle);
  windowAt(b, -0.1 + tw / 2, 0.5, tz, 'px', { w: 0.3, h: 0.34 });
  windowAt(b, -0.1 - tw / 2, 0.5, tz, 'nx', { w: 0.3, h: 0.34 });
  hangingSign(b, 1.05, 1.1, tfront - 0.2, 'px', C.plank, C.ale);
  // barrels & benches out front
  barrel(b, 1.35, 0, 1.6, 0.13, 0.32);
  barrel(b, 1.35, 0, 1.28, 0.13, 0.32);
  barrel(b, 1.36, 0.32, 1.44, 0.12, 0.3);
  bench(b, -1.25, 0, 2.05, 0, 0.6);
  bench(b, 0.2, 0, 2.15, 0, 0.6);
  return {
    chimneys: [c1],
    body: body(-mlen / 2 - 0.05, mlen / 2 + 0.05, mz - mdep / 2, tfront, g1),
  };
};

export const market: ModelFn = (b, { w, h }) => {
  const hx = w / 2;
  const hz = h / 2;
  const slots: THREE.Vector3[] = [];
  const stripes = [C.clothRed, C.clothBlue, C.clothGreen, C.clothYellow, C.clothPurple, C.clothRed];
  const d = 0.75;
  const edge = 0.45;
  const place = (x: number, z: number, ry: number, i: number) => {
    slots.push(...marketStall(b, x, z, ry, stripes[i % stripes.length], C.cloth, 1.35));
  };
  // back row (facing +Z), left & right rows (facing the centre)
  place(-1.35, -hz + edge + d / 2, 0, 0);
  place(1.35, -hz + edge + d / 2, 0, 1);
  place(-hx + edge + d / 2, -0.35, PI / 2, 2);
  place(-hx + edge + d / 2, 1.55, PI / 2, 3);
  place(hx - edge - d / 2, -0.35, -PI / 2, 4);
  place(hx - edge - d / 2, 1.55, -PI / 2, 5);
  // central market cross
  b.box(1.1, 0.12, 1.1, 0, 0, 0.1, C.stoneDark);
  b.box(0.8, 0.12, 0.8, 0, 0.12, 0.1, C.stone);
  b.cyl(0.13, 1.35, 0, 0.24, 0.1, C.stoneLight, { seg: 8 });
  b.box(0.1, 0.34, 0.1, 0, 1.55, 0.1, C.stoneLight);
  b.box(0.34, 0.1, 0.1, 0, 1.68, 0.1, C.stoneLight);
  // clutter: crates, sacks, barrels, benches
  crate(b, -0.9, 0, 1.0, 0.26, C.plank, 0.3);
  crate(b, -0.62, 0, 1.12, 0.22, C.plankGrey, 0.8);
  sack(b, 0.85, 0, -0.9, C.hay);
  sack(b, 1.05, 0, -0.75, 0xb49c72);
  barrel(b, 0.95, 0, 1.1, 0.12, 0.3);
  bench(b, 0, 0, 1.25, 0, 0.6);
  bench(b, 0, 0, -1.0, 0, 0.6);
  // corner lamp posts
  for (const s of [-1, 1]) {
    b.box(0.06, 1.3, 0.06, s * (hx - 0.3), 0, hz - 0.3, C.timberDark);
    b.box(0.12, 0.14, 0.12, s * (hx - 0.3), 1.3, hz - 0.3, C.window, { glow: 1, snow: false });
    b.pyramid(0.09, 0.09, 0.08, s * (hx - 0.3), 1.44, hz - 0.3, C.ironDark);
  }
  return { chimneys: [], body: body(-hx + 0.4, hx - 0.4, -hz + 0.4, hz - 0.4, 1.1), slots };
};

/**
 * Trading post: warehouse on the land side (+Z) with a loading hoist, a broad pier over the water toward -Z,
 * a cargo crane and a mooring spot for the merchant boat (left of the pier).
 */
export const tradingPost: ModelFn = (b, { variant }) => {
  const ph = 0.12;
  const wx = -0.75;
  const wz = 1.5;
  const len = 3.1;
  const depth = 1.9;
  const wallTop = 1.6;
  const ridge = 2.75;
  plinth(b, len + 0.12, depth + 0.12, ph, wx, wz, C.stoneDark);
  gableHouse(b, {
    x: wx, z: wz, len, depth, y0: ph, wallTop, ridge, axis: 'x', wall: variant === 1 ? C.barnRed : C.plank,
    roof: C.shingle, gable: C.plank, corners: C.timberDark, thick: 0.1, over: 0.2, endOver: 0.12, ridgeCap: C.shingleDark,
  });
  const front = wz + depth / 2;
  const back = wz - depth / 2;
  for (let x = wx - len / 2 + 0.2; x < wx + len / 2 - 0.1; x += 0.32) {
    b.box(0.05, wallTop - ph - 0.04, 0.03, x, ph, front + 0.012, C.timberDark, { snow: false });
  }
  doorAt(b, wx + 0.6, ph, front, 'pz', { w: 0.5, h: 0.8, color: C.doorBlue });
  windowAt(b, wx - 0.7, 0.65, front, 'pz', { shutters: C.doorBlue });
  // loading door + hoist toward the pier
  b.at(wx + 0.4, ph, back, PI, () => {
    b.box(0.9, 1.1, 0.05, 0, 0, 0.01, C.timberDark, { snow: false });
    b.box(0.8, 1.02, 0.06, 0, 0, 0.02, C.plank, { snow: false });
    b.box(0.08, 0.08, 0.6, 0, 2.05, 0.25, C.timberDark);
    b.cyl(0.012, 0.7, 0, 1.35, 0.5, C.rope, { seg: 3 });
  });
  flagPole(b, wx - len / 2 + 0.25, 0, front + 0.35, 2.9, C.clothBlue, 0, C.gold);
  // pier (toward -Z)
  const px = 1.5;
  const pw = 1.35;
  const z0 = 1.0;
  const z1 = -2.92;
  const deckY = 0.16;
  const planks = Math.round((z0 - z1) / 0.18);
  for (let i = 0; i < planks; i++) {
    const z = z0 - (i + 0.5) * ((z0 - z1) / planks);
    b.boxc(pw + b.range(-0.03, 0.03), 0.05, (z0 - z1) / planks - 0.02, px, deckY - 0.025, z, i % 4 === 0 ? C.plankGrey : C.plank, { jitter: 0.05 });
  }
  for (const sx of [-1, 1]) {
    b.box(0.06, 0.09, z0 - z1, px + sx * (pw / 2 - 0.06), deckY - 0.14, (z0 + z1) / 2, C.timberDark, { snow: false });
    for (let z = z1 + 0.08; z <= z0; z += 0.8) b.cyl(0.07, 2.7, px + sx * (pw / 2 - 0.02), -2.5, z, C.timberDark, { seg: 6 });
  }
  // bollards on the left edge (boat side)
  for (const z of [-2.6, -1.2]) b.cyl(0.07, 0.28, px - pw / 2 + 0.1, deckY, z, C.timberDark, { seg: 7 });
  // cargo crane at the pier end
  b.at(px + 0.45, deckY, -2.55, 0, () => {
    b.cyl(0.08, 2.0, 0, 0, 0, C.timberDark, { seg: 6 });
    b.beam(0, 1.85, 0, -1.2, 2.05, 0.3, 0.07, C.timber);
    b.beam(0, 0.9, 0, -0.55, 1.95, 0.14, 0.05, C.timber);
    b.cyl(0.012, 0.95, -1.15, 1.08, 0.3, C.rope, { seg: 3 });
    b.box(0.22, 0.2, 0.22, -1.15, 0.9, 0.3, C.plank);
  });
  // cargo on the pier
  crate(b, px + 0.35, deckY, 0.55, 0.26, C.plank, 0.2);
  barrel(b, px + 0.45, deckY, -0.1, 0.12, 0.3);
  sack(b, px + 0.4, deckY, 0.15, 0xb49c72, 0.9);
  // goods display slots on the pier (left half, near the boat)
  const slots: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) slots.push(b.point(px - 0.3 + j * 0.3, deckY, 0.55 - i * 0.45));
  }
  return {
    chimneys: [],
    body: bodyC(wx, wz, len, depth, wallTop),
    slots,
    boat: { x: px - pw / 2 - 0.72, z: -2.35, ry: 0 },
  };
};

export const townHall: ModelFn = (b, { variant }) => {
  const ph = 0.18;
  const mz = -0.9;
  const mlen = 4.2;
  const mdep = 3.3;
  const g1 = 1.3;
  const up0 = 1.38;
  const up1 = 2.5;
  const stone = variant === 1 ? C.stoneWarm : C.stone;
  const roofC = variant === 2 ? C.shingle : C.slate;
  plinth(b, mlen + 0.14, mdep + 0.14, ph, 0, mz, C.stoneDark);
  b.box(mlen, g1 - ph, mdep, 0, ph, mz, stone);
  quoins(b, 0, mz, mlen, mdep, ph, g1, C.stoneLight);
  b.box(mlen + 0.16, 0.08, mdep + 0.16, 0, g1, mz, C.timberDark);
  b.box(mlen + 0.1, up1 - up0, mdep + 0.1, 0, up0, mz, C.plaster);
  const f = mz + (mdep + 0.1) / 2;
  const bk = mz - (mdep + 0.1) / 2;
  timberFace(b, 0, f, 'pz', mlen + 0.1, up0, up1, C.timberDark, 6);
  timberFace(b, 0, bk, 'nz', mlen + 0.1, up0, up1, C.timberDark, 6);
  timberFace(b, (mlen + 0.1) / 2, mz, 'px', mdep + 0.1, up0, up1, C.timberDark, 4);
  timberFace(b, -(mlen + 0.1) / 2, mz, 'nx', mdep + 0.1, up0, up1, C.timberDark, 4);
  // hip roof
  b.hip(mlen + 0.5, mdep + 0.5, 1.35, 0, up1, mz, roofC);
  b.box(mlen + 0.5, 0.08, mdep + 0.5, 0, up1 - 0.06, mz, C.timberDark);
  const c1 = chimney(b, -1.4, mz - 0.6, up1 - 0.3, up1 + 1.4, 0.3, C.stoneDark);
  const c2 = chimney(b, 1.4, mz - 0.6, up1 - 0.3, up1 + 1.4, 0.3, C.stoneDark);
  // windows
  for (const x of [-1.6, -1.05, 1.05, 1.6]) {
    windowAt(b, x, 0.55, mz + mdep / 2, 'pz', { w: 0.3, h: 0.44, shutters: C.doorRed });
    windowAt(b, x, 1.72, f, 'pz', { w: 0.3, h: 0.4 });
  }
  for (const x of [-1.5, -0.5, 0.5, 1.5]) {
    windowAt(b, x, 0.55, mz - mdep / 2, 'nz', { w: 0.3, h: 0.44 });
    windowAt(b, x, 1.72, bk, 'nz', { w: 0.3, h: 0.4 });
  }
  for (const z of [-0.8, 0.5]) {
    windowAt(b, mlen / 2, 0.55, mz + z, 'px', { w: 0.3, h: 0.44 });
    windowAt(b, -mlen / 2, 0.55, mz + z, 'nx', { w: 0.3, h: 0.44 });
    windowAt(b, (mlen + 0.1) / 2, 1.72, mz + z, 'px', { w: 0.3, h: 0.4 });
    windowAt(b, -(mlen + 0.1) / 2, 1.72, mz + z, 'nx', { w: 0.3, h: 0.4 });
  }
  // clock tower at the front centre
  const tz = mz + mdep / 2 + 0.25;
  const ts = 1.25;
  const tTop = 3.85;
  plinth(b, ts + 0.1, ts + 0.1, ph, 0, tz, C.stoneDark);
  b.box(ts, 2.6 - ph, ts, 0, ph, tz, stone);
  quoins(b, 0, tz, ts, ts, ph, 2.6, C.stoneLight);
  b.box(ts + 0.1, 0.1, ts + 0.1, 0, 2.6, tz, C.timberDark);
  b.box(ts - 0.05, tTop - 2.7, ts - 0.05, 0, 2.7, tz, C.plaster);
  for (const face of ['pz', 'px', 'nx'] as const) {
    const ry = face === 'pz' ? 0 : face === 'px' ? PI / 2 : -PI / 2;
    b.at(0, 0, tz, ry, () => {
      const zf = (ts - 0.05) / 2;
      b.cyl(0.36, 0.04, 0, 3.25, zf, C.timberDark, { rx: PI / 2, seg: 12, snow: false });
      b.cyl(0.31, 0.05, 0, 3.25, zf, C.white, { rx: PI / 2, seg: 12, snow: false, glow: 0.6 });
      b.box(0.035, 0.22, 0.03, 0, 3.25, zf + 0.05, C.black, { snow: false, jitter: 0 });
      b.box(0.16, 0.035, 0.03, 0.07, 3.25, zf + 0.05, C.black, { snow: false, jitter: 0, rz: 0.5 });
    });
  }
  b.box(ts + 0.2, 0.08, ts + 0.2, 0, tTop, tz, C.timberDark);
  b.pyramid(ts / 2 + 0.12, ts / 2 + 0.12, 1.05, 0, tTop + 0.08, tz, roofC);
  b.cyl(0.02, 0.5, 0, tTop + 1.1, tz, C.ironDark, { seg: 4 });
  b.box(0.3, 0.02, 0.03, 0.12, tTop + 1.45, tz, C.gold);
  // grand entrance
  const tfront = tz + ts / 2;
  doorAt(b, 0, ph + 0.12, tfront, 'pz', { w: 0.62, h: 0.9, arch: true, color: C.door, frame: C.stoneLight, step: null });
  for (let i = 0; i < 3; i++) b.box(1.2 - i * 0.2, 0.1, 0.3, 0, i * 0.1, tfront + 0.35 - i * 0.12, C.stoneLight, { jitter: 0.03 });
  // banners either side of the tower
  for (const s of [-1, 1]) {
    b.box(0.3, 0.7, 0.03, s * 0.95, 1.45, mz + (mdep + 0.1) / 2 + 0.02, C.clothRed, { snow: false });
    b.box(0.12, 0.12, 0.04, s * 0.95, 1.85, mz + (mdep + 0.1) / 2 + 0.03, C.gold, { snow: false });
  }
  bush(b, -1.8, 0, 1.35, 0.22);
  bush(b, 1.8, 0, 1.35, 0.22);
  return {
    chimneys: [c1, c2],
    body: body(-mlen / 2, mlen / 2, mz - mdep / 2, tfront, up1),
    fires: [b.point(-1.1, up1, mz), b.point(1.1, up1, mz), b.point(0, tTop, tz)],
  };
};
