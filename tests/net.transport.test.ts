/**
 * Transports: the in-memory hub (tests), the BroadcastChannel dev transport and the Claude room wrapper (against a
 * fake platform) all behave like the artifact room: presence latest-wins & converging, admin-only events delivered to
 * everyone including the sender, size limits, leave detection, never throwing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { connectClaudeRoom, ClaudeRoomTransport } from '../src/net/transport-claude';
import { LocalTransport } from '../src/net/transport-local';
import { MemoryHub } from '../src/net/transport-memory';
import type { Transport, TransportMessage, TransportPeer } from '../src/net/transport';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('MemoryHub', () => {
  it('presence converges to the latest value under jitter; events reach everyone incl. the sender; admin-only emit', async () => {
    const hub = new MemoryHub({ latencyMs: 20, jitterMs: 200, drop: 0, seed: 3 });
    const a = hub.connect({ peer: 'a', admin: true });
    const b = hub.connect({ peer: 'b', admin: false });
    for (let i = 0; i < 50; i++) await a.setPresence({ x: i, keep: 1 });
    await a.setPresence({ keep: null });
    hub.flush();
    const seen = b.peers().find((p) => p.peer === 'a')!;
    expect(seen.presence).toEqual({ x: 49 });
    expect(b.peers().map((p) => p.peer)).toEqual(['a', 'b']);
    const got: TransportMessage[] = [];
    a.on('t', (m) => got.push(m));
    b.on('t', (m) => got.push(m));
    await a.emit('t', { n: 1 });
    await expect(b.emit('t', { n: 2 })).rejects.toThrow(/not_permitted/);
    await expect(a.emit('t', { big: 'x'.repeat(5000) })).rejects.toThrow(/invalid_argument/);
    await expect(a.setPresence({ big: 'x'.repeat(5000) })).rejects.toThrow(/invalid_argument/);
    hub.flush();
    expect(got.map((m) => [m.peer, m.isMe, m.sameTab])).toEqual([['a', true, true], ['a', false, false]]);
    hub.disconnect(b);
    hub.flush();
    expect(a.peers().map((p) => p.peer)).toEqual(['a']);
  });

  it('drops events at the configured rate (never the sender echo)', () => {
    const hub = new MemoryHub({ latencyMs: 1, drop: 0.3, seed: 9 });
    const a = hub.connect({ peer: 'a' });
    const b = hub.connect({ peer: 'b' });
    let atA = 0;
    let atB = 0;
    a.on('x', () => atA++);
    b.on('x', () => atB++);
    for (let i = 0; i < 1000; i++) void a.emit('x', i);
    hub.flush();
    expect(atA).toBe(1000);
    expect(atB).toBeGreaterThan(620);
    expect(atB).toBeLessThan(780);
  });
});

describe('LocalTransport (BroadcastChannel)', () => {
  const open: LocalTransport[] = [];
  afterEach(() => {
    for (const t of open.splice(0)) t.dispose();
  });

  it('two tabs see each other, share presence, exchange admin events and detect leaving', async () => {
    const a = new LocalTransport({ admin: true });
    const b = new LocalTransport({ admin: false });
    open.push(a, b);
    const peersSeen: (readonly TransportPeer[])[] = [];
    b.onPeers((p) => peersSeen.push(p));
    await a.setPresence({ n: 'Ann', h: { id: 'g1' } });
    await sleep(150);
    const ann = b.peers().find((p) => p.peer === a.selfPeer());
    expect(ann?.presence).toEqual({ n: 'Ann', h: { id: 'g1' } });
    expect(ann?.sameTab).toBe(false);
    expect(b.peers().find((p) => p.sameTab)?.peer).toBe(b.selfPeer());
    expect(await a.canEmit()).toBe(true);
    expect(await b.canEmit()).toBe(false);
    const atA: TransportMessage[] = [];
    const atB: TransportMessage[] = [];
    a.on('turn', (m) => atA.push(m));
    b.on('turn', (m) => atB.push(m));
    await a.emit('turn', { k: 5 });
    await expect(b.emit('turn', { k: 6 })).rejects.toThrow(/not_permitted/);
    await sleep(80);
    expect(atA.map((m) => [m.data, m.sameTab])).toEqual([[{ k: 5 }, true]]);
    expect(atB.map((m) => [m.data, m.sameTab, m.peer])).toEqual([[{ k: 5 }, false, a.selfPeer()]]);
    expect(peersSeen.length).toBeGreaterThan(0);
    a.dispose();
    await sleep(80);
    expect(b.peers().map((p) => p.peer)).toEqual([b.selfPeer()]);
  });
});

// ---- a fake Claude platform ------------------------------------------------------------------

interface FakePeer {
  peer: string;
  by: string | null;
  isMe: boolean;
  sameTab: boolean;
  kind: 'viewer' | 'agent';
  guest: boolean;
  presence: Record<string, unknown>;
  updatedAt: number;
}

function fakeRoom() {
  let peers: readonly FakePeer[] = Object.freeze([
    { peer: 'me1', by: 'u_me', isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: {}, updatedAt: 1 },
    { peer: 'ag1', by: null, isMe: false, sameTab: false, kind: 'agent', guest: false, presence: {}, updatedAt: 1 },
    { peer: 'yo2', by: 'u_you', isMe: false, sameTab: false, kind: 'viewer', guest: true, presence: { n: 'x' }, updatedAt: 2 },
  ] as FakePeer[]);
  const listeners = new Map<string, ((m: unknown) => void)[]>();
  const peerFns: ((c: { peers: readonly FakePeer[] }) => void)[] = [];
  const errFns: ((e: { code: string; message: string }) => void)[] = [];
  const connFns: ((c: boolean) => void)[] = [];
  let connected = true;
  const room = {
    emit: (topic: string, data: unknown) => {
      if (topic === 'nope') return Promise.reject({ code: 'not_permitted', message: 'no' });
      for (const fn of listeners.get(topic) ?? []) fn({ topic, data, peer: 'me1', by: 'u_me', isMe: true, sameTab: true, kind: 'viewer', guest: false });
      return Promise.resolve();
    },
    on: (topic: string, fn: (m: unknown) => void, onErr?: (e: { code: string; message: string }) => void) => {
      listeners.set(topic, [...(listeners.get(topic) ?? []), fn]);
      if (onErr) errFns.push(onErr);
      return () => undefined;
    },
    presence: (patch: Record<string, unknown>) => {
      if (JSON.stringify(patch).length > 4096) return Promise.reject({ code: 'invalid_argument', message: 'too big' });
      return Promise.resolve();
    },
    peers: () => peers,
    onPeers: (fn: (c: { peers: readonly FakePeer[] }) => void, onErr?: (e: { code: string; message: string }) => void) => {
      peerFns.push(fn);
      if (onErr) errFns.push(onErr);
      return () => undefined;
    },
    connected: () => connected,
    onConnection: (fn: (c: boolean) => void) => {
      connFns.push(fn);
      return () => undefined;
    },
  };
  const user = {
    canEdit: () => Promise.resolve(true),
    profiles: (ids: readonly string[]) => Promise.resolve(Object.fromEntries(ids.map((id) => [id, { id, name: id === 'u_you' ? 'Yoko' : '' }]))),
  };
  return {
    room, user,
    agentMessage: (topic: string) => {
      for (const fn of listeners.get(topic) ?? []) fn({ topic, data: 1, peer: 'ag1', by: null, isMe: false, sameTab: false, kind: 'agent', guest: false });
    },
    setPeers: (p: FakePeer[]) => {
      peers = Object.freeze(p);
      for (const fn of peerFns) fn({ peers });
    },
    fail: (code: string) => {
      connected = false;
      for (const fn of errFns) fn({ code, message: code });
    },
  };
}

describe('ClaudeRoomTransport', () => {
  it('filters agents, maps peers, resolves admin & names, never throws', async () => {
    const f = fakeRoom();
    const t: Transport = new ClaudeRoomTransport(f.room as never, f.user as never);
    expect(t.peers().map((p) => p.peer)).toEqual(['me1', 'yo2']);
    expect(t.selfPeer()).toBe('me1');
    expect(t.peers()).toBe(t.peers()); // same snapshot until something changes
    expect(await t.canEmit()).toBe(true);
    expect(await t.displayName(t.peers()[1])).toBe('Yoko');
    expect(await t.displayName({ ...t.peers()[1], by: null })).toBe('');
    const got: TransportMessage[] = [];
    t.on('turn', (m) => got.push(m));
    await t.emit('turn', { k: 1 });
    f.agentMessage('turn');
    expect(got.map((m) => [m.peer, m.sameTab])).toEqual([['me1', true]]);
    await expect(t.emit('nope', {})).rejects.toBeTruthy();
    await expect(t.setPresence({ big: 'x'.repeat(5000) })).rejects.toBeTruthy();
    let conn: boolean | null = null;
    t.onConnection((c) => (conn = c));
    await sleep(1);
    expect(conn).toBe(true);
    let latest: readonly TransportPeer[] = [];
    t.onPeers((p) => (latest = p));
    f.setPeers([{ peer: 'me1', by: 'u_me', isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: { a: 1 }, updatedAt: 5 }]);
    expect(latest.map((p) => p.presence)).toEqual([{ a: 1 }]);
    f.fail('revoked');
    expect(t.connected()).toBe(false);
    expect(conn).toBe(false);
    t.dispose();
  });

  it('connectClaudeRoom resolves null without a platform or when it never answers', async () => {
    const g = globalThis as { claude?: unknown };
    delete g.claude;
    expect(await connectClaudeRoom(50)).toBeNull();
    g.claude = { use: () => new Promise(() => undefined) };
    const t0 = Date.now();
    expect(await connectClaudeRoom(60)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    g.claude = { use: () => { throw new Error('boom'); } };
    expect(await connectClaudeRoom(50)).toBeNull();
    const f = fakeRoom();
    g.claude = { use: (n: string) => Promise.resolve(n === 'room' ? f.room : n === 'user' ? f.user : null) };
    const t = await connectClaudeRoom(50);
    expect(t?.kind).toBe('claude');
    delete g.claude;
  });
});
