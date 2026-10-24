import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { AccessDeniedError } from '../src/lib/shopify/admin';
import { PermanentJobError, runJob, type JobMessage } from '../src/queue/handlers';
import { tagQuery } from '../src/services/restriction-sync';
import {
  addRules,
  deleteRule,
  MAX_RULES,
  newRuleSchema,
  RuleError,
  startRulesSync,
} from '../src/services/rules';
import { saveSettings, DEFAULT_SETTINGS } from '../src/services/settings';
import { createTestD1, type TestD1 } from './d1';
import { FakeShopify } from './fake-shopify';
import { SHOP, makeEnv, seedShop } from './helpers';

const NOW = 1_800_000_000_000;
const P = (n: number) => `gid://shopify/Product/${n}`;
const C = (n: number) => `gid://shopify/Collection/${n}`;

let d1: TestD1;
let shopify: FakeShopify;
let queue: JobMessage[];
let env: Env;

beforeEach(async () => {
  d1 = await createTestD1();
  seedShop(d1.raw);
  shopify = new FakeShopify();
  queue = [];
  const jobs = { send: async (m: JobMessage) => void queue.push(m) };
  env = makeEnv({ DB: d1.db, JOBS: jobs as unknown as Queue<JobMessage> });
});

const deps = (attempt = 1) => ({ now: () => NOW, admin: () => shopify.admin, attempt });

/** Runs queued messages (FIFO) until the queue is empty, like the consumer would. */
async function drain(limit = 200) {
  for (let i = 0; i < limit && queue.length > 0; i++) {
    const message = queue.shift() as JobMessage;
    await runJob(message, env, deps());
  }
  expect(queue, 'queue drained').toEqual([]);
}

const restricted = () =>
  d1.query<{ product_gid: string; min_age: number }>(
    'SELECT product_gid, min_age FROM restricted_products WHERE shop = ? ORDER BY product_gid',
    SHOP,
  );
