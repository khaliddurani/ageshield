import { z } from 'zod';
import { assertNoUserErrors, type AdminClient } from '../lib/shopify/admin';
import type { ProductJob } from '../lib/shopify/webhook-payloads';
import { listRules, type Rule } from './rules';
import { getSettings, type MinAge } from './settings';
import { formatJobError, type JobFailure } from './job-errors';

// Rules → app-owned product metafield $app.age_restricted (ARCHITECTURE §5). Shopify holds the truth the storefront
// and the Phase 2 Function read; D1 `restricted_products` mirrors what was written so a run only changes what differs.
//
// A sync run (jobs row, type rules_sync) has two phases, each a chain of queue messages:
//   collect — one page (≤ 250 products) of one rule per message: upsert desired_min_age (strictest rule wins) with
//             desired_run = the run's job id;
//   apply   — ≤ 100 products per message: write the metafield where it differs, then delete it from products the
//             run no longer covers.
// A message whose run is no longer queued/running (a newer save cancelled it) stops without changes.
// products/create|update webhooks sync just that product (syncProduct) and never touch other rows.

export const METAFIELD_NAMESPACE = '$app';
export const METAFIELD_KEY = 'age_restricted';
const PAGE_SIZE = 250;
const APPLY_BATCH = 100;
/** metafieldsSet accepts at most 25 metafields per call. */
const METAFIELDS_PER_CALL = 25;

export const rulesSyncPayloadSchema = z.discriminatedUnion('phase', [
  z.object({
    jobId: z.string(),
    phase: z.literal('collect'),
    ruleIndex: z.number().int().min(0),
    after: z.string().nullable(),
  }),
  z.object({ jobId: z.string(), phase: z.literal('apply') }),
]);
export type RulesSyncPayload = z.infer<typeof rulesSyncPayloadSchema>;

// --- GraphQL ---------------------------------------------------------------------------------------------------------

const COLLECTION_PRODUCTS_QUERY = `#graphql
  query AgeShieldCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
    }
  }
`;

const TAGGED_PRODUCTS_QUERY = `#graphql
  query AgeShieldTaggedProducts($query: String!, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $query) { nodes { id } pageInfo { hasNextPage endCursor } }
  }
`;

const PRODUCTS_EXIST_QUERY = `#graphql
  query AgeShieldProductsExist($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { id } }
  }
`;

const PRODUCT_COLLECTIONS_QUERY = `#graphql
  query AgeShieldProductCollections($id: ID!) {
    product(id: $id) { collections(first: 250) { nodes { id } } }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation AgeShieldMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
  }
`;

const METAFIELDS_DELETE_MUTATION = `#graphql
  mutation AgeShieldMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } }
  }
`;

