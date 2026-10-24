import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { redactPath } from '../src/lib/redact';
import { SHOP, makeEnv } from './helpers';
import { signedQuery } from './signing';

describe('App Proxy signature check', () => {
  it('GET /proxy/ping with a valid signature → 200 JSON, no cookie, no redirect', async () => {
    const res = await app.request(`/proxy/ping?${await signedQuery()}`, {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('invalid signature → 401', async () => {
    const res = await app.request(`/proxy/ping?${await signedQuery({}, 'wrong-secret')}`, {}, makeEnv());
    expect(res.status).toBe(401);
  });

  it('tampered parameter → 401', async () => {
    const query = (await signedQuery()).replace('logged_in_customer_id=', 'logged_in_customer_id=42');
    const res = await app.request(`/proxy/ping?${query}`, {}, makeEnv());
    expect(res.status).toBe(401);
  });

  it('missing signature → 401', async () => {
    const res = await app.request(`/proxy/ping?shop=${SHOP}`, {}, makeEnv());
    expect(res.status).toBe(401);
  });

  describe('timestamp freshness (±5 minutes)', () => {
    const at = (offsetS: number) => ({ timestamp: String(Math.floor(Date.now() / 1000) + offsetS) });

    it('accepts a correctly signed request 4 minutes old or 4 minutes ahead', async () => {
      for (const offset of [-240, 240]) {
        const res = await app.request(`/proxy/ping?${await signedQuery(at(offset))}`, {}, makeEnv());
        expect(res.status, `offset ${offset}s`).toBe(200);
      }
    });

    it('rejects a correctly signed request older than 5 minutes (replay) → 401', async () => {
      const res = await app.request(`/proxy/ping?${await signedQuery(at(-330))}`, {}, makeEnv());
      expect(res.status).toBe(401);
    });

    it('rejects a correctly signed request more than 5 minutes in the future → 401', async () => {
      const res = await app.request(`/proxy/ping?${await signedQuery(at(330))}`, {}, makeEnv());
      expect(res.status).toBe(401);
    });

    it('rejects a correctly signed request without a usable timestamp → 401', async () => {
      for (const timestamp of ['', 'abc', '-5']) {
        const res = await app.request(`/proxy/ping?${await signedQuery({ timestamp })}`, {}, makeEnv());
        expect(res.status, `timestamp "${timestamp}"`).toBe(401);
      }
    });
  });

  it('signed but invalid shop → 400', async () => {
    const res = await app.request(`/proxy/ping?${await signedQuery({ shop: 'evil.com' })}`, {}, makeEnv());
    expect(res.status).toBe(400);
  });

  it('redactPath drops query strings and fragments', () => {
    expect(redactPath('/oidc/callback?code=abc&state=xyz')).toBe('/oidc/callback');
    expect(redactPath('/products/x#ageshield=token')).toBe('/products/x');
    expect(redactPath('/api/settings')).toBe('/api/settings');
  });
});
