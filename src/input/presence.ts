/**
 * Co-op presence from the input layer: what this player shows the others — the world point under the pointer, the
 * camera focus, the placement ghost of the build tool and a human label of the current tool. Values are quantised and
 * a new LocalPresence object is only built when something visible changed, so calling `publish` every frame is cheap
 * (the NetSession throttles and packs it into the room presence itself).
 */
import type { Tool } from '../core/app';
import { BUILDINGS, ROAD_DEFS } from '../core/defs';
import type { RemovalFilter } from '../core/types';
import type { LocalPresence, PlayerInfo } from '../net/types';

const CLEAR_LABEL: Record<RemovalFilter, string> = {
  all: 'Clearing land',
  trees: 'Clearing trees',
  stone: 'Clearing stone',
  iron: 'Clearing iron',
};

/** Human label of a tool for the Players list ("Building: Wooden House", "Clearing trees", "Selecting"). */
export function toolPresenceLabel(tool: Tool, opts: { inMenu?: boolean; inspecting?: boolean } = {}): string {
  if (opts.inMenu) return 'In the menu';
  switch (tool.kind) {
    case 'select': return opts.inspecting ? 'Inspecting' : 'Selecting';
    case 'build': return `Building: ${BUILDINGS[tool.type]?.name ?? tool.type}`;
    case 'road': return `Laying ${tool.road === 'stone' ? ROAD_DEFS.stone.name.toLowerCase() : ROAD_DEFS.dirt.name.toLowerCase()}s`;
    case 'removeRoad': return 'Removing roads';
    case 'clear': return CLEAR_LABEL[tool.filter] ?? 'Clearing';
    case 'unclear': return 'Cancelling clearing orders';
    case 'demolish': return 'Demolishing';
  }
}

/** Round to a step (keeps presence stable against sub-pixel jitter; fewer updates on the wire). */
export function quantize(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function sameGhost(a: PlayerInfo['ghost'], b: PlayerInfo['ghost']): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.x === b.x && a.z === b.z && a.rot === b.rot && a.w === b.w && a.h === b.h && a.valid === b.valid;
}

export interface PresenceInput {
  cursor: { x: number; z: number } | null;
  camera: { x: number; z: number; yaw: number; dist: number } | null;
  ghost: PlayerInfo['ghost'];
  tool: string;
}

/** Keeps the last published presence; `next()` returns the same object while nothing changed. */
export class PresenceTracker {
  private cur: LocalPresence = { cursor: null, camera: null, ghost: null, tool: '' };
  private cx = NaN;
  private cz = NaN;
  private camX = NaN;
  private camZ = NaN;
  private camYaw = NaN;
  private camDist = NaN;
  private hasCursor = false;
  private hasCamera = false;

  next(inp: PresenceInput): LocalPresence {
    let changed = false;
    // cursor: 1/20 tile
    const hc = !!inp.cursor;
    const cx = hc ? quantize(inp.cursor!.x, 0.05) : NaN;
    const cz = hc ? quantize(inp.cursor!.z, 0.05) : NaN;
    if (hc !== this.hasCursor || (hc && (cx !== this.cx || cz !== this.cz))) changed = true;
    // camera: 1/10 tile, ~0.6° yaw, 0.25 distance
    const hk = !!inp.camera;
    const kx = hk ? quantize(inp.camera!.x, 0.1) : NaN;
    const kz = hk ? quantize(inp.camera!.z, 0.1) : NaN;
    const ky = hk ? quantize(inp.camera!.yaw, 0.01) : NaN;
    const kd = hk ? quantize(inp.camera!.dist, 0.25) : NaN;
    if (hk !== this.hasCamera || (hk && (kx !== this.camX || kz !== this.camZ || ky !== this.camYaw || kd !== this.camDist))) changed = true;
    if (!sameGhost(inp.ghost, this.cur.ghost)) changed = true;
    if (inp.tool !== this.cur.tool) changed = true;
    if (!changed) return this.cur;
    this.hasCursor = hc;
    this.cx = cx;
    this.cz = cz;
    this.hasCamera = hk;
    this.camX = kx;
    this.camZ = kz;
    this.camYaw = ky;
    this.camDist = kd;
    this.cur = {
      cursor: hc ? [round3(cx), round3(cz)] : null,
      camera: hk ? { x: round3(kx), z: round3(kz), yaw: round3(ky), dist: round3(kd) } : null,
      ghost: inp.ghost ? { ...inp.ghost } : null,
      tool: inp.tool,
    };
    return this.cur;
  }

  /** Forget everything (next call publishes afresh). */
  reset(): void {
    this.cur = { cursor: null, camera: null, ghost: null, tool: '' };
    this.cx = this.cz = this.camX = this.camZ = this.camYaw = this.camDist = NaN;
    this.hasCursor = this.hasCamera = false;
  }
}

/** Trim float noise from quantised values (0.1 * 3 = 0.30000000000000004) so presence JSON stays short. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
