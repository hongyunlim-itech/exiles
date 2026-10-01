/**
 * RelayTransport (src/net/transport-relay.ts) against the real room logic (cloud/room-core.ts) over a fake network
 * with a virtual clock: room semantics identical to the Claude room / LocalTransport (presence, peers, events, echo,
 * limits), the relay's host seat (onAdminChange), kick, room full, reconnects (backoff, seat resumed within the grace,
 * dead-socket detection), duplicate client ids, invite links and connectTransport()'s precedence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BACKOFF_MAX_MS } from '../src/net/transport-relay';
import { connectTransport, type Transport, type TransportMessage, type TransportPeer } from '../src/net/transport';
import { normalizeRoomCode, randomRoomCode, relayBase, RelayTransport, roomCodeFromParam } from '../src/net/transport-relay';
import { readRoomParam } from '../src/ui/coop/rooms';
import { CLOSE_RESET } from '../cloud/room-core';
import { RelayNet, syncPeerLabel } from './net.relay.helpers';

const cid = (name: string): string => `client-${name}-0123456789`;
const flushMicrotasks = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function names(t: Transport): string[] {
  return t.peers().map((p) => p.peer);
}

describe('RelayTransport', () => {
  it('room semantics: hello, peers incl. self, presence merge & delivery, admin-only events with a local echo, limits', async () => {
    const net = new RelayNet({ latencyMs: 30 });
    const a = net.transport(cid('a'));
    const conn: boolean[] = [];
    a.onConnection((c) => conn.push(c));
    const aAdmin = a.canEmit();
    await flushMicrotasks(); // the initial onConnection call (not connected yet)
    net.advance(200);
    expect(a.connected()).toBe(true);
    expect(a.selfPeer()).toBe(syncPeerLabel(net.code, cid('a')));
    expect(await aAdmin).toBe(true);
    const b = net.transport(cid('b'));
    const bAdmin = b.canEmit();
    net.advance(200);
    await flushMicrotasks();
    expect(await bAdmin).toBe(false);
    expect(conn).toEqual([false, true]);
    expect(names(a)).toEqual([a.selfPeer(), b.selfPeer()]);
    expect(names(b)).toEqual([a.selfPeer(), b.selfPeer()]);
    const selfA = a.peers()[0];
    expect(selfA).toMatchObject({ isMe: true, sameTab: true, guest: false, by: null });
    expect(b.peers()[0]).toMatchObject({ isMe: false, sameTab: false, guest: false, by: null });
    expect(a.adminPeer()).toBe(a.selfPeer());
    expect(b.adminPeer()).toBe(a.selfPeer());

    // presence: applied locally at once, coalesced, merged (null deletes), handed to the others whole
    for (let i = 0; i < 20; i++) await a.setPresence({ x: i, keep: 1 });
    expect(a.peers()[0].presence).toEqual({ x: 19, keep: 1 });
    await a.setPresence({ keep: null, n: 'Ann' });
    const t0 = net.clock.now();
    net.advance(200);
    const seen = b.peers().find((p) => p.peer === a.selfPeer())!;
    expect(seen.presence).toEqual({ x: 19, n: 'Ann' });
    expect(seen.updatedAt).toBeGreaterThan(t0);
    expect(Object.isFrozen(seen) && Object.isFrozen(seen.presence)).toBe(true);
    const presenceFrames = net.socketOf(cid('a'))!.sent.filter((f) => f.startsWith('{"t":"p"'));
    expect(presenceFrames.length).toBeLessThanOrEqual(2); // 21 updates → coalesced
    await expect(a.setPresence({ big: 'x'.repeat(5000) })).rejects.toThrow(/invalid_argument/);
    await expect(a.setPresence({ 'bad key': 1 })).rejects.toThrow(/invalid_argument/);
    // an unchanged peer keeps its object (compare with ===) across unrelated updates
    await b.setPresence({ y: 1 });
    net.advance(200);
    expect(b.peers().find((p) => p.peer === a.selfPeer())).toBe(seen);

    // events: admin only; everyone receives, the sender through its local echo
    const got: [string, TransportMessage][] = [];
    a.on('turn', (m) => got.push(['a', m]));
    b.on('turn', (m) => got.push(['b', m]));
    await a.emit('turn', { k: 1 });
    await expect(b.emit('turn', { k: 2 })).rejects.toThrow(/not_permitted/);
    await expect(a.emit('turn', { big: 'x'.repeat(5000) })).rejects.toThrow(/invalid_argument/);
    await expect(a.emit('Bad:Topic', 1)).rejects.toThrow(/invalid_argument/);
    net.advance(200);
    expect(got.map(([who, m]) => [who, m.peer === a.selfPeer(), m.isMe, m.sameTab, m.data])).toEqual([
      ['a', true, true, true, { k: 1 }], ['b', true, false, false, { k: 1 }],
    ]);
    expect(await a.displayName(seen)).toBe('');
    expect(a.inviteUrl()).toBe('https://exiles.example/?room=test-room');
    expect(net.stats.maxClientFrame).toBeLessThanOrEqual(4608);
    a.dispose();
    b.dispose();
  });

  it('the host seat moves when its holder leaves: onAdminChange on both sides', async () => {
    const net = new RelayNet({ latencyMs: 20 });
    const a = net.transport(cid('a'));
    net.advance(100);
    const b = net.transport(cid('b'));
    const c = net.transport(cid('c'));
    const changes: string[] = [];
    b.onAdminChange((v) => changes.push(`b:${v}`));
    c.onAdminChange((v) => changes.push(`c:${v}`));
    net.advance(200);
    expect(changes).toEqual([]);
    a.dispose(); // a clean close: the relay frees the seat at once
    net.advance(200);
    expect(changes).toEqual(['b:true']);
    expect(b.adminPeer()).toBe(b.selfPeer());
    expect(c.adminPeer()).toBe(b.selfPeer());
    expect(names(c)).toEqual([b.selfPeer(), c.selfPeer()]);
    await b.emit('turn', 1);
    b.dispose();
    c.dispose();
  });

  it('kick: the kicked tab stops for good (reason, no reconnect); coming back with the same id is refused', async () => {
    const net = new RelayNet({ latencyMs: 20 });
    const a = net.transport(cid('a'));
    net.advance(100);
    const b = net.transport(cid('b'));
    net.advance(100);
    const bConn: boolean[] = [];
    b.onConnection((v) => bConn.push(v));
    await flushMicrotasks();
    b.kick(a.selfPeer()); // not the host seat: nothing happens
    a.kick(a.selfPeer()); // never yourself
    net.advance(100);
    expect(a.peers()).toHaveLength(2);
    a.kick(b.selfPeer());
    net.advance(100);
    expect(b.closeReason()).toBe('kicked');
    expect(b.connected()).toBe(false);
    expect(bConn).toEqual([true, false]);
    expect(names(b)).toEqual([b.selfPeer()]);
    expect(names(a)).toEqual([a.selfPeer()]);
    expect(net.bans).toEqual([cid('b')]);
    const sockets = net.sockets.length;
    net.advance(30_000);
    expect(net.sockets.length).toBe(sockets); // never reconnects
    await expect(b.emit('x', 1)).resolves.toBeUndefined();
    const b2 = net.transport(cid('b'));
    net.advance(200);
    expect(b2.closeReason()).toBe('kicked');
    a.dispose();
    b.dispose();
    b2.dispose();
  });

  it('room full: the 17th tab stops with "room_full"', () => {
    const net = new RelayNet({ latencyMs: 10 });
    const ts: RelayTransport[] = [];
    for (let i = 0; i < 16; i++) ts.push(net.transport(cid(`p${String(i).padStart(2, '0')}`)));
    net.advance(200);
    expect(ts.every((t) => t.connected())).toBe(true);
    expect(ts[0].peers()).toHaveLength(16);
    const x = net.transport(cid('extra'));
    net.advance(200);
    expect(x.connected()).toBe(false);
    expect(x.closeReason()).toBe('room_full');
    for (const t of [...ts, x]) t.dispose();
  });

  it('reconnects after a drop and resumes its seat within the grace (same label, host seat, presence; nobody sees a leave)', async () => {
    const net = new RelayNet({ latencyMs: 20 });
    const a = net.transport(cid('a'));
    net.advance(100);
    const b = net.transport(cid('b'));
    net.advance(100);
    await a.setPresence({ h: { id: 'town' } });
    net.advance(100);
    const bPeers: (readonly TransportPeer[])[] = [];
    b.onPeers((p) => bPeers.push(p));
    const aConn: boolean[] = [];
    a.onConnection((v) => aConn.push(v));
    const adminChanges: boolean[] = [];
    a.onAdminChange((v) => adminChanges.push(v));
    await flushMicrotasks();
    const label = a.selfPeer();
    net.drop(net.socketOf(cid('a'))!);
    net.advance(100);
    expect(a.connected()).toBe(false);
    expect(names(a)).toEqual([label, b.selfPeer()]); // the last known room stays while reconnecting
    await expect(a.emit('turn', 1)).resolves.toBeUndefined(); // dropped silently while disconnected
    net.advance(1000); // backoff 0.5 s
    expect(a.connected()).toBe(true);
    expect(a.selfPeer()).toBe(label);
    expect(aConn).toEqual([true, false, true]);
    expect(adminChanges).toEqual([]); // kept the host seat
    expect(a.adminPeer()).toBe(label);
    expect(bPeers.every((ps) => ps.some((p) => p.peer === label))).toBe(true);
    expect(b.peers().find((p) => p.peer === label)?.presence).toEqual({ h: { id: 'town' } });
    // presence changed while away is sent after the reconnect
    net.drop(net.socketOf(cid('a'))!);
    net.advance(30);
    await a.setPresence({ h: null, f: 1 });
    net.advance(1500);
    expect(b.peers().find((p) => p.peer === label)?.presence).toEqual({ f: 1 });
    a.dispose();
    b.dispose();
  });

  it('backs off exponentially up to 10 s while the relay is unreachable', () => {
    const net = new RelayNet({ latencyMs: 10 });
    net.offlineUntil.set(cid('a'), 60_000);
    const a = net.transport(cid('a'));
    net.advance(60_000);
    // 0, 0.5, 1.5, 3.5, 7.5, 15.5 s, then every 10 s
    expect(net.sockets.length).toBe(10);
    net.advance(BACKOFF_MAX_MS + 1000);
    expect(a.connected()).toBe(true);
    a.dispose();
  });

  it('detects a silent dead link (unanswered ping) and reconnects; the relay closes silent sockets', () => {
    const net = new RelayNet({ latencyMs: 20, core: { graceMs: 5000, deadMs: 30_000 } });
    const a = net.transport(cid('a'));
    const b = net.transport(cid('b'));
    net.advance(200);
    const first = net.socketOf(cid('b'))!;
    net.partition(first);
    net.advance(21_000); // ping at ≤ 5 s, no answer for 12 s → reconnect
    expect(net.socketOf(cid('b'))).not.toBe(first);
    expect(b.connected()).toBe(true);
    expect(names(a)).toHaveLength(2);
    // the relay never heard the old socket close: the new one replaced it (same tab)
    expect(first.conn!.open).toBe(false);
    // a tab that stops pinging is closed by the relay's sweep
    net.partition(net.socketOf(cid('b'))!);
    const bLabel = b.selfPeer();
    b.dispose();
    net.advance(70_000);
    expect(names(a)).toEqual([a.selfPeer()]);
    expect(names(a)).not.toContain(bLabel);
    a.dispose();
  });

  it('a second tab with a copied client id picks a new one instead of taking the seat', () => {
    const net = new RelayNet({ latencyMs: 20 });
    const a = net.transport(cid('a'));
    net.advance(100);
    const dup = net.transport(cid('a')); // same sessionStorage copy, another page load (tab nonce)
    net.advance(1000);
    expect(a.connected()).toBe(true);
    expect(dup.connected()).toBe(true);
    expect(dup.selfPeer()).not.toBe(a.selfPeer());
    expect(names(a)).toHaveLength(2);
    expect(a.adminPeer()).toBe(a.selfPeer());
    a.dispose();
    dup.dispose();
  });
});

describe('relay resets', () => {
  it('a 4007 reset (the relay lost the socket state) is not terminal: the transport reconnects on its own', async () => {
    const net = new RelayNet({ latencyMs: 20 });
    const a = net.transport(cid('a'));
    net.advance(200);
    expect(a.connected()).toBe(true);
    const label = a.selfPeer();
    const conn = net.socketOf(cid('a'))!.conn!;
    net.io.close(conn, CLOSE_RESET, 'lost state');
    net.advance(100);
    expect(a.connected()).toBe(false);
    expect(a.closeReason()).toBeNull();
    net.advance(3000);
    expect(a.connected()).toBe(true);
    expect(a.selfPeer()).toBe(label);
    expect(a.closeReason()).toBeNull();
    a.dispose();
  });
});

describe('room codes, relay base, connectTransport precedence', () => {
  const g = globalThis as unknown as { window?: unknown; WebSocket?: unknown; claude?: unknown };
  const saved = { window: g.window, WebSocket: g.WebSocket, claude: g.claude };
  const made: Transport[] = [];
  afterEach(() => {
    for (const t of made.splice(0)) t.dispose();
    g.window = saved.window;
    g.WebSocket = saved.WebSocket;
    if (saved.claude === undefined) delete g.claude;
    else g.claude = saved.claude;
  });

  class DummySocket {
    static urls: [string, string[]][] = [];
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    constructor(url: string, protocols: string[]) {
      DummySocket.urls.push([url, protocols]);
    }
    send(): void {}
    close(): void {
      this.readyState = 3;
    }
  }

  async function resolveFor(href: string): Promise<Transport | null> {
    const u = new URL(href);
    g.window = { location: { search: u.search, href }, addEventListener() {}, removeEventListener() {} };
    g.WebSocket = DummySocket;
    const t = await connectTransport();
    if (t) made.push(t);
    return t;
  }

  it('normalizes room codes and builds relay URLs', () => {
    expect(normalizeRoomCode('My Room!')).toBe('my-room');
    expect(normalizeRoomCode('  --abc--  ')).toBe('abc');
    expect(normalizeRoomCode('ab')).toBeNull();
    expect(normalizeRoomCode('x'.repeat(40))).toBe('x'.repeat(32));
    expect(normalizeRoomCode(undefined)).toBeNull();
    for (let i = 0; i < 20; i++) expect(normalizeRoomCode(randomRoomCode())).not.toBeNull();
    expect(relayBase('https://exiles.example/?room=a', null)).toBe('wss://exiles.example');
    expect(relayBase('http://localhost:5173/?room=a', null)).toBe('ws://localhost:5173');
    expect(relayBase('http://localhost:5173/', 'ws://localhost:8787')).toBe('ws://localhost:8787');
    expect(relayBase('http://localhost:5173/', 'localhost:8787/')).toBe('ws://localhost:8787');
    expect(relayBase('http://192.168.1.20:5173/', 'http://192.168.1.20:8787')).toBe('ws://192.168.1.20:8787');
    expect(relayBase('https://exiles.example/', 'wss://evil.example')).toBe('wss://exiles.example'); // refused
    expect(relayBase(null, null)).toBeNull();
    expect(relayBase('file:///x/index.html', null)).toBeNull();
  });

  it('?net=off → none; ?net=local → BroadcastChannel; ?room=<code> → relay; invalid code → none', async () => {
    DummySocket.urls = [];
    expect(await resolveFor('https://exiles.example/?net=off&room=abc')).toBeNull();
    const local = await resolveFor('https://exiles.example/?net=local&room=abc');
    expect(local?.kind).toBe('local');
    const relay = await resolveFor('https://exiles.example/?room=Misty-Glen');
    expect(relay?.kind).toBe('relay');
    expect(DummySocket.urls[0][0]).toBe('wss://exiles.example/api/room/misty-glen');
    expect(DummySocket.urls[0][1][0]).toBe('exiles-relay.1');
    expect(DummySocket.urls[0][1][1]).toMatch(/^cid\.[A-Za-z0-9_-]{22}$/);
    expect(DummySocket.urls[0][1][2]).toMatch(/^tab\.[A-Za-z0-9_-]{10}$/);
    expect(relay?.inviteUrl?.()).toBe('https://exiles.example/?room=misty-glen');
    expect(relay?.connected()).toBe(false);
    const dev = await resolveFor('http://localhost:5173/?room=dev-room&relay=ws://localhost:8787');
    expect(DummySocket.urls[1][0]).toBe('ws://localhost:8787/api/room/dev-room');
    expect(dev?.inviteUrl?.()).toBe('http://localhost:5173/?room=dev-room&relay=ws%3A%2F%2Flocalhost%3A8787');
    expect(await resolveFor('https://exiles.example/?room=a!')).toBeNull();
    // a link names exactly one room: never "corrected" into another one
    expect(await resolveFor('https://exiles.example/?room=My%20Room!')).toBeNull();
    expect(DummySocket.urls.length).toBe(2);
  });

  it('the transport and the UI read ?room= the same way', () => {
    for (const raw of ['misty-glen', ' Misty-Glen ', 'MY ROOM', 'a--b', '-abc-', 'ab', 'x'.repeat(33), 'bad!code', 'é-room', '%20abc']) {
      expect(roomCodeFromParam(raw)).toBe(readRoomParam(`?room=${encodeURIComponent(raw)}`));
    }
  });

  it('inside a Claude artifact ?room= is ignored (no outside connections there): the Claude room is used', async () => {
    DummySocket.urls = [];
    g.claude = { use: () => Promise.resolve(null) };
    expect(await resolveFor('https://claude.example/?room=test-room')).toBeNull();
    expect(DummySocket.urls.length).toBe(0);
  });
});
