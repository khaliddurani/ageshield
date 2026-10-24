import type { Env } from '../env';
import { adminClientForShop, type AdminClient } from '../lib/shopify/admin';
import type { FetchFn } from '../lib/shopify/token-exchange';
import {
  appScopesUpdateSchema,
  customersDataRequestSchema,
  customersRedactSchema,
  productJobSchema,
} from '../lib/shopify/webhook-payloads';
import { syncPlan } from '../services/billing';
import { handleCustomersDataRequest, handleCustomersRedact, handleShopRedact } from '../services/compliance';
import { nonRetryableFailure } from '../services/job-errors';
import { markShopUninstalled, updateShopScopes } from '../services/shops';

/** Message shape for the JOBS queue. `payload` is validated with Zod per job type. */
export interface JobMessage {
  type: string;
  shop: string;
  payload: unknown;
}

export interface JobDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: FetchFn;
  admin?: (shop: string) => AdminClient;
  /** Delivery attempt of the current message (1-based). */
  attempt?: number;
}

/** A job that can never succeed (bad payload, unknown type, no token). Acked instead of retried. */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
}

const MAX_RETRY_DELAY_S = 15 * 60;
/** First delivery + `max_retries` (5) from wrangler.jsonc; after this the message goes to the dead-letter queue. */
export const MAX_ATTEMPTS = 6;

/** Acked instead of retried: retrying can't help (bad payload, unknown type, missing access, no token…). */
function isPermanent(err: unknown): boolean {
  return err instanceof PermanentJobError || nonRetryableFailure(err) !== null;
}

export async function runJob(job: JobMessage, env: Env, deps: JobDeps = {}): Promise<void> {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const admin = () => (deps.admin ?? ((shop: string) => adminClientForShop(env, shop)))(job.shop);

  switch (job.type) {
    case 'app/uninstalled':
      return markShopUninstalled(env.DB, job.shop, now);
    case 'app/scopes_update':
      return updateShopScopes(env.DB, job.shop, appScopesUpdateSchema.parse(job.payload).current);
    case 'products/create':
    case 'products/update':
      // Age-restriction sync for the changed product: added with the data model (step 2).
      productJobSchema.parse(job.payload);
      return;
    case 'customers/data_request':
      return handleCustomersDataRequest(env.DB, job.shop, customersDataRequestSchema.parse(job.payload), now);
    case 'customers/redact':
      return handleCustomersRedact(env.DB, job.shop, customersRedactSchema.parse(job.payload), now);
    case 'shop/redact':
      return handleShopRedact(env.DB, job.shop, now);
    case 'billing/sync':
      // Errors (e.g. Shopify unavailable) keep the stored plan; the queue retries, the next daily run tries again.
      await syncPlan(env.DB, admin(), job.shop, now);
      return;
    default:
      throw new PermanentJobError(`Unknown job type "${job.type}"`);
  }
}

/** Job router: ack on success or permanent failure, retry with exponential backoff otherwise. */
export async function handleQueueBatch(
  batch: MessageBatch<JobMessage>,
  env: Env,
  _ctx?: ExecutionContext,
  deps: JobDeps = {},
): Promise<void> {
  for (const message of batch.messages) {
    const { type, shop } = message.body;
    try {
      await runJob(message.body, env, { ...deps, attempt: message.attempts });
      message.ack();
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
      if (isPermanent(err)) {
        console.error(`job ${type} for ${shop} dropped: ${reason}`);
        message.ack();
      } else {
        console.error(`job ${type} for ${shop} failed (attempt ${message.attempts}): ${reason}`);
        message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), MAX_RETRY_DELAY_S) });
      }
    }
  }
}
