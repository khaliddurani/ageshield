// Store time zones (shop.ianaTimezone). The admin UI shows dates in the store's zone; stored timestamps stay UTC.
// Pure helpers on Intl (Workers have full ICU), DST-safe.

/** True if `tz` is an IANA zone Intl knows. */
export function isTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone to use: the store's if valid, else UTC. */
export function zoneOrUtc(tz: string | null | undefined): string {
  return isTimeZone(tz) ? tz : 'UTC';
}

/** Offset of `tz` at instant `utcMs` (local wall time minus UTC), in ms. */
export function zoneOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utcMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return local - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock "YYYY-MM-DD" + "HH:MM:SS.mmm" in `tz` → UTC ms (re-checks the offset across DST changes). */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const naive = Date.parse(`${date}T${time}Z`);
  let utc = naive - zoneOffsetMs(naive, tz);
  const corrected = naive - zoneOffsetMs(utc, tz);
  if (corrected !== utc) utc = corrected;
  return utc;
}

/** UTC ms → "YYYY-MM-DD" in `tz`. */
export function dateInZone(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}