const latestJob = () =>
  d1.query<{ status: string; total: number; error: string | null }>(
    "SELECT status, total, error FROM jobs WHERE type = 'rules_sync' ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )[0];

function catalog() {
  shopify.collections = new Set([C(1)]);
  shopify.products.set(P(1), { tags: [], collections: [] });
  shopify.products.set(P(2), { tags: ['Snus'], collections: [C(1)] });
  shopify.products.set(P(3), { tags: ['snus'], collections: [] });
  shopify.products.set(P(4), { tags: [], collections: [C(1)] });
  shopify.products.set(P(5), { tags: ['tea'], collections: [] });
}

describe('rules → $app.age_restricted sync run', () => {
  it('expands product, collection and tag rules (paged); the strictest age wins; default for unset ages', async () => {
    catalog();
    shopify.pageSize = 1; // every collection/tag page holds one product: exercises the cursors
    await addRules(
      d1.db,
      SHOP,
      [
        { type: 'product', resourceGid: P(1), minAge: 16 },
        { type: 'collection', resourceGid: C(1), minAge: 21 },
        { type: 'tag', tag: 'SNUS', minAge: null }, // case-insensitive, default age (18)
      ],
      NOW,
    );
    await startRulesSync(env, SHOP, NOW);
    await drain();

    expect(restricted()).toEqual([
      { product_gid: P(1), min_age: 16 },
      { product_gid: P(2), min_age: 21 }, // collection (21) beats tag (18)
      { product_gid: P(3), min_age: 18 },
      { product_gid: P(4), min_age: 21 },
    ]);
    expect([1, 2, 3, 4, 5].map((n) => shopify.ageRestriction(P(n)))).toEqual([16, 21, 18, 21, undefined]);
    expect(shopify.metafields.get(`${P(1)}|$app.age_restricted`)?.type).toBe('number_integer');
    expect(latestJob()).toMatchObject({ status: 'done', total: 4, error: null });
  });

  it('removing a rule removes the metafield; unchanged products are not written again', async () => {
    catalog();
    const [tagRule] = await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: 18 }], NOW);
    await addRules(d1.db, SHOP, [{ type: 'product', resourceGid: P(1), minAge: 18 }], NOW + 1);
    await startRulesSync(env, SHOP, NOW);
    await drain();
    expect(restricted().map((r) => r.product_gid)).toEqual([P(1), P(2), P(3)]);

    const setsBefore = shopify.opCount('AgeShieldMetafieldsSet');
    await deleteRule(d1.db, SHOP, tagRule?.id ?? '');
    await startRulesSync(env, SHOP, NOW + 2);
    await drain();
    expect(restricted()).toEqual([{ product_gid: P(1), min_age: 18 }]);
    expect(shopify.ageRestriction(P(2))).toBeUndefined();
    expect(shopify.ageRestriction(P(3))).toBeUndefined();
    expect(shopify.opCount('AgeShieldMetafieldsSet')).toBe(setsBefore); // P(1) unchanged
  });

  it('changing the default minimum age updates rules without their own age', async () => {
    catalog();
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'tea', minAge: null }], NOW);
    await startRulesSync(env, SHOP, NOW);
    await drain();
    expect(shopify.ageRestriction(P(5))).toBe(18);
    const { defaultMinAgeChanged } = await saveSettings(
      d1.db,
      SHOP,
      { ...DEFAULT_SETTINGS, defaultMinAge: 21 },
      NOW,
    );
    expect(defaultMinAgeChanged).toBe(true);
    await startRulesSync(env, SHOP, NOW + 1);
    await drain();
    expect(shopify.ageRestriction(P(5))).toBe(21);
  });

  it('a deleted product or collection in a rule is skipped, not a failure', async () => {
    catalog();
    await addRules(
      d1.db,
      SHOP,
      [
        { type: 'product', resourceGid: P(999), minAge: 18 },
        { type: 'collection', resourceGid: C(999), minAge: 18 },
        { type: 'product', resourceGid: P(1), minAge: 18 },
      ],
      NOW,
    );
    await startRulesSync(env, SHOP, NOW);
    await drain();
    expect(restricted()).toEqual([{ product_gid: P(1), min_age: 18 }]);
    expect(latestJob()?.status).toBe('done');
  });

  it('writes metafields in batches of at most 25', async () => {
    shopify.collections.add(C(1));
    for (let n = 1; n <= 60; n++) shopify.products.set(P(n), { tags: [], collections: [C(1)] });
    await addRules(d1.db, SHOP, [{ type: 'collection', resourceGid: C(1), minAge: 18 }], NOW);
    await startRulesSync(env, SHOP, NOW);
    await drain();
    expect(restricted()).toHaveLength(60);
    expect(shopify.opCount('AgeShieldMetafieldsSet')).toBe(3); // 25 + 25 + 10
  });

  it('a newer save supersedes a running sync: the old run stops, the new one decides', async () => {
    catalog();
    const [rule] = await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: 18 }], NOW);
    await startRulesSync(env, SHOP, NOW);
    await deleteRule(d1.db, SHOP, rule?.id ?? '');
    await addRules(d1.db, SHOP, [{ type: 'product', resourceGid: P(5), minAge: 21 }], NOW + 1);
    await startRulesSync(env, SHOP, NOW + 1);
    await drain();
    expect(restricted()).toEqual([{ product_gid: P(5), min_age: 21 }]);
    expect(d1.query("SELECT status FROM jobs WHERE type = 'rules_sync' ORDER BY rowid")).toEqual([
      { status: 'cancelled' },
      { status: 'done' },
    ]);
  });

  it('a non-retryable Admin API error fails the run (visible in the UI) instead of retrying forever', async () => {
    catalog();
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: 18 }], NOW);
    await startRulesSync(env, SHOP, NOW);
    shopify.failures.set('AgeShieldTaggedProducts', new AccessDeniedError('Access denied for products'));
    const message = queue.shift() as JobMessage;
    await expect(runJob(message, env, deps())).rejects.toBeInstanceOf(PermanentJobError);
    expect(latestJob()).toMatchObject({ status: 'failed' });
    expect(latestJob()?.error).toMatch(/^access_denied: /);
  });

  it('a transient error is retried, and gives up (failed) on the last attempt', async () => {
    catalog();
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: 18 }], NOW);
    await startRulesSync(env, SHOP, NOW);
    shopify.failures.set('AgeShieldTaggedProducts', new Error('Shopify 503'));
    const message = queue.shift() as JobMessage;
    await expect(runJob(message, env, deps(1))).rejects.toThrow('Shopify 503');
    expect(latestJob()?.status).toBe('running');
    await expect(runJob(message, env, deps(6))).rejects.toBeInstanceOf(PermanentJobError);
    expect(latestJob()?.error).toMatch(/^retries_exhausted: /);
  });
});

