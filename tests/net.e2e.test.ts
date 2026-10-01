/**
 * Co-op end to end, headless: the app-level flow of main.ts (via CoopDriver, the DOM-free half of main's co-op glue)
 * on a lossy MemoryHub room. Players act through the same code paths the UI and input use — AppContext.dispatch /
 * setSpeed, the UIManager.dispatch semantics (toast refusals), the input geometry helpers that build road / clearing
 * commands (roadPathIndices + chunkTiles, normalizeRect + clampRectToMap), the Professions window helpers
 * (requestWorkers / adjustProfession with pending values), confirmDemolish, the CoopController's join / leave / chat /
 * 'rejected' handling — and every town must converge to the identical state.
 */
import { describe, expect, it } from 'vitest';
import type { BuildingType, GameSpeed, Rotation } from '../src/core/types';
import { chunkTiles, clampRectToMap, normalizeRect, roadPathIndices } from '../src/input/geometry';
import { confirmDemolish } from '../src/input/tools/demolishTool';
import type { ToolHost } from '../src/input/tools/types';
import { CoopDriver, type CoopView } from '../src/net/driver';
import { MAX_PAYLOAD_BYTES } from '../src/net/transport';
import { MemoryHub, type MemoryHubOptions, type MemoryPeerOptions, type MemoryTransport } from '../src/net/transport-memory';
import type { ChatLine, Command, CommandResult } from '../src/net/types';
import { Game } from '../src/sim/game';
import type { DispatchOptions, UIContext } from '../src/ui/context';
import { pendingKeyFor, rejectionText } from '../src/ui/coop/describe';
import { DataCache } from '../src/ui/data';
import { pendingKey, PendingValues } from '../src/ui/pending';
import { adjustProfession, desiredWorkers, requestWorkers } from '../src/ui/windows/professions';
import { stateDiff } from './net.helpers';
import { findPlacement, settings } from './simcore.helpers';

// ---------------------------------------------------------------------------------------------
// A headless "tab": what main.ts + UIManager do around the CoopDriver, minus the DOM
// ---------------------------------------------------------------------------------------------

class HeadlessApp implements CoopView {
  game: Game;
  inMenu: boolean;
  readonly coop: CoopDriver;
  readonly pending: PendingValues;
  readonly ui: UIContext;
  /** Screen swaps (driver → main.swapGame). */
  readonly shows: { town: string; soft: boolean }[] = [];
  /** `followed` calls (initialJoin flags). */
  readonly follows: boolean[] = [];
  readonly toasts: string[] = [];
  readonly speeds: GameSpeed[] = [];
  readonly chat: ChatLine[] = [];
  t: MemoryTransport | null = null;
  gone = false;

  constructor(readonly room: HeadlessRoom, readonly label: string, game: Game, inMenu: boolean) {
    this.game = game;
    this.inMenu = inMenu;
    this.coop = new CoopDriver(this, { now: () => room.hub.now, cpuNow: () => 0, frameBudgetMs: 30, joinBudgetMs: 60 }); // virtual CPU clock: deterministic under load
    this.pending = new PendingValues(() => room.hub.now);
    const data = new DataCache(() => this.game);
    const app = this;
    this.ui = {
      get game() {
        return app.game;
      },
      data,
      pending: this.pending,
      dispatch: (cmd: Command, opts?: DispatchOptions) => app.uiDispatch(cmd, opts),
      toast: (text: string) => void app.toasts.push(text),
      confirm: () => Promise.resolve(true),
      sound: () => undefined,
    } as unknown as UIContext;
    // the CoopController's DOM-free bindings: a rejected command drops its pending value and is toasted; chat log
    this.coop.net.events.on('rejected', ({ cmd, reason }) => {
      const key = pendingKeyFor(cmd);
      if (key) this.pending.delete(key);
      this.toasts.push(rejectionText(cmd, reason));
    });
    this.coop.net.events.on('chat', (line) => this.chat.push(line));
  }

  // ---- CoopView ----
  showGame(game: Game, soft: boolean): void {
    this.game = game;
    this.shows.push({ town: game.state.settings.townName, soft });
  }

  followed({ initialJoin }: { initialJoin: boolean }): void {
    this.follows.push(initialJoin);
    if (initialJoin && this.inMenu) this.inMenu = false; // main: closeMenu()
  }

  toast(text: string): void {
    this.toasts.push(text);
  }

