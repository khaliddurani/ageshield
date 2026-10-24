// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSummary, Settings as SettingsData } from '../api/admin';
import { t } from '../i18n';
import { defineFakePolaris, fieldByLabel } from '../test/fake-polaris';
import { setupSteps } from './Dashboard';
import { Settings, toForm, toSettings, validate } from './Settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAVED: SettingsData = {
  enabledCountries: ['DK', 'SE', 'NO', 'FI'],
  defaultMinAge: 18,
  gateMode: 'product_page',
  popupTexts: {},
  brandColor: null,
};

const saveSettings = vi.fn();
vi.mock('../api/admin', async (original) => ({
  ...(await original<typeof import('../api/admin')>()),
  getSettings: async () => SAVED,
  saveSettings: (s: SettingsData) => saveSettings(s),
}));

describe('settings form', () => {
  it('validates countries and colour', () => {
    expect(validate(toForm(SAVED))).toEqual({});
    expect(validate({ ...toForm(SAVED), enabledCountries: [] })).toHaveProperty('countries');
    expect(validate({ ...toForm(SAVED), brandColor: 'blue' })).toHaveProperty('brandColor');
    expect(validate({ ...toForm(SAVED), brandColor: '#00AAff' })).toEqual({});
  });

  it('drops languages without text, trims, keeps country order, empty colour → null', () => {
    const form = {
      ...toForm(SAVED),
      enabledCountries: ['FI', 'DK'] as SettingsData['enabledCountries'],
      texts: {
        da: { heading: ' Alderstjek ', body: '', button: '' },
        sv: { heading: '', body: ' ', button: '' },
      },
      brandColor: '  ',
    };
    expect(toSettings(form)).toEqual({
      ...SAVED,
      enabledCountries: ['DK', 'FI'],
      popupTexts: { da: { heading: 'Alderstjek', body: '', button: '' } },
      brandColor: null,
    });
  });
});

describe('Settings page', () => {
  let host: HTMLDivElement;
  let root: Root;
  let saveBar: { show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> };

  beforeAll(() => defineFakePolaris());
  beforeEach(async () => {
    saveBar = { show: vi.fn(async () => undefined), hide: vi.fn(async () => undefined) };
    (globalThis as unknown as { shopify: unknown }).shopify = {
      saveBar: { ...saveBar, leaveConfirmation: vi.fn(async () => undefined) },
      toast: { show: vi.fn() },
    };
    saveSettings.mockReset();
    saveSettings.mockImplementation(async (s: SettingsData) => ({
      settings: s,
      published: true,
      resynced: false,
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Settings />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('tells merchants not to change the app proxy URL', () => {
    expect(host.textContent).toContain(t('settings.proxyBody'));
  });

  it('a change shows the save bar; saving sends the settings', async () => {
    const sweden = fieldByLabel(host, t('labels.countrySe')) as HTMLElement & { checked: boolean };
    await act(async () => {
      sweden.checked = false;
      sweden.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(saveBar.show).toHaveBeenCalledWith('settings-save-bar');
    const save = host.querySelector('ui-save-bar button') as HTMLButtonElement;
    await act(async () => save.click());
    expect(saveSettings).toHaveBeenCalledWith({ ...SAVED, enabledCountries: ['DK', 'NO', 'FI'] });
  });

  it('does not save without a country', async () => {
    for (const label of ['countryDk', 'countrySe', 'countryNo', 'countryFi'] as const) {
      const box = fieldByLabel(host, t(`labels.${label}`)) as HTMLElement & { checked: boolean };
      await act(async () => {
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    await act(async () => (host.querySelector('ui-save-bar button') as HTMLButtonElement).click());
    expect(saveSettings).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t('settings.errorCountries'));
  });
});

describe('dashboard setup checklist', () => {
  const summary = (setup: Partial<DashboardSummary['setup']>): DashboardSummary => ({
    last30Days: { verified: 0, rejected: 0, cancelled: 0, error: 0 },
    setup: { settingsSaved: false, rulesAdded: false, verificationDone: false, ...setup },
    restrictedProducts: 0,
  });
  const theme = (enabled: boolean) =>
    ({
      status: 'ready',
      theme: { themeName: 'Dawn', enabled, activateUrl: 'https://admin.shopify.com/x' },
    }) as const;

  it('lists the four steps in order with their state', () => {
    const steps = setupSteps(summary({ rulesAdded: true }), theme(false));
    expect(steps.map((s) => [s.label, s.done])).toEqual([
      ['dashboard.stepEmbed', false],
      ['dashboard.stepCountries', false],
      ['dashboard.stepRules', true],
      ['dashboard.stepTest', false],
    ]);
    expect(steps[0]?.action?.label).toBe('theme.enable');
  });

  it('the embed step is not done while the theme is still loading', () => {
    expect(setupSteps(summary({}), { status: 'loading' })[0]).toMatchObject({
      done: false,
      action: undefined,
    });
    expect(setupSteps(summary({}), theme(true))[0]?.done).toBe(true);
  });
});
