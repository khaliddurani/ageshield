import { useCallback, useEffect, useState } from 'react';
import { getDashboard, type DashboardSummary, type VerificationResult } from '../api/admin';
import { ErrorBanner, Loading } from '../components/common';
import { t, uiLocale, type MessageKey } from '../i18n';
import { resultLabel } from '../labels';
import { navigate } from '../router';
import { ThemeStatusCard, useThemeStatus, type ThemeState } from './ThemeStatusCard';

// Dashboard: setup checklist (app embed enabled, countries chosen, rules added, test verification done), the last
// 30 days of verifications, and the app embed status with a theme-editor deep link.

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; summary: DashboardSummary };

const numbers = new Intl.NumberFormat(uiLocale);
const RESULTS: VerificationResult[] = ['verified', 'rejected', 'cancelled', 'error'];

interface Step {
  done: boolean;
  label: MessageKey;
  help: MessageKey;
  action?: { label: MessageKey; run: () => void };
}

export function setupSteps(summary: DashboardSummary, theme: ThemeState): Step[] {
  const embedEnabled = theme.status === 'ready' && theme.theme.enabled;
  return [
    {
      done: embedEnabled,
      label: 'dashboard.stepEmbed',
      help: 'dashboard.stepEmbedHelp',
      action:
        theme.status === 'ready' && !embedEnabled
          ? { label: 'theme.enable', run: () => window.open(theme.theme.activateUrl, '_top') }
          : undefined,
    },
    {
      done: summary.setup.settingsSaved,
      label: 'dashboard.stepCountries',
      help: 'dashboard.stepCountriesHelp',
      action: { label: 'dashboard.openSettings', run: () => navigate('/settings') },
    },
    {
      done: summary.setup.rulesAdded,
      label: 'dashboard.stepRules',
      help: 'dashboard.stepRulesHelp',
      action: { label: 'dashboard.openRules', run: () => navigate('/restricted-products') },
    },
    {
      done: summary.setup.verificationDone,
      label: 'dashboard.stepTest',
      help: 'dashboard.stepTestHelp',
    },
  ];
}

export function Dashboard() {
  const theme = useThemeStatus();
  const [state, setState] = useState<State>({ status: 'loading' });
  // State is only set in the request callbacks; a retry shows the spinner first (event handler).
  const fetchSummary = useCallback(() => {
    getDashboard().then(
      (summary) => setState({ status: 'ready', summary }),
      () => setState({ status: 'error' }),
    );
  }, []);
  useEffect(fetchSummary, [fetchSummary]);
  const retry = () => {
    setState({ status: 'loading' });
    fetchSummary();
  };

  if (state.status !== 'ready') {
    return (
      <s-page heading={t('dashboard.heading')}>
        {state.status === 'error' ? <ErrorBanner onRetry={retry} /> : <Loading />}
      </s-page>
    );
  }

  const { summary } = state;
  const steps = setupSteps(summary, theme.state);
  const done = steps.filter((s) => s.done).length;

  return (
    <s-page heading={t('dashboard.heading')}>
      {done < steps.length && (
        <s-section heading={t('dashboard.setupHeading', { done, total: steps.length })}>
          <s-stack direction="block" gap="base">
            {steps.map((step) => (
              <s-stack
                key={step.label}
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-stack direction="block" gap="small-300">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-badge tone={step.done ? 'success' : 'neutral'}>
                      {step.done ? t('dashboard.stepDone') : t('dashboard.stepTodo')}
                    </s-badge>
                    <s-text type="strong">{t(step.label)}</s-text>
                  </s-stack>
                  <s-paragraph color="subdued">{t(step.help)}</s-paragraph>
                </s-stack>
                {!step.done && step.action && (
                  <s-button onClick={step.action.run}>{t(step.action.label)}</s-button>
                )}
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading={t('dashboard.statsHeading')}>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
          {RESULTS.map((result) => (
            <s-box key={result} padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-text color="subdued">{resultLabel(result)}</s-text>
                <s-heading>{numbers.format(summary.last30Days[result])}</s-heading>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
        <s-paragraph color="subdued">
          {t('dashboard.restrictedProducts', { count: summary.restrictedProducts })}
        </s-paragraph>
      </s-section>

      <ThemeStatusCard state={theme.state} onRecheck={theme.recheck} />
    </s-page>
  );
}
