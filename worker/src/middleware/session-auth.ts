import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';
import { getOfflineAccessToken, tokenManagerFromEnv } from '../lib/shopify/offline-token';
import { InvalidSessionTokenError, verifySessionToken } from '../lib/shopify/session-token';
import { InvalidSubjectTokenError } from '../lib/shopify/token-exchange';

// /api/* auth (ARCHITECTURE §3.3): verify the App Bridge ID token, then make sure an offline token exists.

/** 401 that tells App Bridge to fetch a fresh ID token and retry the request once. */
function retryableUnauthorized(c: Context<AppBindings>) {
  return c.json({ error: 'unauthorized' }, 401, { 'X-Shopify-Retry-Invalid-Session-Request': '1' });
}

export const sessionAuth = createMiddleware<AppBindings>(async (c, next) => {
  const match = /^Bearer\s+(\S+)$/.exec(c.req.header('Authorization') ?? '');
  const idToken = match?.[1];
  if (!idToken) return retryableUnauthorized(c);

  let shop: string;
  try {
    ({ shop } = await verifySessionToken(idToken, c.env.SHOPIFY_API_KEY, c.env.SHOPIFY_API_SECRET));
  } catch (err) {
    if (err instanceof InvalidSessionTokenError) return retryableUnauthorized(c);
    throw err;
  }

  try {
    await getOfflineAccessToken(tokenManagerFromEnv(c.env), shop, { idToken });
  } catch (err) {
    if (err instanceof InvalidSubjectTokenError) return retryableUnauthorized(c);
    throw err;
  }

  c.set('shop', shop);
  c.set('idToken', idToken);
  await next();
});
