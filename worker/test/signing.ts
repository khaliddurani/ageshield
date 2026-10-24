import { appProxySignature } from '../src/lib/shopify/hmac';
import { API_SECRET, SHOP } from './helpers';

/** Query string Shopify's App Proxy adds to a forwarded request, signed with `secret`. */
export async function signedQuery(extra: Record<string, string> = {}, secret = API_SECRET): Promise<string> {
  const params = new URLSearchParams({
    shop: SHOP,
    logged_in_customer_id: '',
    path_prefix: '/apps/ageshield-staging',
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extra,
  });
  params.set('signature', await appProxySignature(params, secret));
  return params.toString();
}

async function hmac(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

/** X-Shopify-Hmac-Sha256 value for a webhook body. */
export async function webhookHmac(body: string, secret = API_SECRET): Promise<string> {
  return btoa(String.fromCharCode(...(await hmac(body, secret))));
}

export async function hexHmac(message: string, secret = API_SECRET): Promise<string> {
  return Array.from(await hmac(message, secret), (b) => b.toString(16).padStart(2, '0')).join('');
}
