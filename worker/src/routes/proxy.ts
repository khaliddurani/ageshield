import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { isFreshAppProxyTimestamp, verifyAppProxySignature } from '../lib/shopify/hmac';
import { isValidShopDomain } from '../lib/shopify/shop';
import { IduraError } from '../lib/idura';
import { clientIp } from '../services/rate-limit';
import { startRequestSchema, startVerification, VerificationError } from '../services/verification';

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

/**
 * POST /apps/{subpath}/verify/start {country, minAge, returnPath} → {authorizeUrl}. The storefront JS navigates to it;
 * the proxy itself never redirects (Shopify would follow the redirect server-side).
 */
proxyRoutes.post('/verify/start', async (c) => {
  const noStore = { 'Cache-Control': 'no-store' };
  const parsed = startRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400, noStore);
  try {
    const result = await startVerification(
      c.env,
      c.get('shop'),
      parsed.data,
      clientIp(c.req.raw.headers),
      Date.now(),
    );
    return c.json(result, 200, noStore);
  } catch (err) {
    if (err instanceof VerificationError) {
      const headers = err.retryAfterS ? { ...noStore, 'Retry-After': String(err.retryAfterS) } : noStore;
      return c.json({ error: err.code }, err.status, headers);
    }
    if (err instanceof IduraError) {
      console.error(`verify/start for ${c.get('shop')}: ${err.code}`);
      return c.json({ error: 'idp_unavailable' }, 503, noStore);
    }
    throw err;
  }
});
