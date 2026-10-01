/** Housing models: wooden house (log cabin), stone house, boarding house. */
import type { ModelBuilder } from '../builder';
import { C } from '../palette';
import {
  barrel, bench, bush, crate, doorAt, gableHouse, gableRoof, logLines, plinth, roofYAt, timberFace, windowAt, woodStack, chimney,
} from '../parts';
import { bodyC, type ModelFn } from '../spec';

const PI = Math.PI;

/** Alternating corner quoin blocks on a rectangular stone body. */
export function quoins(b: ModelBuilder, cx: number, cz: number, sx: number, sz: number, y0: number, y1: number, color: number = C.stoneLight): void {
  const step = 0.2;
  let i = 0;
  const top = y1 - 0.03;
  for (let y = y0; y < top - 0.05; y += step, i++) {
    const hgt = Math.min(step - 0.02, top - y);
    const long = i % 2 === 0;
    for (const ex of [-1, 1]) {
      for (const ez of [-1, 1]) {
        const lx = long ? 0.26 : 0.14;
        const lz = long ? 0.14 : 0.26;
        b.box(lx, hgt, lz, cx + ex * (sx / 2 - lx / 2 + 0.015), y, cz + ez * (sz / 2 - lz / 2 + 0.015), color, { jitter: 0.05, snow: false });
      }
    }
  }
}

function flowerBox(b: ModelBuilder, x: number, y: number, z: number, face: 'pz' | 'px' | 'nx'): void {
  const ry = face === 'pz' ? 0 : face === 'px' ? PI / 2 : -PI / 2;
  b.at(x, y, z, ry, () => {
    b.box(0.36, 0.08, 0.1, 0, 0, 0.06, C.plank);
    b.blob(0.07, 0.05, 0.05, -0.1, 0.1, 0.06, C.leaf);
    b.blob(0.07, 0.05, 0.05, 0.1, 0.1, 0.06, C.leaf);
    b.blob(0.03, 0.03, 0.03, -0.06, 0.14, 0.08, b.pick([C.flowerPurple, C.red, C.flowerYellow]));
    b.blob(0.03, 0.03, 0.03, 0.1, 0.14, 0.08, b.pick([C.flowerWhite, C.red, C.flowerYellow]));
  });
}

export const woodenHouse: ModelFn = (b, { variant }) => {
  const ph = 0.12;
  const bz = -0.1;
  const len = 2.3;
  const depth = 2.0;
  const wallTop = 1.1;
  const ridge = 2.1;
  const front = bz + depth / 2;
  const back = bz - depth / 2;
  plinth(b, len + 0.14, depth + 0.14, ph, 0, bz);
  const roof = [C.thatch, C.thatchLight, C.thatchDark][variant];
  gableHouse(b, {
    z: bz, len, depth, y0: ph, wallTop, ridge, axis: 'x', wall: C.log, roof, gable: C.plank,
    corners: C.timberDark, thick: 0.16, over: 0.24, endOver: 0.18, ridgeCap: C.thatchDark,
  });
  logLines(b, 0, front, 'pz', len - 0.16, ph, wallTop);
  logLines(b, 0, back, 'nz', len - 0.16, ph, wallTop);
  logLines(b, len / 2, bz, 'px', depth - 0.16, ph, wallTop);
  logLines(b, -len / 2, bz, 'nx', depth - 0.16, ph, wallTop);

  const doorX = variant === 1 ? -0.42 : 0.38;
  doorAt(b, doorX, ph, front, 'pz', { h: 0.7 });
  windowAt(b, doorX > 0 ? -0.45 : 0.45, 0.48, front, 'pz', { shutters: variant === 2 ? C.doorGreen : null });
  windowAt(b, len / 2, 0.48, bz, 'px');
  windowAt(b, -len / 2, 0.48, bz, 'nx');
  windowAt(b, 0.3, 0.48, back, 'nz');

  const cs = variant === 2 ? -1 : 1;
  const chimX = cs * 0.68;
  const chimZ = bz - 0.45;
  const top = chimney(b, chimX, chimZ, ph, Math.max(2.3, roofYAt(wallTop, ridge, depth, 0.45) + 0.6), 0.3, C.stone);

  // clutter
  const side = -cs;
  if (variant !== 1) {
    woodStack(b, side * (len / 2 + 0.15), 0, bz + 0.1, 0.9, 0.46, 0.24, side * PI / 2, false);
  } else {
    bench(b, 0.35, 0, front + 0.28, 0, 0.62);
    crate(b, -1.0, 0, front + 0.2, 0.24, C.plank, 0.3);
  }
  barrel(b, doorX > 0 ? 0.95 : -0.95, 0, front + 0.24, 0.12, 0.3);
  if (variant === 2) {
    bush(b, 0.95, 0, back - 0.22, 0.18);
    bush(b, -0.2, 0, back - 0.2, 0.15, C.leafDark);
  }
  return { chimneys: [top], body: bodyC(0, bz, len, depth, wallTop) };
};

