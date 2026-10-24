import { describe, expect, it } from 'vitest';
import {
  appProxyMessage,
  appProxySignature,
  isFreshAppProxyTimestamp,
  timingSafeEqual,
  verifyAppProxySignature,
  verifyWebhookHmac,
} from '../src/lib/shopify/hmac';
import { API_SECRET } from './helpers';
import { webhookHmac } from './signing';

const body = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('webhook HMAC', () => {
  it('accepts a valid signature over the raw body', async () => {
    const raw = '{"id":1}';
    expect(await verifyWebhookHmac(body(raw), await webhookHmac(raw), API_SECRET)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const header = await webhookHmac('{"id":1}');
    expect(await verifyWebhookHmac(body('{"id":2}'), header, API_SECRET)).toBe(false);
  });

  it('rejects a signature made with another secret', async () => {
    const raw = '{"id":1}';
    expect(await verifyWebhookHmac(body(raw), await webhookHmac(raw, 'other'), API_SECRET)).toBe(false);
  });

  it('rejects missing or malformed headers', async () => {
    expect(await verifyWebhookHmac(body('{}'), undefined, API_SECRET)).toBe(false);
    expect(await verifyWebhookHmac(body('{}'), '%%%not base64%%%', API_SECRET)).toBe(false);
  });
});

describe('App Proxy signature', () => {
  // Example from shopify.dev "Authenticate app proxies" (shared secret "hush").
  const docsQuery =
    'extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555';

  it('builds the sorted message with multi-values joined by commas', () => {
    expect(appProxyMessage(new URLSearchParams(`${docsQuery}&signature=abc`))).toBe(
      'extra=1,2logged_in_customer_id=1path_prefix=/apps/awesome_reviewsshop=shop-name.myshopify.comtimestamp=1317327555',
    );
  });

  it('reproduces the signature from the shopify.dev example', async () => {
    const params = new URLSearchParams(docsQuery);
    expect(await appProxySignature(params, 'hush')).toBe(
      '4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb',
    );
    params.set('signature', '4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb');
    expect(await verifyAppProxySignature(params, 'hush')).toBe(true);
  });

  it('accepts a valid signature and rejects tampering', async () => {
    const params = new URLSearchParams(docsQuery);
    params.set('signature', await appProxySignature(params, API_SECRET));
    expect(await verifyAppProxySignature(params, API_SECRET)).toBe(true);

    params.set('logged_in_customer_id', '2');
    expect(await verifyAppProxySignature(params, API_SECRET)).toBe(false);
  });

  it('rejects a missing signature', async () => {
    expect(await verifyAppProxySignature(new URLSearchParams(docsQuery), API_SECRET)).toBe(false);
  });
});

describe('isFreshAppProxyTimestamp', () => {
  const NOW_MS = 1_800_000_000_000;
  const check = (ts: string | null) =>
    isFreshAppProxyTimestamp(new URLSearchParams(ts === null ? {} : { timestamp: ts }), NOW_MS);

  it('accepts up to exactly 5 minutes either way', () => {
    expect(check('1800000000')).toBe(true);
    expect(check('1799999700')).toBe(true);
    expect(check('1800000300')).toBe(true);
  });

  it('rejects anything beyond 5 minutes, missing or non-numeric', () => {
    expect(check('1799999699')).toBe(false);
    expect(check('1800000301')).toBe(false);
    expect(check(null)).toBe(false);
    expect(check('1.8e9')).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares contents and lengths', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });
});
