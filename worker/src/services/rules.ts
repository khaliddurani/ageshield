import { z } from 'zod';
import type { Env } from '../env';
import { minAgeSchema, type MinAge } from './settings';

// Restricted-product rules (D1 `restricted_rules`). Saving rules starts a sync run (restriction-sync.ts) that writes
// the app-owned product metafield $app.age_restricted on every affected product.

export type RuleType = 'product' | 'collection' | 'tag';

export interface Rule {
  id: string;
  type: RuleType;
  /** Product or collection gid (null for tag rules). */
  resourceGid: string | null;
  /** Product tag (tag rules only). */
  tag: string | null;
  /** null = the shop's default minimum age. */
  minAge: MinAge | null;
  createdAt: number;
}

const gid = (kind: 'Product' | 'Collection') =>
  z.string().regex(new RegExp(`^gid://shopify/${kind}/\\d+$`), `Must be a ${kind} gid`);

export const newRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('product'), resourceGid: gid('Product'), minAge: minAgeSchema.nullable() }),
  z.object({
    type: z.literal('collection'),
    resourceGid: gid('Collection'),
    minAge: minAgeSchema.nullable(),
  }),
  // Shopify tags: up to 255 characters, no commas.
  z.object({
    type: z.literal('tag'),
    tag: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^,]+$/, 'Tags cannot contain commas'),
    minAge: minAgeSchema.nullable(),
  }),
]);
export type NewRule = z.infer<typeof newRuleSchema>;

/** Rules per shop; keeps a sync run (one queue message per rule page) bounded. */
export const MAX_RULES = 250;

export class RuleError extends Error {
  override name = 'RuleError';
  constructor(
    readonly code: 'rule_limit' | 'rule_exists',
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

interface RuleRow {
  id: string;
  type: RuleType;
  resource_gid: string | null;
  tag: string | null;
  min_age: MinAge | null;
  created_at: number;
}

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  type: r.type,
  resourceGid: r.resource_gid,
  tag: r.tag,
  minAge: r.min_age,
  createdAt: r.created_at,
});

/** All rules of a shop, oldest first (the sync run walks them in this order). */
export async function listRules(db: D1Database, shop: string): Promise<Rule[]> {
  const { results } = await db
    .prepare(
      `SELECT id, type, resource_gid, tag, min_age, created_at FROM restricted_rules
        WHERE shop = ?1 ORDER BY created_at, id`,
    )
    .bind(shop)
    .all<RuleRow>();
  return results.map(toRule);
}

/** Adds rules (skipping exact duplicates of existing ones). Returns the rules that were added. */
export async function addRules(db: D1Database, shop: string, rules: NewRule[], now: number): Promise<Rule[]> {
  const existing = await listRules(db, shop);
  const key = (r: { type: RuleType; resourceGid?: string | null; tag?: string | null }) =>
    `${r.type}|${r.type === 'tag' ? (r.tag ?? '').toLowerCase() : r.resourceGid}`;
  const seen = new Set(existing.map(key));
  const added: Rule[] = [];
  for (const rule of rules) {
    const k = key(rule);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push({
      id: crypto.randomUUID(),
      type: rule.type,
      resourceGid: rule.type === 'tag' ? null : rule.resourceGid,
      tag: rule.type === 'tag' ? rule.tag : null,
      minAge: rule.minAge,
      createdAt: now,
    });
  }
  if (existing.length + added.length > MAX_RULES) {
    throw new RuleError('rule_limit', 400, `A shop can have at most ${MAX_RULES} rules`);
  }
  if (added.length > 0) {
    await db.batch(
      added.map((r) =>
        db
          .prepare(
            `INSERT INTO restricted_rules (id, shop, type, resource_gid, tag, min_age, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(r.id, shop, r.type, r.resourceGid, r.tag, r.minAge, r.createdAt),
      ),
    );
  }
  return added;
}

/** Deletes a rule; false if it doesn't exist (or belongs to another shop). */
export async function deleteRule(db: D1Database, shop: string, id: string): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM restricted_rules WHERE shop = ?1 AND id = ?2')
    .bind(shop, id)
    .run();
  return res.meta.changes > 0;
}

/**
 * Starts a sync run: a `jobs` row (type rules_sync) plus the first queue message. Earlier unfinished runs are marked
 * cancelled; their remaining messages notice that they are no longer the latest run and stop.
 */
export async function startRulesSync(env: Env, shop: string, now: number): Promise<string> {
  const jobId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = 'cancelled', updated_at = ?2
        WHERE shop = ?1 AND type = 'rules_sync' AND status IN ('queued', 'running')`,
    ).bind(shop, now),
    env.DB.prepare(
      `INSERT INTO jobs (id, shop, type, status, total, processed, created_at, updated_at)
       VALUES (?1, ?2, 'rules_sync', 'queued', 0, 0, ?3, ?3)`,
    ).bind(jobId, shop, now),
  ]);
  await env.JOBS.send({
    type: 'rules/sync',
    shop,
    payload: { jobId, phase: 'collect', ruleIndex: 0, after: null },
  });
  return jobId;
}
