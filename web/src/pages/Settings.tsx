import { useCallback, useEffect, useState } from 'react';
import {
  COUNTRIES,
  MIN_AGES,
  getSettings,
  saveSettings,
  type GateMode,
  type MinAge,
  type PopupText,
  type Settings as SettingsData,
} from '../api/admin';
import { ErrorBanner, Loading } from '../components/common';
import { Checkbox, Select, TextArea, TextField } from '../components/fields';
import { useSaveBar } from '../components/save-bar';
import { t } from '../i18n';
import { ageLabel, countryLabel } from '../labels';

// Settings: countries, default minimum age, gate mode, storefront texts per language, brand colour. Saving publishes
// the storefront config at once (worker routes/api/settings.ts). Uses the Contextual Save Bar.

const SAVE_BAR_ID = 'settings-save-bar';
/** Storefront languages offered for custom texts (Shopify locale codes; nb = Norwegian Bokmål). */
const TEXT_LOCALES = ['en', 'da', 'sv', 'nb', 'fi'] as const;
const EMPTY_TEXT: PopupText = { heading: '', body: '', button: '' };
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const LIMITS = { heading: 120, body: 600, button: 60 } as const;

export interface Form {
  enabledCountries: SettingsData['enabledCountries'];
  defaultMinAge: MinAge;
  gateMode: GateMode;
  texts: Record<string, PopupText>;
  brandColor: string;
}

export const toForm = (s: SettingsData): Form => ({
  enabledCountries: s.enabledCountries,
  defaultMinAge: s.defaultMinAge,
  gateMode: s.gateMode,
  texts: s.popupTexts,
  brandColor: s.brandColor ?? '',
});

/** Form → API body. Languages with no text at all are left out (the theme's translation is used). */
export function toSettings(form: Form): SettingsData {
  const popupTexts: Record<string, PopupText> = {};
  for (const [locale, text] of Object.entries(form.texts)) {
    const trimmed = { heading: text.heading.trim(), body: text.body.trim(), button: text.button.trim() };
    if (trimmed.heading || trimmed.body || trimmed.button) popupTexts[locale] = trimmed;
  }
  return {
    enabledCountries: COUNTRIES.filter((c) => form.enabledCountries.includes(c)),
    defaultMinAge: form.defaultMinAge,
    gateMode: form.gateMode,
    popupTexts,
    brandColor: form.brandColor.trim() || null,
  };
}

export function validate(form: Form): Partial<Record<'countries' | 'brandColor', string>> {
  const errors: Partial<Record<'countries' | 'brandColor', string>> = {};
  if (form.enabledCountries.length === 0) errors.countries = t('settings.errorCountries');
  if (form.brandColor.trim() && !HEX_RE.test(form.brandColor.trim()))
    errors.brandColor = t('settings.errorColor');
  return errors;
}

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; saved: Form };

