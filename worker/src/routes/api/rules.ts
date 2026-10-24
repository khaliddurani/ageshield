import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../../env';
import { adminClientForShop, type AdminClient } from '../../lib/shopify/admin';
import { restrictionStatus } from '../../services/restriction-sync';
import {
  addRules,
  deleteRule,
  listRules,
  MAX_RULES,
  newRuleSchema,
  startRulesSync,
  type Rule,
} from '../../services/rules';

// /api/rules — Restricted products page. Every change starts a sync run (services/restriction-sync.ts).

const RESOURCE_TITLES_QUERY = `#graphql
  query AgeShieldRuleTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title }
      ... on Collection { id title }
    }
  }
`;

/** Titles for product/collection rules (null = deleted in Shopify). Never blocks the page: errors → no titles. */
async function resourceTitles(admin: AdminClient, rules: Rule[]): Promise<Record<string, string | null>> {
  const ids = [...new Set(rules.flatMap((r) => (r.resourceGid ? [r.resourceGid] : [])))];
  const titles: Record<string, string | null> = {};
  try {
    for (let i = 0; i < ids.length; i += 250) {
      const chunk = ids.slice(i, i + 250);
      const data = await admin.graphql<{ nodes: ({ id?: string; title?: string } | null)[] }>(
        RESOURCE_TITLES_QUERY,
        { ids: chunk },
      );
      chunk.forEach((id, index) => (titles[id] = data.nodes[index]?.title ?? null));
    }
  } catch (err) {
    console.error(`rule titles failed: ${err instanceof Error ? err.name : 'error'}`);
  }
  return titles;
}

const addRulesBodySchema = z.object({ rules: z.array(newRuleSchema).min(1).max(MAX_RULES) });
const ruleIdSchema = z.string().uuid();

async function rulesPage(c: { env: AppBindings['Bindings']; shop: string; idToken: string }) {
  const rules = await listRules(c.env.DB, c.shop);
  const titles = await resourceTitles(adminClientForShop(c.env, c.shop, c.idToken), rules);
  return {
    rules: rules.map((r) => ({
      ...r,
      title: r.resourceGid ? (titles[r.resourceGid] ?? null) : null,
      resourceDeleted: r.resourceGid ? titles[r.resourceGid] === null : false,
    })),
    maxRules: MAX_RULES,
    ...(await restrictionStatus(c.env.DB, c.shop)),
  };
}

export const rulesRoutes = new Hono<AppBindings>()
  .get('/rules', async (c) =>
    c.json(await rulesPage({ env: c.env, shop: c.get('shop'), idToken: c.get('idToken') })),
  )
  /** Sync progress only (polled while a run is in progress; no Admin API call). */
  .get('/rules/status', async (c) => c.json(await restrictionStatus(c.env.DB, c.get('shop'))))
  .post('/rules', async (c) => {
    const shop = c.get('shop');
    const { rules } = addRulesBodySchema.parse(await c.req.json());
    const now = Date.now();
    const added = await addRules(c.env.DB, shop, rules, now);
    if (added.length > 0) await startRulesSync(c.env, shop, now);
    return c.json({
      added: added.length,
      ...(await rulesPage({ env: c.env, shop, idToken: c.get('idToken') })),
    });
  })
  .delete('/rules/:id', async (c) => {
    const shop = c.get('shop');
    const id = ruleIdSchema.safeParse(c.req.param('id'));
    if (!id.success || !(await deleteRule(c.env.DB, shop, id.data)))
      return c.json({ error: 'not_found' }, 404);
    await startRulesSync(c.env, shop, Date.now());
    return c.json(await rulesPage({ env: c.env, shop, idToken: c.get('idToken') }));
  })
  /** Re-run the sync (e.g. after a failed run). */
  .post('/rules/sync', async (c) => {
    await startRulesSync(c.env, c.get('shop'), Date.now());
    return c.json(await restrictionStatus(c.env.DB, c.get('shop')));
  });
