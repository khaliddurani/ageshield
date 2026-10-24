import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOMAINS_TTL_MS,
  MISS_REFRESH_MIN_MS,
  normalizeHost,
  returnHostFor,
} from '../src/services/shop-domains';
import { createTestD1, type TestD1 } from './d1';
import { FakeShopify } from './fake-shopify';
import { SHOP, seedShop } from './helpers';

const NOW = 1_800_000_000_000;
let d1: TestD1;
let shopify: FakeShopify;
const lookup = (host: string | null | undefined, now = NOW) =>
  returnHostFor(d1.db, () => shopify.admin, SHOP, host, now);
const fetches = () => shopify.opCount('AgeShieldStorefrontDomains');

beforeEach(async () => {
  d1 = await createTestD1();
  seedShop(d1.raw);
  shopify = new FakeShopify();
});

describe('return host: only the shop’s own domains', () => {
  it('allows the primary domain, every market domain and the myshopify domain', async () => {
    for (const host of ['snusbutik.dk', 'snusbutik.se', 'snusbutik.no', SHOP]) {
      expect(await lookup(host), host).toBe(host);
    }
    expect(await lookup('SnusButik.SE')).toBe('snusbutik.se'); // case-insensitive
  });

  it('a foreign host falls back to the primary domain', async () => {
    for (const host of ['evil.com', 'snusbutik.fi', 'google.com']) {
      expect(await lookup(host), host).toBe('snusbutik.dk');
    }
  });

  it('look-alike hosts are not the shop’s domains', async () => {
    for (const host of [
      'snusbutik.dk.evil.com', // suffix trick
      'evil-snusbutik.dk', // prefix trick
      'snusbutik.dk.', // trailing dot
      'snusbutik.dk:443', // port
      'user@snusbutik.dk', // userinfo
      'xn--snusbutk-o2a.dk', // punycode look-alike
      'snusbutik.dk/evil.com',
      'snusbutik.dk\\@evil.com',
      ' snusbutik.dk.evil.com',
      'demo-store.myshopify.com.evil.com',
      'other-store.myshopify.com', // another shop's myshopify domain
    ]) {
      expect(await lookup(host), host).toBe('snusbutik.dk');
    }
  });

  it('no host sent → primary domain', async () => {
    expect(await lookup(undefined)).toBe('snusbutik.dk');
    expect(await lookup('')).toBe('snusbutik.dk');
  });

  it('normalizeHost accepts plain host names only', () => {
    expect(normalizeHost('Shop.Example.DK')).toBe('shop.example.dk');
    for (const bad of ['', 'localhost', 'a..b.dk', '-a.dk', 'a.dk:1', 'a.dk.', 'https://a.dk', 'a b.dk']) {
      expect(normalizeHost(bad), bad).toBeNull();
    }
  });
});

describe('domain cache', () => {
  it('caches for an hour, then refreshes', async () => {
    await lookup('snusbutik.se');
    await lookup('snusbutik.no', NOW + DOMAINS_TTL_MS - 1);
    expect(fetches()).toBe(1);
    await lookup('snusbutik.no', NOW + DOMAINS_TTL_MS);
    expect(fetches()).toBe(2);
  });

  it('a cache miss re-reads (a market domain added since), at most once a minute', async () => {
    await lookup('snusbutik.se');
    shopify.webPresences.push('snusbutik.fi');
    expect(await lookup('snusbutik.fi', NOW + 1000)).toBe('snusbutik.dk'); // within a minute: no refetch
    expect(fetches()).toBe(1);
    expect(await lookup('snusbutik.fi', NOW + MISS_REFRESH_MIN_MS)).toBe('snusbutik.fi');
    expect(fetches()).toBe(2);
    // Made-up hosts can't force more API calls than one a minute.
    for (let i = 0; i < 10; i++) await lookup(`made-up-${i}.dk`, NOW + MISS_REFRESH_MIN_MS + i);
    expect(fetches()).toBe(2);
  });

  it('the myshopify domain needs no lookup', async () => {
    expect(await lookup(SHOP)).toBe(SHOP);
    expect(shopify.calls).toEqual([]);
  });

  it('pages through many web presences', async () => {
    shopify.pageSize = 2;
    shopify.webPresences = ['a.dk', 'b.se', null, 'c.no', 'd.fi'];
    expect(await lookup('d.fi')).toBe('d.fi');
    expect(fetches()).toBe(3);
  });

  it('without read_markets only the primary domain is known', async () => {
    shopify.readMarkets = false;
    expect(await lookup('snusbutik.dk')).toBe('snusbutik.dk');
    expect(await lookup('snusbutik.se', NOW + MISS_REFRESH_MIN_MS)).toBe('snusbutik.dk');
  });

  it('Shopify unreachable: the stale cache or the myshopify domain is used, never the requested host', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    shopify.failures.set('AgeShieldStorefrontDomains', new Error('Shopify 503'));
    expect(await lookup('snusbutik.se')).toBe(SHOP); // nothing cached yet
    shopify.failures.clear();
    await lookup('snusbutik.se', NOW + 1);
    shopify.failures.set('AgeShieldStorefrontDomains', new Error('Shopify 503'));
    expect(await lookup('snusbutik.se', NOW + DOMAINS_TTL_MS + 1)).toBe('snusbutik.se'); // stale cache still used
    expect(await lookup('evil.com', NOW + DOMAINS_TTL_MS + 2)).toBe('snusbutik.dk');
    spy.mockRestore();
  });
});
