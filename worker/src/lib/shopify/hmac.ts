// HMAC-SHA256 verification for webhooks (base64 over the raw body) and App Proxy requests (hex over sorted params).

async function hmacSha256(secret: string, data: BufferSource): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/** Constant-time comparison: always walks the full length of `expected`. */
export function timingSafeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verifies `X-Shopify-Hmac-Sha256` against the raw request body, keyed with the app's client secret. */
export async function verifyWebhookHmac(
  rawBody: ArrayBuffer,
  header: string | undefined | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const received = base64ToBytes(header.trim());
  if (!received) return false;
  return timingSafeEqual(received, await hmacSha256(secret, rawBody));
}

/**
 * App Proxy message: every query param except `signature`, multi-values joined with ",", each as `key=value`,
 * sorted, concatenated with no separator (shopify.dev "Authenticate app proxies").
 */
export function appProxyMessage(params: URLSearchParams): string {
  const values = new Map<string, string[]>();
  for (const [key, value] of params) {
    if (key === 'signature') continue;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return [...values.entries()]
    .map(([key, vals]) => `${key}=${vals.join(',')}`)
    .sort()
    .join('');
}

export async function appProxySignature(params: URLSearchParams, secret: string): Promise<string> {
  return bytesToHex(await hmacSha256(secret, new TextEncoder().encode(appProxyMessage(params))));
}

/** Max age (either direction) of an App Proxy `timestamp`, in seconds. */
export const APP_PROXY_MAX_SKEW_S = 5 * 60;

/** True if the proxy `timestamp` (unix seconds) is within ±5 minutes of `nowMs`. Limits replay of signed URLs. */
export function isFreshAppProxyTimestamp(params: URLSearchParams, nowMs: number): boolean {
  const raw = params.get('timestamp');
  if (!raw || !/^\d+$/.test(raw)) return false;
  return Math.abs(nowMs / 1000 - Number(raw)) <= APP_PROXY_MAX_SKEW_S;
}

/** Verifies the App Proxy `signature` (hex HMAC-SHA256 with the client secret). */
export async function verifyAppProxySignature(params: URLSearchParams, secret: string): Promise<boolean> {
  const received = params.get('signature');
  if (!received) return false;
  const expected = await appProxySignature(params, secret);
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(received.toLowerCase()), enc.encode(expected));
}
