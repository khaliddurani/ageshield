import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { isFreshAppProxyTimestamp, verifyAppProxySignature } from '../lib/shopify/hmac';
import { isValidShopDomain } from '../lib/shopify/shop';

// App Proxy (ARCHITECTURE §6): {store}/apps/{subpath}/* → /proxy/*. Every request must carry a valid `signature`
// and a fresh timestamp. Shopify forwards GET and POST (with body) and adds the signed query parameters to both.
// Shopify follows redirects itself and strips Set-Cookie: proxy routes answer with JSON only — never a redirect,
// never a cookie. The body is not signed, so it is validated like any untrusted input.

export const proxyRoutes = new Hono<AppBindings>();

proxyRoutes.use('*', async (c, next) => {
  const params = new URL(c.req.url).searchParams;
  if (!(await verifyAppProxySignature(params, c.env.SHOPIFY_API_SECRET))) return c.text('Unauthorized', 401);
  if (!isFreshAppProxyTimestamp(params, Date.now())) return c.text('Unauthorized', 401);
  const shop = params.get('shop');
  if (!shop || !isValidShopDomain(shop)) return c.text('Bad request', 400);
  c.set('shop', shop);
  await next();
});

proxyRoutes.get('/ping', (c) => c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' }));
