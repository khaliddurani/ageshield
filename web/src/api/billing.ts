import { api } from './client';

// Mirrors worker/src/services/billing-summary.ts and plans.ts (the plan config lives in the worker only).

export type PlanName = 'free' | 'starter' | 'pro';

export type LimitKind = 'monthly_verifications';

export interface PlanLimits {
  /** Never unlimited (each verification is a paid Idura transaction). */
  maxVerificationsPerMonth: number;
  prioritySupport: boolean;
}

/** Exact App Store listing text (en) with an id for translations. */
export interface PlanFeature {
  id: string;
  en: string;
}

export interface BillingSummary {
  plans: {
    name: PlanName;
    priceUsd: number;
    trialDays: number;
    limits: PlanLimits;
    features: PlanFeature[];
  }[];
  current: {
    plan: PlanName;
    trialEndsAt: number | null;
    currentPeriodEnd: number | null;
    syncedAt: number | null;
  };
  planPageUrl: string;
  requiredPlans: Record<LimitKind, PlanName | null>;
  /** POST /sync only: false when Shopify couldn't be reached (the stored plan is shown). */
  synced?: boolean;
}

let cached: Promise<BillingSummary> | null = null;

export const billingApi = {
  /** Cached for the page session; refreshed by sync(). */
  get: (): Promise<BillingSummary> => {
    cached ??= api<BillingSummary>('/api/billing').catch((err: unknown) => {
      cached = null;
      throw err;
    });
    return cached;
  },
  /** Re-read the plan from Shopify (Plans page). */
  sync: async (): Promise<BillingSummary> => {
    const summary = await api<BillingSummary>('/api/billing/sync', { method: 'POST' });
    cached = Promise.resolve(summary);
    return summary;
  },
};

/** Opens Shopify's plan selection page in the top frame (Shopify App Pricing; required for embedded apps). */
export async function openPlanPage(): Promise<void> {
  const { planPageUrl } = await billingApi.get();
  window.open(planPageUrl, '_top');
}
