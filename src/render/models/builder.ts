/**
 * ModelBuilder — accumulates low-poly primitive parts (boxes, cylinders, prisms, hip roofs, blobs…) into ONE
 * non-indexed, flat-shaded BufferGeometry with per-vertex colours and an `fx` attribute:
 *   fx.x = window glow weight (lit at night), fx.y = snow allowed (upward faces turn white with weather.snow),
 *   fx.z = ember glow weight (forges, hearths).
 * One geometry per building → one draw call per building with the shared building material.
 */
import * as THREE from 'three';

export interface PartOpts {
  /** Rotations (radians). Applied as Ry * Rx * Rz around the part anchor. */
  rx?: number;
  ry?: number;
  rz?: number;
  /** Night window glow weight 0..1. */
  glow?: number;
  /** Ember glow weight 0..1 (forge coals etc.). */
  ember?: number;
  /** Allow snow on upward faces (default true). */
  snow?: boolean;
  /** Colour brightness jitter amplitude override (default builder.jitterAmp). */
  jitter?: number;
  /** Cylinder/cone segments. */
  seg?: number;
  /** Cylinder start angle offset (radians). */
  a0?: number;
  /** Omit the bottom face of boxes/cylinders (never visible on the ground). */
  noBottom?: boolean;
}

const colorCache = new Map<number, THREE.Color>();

/** Linear-space colour for an sRGB hex (cached). */
export function linearColor(hex: number): THREE.Color {
  let c = colorCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colorCache.set(hex, c);
  }
  return c;
}

// Unit cube [-0.5, 0.5]^3, outward CCW triangles.
const CUBE_V = [
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
  -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
];
const CUBE_I = [
  4, 5, 6, 4, 6, 7, // +Z
  1, 0, 3, 1, 3, 2, // -Z
  5, 1, 2, 5, 2, 6, // +X
  0, 4, 7, 0, 7, 3, // -X
  7, 6, 2, 7, 2, 3, // +Y
  0, 1, 5, 0, 5, 4, // -Y
];
const CUBE_I_NOBOTTOM = CUBE_I.slice(0, 30);

let icoCache: Float32Array | null = null;
function icoPositions(): Float32Array {
  if (!icoCache) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const ng = g.index ? g.toNonIndexed() : g;
    icoCache = new Float32Array(ng.getAttribute('position').array as ArrayLike<number>);
    g.dispose();
    if (ng !== g) ng.dispose();
  }
  return icoCache;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

