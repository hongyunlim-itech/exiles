/**
 * Rivers, lakes and ponds (water masks + mountain-free corridors). OWNER: sim-world agent.
 * Heights are shaped later (relief.ts) from these masks.
 */
import type { GenContext } from './context';
import { DEPTH_CAP_LAKE, DEPTH_CAP_POND, DEPTH_CAP_RIVER, WATER_LAKE, WATER_NONE, WATER_POND, WATER_RIVER } from './context';
import { clamp, lerp, smoothstep } from './noise';

interface RiverSample {
  x: number;
  z: number;
  /** Half width (tiles). */
  r: number;
}

interface MeanderOptions {
  amp: number;
  wavelength: number;
  widthMin: number;
  widthMax: number;
  /** Keep the end point fixed (tributary junction). */
  pinEnd: boolean;
  salt: number;
}

/** Build a meandering centre line from A to B, sampled every half tile. */
function meanderPath(ctx: GenContext, ax: number, az: number, bx: number, bz: number, o: MeanderOptions): RiverSample[] {
  const n = ctx.noise.river;
  const dx = bx - ax;
  const dz = bz - az;
  const L = Math.hypot(dx, dz);
  const ux = dx / L;
  const uz = dz / L;
  const nx = -uz;
  const nz = ux;
  const phase = ctx.rng.range(0, Math.PI * 2);
  const count = Math.ceil(L / 0.5);
  const out: RiverSample[] = [];
  for (let s = 0; s <= count; s++) {
    const t = s / count;
    const u = t * L;
    let env = 1;
    if (o.pinEnd) env *= 1 - smoothstep(0.8, 1, t);
    const off = o.amp * env * (0.55 * Math.sin((2 * Math.PI * u) / o.wavelength + phase) + 0.6 * n.fbm(u / 48, o.salt * 3.1, 2));
    const w01 = n.fbm01(u / 34, o.salt * 5.7 + 40, 2);
    const width = lerp(o.widthMin, o.widthMax, smoothstep(0.25, 0.75, w01));
    out.push({ x: ax + ux * u + nx * off, z: az + uz * u + nz * off, r: width / 2 });
  }
  return out;
}

/** Stamp river samples into the water mask; clears a mountain-free corridor alongside. */
function stampRiver(ctx: GenContext, samples: RiverSample[]): void {
  const { W, H, water, waterCap, noMountain } = ctx;
  const CORRIDOR = 4;
  for (const p of samples) {
    const M = p.r + CORRIDOR;
    const x0 = Math.max(0, Math.floor(p.x - M));
    const x1 = Math.min(W - 1, Math.ceil(p.x + M));
    const z0 = Math.max(0, Math.floor(p.z - M));
    const z1 = Math.min(H - 1, Math.ceil(p.z + M));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z);
        if (d > M) continue;
        const i = z * W + x;
        noMountain[i] = 1;
        if (d < p.r) {
          if (water[i] === WATER_NONE) water[i] = WATER_RIVER;
          if (waterCap[i] < DEPTH_CAP_RIVER) waterCap[i] = DEPTH_CAP_RIVER;
        }
      }
    }
  }
}

