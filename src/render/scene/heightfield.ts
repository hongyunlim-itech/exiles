/**
 * Heightfield ray-marching & ray/box helpers for picking. Pure math — no three.js, no DOM. OWNER: render-scene.
 */

export type HeightSampler = (wx: number, wz: number) => number;

export interface RayHit {
  /** Ray parameter of the hit (distance along the unit direction). */
  t: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Intersect a ray with an axis-aligned box. Returns the entry distance (>= 0) or -1 when missed.
 * `dir` does not need to be normalized (t is in units of dir length).
 */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): number {
  let tmin = 0;
  let tmax = Infinity;
  // X slab
  if (Math.abs(dx) < 1e-12) {
    if (ox < minX || ox > maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Y slab
  if (Math.abs(dy) < 1e-12) {
    if (oy < minY || oy > maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv;
    let t2 = (maxY - oy) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Z slab
  if (Math.abs(dz) < 1e-12) {
    if (oz < minZ || oz > maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/**
 * March a ray against a heightfield surface y = h(x, z) over the rectangle [0, W] x [0, H].
 * `dir` must be normalized. Uses an adaptive step (proportional to the height above the surface) followed by a
 * bisection refinement, so thin ridges are not skipped at typical camera angles.
 * Returns null when the ray leaves the map without hitting the surface.
 */
export function raymarchHeightfield(
  h: HeightSampler, W: number, H: number, minY: number, maxY: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  out: RayHit = { t: 0, x: 0, y: 0, z: 0 },
): RayHit | null {
  const eps = 1e-4;
  const tEnter = rayBox(ox, oy, oz, dx, dy, dz, 0, minY - 1, 0, W, maxY + 0.5, H);
  if (tEnter < 0) return null;
  // exit distance of the same box
  let tExit = Infinity;
  const slab = (o: number, d: number, lo: number, hi: number): void => {
    if (Math.abs(d) < 1e-12) return;
    const t1 = (lo - o) / d;
    const t2 = (hi - o) / d;
    const tf = t1 > t2 ? t1 : t2;
    if (tf < tExit) tExit = tf;
  };
  slab(ox, dx, 0, W);
  slab(oy, dy, minY - 1, maxY + 0.5);
  slab(oz, dz, 0, H);
  if (!Number.isFinite(tExit)) return null;

  let t = tEnter;
  let px = ox + dx * t;
  let pz = oz + dz * t;
  let prevT = t;
  let prevDiff = oy + dy * t - h(px, pz);
  if (prevDiff <= 0) {
    // started below the surface (camera inside a hill?) — report the entry point.
    out.t = t;
    out.x = px;
    out.z = pz;
    out.y = h(px, pz);
    return out;
  }
  // slope-aware minimum step
  const horiz = Math.hypot(dx, dz);
  const minStep = 0.08;
  const maxStep = 2.0;
  let guard = 0;
  while (t < tExit && guard++ < 20000) {
    const step = Math.min(maxStep, Math.max(minStep, prevDiff * 0.45 / Math.max(0.2, horiz + Math.abs(dy))));
    t = Math.min(tExit, t + step);
    px = ox + dx * t;
    pz = oz + dz * t;
    const diff = oy + dy * t - h(px, pz);
    if (diff <= 0) {
      // bisection between prevT (above) and t (below)
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 18 && hi - lo > eps; i++) {
        const mid = (lo + hi) * 0.5;
        const mx = ox + dx * mid;
        const mz = oz + dz * mid;
        if (oy + dy * mid - h(mx, mz) > 0) lo = mid;
        else hi = mid;
      }
      out.t = hi;
      out.x = ox + dx * hi;
      out.z = oz + dz * hi;
      out.y = oy + dy * hi;
      return out;
    }
    prevT = t;
    prevDiff = diff;
    if (t >= tExit) break;
  }
  return null;
}