  speedChanged(speed: GameSpeed): void {
    this.speeds.push(speed);
  }

  // ---- app / UI paths ----
  connect(peer: MemoryPeerOptions): void {
    this.t = this.room.hub.connect(peer);
    expect(this.coop.attachTransport(this.t)).toBe(true);
  }

  /** main.ts newGame / loadGame → startGame (closes the menu). */
  newGame(townName: string, seed: number): void {
    this.coop.startGame(Game.create(settings({ seed, townName })));
    this.inMenu = false;
  }

  /** UIManager.dispatch: AppContext.dispatch, refusals toasted, derived data invalidated. */
  uiDispatch(cmd: Command, opts: DispatchOptions = {}): CommandResult {
    const res = this.coop.dispatch(cmd);
    if (!res.ok && opts.toastFailure !== false) this.toasts.push(res.reason ?? 'That is not possible right now.');
    this.ui.data.invalidate();
    return res;
  }

  /** BuildTool.place (after its local checks): the place command it dispatches. */
  place(type: BuildingType, x: number, z: number, rot: Rotation): CommandResult {
    return this.uiDispatch({ op: 'place', type, x, z, rot });
  }

  /** RoadTool on release: the L-shaped path, split into command-sized chunks. */
  road(x0: number, z0: number, x1: number, z1: number): CommandResult[] {
    const s = this.game.state;
    return chunkTiles(roadPathIndices(x0, z0, x1, z1, s.W, s.H)).map((tiles) => this.uiDispatch({ op: 'road', kind: 'dirt', tiles }));
  }

  /** ClearTool on release: the dragged rectangle, clamped to the map. */
  clear(ax: number, az: number, bx: number, bz: number): CommandResult {
    const s = this.game.state;
    const r = clampRectToMap(normalizeRect(ax, az, bx, bz), s.W, s.H)!;
    return this.uiDispatch({ op: 'mark', x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, filter: 'trees' });
  }

  /** The Delete hotkey / demolish tool: confirm, then dispatch. */
  demolish(id: number): void {
    const host = {
      app: {
        game: this.game,
        ui: { confirm: () => Promise.resolve(true), toast: (t: string) => void this.toasts.push(t) },
        dispatch: (cmd: Command) => this.coop.dispatch(cmd),
      },
      playUi: () => undefined,
    } as unknown as Pick<ToolHost, 'app' | 'playUi'>;
    confirmDemolish(host, id);
  }

  rejections(prefix: string): number {
    return this.toasts.filter((t) => t.startsWith(prefix)).length;
  }

  get tick(): number {
    return this.coop.net.currentTick;
  }
}

class HeadlessRoom {
  readonly hub: MemoryHub;
  readonly apps: HeadlessApp[] = [];

  constructor(opts: MemoryHubOptions) {
    this.hub = new MemoryHub(opts);
  }

  app(label: string, game: Game, peer: MemoryPeerOptions | null, inMenu = true): HeadlessApp {
    const a = new HeadlessApp(this, label, game, inMenu);
    if (peer) a.connect(peer);
    this.apps.push(a);
    return a;
  }

  /** The tab closes (pagehide): others see the peer leave. */
  close(a: HeadlessApp): void {
    a.gone = true;
    if (a.t) this.hub.disconnect(a.t);
    a.coop.dispose();
  }

  /** `n` animation frames of `ms` each on every open tab (virtual clock), yielding to async work in between. */
  async frames(n: number, ms = 50, each?: () => void): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.hub.advance(ms);
      for (const a of this.apps) if (!a.gone) a.coop.frame(ms / 1000, a.inMenu, this.hub.now);
      each?.();
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  async until(cond: () => boolean, max: number, ms = 50, each?: () => void): Promise<boolean> {
    for (let i = 0; i < max; i++) {
      if (cond()) return true;
      await this.frames(1, ms, each);
    }
    return cond();
  }
}

/** Pause the shared clock from `who` and wait until every follower stands at the host's tick with nothing queued. */
async function settle(room: HeadlessRoom, who: HeadlessApp, host: HeadlessApp, followers: HeadlessApp[]): Promise<boolean> {
  who.coop.setSpeed(0);
  const ok = await room.until(() => host.coop.speed() === 0 && followers.every((f) =>
    f.coop.status().mode === 'guest' && f.tick === host.tick && f.coop.status().pendingCommands === 0 && f.coop.speed() === 0), 600);
  await room.frames(10);
  return ok && followers.every((f) => f.tick === host.tick);
}

