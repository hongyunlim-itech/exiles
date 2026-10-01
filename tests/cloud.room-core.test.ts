/**
 * The relay's room state machine (cloud/room-core.ts), without Cloudflare: hello / join / leave, presence merge &
 * limits, admin-only events, the host seat (oldest connected; sticky; promotion when its holder leaves), reconnect
 * grace, kick + ban, room full, duplicate tabs, rate limits, liveness sweeps and the rebuild of a hibernated room from
 * its sockets' attachments.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSE_DUPLICATE, CLOSE_KICKED, CLOSE_REPLACED, CLOSE_ROOM_FULL, CLOSE_TIMEOUT, MAX_FRAME, MAX_PAYLOAD, parseProtocols, peerLabel,
  readAttachment, RoomCore, type PeerAttachment, type RoomIO,
} from '../cloud/room-core';
import { syncPeerLabel } from './net.relay.helpers';

interface Conn {
  name: string;
  inbox: Record<string, unknown>[];
  raw: string[];
  closed: { code: number; reason: string } | null;
}

class Harness {
  t = 1_000_000;
  readonly bans: string[][] = [];
  readonly atts = new Map<Conn, PeerAttachment | null>();
  readonly io: RoomIO<Conn> = {
    send: (c, text) => {
      c.raw.push(text);
      if (text !== 'pong') c.inbox.push(JSON.parse(text) as Record<string, unknown>);
    },
    close: (c, code, reason) => {
      c.closed = { code, reason };
      this.atts.set(c, null);
    },
    persist: (c, att) => {
      this.atts.set(c, structuredClone(att));
    },
    saveBans: (b) => {
      this.bans.push([...b]);
    },
  };
  core: RoomCore<Conn>;

  constructor(opts: ConstructorParameters<typeof RoomCore<Conn>>[1] = {}) {
    let n = 0;
    this.core = new RoomCore<Conn>(this.io, { now: () => this.t, nonce: () => `k${++n}`, ...opts });
  }

  conn(name: string): Conn {
    return { name, inbox: [], raw: [], closed: null };
  }

  /** Connect a client (cid derived from the name). */
  join(name: string, tab = 'tab1'): Conn {
    const c = this.conn(name);
    this.core.connect(c, cid(name), tab, syncPeerLabel('room', cid(name)));
    return c;
  }

  send(c: Conn, m: unknown): void {
    this.core.message(c, typeof m === 'string' ? m : JSON.stringify(m));
  }
}

const cid = (name: string): string => `client-${name}-0123456789`;
const label = (name: string): string => syncPeerLabel('room', cid(name));
const last = (c: Conn): Record<string, unknown> | undefined => c.inbox[c.inbox.length - 1];
const ofType = (c: Conn, t: string): Record<string, unknown>[] => c.inbox.filter((m) => m.t === t);

