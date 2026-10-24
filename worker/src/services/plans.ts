// Plans (Shopify App Pricing). The single source of truth for plan names, handles, prices, trials and limits: the
// Plans page shows it (GET /api/billing) and server-side enforcement will use it.
//
// PLACEHOLDER (Phase 1): names, prices and limits are not decided yet and nothing is enforced. Phase 3 (docs/BUILD_PLAN.md)
// sets the real plans; they must then match the Partner Dashboard App Pricing plans and the App Store listing.

export type PlanName = 'free' | 'starter' | 'pro';

export interface PlanLimits {
  /**
   * Completed age verifications per calendar month (UTC). Always a number: every verification costs us an Idura
   * transaction, so no plan is ever unlimited.
   */
  maxVerificationsPerMonth: number;
  prioritySupport: boolean;
}

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free: { maxVerificationsPerMonth: 50, prioritySupport: false },
  starter: { maxVerificationsPerMonth: 1000, prioritySupport: false },
  pro: { maxVerificationsPerMonth: 5000, prioritySupport: true },
};

/**
 * The plan a shop is limited by: `shops.plan` from D1 (default 'free'); unknown values count as Free.
 * services/billing.ts keeps the column in sync with the shop's Shopify App Pricing subscription.
 */
export function effectivePlan(storedPlan: string | null): PlanName {
  return storedPlan !== null && Object.hasOwn(PLAN_LIMITS, storedPlan) ? (storedPlan as PlanName) : 'free';
}

export function limitsFor(storedPlan: string | null): PlanLimits {
  return PLAN_LIMITS[effectivePlan(storedPlan)];
}

/** One line of a plan's feature list: a stable id (UI translations) and the exact English listing text. */
export interface PlanFeature {
  id: string;
  en: string;
}

export interface PlanInfoConfig {
  name: PlanName;
  /** App Pricing plan handle (Partner Dashboard). */
  handle: string;
  /** USD per month. */
  priceUsd: number;
  trialDays: number;
  /** Feature list exactly as in the App Store listing; da/sv translate them by id (web/src/locales, planFeatures). */
  features: readonly PlanFeature[];
}

/** Plans in display order. Prices are never part of a plan name (App Store requirement). */
export const PLANS: readonly PlanInfoConfig[] = [
  {
    name: 'free',
    handle: 'free',
    priceUsd: 0,
    trialDays: 0,
    features: [
      { id: 'verifications50', en: '50 age verifications per month' },
      { id: 'allCountries', en: 'MitID, BankID (SE/NO) and Finnish Trust Network' },
    ],
  },
  {
    name: 'starter',
    handle: 'starter',
    priceUsd: 9.99,
    trialDays: 7,
    features: [
      { id: 'verifications1000', en: '1,000 age verifications per month' },
      { id: 'allCountries', en: 'MitID, BankID (SE/NO) and Finnish Trust Network' },
      { id: 'trial7', en: '7-day free trial' },
    ],
  },
  {
    name: 'pro',
    handle: 'pro',
    priceUsd: 29.99,
    trialDays: 7,
    features: [
      { id: 'verifications5000', en: '5,000 age verifications per month' },
      { id: 'prioritySupport', en: 'Priority support' },
      { id: 'trial7', en: '7-day free trial' },
    ],
  },
];

/** App Pricing handle → plan. Unknown, missing or deleted-plan (null) handles count as Free. */
export function planForHandle(handle: string | null | undefined): PlanName {
  return PLANS.find((p) => p.handle === handle)?.name ?? 'free';
}

/** Cheapest plan that passes `test` (for "included in …" messages). */
export function cheapestPlanWith(test: (limits: PlanLimits) => boolean): PlanName | null {
  return PLANS.find((p) => test(PLAN_LIMITS[p.name]))?.name ?? null;
}

/** Cheapest plan *above* `current` that passes `test`. */
export function upgradeWith(current: PlanName, test: (limits: PlanLimits) => boolean): PlanName | null {
  const above = PLANS.slice(PLANS.findIndex((p) => p.name === current) + 1);
  return above.find((p) => test(PLAN_LIMITS[p.name]))?.name ?? null;
}

/** Plan limits the app explains with an "upgrade" notice. */
export const LIMIT_KINDS = ['monthly_verifications'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** Cheapest plan above `current` with a higher monthly verification limit. */
export function requiredPlans(current: PlanName): Record<LimitKind, PlanName | null> {
  const monthly = PLAN_LIMITS[current].maxVerificationsPerMonth;
  return {
    monthly_verifications: upgradeWith(current, (l) => l.maxVerificationsPerMonth > monthly),
  };
}
