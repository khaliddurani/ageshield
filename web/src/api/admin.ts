import { api } from './client';

// Mirrors worker/src/routes/api/{settings,rules,verifications}.ts.

export type Country = 'DK' | 'SE' | 'NO' | 'FI';
export type MinAge = 15 | 16 | 18 | 21;
export type GateMode = 'product_page' | 'cart';

export const COUNTRIES: readonly Country[] = ['DK', 'SE', 'NO', 'FI'];
export const MIN_AGES: readonly MinAge[] = [15, 16, 18, 21];

export interface PopupText {
  heading: string;
  body: string;
  button: string;
}

export interface Settings {
  enabledCountries: Country[];
  defaultMinAge: MinAge;
  gateMode: GateMode;
  popupTexts: Record<string, PopupText>;
  brandColor: string | null;
}

export const getSettings = () => api<Settings>('/api/settings');
export const saveSettings = (settings: Settings) =>
  api<{ settings: Settings; published: boolean; resynced: boolean }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });

export type RuleType = 'product' | 'collection' | 'tag';

export interface Rule {
  id: string;
  type: RuleType;
  resourceGid: string | null;
  tag: string | null;
  minAge: MinAge | null;
  createdAt: number;
  /** Product/collection title (null if unknown or deleted). */
  title: string | null;
  resourceDeleted: boolean;
}

export type NewRule =
  | { type: 'product' | 'collection'; resourceGid: string; minAge: MinAge | null }
  | { type: 'tag'; tag: string; minAge: MinAge | null };

export interface SyncStatus {
  restrictedProducts: number;
  sync: {
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    processed: number;
    errorCode: string | null;
    startedAt: number;
    updatedAt: number;
  } | null;
}

export interface RulesPage extends SyncStatus {
  rules: Rule[];
  maxRules: number;
}

export const getRules = () => api<RulesPage>('/api/rules');
export const getRulesStatus = () => api<SyncStatus>('/api/rules/status');
export const addRules = (rules: NewRule[]) =>
  api<RulesPage & { added: number }>('/api/rules', { method: 'POST', body: JSON.stringify({ rules }) });
export const deleteRule = (id: string) =>
  api<RulesPage>(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const resyncRules = () => api<SyncStatus>('/api/rules/sync', { method: 'POST' });

export type VerificationResult = 'verified' | 'rejected' | 'cancelled' | 'error';

export interface VerificationItem {
  id: string;
  createdAt: number;
  country: Country;
  minAge: MinAge;
  result: VerificationResult;
  errorCode: string | null;
}

export function listVerifications(cursor: string | null, result: VerificationResult | null) {
  const params = new URLSearchParams({ limit: '25' });
  if (cursor) params.set('cursor', cursor);
  if (result) params.set('result', result);
  return api<{ items: VerificationItem[]; nextCursor: string | null }>(`/api/verifications?${params}`);
}

export interface DashboardSummary {
  last30Days: Record<VerificationResult, number>;
  setup: { settingsSaved: boolean; rulesAdded: boolean; verificationDone: boolean };
  restrictedProducts: number;
}

export const getDashboard = () => api<DashboardSummary>('/api/dashboard');
