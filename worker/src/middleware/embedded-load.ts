import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';
import { isValidShopDomain, storeHandle } from '../lib/shopify/shop';

// HTML route handling (ARCHITECTURE §3.2). Embedded loads always get index.html immediately — never redirect them.

const MARKETING_URL = 'https://merchantkits.com/ageshield/';
// /oidc/ is the Idura callback (a top-level browser redirect, never the embedded app).
const NON_HTML_PREFIXES = ['/api/', '/webhooks/', '/proxy/', '/oidc/'];
const STATIC_FILE_RE = /\/[^/]+\.[a-z0-9]+$/i;
const API_KEY_META_RE = /(<meta\s+name="shopify-api-key"\s+content=")[^"]*(")/;

/** Security headers for every HTML response. Never sets X-Frame-Options. `shop` must already be validated. */
export function htmlHeaders(shop: string | null): Headers {
  const ancestors = shop ? `https://${shop} https://admin.shopify.com` : 'https://admin.shopify.com';
  return new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `frame-ancestors ${ancestors};`,
    'Cache-Control': 'no-store',
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Sets the shopify-api-key meta to this environment's client ID, so one build serves staging and production. */
export function injectApiKey(html: string, apiKey: string): string {
  if (!API_KEY_META_RE.test(html)) throw new Error('index.html is missing the shopify-api-key meta tag');
  return html.replace(
    API_KEY_META_RE,
    (_m, start: string, end: string) => `${start}${escapeAttribute(apiKey)}${end}`,
  );
}

export const embeddedLoad = createMiddleware<AppBindings>(async (c, next) => {
  const url = new URL(c.req.url);
  const path = url.pathname;
  if (path === '/health' || path === '/api' || NON_HTML_PREFIXES.some((p) => path.startsWith(p)))
    return next();
  // The SPA and static files are read-only: never answer a write method with index.html.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
  }

  // Static files (JS, CSS, images) go straight to the asset store.
  if (STATIC_FILE_RE.test(path) && !path.endsWith('.html')) {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (!res.headers.get('content-type')?.includes('text/html')) return res;
    return new Response(res.body, { status: res.status, headers: htmlHeaders(null) });
  }

  const shop = url.searchParams.get('shop');
  if (shop !== null && !isValidShopDomain(shop)) return c.text('Invalid shop parameter', 400);

  if (url.searchParams.get('embedded') === '1' || url.searchParams.has('id_token')) {
    const asset = await c.env.ASSETS.fetch(new Request(new URL('/', url)));
    if (!asset.ok) return c.text('App shell unavailable', 503);
    const html = injectApiKey(await asset.text(), c.env.SHOPIFY_API_KEY);
    return new Response(c.req.method === 'HEAD' ? null : html, { status: 200, headers: htmlHeaders(shop) });
  }

  if (shop) {
    return c.redirect(
      `https://admin.shopify.com/store/${storeHandle(shop)}/apps/${c.env.SHOPIFY_APP_HANDLE}`,
      302,
    );
  }
  return c.redirect(MARKETING_URL, 302);
});
