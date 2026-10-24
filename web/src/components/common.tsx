import { useEffect, useRef } from 'react';
import { t } from '../i18n';

export function Loading() {
  return (
    <s-section>
      <s-stack direction="inline" justifyContent="center">
        <s-spinner accessibilityLabel={t('common.loading')} size="large" />
      </s-stack>
    </s-section>
  );
}

export function ErrorBanner(props: { onRetry: () => void; heading?: string; body?: string }) {
  return (
    <s-banner tone="critical" heading={props.heading ?? t('common.errorHeading')}>
      <s-paragraph>{props.body ?? t('common.errorBody')}</s-paragraph>
      <s-button onClick={props.onRetry}>{t('common.retry')}</s-button>
    </s-banner>
  );
}

/** Dates in the store's time zone (see time.ts). */
export { formatDate, formatDateTime } from '../time';

/** Calls `fn` every `ms` while `active`. */
export function usePolling(fn: () => void, ms: number, active: boolean) {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => latest.current(), ms);
    return () => window.clearInterval(timer);
  }, [ms, active]);
}
