import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { encryptString } from '../src/lib/crypto';
import type { AdminClient } from '../src/lib/shopify/admin';
import { runJob, type JobMessage } from '../src/queue/handlers';
import {
  SYNC_MAX_AGE_MS,
  activePlan,
  monthStart,
  queuePlanSyncs,
  syncPlan,
  syncPlanIfStale,
  type SubscriptionInfo,
} from '../src/services/billing';
import { PLAN_LIMITS, PLANS, planForHandle, requiredPlans, upgradeWith } from '../src/services/plans';
import { markShopUninstalled } from '../src/services/shops';
import { createTestD1, type TestD1 } from './d1';
import { ENCRYPTION_KEY, SHOP, makeEnv, signIdToken } from './helpers';

// Billing (Shopify App Pricing via the Admin API). Subscription payloads below are what RecallKit staging returned on
// 2026-10-11 (choose Starter → downgrade to Free → Starter again → uninstall/reinstall).

const NOW = Date.parse('2026-10-11T12:00:00Z');

// The API routes get the shop's Admin client from adminClientForShop; the route tests swap it for a fake.
let routeAdmin: AdminClient | null = null;
vi.mock('../src/lib/shopify/admin', async (original) => ({
  ...(await original<typeof import('../src/lib/shopify/admin')>()),
  adminClientForShop: () => routeAdmin,
}));

const sub = (o: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  id: 'gid://shopify/AppSubscription/28292612162',
  name: 'Starter',
  status: 'ACTIVE',
  test: false,
  trialDays: 7,
  createdAt: '2026-10-11T10:19:23Z',
  currentPeriodEnd: '2026-10-18T10:19:23Z',
  planHandle: 'starter',
  ...o,
});
const STARTER = sub({});
const FREE_SUB = sub({
  id: 'gid://shopify/AppSubscription/28292677698',
  name: 'Free',
  trialDays: 0,
  createdAt: '2026-10-11T10:27:19Z',
  currentPeriodEnd: '2026-11-10T10:27:19Z',
  planHandle: 'free',
});

/** Admin API node shape (lineItems → pricingDetails.planHandle) for the fake. */
function node(s: SubscriptionInfo) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    test: s.test,
    trialDays: s.trialDays,
    createdAt: s.createdAt,
    currentPeriodEnd: s.currentPeriodEnd,
    lineItems: [
      { plan: { pricingDetails: { __typename: 'AppRecurringPricing', planHandle: s.planHandle } } },
    ],
  };
}

function fakeAdmin(active: SubscriptionInfo[] | Error): AdminClient & { calls: number } {
  const admin = {
    calls: 0,
    graphql: async <T>(): Promise<T> => {
      admin.calls++;
      if (active instanceof Error) throw active;
      return {
        currentAppInstallation: { activeSubscriptions: active.map(node) },
      } as T;
    },
  };
  return admin;
}

let d1: TestD1;
let env: Env;
let queue: JobMessage[];
const row = () =>
  d1.query<Record<string, unknown>>(
    'SELECT plan, plan_handle, subscription_id, trial_ends_at, current_period_end, plan_synced_at FROM shops',
  )[0];

beforeEach(async () => {
  d1 = await createTestD1();
  queue = [];
  const jobs = {
    send: async (m: JobMessage) => void queue.push(m),
    sendBatch: async (ms: { body: JobMessage }[]) => void queue.push(...ms.map((m) => m.body)),
  };
  env = makeEnv({ DB: d1.db, JOBS: jobs as unknown as Queue<JobMessage> });
  d1.raw.run(
    `INSERT INTO shops (shop, access_token_enc, access_token_expires_at, refresh_token_enc, refresh_token_expires_at,
                        scope, installed_at, plan)
     VALUES (?, ?, ?, ?, ?, 'read_products', 1, 'free')`,
    [
      SHOP,
      await encryptString('access-token', ENCRYPTION_KEY),
      Date.now() + 3_600_000,
      await encryptString('refresh-token', ENCRYPTION_KEY),
      Date.now() + 86_400_000,
    ],
  );
});