describe('RoomCore', () => {
  it('hello, join, presence merge (null deletes, replace, dedupe), full objects to the others only, limits', () => {
    const h = new Harness();
    const a = h.join('a');
    expect(a.inbox).toEqual([{ t: 'hello', self: label('a'), admin: label('a'), peers: [{ peer: label('a'), joinedAt: h.t, presence: {} }] }]);
    h.t += 10;
    const b = h.join('b');
    const hello = b.inbox[0] as { t: string; self: string; admin: string; peers: { peer: string }[] };
    expect(hello.t).toBe('hello');
    expect(hello.admin).toBe(label('a'));
    expect(hello.peers.map((p) => p.peer)).toEqual([label('a'), label('b')]);
    expect(last(a)).toEqual({ t: 'join', peer: label('b'), joinedAt: h.t });

    h.send(a, { t: 'p', patch: { x: 1, keep: 'k' } });
    expect(last(b)).toEqual({ t: 'p', peer: label('a'), presence: { x: 1, keep: 'k' } });
    expect(ofType(a, 'p')).toHaveLength(0); // never echoed
    h.send(a, { t: 'p', patch: { x: 2, keep: null } });
    expect(last(b)).toEqual({ t: 'p', peer: label('a'), presence: { x: 2 } });
    const n = b.inbox.length;
    h.send(a, { t: 'p', patch: { x: 2 } }); // unchanged → no broadcast
    expect(b.inbox.length).toBe(n);
    h.send(a, { t: 'p', r: 1, patch: { y: 'new' } });
    expect(last(b)).toEqual({ t: 'p', peer: label('a'), presence: { y: 'new' } });

    // limits: merged presence ≤ 4096 bytes, identifier keys, frames ≤ MAX_FRAME
    h.send(a, { t: 'p', patch: { big: 'x'.repeat(MAX_PAYLOAD) } });
    expect(last(a)).toMatchObject({ t: 'err', code: 'too_large' });
    h.send(a, { t: 'p', patch: { half: 'x'.repeat(2500) } });
    h.send(a, { t: 'p', patch: { more: 'x'.repeat(2500) } }); // the merge would exceed 4 KiB: refused, not applied
    expect(last(a)).toMatchObject({ t: 'err', code: 'too_large' });
    expect(Object.keys(h.core.seatsView()[0].presence)).toEqual(['y', 'half']);
    h.send(a, { t: 'p', patch: { __proto__x: 1, ['__proto__']: { polluted: 1 } } });
    expect(last(a)).toMatchObject({ t: 'err', code: 'invalid_argument' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    h.send(a, 'x'.repeat(MAX_FRAME + 1));
    expect(last(a)).toMatchObject({ t: 'err', code: 'too_large' });
    h.send(a, 'not json');
    expect(last(a)).toMatchObject({ t: 'err', code: 'invalid_argument' });
    h.core.message(a, new ArrayBuffer(4));
    expect(last(a)).toMatchObject({ t: 'err', code: 'invalid_argument' });
    h.send(a, 'ping');
    expect(a.raw[a.raw.length - 1]).toBe('pong');

    // newcomers get everyone's current presence
    const c = h.join('c');
    const hc = c.inbox[0] as { peers: { peer: string; presence: unknown }[] };
    expect(hc.peers[0]).toMatchObject({ peer: label('a'), presence: { y: 'new', half: 'x'.repeat(2500) } });
  });

  it('events: only the host seat may emit; topic grammar; ≤ 4096 bytes; relayed to the others with the sender', () => {
    const h = new Harness();
    const a = h.join('a');
    const b = h.join('b');
    h.send(a, { t: 'e', topic: 'turn', data: { k: 5 } });
    expect(last(b)).toEqual({ t: 'e', peer: label('a'), topic: 'turn', data: { k: 5 } });
    expect(ofType(a, 'e')).toHaveLength(0); // the sender delivers its own copy locally
    h.send(a, { t: 'e', topic: 'no-data' });
    expect(last(b)).toEqual({ t: 'e', peer: label('a'), topic: 'no-data', data: null });
    h.send(b, { t: 'e', topic: 'turn', data: 1 });
    expect(last(b)).toMatchObject({ t: 'err', code: 'not_permitted' });
    for (const bad of ['Turn', '1abc', 'a:b', '', 'x'.repeat(49)]) {
      h.send(a, { t: 'e', topic: bad, data: 1 });
      expect(last(a)).toMatchObject({ t: 'err', code: 'invalid_argument' });
    }
    h.send(a, { t: 'e', topic: 'big', data: 'x'.repeat(MAX_PAYLOAD) }); // JSON adds the quotes: 4098 bytes
    expect(last(a)).toMatchObject({ t: 'err', code: 'too_large' });
    h.send(a, { t: 'e', topic: 'fits', data: 'x'.repeat(MAX_PAYLOAD - 2) });
    expect(last(b)).toMatchObject({ t: 'e', topic: 'fits' });
    h.send(a, { t: 'what' });
    expect(last(a)).toMatchObject({ t: 'err', code: 'invalid_argument' });
  });

  it('host seat: oldest connected; clean leave promotes the next-oldest; a dropped seat is held for the grace', () => {
    const h = new Harness({ graceMs: 5000 });
    const a = h.join('a');
    h.t += 1;
    const b = h.join('b');
    h.t += 1;
    const c = h.join('c');
    expect(h.core.adminPeer()).toBe(label('a'));
    // a clean close (the tab left) frees the seat at once
    h.core.disconnect(a, 1001);
    expect(ofType(b, 'leave')).toEqual([{ t: 'leave', peer: label('a') }]);
    expect(last(b)).toEqual({ t: 'admin', peer: label('b') });
    expect(last(c)).toEqual({ t: 'admin', peer: label('b') });
    expect(h.core.adminPeer()).toBe(label('b'));
    expect(h.atts.get(b)?.adm).toBe(1);
    // b drops (1006): nobody notices during the grace; the same tab comes back → same seat, same host seat, no news
    const before = c.inbox.length;
    h.core.disconnect(b, 1006);
    expect(h.core.seatsView().find((s) => s.peer === label('b'))?.connected).toBe(false);
    h.t += 3000;
    h.core.tick();
    expect(c.inbox.length).toBe(before);
    const b2 = h.conn('b2');
    h.core.connect(b2, cid('b'), 'tab1', label('b'));
    expect(b2.inbox[0]).toMatchObject({ t: 'hello', self: label('b'), admin: label('b') });
    expect(c.inbox.length).toBe(before);
    expect(h.core.adminPeer()).toBe(label('b'));
    // b drops again and stays away: after the grace everyone hears it left, and c gets the seat
    h.core.disconnect(b2, 1006);
    expect(h.core.nextDeadline()).toBe(h.t + 5000);
    h.t += 5001;
    h.core.tick();
    expect(ofType(c, 'leave').map((m) => m.peer)).toEqual([label('a'), label('b')]);
    expect(last(c)).toEqual({ t: 'admin', peer: label('c') });
    // b returns later: a new seat (youngest) — the host seat stays with c
    h.t += 100;
    const b3 = h.join('b');
    expect(b3.inbox[0]).toMatchObject({ t: 'hello', self: label('b'), admin: label('c') });
    expect(last(c)).toMatchObject({ t: 'join', peer: label('b') });
    expect(h.core.adminPeer()).toBe(label('c'));
  });

  it('the host seat is sticky: a waiting (dropped) older peer does not take it back', () => {
    const h = new Harness({ graceMs: 5000 });
    const a = h.join('a');
    h.t += 1;
    const b = h.join('b');
    h.t += 1;
    const c = h.join('c');
    h.core.disconnect(b, 1006); // b waits within its grace
    h.core.disconnect(a, 1000); // the host leaves: the oldest CONNECTED peer gets the seat
    expect(h.core.adminPeer()).toBe(label('c'));
    expect(last(c)).toEqual({ t: 'admin', peer: label('c') });
    const b2 = h.conn('b2');
    h.core.connect(b2, cid('b'), 'tab1', label('b'));
    expect(b2.inbox[0]).toMatchObject({ t: 'hello', admin: label('c') });
    expect(h.core.adminPeer()).toBe(label('c'));
    void b;
  });

  it('the same tab on a new socket replaces the old one; another tab with a copied client id is refused', () => {
    const h = new Harness();
    const a = h.join('a', 'tabA');
    const other = h.join('o');
    const a2 = h.conn('a2');
    h.core.connect(a2, cid('a'), 'tabA', label('a'));
    expect(a.closed).toEqual({ code: CLOSE_REPLACED, reason: 'replaced' });
    expect(a2.inbox[0]).toMatchObject({ t: 'hello', self: label('a') });
    expect(ofType(other, 'leave')).toHaveLength(0);
    h.core.disconnect(a, CLOSE_REPLACED); // the old socket's close arrives later: ignored
    expect(h.core.seatsView().find((s) => s.peer === label('a'))?.connected).toBe(true);
    h.send(a2, { t: 'e', topic: 'x', data: 1 });
    expect(last(other)).toMatchObject({ t: 'e', peer: label('a') });
    const dup = h.conn('dup');
    h.core.connect(dup, cid('a'), 'tabB', label('a'));
    expect(dup.inbox).toEqual([{ t: 'err', code: 'duplicate' }]);
    expect(dup.closed?.code).toBe(CLOSE_DUPLICATE);
    // invalid ids
    const bad = h.conn('bad');
    h.core.connect(bad, 'short', 'tabA', label('a'));
    expect(bad.closed?.code).toBe(4005);
  });

  it('kick: host seat only; closes 4001, tells everyone, bans the client id until the room empties', () => {
    const h = new Harness();
    const a = h.join('a');
    const b = h.join('b');
    const c = h.join('c');
    h.send(b, { t: 'kick', peer: label('c') });
    expect(last(b)).toMatchObject({ t: 'err', code: 'not_permitted' });
    expect(c.closed).toBeNull();
    h.send(a, { t: 'kick', peer: label('a') });
    expect(last(a)).toMatchObject({ t: 'err', code: 'invalid_argument' });
    h.send(a, { t: 'kick', peer: label('c') });
    expect(last(c)).toEqual({ t: 'err', code: 'kicked' });
    expect(c.closed).toEqual({ code: CLOSE_KICKED, reason: 'kicked' });
    expect(last(a)).toEqual({ t: 'leave', peer: label('c') });
    expect(last(b)).toEqual({ t: 'leave', peer: label('c') });
    expect(h.bans[h.bans.length - 1]).toEqual([cid('c')]);
    expect(h.core.isBanned(cid('c'))).toBe(true);
    h.core.disconnect(c, CLOSE_KICKED); // its close arrives: nothing more happens
    // coming back (reload, same tab) is refused
    const c2 = h.join('c');
    expect(c2.inbox).toEqual([{ t: 'err', code: 'kicked' }]);
    expect(c2.closed?.code).toBe(CLOSE_KICKED);
    expect(h.core.size()).toBe(2);
    // the room's lifetime ends when everyone left: bans are forgotten
    h.core.disconnect(a, 1000);
    h.core.disconnect(b, 1000);
    expect(h.core.isEmpty()).toBe(true);
    expect(h.bans[h.bans.length - 1]).toEqual([]);
    const c3 = h.join('c');
    expect(c3.inbox[0]).toMatchObject({ t: 'hello', self: label('c'), admin: label('c') });
  });

  it('room full at 16 seats (held seats count); the 17th is refused with 4004', () => {
    const h = new Harness({ graceMs: 5000 });
    const conns: Conn[] = [];
    for (let i = 0; i < 16; i++) conns.push(h.join(`p${i}`));
    expect(h.core.size()).toBe(16);
    const x = h.join('extra');
    expect(x.inbox).toEqual([{ t: 'err', code: 'room_full' }]);
    expect(x.closed?.code).toBe(CLOSE_ROOM_FULL);
    h.core.disconnect(conns[3], 1006); // held for its grace: still full
    const y = h.join('extra2');
    expect(y.closed?.code).toBe(CLOSE_ROOM_FULL);
    h.t += 5001;
    h.core.tick();
    const z = h.join('extra3');
    expect(z.closed).toBeNull();
    expect(h.core.size()).toBe(16);
  });

  it('rate limits: 40/s, burst 80 per socket and kind; the excess is dropped silently', () => {
    const h = new Harness();
    const a = h.join('a');
    const b = h.join('b');
    const count = (): number => ofType(b, 'p').length;
    for (let i = 0; i < 200; i++) h.send(a, { t: 'p', patch: { i } });
    expect(count()).toBe(80);
    expect(ofType(a, 'err')).toHaveLength(0);
    h.t += 1000;
    for (let i = 200; i < 400; i++) h.send(a, { t: 'p', patch: { i } });
    expect(count()).toBe(120);
    // events have their own bucket
    let events = 0;
    for (let i = 0; i < 100; i++) h.send(a, { t: 'e', topic: 'x', data: i });
    events = ofType(b, 'e').length;
    expect(events).toBe(80);
  });

  it('liveness: a silent socket is closed (4006) and its seat held for the grace; the emitting host seat sooner', () => {
    const h = new Harness({ graceMs: 5000, deadMs: 90_000, adminDeadMs: 12_000 });
    const a = h.join('a');
    h.t += 1;
    const b = h.join('b');
    const pings = new Map<Conn, number>([[a, h.t], [b, h.t]]);
    h.send(a, { t: 'e', topic: 'turn', data: 1 }); // a hosts: emits
    // b pings (auto-response timestamps) but a goes silent
    for (let s = 0; s < 13; s++) {
      h.t += 1000;
      pings.set(b, h.t);
      h.core.tick((c) => pings.get(c) ?? 0);
    }
    expect(a.closed).toEqual({ code: CLOSE_TIMEOUT, reason: 'timeout' });
    expect(h.core.adminPeer()).toBe(label('a')); // still held during the grace
    h.t += 5001;
    h.core.tick((c) => pings.get(c) ?? 0);
    expect(h.core.adminPeer()).toBe(label('b'));
    expect(last(b)).toEqual({ t: 'admin', peer: label('b') });
    // a non-emitting peer (b, now in the lobby) that keeps pinging stays; one that stops is closed after 90 s
    h.t += 80_000;
    h.core.tick(() => h.t - 1000);
    expect(b.closed).toBeNull();
    h.t += 91_000;
    h.core.tick(() => 0);
    expect(b.closed?.code).toBe(CLOSE_TIMEOUT);
  });

  it('rebuilds a hibernated room from the sockets\' attachments (sticky host seat, presence, bans)', () => {
    const h = new Harness({ graceMs: 5000 });
    const a = h.join('a');
    h.t += 1;
    const b = h.join('b');
    h.t += 1;
    const c = h.join('c');
    h.t += 1;
    const d = h.join('d');
    h.send(b, { t: 'p', patch: { n: 'Bea', f: { k: 10 } } });
    h.send(c, { t: 'p', patch: { n: 'Cy' } });
    h.core.disconnect(a, 1000); // b holds the host seat now
    h.send(b, { t: 'kick', peer: label('d') }); // d is banned
    h.send(c, { t: 'p', patch: { n: 'Cyrus' } });
    expect(h.core.adminPeer()).toBe(label('b'));

    // the object hibernates: in-memory state is gone; only the open sockets (a left, d was kicked — both closed) with
    // their attachments and the stored bans survive
    const h2 = new Harness({ graceMs: 5000, bans: h.bans[h.bans.length - 1] });
    h2.t = h.t + 60_000;
    expect(d.closed?.code).toBe(CLOSE_KICKED);
    expect(h.atts.get(d)).toBeNull(); // tombstoned when closed
    for (const x of [b, c]) expect(h2.core.restore(x, h.atts.get(x))).toBe(true);
    h2.core.finishRestore();
    expect(h2.core.adminPeer()).toBe(label('b'));
    expect(h2.core.seatsView().map((s) => [s.peer, s.presence])).toEqual([
      [label('b'), { n: 'Bea', f: { k: 10 } }], [label('c'), { n: 'Cyrus' }],
    ]);
    // keeps working: events from the host seat, a newcomer's hello, the ban
    const cBefore = c.inbox.length;
    h2.send(b, { t: 'e', topic: 'turn', data: { k: 11 } });
    expect(c.inbox.length).toBe(cBefore + 1);
    expect(last(c)).toEqual({ t: 'e', peer: label('b'), topic: 'turn', data: { k: 11 } });
    const e = h2.join('e');
    const hello = e.inbox[0] as { admin: string; peers: { peer: string; joinedAt: number }[] };
    expect(hello.admin).toBe(label('b'));
    expect(hello.peers.map((p) => p.peer)).toEqual([label('b'), label('c'), label('e')]);
    expect(hello.peers[2].joinedAt).toBeGreaterThan(hello.peers[1].joinedAt);
    const d2 = h2.join('d');
    expect(d2.closed?.code).toBe(CLOSE_KICKED);
    // a socket object we have not seen (identity lost in the wake-up) is found by its attachment's nonce
    const cAlias: Conn = { ...c, inbox: c.inbox, raw: c.raw };
    h2.core.message(cAlias, JSON.stringify({ t: 'p', patch: { n: 'C.' } }), () => h.atts.get(c));
    expect(last(b)).toEqual({ t: 'p', peer: label('c'), presence: { n: 'C.' } });
    // woken by the close of a socket that was not rebuilt: everyone forgets that peer
    const ghostAtt: PeerAttachment = { ...h.atts.get(c)!, peer: syncPeerLabel('room', cid('zz')), cid: cid('zz'), k: 'other' };
    h2.core.disconnect(h2.conn('unknown'), 1006, () => ghostAtt);
    expect(last(b)).toEqual({ t: 'leave', peer: ghostAtt.peer });
    // invalid attachments are refused (the caller closes those sockets)
    expect(h2.core.restore(h2.conn('x'), null)).toBe(false);
    expect(h2.core.restore(h2.conn('x'), { v: 1, peer: 'nope' })).toBe(false);
    expect(readAttachment(h.atts.get(b))).not.toBeNull();
    // restored without a host-seat flag anywhere: the oldest connected peer gets it, and everyone is told
    const h3 = new Harness();
    const bb = h3.conn('bb');
    const cc = h3.conn('cc');
    const ab = { ...h.atts.get(b)! };
    delete ab.adm;
    h3.core.restore(cc, h.atts.get(c));
    h3.core.restore(bb, ab);
    h3.core.finishRestore();
    expect(h3.core.adminPeer()).toBe(label('b'));
    expect(last(cc)).toEqual({ t: 'admin', peer: label('b') });
  });

  it('peer labels: SHA-256 of (code, client id), 16 hex digits; protocol header parsing', async () => {
    const l = await peerLabel('room', cid('a'));
    expect(l).toMatch(/^[0-9a-f]{16}$/);
    expect(l).toBe(label('a'));
    expect(await peerLabel('other-room', cid('a'))).not.toBe(l);
    expect(parseProtocols('exiles-relay.1, cid.abcdefghijklmnopqr, tab.tab1')).toEqual({ ok: true, cid: 'abcdefghijklmnopqr', tab: 'tab1' });
    expect(parseProtocols(null)).toEqual({ ok: false, cid: '', tab: '' });
  });
});