interface Page {
  nodes: { id: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Shopify search syntax for an exact tag: tag:"value" with quotes and backslashes escaped. */
export function tagQuery(tag: string): string {
  return `tag:"${tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One page of the products a rule covers. */
async function rulePage(
  admin: AdminClient,
  rule: Rule,
  after: string | null,
): Promise<{ productIds: string[]; next: string | null }> {
  if (rule.type === 'product') {
    // A deleted product would make metafieldsSet fail for the whole batch, so check it still exists.
    const data = await admin.graphql<{ nodes: ({ id?: string } | null)[] }>(PRODUCTS_EXIST_QUERY, {
      ids: [rule.resourceGid],
    });
    return { productIds: data.nodes.flatMap((n) => (n?.id ? [n.id] : [])), next: null };
  }
  let page: Page | null;
  if (rule.type === 'collection') {
    const data = await admin.graphql<{ collection: { products: Page } | null }>(COLLECTION_PRODUCTS_QUERY, {
      id: rule.resourceGid,
      first: PAGE_SIZE,
      after,
    });
    page = data.collection?.products ?? null; // deleted collection: covers nothing
  } else {
    const data = await admin.graphql<{ products: Page }>(TAGGED_PRODUCTS_QUERY, {
      query: tagQuery(rule.tag ?? ''),
      first: PAGE_SIZE,
      after,
    });
    page = data.products;
  }
  if (!page) return { productIds: [], next: null };
  return {
    productIds: page.nodes.map((n) => n.id),
    next: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
  };
}

async function setMetafields(admin: AdminClient, items: { productGid: string; minAge: number }[]) {
  for (let i = 0; i < items.length; i += METAFIELDS_PER_CALL) {
    const data = await admin.graphql<{ metafieldsSet: { userErrors: { message: string }[] } }>(
      METAFIELDS_SET_MUTATION,
      {
        metafields: items.slice(i, i + METAFIELDS_PER_CALL).map((item) => ({
          ownerId: item.productGid,
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: 'number_integer',
          value: String(item.minAge),
        })),
      },
    );
    assertNoUserErrors(data.metafieldsSet, 'metafieldsSet');
  }
}

async function deleteMetafields(admin: AdminClient, productGids: string[]) {
  for (let i = 0; i < productGids.length; i += METAFIELDS_PER_CALL) {
    const data = await admin.graphql<{ metafieldsDelete: { userErrors: { message: string }[] } }>(
      METAFIELDS_DELETE_MUTATION,
      {
        metafields: productGids
          .slice(i, i + METAFIELDS_PER_CALL)
          .map((ownerId) => ({ ownerId, namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY })),
      },
    );
    assertNoUserErrors(data.metafieldsDelete, 'metafieldsDelete');
  }
}

// --- Sync run ----------------------------------------------------------------------------------------------------------

async function runIsCurrent(db: D1Database, shop: string, jobId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM jobs WHERE id = ?1 AND shop = ?2 AND status IN ('queued', 'running')")
    .bind(jobId, shop)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * Runs one message of a sync run. Returns the next message's payload, or null when the run is finished (or was
 * superseded). Admin API errors throw (the queue retries the same message; every step is idempotent).
 */
export async function runRulesSyncStep(
  db: D1Database,
  admin: AdminClient,
  shop: string,
  payload: RulesSyncPayload,
  now: number,
): Promise<RulesSyncPayload | null> {
  if (!(await runIsCurrent(db, shop, payload.jobId))) return null;
  await db
    .prepare("UPDATE jobs SET status = 'running', updated_at = ?2 WHERE id = ?1")
    .bind(payload.jobId, now)
    .run();

  if (payload.phase === 'collect') {
    const rules = await listRules(db, shop);
    const rule = rules[payload.ruleIndex];
    if (!rule) return { jobId: payload.jobId, phase: 'apply' };
    const settings = await getSettings(db, shop);
    const minAge: MinAge = rule.minAge ?? settings.defaultMinAge;
    const { productIds, next } = await rulePage(admin, rule, payload.after);
    if (productIds.length > 0) {
      await db.batch(
        productIds.map((productGid) =>
          db
            .prepare(
              `INSERT INTO restricted_products (shop, product_gid, desired_min_age, desired_run)
               VALUES (?1, ?2, ?3, ?4)
               ON CONFLICT(shop, product_gid) DO UPDATE SET
                 desired_min_age = CASE WHEN restricted_products.desired_run = ?4
                                        THEN MAX(restricted_products.desired_min_age, ?3) ELSE ?3 END,
                 desired_run = ?4`,
            )
            .bind(shop, productGid, minAge, payload.jobId),
        ),
      );
    }
    if (next) return { ...payload, after: next };
    return { jobId: payload.jobId, phase: 'collect', ruleIndex: payload.ruleIndex + 1, after: null };
  }

  // apply: first write what differs, then remove what the run doesn't cover any more.
  const { results: toSet } = await db
    .prepare(
      `SELECT product_gid, desired_min_age FROM restricted_products
        WHERE shop = ?1 AND desired_run = ?2 AND (min_age IS NULL OR min_age != desired_min_age)
        LIMIT ?3`,
    )
    .bind(shop, payload.jobId, APPLY_BATCH)
    .all<{ product_gid: string; desired_min_age: number }>();
  if (toSet.length > 0) {
    await setMetafields(
      admin,
      toSet.map((r) => ({ productGid: r.product_gid, minAge: r.desired_min_age })),
    );
    await db.batch([
      ...toSet.map((r) =>
        db
          .prepare(
            `UPDATE restricted_products SET min_age = desired_min_age, synced_at = ?3
              WHERE shop = ?1 AND product_gid = ?2`,
          )
          .bind(shop, r.product_gid, now),
      ),
      db
        .prepare('UPDATE jobs SET processed = processed + ?2, updated_at = ?3 WHERE id = ?1')
        .bind(payload.jobId, toSet.length, now),
    ]);
    return payload;
  }

  const { results: toRemove } = await db
    .prepare(
      `SELECT product_gid, min_age FROM restricted_products
        WHERE shop = ?1 AND (desired_run IS NULL OR desired_run != ?2)
        LIMIT ?3`,
    )
    .bind(shop, payload.jobId, APPLY_BATCH)
    .all<{ product_gid: string; min_age: number | null }>();
  if (toRemove.length > 0) {
    await deleteMetafields(
      admin,
      toRemove.filter((r) => r.min_age !== null).map((r) => r.product_gid),
    );
    await db.batch([
      ...toRemove.map((r) =>
        db
          .prepare('DELETE FROM restricted_products WHERE shop = ?1 AND product_gid = ?2')
          .bind(shop, r.product_gid),
      ),
      db
        .prepare('UPDATE jobs SET processed = processed + ?2, updated_at = ?3 WHERE id = ?1')
        .bind(payload.jobId, toRemove.length, now),
    ]);
    return payload;
  }

  const total = await db
    .prepare('SELECT COUNT(*) AS n FROM restricted_products WHERE shop = ?1')
    .bind(shop)
    .first<{ n: number }>();
  await db
    .prepare("UPDATE jobs SET status = 'done', total = ?2, updated_at = ?3 WHERE id = ?1")
    .bind(payload.jobId, total?.n ?? 0, now)
    .run();
  return null;
}

/** The run gave up (non-retryable error or retries exhausted): record it so the UI shows the failure. */
export async function failRulesSync(
  db: D1Database,
  jobId: string,
  failure: JobFailure,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE jobs SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1")
    .bind(jobId, formatJobError(failure), now)
    .run();
}

// --- Single product (webhooks) -------------------------------------------------------------------------------------

/** Strictest minimum age among the rules that cover the product, or null. */
export async function desiredMinAge(
  admin: AdminClient,
  rules: Rule[],
  defaultMinAge: MinAge,
  product: ProductJob,
): Promise<MinAge | null> {
  const tags = new Set(product.tags.map((t) => t.toLowerCase()));
  const matches = rules.filter(
    (r) =>
      (r.type === 'product' && r.resourceGid === product.productId) ||
      (r.type === 'tag' && tags.has((r.tag ?? '').toLowerCase())),
  );
  const collectionRules = rules.filter((r) => r.type === 'collection');
  if (collectionRules.length > 0) {
    const data = await admin.graphql<{ product: { collections: { nodes: { id: string }[] } } | null }>(
      PRODUCT_COLLECTIONS_QUERY,
      { id: product.productId },
    );
    const inCollections = new Set((data.product?.collections.nodes ?? []).map((c) => c.id));
    matches.push(...collectionRules.filter((r) => inCollections.has(r.resourceGid ?? '')));
  }
  if (matches.length === 0) return null;
  return Math.max(...matches.map((r) => r.minAge ?? defaultMinAge)) as MinAge;
}

/**
 * products/create|update: bring this product's metafield in line with the rules. No API call for shops without
 * rules (and no write when nothing changed, so the products/update our own write triggers ends here).
 */
export async function syncProduct(
  db: D1Database,
  admin: () => AdminClient,
  shop: string,
  product: ProductJob,
  now: number,
): Promise<void> {
  const rules = await listRules(db, shop);
  const row = await db
    .prepare('SELECT min_age FROM restricted_products WHERE shop = ?1 AND product_gid = ?2')
    .bind(shop, product.productId)
    .first<{ min_age: number | null }>();
  if (rules.length === 0 && !row) return;

  const { defaultMinAge } = await getSettings(db, shop);
  const desired = await desiredMinAge(admin(), rules, defaultMinAge, product);
  if (desired === (row?.min_age ?? null)) return;

  // A run in progress must keep this product (desired_run) — or, if it computed it before, gets the new value.
  const active = await db
    .prepare(
      `SELECT id FROM jobs WHERE shop = ?1 AND type = 'rules_sync' AND status IN ('queued', 'running')
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(shop)
    .first<{ id: string }>();

  if (desired === null) {
    await deleteMetafields(admin(), [product.productId]);
    await db
      .prepare('DELETE FROM restricted_products WHERE shop = ?1 AND product_gid = ?2')
      .bind(shop, product.productId)
      .run();
    return;
  }
  await setMetafields(admin(), [{ productGid: product.productId, minAge: desired }]);
  await db
    .prepare(
      `INSERT INTO restricted_products (shop, product_gid, min_age, desired_min_age, desired_run, synced_at)
       VALUES (?1, ?2, ?3, ?3, ?4, ?5)
       ON CONFLICT(shop, product_gid) DO UPDATE SET
         min_age = ?3, desired_min_age = ?3, desired_run = ?4, synced_at = ?5`,
    )
    .bind(shop, product.productId, desired, active?.id ?? null, now)
    .run();
}

/** Restricted products count and the latest sync run, for the Restricted products page. */
export async function restrictionStatus(db: D1Database, shop: string) {
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM restricted_products WHERE shop = ?1 AND min_age IS NOT NULL')
    .bind(shop)
    .first<{ n: number }>();
  const job = await db
    .prepare(
      `SELECT id, status, processed, error, created_at, updated_at FROM jobs
        WHERE shop = ?1 AND type = 'rules_sync' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(shop)
    .first<{
      id: string;
      status: string;
      processed: number;
      error: string | null;
      created_at: number;
      updated_at: number;
    }>();
  return {
    restrictedProducts: count?.n ?? 0,
    sync: job
      ? {
          status: job.status,
          processed: job.processed,
          errorCode: job.error?.split(':')[0] ?? null,
          startedAt: job.created_at,
          updatedAt: job.updated_at,
        }
      : null,
  };
}
