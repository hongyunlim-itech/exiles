import { describe, expect, it } from 'vitest';
import {
  buildInviteUrl, closeReasonInfo, generateRoomCode, hasRoomParam, isValidRoomCode, joinHint, lowerFirst, MAX_ROOM_PLAYERS,
  NICK_MAX, normalizeRoomCode, probeRelay, readRelayOverride, readRoomParam, relayHealthUrl, ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH, sanitizeNickname, shouldProbeRelay, withRoom, type FetchLike,
} from '../src/ui/coop/rooms';

/** Deterministic [0, 1) sequence for code generation. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('room codes', () => {
  it('generates friendly 6-character codes without look-alike characters', () => {
    for (const ch of '01ilo') expect(ROOM_CODE_ALPHABET).not.toContain(ch);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(495); // 31^6 codes: collisions in 500 draws are practically impossible
  });

  it('maps the random source onto the alphabet (clamped, NaN-safe)', () => {
    const last = ROOM_CODE_ALPHABET[ROOM_CODE_ALPHABET.length - 1];
    expect(generateRoomCode(seq([0]))).toBe('aaaaaa');
    expect(generateRoomCode(seq([0.999999]))).toBe(last.repeat(6));
    expect(generateRoomCode(seq([1, -5, NaN]))).toBe(`${last}aa${last}aa`);
    expect(generateRoomCode(seq([0.5]), 3)).toHaveLength(3);
  });

  it('validates codes like the relay: [a-z0-9-]{3,32}', () => {
    expect(isValidRoomCode('abc')).toBe(true);
    expect(isValidRoomCode('my-town-42')).toBe(true);
    expect(isValidRoomCode('a'.repeat(32))).toBe(true);
    expect(isValidRoomCode('ab')).toBe(false);
    expect(isValidRoomCode('a'.repeat(33))).toBe(false);
    expect(isValidRoomCode('ABC123')).toBe(false);
    expect(isValidRoomCode('abc_12')).toBe(false);
    expect(isValidRoomCode('abc 12')).toBe(false);
    expect(isValidRoomCode(42)).toBe(false);
  });

  it('normalizes typed and pasted codes', () => {
    expect(normalizeRoomCode('  AB3Kq7 ')).toBe('ab3kq7');
    expect(normalizeRoomCode('ab3 kq7')).toBe('ab3kq7');
    expect(normalizeRoomCode('#ab3kq7')).toBe('ab3kq7');
    expect(normalizeRoomCode('https://exiles.example.workers.dev/?room=ab3kq7')).toBe('ab3kq7');
    expect(normalizeRoomCode('http://localhost:5173/?relay=http%3A%2F%2Flocalhost%3A8787&room=Party-1')).toBe('party-1');
    expect(normalizeRoomCode('?room=ab3kq7')).toBe('ab3kq7');
    expect(normalizeRoomCode('https://exiles.example.workers.dev/')).toBeNull(); // a link without a room
    expect(normalizeRoomCode('ab')).toBeNull();
    expect(normalizeRoomCode('no_underscores')).toBeNull();
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
  });

  it('reads the room from the page query', () => {
    expect(readRoomParam('?room=ab3kq7')).toBe('ab3kq7');
    expect(readRoomParam('?relay=x&room=AB3KQ7')).toBe('ab3kq7');
    expect(readRoomParam('?room=')).toBeNull();
    expect(readRoomParam('?room=bad!code')).toBeNull();
    expect(readRoomParam('')).toBeNull();
    expect(hasRoomParam('?room=bad!code')).toBe(true);
    expect(hasRoomParam('?net=local')).toBe(false);
  });
});

describe('room URLs', () => {
  it('sets the room and keeps the other parameters (host / join)', () => {
    expect(withRoom('https://exiles.example.dev/', 'ab3kq7')).toBe('https://exiles.example.dev/?room=ab3kq7');
    const dev = withRoom('http://localhost:5173/?relay=http://localhost:8787#x', 'ab3kq7');
    const u = new URL(dev);
    expect(u.searchParams.get('relay')).toBe('http://localhost:8787');
    expect(u.searchParams.get('room')).toBe('ab3kq7');
    expect(u.hash).toBe('');
    // replacing an existing room
    expect(new URL(withRoom('https://h.dev/?room=old&x=1', 'new1')).search).toBe('?room=new1&x=1');
  });

  it('drops only the room for "Play solo"', () => {
    expect(withRoom('https://exiles.example.dev/?room=ab3kq7', null)).toBe('https://exiles.example.dev/');
    const u = new URL(withRoom('http://localhost:5173/?room=ab3kq7&relay=http%3A%2F%2Flocalhost%3A8787', null));
    expect(u.searchParams.has('room')).toBe(false);
    expect(u.searchParams.get('relay')).toBe('http://localhost:8787');
  });

  it('builds invite links: origin + path + ?room (and the dev relay override only)', () => {
    expect(buildInviteUrl('https://exiles.example.workers.dev/?room=ab3kq7&debug=1#top', 'ab3kq7'))
      .toBe('https://exiles.example.workers.dev/?room=ab3kq7');
    expect(buildInviteUrl('https://exiles.example.workers.dev/', 'party-1')).toBe('https://exiles.example.workers.dev/?room=party-1');
    const dev = new URL(buildInviteUrl('http://localhost:5173/?room=ab3kq7&relay=http%3A%2F%2Flocalhost%3A8787&net=x', 'ab3kq7'));
    expect(dev.origin).toBe('http://localhost:5173');
    expect(dev.searchParams.get('room')).toBe('ab3kq7');
    expect(dev.searchParams.get('relay')).toBe('http://localhost:8787');
    expect(dev.searchParams.has('net')).toBe(false);
    // a sub-path deployment keeps its path
    expect(buildInviteUrl('https://example.com/games/exiles/index.html?room=x', 'ab3kq7')).toBe('https://example.com/games/exiles/index.html?room=ab3kq7');
  });

  it('probes the same origin, or the ?relay= override (local / LAN development hosts only, like the transport)', () => {
    expect(relayHealthUrl('')).toBe('/api/health');
    expect(relayHealthUrl('?relay=http://localhost:8787')).toBe('http://localhost:8787/api/health');
    expect(relayHealthUrl('?relay=http://localhost:8787/')).toBe('http://localhost:8787/api/health');
    expect(relayHealthUrl('?relay=ws://localhost:8787', 'http://localhost:5173/')).toBe('http://localhost:8787/api/health');
    expect(relayHealthUrl('?relay=localhost:8787', 'http://localhost:5173/')).toBe('http://localhost:8787/api/health');
    expect(relayHealthUrl('?relay=http://192.168.1.20:8787', 'http://192.168.1.20:5173/')).toBe('http://192.168.1.20:8787/api/health');
    // a crafted link cannot make the page contact a stranger's server (the transport refuses it too)
    expect(relayHealthUrl('?relay=wss://relay.example.dev', 'https://exiles.example/')).toBe('/api/health');
    expect(relayHealthUrl('?relay=wss://relay.example.dev')).toBe('/api/health');
    // the page's own host is the default anyway
    expect(relayHealthUrl('?relay=https://exiles.example', 'https://exiles.example/')).toBe('/api/health');
    expect(readRelayOverride('?relay=javascript:alert(1)')).toBeNull();
    expect(readRelayOverride('?relay=not a url')).toBeNull();
    expect(relayHealthUrl('?relay=ftp://x')).toBe('/api/health');
  });

  it('probes only on plain web pages outside rooms and artifacts', () => {
    expect(shouldProbeRelay({ inClaude: false, search: '', protocol: 'https:' })).toBe(true);
    expect(shouldProbeRelay({ inClaude: false, search: '?relay=http://localhost:8787', protocol: 'http:' })).toBe(true);
    expect(shouldProbeRelay({ inClaude: true, search: '', protocol: 'https:' })).toBe(false);
    expect(shouldProbeRelay({ inClaude: false, search: '?room=ab3kq7', protocol: 'https:' })).toBe(false);
    expect(shouldProbeRelay({ inClaude: false, search: '?net=local', protocol: 'http:' })).toBe(false);
    expect(shouldProbeRelay({ inClaude: false, search: '?net=off', protocol: 'http:' })).toBe(false);
    expect(shouldProbeRelay({ inClaude: false, search: '', protocol: 'file:' })).toBe(false);
  });
});

describe('relay health probe', () => {
  const answer = (ok: boolean, body: string): FetchLike => async () => ({ ok, text: async () => body });

  it('accepts a JSON health answer', async () => {
    expect(await probeRelay('/api/health', answer(true, '{"ok":true,"rooms":0}'))).toBe(true);
    expect(await probeRelay('/api/health', answer(true, '{}'))).toBe(true);
  });

  it('rejects errors, non-JSON (SPA index.html), ok:false and missing fetch', async () => {
    expect(await probeRelay('/api/health', answer(false, '{"ok":true}'))).toBe(false);
    expect(await probeRelay('/api/health', answer(true, '<!doctype html><html></html>'))).toBe(false);
    expect(await probeRelay('/api/health', answer(true, '{"ok":false}'))).toBe(false);
    expect(await probeRelay('/api/health', answer(true, '[1]'))).toBe(false);
    expect(await probeRelay('/api/health', async () => {
      throw new TypeError('Failed to fetch');
    })).toBe(false);
    expect(await probeRelay('/api/health', null)).toBe(false);
  });

  it('gives up after the timeout and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const hang: FetchLike = (_url, init) => {
      signal = init?.signal;
      return new Promise(() => undefined);
    };
    const t0 = Date.now();
    expect(await probeRelay('/api/health', hang, 50)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(signal?.aborted).toBe(true);
  });

  it('passes the URL and asks for fresh JSON', async () => {
    let seen: { url: string; cache?: string; accept?: string } | null = null;
    const f: FetchLike = async (url, init) => {
      seen = { url, cache: init?.cache, accept: init?.headers?.accept };
      return { ok: true, text: async () => '{"ok":true}' };
    };
    expect(await probeRelay('http://localhost:8787/api/health', f)).toBe(true);
    expect(seen).toEqual({ url: 'http://localhost:8787/api/health', cache: 'no-store', accept: 'application/json' });
  });
});

describe('nicknames and texts', () => {
  it('cleans nicknames: control/format characters, whitespace, length', () => {
    expect(sanitizeNickname('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(sanitizeNickname('Bob\u0000​‮the\nBuilder')).toBe('Bob the Builder');
    expect(sanitizeNickname('x'.repeat(40))).toHaveLength(NICK_MAX);
    // never splits an emoji (surrogate pair) at the limit
    const emoji = sanitizeNickname(`${'a'.repeat(NICK_MAX - 1)}😀😀`);
    expect(Array.from(emoji)).toHaveLength(NICK_MAX);
    expect(emoji.endsWith('😀')).toBe(true);
    expect(sanitizeNickname('   ')).toBe('');
    expect(sanitizeNickname(undefined)).toBe('');
  });

  it('says who can join per room kind', () => {
    expect(joinHint('relay')).toBe('Anyone with the invite link can join.');
    expect(joinHint('claude')).toBe('People you invite by email (Share menu) can join.');
    expect(joinHint('local')).toMatch(/net=local/);
    expect(joinHint(null)).toMatch(/can join/);
    expect(lowerFirst('Anyone with')).toBe('anyone with');
    expect(lowerFirst('')).toBe('');
  });

  it('explains terminal close reasons', () => {
    expect(closeReasonInfo(null)).toBeNull();
    expect(closeReasonInfo('')).toBeNull();
    expect(closeReasonInfo(undefined)).toBeNull();
    expect(closeReasonInfo('kicked')).toMatchObject({ text: 'You were removed from this room.', retry: false });
    expect(closeReasonInfo('room_full')).toMatchObject({ text: `This room is full (${MAX_ROOM_PLAYERS} players).`, retry: true });
    expect(closeReasonInfo('ROOM_FULL')?.text).toBe('This room is full (16 players).');
    expect(closeReasonInfo('unreachable')?.retry).toBe(true);
    expect(closeReasonInfo('bad_room')?.retry).toBe(false);
    expect(closeReasonInfo('bad_request')).toMatchObject({ title: 'Connection refused', retry: true });
    const unknown = closeReasonInfo('something_new');
    expect(unknown?.text).toBe('The connection to this room was closed.');
    expect(unknown?.retry).toBe(true);
  });
});
