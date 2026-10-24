import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { app } from '../src/index';
import { encryptString } from '../src/lib/crypto';
import type { JobMessage } from '../src/queue/handlers';
import { addRules } from '../src/services/rules';
import { createTestD1, type TestD1 } from './d1';
import { FakeShopify } from './fake-shopify';
import { ENCRYPTION_KEY, SHOP, makeEnv, signIdToken } from './helpers';

// Admin API routes behind session auth: settings, rules, verifications, dashboard.

let shopify = new FakeShopify();
vi.mock('../src/lib/shopify/admin', async (original) => ({
  ...(await original<typeof import('../src/lib/shopify/admin')>()),
  adminClientForShop: () => shopify.admin,
}));

const NOW = Date.now();
let d1: TestD1;
let env: Env;
let queue: JobMessage[];

beforeEach(async () => {
  d1 = await createTestD1();
  shopify = new FakeShopify();
  queue = [];
  const jobs = { send: async (m: JobMessage) => void queue.push(m) };
  env = makeEnv({ DB: d1.db, JOBS: jobs as unknown as Queue<JobMessage> });
  for (const shop of [SHOP, 'other.myshopify.com']) {
    d1.raw.run(
      `INSERT INTO shops (shop, access_token_enc, access_token_expires_at, refresh_token_enc, refresh_token_expires_at,
                          scope, installed_at, shop_name, iana_timezone)
       VALUES (?, ?, ?, ?, ?, 'read_products', 1, 'Demo', 'Europe/Copenhagen')`,
      [
        shop,
        await encryptString('access', ENCRYPTION_KEY),
        NOW + 3_600_000,
        await encryptString('refresh', ENCRYPTION_KEY),
        NOW + 86_400_000,
      ],
    );
  }
});