export function Settings() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [form, setForm] = useState<Form | null>(null);
  const [locale, setLocale] = useState<string>('en');
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  // State is only set in the request callbacks; a retry shows the spinner first (event handler).
  const fetchSettings = useCallback(() => {
    getSettings().then(
      (s) => {
        setState({ status: 'ready', saved: toForm(s) });
        setForm(toForm(s));
      },
      () => setState({ status: 'error' }),
    );
  }, []);
  useEffect(fetchSettings, [fetchSettings]);
  const load = () => {
    setState({ status: 'loading' });
    fetchSettings();
  };

  const saved = state.status === 'ready' ? state.saved : null;
  const dirty =
    form !== null && saved !== null && JSON.stringify(toSettings(form)) !== JSON.stringify(toSettings(saved));
  useSaveBar(SAVE_BAR_ID, dirty);

  if (state.status !== 'ready' || !form) {
    return (
      <s-page heading={t('settings.heading')}>
        {state.status === 'error' ? <ErrorBanner onRetry={load} /> : <Loading />}
      </s-page>
    );
  }

  const errors = validate(form);
  const visibleErrors = showErrors ? errors : {};
  const text = form.texts[locale] ?? EMPTY_TEXT;
  const setText = (key: keyof PopupText) => (value: string) =>
    setForm((f) =>
      f ? { ...f, texts: { ...f.texts, [locale]: { ...(f.texts[locale] ?? EMPTY_TEXT), [key]: value } } } : f,
    );

  const save = async () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const res = await saveSettings(toSettings(form));
      const next = toForm(res.settings);
      setState({ status: 'ready', saved: next });
      setForm(next);
      setShowErrors(false);
      shopify.toast.show(res.published ? t('settings.saved') : t('settings.savedNotPublished'));
      if (res.resynced) shopify.toast.show(t('settings.resyncStarted'));
    } catch {
      shopify.toast.show(t('settings.saveFailed'), { isError: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <s-page heading={t('settings.heading')}>
      <ui-save-bar id={SAVE_BAR_ID}>
        <button {...({ variant: 'primary' } as object)} onClick={() => void save()} disabled={saving}>
          {t('common.save')}
        </button>
        <button
          onClick={() => {
            setForm(saved);
            setShowErrors(false);
          }}
          disabled={saving}
        >
          {t('common.discard')}
        </button>
      </ui-save-bar>

      <s-section heading={t('settings.countriesHeading')}>
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">{t('settings.countriesHelp')}</s-paragraph>
          {COUNTRIES.map((country) => (
            <Checkbox
              key={country}
              label={countryLabel(country)}
              checked={form.enabledCountries.includes(country)}
              onChange={(checked) =>
                setForm((f) =>
                  f
                    ? {
                        ...f,
                        enabledCountries: checked
                          ? [...new Set([...f.enabledCountries, country])]
                          : f.enabledCountries.filter((c) => c !== country),
                      }
                    : f,
                )
              }
            />
          ))}
          {visibleErrors.countries && <s-text tone="critical">{visibleErrors.countries}</s-text>}
        </s-stack>
      </s-section>

      <s-section heading={t('settings.gateHeading')}>
        <s-stack direction="block" gap="base">
          <Select
            label={t('settings.defaultMinAge')}
            details={t('settings.defaultMinAgeHelp')}
            value={String(form.defaultMinAge)}
            options={MIN_AGES.map((age) => ({ value: String(age), label: ageLabel(age) }))}
            onChange={(v) => setForm((f) => (f ? { ...f, defaultMinAge: Number(v) as MinAge } : f))}
          />
          <Select
            label={t('settings.gateMode')}
            details={
              form.gateMode === 'cart' ? t('settings.gateModeCartHelp') : t('settings.gateModeProductHelp')
            }
            value={form.gateMode}
            options={[
              { value: 'product_page', label: t('settings.gateModeProduct') },
              { value: 'cart', label: t('settings.gateModeCart') },
            ]}
            onChange={(v) =>
              setForm((f) => (f ? { ...f, gateMode: v === 'cart' ? 'cart' : 'product_page' } : f))
            }
          />
        </s-stack>
      </s-section>

      <s-section heading={t('settings.textsHeading')}>
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">{t('settings.textsHelp')}</s-paragraph>
          <Select
            label={t('settings.textsLanguage')}
            value={locale}
            options={TEXT_LOCALES.map((l) => ({ value: l, label: t(`settings.language_${l}`) }))}
            onChange={setLocale}
          />
          <TextField
            key={`heading-${locale}`}
            label={t('settings.textHeading')}
            placeholder={t('settings.textHeadingPlaceholder')}
            value={text.heading}
            maxLength={LIMITS.heading}
            onChange={setText('heading')}
          />
          <TextArea
            key={`body-${locale}`}
            label={t('settings.textBody')}
            placeholder={t('settings.textBodyPlaceholder')}
            value={text.body}
            rows={3}
            maxLength={LIMITS.body}
            onChange={setText('body')}
          />
          <TextField
            key={`button-${locale}`}
            label={t('settings.textButton')}
            placeholder={t('settings.textButtonPlaceholder')}
            value={text.button}
            maxLength={LIMITS.button}
            onChange={setText('button')}
          />
        </s-stack>
      </s-section>

      <s-section heading={t('settings.brandHeading')}>
        <TextField
          label={t('settings.brandColor')}
          details={t('settings.brandColorHelp')}
          placeholder="#1a1a1a"
          value={form.brandColor}
          error={visibleErrors.brandColor}
          maxLength={7}
          onChange={(v) => setForm((f) => (f ? { ...f, brandColor: v } : f))}
        />
      </s-section>

      <s-section>
        <s-banner tone="info" heading={t('settings.proxyHeading')}>
          <s-paragraph>{t('settings.proxyBody')}</s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}
