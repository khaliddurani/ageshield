import type { Env } from '../env';
import type { AdminClient } from '../lib/shopify/admin';
import { planForHandle, type PlanName } from './plans';

// Billing (ARCHITECTURE §8, Shopify App Pricing). The plan is read with the Admin API and the existing offline token
// (currentAppInstallation.activeSubscriptions → line item planHandle), not the Partner API (decision 2026-10-11:
// no organization-wide Partner API secret). Plans are matched by handle, never by name (names get translated).
// This is the only place that reads subscriptions, so switching the source later changes this file only.
// Sync: on app load (if older than 5 min), on return from the plan page (?plan_handle), daily cron, app/uninstalled.

export interface SubscriptionInfo {
  id: string;
  name: string;
  status: string;
  test: boolean;
  trialDays: number;
  createdAt: string;
  currentPeriodEnd: string | null;
  /** App Pricing plan handle of the recurring line item (null if the plan was deleted or it isn't App Pricing). */
  planHandle: string | null;
}

const SUBSCRIPTION_FIELDS = `
  id name status test trialDays createdAt currentPeriodEnd
  lineItems {
    plan {
      pricingDetails {
        __typename
        ... on AppRecurringPricing { planHandle interval price { amount currencyCode } }
      }
    }
  }
`;

const SUBSCRIPTIONS_QUERY = `#graphql
  query BillingSubscriptions {
    currentAppInstallation {
      activeSubscriptions { ${SUBSCRIPTION_FIELDS} }
    }
  }
`;

interface SubscriptionNode {
  id: string;
  name: string;
  status: string;
  test: boolean;
  trialDays: number;
  createdAt: string;
  currentPeriodEnd: string | null;
  lineItems: { plan: { pricingDetails: { __typename: string; planHandle?: string | null } } }[];
}

function toInfo(node: SubscriptionNode): SubscriptionInfo {
  const recurring = node.lineItems.find((l) => l.plan.pricingDetails.__typename === 'AppRecurringPricing');
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    test: node.test,
    trialDays: node.trialDays,
    createdAt: node.createdAt,
    currentPeriodEnd: node.currentPeriodEnd,
    planHandle: recurring?.plan.pricingDetails.planHandle ?? null,
  };
}

export async function readSubscriptions(admin: AdminClient): Promise<{ active: SubscriptionInfo[] }> {
  const data = await admin.graphql<{
    currentAppInstallation: {
      activeSubscriptions: SubscriptionNode[];
    };
  }>(SUBSCRIPTIONS_QUERY);
  return {
    active: data.currentAppInstallation.activeSubscriptions.map(toInfo),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Which plan applies (pure)

const DAY_MS = 86_400_000;

export interface ActivePlan {
  plan: PlanName;
  handle: string | null;
  subscriptionId: string | null;
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
}

export const FREE: ActivePlan = {
  plan: 'free',
  handle: null,
  subscriptionId: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
};

/**
 * The plan from the shop's subscriptions, as staging showed Shopify returns them (2026-10-11): Free and paid plans are
 * both subscriptions with a planHandle; a downgrade cancels the old one; uninstalling cancels all. Only an ACTIVE
 * subscription counts (newest wins); no active subscription, an unknown/null handle or any other status → Free.
 */
export function activePlan(subscriptions: SubscriptionInfo[]): ActivePlan {
  const active = subscriptions
    .filter((s) => s.status === 'ACTIVE')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!active) return FREE;
  const created = Date.parse(active.createdAt);
  return {
    plan: planForHandle(active.planHandle),
    handle: active.planHandle,
    subscriptionId: active.id,
    trialEndsAt: active.trialDays > 0 ? created + active.trialDays * DAY_MS : null,
    currentPeriodEnd: active.currentPeriodEnd ? Date.parse(active.currentPeriodEnd) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Sync shops.plan from Shopify

/** App loads re-check the plan when the last sync is older than this. */
export const SYNC_MAX_AGE_MS = 5 * 60_000;

/**
 * Reads the shop's subscriptions and stores the plan. Only a successful read changes anything: an API error throws
 * and the stored plan stays (a Shopify hiccup must never downgrade a paying shop). Plan changes go to audit_log.
 */
export async function syncPlan(
  db: D1Database,
  admin: AdminClient,
  shop: string,
  now: number,
): Promise<ActivePlan> {
  const { active } = await readSubscriptions(admin);
  const next = activePlan(active);
  const before = await db
    .prepare('SELECT plan FROM shops WHERE shop = ?1')
    .bind(shop)
    .first<{ plan: string }>();
  if (!before) return next;
  const statements = [
    db
      .prepare(
        `UPDATE shops SET plan = ?2, plan_handle = ?3, subscription_id = ?4, trial_ends_at = ?5,
           current_period_end = ?6, plan_synced_at = ?7
         WHERE shop = ?1`,
      )
      .bind(shop, next.plan, next.handle, next.subscriptionId, next.trialEndsAt, next.currentPeriodEnd, now),
  ];
  if (before.plan !== next.plan) {
    statements.push(
      db
        .prepare('INSERT INTO audit_log (id, shop, action, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(
          crypto.randomUUID(),
          shop,
          'plan_changed',
          JSON.stringify({
            from: before.plan,
            to: next.plan,
            handle: next.handle,
            subscriptionId: next.subscriptionId,
          }),
          now,
        ),
    );
  }
  await db.batch(statements);
  return next;
}

/** App load: sync when the stored plan is older than SYNC_MAX_AGE_MS. Errors are logged, never thrown. */
export async function syncPlanIfStale(
  db: D1Database,
  admin: AdminClient,
  shop: string,
  now: number,
): Promise<void> {
  const row = await db
    .prepare('SELECT plan_synced_at FROM shops WHERE shop = ?1')
    .bind(shop)
    .first<{ plan_synced_at: number | null }>();
  if (!row || (row.plan_synced_at !== null && now - row.plan_synced_at < SYNC_MAX_AGE_MS)) return;
  try {
    await syncPlan(db, admin, shop, now);
  } catch (err) {
    console.error(
      `plan sync ${shop} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown'}`,
    );
  }
}

/**
 * Daily cron: one billing/sync job per installed shop (catches changes made outside the app, e.g. a frozen
 * subscription). Returns the number of jobs queued.
 */
export async function queuePlanSyncs(env: Env): Promise<{ shops: number }> {
  const { results } = await env.DB.prepare(
    'SELECT shop FROM shops WHERE uninstalled_at IS NULL AND access_token_enc IS NOT NULL',
  ).all<{ shop: string }>();
  const messages = results.map((r) => ({ body: { type: 'billing/sync', shop: r.shop, payload: {} } }));
  for (let i = 0; i < messages.length; i += 100) await env.JOBS.sendBatch(messages.slice(i, i + 100));
  return { shops: results.length };
}

/** app/uninstalled: Shopify cancels the subscription, so the shop is on Free until it chooses a plan again. */
export function freePlanStatement(db: D1Database, shop: string) {
  return db
    .prepare(
      `UPDATE shops SET plan = 'free', plan_handle = NULL, subscription_id = NULL, trial_ends_at = NULL,
         current_period_end = NULL WHERE shop = ?1`,
    )
    .bind(shop);
}

// ---------------------------------------------------------------------------------------------------------------
// Usage

/** First day of the calendar month (UTC) of `now`. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
