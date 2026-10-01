/**
 * Decorative terrain ring around the playable map: continues the edge heights, lifts out of the water, then rises
 * into forested hills and rocky, snow-capped mountains that fade into the fog — so the world looks bounded instead
 * of ending in a cliff. Shares the terrain material (TERRAIN_RING variant) so seasons/snow apply. OWNER: render-scene.
 *
 * Geometry (performance pass): nested rectangular bands whose cell size doubles outward —
 *   1-unit cells within 8 of the map, then 2 (to 24), 4 (to 56), 8 (to 112), 16 (to 256), 32 (to ~544).
 * Band edges are aligned to the next band's step, and every cell touching the finer band inside it splits that
 * edge at its midpoint (a 3-triangle fan), so there are no T-junctions or cracks. Vertices are shared across bands
 * (one vertex per grid point), so smooth normals are continuous too. The ring is split into 8 sectors (N, NE, E, …)
 * sharing one vertex/index buffer (draw ranges) so frustum culling drops the parts behind the camera.
 * ~30k triangles for a 160² map instead of ~115k.
 */
import * as THREE from 'three';
import { hash2 } from '../../core/rng';
import { PAL, hexToRgb, smoothstep } from './palette';

/** Width of the finest (1-unit) band. */
export const BORDER_MARGIN = 8;
/** Band outer margins (from the map edge) and cell sizes, fine → coarse. Each margin is a multiple of the next step. */
export const BORDER_BANDS: readonly { margin: number; step: number }[] = [
  { margin: 8, step: 1 },
  { margin: 24, step: 2 },
  { margin: 56, step: 4 },
  { margin: 112, step: 8 },
  { margin: 256, step: 16 },
  { margin: 544, step: 32 },
];
/** Edge corners below this height count as river mouths. */
const WATER_ISH = 0.05;
const KEY_OFF = 2048;
const KEY_SPAN = 8192;

function vnoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  let tx = x - x0;
  let tz = z - z0;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

function fbm(x: number, z: number, seed: number): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let o = 0; o < 4; o++) {
    v += a * vnoise(x * f, z * f, seed + o * 17);
    f *= 2.03;
    a *= 0.5;
  }
  return v / 0.9375;
}

const GREEN = hexToRgb(PAL.grassLush);
const FOREST = hexToRgb(PAL.forestFloor);
const SCRUB = hexToRgb(PAL.scrub);

export interface BorderSource {
  W: number;
  H: number;
  heights: Float32Array;
  /** Corner colours / materials of the map ((W+1)*(H+1)*4 bytes) for a seamless join. */
  cornerRgb: Uint8Array;
  cornerMat: Uint8Array;
  seed: number;
  /** Typical mountain height of the map (e.g. 90th percentile of mountain corners); scales the ring's relief. */
  mountainLevel: number;
}

interface Sample {
  h: number;
  r: number;
  g: number;
  b: number;
  sand: number;
  grass: number;
  rock: number;
  snow: number;
}

/** Rectangle [x0, x1] × [z0, z1] (world units). */
interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Height grid of one band (bounding rect of the band; points inside the inner rect are unused). */
interface BandGrid {
  outer: Rect;
  inner: Rect;
  step: number;
  nx: number;
  nz: number;
  h: Float32Array;
}

function ceilTo(v: number, m: number): number {
  return Math.ceil(v / m) * m;
}

/** Band rectangles for a W×H map: band k spans outer[k] minus outer[k-1] (outer[-1] = the map). */
export function borderBandRects(W: number, H: number): { outer: Rect; inner: Rect; step: number }[] {
  const out: { outer: Rect; inner: Rect; step: number }[] = [];
  let inner: Rect = { x0: 0, z0: 0, x1: W, z1: H };
  for (let k = 0; k < BORDER_BANDS.length; k++) {
    const { margin, step } = BORDER_BANDS[k];
    const align = k + 1 < BORDER_BANDS.length ? BORDER_BANDS[k + 1].step : step;
    const outer: Rect = { x0: -margin, z0: -margin, x1: ceilTo(W + margin, align), z1: ceilTo(H + margin, align) };
    out.push({ outer, inner, step });
    inner = outer;
  }
  return out;
}

/** Sector (0..7, the 3×3 grid around the map minus its centre) of a point outside the map. */
function sectorOf(x: number, z: number, W: number, H: number): number {
  const sx = x < 0 ? 0 : x >= W ? 2 : 1;
  const sz = z < 0 ? 0 : z >= H ? 2 : 1;
  const s = sz * 3 + sx;
  return s > 4 ? s - 1 : s;
}

