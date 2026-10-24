import { useCallback, useEffect, useState } from 'react';
import {
  MIN_AGES,
  addRules,
  deleteRule,
  getRules,
  getRulesStatus,
  resyncRules,
  type MinAge,
  type NewRule,
  type Rule,
  type RulesPage,
  type SyncStatus,
} from '../api/admin';
import { ApiError } from '../api/client';
import { ErrorBanner, formatDateTime, Loading, usePolling } from '../components/common';
import { flag, Select, TextField } from '../components/fields';
import { t } from '../i18n';
import { ageLabel } from '../labels';

// Restricted products: rules (products, collections, tags) → app-owned product metafield $app.age_restricted, synced
// by a background job. Shows the affected-product count and the sync status (polled while a run is in progress).

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; page: RulesPage };

const DEFAULT_AGE = 'default';
const TAG_RE = /^[^,]{1,255}$/;

function SyncBanner({ status, onRetry }: { status: SyncStatus; onRetry: () => void }) {
  const sync = status.sync;
  if (!sync || sync.status === 'cancelled') return null;
  if (sync.status === 'queued' || sync.status === 'running') {
    return (
      <s-banner tone="info" heading={t('rules.syncRunningHeading')}>
        <s-paragraph>{t('rules.syncRunningBody', { count: sync.processed })}</s-paragraph>
      </s-banner>
    );
  }
  if (sync.status === 'failed') {
    return (
      <s-banner tone="critical" heading={t('rules.syncFailedHeading')}>
        <s-paragraph>
          {sync.errorCode === 'not_authorized' ? t('rules.syncFailedAuth') : t('rules.syncFailedBody')}
        </s-paragraph>
        <s-button onClick={onRetry}>{t('rules.syncRetry')}</s-button>
      </s-banner>
    );
  }
  return (
    <s-paragraph color="subdued">{t('rules.syncDone', { date: formatDateTime(sync.updatedAt) })}</s-paragraph>
  );
}

function ruleTarget(rule: Rule): string {
  if (rule.type === 'tag') return rule.tag ?? '';
  if (rule.resourceDeleted) return t('rules.deletedResource');
  return rule.title ?? rule.resourceGid ?? '';
}

