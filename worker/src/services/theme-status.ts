import type { AdminClient } from '../lib/shopify/admin';
import { storeHandle } from '../lib/shopify/shop';

// App embed status for the Dashboard (ARCHITECTURE §7): is the Age gate app embed enabled in the live theme? Needs
// read_themes. App embeds appear in config/settings_data.json under current.blocks as
// { "type": "shopify://apps/{app}/blocks/{block_handle}/{extension_uid}", "disabled": false }. The entry only exists
// after the merchant enabled the embed once; disabling it later keeps the entry with disabled: true (shopify.dev,
// "Theme app extension configuration").

/** Handle of the app embed block: extensions/age-gate/blocks/age_gate.liquid. */
export const AGE_GATE_EMBED = 'age_gate';

const MAIN_THEME_SETTINGS_QUERY = `#graphql
  query AgeShieldMainThemeSettings {
    themes(roles: [MAIN], first: 1) {
      nodes {
        id
        name
        files(filenames: ["config/settings_data.json"], first: 1) {
          nodes {
            filename
            body { ... on OnlineStoreThemeFileBodyText { content } }
          }
        }
      }
    }
  }
`;

export interface AppEmbedStatus {
  themeName: string | null;
  enabled: boolean;
  /** Theme editor deep link that opens App embeds with the Age gate switched on (merchant still saves). */
  activateUrl: string;
}

/** settings_data.json may start with a /* … *\/ comment that Shopify adds; strip it before parsing. */
export function parseSettingsJson(content: string): unknown {
  return JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
}

type Blocks = Record<string, { type?: unknown; disabled?: unknown }>;

/** True if settings_data.json has the app embed and it is not disabled. */
export function settingsHaveEnabledEmbed(content: string, blockHandle: string): boolean {
  let data: { current?: unknown; presets?: Record<string, { blocks?: Blocks }> };
  try {
    data = parseSettingsJson(content) as typeof data;
  } catch {
    return false;
  }
  // `current` is usually an object; some themes store the name of a preset instead.
  const current =
    typeof data.current === 'string'
      ? data.presets?.[data.current]
      : (data.current as { blocks?: Blocks } | undefined);
  const typeRe = new RegExp(`^shopify://apps/[^/]+/blocks/${blockHandle}/[^/]+$`);
  return Object.values(current?.blocks ?? {}).some(
    (b) => typeof b.type === 'string' && typeRe.test(b.type) && b.disabled !== true,
  );
}

/**
 * Theme editor deep link that activates the app embed: context=apps&activateAppId={api_key}/{handle} (shopify.dev).
 * Points straight at admin.shopify.com with a literal slash, like RecallKit's addAppBlockId link (the {shop}/admin form
 * redirected and dropped the query). Opened in the top frame.
 */
export function activateEmbedUrl(shop: string, apiKey: string, blockHandle: string): string {
  const query = [
    'context=apps',
    `activateAppId=${encodeURIComponent(apiKey)}/${encodeURIComponent(blockHandle)}`,
  ].join('&');
  return `https://admin.shopify.com/store/${storeHandle(shop)}/themes/current/editor?${query}`;
}

interface ThemesResponse {
  themes: {
    nodes: {
      name: string;
      files: { nodes: { filename: string; body: { content?: string } | null }[] };
    }[];
  };
}

export async function appEmbedStatus(
  admin: AdminClient,
  shop: string,
  apiKey: string,
): Promise<AppEmbedStatus> {
  const data = await admin.graphql<ThemesResponse>(MAIN_THEME_SETTINGS_QUERY);
  const theme = data.themes.nodes[0];
  const content = theme?.files.nodes[0]?.body?.content ?? null;
  return {
    themeName: theme?.name ?? null,
    enabled: content !== null && settingsHaveEnabledEmbed(content, AGE_GATE_EMBED),
    activateUrl: activateEmbedUrl(shop, apiKey, AGE_GATE_EMBED),
  };
}
