/**
 * Small shared helpers for the co-op layer (net-core).
 */

/** UTF-8 byte length of a string (no allocation). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** UTF-8 bytes of the JSON text of a value (Infinity for values JSON cannot represent). */
export function jsonBytes(v: unknown): number {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? 0 : utf8Length(s);
  } catch {
    return Infinity;
  }
}

/** A random lowercase alphanumeric id (not for the simulation — Math.random is fine here). */
export function randomId(len = 12): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/** 32-bit FNV-1a of a string. */
export function strHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Player colours (distinct on the terrain, readable in the UI). */
export const PLAYER_COLORS = ['#e8a33d', '#4fb0e8', '#e0566b', '#6cc36a', '#b27be8', '#e8e05a', '#4fd1c1', '#e87fb8'];

/** Zero-width joiner and emoji variation selectors (allowed in presence strings). */
const KEEP_FORMAT = new Set([0x200d, 0xfe0e, 0xfe0f]);

/**
 * Text safe for room presence (the platform refuses control, private-use and invisible format characters; emoji
 * joiners and variation selectors are fine), trimmed to `max` characters.
 */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\p{Cc}\p{Co}\p{Cs}]/gu, ' ')
    .replace(/\p{Cf}/gu, (ch) => (KEEP_FORMAT.has(ch.codePointAt(0) ?? 0) ? ch : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Deep-freeze-free shallow check that a value is a plain object. */
export function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
