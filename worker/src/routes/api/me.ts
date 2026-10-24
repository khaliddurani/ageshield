import { Hono } from 'hono';
import type { AppBindings } from '../../env';
import { adminClientForShop } from '../../lib/shopify/admin';
import { syncPlanIfStale } from '../../services/billing';
import { getShopProfile } from '../../services/shops';
import { appEmbedStatus } from '../../services/theme-status';

export const meRoutes = new Hono<AppBindings>()
  .get('/me', async (c) => {
    const profile = await getShopProfile(c.env, c.get('shop'), c.get('idToken'));
    if (!profile) return c.json({ error: 'shop_not_found' }, 404);
    // Keep shops.plan in sync with Shopify App Pricing (background; only when the last sync is > 5 min old).
    const sync = syncPlanIfStale(
      c.env.DB,
      adminClientForShop(c.env, c.get('shop'), c.get('idToken')),
      c.get('shop'),
      Date.now(),
    );
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