export class TerrainBorder {
  /** Whole-ring mesh (all sectors; kept for debugging/compatibility — not added to the scene). */
  readonly mesh: THREE.Mesh;
  /** The rendered ring: one mesh per sector sharing the ring's buffers (frustum-culled independently). */
  readonly group = new THREE.Group();
  /** Sorted heights of rocky ring vertices (for snow-line estimation when the map has few mountains). */
  rockHeights: Float32Array = new Float32Array(0);
  private readonly material: THREE.Material;
  private sectors: THREE.Mesh[] = [];
  private bands: BandGrid[] = [];
  private mapW = 0;
  private mapH = 0;

  constructor(material: THREE.Material) {
    this.material = material;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = 'terrain-border';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.group.name = 'terrain-border';
  }

  build(src: BorderSource): void {
    const { W, H, heights, cornerRgb, cornerMat, seed } = src;
    const W1 = W + 1;
    const L = Math.max(5, Math.min(30, src.mountainLevel || 8));
    const corner = (x: number, z: number): number => heights[z * W1 + x];
    const out: Sample = { h: 0, r: 0, g: 0, b: 0, sand: 0, grass: 0, rock: 0, snow: 0 };
    const rock: number[] = [];

    // distance (along each map edge) to the nearest underwater edge corner: rivers leaving the map continue
    // into a valley outside instead of running into a wall
    const WET_CAP = 24;
    const wetDist = (get: (k: number) => number, n: number): Float32Array => {
      const o = new Float32Array(n + 1).fill(WET_CAP);
      let last = -1e9;
      for (let k = 0; k <= n; k++) {
        if (get(k) < WATER_ISH) last = k;
        o[k] = Math.min(WET_CAP, k - last);
      }
      last = 1e9;
      for (let k = n; k >= 0; k--) {
        if (get(k) < WATER_ISH) last = k;
        o[k] = Math.min(o[k], last - k);
      }
      return o;
    };
    const wetTop = wetDist((x) => corner(x, 0), W);
    const wetBottom = wetDist((x) => corner(x, H), W);
    const wetLeft = wetDist((z) => corner(0, z), H);
    const wetRight = wetDist((z) => corner(W, z), H);
    const edgeWet = (px: number, pz: number, qx: number, qz: number): number => {
      let w = WET_CAP;
      if (pz < 0) w = Math.min(w, wetTop[qx]);
      if (pz > H) w = Math.min(w, wetBottom[qx]);
      if (px < 0) w = Math.min(w, wetLeft[qz]);
      if (px > W) w = Math.min(w, wetRight[qz]);
      return w;
    };

    /** Height, colour & material of the ring at world point (px, pz) outside the map. */
    const sample = (px: number, pz: number): Sample => {
      const qx = Math.max(0, Math.min(W, Math.round(px)));
      const qz = Math.max(0, Math.min(H, Math.round(pz)));
      const base = corner(qx, qz);
      const d = Math.hypot(px - Math.max(0, Math.min(W, px)), pz - Math.max(0, Math.min(H, pz)));
      // river valleys: 1 in line with a river mouth, fading out a few tiles to either side
      const valley = smoothstep(9, 2, edgeWet(px, pz, qx, qz) - d * 0.12);
      // continue the edge, lift out of any water (slowly along a river valley)
      let h = base + (Math.max(base, 0.45) - base) * smoothstep(0, 2.5 + 12 * valley, d);
      // beyond the map's own edge walls the land settles into a forested valley floor with rolling hills...
      const m = fbm(px * 0.03, pz * 0.03, seed + 71);
      const ridge = 1 - Math.abs(2 * fbm(px * 0.05 + 11, pz * 0.05 - 7, seed + 131) - 1);
      const floor = L * (0.18 + 0.22 * m) + L * 0.45 * ridge * m;
      h += (floor - h) * smoothstep(1 + 14 * valley, 14 + 40 * valley, d);
      // ...then distant ranges rise towards the horizon (hazy in the fog)
      const far = smoothstep(40, 240, d);
      const peaks = fbm(px * 0.011 + 3, pz * 0.011 - 5, seed + 211);
      h += far * L * (0.2 + 1.15 * peaks * peaks);
      h += (vnoise(px * 0.35, pz * 0.35, seed + 9) - 0.5) * 0.7 * smoothstep(1, 6, d);
      out.h = h;

      // materials: forested hills, rock on high ground; the seam blends from the map's own edge colours
      const ci = (qz * W1 + qx) * 4;
      const seam = smoothstep(0, 4, d);
      const rockAmt = Math.min(1, smoothstep(L * 0.75, L * 1.25, h) * (0.8 + 0.4 * vnoise(px * 0.2, pz * 0.2, seed + 3)));
      const fk = Math.min(1, 0.75 + 0.35 * vnoise(px * 0.12, pz * 0.12, seed + 5) + smoothstep(2, 10, d) * 0.3);
      const gr = GREEN[0] + (FOREST[0] - GREEN[0]) * fk;
      const gg = GREEN[1] + (FOREST[1] - GREEN[1]) * fk;
      const gb = GREEN[2] + (FOREST[2] - GREEN[2]) * fk;
      const r = (gr + (SCRUB[0] - gr) * rockAmt * 0.7) * 255;
      const g = (gg + (SCRUB[1] - gg) * rockAmt * 0.7) * 255;
      const b = (gb + (SCRUB[2] - gb) * rockAmt * 0.7) * 255;
      out.r = cornerRgb[ci] + (r - cornerRgb[ci]) * seam;
      out.g = cornerRgb[ci + 1] + (g - cornerRgb[ci + 1]) * seam;
      out.b = cornerRgb[ci + 2] + (b - cornerRgb[ci + 2]) * seam;
      out.sand = cornerMat[ci + 3] * (1 - seam);
      out.grass = cornerMat[ci] + ((1 - rockAmt) * 255 - cornerMat[ci]) * seam;
      out.snow = cornerMat[ci + 1] + (255 - cornerMat[ci + 1]) * seam;
      out.rock = cornerMat[ci + 2] + (rockAmt * 255 - cornerMat[ci + 2]) * seam;
      if (rockAmt > 0.5 && d < 60) rock.push(h);
      return out;
    };

    const pos: number[] = [];
    const col: number[] = [];
    const mat: number[] = [];
    const hgt: number[] = [];
    const vid = new Map<number, number>();
    /** Shared vertex at integer grid point (px, pz). Map-boundary points use the exact corner heights. */
    const vertex = (px: number, pz: number): number => {
      const key = (px + KEY_OFF) * KEY_SPAN + (pz + KEY_OFF);
      const got = vid.get(key);
      if (got !== undefined) return got;
      const s = sample(px, pz);
      if (px >= 0 && px <= W && pz >= 0 && pz <= H) s.h = corner(px, pz);
      const v = pos.length / 3;
      vid.set(key, v);
      pos.push(px, s.h, pz);
      hgt.push(s.h);
      col.push(Math.round(s.r), Math.round(s.g), Math.round(s.b), Math.round(s.sand));
      mat.push(Math.round(s.grass), Math.round(s.snow), Math.round(s.rock), 0);
      return v;
    };

    const sectorIdx: number[][] = Array.from({ length: 8 }, () => []);
    const bands: BandGrid[] = [];
    for (const band of borderBandRects(W, H)) {
      const { outer, inner, step } = band;
      const nx = Math.round((outer.x1 - outer.x0) / step) + 1;
      const nz = Math.round((outer.z1 - outer.z0) / step) + 1;
      const grid = new Float32Array(nx * nz);
      const half = step / 2;
      const fine = step > 1; // cells touching the inner rect split that edge (the inner band has half the step)
      for (let iz = 0; iz < nz - 1; iz++) {
        for (let ix = 0; ix < nx - 1; ix++) {
          const cx = outer.x0 + ix * step;
          const cz = outer.z0 + iz * step;
          if (cx >= inner.x0 && cx + step <= inner.x1 && cz >= inner.z0 && cz + step <= inner.z1) continue;
          const p00 = vertex(cx, cz);
          const p10 = vertex(cx + step, cz);
          const p01 = vertex(cx, cz + step);
          const p11 = vertex(cx + step, cz + step);
          grid[iz * nx + ix] = hgt[p00];
          grid[iz * nx + ix + 1] = hgt[p10];
          grid[(iz + 1) * nx + ix] = hgt[p01];
          grid[(iz + 1) * nx + ix + 1] = hgt[p11];
          const idx = sectorIdx[sectorOf(cx + half, cz + half, W, H)];
          // which edge (if any) lies on the inner rect's boundary? (positive-orientation polygon p00,p01,p11,p10)
          let split = -1;
          if (fine) {
            const zIn = cz >= inner.z0 && cz + step <= inner.z1;
            const xIn = cx >= inner.x0 && cx + step <= inner.x1;
            if (zIn && cx === inner.x1) split = 0; // left edge p00-p01 touches the inner rect's right side
            else if (xIn && cz + step === inner.z0) split = 1; // edge p01-p11 touches the inner top side
            else if (zIn && cx + step === inner.x0) split = 2; // edge p11-p10 touches the inner left side
            else if (xIn && cz === inner.z1) split = 3; // edge p10-p00 touches the inner bottom side
          }
          if (split < 0) {
            const ha = hgt[p00];
            const hb = hgt[p10];
            const hc = hgt[p01];
            const hd = hgt[p11];
            if (Math.abs(ha - hd) <= Math.abs(hb - hc)) idx.push(p00, p01, p11, p00, p11, p10);
            else idx.push(p00, p01, p10, p10, p01, p11);
            continue;
          }
          const poly = [p00, p01, p11, p10];
          const mids = [
            () => vertex(cx, cz + half),
            () => vertex(cx + half, cz + step),
            () => vertex(cx + step, cz + half),
            () => vertex(cx + half, cz),
          ];
          const m = mids[split]();
          // polygon [.., A, m, B, ..] → fan from m: (m, B, X), (m, X, Y), (m, Y, A)
          const B = poly[(split + 1) % 4];
          const X = poly[(split + 2) % 4];
          const Y = poly[(split + 3) % 4];
          const A = poly[split];
          idx.push(m, B, X, m, X, Y, m, Y, A);
        }
      }
      bands.push({ outer, inner, step, nx, nz, h: grid });
    }
    this.bands = bands;
    this.mapW = W;
    this.mapH = H;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(Uint8Array.from(col), 4, true));
    g.setAttribute('aMat', new THREE.BufferAttribute(Uint8Array.from(mat), 4, true));
    const all: number[] = [];
    const ranges: { start: number; count: number }[] = [];
    for (const list of sectorIdx) {
      ranges.push({ start: all.length, count: list.length });
      for (let i = 0; i < list.length; i++) all.push(list[i]);
    }
    g.setIndex(new THREE.BufferAttribute(pos.length / 3 > 65535 ? Uint32Array.from(all) : Uint16Array.from(all), 1));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.disposeSectors();
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;

