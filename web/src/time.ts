import { uiLocale } from './i18n';

// Dates in the admin UI use the store's time zone (shop.ianaTimezone from /api/me), like the Shopify admin.
// Until it's known (or if /api/me fails) the browser's zone is used.

let storeZone: string | undefined;
const cache = new Map<string, Intl.DateTimeFormat>();

export function setStoreTimeZone(tz: string | null | undefined) {
  storeZone = tz || undefined;
  cache.clear();
}

function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(uiLocale, { ...options, timeZone: storeZone });
    } catch {
      f = new Intl.DateTimeFormat(uiLocale, options); // unknown zone name: browser zone
    }
    cache.set(key, f);
  }
  return f;
}

export const formatDate = (ms: number) => formatter('date', { dateStyle: 'medium' }).format(ms);
export const formatDateTime = (ms: number) =>
  formatter('datetime', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);

/** "YYYY-MM-DD" of `ms` in the store's time zone (date inputs, default ranges). */
export function isoDateInStore(ms: number): string {
  const f = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: storeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
    }
  })();
  return f.format(ms);
}

/**
 * A calendar date ("YYYY-MM-DD", already in the store's days) in the UI locale. Formatted
 * as that date, never as an instant: parsing it as midnight UTC and showing it in a zone west of UTC moved it a day back.
 */
export function formatCalendarDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat(uiLocale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1),
  );
}