/** Map-crossing river(s) plus an optional tributary. */
export function carveRivers(ctx: GenContext): void {
  const { W, H, params, rng } = ctx;
  let count = Math.floor(params.rivers);
  if (rng.chance(params.rivers - count)) count++;
  const sizeScale = Math.sqrt(W / 160);
  const axes: ('x' | 'z')[] = [];
  for (let k = 0; k < count; k++) {
    // Alternate axes when there are several rivers so they cross rather than run in parallel.
    const axis: 'x' | 'z' = k === 0 ? (rng.chance(0.5) ? 'x' : 'z') : axes[0] === 'x' ? 'z' : 'x';
    axes.push(axis);
    const a = rng.range(0.22, 0.78);
    const b = clamp(a + rng.range(-0.38, 0.38), 0.15, 0.85);
    const flip = rng.chance(0.5);
    const EXT = 10;
    let ax: number, az: number, bx: number, bz: number;
    if (axis === 'z') {
      ax = a * W;
      az = -EXT;
      bx = b * W;
      bz = H + EXT;
    } else {
      ax = -EXT;
      az = a * H;
      bx = W + EXT;
      bz = b * H;
    }
    if (flip) {
      [ax, bx] = [bx, ax];
      [az, bz] = [bz, az];
    }
    const main = meanderPath(ctx, ax, az, bx, bz, {
      amp: rng.range(7, 13) * sizeScale,
      wavelength: rng.range(55, 85) * sizeScale,
      widthMin: params.riverWidth[0],
      widthMax: params.riverWidth[1],
      pinEnd: false,
      salt: k + 1,
    });
    stampRiver(ctx, main);

    if (k === 0 && rng.chance(params.tributaryChance)) {
      // Tributary from a perpendicular edge to a junction on the main river.
      const j = main[Math.floor(main.length * rng.range(0.3, 0.7))];
      let tx: number, tz: number;
      if (axis === 'z') {
        tx = j.x < W / 2 ? W + EXT : -EXT;
        tz = clamp(j.z + rng.range(-0.25, 0.25) * H, 0.1 * H, 0.9 * H);
      } else {
        tz = j.z < H / 2 ? H + EXT : -EXT;
        tx = clamp(j.x + rng.range(-0.25, 0.25) * W, 0.1 * W, 0.9 * W);
      }
      const trib = meanderPath(ctx, tx, tz, j.x, j.z, {
        amp: rng.range(5, 9) * sizeScale,
        wavelength: rng.range(40, 60) * sizeScale,
        widthMin: Math.max(3, params.riverWidth[0] - 0.4),
        widthMax: Math.max(3.4, params.riverWidth[1] - 1.6),
        pinEnd: true,
        salt: 17,
      });
      stampRiver(ctx, trib);
    }
  }
}

/** Stamp an irregular lake (DeepWater core for large lakes) and its mountain-free shore. */
export function stampLake(ctx: GenContext, cx: number, cz: number, R: number, kind: number): void {
  const { W, H, water, waterCap, noMountain, rng } = ctx;
  const n = ctx.noise.lake;
  const k = rng.range(0, 100);
  const cap = kind === WATER_LAKE ? DEPTH_CAP_LAKE : DEPTH_CAP_POND;
  const SHORE = 3;
  const M = R * 1.5 + SHORE + 1;
  const x0 = Math.max(0, Math.floor(cx - M));
  const x1 = Math.min(W - 1, Math.ceil(cx + M));
  const z0 = Math.max(0, Math.floor(cz - M));
  const z1 = Math.min(H - 1, Math.ceil(cz + M));
  // Elongation for more natural shapes.
  const ang = rng.range(0, Math.PI);
  const stretch = rng.range(1, 1.45);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dz = z + 0.5 - cz;
      const lx = (dx * ca + dz * sa) / stretch;
      const lz = -dx * sa + dz * ca;
      const d = Math.hypot(lx, lz) * Math.sqrt(stretch);
      const th = Math.atan2(lz, lx);
      const c = Math.cos(th);
      const s = Math.sin(th);
      const rr = R * (1 + 0.28 * n.noise(c * 1.1 + k, s * 1.1 - k) + 0.07 * n.noise(c * 2.4 - k, s * 2.4 + k));
      if (d > rr + SHORE) continue;
      const i = z * W + x;
      noMountain[i] = 1;
      if (d < rr) {
        if (water[i] === WATER_NONE || water[i] === WATER_POND) water[i] = kind;
        if (waterCap[i] < cap) waterCap[i] = cap;
      }
    }
  }
}

