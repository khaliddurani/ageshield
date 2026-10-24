import { useEffect, useState } from 'react';
import { billingApi, openPlanPage, type LimitKind, type PlanName } from '../api/billing';
import { ApiError } from '../api/client';
import { t, uiLocale, type MessageKey } from '../i18n';
import { navigate } from '../router';
import { flag } from './fields';

// One notice for every plan limit: says which limit applies, which plan includes more, and links to Shopify's plan
// selection page. Shown inline (never as a modal) — before an action when the app already knows the limit applies,
// and after the API refused an action with a plan_* error. (Limits are enforced from Phase 3.)

const HEADING: Record<LimitKind, MessageKey> = {
  monthly_verifications: 'plans.limitMonthlyVerificationsHeading',
};

const BODY: Record<LimitKind, MessageKey> = {
  monthly_verifications: 'plans.limitMonthlyVerificationsBody',
};

export const PLAN_NAME: Record<PlanName, MessageKey> = {
  free: 'plans.nameFree',
  starter: 'plans.nameStarter',
  pro: 'plans.namePro',
};

/** API error code → limit kind. */
const KIND_BY_CODE: Record<string, LimitKind> = {
  plan_monthly_verifications: 'monthly_verifications',
};

export interface PlanLimit {
  kind: LimitKind;
  values: Record<string, string | number>;
  requiredPlan?: PlanName | null;
}

/** The plan limit an API error is about, or null for other errors. */
export function planLimitFromError(err: unknown): PlanLimit | null {
  if (!(err instanceof ApiError) || !err.code) return null;
  const kind = KIND_BY_CODE[err.code];
  if (!kind) return null;
  const values: Record<string, string | number> = {};
  for (const key of ['limit', 'used']) {
    const v = err.details[key];
    if (typeof v === 'number') values[key] = v;
  }
  const required = err.details['requiredPlan'];
  return {
    kind,
    values,
    requiredPlan: required === 'free' || required === 'starter' || required === 'pro' ? required : null,
  };
}

const numbers = new Intl.NumberFormat(uiLocale);

export function PlanLimitNotice(props: PlanLimit & { tone?: 'info' | 'warning' }) {
  const values = Object.fromEntries(
    Object.entries(props.values).map(([k, v]) => [k, typeof v === 'number' ? numbers.format(v) : v]),
  );
  // Without an explicit plan (e.g. a notice shown before any API call), take it from the plan config on the server.
  const [fromConfig, setFromConfig] = useState<PlanName | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (props.requiredPlan !== undefined) return;
    let cancelled = false;
    billingApi.get().then(
      (s) => !cancelled && setFromConfig(s.requiredPlans[props.kind]),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [props.kind, props.requiredPlan]);
  const plan = props.requiredPlan !== undefined ? props.requiredPlan : fromConfig;

  const change = () => {
    setOpening(true);
    openPlanPage().catch(() => {
      setOpening(false);
      shopify.toast.show(t('plans.openFailed'), { isError: true });
    });
  };

  return (
    <s-banner tone={props.tone ?? 'warning'} heading={t(HEADING[props.kind], values)}>
      <s-paragraph>{t(BODY[props.kind], values)}</s-paragraph>
      {plan && plan !== 'free' && (
        <s-paragraph>{t('plans.includedIn', { plan: t(PLAN_NAME[plan]) })}</s-paragraph>
      )}
      {!plan && <s-paragraph>{t('plans.monthlyResets')}</s-paragraph>}
      <s-button variant="primary" loading={flag(opening)} onClick={change}>
        {t('plans.changePlan')}
      </s-button>
      <s-button variant="tertiary" onClick={() => navigate('/plans')}>
        {t('plans.comparePlans')}
      </s-button>
    </s-banner>
  );
}