async function api(method: string, path: string, body?: unknown) {
  const res = await app.request(
    `/api${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${await signIdToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const P = (n: number) => `gid://shopify/Product/${n}`;
const C = (n: number) => `gid://shopify/Collection/${n}`;
const settings = {
  enabledCountries: ['DK', 'SE'],
  defaultMinAge: 18,
  gateMode: 'cart',
  popupTexts: { da: { heading: 'Alderstjek', body: 'Kun 18+', button: 'Bekræft med' } },
  brandColor: '#0055aa',
};

describe('/api/settings', () => {
  it('GET returns the defaults before the first save', async () => {
    expect((await api('GET', '/settings')).body).toEqual({
      enabledCountries: ['DK', 'SE', 'NO', 'FI'],
      defaultMinAge: 18,
      gateMode: 'product_page',
      popupTexts: {},
      brandColor: null,
    });
  });

  it('PUT saves, publishes the storefront config at once, and GET reads it back', async () => {
    const res = await api('PUT', '/settings', settings);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settings, published: true, resynced: false });
    expect(
      JSON.parse(shopify.metafields.get('gid://shopify/AppInstallation/1|ageshield.config')?.value ?? ''),
    ).toMatchObject({
      countries: ['DK', 'SE'],
      gateMode: 'cart',
    });
    expect((await api('GET', '/settings')).body).toEqual(settings);
  });

  it('PUT rejects invalid input with 400', async () => {
    for (const bad of [
      { ...settings, enabledCountries: [] },
      { ...settings, enabledCountries: ['DE'] },
      { ...settings, defaultMinAge: 17 },
      { ...settings, gateMode: 'popup' },
      { ...settings, brandColor: 'red' },
      { ...settings, popupTexts: { 'not a locale': { heading: '', body: '', button: '' } } },
      { ...settings, popupTexts: { en: { heading: 'x'.repeat(121), body: '', button: '' } } },
    ]) {
      expect((await api('PUT', '/settings', bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
  });

  it('changing the default age re-syncs rules that use it', async () => {
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: null }], NOW);
    expect((await api('PUT', '/settings', { ...settings, defaultMinAge: 21 })).body['resynced']).toBe(true);
    expect(queue.map((m) => m.type)).toEqual(['rules/sync']);
  });

  it('still saves when Shopify is unreachable (published: false)', async () => {
    shopify.failures.set('AgeShieldAppInstallation', new Error('Shopify 503'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await api('PUT', '/settings', settings);
    spy.mockRestore();
    expect(res.body).toMatchObject({ published: false, settings });
  });
});

describe('/api/rules', () => {
  beforeEach(() => {
    shopify.handlers.set('AgeShieldRuleTitles', (v) => ({
      nodes: (v['ids'] as string[]).map((id) =>
        id === P(1) ? { id, title: 'Snus Original' } : id === C(1) ? { id, title: 'Nicotine' } : null,
      ),
    }));
  });

  it('POST adds rules, starts a sync and returns the list with titles', async () => {
    const res = await api('POST', '/rules', {
      rules: [
        { type: 'product', resourceGid: P(1), minAge: 18 },
        { type: 'collection', resourceGid: C(1), minAge: 21 },
        { type: 'tag', tag: 'vape', minAge: null },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body['added']).toBe(3);
    const rules = res.body['rules'] as { type: string; title: string | null; tag: string | null }[];
    expect(rules.map((r) => [r.type, r.title ?? r.tag])).toEqual([
      ['product', 'Snus Original'],
      ['collection', 'Nicotine'],
      ['tag', 'vape'],
    ]);
    expect(res.body['sync']).toMatchObject({ status: 'queued' });
    expect(queue).toHaveLength(1);
  });

  it('flags rules whose product or collection was deleted in Shopify', async () => {
    await api('POST', '/rules', { rules: [{ type: 'product', resourceGid: P(99), minAge: null }] });
    const { body } = await api('GET', '/rules');
    expect(body['rules']).toMatchObject([{ resourceGid: P(99), title: null, resourceDeleted: true }]);
  });

  it('duplicates add nothing and start no sync', async () => {
    await api('POST', '/rules', { rules: [{ type: 'tag', tag: 'Snus', minAge: null }] });
    queue = [];
    const res = await api('POST', '/rules', { rules: [{ type: 'tag', tag: 'snus', minAge: 21 }] });
    expect(res.body['added']).toBe(0);
    expect(queue).toEqual([]);
  });

  it('DELETE removes the shop’s own rule and re-syncs; other shops’ or unknown ids → 404', async () => {
    const [mine] = await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: null }], NOW);
    const [theirs] = await addRules(
      d1.db,
      'other.myshopify.com',
      [{ type: 'tag', tag: 'x', minAge: null }],
      NOW,
    );
    expect((await api('DELETE', `/rules/${theirs?.id}`)).status).toBe(404);
    expect((await api('DELETE', '/rules/not-a-uuid')).status).toBe(404);
    const res = await api('DELETE', `/rules/${mine?.id}`);
    expect(res.status).toBe(200);
    expect(res.body['rules']).toEqual([]);
    expect(queue).toHaveLength(1);
    expect(d1.query('SELECT shop FROM restricted_rules')).toEqual([{ shop: 'other.myshopify.com' }]);
  });

  it('rejects invalid rules with 400', async () => {
    for (const rules of [
      [],
      [{ type: 'product', resourceGid: 'gid://shopify/Order/1', minAge: 18 }],
      [{ type: 'tag', tag: 'a,b', minAge: null }],
    ]) {
      expect((await api('POST', '/rules', { rules })).status).toBe(400);
    }
  });

  it('GET /rules/status reads progress without calling Shopify', async () => {
    await api('POST', '/rules', { rules: [{ type: 'tag', tag: 'snus', minAge: null }] });
    const calls = shopify.calls.length;
    expect((await api('GET', '/rules/status')).body).toMatchObject({
      restrictedProducts: 0,
      sync: { status: 'queued' },
    });
    expect(shopify.calls.length).toBe(calls);
  });
});

describe('/api/verifications and /api/dashboard', () => {
  function seedVerification(id: string, createdAt: number, result: string, shop = SHOP) {
    d1.raw.run(
      `INSERT INTO verifications (id, shop, country, min_age, result, error_code, audit_id, created_at)
       VALUES (?, ?, 'DK', 18, ?, ?, 'alu_x', ?)`,
      [id, shop, result, result === 'error' ? 'assurance_level' : null, createdAt],
    );
  }
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('lists newest first with keyset pagination, only the fields the page shows', async () => {
    for (let n = 1; n <= 5; n++) seedVerification(uuid(n), NOW - n * 1000, n % 2 ? 'verified' : 'rejected');
    seedVerification(uuid(9), NOW, 'verified', 'other.myshopify.com');
    const first = await api('GET', '/verifications?limit=2');
    expect((first.body['items'] as { id: string }[]).map((i) => i.id)).toEqual([uuid(1), uuid(2)]);
    expect(Object.keys((first.body['items'] as object[])[0] ?? {}).sort()).toEqual([
      'country',
      'createdAt',
      'errorCode',
      'id',
      'minAge',
      'result',
    ]);
    const second = await api('GET', `/verifications?limit=2&cursor=${String(first.body['nextCursor'])}`);
    expect((second.body['items'] as { id: string }[]).map((i) => i.id)).toEqual([uuid(3), uuid(4)]);
    const last = await api('GET', `/verifications?limit=2&cursor=${String(second.body['nextCursor'])}`);
    expect((last.body['items'] as { id: string }[]).map((i) => i.id)).toEqual([uuid(5)]);
    expect(last.body['nextCursor']).toBeNull();
    const rejected = await api('GET', '/verifications?result=rejected');
    expect((rejected.body['items'] as { result: string }[]).every((i) => i.result === 'rejected')).toBe(true);
    expect((await api('GET', '/verifications?cursor=bad')).status).toBe(400);
  });

  it('dashboard: 30-day counts per result and setup progress', async () => {
    expect((await api('GET', '/dashboard')).body).toEqual({
      last30Days: { verified: 0, rejected: 0, cancelled: 0, error: 0 },
      setup: { settingsSaved: false, rulesAdded: false, verificationDone: false },
      restrictedProducts: 0,
    });
    seedVerification(uuid(1), NOW - 1000, 'verified');
    seedVerification(uuid(2), NOW - 2000, 'error');
    seedVerification(uuid(3), NOW - 31 * 86_400_000, 'rejected'); // older than 30 days
    await api('PUT', '/settings', settings);
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: null }], NOW);
    expect((await api('GET', '/dashboard')).body).toMatchObject({
      last30Days: { verified: 1, rejected: 0, cancelled: 0, error: 1 },
      setup: { settingsSaved: true, rulesAdded: true, verificationDone: true },
    });
  });
});
