import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { API_KEY, SHOP, makeEnv } from './helpers';

const request = (path: string) => app.request(path, {}, makeEnv());

describe('embedded load routing', () => {
  it('serves index.html immediately for embedded=1 (no redirect)', async () => {
    const res = await request(`/?embedded=1&shop=${SHOP}&host=abc&id_token=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root">');
  });

  it('serves index.html when only id_token is present', async () => {
    const res = await request(`/?shop=${SHOP}&id_token=x`);
    expect(res.status).toBe(200);
  });

  it('serves SPA deep links for embedded loads', async () => {
    const res = await request(`/verifications?embedded=1&shop=${SHOP}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });

  it('injects the environment client ID into the shopify-api-key meta', async () => {
    const html = await (await request(`/?embedded=1&shop=${SHOP}`)).text();
    expect(html).toContain(`<meta name="shopify-api-key" content="${API_KEY}" />`);
    expect(html).not.toContain('%VITE_SHOPIFY_API_KEY%');
  });

  it('redirects a non-embedded load with a valid shop into Shopify admin', async () => {
    const res = await request(`/?shop=${SHOP}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://admin.shopify.com/store/demo-store/apps/ageshield-staging',
    );
  });

  it('rejects an invalid shop with 400, even when embedded', async () => {
    for (const shop of [
      'evil.com',
      'x.myshopify.com.evil.com',
      '-bad.myshopify.com',
      'UPPER.myshopify.com',
    ]) {
      const res = await request(`/?embedded=1&shop=${encodeURIComponent(shop)}`);
      expect(res.status, shop).toBe(400);
    }
  });

  it('redirects a bare visit to the marketing page', async () => {
    const res = await request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://merchantkits.com/ageshield/');
  });

  it('passes static assets through untouched', async () => {
    const res = await request('/assets/index-abc.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
  });

  it('never answers the OIDC callback path with the SPA shell', async () => {
    const res = await request(`/oidc/unknown?shop=${SHOP}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });
});

describe('HTML security headers', () => {
  it('sends per-shop frame-ancestors CSP and never X-Frame-Options', async () => {
    const res = await request(`/?embedded=1&shop=${SHOP}`);
    expect(res.headers.get('content-security-policy')).toBe(
      `frame-ancestors https://${SHOP} https://admin.shopify.com;`,
    );
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('falls back to admin.shopify.com only when no shop is given', async () => {
    const res = await request('/?embedded=1');
    expect(res.headers.get('content-security-policy')).toBe('frame-ancestors https://admin.shopify.com;');
    expect(res.headers.get('x-frame-options')).toBeNull();
  });
});
