/** Number / date / duration formatting for the UI. */
import { MONTH_SECONDS } from '../core/constants';
import { MONTH_NAMES } from '../core/defs';

const MINUS = '−';

/** Integer with thousands separators ("12,345"). Negative numbers use a proper minus sign. */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const v = Math.trunc(n + (n >= 0 ? 1e-6 : -1e-6));
  const s = Math.abs(v).toString();
  const out = s.length > 3 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
  return v < 0 ? MINUS + out : out;
}

/** Compact number: 9,999 / 12.3k / 456k / 1.2M. */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a < 10000) return fmtInt(n);
  const sign = n < 0 ? MINUS : '';
  if (a < 100000) return `${sign}${(a / 1000).toFixed(1)}k`;
  if (a < 1e6) return `${sign}${Math.round(a / 1000)}k`;
  return `${sign}${(a / 1e6).toFixed(1)}M`;
}

/** Signed integer: "+12", "−3", "0". */
export function fmtSigned(n: number): string {
  const v = Math.round(n);
  if (v > 0) return `+${fmtInt(v)}`;
  if (v < 0) return `${MINUS}${fmtInt(-v)}`;
  return '0';
}

/** Signed decimal with one place ("+2.5", "−10"). */
export function fmtSignedDec(n: number): string {
  const r = Math.round(n * 10) / 10;
  const s = Math.abs(r) >= 10 || Number.isInteger(r) ? Math.abs(Math.round(r)).toString() : Math.abs(r).toFixed(1);
  if (r > 0) return `+${s}`;
  if (r < 0) return `${MINUS}${s}`;
  return '0';
}

export function pct(frac: number): string {
  if (!Number.isFinite(frac)) return '–';
  return `${Math.round(frac * 100)}%`;
}

export function fmtTemp(c: number): string {
  const v = Math.round(c);
  return `${v < 0 ? MINUS + Math.abs(v) : v}°C`;
}

export function monthName(m: number): string {
  return MONTH_NAMES[((Math.floor(m) % 12) + 12) % 12];
}

export function dateLabel(year: number, month: number): string {
  return `Year ${year}, ${monthName(month)}`;
}

export function shortDate(year: number, month: number): string {
  return `Y${year} · ${monthName(month)}`;
}

/** Game seconds → "3 months" / "1 month" / "12 days" (a month has 30 nominal days). */
export function fmtMonths(seconds: number): string {
  const m = Math.max(0, seconds) / MONTH_SECONDS;
  if (m >= 1.95) return `${Math.round(m)} months`;
  if (m >= 0.95) return '1 month';
  const d = Math.max(1, Math.round(m * 30));
  return d === 1 ? '1 day' : `${d} days`;
}

/** Years with one decimal ("2.5 years"). */
export function fmtYears(years: number): string {
  const r = Math.round(years * 10) / 10;
  return r === 1 ? '1 year' : `${r} years`;
}

/** Wall-clock relative time for save slots. */
export function fmtRelTime(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(ms).toLocaleDateString();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${Math.round(n) === 1 ? one : many}`;
}

export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
