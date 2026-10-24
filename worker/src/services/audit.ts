/** Appends to audit_log if the shop row exists. `details` must not contain secrets or customer PII. */
export async function writeAudit(
  db: D1Database,
  shop: string,
  action: string,
  details: Record<string, unknown>,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, shop, action, details, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM shops WHERE shop = ?2)`,
    )
    .bind(crypto.randomUUID(), shop, action, JSON.stringify(details), now)
    .run();
}