export function RestrictedProducts() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [age, setAge] = useState<string>(DEFAULT_AGE);
  const [tag, setTag] = useState('');
  const [tagError, setTagError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);

  // State is only set in the request callbacks; a retry shows the spinner first (event handler).
  const fetchRules = useCallback(() => {
    getRules().then(
      (page) => setState({ status: 'ready', page }),
      () => setState({ status: 'error' }),
    );
  }, []);
  useEffect(fetchRules, [fetchRules]);
  const load = () => {
    setState({ status: 'loading' });
    fetchRules();
  };

  const running =
    state.status === 'ready' &&
    (state.page.sync?.status === 'queued' || state.page.sync?.status === 'running');
  usePolling(
    () => {
      getRulesStatus().then(
        (status) =>
          setState((s) => (s.status === 'ready' ? { status: 'ready', page: { ...s.page, ...status } } : s)),
        () => undefined,
      );
    },
    3000,
    running,
  );

  const minAge = (): MinAge | null => (age === DEFAULT_AGE ? null : (Number(age) as MinAge));

  const submit = async (rules: NewRule[], key: string) => {
    if (rules.length === 0) return;
    setBusy(key);
    try {
      const page = await addRules(rules);
      setState({ status: 'ready', page });
      shopify.toast.show(page.added > 0 ? t('rules.added', { count: page.added }) : t('rules.nothingAdded'));
      return true;
    } catch (err) {
      const limit = err instanceof ApiError && err.code === 'rule_limit';
      shopify.toast.show(limit ? t('rules.limitReached') : t('rules.saveFailed'), { isError: true });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const pick = async (type: 'product' | 'collection') => {
    const selection = await shopify
      .resourcePicker({ type, multiple: true, action: 'select' })
      .catch(() => undefined);
    if (!selection) return;
    await submit(
      selection.map((r) => ({ type, resourceGid: r.id, minAge: minAge() })),
      type,
    );
  };

  const addTag = async () => {
    const value = tag.trim();
    if (!TAG_RE.test(value)) {
      setTagError(t('rules.tagInvalid'));
      return;
    }
    setTagError(undefined);
    if (await submit([{ type: 'tag', tag: value, minAge: minAge() }], 'tag')) setTag('');
  };

  const remove = async (rule: Rule) => {
    setBusy(rule.id);
    try {
      setState({ status: 'ready', page: await deleteRule(rule.id) });
      shopify.toast.show(t('rules.removed'));
    } catch {
      shopify.toast.show(t('rules.saveFailed'), { isError: true });
    } finally {
      setBusy(null);
    }
  };

  const retry = () => {
    resyncRules().then(
      (status) =>
        setState((s) => (s.status === 'ready' ? { status: 'ready', page: { ...s.page, ...status } } : s)),
      () => shopify.toast.show(t('rules.saveFailed'), { isError: true }),
    );
  };

  if (state.status !== 'ready') {
    return (
      <s-page heading={t('rules.heading')}>
        {state.status === 'error' ? <ErrorBanner onRetry={load} /> : <Loading />}
      </s-page>
    );
  }
  const { page } = state;
  const full = page.rules.length >= page.maxRules;

  return (
    <s-page heading={t('rules.heading')}>
      <s-section>
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">{t('rules.restrictedCount', { count: page.restrictedProducts })}</s-text>
          <SyncBanner status={page} onRetry={retry} />
        </s-stack>
      </s-section>

      <s-section heading={t('rules.addHeading')}>
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">{t('rules.addHelp')}</s-paragraph>
          <Select
            label={t('rules.ageForNew')}
            value={age}
            options={[
              { value: DEFAULT_AGE, label: t('rules.ageDefault') },
              ...MIN_AGES.map((a) => ({ value: String(a), label: ageLabel(a) })),
            ]}
            onChange={setAge}
          />
          <s-stack direction="inline" gap="base">
            <s-button
              disabled={flag(full)}
              loading={flag(busy === 'product')}
              onClick={() => void pick('product')}
            >
              {t('rules.addProducts')}
            </s-button>
            <s-button
              disabled={flag(full)}
              loading={flag(busy === 'collection')}
              onClick={() => void pick('collection')}
            >
              {t('rules.addCollections')}
            </s-button>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="end">
            <TextField
              label={t('rules.tagLabel')}
              placeholder={t('rules.tagPlaceholder')}
              value={tag}
              error={tagError}
              maxLength={255}
              onChange={setTag}
            />
            <s-button
              disabled={flag(full || !tag.trim())}
              loading={flag(busy === 'tag')}
              onClick={() => void addTag()}
            >
              {t('rules.addTag')}
            </s-button>
          </s-stack>
          {full && <s-text tone="caution">{t('rules.limitReached')}</s-text>}
        </s-stack>
      </s-section>

      {page.rules.length === 0 ? (
        <s-section>
          <s-stack direction="block" gap="small-200">
            <s-heading>{t('rules.emptyHeading')}</s-heading>
            <s-paragraph>{t('rules.emptyBody')}</s-paragraph>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header>{t('rules.colType')}</s-table-header>
              <s-table-header>{t('rules.colTarget')}</s-table-header>
              <s-table-header>{t('rules.colAge')}</s-table-header>
              <s-table-header />
            </s-table-header-row>
            <s-table-body>
              {page.rules.map((rule) => (
                <s-table-row key={rule.id}>
                  <s-table-cell>{t(`rules.type_${rule.type}`)}</s-table-cell>
                  <s-table-cell>
                    {rule.resourceDeleted ? (
                      <s-badge tone="warning">{ruleTarget(rule)}</s-badge>
                    ) : (
                      ruleTarget(rule)
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {rule.minAge === null ? t('rules.ageDefaultShort') : ageLabel(rule.minAge)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      loading={flag(busy === rule.id)}
                      accessibilityLabel={t('rules.removeLabel', { target: ruleTarget(rule) })}
                      onClick={() => void remove(rule)}
                    >
                      {t('rules.remove')}
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