export const stoneHouse: ModelFn = (b, { variant }) => {
  const ph = 0.14;
  const bz = -0.12;
  const len = 2.35;
  const depth = 2.05;
  const wallTop = 1.22;
  const ridge = 2.38;
  const front = bz + depth / 2;
  const back = bz - depth / 2;
  plinth(b, len + 0.12, depth + 0.12, ph, 0, bz, C.stoneDark);
  const roof = [C.shingle, C.slate, C.tileRed][variant];
  gableHouse(b, {
    z: bz, len, depth, y0: ph, wallTop, ridge, axis: 'x', wall: C.stone, roof, gable: C.stoneWarm,
    corners: null, thick: 0.1, over: 0.2, endOver: 0.12, ridgeCap: C.shingleDark,
  });
  quoins(b, 0, bz, len, depth, ph, wallTop);
  // lintel band
  b.box(len + 0.02, 0.06, depth + 0.02, 0, wallTop - 0.08, bz, C.stoneLight, { snow: false });

  const shutters = [C.doorGreen, C.doorBlue, C.doorRed][variant];
  doorAt(b, 0, ph, front, 'pz', { arch: true, h: 0.66, color: C.door });
  windowAt(b, -0.68, 0.52, front, 'pz', { shutters });
  windowAt(b, 0.68, 0.52, front, 'pz', { shutters });
  flowerBox(b, -0.68, 0.38, front, 'pz');
  flowerBox(b, 0.68, 0.38, front, 'pz');
  windowAt(b, len / 2, 0.52, bz - 0.3, 'px', { shutters });
  windowAt(b, -len / 2, 0.52, bz - 0.3, 'nx', { shutters });
  windowAt(b, -0.5, 0.52, back, 'nz');
  windowAt(b, 0.5, 0.52, back, 'nz');

  const cs = variant === 1 ? -1 : 1;
  const top = chimney(b, cs * (len / 2 + 0.06), bz, 0, ridge + 0.38, 0.38, C.stoneDark);
  barrel(b, -cs * 0.95, 0, front + 0.25, 0.12, 0.3);
  if (variant === 0) crate(b, cs * 0.9, 0, front + 0.24, 0.22, C.plank, 0.4);
  return { chimneys: [top], body: bodyC(0, bz, len, depth, wallTop) };
};

export const boardingHouse: ModelFn = (b, { variant }) => {
  const ph = 0.14;
  const bz = -0.12;
  const sx = 3.0;
  const lenZ = 4.15;
  const g1 = 1.15;
  const up0 = 1.23;
  const up1 = 2.25;
  const ridge = 3.45;
  const frontG = bz + lenZ / 2;
  const frontU = bz + (lenZ + 0.1) / 2;
  plinth(b, sx + 0.12, lenZ + 0.12, ph, 0, bz, C.stoneDark);
  // ground floor (stone), jetty, upper floor (plaster + timber frame)
  b.box(sx, g1 - ph, lenZ, 0, ph, bz, C.stone);
  quoins(b, 0, bz, sx, lenZ, ph, g1);
  b.box(sx + 0.14, 0.08, lenZ + 0.14, 0, g1, bz, C.timberDark);
  b.box(sx + 0.1, up1 - up0, lenZ + 0.1, 0, up0, bz, variant === 1 ? C.plasterWarm : C.plaster);
  timberFace(b, 0, frontU, 'pz', sx + 0.1, up0, up1, C.timberDark, 4);
  timberFace(b, 0, bz - (lenZ + 0.1) / 2, 'nz', sx + 0.1, up0, up1, C.timberDark, 4);
  timberFace(b, (sx + 0.1) / 2, bz, 'px', lenZ + 0.1, up0, up1, C.timberDark, 5);
  timberFace(b, -(sx + 0.1) / 2, bz, 'nx', lenZ + 0.1, up0, up1, C.timberDark, 5);
  const roofC = [C.shingle, C.thatch, C.shingleGrey][variant];
  gableRoof(b, {
    z: bz, len: lenZ + 0.1, depth: sx + 0.1, wallTop: up1, ridge, axis: 'z', color: roofC,
    gable: variant === 1 ? C.plasterWarm : C.plaster, over: 0.2, endOver: 0.14, thick: variant === 1 ? 0.15 : 0.1, ridgeCap: C.shingleDark,
  });
  // front facade
  doorAt(b, 0, ph, frontG, 'pz', { w: 0.5, h: 0.78, color: C.door });
  b.boxc(1.0, 0.05, 0.45, 0, 1.02, frontG + 0.2, C.shingle, { rx: -0.35 });
  windowAt(b, -0.95, 0.5, frontG, 'pz');
  windowAt(b, 0.95, 0.5, frontG, 'pz');
  for (const x of [-0.95, 0, 0.95]) windowAt(b, x, 1.55, frontU, 'pz');
  windowAt(b, 0, 2.55, frontU - 0.02, 'pz', { w: 0.2, h: 0.22 });
  // sides
  for (const z of [-1.4, -0.1, 1.2]) {
    for (const [x, face] of [[sx / 2, 'px'], [-sx / 2, 'nx']] as const) {
      windowAt(b, x, 0.5, bz + z, face);
      windowAt(b, x + Math.sign(x) * 0.05, 1.55, bz + z, face);
    }
  }
  for (const x of [-0.8, 0.8]) windowAt(b, x, 1.55, bz - (lenZ + 0.1) / 2, 'nz');
  const c1 = chimney(b, 0.35, bz - 1.25, up1 - 0.4, ridge + 0.35, 0.32, C.stoneDark);
  const c2 = chimney(b, -0.35, bz + 1.1, up1 - 0.4, ridge + 0.35, 0.32, C.stoneDark);
  barrel(b, 1.3, 0, frontG + 0.28, 0.13, 0.32);
  barrel(b, 1.05, 0, frontG + 0.3, 0.12, 0.3);
  bench(b, -1.0, 0, frontG + 0.3, 0, 0.6);
  return { chimneys: [c1, c2], body: bodyC(0, bz, sx + 0.1, lenZ + 0.1, up1) };
};