describe('which plan applies (mapping)', () => {
  it('no active subscription (new shop, after reinstall) → Free', () => {
    expect(activePlan([])).toMatchObject({ plan: 'free', handle: null, subscriptionId: null });
  });

  it('Starter with a 7-day trial: trial end = created + 7 days = current period end', () => {
    expect(activePlan([STARTER])).toEqual({
      plan: 'starter',
      handle: 'starter',
      subscriptionId: 'gid://shopify/AppSubscription/28292612162',
      trialEndsAt: Date.parse('2026-10-18T10:19:23Z'),
      currentPeriodEnd: Date.parse('2026-10-18T10:19:23Z'),
    });
  });

  it('Free is a $0 subscription with handle free; a cancelled plan is ignored', () => {
    expect(activePlan([sub({ status: 'CANCELLED', currentPeriodEnd: null }), FREE_SUB])).toMatchObject({
      plan: 'free',
      handle: 'free',
      trialEndsAt: null,
    });
  });

  it('unknown / deleted-plan (null) handles and non-active statuses count as Free', () => {
    expect(activePlan([sub({ planHandle: 'enterprise' })]).plan).toBe('free');
    expect(activePlan([sub({ planHandle: null })]).plan).toBe('free');
    for (const status of ['FROZEN', 'PENDING', 'DECLINED', 'EXPIRED', 'CANCELLED'])
      expect(activePlan([sub({ status })]).plan, status).toBe('free');
  });

  it('the newest active subscription wins', () => {
    const pro = sub({ id: 'x', planHandle: 'pro', createdAt: '2026-10-12T00:00:00Z' });
    expect(activePlan([STARTER, pro]).plan).toBe('pro');
  });

  it('plan names are never used (Shopify translates them)', () => {
    expect(activePlan([sub({ name: 'Inicial', planHandle: 'starter' })]).plan).toBe('starter');
    expect(planForHandle('Starter')).toBe('free'); // handles are lower-case ids
  });
});

describe('sync shops.plan', () => {
  it('stores the plan and subscription details and logs the change', async () => {
    await syncPlan(env.DB, fakeAdmin([STARTER]), SHOP, NOW);
    expect(row()).toEqual({
      plan: 'starter',
      plan_handle: 'starter',
      subscription_id: 'gid://shopify/AppSubscription/28292612162',
      trial_ends_at: Date.parse('2026-10-18T10:19:23Z'),
      current_period_end: Date.parse('2026-10-18T10:19:23Z'),
      plan_synced_at: NOW,
    });
    expect(d1.query('SELECT action, details FROM audit_log')).toEqual([
      {
        action: 'plan_changed',
        details: JSON.stringify({
          from: 'free',
          to: 'starter',
          handle: 'starter',
          subscriptionId: 'gid://shopify/AppSubscription/28292612162',
        }),
      },
    ]);

    // Same plan again: no new audit entry.
    await syncPlan(env.DB, fakeAdmin([STARTER]), SHOP, NOW + 1);
    expect(d1.query('SELECT COUNT(*) AS n FROM audit_log')).toEqual([{ n: 1 }]);
  });

  it('downgrade to Free, then a cancelled subscription (reinstall) → Free', async () => {
    await syncPlan(env.DB, fakeAdmin([STARTER]), SHOP, NOW);
    await syncPlan(env.DB, fakeAdmin([FREE_SUB]), SHOP, NOW + 1);
    expect(row()).toMatchObject({ plan: 'free', plan_handle: 'free', trial_ends_at: null });
    await syncPlan(env.DB, fakeAdmin([]), SHOP, NOW + 2);
    expect(row()).toMatchObject({ plan: 'free', plan_handle: null, subscription_id: null });
  });

  it('a Shopify error never changes the stored plan', async () => {
    await syncPlan(env.DB, fakeAdmin([STARTER]), SHOP, NOW);
    await expect(syncPlan(env.DB, fakeAdmin(new Error('Shopify 500')), SHOP, NOW + 1)).rejects.toThrow();
    expect(row()).toMatchObject({ plan: 'starter', plan_synced_at: NOW });
  });

  it('app load re-checks at most every 5 minutes and swallows errors', async () => {
    const admin = fakeAdmin([STARTER]);
    await syncPlanIfStale(env.DB, admin, SHOP, NOW); // never synced → sync
    await syncPlanIfStale(env.DB, admin, SHOP, NOW + SYNC_MAX_AGE_MS - 1); // fresh → skip
    expect(admin.calls).toBe(1);
    await syncPlanIfStale(env.DB, admin, SHOP, NOW + SYNC_MAX_AGE_MS);
    expect(admin.calls).toBe(2);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      syncPlanIfStale(env.DB, fakeAdmin(new Error('down')), SHOP, NOW + 2 * SYNC_MAX_AGE_MS),
    ).resolves.toBeUndefined();
    spy.mockRestore();
    expect(row()).toMatchObject({ plan: 'starter' });
  });

  it('uninstall puts the shop on Free (Shopify cancels the subscription)', async () => {
    await syncPlan(env.DB, fakeAdmin([STARTER]), SHOP, NOW);
    await markShopUninstalled(env.DB, SHOP, NOW + 1);
    expect(row()).toMatchObject({
      plan: 'free',
      plan_handle: null,
      subscription_id: null,
      trial_ends_at: null,
    });
  });

  it('daily cron queues one sync per installed shop; the job applies it; errors keep the plan', async () => {
    d1.raw.run(`INSERT INTO shops (shop, installed_at, uninstalled_at) VALUES ('gone.myshopify.com', 1, 2)`);
    expect(await queuePlanSyncs(env)).toEqual({ shops: 1 });
    expect(queue).toEqual([{ type: 'billing/sync', shop: SHOP, payload: {} }]);

    await runJob(queue[0] as JobMessage, env, { now: () => NOW, admin: () => fakeAdmin([STARTER]) });
    expect(row()).toMatchObject({ plan: 'starter' });
    await expect(
      runJob(queue[0] as JobMessage, env, { now: () => NOW, admin: () => fakeAdmin(new Error('down')) }),
    ).rejects.toThrow();
    expect(row()).toMatchObject({ plan: 'starter' });
  });
});

