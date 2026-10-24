import type { Env } from '../env';
import { assertNoUserErrors, type AdminClient } from '../lib/shopify/admin';
import { getSettings, type Settings } from './settings';

// Storefront config (ARCHITECTURE §7): what the Age gate app embed needs (enabled countries, texts, brand colour, gate
// mode, App Proxy path), published as an app-data metafield on the app installation. Liquid reads it as
// app.metafields.ageshield.config, so storefront page views never call the Worker. No scope is needed to write
// app-data metafields, and Shopify deletes them on uninstall.
//
// Type multi_line_text_field holding JSON (json-type app metafields are unreliable in Liquid): the embed prints the
// string verbatim inside <script type="application/json">, so `<`, `>`, `&` and U+2028/9 are \u-escaped here and
// merchant text can never close the tag.
//
// Written when settings are saved and on app load when the stored hash differs (self-healing after a reinstall).

export const CONFIG_NAMESPACE = 'ageshield';
export const CONFIG_KEY = 'config';
export const CONFIG_VERSION = 1;

export interface StorefrontConfig {
  v: number;
  /** "/apps/{subpath}" on the store domain. */
  proxyPath: string;
  countries: Settings['enabledCountries'];
  defaultMinAge: Settings['defaultMinAge'];
  gateMode: Settings['gateMode'];
  texts: Settings['popupTexts'];
  brandColor: Settings['brandColor'];
}

export function buildStorefrontConfig(
  env: Pick<Env, 'APP_PROXY_SUBPATH'>,
  settings: Settings,
): StorefrontConfig {
  return {
    v: CONFIG_VERSION,
    proxyPath: `/apps/${env.APP_PROXY_SUBPATH}`,
    countries: settings.enabledCountries,
    defaultMinAge: settings.defaultMinAge,
    gateMode: settings.gateMode,
    texts: settings.popupTexts,
    brandColor: settings.brandColor,
  };
}

// U+2028/U+2029 end a line in JavaScript source, so they are built from code points, not written literally.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

/** JSON that is safe to print verbatim inside a <script> element. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const APP_INSTALLATION_QUERY = `#graphql
  query AgeShieldAppInstallation { currentAppInstallation { id } }
`;

const CONFIG_SET_MUTATION = `#graphql
  mutation AgeShieldConfigSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
  }
`;

/**
 * Writes the shop's storefront config to the app-data metafield unless the same config was written last time
 * (`force` skips that check). Returns whether it wrote.
 */
export async function syncStorefrontConfig(
  env: Pick<Env, 'DB' | 'APP_PROXY_SUBPATH'>,
  admin: AdminClient,
  shop: string,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const value = scriptSafeJson(buildStorefrontConfig(env, await getSettings(env.DB, shop)));
  const hash = await sha256Hex(value);
  if (!opts.force) {
    const row = await env.DB.prepare('SELECT storefront_config_hash FROM shops WHERE shop = ?1')
      .bind(shop)
      .first<{ storefront_config_hash: string | null }>();
    if (row?.storefront_config_hash === hash) return false;
  }
  const { currentAppInstallation } = await admin.graphql<{ currentAppInstallation: { id: string } }>(
    APP_INSTALLATION_QUERY,
  );
  const data = await admin.graphql<{ metafieldsSet: { userErrors: { message: string }[] } }>(
    CONFIG_SET_MUTATION,
    {
      metafields: [
        {
          ownerId: currentAppInstallation.id,
          namespace: CONFIG_NAMESPACE,
          key: CONFIG_KEY,
          type: 'multi_line_text_field',
          value,
        },
      ],
    },
  );
  assertNoUserErrors(data.metafieldsSet, 'metafieldsSet');
  await env.DB.prepare('UPDATE shops SET storefront_config_hash = ?2 WHERE shop = ?1').bind(shop, hash).run();
  return true;
}