/** Scatter lakes (lowland preferred, spaced apart, mostly away from rivers). */
export function placeLakes(ctx: GenContext): void {
  const { W, H, N, params, rng, water, land, CW } = ctx;
  const areaScale = N / (160 * 160);
  const sizeScale = Math.sqrt(W / 160);
  const target = Math.max(0, Math.round(rng.range(params.lakeCount[0], params.lakeCount[1] + 0.999) * Math.sqrt(areaScale)));
  const placed: { x: number; z: number; r: number }[] = [];
  let attempts = 0;
  while (placed.length < target && attempts < 400) {
    attempts++;
    const R = rng.range(params.lakeRadius[0], params.lakeRadius[1]) * sizeScale;
    const margin = R * 1.5 + 10;
    if (W - 2 * margin <= 0 || H - 2 * margin <= 0) continue;
    const cx = rng.range(margin, W - margin);
    const cz = rng.range(margin, H - margin);
    let ok = true;
    for (const p of placed) {
      if (Math.hypot(p.x - cx, p.z - cz) < p.r * 1.4 + R * 1.4 + 10) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // Avoid swallowing rivers: tolerate a little overlap (lakes fed by rivers look natural).
    let riverTiles = 0;
    let total = 0;
    const rr = Math.ceil(R * 1.3);
    for (let z = Math.floor(cz) - rr; z <= Math.floor(cz) + rr; z++) {
      for (let x = Math.floor(cx) - rr; x <= Math.floor(cx) + rr; x++) {
        if (x < 0 || z < 0 || x >= W || z >= H) continue;
        total++;
        if (water[z * W + x] !== WATER_NONE) riverTiles++;
      }
    }
    if (riverTiles > total * 0.12) continue;
    // Prefer low ground.
    const h = land[Math.floor(cz) * CW + Math.floor(cx)];
    if (attempts < 300 && rng.next() < clamp((h - 0.6) / 2.2, 0, 0.8)) continue;
    stampLake(ctx, cx, cz, R, R >= 6.2 ? WATER_LAKE : WATER_POND);
    placed.push({ x: cx, z: cz, r: R });
  }
}

/**
 * Smooth the water mask with a cellular automaton: remove 1-tile spikes and fill notches, so shorelines are clean
 * and every water tile can be shaped below the water level.
 */
export function cleanupWater(ctx: GenContext, iterations = 2): void {
  const { W, H, N, water, waterCap, mountain } = ctx;
  const next = new Uint8Array(N);
  const nextCap = new Float32Array(N);
  for (let it = 0; it < iterations; it++) {
    next.set(water);
    nextCap.set(waterCap);
    let changed = false;
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        const isWater = water[i] !== WATER_NONE;
        let n4 = 0;
        let bestCap = 0;
        let bestKind = WATER_NONE;
        for (let d = 0; d < 4; d++) {
          const xx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
          const zz = z + (d === 2 ? -1 : d === 3 ? 1 : 0);
          if (xx < 0 || zz < 0 || xx >= W || zz >= H) {
            // Off-map counts as water only for tiles that are water (keeps rivers open at the edges).
            if (isWater) n4++;
            continue;
          }
          const j = zz * W + xx;
          if (water[j] !== WATER_NONE) {
            n4++;
            if (waterCap[j] > bestCap) {
              bestCap = waterCap[j];
              bestKind = water[j];
            }
          }
        }
        if (isWater) {
          if (n4 <= 1) {
            next[i] = WATER_NONE;
            nextCap[i] = 0;
            changed = true;
          }
        } else if (!mountain[i] && n4 >= 3) {
          next[i] = bestKind === WATER_NONE ? WATER_RIVER : bestKind;
          nextCap[i] = bestCap || DEPTH_CAP_RIVER;
          changed = true;
        }
      }
    }
    water.set(next);
    waterCap.set(nextCap);
    if (!changed) break;
  }
}

/** Stamp a pond (or small lake) of radius R at (cx, cz) and tidy the shoreline. Used to guarantee water near the start. */
export function addPond(ctx: GenContext, cx: number, cz: number, R: number): void {
  stampLake(ctx, cx, cz, R, R >= 6.2 ? WATER_LAKE : WATER_POND);
  cleanupWater(ctx, 2);
}
