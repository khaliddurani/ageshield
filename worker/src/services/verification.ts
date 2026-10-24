import { z } from 'zod';
import type { Env } from '../env';
import {
  ageResult,
  buildAuthorizeUrl,
  callbackErrorResult,
  exchangeCode,
  getDiscovery,
  IduraError,
  randomToken,
  verifyIdToken,
  type IduraConfig,
  type IduraDeps,
} from '../lib/idura';
import { countrySchema, getSettings, minAgeSchema, type Country, type MinAge } from './settings';
import { adminClientForShop, type AdminClient } from '../lib/shopify/admin';
import { hitRateLimit, type RateLimitRule } from './rate-limit';
import { returnHostFor } from './shop-domains';
import { signVerificationToken, TOKEN_TTL_S, TOKEN_VERSION } from './verification-token';

// Age verification flow (ARCHITECTURE §6):
//   storefront → App Proxy POST /verify/start → { authorizeUrl } (JSON; the proxy never redirects)
//   browser → Idura → GET {APP_URL}/oidc/callback (directly on the Worker) → 302 to the store page with the result in
//   the URL fragment: #ageshield=<token> (verified) or #ageshield_status=<status>. Never in the query string.
// Nothing personal is stored or logged: verifications hold country, threshold, result, error code and Idura's
// audit reference.

export const STATE_TTL_MS = 10 * 60_000;
/** Per hashed client IP. A real shopper needs a handful; this stops scripted login spam (each costs us at Idura). */
export const START_RATE_LIMIT: RateLimitRule = { scope: 'verify_start', limit: 20, windowMs: 10 * 60_000 };

export const startRequestSchema = z.object({
  country: countrySchema,
  minAge: minAgeSchema,
  /** Store-relative path to come back to, e.g. "/products/snus?variant=1". */
  returnPath: z.string().min(1).max(1024),
  /**
   * The shopper's current host (location.hostname). Untrusted: used only if it is one of the shop's own domains
   * (services/shop-domains.ts), otherwise the primary domain is used.
   */
  host: z.string().max(253).optional(),
});

export class VerificationError extends Error {
  override name = 'VerificationError';
  constructor(
    readonly code: 'invalid_return_path' | 'country_not_enabled' | 'shop_not_installed' | 'rate_limited',
    readonly status: 400 | 403 | 404 | 429,
    readonly retryAfterS?: number,
  ) {
    super(code);
  }
}

/**
 * A store-relative path: no scheme, no "//host", no backslashes or control characters. Any fragment is dropped (it
 * would clash with ours).
 */
export function safeReturnPath(returnPath: string): string {
  const path = returnPath.split('#')[0] ?? '';
  // eslint-disable-next-line no-control-regex
  if (!/^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/.test(path)) {
    throw new VerificationError('invalid_return_path', 400);
  }
  return path;
}

/**
 * The absolute return URL https://{host}{path}. `host` must already be one of the shop's own domains (signed shop
 * domain, or a host checked by returnHostFor) — never a client value as-is.
 */
export function returnUrlFor(host: string, returnPath: string): string {
  const base = `https://${host}`;
  const url = new URL(safeReturnPath(returnPath), base);
  if (url.origin !== base) throw new VerificationError('invalid_return_path', 400);
  return url.toString();
}

export interface StartDeps extends IduraDeps {
  /** Admin client of the shop (stored offline token); for the storefront domain lookup. */
  admin?: () => AdminClient;
}

export function iduraConfig(env: Env): IduraConfig {
  return {
    domain: env.IDURA_DOMAIN,
    clientId: env.IDURA_CLIENT_ID,
    clientSecret: env.IDURA_CLIENT_SECRET,
    redirectUri: `${env.APP_URL}/oidc/callback`,
  };
}

