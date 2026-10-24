import { describe, expect, it } from 'vitest';
import { activateEmbedUrl, appEmbedStatus, settingsHaveEnabledEmbed } from '../src/services/theme-status';
import { FakeShopify } from './fake-shopify';
import { API_KEY, SHOP } from './helpers';

const HEADER = `/*
 * ------------------------------------------------------------
 * IMPORTANT: The contents of this file are auto-generated.
 * ------------------------------------------------------------
 */
`;

const OUR_EMBED = 'shopify://apps/ageshield-staging/blocks/age_gate/0f9c3a1e-1111-4222-8333-944455556666';

function settings(blocks: Record<string, { type: string; disabled?: boolean }>): string {
  return HEADER + JSON.stringify({ current: { colors_accent_1: '#000', blocks } });
}

describe('age gate app embed detection', () => {
  it('finds the enabled embed in settings_data.json (with Shopify’s comment header)', () => {
    expect(settingsHaveEnabledEmbed(settings({ a: { type: OUR_EMBED, disabled: false } }), 'age_gate')).toBe(
      true,
    );
  });

  it('reports a disabled embed, a missing embed, another app’s embed and broken JSON as not enabled', () => {
    expect(settingsHaveEnabledEmbed(settings({ a: { type: OUR_EMBED, disabled: true } }), 'age_gate')).toBe(
      false,
    );
    expect(settingsHaveEnabledEmbed(settings({}), 'age_gate')).toBe(false);
    expect(
      settingsHaveEnabledEmbed(
        settings({ x: { type: 'shopify://apps/other/blocks/cookie_banner/abc', disabled: false } }),
        'age_gate',
      ),
    ).toBe(false);
    expect(settingsHaveEnabledEmbed('{ not json', 'age_gate')).toBe(false);
  });

  it('follows `current` when it names a preset', () => {
    const content = JSON.stringify({
      current: 'Default',
      presets: { Default: { blocks: { a: { type: OUR_EMBED, disabled: false } } } },
    });
    expect(settingsHaveEnabledEmbed(content, 'age_gate')).toBe(true);
  });

  it('builds the theme editor deep link with context=apps and a literal slash in activateAppId', () => {
    const url = activateEmbedUrl(SHOP, API_KEY, 'age_gate');
    expect(url).toBe(
      `https://admin.shopify.com/store/demo-store/themes/current/editor?context=apps&activateAppId=${API_KEY}/age_gate`,
    );
    expect(url).not.toContain('%2F');
  });

  it('reads the main theme’s settings_data.json through the Admin API', async () => {
    const shopify = new FakeShopify();
    shopify.settingsData = settings({ a: { type: OUR_EMBED, disabled: false } });
    expect(await appEmbedStatus(shopify.admin, SHOP, API_KEY)).toMatchObject({
      themeName: 'Dawn',
      enabled: true,
    });
    shopify.settingsData = null;
    expect(await appEmbedStatus(shopify.admin, SHOP, API_KEY)).toMatchObject({ enabled: false });
    expect(shopify.opCount('AgeShieldMainThemeSettings')).toBe(2);
  });
});
