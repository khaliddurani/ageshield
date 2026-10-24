import { useCallback, useEffect, useState } from 'react';
import { getThemeStatus, type ThemeStatus } from '../api/me';
import { ErrorBanner, Loading } from '../components/common';
import { t } from '../i18n';

// Dashboard: is the Age gate app embed enabled in the live theme? The deep link opens the theme editor's App embeds
// panel with the Age gate switched on; the merchant still has to save the theme.

export type ThemeState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; theme: ThemeStatus };

/** Theme status, loaded once by the Dashboard and shared with the setup checklist. `enabled = false` skips it. */
export function useThemeStatus(enabled = true): { state: ThemeState; recheck: () => void } {
  const [state, setState] = useState<ThemeState>({ status: 'loading' });
  const load = useCallback(
    () =>
      getThemeStatus().then(
        (theme) => setState({ status: 'ready', theme }),
        () => setState({ status: 'error' }),
      ),
    [],
  );
  useEffect(() => {
    if (enabled) void load();
  }, [load, enabled]);
  const recheck = useCallback(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);
  return { state, recheck };
}

export function ThemeStatusCard({ state, onRecheck }: { state: ThemeState; onRecheck: () => void }) {
  return (
    <s-section heading={t('theme.heading')}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorBanner heading={t('theme.loadError')} onRetry={onRecheck} />}
      {state.status === 'ready' && <ThemeStatusBody theme={state.theme} onRecheck={onRecheck} />}
    </s-section>
  );
}

function ThemeStatusBody({ theme, onRecheck }: { theme: ThemeStatus; onRecheck: () => void }) {
  return (
    <s-stack direction="block" gap="base">
      <s-paragraph color="subdued">{t('theme.liveTheme', { theme: theme.themeName ?? '—' })}</s-paragraph>
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-text type="strong">{t('theme.ageGate')}</s-text>
        <s-badge tone={theme.enabled ? 'success' : 'warning'}>
          {theme.enabled ? t('theme.enabled') : t('theme.notEnabled')}
        </s-badge>
      </s-stack>
      <s-paragraph>{theme.enabled ? t('theme.enabledBody') : t('theme.notEnabledBody')}</s-paragraph>
      <s-stack direction="inline" gap="base">
        {!theme.enabled && (
          // Opens the Shopify theme editor in the admin (top frame), with the app embed switched on.
          <s-button variant="primary" onClick={() => window.open(theme.activateUrl, '_top')}>
            {t('theme.enable')}
          </s-button>
        )}
        <s-button onClick={onRecheck}>{t('theme.recheck')}</s-button>
      </s-stack>
    </s-stack>
  );
}
