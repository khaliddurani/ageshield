import { Hono } from 'hono';
import type { AppBindings } from '../../env';
import { adminClientForShop } from '../../lib/shopify/admin';
import { listRules, startRulesSync } from '../../services/rules';
import { getSettings, saveSettings, settingsSchema } from '../../services/settings';
import { syncStorefrontConfig } from '../../services/storefront-config';

// /api/settings — Settings page. Saving re-publishes the storefront config (app-data metafield) right away and, when
// the default minimum age changed, re-syncs the product metafields of rules that use it.

export const settingsRoutes = new Hono<AppBindings>()
  .get('/settings', async (c) => c.json(await getSettings(c.env.DB, c.get('shop'))))
  .put('/settings', async (c) => {
    const shop = c.get('shop');
    const settings = settingsSchema.parse(await c.req.json());
    const now = Date.now();
    const { defaultMinAgeChanged } = await saveSettings(c.env.DB, shop, settings, now);
    let resynced = false;
    if (defaultMinAgeChanged && (await listRules(c.env.DB, shop)).some((r) => r.minAge === null)) {
      await startRulesSync(c.env, shop, now);
      resynced = true;
    }
    // The settings are saved either way; if Shopify can't be reached the next app load publishes them.
    let published = true;
    try {
      await syncStorefrontConfig(c.env, adminClientForShop(c.env, shop, c.get('idToken')), shop);
    } catch (err) {
      published = false;
      console.error(
        `storefront config for ${shop} not published: ${err instanceof Error ? `${err.name}: ${err.message}` : 'error'}`,
      );
    }
    return c.json({ settings: await getSettings(c.env.DB, shop), published, resynced });
  });
