import { z } from 'zod';

// Admin views of the verifications table: the Verifications list and the Dashboard numbers. Rows hold no personal
// data (country, threshold, result, error code, Idura audit reference).

export type VerificationResult = 'verified' | 'rejected' | 'cancelled' | 'error';

export interface VerificationListItem {
  id: string;
  createdAt: number;
  country: string;
  minAge: number;
  result: VerificationResult;
  errorCode: string | null;
}

export const listQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,16}_[0-9a-f-]{36}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  result: z.enum(['verified', 'rejected', 'cancelled', 'error']).optional(),
});

interface Row {
  id: string;
  created_at: number;
  country: string;
  min_age: number;
  result: VerificationResult;
  error_code: string | null;
}

/** Newest first, keyset-paginated: cursor "<created_at>_<id>" of the last row shown. */
export async function listVerifications(
  db: D1Database,
  shop: string,
  query: z.infer<typeof listQuerySchema>,
): Promise<{ items: VerificationListItem[]; nextCursor: string | null }> {
  const [at, id] = query.cursor ? query.cursor.split('_') : [null, null];
  const { results } = await db
    .prepare(
      `SELECT id, created_at, country, min_age, result, error_code FROM verifications
        WHERE shop = ?1
          AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
          AND (?4 IS NULL OR result = ?4)
        ORDER BY created_at DESC, id DESC
        LIMIT ?5`,
    )
    .bind(shop, at === null ? null : Number(at), id, query.result ?? null, query.limit + 1)
    .all<Row>();
  const page = results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      country: r.country,
      minAge: r.min_age,
      result: r.result,
      errorCode: r.error_code,
    })),
    nextCursor: results.length > query.limit && last ? `${last.created_at}_${last.id}` : null,
  };
}

const DAY_MS = 86_400_000;

export interface DashboardSummary {
  last30Days: Record<VerificationResult, number>;
  setup: {
    /** The merchant saved the Settings page at least once (countries chosen). */
    settingsSaved: boolean;
    rulesAdded: boolean;
    /** At least one completed (verified) verification ever, e.g. the merchant's own test. */
    verificationDone: boolean;
  };
  restrictedProducts: number;
}

export async function dashboardSummary(db: D1Database, shop: string, now: number): Promise<DashboardSummary> {
  const count = async (sql: string) => (await db.prepare(sql).bind(shop).first<{ n: number }>())?.n ?? 0;
  const [counts, settings, rules, verified, restricted] = await Promise.all([
    db
      .prepare(
        'SELECT result, COUNT(*) AS n FROM verifications WHERE shop = ?1 AND created_at >= ?2 GROUP BY result',
      )
      .bind(shop, now - 30 * DAY_MS)
      .all<{ result: VerificationResult; n: number }>(),
    count('SELECT COUNT(*) AS n FROM settings WHERE shop = ?1'),
    count('SELECT COUNT(*) AS n FROM restricted_rules WHERE shop = ?1'),
    // EXISTS-style: stops at the first verified row instead of counting them all.
    count(
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM verifications WHERE shop = ?1 AND result = 'verified' LIMIT 1)",
    ),
    count('SELECT COUNT(*) AS n FROM restricted_products WHERE shop = ?1 AND min_age IS NOT NULL'),
  ]);
  const last30Days: Record<VerificationResult, number> = { verified: 0, rejected: 0, cancelled: 0, error: 0 };
  for (const row of counts.results) {
    if (row.result in last30Days) last30Days[row.result] = row.n;
  }
  return {
    last30Days,
    setup: { settingsSaved: settings > 0, rulesAdded: rules > 0, verificationDone: verified > 0 },
    restrictedProducts: restricted,
  };
}