describe('upgrade suggestions', () => {
  it('names the next plan with a higher monthly verification limit', () => {
    expect(requiredPlans('free').monthly_verifications).toBe('starter');
    expect(requiredPlans('starter').monthly_verifications).toBe('pro');
    expect(requiredPlans('pro').monthly_verifications).toBeNull();
    expect(upgradeWith('pro', () => true)).toBeNull();
  });

  it('month boundaries are UTC', () => {
    expect(monthStart(Date.parse('2026-10-31T23:59:59Z'))).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });

  it('no plan is unlimited: every verification is a paid Idura transaction', () => {
    for (const p of PLANS) {
      const max = PLAN_LIMITS[p.name].maxVerificationsPerMonth;
      expect(Number.isInteger(max) && max > 0, p.name).toBe(true);
      // The listing states the cap the plan enforces.
      const line = `${max.toLocaleString('en-US')} age verifications per month`;
      expect(
        p.features.some((f) => f.en === line),
        p.name,
      ).toBe(true);
      expect(p.features.map((f) => f.en.toLowerCase()).join(' ')).not.toContain('unlimited');
    }
  });

  it('every plan with a trial lists it as a feature', () => {
    for (const p of PLANS) {
      const trial = p.features.some((f) => f.en === `${p.trialDays}-day free trial`);
      expect(trial, p.name).toBe(p.trialDays > 0);
    }
  });
});

describe('/api/billing', () => {
  async function api(method: string, path: string) {
    const { app } = await import('../src/index');
    const res = await app.request(
      `/api${path}`,
      { method, headers: { Authorization: `Bearer ${await signIdToken()}` } },
      env,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('POST /billing/sync reads the plan from Shopify and returns the Plans page data', async () => {
    routeAdmin = fakeAdmin([STARTER]);
    const res = await api('POST', '/billing/sync');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      synced: true,
      current: { plan: 'starter' },
      planPageUrl: 'https://admin.shopify.com/store/demo-store/charges/ageshield-staging/pricing_plans',
      requiredPlans: { monthly_verifications: 'pro' },
    });
    expect((res.body['plans'] as { name: string }[]).map((p) => p.name)).toEqual(['free', 'starter', 'pro']);
  });

  it('if Shopify fails, the stored plan is shown and synced is false', async () => {
    routeAdmin = fakeAdmin([STARTER]);
    await api('POST', '/billing/sync');
    routeAdmin = fakeAdmin(new Error('down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await api('POST', '/billing/sync');
    spy.mockRestore();
    expect(res.body).toMatchObject({ synced: false, current: { plan: 'starter' } });
  });

  it('opening the app (GET /me) syncs a stale plan in the background', async () => {
    d1.raw.run(`UPDATE shops SET shop_name = 'Demo Store', iana_timezone = 'Europe/Copenhagen'`);
    routeAdmin = fakeAdmin([STARTER]);
    expect((await api('GET', '/me')).status).toBe(200);
    expect(row()).toMatchObject({ plan: 'starter' });
  });

  it('opening the app still works when the time zone backfill fails (known shop falls back to UTC)', async () => {
    d1.raw.run(`UPDATE shops SET shop_name = 'Demo Store', iana_timezone = NULL`);
    routeAdmin = fakeAdmin(new Error('down'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await api('GET', '/me');
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ shopName: 'Demo Store', timeZone: 'UTC' });
  });

  it('no billing date on Free; the trial end only while it lasts', async () => {
    routeAdmin = fakeAdmin([FREE_SUB]);
    expect((await api('POST', '/billing/sync')).body['current']).toMatchObject({
      plan: 'free',
      currentPeriodEnd: null,
      trialEndsAt: null,
    });
  });
});
