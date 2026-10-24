import { api } from './client';

export interface Me {
  shop: string;
  shopName: string;
  plan: string;
  scopes: string[];
  /** IANA time zone of the store; dates are shown in it. */
  timeZone: string;
}

export function getMe(): Promise<Me> {
  return api<Me>('/api/me');
}

/** Mirrors worker/src/services/theme-status.ts. */
export interface ThemeStatus {
  themeName: string | null;
  enabled: boolean;
  activateUrl: string;
}

export function getThemeStatus(): Promise<ThemeStatus> {
  return api<ThemeStatus>('/api/theme-status');
}
