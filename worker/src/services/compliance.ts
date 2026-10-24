import type { CustomersDataRequest, CustomersRedact } from '../lib/shopify/webhook-payloads';
import { writeAudit } from './audit';

// Mandatory privacy webhooks (ARCHITECTURE §4): customers/data_request, customers/redact, shop/redact.
// AgeShield stores no customer personal data: verifications hold country, age threshold and result only, with no
// link to a customer, an order (Phase 1) or an eID identity. So the customer requests have nothing to return or
// delete; each one is acknowledged in the audit log (request id only).

export async function handleCustomersDataRequest(
  db: D1Database,
  shop: string,
  request: CustomersDataRequest,
  now: number,
): Promise<void> {
  await writeAudit(
    db,
    shop,
    'customers_data_request',
    { requestId: request.data_request.id, records: 0 },
    now,
  );
}

export async function handleCustomersRedact(
  db: D1Database,
  shop: string,
  request: CustomersRedact,
  now: number,
): Promise<void> {
  await writeAudit(
    db,
    shop,
    'customers_redact',
    { orders: request.orders_to_redact.length, records: 0 },
    now,
  );
}

// Every table with a `shop` column. Children first.
export const SHOP_TABLES = [
  'oidc_states',
  'verifications',
  'restricted_products',
  'restricted_rules',
  'settings',
  'jobs',
  'audit_log',
  'webhook_events',
  'shops',
] as const;

/**
 * shop/redact: erase every row for the shop.
 * Skipped (and audited) if the shop is currently installed, i.e. it reinstalled after uninstalling.
 */
export async function handleShopRedact(db: D1Database, shop: string, now: number): Promise<void> {
  const installed = await db
    .prepare('SELECT 1 AS ok FROM shops WHERE shop = ?1 AND uninstalled_at IS NULL')
    .bind(shop)
    .first<{ ok: number }>();
  if (installed) {
    await writeAudit(db, shop, 'shop_redact_skipped', { reason: 'shop_installed' }, now);
    return;
  }
  await db.batch(SHOP_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE shop = ?1`).bind(shop)));
}
