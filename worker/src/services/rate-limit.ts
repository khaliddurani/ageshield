// Fixed-window rate limiting in D1 for public endpoints (App Proxy pages). Keys are hashed; raw IPs are not stored.

export interface RateLimitRule {
  /** Namespace, e.g. "ack". */
  scope: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterS: number;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Client IP as forwarded by Shopify's App Proxy (first X-Forwarded-For entry), or CF-Connecting-IP. */
export function clientIp(headers: { get(name: string): string | null | undefined }): string {
  const forwarded = headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  return forwarded || headers.get('CF-Connecting-IP')?.trim() || 'unknown';
}

/** Counts one hit for `subject` (e.g. an IP) and says whether it is within the limit. Atomic per key. */
export async function hitRateLimit(
  db: D1Database,
  rule: RateLimitRule,
  subject: string,
  now: number,
): Promise<RateLimitResult> {
  const key = `${rule.scope}:${await sha256Hex(subject)}`;
  const windowStart = now - (now % rule.windowMs);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return {
    allowed: count <= rule.limit,
    count,
    retryAfterS: Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000)),
  };
}

/** Cron cleanup: drop windows older than `maxAgeMs`. */
export async function purgeRateLimits(db: D1Database, now: number, maxAgeMs: number): Promise<void> {
  await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?1')
    .bind(now - maxAgeMs)
    .run();
}
