import { useCallback, useEffect, useState } from 'react';
import { listVerifications, type VerificationItem, type VerificationResult } from '../api/admin';
import { ErrorBanner, formatDateTime, Loading } from '../components/common';
import { flag, Select } from '../components/fields';
import { t } from '../i18n';
import { ageLabel, countryLabel, resultLabel, RESULT_TONE } from '../labels';

// Verifications: newest first, 25 per page, filter by result. No personal data exists to show: date, country,
// age threshold, result (and the error reason) only.

const ALL = 'all';
const RESULTS: VerificationResult[] = ['verified', 'rejected', 'cancelled', 'error'];

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; items: VerificationItem[]; nextCursor: string | null };

/** Readable reason for an error result (codes from the worker's verification flow). */
function errorReason(code: string | null): string | null {
  if (!code) return null;
  if (code === 'assurance_level') return t('verifications.reasonAssurance');
  if (code === 'state_expired') return t('verifications.reasonExpired');
  if (code === 'age_claim_missing' || code === 'country_mismatch') return t('verifications.reasonClaim');
  return t('verifications.reasonTechnical');
}

export function Verifications() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [filter, setFilter] = useState<string>(ALL);
  /** Cursors of the pages before the current one ([] = first page); `current` is this page's cursor. */
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  // The effect only fetches; the handlers that change page or filter show the spinner first.
  const fetchPage = useCallback((cursor: string | null, result: string) => {
    listVerifications(cursor, result === ALL ? null : (result as VerificationResult)).then(
      (page) => setState({ status: 'ready', ...page }),
      () => setState({ status: 'error' }),
    );
  }, []);
  useEffect(() => fetchPage(current, filter), [fetchPage, current, filter]);
  const load = (cursor: string | null, result: string) => {
    setState({ status: 'loading' });
    fetchPage(cursor, result);
  };

  const next = () => {
    if (state.status !== 'ready' || !state.nextCursor) return;
    setState({ status: 'loading' });
    setHistory((h) => [...h, current]);
    setCurrent(state.nextCursor);
  };
  const previous = () => {
    if (history.length === 0) return;
    setState({ status: 'loading' });
    setCurrent(history[history.length - 1] ?? null);
    setHistory(history.slice(0, -1));
  };

  return (
    <s-page heading={t('verifications.heading')}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">{t('verifications.privacyNote')}</s-paragraph>
          <Select
            label={t('verifications.filter')}
            value={filter}
            options={[
              { value: ALL, label: t('verifications.filterAll') },
              ...RESULTS.map((r) => ({ value: r, label: resultLabel(r) })),
            ]}
            onChange={(v) => {
              setState({ status: 'loading' });
              setHistory([]);
              setCurrent(null);
              setFilter(v);
            }}
          />
        </s-stack>
      </s-section>

      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorBanner onRetry={() => load(current, filter)} />}
      {state.status === 'ready' && state.items.length === 0 && (
        <s-section>
          <s-stack direction="block" gap="small-200">
            <s-heading>{t('verifications.emptyHeading')}</s-heading>
            <s-paragraph>{t('verifications.emptyBody')}</s-paragraph>
          </s-stack>
        </s-section>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <s-section padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header>{t('verifications.colDate')}</s-table-header>
              <s-table-header>{t('verifications.colCountry')}</s-table-header>
              <s-table-header>{t('verifications.colAge')}</s-table-header>
              <s-table-header>{t('verifications.colResult')}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {state.items.map((item) => (
                <s-table-row key={item.id}>
                  <s-table-cell>{formatDateTime(item.createdAt)}</s-table-cell>
                  <s-table-cell>{countryLabel(item.country)}</s-table-cell>
                  <s-table-cell>{ageLabel(item.minAge)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-badge tone={RESULT_TONE[item.result]}>{resultLabel(item.result)}</s-badge>
                      {item.result === 'error' && errorReason(item.errorCode) && (
                        <s-text color="subdued">{errorReason(item.errorCode)}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
      {state.status === 'ready' && (history.length > 0 || state.nextCursor) && (
        <s-section>
          <s-stack direction="inline" gap="base" justifyContent="center">
            <s-button disabled={flag(history.length === 0)} onClick={previous}>
              {t('verifications.previous')}
            </s-button>
            <s-button disabled={flag(!state.nextCursor)} onClick={next}>
              {t('verifications.next')}
            </s-button>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
