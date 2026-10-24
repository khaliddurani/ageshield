import type { Env } from '../../env';
import { getOfflineAccessToken, tokenManagerFromEnv } from './offline-token';
import type { FetchFn } from './token-exchange';

// The single GraphQL Admin API client. All Shopify calls go through here.

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: ThrottleStatus } };
}

export class AdminApiError extends Error {
  override name = 'AdminApiError';
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly graphqlErrors: GraphqlError[] = [],
  ) {
    super(message);
  }
}

/**
 * The app is not approved for protected customer data (Shopify answers 200 with null fields and an error like
 * "This app is not approved to access the Customer object").
 */
export class ProtectedCustomerDataError extends AdminApiError {
  override name = 'ProtectedCustomerDataError';
}

const PROTECTED_DATA_RE = /not approved to (access|use)/i;

/**
 * A field or object needs an access scope the app doesn't have (e.g. "Access denied for customer field.
 * Required access: `read_customers` access scope."). Retrying can't fix it.
 */
export class AccessDeniedError extends AdminApiError {
  override name = 'AccessDeniedError';
}

const ACCESS_DENIED_RE = /access denied|required access/i;

function isAccessDenied(error: GraphqlError): boolean {
  return error.extensions?.code === 'ACCESS_DENIED' || ACCESS_DENIED_RE.test(error.message);
}

export class UserErrorsError extends Error {
  override name = 'UserErrorsError';
  constructor(
    operation: string,
    readonly userErrors: UserError[],
  ) {
    super(`${operation}: ${userErrors.map((e) => e.message).join('; ')}`);
  }
}

/** Throws if a mutation payload is missing or returned `userErrors`. */
export function assertNoUserErrors<P extends { userErrors?: UserError[] | null }>(
  payload: P | null | undefined,
  operation: string,
): P {
  if (!payload) throw new AdminApiError(`${operation}: empty payload`);
  if (payload.userErrors && payload.userErrors.length > 0)
    throw new UserErrorsError(operation, payload.userErrors);
  return payload;
}

export interface AdminClientOptions {
  apiVersion: string;
  /** Returns a valid access token. `rejectedToken` is set after Shopify answered 401 with it. */
  getAccessToken: (rejectedToken?: string) => Promise<string>;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
  /** Wait before sending if the shop's estimated available query cost is below this. */
  minAvailable?: number;
}

export interface AdminClient {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

// Last known throttle bucket per shop (per isolate); used to back off before hitting THROTTLED.
const throttleByShop = new Map<string, { status: ThrottleStatus; at: number }>();

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

function throttleWaitMs(shop: string, needed: number, now: number): number {
  const last = throttleByShop.get(shop);
  if (!last || last.status.restoreRate <= 0) return 0;
  const restored = ((now - last.at) / 1000) * last.status.restoreRate;
  const available = Math.min(last.status.maximumAvailable, last.status.currentlyAvailable + restored);
  if (available >= needed) return 0;
  return Math.min(((needed - available) / last.status.restoreRate) * 1000, MAX_BACKOFF_MS);
}

export function createAdminClient(shop: string, opts: AdminClientOptions): AdminClient {
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const maxRetries = opts.maxRetries ?? 4;
  const minAvailable = opts.minAvailable ?? 100;
  const url = `https://${shop}/admin/api/${opts.apiVersion}/graphql.json`;

  return {
    async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      let rejectedToken: string | undefined;
      let authRetried = false;

      for (let attempt = 0; ; attempt++) {
        const wait = throttleWaitMs(shop, minAvailable, now());
        if (wait > 0) await sleep(wait);

        const token = await opts.getAccessToken(rejectedToken);
        let res: Response;
        try {
          res = await fetchFn(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Shopify-Access-Token': token,
            },
            body: JSON.stringify({ query, variables }),
          });
        } catch (err) {
          if (attempt >= maxRetries) throw new AdminApiError(`Network error: ${String(err)}`);
          await sleep(backoffMs(attempt, null));
          continue;
        }

        if (res.status === 401 && !authRetried) {
          authRetried = true;
          rejectedToken = token;
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= maxRetries) throw new AdminApiError(`Admin API HTTP ${res.status}`, res.status);
          await sleep(backoffMs(attempt, res.headers.get('Retry-After')));
          continue;
        }
        if (res.status === 403) throw new AccessDeniedError('Admin API HTTP 403 (access denied)', res.status);
        if (!res.ok) throw new AdminApiError(`Admin API HTTP ${res.status}`, res.status);

        const body = (await res.json()) as GraphqlResponse<T>;
        const cost = body.extensions?.cost;
        if (cost?.throttleStatus) throttleByShop.set(shop, { status: cost.throttleStatus, at: now() });

        const errors = body.errors ?? [];
        if (errors.some((e) => e.extensions?.code === 'THROTTLED')) {
          if (attempt >= maxRetries) throw new AdminApiError('Admin API throttled', res.status, errors);
          const needed = cost?.requestedQueryCost ?? minAvailable;
          await sleep(Math.max(throttleWaitMs(shop, needed, now()), backoffMs(attempt, null)));
          continue;
        }
        if (errors.some((e) => PROTECTED_DATA_RE.test(e.message))) {
          throw new ProtectedCustomerDataError(
            'Protected customer data access is not approved',
            res.status,
            errors,
          );
        }
        const denied = errors.find(isAccessDenied);
        if (denied) throw new AccessDeniedError(denied.message, res.status, errors);
        if (errors.length > 0) {
          throw new AdminApiError(`GraphQL: ${errors.map((e) => e.message).join('; ')}`, res.status, errors);
        }
        if (body.data === undefined) throw new AdminApiError('GraphQL response without data', res.status);
        return body.data;
      }
    },
  };
}

/** Admin client for a shop using its stored offline token. Pass `idToken` on merchant requests to allow exchange. */
export function adminClientForShop(env: Env, shop: string, idToken?: string): AdminClient {
  const deps = tokenManagerFromEnv(env);
  return createAdminClient(shop, {
    apiVersion: env.SHOPIFY_API_VERSION,
    getAccessToken: async (rejectedToken) =>
      (await getOfflineAccessToken(deps, shop, { idToken, rejectedToken })).accessToken,
  });
}