/** Starts a login: validates, rate-limits, stores a single-use state row and returns Idura's authorize URL. */
export async function startVerification(
  env: Env,
  shop: string,
  input: z.infer<typeof startRequestSchema>,
  clientIp: string,
  now: number,
  deps: StartDeps = {},
): Promise<{ authorizeUrl: string }> {
  safeReturnPath(input.returnPath); // reject bad paths before anything is counted or looked up
  const limit = await hitRateLimit(env.DB, START_RATE_LIMIT, clientIp, now);
  if (!limit.allowed) throw new VerificationError('rate_limited', 429, limit.retryAfterS);

  const installed = await env.DB.prepare(
    'SELECT 1 AS ok FROM shops WHERE shop = ?1 AND uninstalled_at IS NULL',
  )
    .bind(shop)
    .first<{ ok: number }>();
  if (!installed) throw new VerificationError('shop_not_installed', 404);
  const settings = await getSettings(env.DB, shop);
  if (!settings.enabledCountries.includes(input.country))
    throw new VerificationError('country_not_enabled', 403);

  const host = await returnHostFor(
    env.DB,
    deps.admin ?? (() => adminClientForShop(env, shop)),
    shop,
    input.host,
    now,
  );
  const returnUrl = returnUrlFor(host, input.returnPath);
  const config = iduraConfig(env);
  const discovery = await getDiscovery(config.domain, deps);
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken();
  await env.DB.prepare(
    `INSERT INTO oidc_states (state, shop, nonce, code_verifier, country, min_age, return_url, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(state, shop, nonce, codeVerifier, input.country, input.minAge, returnUrl, now, now + STATE_TTL_MS)
    .run();
  return {
    authorizeUrl: await buildAuthorizeUrl(config, discovery, {
      country: input.country,
      minAge: input.minAge,
      state,
      nonce,
      codeVerifier,
    }),
  };
}

/** What the storefront shows (#ageshield_status=…); the token itself travels as #ageshield=…. */
export type StorefrontStatus = 'rejected' | 'cancelled' | 'assurance' | 'expired' | 'error';

export type CallbackOutcome =
  | { kind: 'redirect'; url: string }
  /** No usable state: we don't know where to send the shopper back. */
  | { kind: 'page'; status: 400 };

interface StateRow {
  shop: string;
  nonce: string;
  code_verifier: string;
  country: Country;
  min_age: MinAge;
  return_url: string;
  expires_at: number;
}

const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

async function recordVerification(
  db: D1Database,
  row: StateRow,
  result: 'verified' | 'rejected' | 'cancelled' | 'error',
  extra: { errorCode?: string | null; auditId?: string | null; tokenExpiresAt?: number | null },
  now: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO verifications (id, shop, country, min_age, result, error_code, audit_id, created_at, token_expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      id,
      row.shop,
      row.country,
      row.min_age,
      result,
      extra.errorCode ?? null,
      extra.auditId ?? null,
      now,
      extra.tokenExpiresAt ?? null,
    )
    .run();
  return id;
}

const withFragment = (url: string, fragment: Record<string, string>) =>
  `${url}#${new URLSearchParams(fragment).toString()}`;

/**
 * GET /oidc/callback. The state row is deleted before anything else (single use, also when the login failed), the
 * code is exchanged, the id_token verified and the result mapped. Every outcome with a known state is recorded and
 * sent back to the store page.
 */
export async function completeVerification(
  env: Env,
  query: URLSearchParams,
  now: number,
  deps: IduraDeps = {},
): Promise<CallbackOutcome> {
  const state = query.get('state') ?? '';
  if (!STATE_RE.test(state)) return { kind: 'page', status: 400 };
  const row = await env.DB.prepare(
    `DELETE FROM oidc_states WHERE state = ?1
     RETURNING shop, nonce, code_verifier, country, min_age, return_url, expires_at`,
  )
    .bind(state)
    .first<StateRow>();
  if (!row) return { kind: 'page', status: 400 };

  const back = (status: StorefrontStatus) =>
    ({
      kind: 'redirect',
      url: withFragment(row.return_url, {
        ageshield_status: status,
        ageshield_age: String(row.min_age),
        // Lets the storefront name the eID in messages (e.g. MitID for the assurance-level error).
        ageshield_country: row.country,
      }),
    }) as const;

  if (row.expires_at < now) {
    await recordVerification(env.DB, row, 'error', { errorCode: 'state_expired' }, now);
    return back('expired');
  }

  const error = query.get('error');
  if (error !== null) {
    const mapped = callbackErrorResult(error, query.get('error_description') ?? undefined);
    if (mapped.result === 'cancelled') {
      await recordVerification(env.DB, row, 'cancelled', {}, now);
      return back('cancelled');
    }
    await recordVerification(env.DB, row, 'error', { errorCode: mapped.errorCode }, now);
    return back(mapped.errorCode === 'assurance_level' ? 'assurance' : 'error');
  }

  const code = query.get('code');
  if (!code || code.length > 4096) {
    await recordVerification(env.DB, row, 'error', { errorCode: 'code_missing' }, now);
    return back('error');
  }

  let outcome: ReturnType<typeof ageResult>;
  try {
    const config = iduraConfig(env);
    const discovery = await getDiscovery(config.domain, deps);
    const idToken = await exchangeCode(config, discovery, code, row.code_verifier, deps);
    const claims = await verifyIdToken(config, discovery, idToken, row.nonce, { ...deps, now: () => now });
    outcome = ageResult(claims, row.country, row.min_age);
  } catch (err) {
    if (!(err instanceof IduraError)) throw err;
    console.error(`oidc callback for ${row.shop}: ${err.code}`);
    await recordVerification(env.DB, row, 'error', { errorCode: err.code }, now);
    return back('error');
  }

  if (outcome.result === 'error') {
    await recordVerification(env.DB, row, 'error', { errorCode: outcome.errorCode }, now);
    return back('error');
  }
  if (outcome.result === 'rejected') {
    await recordVerification(env.DB, row, 'rejected', { auditId: outcome.auditId }, now);
    return back('rejected');
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + TOKEN_TTL_S;
  const vid = await recordVerification(
    env.DB,
    row,
    'verified',
    { auditId: outcome.auditId, tokenExpiresAt: exp * 1000 },
    now,
  );
  const token = await signVerificationToken(env.VERIFICATION_SIGNING_KEY, {
    v: TOKEN_VERSION,
    vid,
    shop: row.shop,
    min_age: row.min_age,
    country: row.country,
    audit_id: outcome.auditId,
    iat,
    exp,
  });
  return { kind: 'redirect', url: withFragment(row.return_url, { ageshield: token }) };
}
