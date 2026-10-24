import type { Env } from '../env';
import { storeHandle } from '../lib/shopify/shop';
import {
  PLAN_LIMITS,
  PLANS,
  effectivePlan,
  requiredPlans,
  type LimitKind,
  type PlanFeature,
  type PlanLimits,
  type PlanName,
} from './plans';

// GET /api/billing: everything the Plans page shows (plans from the config, the shop's plan and usage).

export interface BillingSummary {
  plans: {
    name: PlanName;
    priceUsd: number;
    trialDays: number;
    limits: PlanLimits;
    features: readonly PlanFeature[];
  }[];
  current: {
    plan: PlanName;
    trialEndsAt: number | null;
    currentPeriodEnd: number | null;
    syncedAt: number | null;
  };
  /** Shopify's plan selection page (opened in the top frame). */
  planPageUrl: string;
  /** Cheapest plan that lifts each limit, for upgrade notices. */
  requiredPlans: Record<LimitKind, PlanName | null>;
}

/** https://admin.shopify.com/store/{store}/charges/{app handle}/pricing_plans */
export function planPageUrl(shop: string, appHandle: string): string {
  return `https://admin.shopify.com/store/${storeHandle(shop)}/charges/${appHandle}/pricing_plans`;
}

export async function billingSummary(env: Env, shop: string, now: number): Promise<BillingSummary> {
  const row = await env.DB.prepare(
    'SELECT plan, trial_ends_at, current_period_end, plan_synced_at FROM shops WHERE shop = ?1',
  )
    .bind(shop)
    .first<{
      plan: string | null;
      trial_ends_at: number | null;
      current_period_end: number | null;
      plan_synced_at: number | null;
    }>();
  const plan = effectivePlan(row?.plan ?? null);
  return {
    plans: PLANS.map((p) => ({
      name: p.name,
      priceUsd: p.priceUsd,
      trialDays: p.trialDays,
      limits: PLAN_LIMITS[p.name],
      features: p.features,
    })),
    current: {
      plan,
      // A trial that has ended is no longer shown as one.
      trialEndsAt: row?.trial_ends_at && row.trial_ends_at > now ? row.trial_ends_at : null,
      currentPeriodEnd: plan === 'free' ? null : (row?.current_period_end ?? null),
      syncedAt: row?.plan_synced_at ?? null,
    },
    planPageUrl: planPageUrl(shop, env.SHOPIFY_APP_HANDLE),
    requiredPlans: requiredPlans(plan),
  };
}
