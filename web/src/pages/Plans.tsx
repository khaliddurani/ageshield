import { useCallback, useEffect, useState } from 'react';
import { billingApi, openPlanPage, type BillingSummary, type PlanFeature } from '../api/billing';
import { ErrorBanner, formatDate, formatDateTime, Loading } from '../components/common';
import { flag } from '../components/fields';
import { PLAN_NAME } from '../components/PlanLimitNotice';
import { t, uiLocale, type MessageKey } from '../i18n';

// Plans (Shopify App Pricing): current plan, what's included, and "Change plan", which opens Shopify's plan selection
// page in the top frame. Opening this page re-reads the plan from Shopify; that's also where Shopify sends merchants
// back after choosing a plan (welcome link /plans?plan_handle=…&charge_id=…).

/** Removes Shopify's return parameters so they don't stick to later in-app navigations. */
function dropReturnParams() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('plan_handle') && !params.has('charge_id')) return;
  params.delete('plan_handle');
  params.delete('charge_id');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

const usd = new Intl.NumberFormat(uiLocale, { style: 'currency', currency: 'USD' });

/**
 * A plan feature line: the exact App Store listing text from the plan config (worker plans.ts), translated by id for
 * da/sv (locales, section planFeatures); falls back to the listing English.
 */
export function featureText(feature: PlanFeature): string {
  const key = `planFeatures.${feature.id}` as MessageKey;
  const text = t(key);
  return text === key ? feature.en : text;
}

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; billing: BillingSummary };

export function Plans() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [opening, setOpening] = useState(false);

  // Re-read the plan from Shopify on every visit (also when Shopify sends the merchant back after a plan change).
  const load = useCallback(
    () =>
      billingApi.sync().then(
        (billing) => {
          dropReturnParams();
          setState({ status: 'ready', billing });
        },
        () => setState({ status: 'error' }),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const change = () => {
    setOpening(true);
    openPlanPage().catch(() => {
      setOpening(false);
      shopify.toast.show(t('plans.openFailed'), { isError: true });
    });
  };

  if (state.status !== 'ready') {
    return (
      <s-page heading={t('plans.heading')}>
        {state.status === 'loading' ? (
          <Loading />
        ) : (
          <ErrorBanner
            onRetry={() => {
              setState({ status: 'loading' });
              void load();
            }}
          />
        )}
      </s-page>
    );
  }

  const { billing } = state;

  return (
    <s-page heading={t('plans.heading')}>
      <s-button slot="primary-action" variant="primary" loading={flag(opening)} onClick={change}>
        {t('plans.changePlan')}
      </s-button>

      {billing.synced === false && (
        <s-banner tone="warning">
          <s-paragraph>
            {t('plans.syncFailed', {
              date: billing.current.syncedAt ? formatDateTime(billing.current.syncedAt) : '—',
            })}
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading={t('plans.currentHeading')}>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text type="strong">{t(PLAN_NAME[billing.current.plan])}</s-text>
            {billing.current.trialEndsAt !== null && <s-badge tone="info">{t('plans.trialBadge')}</s-badge>}
          </s-stack>
          {billing.current.trialEndsAt !== null ? (
            <s-paragraph>
              {t('plans.trialEnds', { date: formatDate(billing.current.trialEndsAt) })}
            </s-paragraph>
          ) : (
            billing.current.currentPeriodEnd !== null && (
              <s-paragraph>
                {t('plans.periodEnds', { date: formatDate(billing.current.currentPeriodEnd) })}
              </s-paragraph>
            )
          )}
          <s-paragraph color="subdued">{t('plans.changeHelp')}</s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading={t('plans.compareHeading')}>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
          {billing.plans.map((plan) => (
            <s-box key={plan.name} padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text type="strong">{t(PLAN_NAME[plan.name])}</s-text>
                  {plan.name === billing.current.plan && (
                    <s-badge tone="success">{t('plans.currentBadge')}</s-badge>
                  )}
                </s-stack>
                <s-paragraph>
                  {plan.priceUsd === 0
                    ? t('plans.priceFree')
                    : t('plans.pricePerMonth', { price: usd.format(plan.priceUsd) })}
                </s-paragraph>
                <s-unordered-list>
                  {plan.features.map((f) => (
                    <s-list-item key={f.id}>{featureText(f)}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <s-section>
        <s-paragraph color="subdued">{t('plans.downgradeNote')}</s-paragraph>
      </s-section>
    </s-page>
  );
}
