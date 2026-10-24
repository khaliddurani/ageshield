import { beforeEach, describe, expect, it } from 'vitest';
import { runJob } from '../src/queue/handlers';
import { DEFAULT_SETTINGS, saveSettings } from '../src/services/settings';
import { syncStorefrontConfig } from '../src/services/storefront-config';
import { createTestD1, type TestD1 } from './d1';
import { FakeShopify } from './fake-shopify';
import { SHOP, makeEnv, seedShop } from './helpers';

const KEY = 'gid://shopify/AppInstallation/1|ageshield.config';
let d1: TestD1;
let shopify: FakeShopify;
const env = () => makeEnv({ DB: d1.db });

beforeEach(async () => {
  d1 = await createTestD1();
  seedShop(d1.raw);
  shopify = new FakeShopify();
});

describe('storefront config app-data metafield', () => {
  it('publishes the settings on the app installation as script-safe JSON text', async () => {
    expect(await syncStorefrontConfig(env(), shopify.admin, SHOP)).toBe(true);
    const mf = shopify.metafields.get(KEY);
    expect(mf?.type).toBe('multi_line_text_field');
    expect(JSON.parse(mf?.value ?? '')).toEqual({
      v: 1,
      proxyPath: '/apps/ageshield-staging',
      countries: ['DK', 'SE', 'NO', 'FI'],
      defaultMinAge: 18,
      gateMode: 'product_page',
      texts: {},
      brandColor: null,
    });
  });

  it('skips the write when nothing changed; writes again after a settings change', async () => {
    await syncStorefrontConfig(env(), shopify.admin, SHOP);
    expect(await syncStorefrontConfig(env(), shopify.admin, SHOP)).toBe(false);
    await saveSettings(
      d1.db,
      SHOP,
      { ...DEFAULT_SETTINGS, enabledCountries: ['DK'], brandColor: '#0055aa' },
      1,
    );
    expect(await syncStorefrontConfig(env(), shopify.admin, SHOP)).toBe(true);
    expect(JSON.parse(shopify.metafields.get(KEY)?.value ?? '')).toMatchObject({
      countries: ['DK'],
      brandColor: '#0055aa',
    });
    expect(shopify.opCount('AgeShieldConfigSet')).toBe(2);
  });

  it('uninstall forgets the hash (Shopify deletes app-data metafields), so a reinstall publishes again', async () => {
    await syncStorefrontConfig(env(), shopify.admin, SHOP);
    await runJob({ type: 'app/uninstalled', shop: SHOP, payload: {} }, env(), { now: () => 5 });
    expect(await syncStorefrontConfig(env(), shopify.admin, SHOP)).toBe(true);
  });
});
