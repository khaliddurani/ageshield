import { ZodError } from 'zod';
import { AccessDeniedError } from '../lib/shopify/admin';
import { NoOfflineTokenError } from '../lib/shopify/offline-token';

// Classifies job failures: what to store in jobs.error, and whether retrying can help.

export type JobErrorCode = 'access_denied' | 'not_authorized' | 'invalid_job' | 'retries_exhausted';

export interface JobFailure {
  code: JobErrorCode;
  /** Readable, safe to store and show: no tokens, no customer data. */
  message: string;
}

/** Errors that fail the job immediately instead of being retried. */
export function nonRetryableFailure(err: unknown): JobFailure | null {
  if (err instanceof AccessDeniedError) {
    return { code: 'access_denied', message: `Shopify denied access: ${err.message}` };
  }
  if (err instanceof NoOfflineTokenError) {
    return {
      code: 'not_authorized',
      message: 'The app has no valid access token for this store. Open the app again.',
    };
  }
  if (err instanceof ZodError) return { code: 'invalid_job', message: 'The job payload is invalid.' };
  return null;
}

/** Failure recorded after the last retry. */
export function exhaustedFailure(err: unknown): JobFailure {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
  return { code: 'retries_exhausted', message: `Gave up after repeated errors (${reason.slice(0, 300)}).` };
}

/** jobs.error text: "<code>: <message>". The UI reads the code before the first colon. */
export function formatJobError(failure: JobFailure): string {
  return `${failure.code}: ${failure.message}`;
}
