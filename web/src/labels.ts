import type { Country, MinAge, VerificationResult } from './api/admin';
import { t, type MessageKey } from './i18n';

// Shared display labels for countries, ages and verification results.

const COUNTRY: Record<Country, MessageKey> = {
  DK: 'labels.countryDk',
  SE: 'labels.countrySe',
  NO: 'labels.countryNo',
  FI: 'labels.countryFi',
};

/** "MitID (Denmark)" etc. */
export const countryLabel = (country: Country) => t(COUNTRY[country]);

export const ageLabel = (age: MinAge) => t('labels.age', { age });

const RESULT: Record<VerificationResult, MessageKey> = {
  verified: 'labels.resultVerified',
  rejected: 'labels.resultRejected',
  cancelled: 'labels.resultCancelled',
  error: 'labels.resultError',
};

export const RESULT_TONE: Record<VerificationResult, 'success' | 'warning' | 'neutral' | 'critical'> = {
  verified: 'success',
  rejected: 'warning',
  cancelled: 'neutral',
  error: 'critical',
};

export const resultLabel = (result: VerificationResult) => t(RESULT[result]);
