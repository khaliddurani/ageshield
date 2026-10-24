import { z } from 'zod';

// Exact strings from shopify.dev "Exchange a session token for an access token" (checked 2026-10-06).
const GRANT_TYPE_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const REQUESTED_TOKEN_TYPE_OFFLINE = 'urn:shopify:params:oauth:token-type:offline-access-token';

export interface AppCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface OfflineTokenSet {
  accessToken: string;
  accessTokenExpiresAt: number; // unix ms
  refreshToken: string;
  refreshTokenExpiresAt: number | null; // unix ms
  scope: string | null;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Shopify rejected the ID token (400 on exchange). Respond 401 + retry header so App Bridge sends a fresh one. */
export class InvalidSubjectTokenError extends Error {
  override name = 'InvalidSubjectTokenError';
}

/** Refresh token expired or revoked (401 on refresh). A new token exchange is needed. */
export class RefreshTokenExpiredError extends Error {
  override name = 'RefreshTokenExpiredError';
}

export class TokenRequestError extends Error {
  override name = 'TokenRequestError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.coerce.number().positive().optional(),
  scope: z.string().optional(),
});

const errorResponseSchema = z.object({ error: z.string().optional() });

const defaultFetch: FetchFn = (input, init) => fetch(input, init);

async function postTokenRequest(
  shop: string,
  params: Record<string, string>,
  fetchFn: FetchFn,
): Promise<Response> {
  return fetchFn(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
}

/** Error code from Shopify's error body (e.g. `invalid_subject_token`). Never includes token values. */
async function errorCode(res: Response): Promise<string> {
  try {
    const parsed = errorResponseSchema.safeParse(await res.json());
    return parsed.success && parsed.data.error ? parsed.data.error : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function parseTokenSet(res: Response, now: number): Promise<OfflineTokenSet> {
  const body = tokenResponseSchema.parse(await res.json());
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: now + body.expires_in * 1000,
    refreshToken: body.refresh_token,
    refreshTokenExpiresAt:
      body.refresh_token_expires_in === undefined ? null : now + body.refresh_token_expires_in * 1000,
    scope: body.scope ?? null,
  };
}

/** Exchanges a raw ID token (no "Bearer ") for an expiring offline access token. */
export async function exchangeSessionToken(
  shop: string,
  idToken: string,
  credentials: AppCredentials,
  now: number,
  fetchFn: FetchFn = defaultFetch,
): Promise<OfflineTokenSet> {
  const res = await postTokenRequest(
    shop,
    {
      client_id: credentials.apiKey,
      client_secret: credentials.apiSecret,
      grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
      subject_token: idToken,
      subject_token_type: SUBJECT_TOKEN_TYPE_ID_TOKEN,
      requested_token_type: REQUESTED_TOKEN_TYPE_OFFLINE,
      expiring: '1',
    },
    fetchFn,
  );
  if (res.status === 400)
    throw new InvalidSubjectTokenError(`Token exchange rejected: ${await errorCode(res)}`);
  if (!res.ok) throw new TokenRequestError(res.status, `Token exchange failed: ${await errorCode(res)}`);
  return parseTokenSet(res, now);
}

/** Refreshes an expiring offline token. Shopify rotates the refresh token on every refresh. */
export async function refreshOfflineToken(
  shop: string,
  refreshToken: string,
  credentials: AppCredentials,
  now: number,
  fetchFn: FetchFn = defaultFetch,
): Promise<OfflineTokenSet> {
  const res = await postTokenRequest(
    shop,
    {
      client_id: credentials.apiKey,
      client_secret: credentials.apiSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    fetchFn,
  );
  if (res.status === 401) throw new RefreshTokenExpiredError(`Refresh rejected: ${await errorCode(res)}`);
  if (!res.ok) throw new TokenRequestError(res.status, `Token refresh failed: ${await errorCode(res)}`);
  return parseTokenSet(res, now);
}
