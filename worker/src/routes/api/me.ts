import { Hono } from 'hono';
import type { AppBindings } from '../../env';
import { adminClientForShop } from '../../lib/shopify/admin';
import { syncPlanIfStale } from '../../services/billing';
import { getShopProfile } from '../../services/shops';
import { appEmbedStatus } from '../../services/theme-status';
import { syncStorefrontConfig } from '../../services/storefront-config';

export const meRoutes = new Hono<AppBindings>()
  .get('/me', async (c) => {
    const profile = await getShopProfile(c.env, c.get('shop'), c.get('idToken'));
    if (!profile) return c.json({ error: 'shop_not_found' }, 404);
    const shop = c.get('shop');
    const admin = adminClientForShop(c.env, shop, c.get('idToken'));
    // Background: keep shops.plan in sync with Shopify App Pricing (only when the last sync is > 5 min old), and
    // (re)publish the storefront config if it changed or was lost (reinstall).
    const sync = Promise.all([
      syncPlanIfStale(c.env.DB, admin, shop, Date.now()),
      syncStorefrontConfig(c.env, admin, shop).catch((err: unknown) => {
        console.error(
          `storefront config for ${shop} not published: ${err instanceof Error ? `${err.name}: ${err.message}` : 'error'}`,
        );
      }),
    ]);
    try {
      c.executionCtx.waitUntil(sync);
    } catch {
      await sync; // no execution context (tests)
    }
    return c.json(profile);
  })
  /** Is the Age gate app embed enabled in the live theme? (read_themes, ARCHITECTURE §7) */
  .get('/theme-status', async (c) => {
    const shop = c.get('shop');
    const admin = adminClientForShop(c.env, shop, c.get('idToken'));
    return c.json(await appEmbedStatus(admin, shop, c.env.SHOPIFY_API_KEY));
  });
