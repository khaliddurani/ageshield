import type { Env } from '../env';
import { zoneOrUtc } from '../lib/time';
import { freePlanStatement } from './billing';
import { adminClientForShop, type AdminClient } from '../lib/shopify/admin';

export interface ShopProfile {
  shop: string;
  shopName: string;
  plan: string;
  scopes: string[];
  /** IANA time zone of the store; the admin UI shows dates in it. */
  timeZone: string;
}

interface ShopRow {
  shop_name: string | null;
  plan: string;
  scope: string | null;
  iana_timezone: string | null;
}

interface ShopDetails {
  name: string;
  ianaTimezone: string | null;
}

const SHOP_DETAILS_QUERY = `#graphql
  query ShopDetails { shop { name ianaTimezone } }
`;

/** Fetches the shop name and time zone from Shopify and caches them on the shops row. */
async function refreshShopDetails(db: D1Database, shop: string, admin: AdminClient): Promise<ShopDetails> {
  const { shop: details } = await admin.graphql<{ shop: ShopDetails }>(SHOP_DETAILS_QUERY);
  await db
    .prepare('UPDATE shops SET shop_name = ?1, iana_timezone = ?2 WHERE shop = ?3')
    .bind(details.name, details.ianaTimezone ?? null, shop)
    .run();
  return details;
}

/** Shop profile for the merchant UI. Fetches and caches shop details on first use. */
export async function getShopProfile(env: Env, shop: string, idToken: string): Promise<ShopProfile | null> {
  const row = await env.DB.prepare('SELECT shop_name, plan, scope, iana_timezone FROM shops WHERE shop = ?1')
    .bind(shop)
    .first<ShopRow>();
  if (!row) return null;

  let shopName = row.shop_name;
  let timeZone = row.iana_timezone;
  if (!shopName || !timeZone) {
    try {
      const details = await refreshShopDetails(env.DB, shop, adminClientForShop(env, shop, idToken));
      shopName = details.name;
      timeZone = details.ianaTimezone;
    } catch (err) {
      // The app waits for /me, so a failed backfill of an already known shop must not block it; retried next load.
      if (!shopName) throw err;
      console.warn(`Shop details refresh failed for ${shop}:`, err instanceof Error ? err.message : err);
    }
  }

  return {
    shop,
    shopName,
    plan: row.plan,
    scopes: parseScopes(row.scope),
    timeZone: zoneOrUtc(timeZone),
  };
}

export function parseScopes(scope: string | null): string[] {
  return scope
    ? scope
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * app/uninstalled: keep the row (settings, rules, anonymous verification counts) but drop tokens and mark it
 * uninstalled. Shopify cancels the app subscription on uninstall, so the shop goes back to Free. Everything is deleted
 * by shop/redact 48 hours later.
 */
export async function markShopUninstalled(db: D1Database, shop: string, now: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        // Shopify deletes the app-data config metafield on uninstall: forget its hash so a reinstall writes it again.
        `UPDATE shops SET uninstalled_at = ?1,
                access_token_enc = NULL, access_token_expires_at = NULL,
                refresh_token_enc = NULL, refresh_token_expires_at = NULL, refreshing_until = NULL,
                storefront_config_hash = NULL
          WHERE shop = ?2`,
      )
      .bind(now, shop),
    freePlanStatement(db, shop),
  ]);
}

/**
 * app/scopes_update: store the scopes the merchant has currently granted. When a scope was added, the stored access
 * token predates the approval, so it is expired: the next Admin API call refreshes it (refresh token kept) and gets
 * one issued with the new scopes.
 */
export async function updateShopScopes(db: D1Database, shop: string, scopes: string[]): Promise<void> {
  const row = await db
    .prepare('SELECT scope FROM shops WHERE shop = ?1')
    .bind(shop)
    .first<{ scope: string | null }>();
  const before = new Set(parseScopes(row?.scope ?? null));
  const added = scopes.some((s) => !before.has(s));
  await db
    .prepare(
      `UPDATE shops SET scope = ?1,
         access_token_expires_at = CASE WHEN ?3 = 1 AND access_token_enc IS NOT NULL THEN 0 ELSE access_token_expires_at END
       WHERE shop = ?2`,
    )
    .bind(scopes.join(','), shop, added ? 1 : 0)
    .run();
}