export class ModelBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private fx: number[] = [];
  private frames: THREE.Matrix4[] = [];
  private frame = new THREE.Matrix4();
  private rngState: number;
  jitterAmp = 0.035;
  /** Max y reached by any vertex (model height). */
  maxY = 0;

  constructor(seed: number) {
    this.rngState = (seed >>> 0) ^ 0x9e3779b9;
  }

  /** Deterministic random in [0, 1). */
  rand(): number {
    let t = (this.rngState = (this.rngState + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.rand();
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.rand() * arr.length) % arr.length];
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  // ---- frames (sub-assembly placement) -----------------------------------------------------

  /** Run `fn` with the local frame translated by (x, y, z) and rotated by `ry` around Y. */
  at(x: number, y: number, z: number, ry: number, fn: () => void): void {
    this.frames.push(this.frame.clone());
    _m.makeRotationY(ry);
    _m.setPosition(x, y, z);
    this.frame.multiply(_m);
    try {
      fn();
    } finally {
      this.frame.copy(this.frames.pop()!);
    }
  }

  /** A local point transformed by the current frame (model space). */
  point(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.frame);
  }

  // ---- primitives ---------------------------------------------------------------------------

  /** Box anchored at its BOTTOM centre (x, y, z). Rotations pivot around that anchor. */
  box(sx: number, sy: number, sz: number, x: number, y: number, z: number, color: number, o?: PartOpts): void {
    this.partMatrix(x, y, z, o);
    _m2.makeTranslation(0, sy / 2, 0);
    _m.multiply(_m2);
    _m2.makeScale(sx, sy, sz);
    _m.multiply(_m2);
    this.emit(CUBE_V, o?.noBottom ? CUBE_I_NOBOTTOM : CUBE_I, _m, color, o);
  }

  /** Box anchored at its CENTRE. */
  boxc(sx: number, sy: number, sz: number, x: number, y: number, z: number, color: number, o?: PartOpts): void {
    this.partMatrix(x, y, z, o);
    _m2.makeScale(sx, sy, sz);
    _m.multiply(_m2);
    this.emit(CUBE_V, o?.noBottom ? CUBE_I_NOBOTTOM : CUBE_I, _m, color, o);
  }

  /** Box between two points (a beam/pole/rail) with square cross-section `t` (or t × t2). */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, color: number, o?: PartOpts & { t2?: number }): void {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    _a.set(dx / len, dy / len, dz / len);
    _q.setFromUnitVectors(_b.set(0, 1, 0), _a);
    _p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    _s.set(t, len, o?.t2 ?? t);
    _m.compose(_p, _q, _s);
    _m.premultiply(this.frame);
    this.emit(CUBE_V, CUBE_I, _m, color, o);
  }

  /** Cylinder (or frustum with rTop) along +Y, bottom centre at (x, y, z). */
  cyl(r: number, h: number, x: number, y: number, z: number, color: number, o?: PartOpts & { rTop?: number }): void {
    const seg = Math.max(3, o?.seg ?? 8);
    const rTop = (o?.rTop ?? r) / r;
    const a0 = o?.a0 ?? 0;
    const v: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = a0 + (i / seg) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      v.push(cx, 0, cz); // bottom ring: 2*i
      v.push(cx * rTop, 1, cz * rTop); // top ring: 2*i+1
    }
    const cb = v.length / 3;
    v.push(0, 0, 0);
    const ct = cb + 1;
    v.push(0, 1, 0);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const b0 = 2 * i;
      const t0 = 2 * i + 1;
      const b1 = 2 * j;
      const t1 = 2 * j + 1;
      if (rTop > 0.001) {
        idx.push(b0, t0, b1, b1, t0, t1);
        idx.push(ct, t1, t0);
      } else {
        idx.push(b0, ct, b1);
      }
      if (!o?.noBottom) idx.push(cb, b0, b1);
    }
    this.partMatrix(x, y, z, o);
    _m2.makeScale(r, h, r);
    _m.multiply(_m2);
    this.emit(v, idx, _m, color, o);
  }

  /** Cone / pyramid along +Y. For a square pyramid aligned to axes use seg 4 and a0 = PI/4 (r = half-diagonal). */
  cone(r: number, h: number, x: number, y: number, z: number, color: number, o?: PartOpts): void {
    this.cyl(r, h, x, y, z, color, { ...o, rTop: 0 });
  }

  /** Square pyramid with base half-extents (hx, hz) and height h, bottom at y. */
  pyramid(hx: number, hz: number, h: number, x: number, y: number, z: number, color: number, o?: PartOpts): void {
    this.convex(
      [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz], [0, h, 0]],
      [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
      x, y, z, color, o,
    );
  }

  /** Irregular blob (icosahedron) centred at (x, y, z) with radii (rx, ry, rz). */
  blob(rx: number, ry: number, rz: number, x: number, y: number, z: number, color: number, o?: PartOpts): void {
    const v = icoPositions();
    this.partMatrix(x, y, z, o);
    _m2.makeScale(rx, ry, rz);
    _m.multiply(_m2);
    this.emit(v, null, _m, color, o);
  }

  /**
   * Prism: convex cross-section `profile` given as [z, y] points (any winding), extruded along X by `length`,
   * centred at x. Profile coordinates are offsets from (y, z).
   */
  prism(profile: ReadonlyArray<readonly [number, number]>, length: number, x: number, y: number, z: number, color: number, o?: PartOpts): void {
    const n = profile.length;
    const verts: number[][] = [];
    for (const [pz, py] of profile) verts.push([-length / 2, py, pz]);
    for (const [pz, py] of profile) verts.push([length / 2, py, pz]);
    const faces: number[][] = [];
    faces.push(profile.map((_, i) => i));
    faces.push(profile.map((_, i) => n + i));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push([i, j, n + j, n + i]);
    }
    this.convex(verts, faces, x, y, z, color, o);
  }

  /**
   * Hip roof solid: base rectangle sx × sz at y, ridge height h. Equal slopes on all sides
   * (ridge length |sx - sz|); `ridgeInset` > 0 shortens the ridge further (steeper ends).
   */
  hip(sx: number, sz: number, h: number, x: number, y: number, z: number, color: number, o?: PartOpts & { ridgeInset?: number }): void {
    const hx = sx / 2;
    const hz = sz / 2;
    const inset = o?.ridgeInset ?? 0;
    let r0: number[];
    let r1: number[];
    if (sx >= sz) {
      const rl = Math.max(0, hx - hz - inset);
      r0 = [-rl, h, 0];
      r1 = [rl, h, 0];
    } else {
      const rl = Math.max(0, hz - hx - inset);
      r0 = [0, h, -rl];
      r1 = [0, h, rl];
    }
    const verts = [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz], r0, r1];
    const faces = sx >= sz
      ? [[0, 1, 2, 3], [3, 2, 5, 4], [1, 0, 4, 5], [0, 3, 4], [2, 1, 5]]
      : [[0, 1, 2, 3], [0, 3, 5, 4], [2, 1, 4, 5], [1, 0, 4], [3, 2, 5]];
    this.convex(verts, faces, x, y, z, color, o);
  }

  /**
   * Generic convex solid: vertices + polygon faces (fan-triangulated). Each triangle is oriented so its normal
   * points away from the solid's centroid, so face winding does not matter.
   */
  convex(verts: number[][], faces: number[][], x: number, y: number, z: number, color: number, o?: PartOpts): void {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const v of verts) {
      cx += v[0];
      cy += v[1];
      cz += v[2];
    }
    cx /= verts.length;
    cy /= verts.length;
    cz /= verts.length;
    const flat: number[] = [];
    const idx: number[] = [];
    for (const v of verts) flat.push(v[0], v[1], v[2]);
    for (const f of faces) {
      for (let i = 1; i < f.length - 1; i++) {
        let ia = f[0];
        let ib = f[i];
        let ic = f[i + 1];
        _a.fromArray(flat, ia * 3);
        _b.fromArray(flat, ib * 3);
        _c.fromArray(flat, ic * 3);
        _t1.subVectors(_b, _a);
        _t2.subVectors(_c, _a);
        _n.crossVectors(_t1, _t2);
        if (_n.lengthSq() < 1e-12) continue;
        _t1.set((_a.x + _b.x + _c.x) / 3 - cx, (_a.y + _b.y + _c.y) / 3 - cy, (_a.z + _b.z + _c.z) / 3 - cz);
        if (_n.dot(_t1) < 0) {
          const t = ib;
          ib = ic;
          ic = t;
        }
        idx.push(ia, ib, ic);
      }
    }
    this.partMatrix(x, y, z, o);
    this.emit(flat, idx, _m, color, o);
  }

  /** Single (optionally double-sided) flat polygon from explicit points (fan). */
  poly(points: ReadonlyArray<readonly [number, number, number]>, color: number, o?: PartOpts & { double?: boolean }): void {
    const flat: number[] = [];
    for (const p of points) flat.push(p[0], p[1], p[2]);
    const idx: number[] = [];
    for (let i = 1; i < points.length - 1; i++) {
      idx.push(0, i, i + 1);
      if (o?.double) idx.push(0, i + 1, i);
    }
    this.partMatrix(0, 0, 0, o);
    this.emit(flat, idx, _m, color, o);
  }

  // ---- output --------------------------------------------------------------------------------

  /** Build the merged geometry (non-indexed, flat normals, colour + fx attributes). */
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(this.pos);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(computeFlatNormals(pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('fx', new THREE.BufferAttribute(new Float32Array(this.fx), 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  // ---- internals -----------------------------------------------------------------------------

  private partMatrix(x: number, y: number, z: number, o?: PartOpts): void {
    _e.set(o?.rx ?? 0, o?.ry ?? 0, o?.rz ?? 0, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    _m.premultiply(this.frame);
  }

  private emit(verts: ArrayLike<number>, idx: ArrayLike<number> | null, m: THREE.Matrix4, color: number, o?: PartOpts): void {
    const base = linearColor(color);
    const amp = o?.jitter ?? this.jitterAmp;
    const k = 1 + (this.rand() - 0.5) * 2 * amp;
    const r = Math.min(1, base.r * k);
    const gc = Math.min(1, base.g * k);
    const b = Math.min(1, base.b * k);
    const glow = o?.glow ?? 0;
    const snow = o?.snow === false ? 0 : 1;
    const ember = o?.ember ?? 0;
    const flip = m.determinant() < 0;
    const count = idx ? idx.length : verts.length / 3;
    for (let t = 0; t < count; t += 3) {
      for (let k2 = 0; k2 < 3; k2++) {
        const kk = flip ? 2 - k2 : k2;
        const vi = idx ? idx[t + kk] : t + kk;
        _a.set(verts[vi * 3], verts[vi * 3 + 1], verts[vi * 3 + 2]).applyMatrix4(m);
        this.pos.push(_a.x, _a.y, _a.z);
        if (_a.y > this.maxY) this.maxY = _a.y;
        this.col.push(r, gc, b);
        this.fx.push(glow, snow, ember);
      }
    }
  }
}

/** Per-triangle normals for a non-indexed position array. */
export function computeFlatNormals(pos: Float32Array): Float32Array {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i];
    const ay = pos[i + 1];
    const az = pos[i + 2];
    const e1x = pos[i + 3] - ax;
    const e1y = pos[i + 4] - ay;
    const e1z = pos[i + 5] - az;
    const e2x = pos[i + 6] - ax;
    const e2y = pos[i + 7] - ay;
    const e2z = pos[i + 8] - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let k = 0; k < 3; k++) {
      n[i + k * 3] = nx;
      n[i + k * 3 + 1] = ny;
      n[i + k * 3 + 2] = nz;
    }
  }
  return n;
}