    // per-sector views of the shared buffers
    const posArr = g.getAttribute('position').array as Float32Array;
    const indexArr = g.index!.array;
    ranges.forEach((r, s) => {
      if (r.count === 0) return;
      const sg = new THREE.BufferGeometry();
      for (const name of Object.keys(g.attributes)) sg.setAttribute(name, g.attributes[name]);
      sg.setIndex(g.index);
      sg.setDrawRange(r.start, r.count);
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (let i = r.start; i < r.start + r.count; i++) {
        const k = indexArr[i] * 3;
        box.expandByPoint(v.set(posArr[k], posArr[k + 1], posArr[k + 2]));
      }
      sg.boundingBox = box;
      sg.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(sg, this.material);
      mesh.name = `terrain-border-${s}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      this.sectors.push(mesh);
      this.group.add(mesh);
    });
    this.rockHeights = Float32Array.from(rock).sort();
  }

  /** Triangles in the whole ring (tests / perf readout). */
  get triangleCount(): number {
    const i = this.mesh.geometry.index;
    return i ? i.count / 3 : 0;
  }

  /**
   * Height of the ring surface at a world point outside the map (bilinear over the band's grid), or null when the
   * point is inside the map or beyond the ring.
   */
  heightAt(px: number, pz: number): number | null {
    if (this.bands.length === 0) return null;
    if (px >= 0 && px <= this.mapW && pz >= 0 && pz <= this.mapH) return null;
    for (const b of this.bands) {
      const o = b.outer;
      if (px < o.x0 || px > o.x1 || pz < o.z0 || pz > o.z1) continue;
      const gx = Math.min(b.nx - 1.000001, Math.max(0, (px - o.x0) / b.step));
      const gz = Math.min(b.nz - 1.000001, Math.max(0, (pz - o.z0) / b.step));
      const ix = Math.floor(gx);
      const iz = Math.floor(gz);
      const tx = gx - ix;
      const tz = gz - iz;
      const k = iz * b.nx + ix;
      const h = b.h;
      return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + b.nx] * (1 - tx) + h[k + b.nx + 1] * tx) * tz;
    }
    return null;
  }

  private disposeSectors(): void {
    // disposed together with the ring geometry whose buffers they share (GL buffer removal is idempotent)
    for (const m of this.sectors) {
      m.geometry.dispose();
      m.removeFromParent();
    }
    this.sectors = [];
  }

  dispose(): void {
    this.disposeSectors();
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
    this.group.removeFromParent();
    this.bands = [];
  }
}
