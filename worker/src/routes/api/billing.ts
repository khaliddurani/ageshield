import { Hono } from 'hono';
import type { AppBindings } from '../../env';
import { adminClientForShop } from '../../lib/shopify/admin';
import { syncPlan } from '../../services/billing';
import { billingSummary } from '../../services/billing-summary';

// /api/billing — Plans page (ARCHITECTURE §8, Shopify App Pricing).

export const billingRoutes = new Hono<AppBindings>()
  .get('/billing', async (c) => c.json(await billingSummary(c.env, c.get('shop'), Date.now())))
  /**
   * Re-read the plan from Shopify now (the Plans page calls this when Shopify sends the merchant back with
   * ?plan_handle=…; the parameter itself is never trusted). If Shopify can't be reached the stored plan is kept.
   */
  .post('/billing/sync', async (c) => {
    const shop = c.get('shop');
    const now = Date.now();
    let synced = true;
    try {
      await syncPlan(c.env.DB, adminClientForShop(c.env, shop, c.get('idToken')), shop, now);
    } catch (err) {
      synced = false;
      console.error(
        `plan sync ${shop} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown'}`,
      );
    }
    return c.json({ ...(await billingSummary(c.env, shop, now)), synced });
  });