describe('products/create|update webhook sync', () => {
  const webhook = (productId: string, tags: string[]) =>
    runJob({ type: 'products/update', shop: SHOP, payload: { productId, tags } }, env, deps());

  it('no rules and not restricted → no Admin API call at all', async () => {
    await webhook(P(1), ['snus']);
    expect(shopify.calls).toEqual([]);
  });

  it('a tag added or removed in Shopify updates that product only', async () => {
    catalog();
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: 18 }], NOW);
    await webhook(P(5), ['tea', 'Snus']);
    expect(shopify.ageRestriction(P(5))).toBe(18);
    expect(restricted()).toEqual([{ product_gid: P(5), min_age: 18 }]);

    await webhook(P(5), ['tea']);
    expect(shopify.ageRestriction(P(5))).toBeUndefined();
    expect(restricted()).toEqual([]);
  });

  it('the products/update our own metafield write triggers changes nothing (no loop)', async () => {
    catalog();
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: 18 }], NOW);
    await webhook(P(3), ['snus']);
    const writes = shopify.opCount('AgeShieldMetafieldsSet');
    await webhook(P(3), ['snus']);
    expect(shopify.opCount('AgeShieldMetafieldsSet')).toBe(writes);
  });

  it('collection rules check the product’s collections (one query)', async () => {
    catalog();
    await addRules(d1.db, SHOP, [{ type: 'collection', resourceGid: C(1), minAge: 21 }], NOW);
    await webhook(P(4), []);
    expect(shopify.ageRestriction(P(4))).toBe(21);
    expect(shopify.opCount('AgeShieldProductCollections')).toBe(1);
  });

  it('a product created during a running sync is kept by that run', async () => {
    catalog();
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'snus', minAge: 18 }], NOW);
    await startRulesSync(env, SHOP, NOW);
    await runJob(queue.shift() as JobMessage, env, deps()); // collect: P(2), P(3)
    shopify.products.set(P(6), { tags: ['snus'], collections: [] });
    await webhook(P(6), ['snus']);
    await drain();
    expect(restricted().map((r) => r.product_gid)).toEqual([P(2), P(3), P(6)]);
    expect(shopify.ageRestriction(P(6))).toBe(18);
  });
});

describe('rules', () => {
  it('validates input: gids by type, tags without commas, allowed ages only', () => {
    expect(newRuleSchema.safeParse({ type: 'product', resourceGid: P(1), minAge: 18 }).success).toBe(true);
    expect(newRuleSchema.safeParse({ type: 'product', resourceGid: C(1), minAge: 18 }).success).toBe(false);
    expect(newRuleSchema.safeParse({ type: 'tag', tag: 'a,b', minAge: null }).success).toBe(false);
    expect(newRuleSchema.safeParse({ type: 'tag', tag: '  ', minAge: null }).success).toBe(false);
    expect(newRuleSchema.safeParse({ type: 'tag', tag: 'snus', minAge: 17 }).success).toBe(false);
  });

  it('skips duplicates (tags case-insensitively) and enforces the rule limit', async () => {
    await addRules(d1.db, SHOP, [{ type: 'tag', tag: 'Snus', minAge: null }], NOW);
    const added = await addRules(
      d1.db,
      SHOP,
      [
        { type: 'tag', tag: 'snus', minAge: 21 },
        { type: 'product', resourceGid: P(1), minAge: null },
        { type: 'product', resourceGid: P(1), minAge: 16 },
      ],
      NOW,
    );
    expect(added.map((r) => r.type)).toEqual(['product']);
    const many = Array.from({ length: MAX_RULES }, (_, i) => ({
      type: 'product' as const,
      resourceGid: P(1000 + i),
      minAge: null,
    }));
    await expect(addRules(d1.db, SHOP, many, NOW)).rejects.toBeInstanceOf(RuleError);
  });

  it('the database rejects ages outside 15/16/18/21 and malformed rules', () => {
    expect(() =>
      d1.raw.run(
        "INSERT INTO restricted_rules (id, shop, type, resource_gid, min_age, created_at) VALUES ('x', ?, 'product', 'g', 17, 1)",
        [SHOP],
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      d1.raw.run("INSERT INTO restricted_rules (id, shop, type, created_at) VALUES ('y', ?, 'product', 1)", [
        SHOP,
      ]),
    ).toThrow(/CHECK/);
  });

  it('builds an exact tag search query with quotes escaped', () => {
    expect(tagQuery('snus')).toBe('tag:"snus"');
    expect(tagQuery('18" "x')).toBe('tag:"18\\" \\"x"');
  });
});
