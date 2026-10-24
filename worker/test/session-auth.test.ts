import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { makeEnv, signIdToken } from './helpers';

describe('/api session auth', () => {
  it('rejects a request without a bearer token with 401 + retry header', async () => {
    const res = await app.request('/api/me', {}, makeEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Shopify-Retry-Invalid-Session-Request')).toBe('1');
  });

  it('rejects a token with a bad signature with 401 + retry header', async () => {
    const token = await signIdToken({}, 'wrong-secret');
    const res = await app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } }, makeEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Shopify-Retry-Invalid-Session-Request')).toBe('1');
  });

  it('rejects an expired token with 401 + retry header', async () => {
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = await signIdToken({ exp: past, nbf: past - 60 });
    const res = await app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } }, makeEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Shopify-Retry-Invalid-Session-Request')).toBe('1');
  });
});
