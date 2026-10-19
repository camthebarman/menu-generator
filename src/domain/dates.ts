// Local calendar-date helpers. Label dates are stored as YYYY-MM-DD local dates in the
// organization's configured timezone. Timestamps are ISO strings converted on read.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Calendar date of an instant in a timezone. */
export function localDateOf(instant: Date | string, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** b - a in whole calendar days */
export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function minDate(dates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const d of dates) if (d && (best === null || d < best)) best = d;
  return best;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Clock abstraction so tests and demo mode can freeze time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

export function todayIn(clock: Clock, timeZone: string): string {
  return localDateOf(clock.now(), timeZone);
}