function buildingAt(g: Game, type: BuildingType, x: number, z: number): number | null {
  return g.state.buildings.find((b) => b.type === type && b.x === x && b.z === z)?.id ?? null;
}

// ---------------------------------------------------------------------------------------------

describe('co-op end to end (app flow on a lossy room)', () => {
  it('host + view-only guest + admin guest build one town through the UI paths, converge, and survive the host leaving', async () => {
    const room = new HeadlessRoom({ latencyMs: 40, jitterMs: 60, drop: 0.1, seed: 11 });
    // the host's tab boots with the title-screen town; the view-only guest sits in the menu; the second admin plays solo
    const host = room.app('host', Game.create(settings({ seed: 201, townName: 'Title' })), { peer: 'p1', name: 'Hana' });
    const viewer = room.app('viewer', Game.create(settings({ seed: 202 })), { peer: 'p3', admin: false, guest: true, name: 'Vic' });
    const aki = room.app('aki', Game.create(settings({ seed: 203, townName: 'Akiholm' })), { peer: 'p2', name: 'Aki' }, false);
    expect(await room.until(() => host.coop.status().canHost && aki.coop.status().canHost && viewer.coop.status().connected, 40)).toBe(true);
    for (const a of [host, viewer, aki]) expect(a.coop.netMode).toBe('lobby');
    expect(viewer.coop.status().canHost).toBe(false);

    // lobby: a solo town runs only while the menu is closed
    const akiT0 = aki.game.state.time.elapsed;
    const viewerT0 = viewer.game.state.time.elapsed;
    await room.frames(10);
    expect(aki.game.state.time.elapsed).toBeGreaterThan(akiT0);
    expect(viewer.game.state.time.elapsed).toBe(viewerT0);

    // New Game on the connected admin → it is hosted
    host.newGame('Riverbend', 204);
    expect(host.coop.status().mode).toBe('host');
    expect(host.shows.at(-1)).toEqual({ town: 'Riverbend', soft: false });
    expect(host.game).toBe(host.coop.net.game);
    expect(host.coop.mayAutosave).toBe(true);

    // the lobby sees the hosted town (main menu "Join …" button); join from the menu and from a running solo game
    expect(await room.until(() => viewer.coop.hostedTown()?.townName === 'Riverbend' && aki.coop.hostedTown() !== null, 100)).toBe(true);
    expect(viewer.coop.hostedTown()!.hostName).toBe('Hana');
    // a lobby peer's cursor is over its own town: not drawn in the host's
    aki.coop.net.setLocalPresence({ cursor: [5, 5], camera: null, ghost: null, tool: 'Selecting' });
    await room.frames(6);
    const akiSeen = host.coop.players().find((p) => p.peer === 'p2')!;
    expect(akiSeen.cursor).toBeNull();
    expect(akiSeen.tool).toBe('Selecting');

    viewer.coop.net.join();
    aki.coop.net.join();
    expect(viewer.coop.netMode).toBe('joining');
    expect(await room.until(() => viewer.coop.netMode === 'guest' && aki.coop.netMode === 'guest', 600)).toBe(true);
    for (const g of [viewer, aki]) {
      expect(g.game.state.settings.townName).toBe('Riverbend');
      expect(g.game).toBe(g.coop.net.game);
      expect(g.follows).toEqual([true]);
      expect(g.shows.at(-1)).toEqual({ town: 'Riverbend', soft: false });
      expect(g.coop.mayAutosave).toBe(false); // a guest's copy never overwrites its own saves
    }
    expect(viewer.inMenu).toBe(false); // joining from the menu closes it

    // ---- commands through the UI paths ----
    const c0 = host.game.townCenter();
    const c = { x: Math.floor(c0.x), z: Math.floor(c0.z) };
    const hutSpot = findPlacement(host.game, 'gathererHut', c.x - 8, c.z + 6)!;
    const res = host.place('gathererHut', hutSpot.x, hutSpot.z, hutSpot.rot);
    expect(res.ok).toBe(true);
    expect(res.pending).toBeUndefined();
    const hutId = res.buildingId!;
    expect(hutId).toBeGreaterThan(0);

    const wellSpot = findPlacement(host.game, 'well', c.x + 7, c.z - 6)!;
    const w = viewer.place('well', wellSpot.x, wellSpot.z, wellSpot.rot);
    expect(w).toMatchObject({ ok: true, pending: true });
    expect(w.buildingId).toBeUndefined();

    // a drag across the whole map → several commands; chunks over mountains / deep water are refused locally
    const roads = viewer.road(2, c.z + 3, host.game.state.W - 3, c.z + 3);
    expect(roads.length).toBeGreaterThan(1);
    expect(roads.filter((r) => r.ok && r.pending).length).toBeGreaterThan(0);
    for (const r of roads) if (!r.ok) expect(r.reason).toBeTruthy();
    const mark = aki.clear(c.x - 20, c.z - 20, c.x - 12, c.z - 12);
    expect(mark).toMatchObject({ ok: true, pending: true });

    // the hut must exist on the guests before their panels can address it
    expect(await room.until(() => viewer.game.getBuilding(hutId) !== undefined && aki.game.getBuilding(hutId) !== undefined, 200)).toBe(true);
    expect(requestWorkers(viewer.ui, hutId, 2)).toBe(true);
    expect(desiredWorkers(viewer.ui, viewer.game.getBuilding(hutId)!)).toBe(2); // shown at once (pending value)
    expect(viewer.pending.isPending(pendingKey.workers(hutId), viewer.game.getBuilding(hutId)!.workersDesired)).toBe(true);
    expect(viewer.uiDispatch({ op: 'priority', id: hutId, priority: true })).toMatchObject({ ok: true, pending: true });
    expect(viewer.uiDispatch({ op: 'builders', n: 3 }).ok).toBe(true);
    // a deliberately conflicting order: both guests place a well on the same spot in the same frame
    const dup = findPlacement(host.game, 'well', c.x + 12, c.z + 10)!;
    expect(viewer.place('well', dup.x, dup.z, dup.rot).ok).toBe(true);
    expect(aki.place('well', dup.x, dup.z, dup.rot).ok).toBe(true);
    // shared speed from a view-only guest (top-bar buttons → AppContext.setSpeed)
    viewer.coop.setSpeed(5);

    const hutOn = (a: HeadlessApp) => a.game.getBuilding(hutId);
    expect(await room.until(() => [host, viewer, aki].every((a) => a.coop.speed() === 5 && hutOn(a)?.workersDesired === 2 &&
      hutOn(a)?.priority === true && buildingAt(a.game, 'well', wellSpot.x, wellSpot.z) !== null &&
      buildingAt(a.game, 'well', dup.x, dup.z) !== null) && viewer.coop.status().pendingCommands === 0 &&
      aki.coop.status().pendingCommands === 0, 400)).toBe(true);
    for (const a of [host, viewer, aki]) expect(a.speeds).toContain(5);
    expect(viewer.pending.isPending(pendingKey.workers(hutId), 2)).toBe(false);
    // exactly one of the two conflicting orders was refused — toasted on its issuer only
    await room.frames(4);
    const refusedWell = (a: HeadlessApp) => a.rejections("Couldn't build the Well");
    expect(refusedWell(viewer) + refusedWell(aki)).toBe(1);
    expect(refusedWell(host)).toBe(0);
    expect(host.game.state.buildings.filter((b) => b.type === 'well' && b.x === dup.x && b.z === dup.z)).toHaveLength(1);

    // the Professions window's −/+ on a guest, and a demolition confirmed on a guest
    aki.ui.data.invalidate();
    expect(adjustProfession(aki.ui, 'gatherer', 1)).toBe(true);
    const wellId = buildingAt(aki.game, 'well', wellSpot.x, wellSpot.z)!;
    aki.demolish(wellId);
    expect(await room.until(() => [host, viewer, aki].every((a) => hutOn(a)?.workersDesired === 3 &&
      (a.game.getBuilding(wellId) === undefined || a.game.getBuilding(wellId)!.state === 'demolishing')), 300)).toBe(true);

    // chat: admins emit, the view-only guest is relayed by the host — every line once everywhere. Each line is emitted
    // twice (a copy survives a dropped event); a lower drop rate here keeps "both copies dropped" out of this test
    room.hub.drop = 0.03;
    viewer.coop.net.sendChat('hi from the viewer');
    host.coop.net.sendChat('welcome to Riverbend');
    aki.coop.net.sendChat('hello!');
    expect(await room.until(() => [host, viewer, aki].every((a) => a.chat.length >= 3), 200)).toBe(true);
    await room.frames(20);
    for (const a of [host, viewer, aki]) {
      expect(a.chat.map((l) => l.text).sort()).toEqual(['hello!', 'hi from the viewer', 'welcome to Riverbend']);
      expect(a.chat.find((l) => l.text === 'hi from the viewer')!.name).toBe('Vic');
      expect(a.chat.find((l) => l.text === 'welcome to Riverbend')!.name).toBe('Hana');
    }
    room.hub.drop = 0.1;

    // cursors / ghosts of players in the same town (renderer's remote players)
    const cx = c.x;
    const cz = c.z;
    viewer.coop.net.setLocalPresence({
      cursor: [cx + 0.5, cz + 0.25], camera: { x: cx, z: cz, yaw: 0.3, dist: 40 },
      ghost: { type: 'woodenHouse', x: cx, z: cz, rot: 0, w: 3, h: 3, valid: true }, tool: 'Building: Wooden House',
    });
    expect(await room.until(() => (host.coop.players().find((p) => p.peer === 'p3')?.ghost ?? null) !== null, 40)).toBe(true);
    const seen = host.coop.players().find((p) => p.peer === 'p3')!;
    expect(seen).toMatchObject({ name: 'Vic', guest: true, isHost: false, tool: 'Building: Wooden House' });
    expect(seen.cursor).toEqual([cx + 0.5, cz + 0.25]);
    expect(seen.ghost).toMatchObject({ type: 'woodenHouse', x: cx, z: cz, valid: true });
    expect(host.coop.players().find((p) => p.isMe)!.isHost).toBe(true);

    // pause from the admin guest; an order given while paused still reaches everyone; identical towns
    expect(await settle(room, aki, host, [viewer, aki])).toBe(true);
    const pausedAt = host.tick;
    expect(viewer.uiDispatch({ op: 'priority', id: hutId, priority: false }).pending).toBe(true);
    expect(await room.until(() => [host, viewer, aki].every((a) => hutOn(a)?.priority === false), 200)).toBe(true);
    expect(host.tick).toBe(pausedAt);
    expect(stateDiff(host.game, viewer.game)).toBe('');
    expect(stateDiff(host.game, aki.game)).toBe('');

    // the host opens the main menu: the shared clock keeps running for everyone
    host.inMenu = true;
    viewer.coop.setSpeed(2);
    await room.frames(60);
    expect(host.tick).toBeGreaterThan(pausedAt + 10);
    expect(viewer.tick).toBeGreaterThan(pausedAt + 5);

    // the host's tab closes: the admin guest takes over, the view-only guest keeps following
    const shownBefore = aki.shows.length;
    room.close(host);
    expect(await room.until(() => aki.coop.netMode === 'host' && viewer.coop.netMode === 'guest' &&
      !viewer.coop.net.waitingForHost && viewer.tick > 0, 600)).toBe(true);
    expect(aki.game).toBe(aki.coop.net.game);
    expect(aki.shows.length).toBe(shownBefore); // same town, no swap
    expect(aki.coop.mayAutosave).toBe(true);
    const afterTakeover = viewer.tick;
    await room.frames(60);
    expect(viewer.tick).toBeGreaterThan(afterTakeover);
    expect(await settle(room, viewer, aki, [viewer])).toBe(true);
    expect(stateDiff(aki.game, viewer.game)).toBe('');
    expect(viewer.coop.status().resyncs).toBeLessThanOrEqual(1);
    // the new host relayed the viewer's still-queued chat line again: nobody shows it twice
    for (const a of [viewer, aki]) expect(a.chat.map((l) => l.text).sort()).toEqual(['hello!', 'hi from the viewer', 'welcome to Riverbend']);
    expect(room.hub.stats.maxEventBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(room.hub.stats.maxPresenceBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(room.hub.stats.dropped).toBeGreaterThan(0);
  });

  it('stop sharing sends followers to the lobby with their copy; a vanished host leaves them waiting; a new host is followed', async () => {
    const room = new HeadlessRoom({ latencyMs: 30, jitterMs: 30, seed: 3 });
    const host = room.app('host', Game.create(settings({ seed: 301 })), { peer: 'p1', name: 'Hana' });
    const viewer = room.app('viewer', Game.create(settings({ seed: 302 })), { peer: 'p5', admin: false });
    expect(await room.until(() => host.coop.status().canHost, 40)).toBe(true);
    host.newGame('First', 303);
    expect(await room.until(() => viewer.coop.hostedTown() !== null, 100)).toBe(true);
    viewer.coop.net.join();
    expect(await room.until(() => viewer.coop.netMode === 'guest', 600)).toBe(true);

    // "Stop sharing" (Players window / menu → net.leave())
    host.coop.net.leave();
    expect(host.coop.status().mode).toBe('lobby');
    expect(await room.until(() => viewer.coop.netMode === 'lobby', 100)).toBe(true);
    expect(viewer.game.state.settings.townName).toBe('First'); // keeps its copy…
    const t = viewer.game.state.time.elapsed;
    await room.frames(20);
    expect(viewer.game.state.time.elapsed).toBeGreaterThan(t); // …and plays on alone
    expect(viewer.coop.mayAutosave).toBe(true);

    // the host starts another town (connected admin in the lobby → hosted); the viewer joins it
    host.newGame('Second', 304);
    expect(host.coop.status().mode).toBe('host');
    expect(await room.until(() => viewer.coop.hostedTown()?.townName === 'Second', 100)).toBe(true);
    viewer.coop.net.join();
    expect(await room.until(() => viewer.coop.netMode === 'guest' && viewer.game.state.settings.townName === 'Second', 600)).toBe(true);

    // the host's tab closes and no admin can take over: the viewer waits, its clock stands still
    room.close(host);
    expect(await room.until(() => viewer.coop.net.waitingForHost, 200)).toBe(true);
    expect(viewer.coop.speed()).toBe(0);
    expect(viewer.speeds.at(-1)).toBe(0);
    expect(viewer.coop.status().label).toMatch(/^Waiting for the host/);
    const frozen = viewer.tick;
    await room.frames(40);
    expect(viewer.tick).toBe(frozen);

    // an admin opens the page and starts a town: the waiting viewer follows it automatically (full swap, no join click)
    const next = room.app('next', Game.create(settings({ seed: 305 })), { peer: 'p9', name: 'Nia' });
    expect(await room.until(() => next.coop.status().canHost, 40)).toBe(true);
    next.newGame('Third', 306);
    expect(await room.until(() => viewer.coop.netMode === 'guest' && viewer.game.state.settings.townName === 'Third', 600)).toBe(true);
    expect(viewer.follows.at(-1)).toBe(false); // "the host opened another town"
    expect(viewer.shows.at(-1)).toEqual({ town: 'Third', soft: false });
    expect(viewer.coop.speed()).toBeGreaterThan(0);
    expect(await settle(room, next, next, [viewer])).toBe(true);
    expect(stateDiff(next.game, viewer.game)).toBe('');
  });

  it('a desync is repaired by a soft swap; New Game from a guest leaves first and stays local while someone hosts', async () => {
    const room = new HeadlessRoom({ latencyMs: 25, jitterMs: 25, seed: 5 });
    const host = room.app('host', Game.create(settings({ seed: 401 })), { peer: 'p1' });
    const g = room.app('guest', Game.create(settings({ seed: 402 })), { peer: 'p2' });
    expect(await room.until(() => host.coop.status().canHost && g.coop.status().canHost, 40)).toBe(true);
    host.newGame('Mossford', 403);
    expect(await room.until(() => g.coop.hostedTown() !== null, 100)).toBe(true);
    g.coop.net.join();
    expect(await room.until(() => g.coop.netMode === 'guest', 600)).toBe(true);
    host.coop.setSpeed(5);
    await room.frames(20);

    // the guest's copy drifts (e.g. a debug helper changed it): the next hash check repairs it from a fresh snapshot
    g.game.state.citizens[0].food = 1;
    const selectionKeeps = g.shows.length;
    expect(await room.until(() => g.coop.status().resyncs === 1 && g.coop.netMode === 'guest', 600)).toBe(true);
    expect(g.shows.length).toBe(selectionKeeps + 1);
    expect(g.shows.at(-1)).toEqual({ town: 'Mossford', soft: true }); // camera, tool, selection kept
    expect(g.follows).toEqual([true]); // no second "join"
    expect(await settle(room, host, host, [g])).toBe(true);
    expect(stateDiff(host.game, g.game)).toBe('');

    // New Game while following: leave the shared town first; someone hosts here → the new town stays local
    g.newGame('Mine', 404);
    expect(g.coop.status().mode).toBe('lobby');
    expect(g.game.state.settings.townName).toBe('Mine');
    expect(g.coop.net.game).toBe(g.game);
    expect(g.toasts.some((t) => /already hosting a town here/.test(t))).toBe(true);
    const mc = g.game.townCenter();
    const mine = findPlacement(g.game, 'well', mc.x + 6, mc.z)!;
    const r = g.place('well', mine.x, mine.z, mine.rot);
    expect(r.ok).toBe(true);
    expect(r.pending).toBeUndefined(); // local play: real results
    expect(r.buildingId).toBeDefined();
    await room.frames(20);
    expect(host.coop.status().mode).toBe('host');
    expect(host.game.state.settings.townName).toBe('Mossford');
  });

  it('solo without a room; a late room lights up the lobby without hosting on its own; a hidden host keeps real-time pace', async () => {
    const room = new HeadlessRoom({ latencyMs: 20, seed: 9 });
    const solo = room.app('solo', Game.create(settings({ seed: 501, townName: 'Title' })), null);
    solo.newGame('Alone', 502);
    expect(solo.coop.status().mode).toBe('solo');
    expect(solo.shows.at(-1)).toEqual({ town: 'Alone', soft: false });
    const spot = findPlacement(solo.game, 'well', solo.game.townCenter().x + 5, solo.game.townCenter().z + 5)!;
    const r = solo.place('well', spot.x, spot.z, spot.rot);
    expect(r.ok).toBe(true);
    expect(r.buildingId).toBeDefined();
    const road = solo.road(spot.x - 4, spot.z - 2, spot.x + 6, spot.z - 2);
    expect(road.reduce((n, x) => n + (x.count ?? 0), 0)).toBeGreaterThan(0);
    solo.coop.setSpeed(5);
    expect(solo.game.speed).toBe(5);
    expect(solo.speeds.at(-1)).toBe(5);
    // the menu freezes a solo town; closing it resumes
    solo.inMenu = true;
    const t0 = solo.game.state.time.elapsed;
    await room.frames(10);
    expect(solo.game.state.time.elapsed).toBe(t0);
    solo.inMenu = false;
    await room.frames(10);
    expect(solo.game.state.time.elapsed).toBeGreaterThan(t0);
    expect(solo.coop.backgroundTick(0.25)).toBe(false); // no shared clock to keep alive

    // the room connects late: lobby, the running town is NOT shared by itself (the UI offers "Share town")
    const other = room.app('other', Game.create(settings({ seed: 503 })), { peer: 'p8', admin: false });
    solo.connect({ peer: 'p1', name: 'Sol' });
    expect(await room.until(() => solo.coop.status().canHost, 40)).toBe(true);
    expect(solo.coop.netMode).toBe('lobby');
    await room.frames(10);
    expect(other.coop.hostedTown()).toBeNull();
    // "Share town" (CoopController.shareCurrentTown → net.hostGame(app.game)): same game, no swap
    const shows = solo.shows.length;
    solo.coop.net.hostGame(solo.game);
    expect(solo.coop.status().mode).toBe('host');
    expect(solo.shows.length).toBe(shows);
    expect(await room.until(() => other.coop.hostedTown()?.townName === 'Alone', 100)).toBe(true);
    other.coop.net.join();
    expect(await room.until(() => other.coop.netMode === 'guest', 600)).toBe(true);

    // the host's tab goes to the background: a worker timer calls backgroundTick every 250 ms instead of frames
    solo.coop.setSpeed(1);
    await room.frames(10);
    const tick0 = solo.tick;
    for (let i = 0; i < 20; i++) {
      // the guest keeps drawing frames; the hidden host tab gets no frames, only its timer tick
      for (let f = 0; f < 5; f++) {
        room.hub.advance(50);
        other.coop.frame(0.05, other.inMenu, room.hub.now);
        await new Promise<void>((r) => setImmediate(r));
      }
      solo.coop.backgroundTick(0.25);
    }
    const ran = solo.tick - tick0;
    expect(ran).toBeGreaterThanOrEqual(19); // 5 s of real time at speed 1 = 20 ticks of 0.25 s
    expect(ran).toBeLessThanOrEqual(21);
    expect(await room.until(() => other.tick >= solo.tick - 2, 100)).toBe(true);
  });
});
