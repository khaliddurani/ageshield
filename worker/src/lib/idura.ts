import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import type { FetchFn } from './shopify/token-exchange';

// Idura (formerly Criipto) Verify — Age Verification extension, OIDC authorization code flow with PKCE.
// docs.idura.app: /verify/guides/age-verification, /verify/reference/authorization-flows/pkce,
// /verify/reference/request-parameters. Confirmed against the test tenant (2026-10-24):
//   - authorize: acr_values=urn:age-verification, login_hint=country:{DK|SE|NO|FI}, scope "openid is_over_{N}";
//   - token: confidential client = Basic base64(urlencode(client_id):urlencode(client_secret)) + code_verifier;
//   - id_token: RS256 (JWKS), claim object AGE_CLAIM = { country, auditId, is_over_{N}: boolean }. An underage user
//     completes the login normally with is_over_{N}: false;
//   - exp is set years ahead, so freshness is checked on authenticationinstant / iat (MAX_AUTH_AGE_S);
//   - ial is "low" even for valid users, so no ial is required.
// Never read, store or log sub, nameidentifier, sessionindex or any other identity claim.

export const AGE_CLAIM = 'http://ageverification.criipto.com';
export const AGE_VERIFICATION_ACR = 'urn:age-verification';
/** An authentication older than this is not accepted (the id_token exp is meaningless). */
export const MAX_AUTH_AGE_S = 10 * 60;
const CLOCK_TOLERANCE_S = 30;
const DISCOVERY_TTL_MS = 60 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;

export interface IduraConfig {
  /** e.g. merchantkits.test.idura.broker (no scheme). */
  domain: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface IduraDeps {
  fetchFn?: FetchFn;
  now?: () => number;
}

export class IduraError extends Error {
  override name = 'IduraError';
  constructor(
    /** Stored as verifications.error_code: no tokens, no personal data. */
    readonly code:
      'discovery_failed' | 'token_exchange_failed' | 'id_token_invalid' | 'auth_too_old' | 'nonce_mismatch',
    message: string,
  ) {
    super(message);
  }
}

const discoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
});
export type Discovery = z.infer<typeof discoverySchema>;

const discoveryCache = new Map<string, { at: number; value: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Test hook: forget cached discovery documents and key sets. */
export function resetIduraCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

const defaultFetch: FetchFn = (input, init) => fetch(input, init);

/**
 * The tenant's OpenID configuration (cached per isolate for an hour). Every endpoint must be https on the configured
 * domain and the issuer must be exactly https://{domain}, so a tampered document can't redirect the flow.
 */
export async function getDiscovery(domain: string, deps: IduraDeps = {}): Promise<Discovery> {
  const now = (deps.now ?? Date.now)();
  const cached = discoveryCache.get(domain);
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.value;
  let value: Discovery;
  try {
    const res = await (deps.fetchFn ?? defaultFetch)(`https://${domain}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    value = discoverySchema.parse(await res.json());
  } catch (err) {
    throw new IduraError(
      'discovery_failed',
      `Discovery failed: ${err instanceof Error ? err.message : 'error'}`,
    );
  }
  const expectedOrigin = `https://${domain}`;
  const sameOrigin = (url: string) => new URL(url).origin === expectedOrigin;
  if (
    value.issuer.replace(/\/$/, '') !== expectedOrigin ||
    ![value.authorization_endpoint, value.token_endpoint, value.jwks_uri].every(sameOrigin)
  ) {
    throw new IduraError('discovery_failed', 'Discovery document does not belong to the configured domain');
  }
  discoveryCache.set(domain, { at: now, value });
  return value;
}

// --- PKCE / random values ----------------------------------------------------------------------------------------

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 256-bit random value, base64url (43 chars): state, nonce, PKCE code_verifier. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** S256 code_challenge = base64url(sha256(code_verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

// --- Authorize ---------------------------------------------------------------------------------------------------

export interface AuthorizeParams {
  country: 'DK' | 'SE' | 'NO' | 'FI';
  minAge: 15 | 16 | 18 | 21;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export async function buildAuthorizeUrl(
  config: IduraConfig,
  discovery: Discovery,
  params: AuthorizeParams,
): Promise<string> {
  const url = new URL(discovery.authorization_endpoint);
  const query = {
    response_type: 'code',
    response_mode: 'query',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: `openid is_over_${params.minAge}`,
    acr_values: AGE_VERIFICATION_ACR,
    login_hint: `country:${params.country}`,
    state: params.state,
    nonce: params.nonce,
    code_challenge: await codeChallenge(params.codeVerifier),
    code_challenge_method: 'S256',
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

// --- Token exchange + id_token -------------------------------------------------------------------------------------

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });

/** application/x-www-form-urlencoded encoding (RFC 6749 §2.3.1 for the Basic credentials). */
const formEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');

/** Exchanges the authorization code. Returns the raw id_token only (access token is not used or kept). */
export async function exchangeCode(
  config: IduraConfig,
  discovery: Discovery,
  code: string,
  codeVerifier: string,
  deps: IduraDeps = {},
): Promise<string> {
  const credentials = btoa(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`);
  let res: Response;
  try {
    res = await (deps.fetchFn ?? defaultFetch)(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new IduraError(
      'token_exchange_failed',
      `Token request failed: ${err instanceof Error ? err.name : 'error'}`,
    );
  }
  if (!res.ok) {
    // Only the OAuth error code is kept (never the body: it could echo request values).
    let error = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error)) error = body.error;
    } catch {
      // not JSON
    }
    throw new IduraError('token_exchange_failed', `Token request rejected: ${error}`);
  }
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new IduraError('token_exchange_failed', 'Token response without id_token');
  return parsed.data.id_token;
}

function keySet(jwksUri: string, fetchFn: FetchFn | undefined) {
  if (fetchFn) return createRemoteJWKSet(new URL(jwksUri), { [customFetch]: fetchFn });
  let set = jwksCache.get(jwksUri);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: HTTP_TIMEOUT_MS });
    jwksCache.set(jwksUri, set);
  }
  return set;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < y.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Seconds since the epoch of the authentication: authenticationinstant (ISO or number), else iat. */
function authenticatedAtS(payload: JWTPayload): number | null {
  const instant = payload['authenticationinstant'];
  if (typeof instant === 'number' && Number.isFinite(instant))
    return instant > 1e12 ? instant / 1000 : instant;
  if (typeof instant === 'string') {
    const ms = Date.parse(instant);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return typeof payload.iat === 'number' ? payload.iat : null;
}

/** The only id_token data AgeShield uses. */
export interface AgeClaims {
  /** The age claim object, or null if the token has none. */
  age: Record<string, unknown> | null;
}

/**
 * Verifies the id_token: RS256 signature against the tenant's JWKS, iss, aud, nbf (and exp, which jose checks too),
 * nonce (constant-time), and that the authentication happened within MAX_AUTH_AGE_S. Returns the age claim object only.
 */
export async function verifyIdToken(
  config: IduraConfig,
  discovery: Discovery,
  idToken: string,
  expectedNonce: string,
  deps: IduraDeps = {},
): Promise<AgeClaims> {
  const nowMs = (deps.now ?? Date.now)();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet(discovery.jwks_uri, deps.fetchFn), {
      algorithms: ['RS256'],
      issuer: discovery.issuer,
      audience: config.clientId,
      clockTolerance: CLOCK_TOLERANCE_S,
      currentDate: new Date(nowMs),
    }));
  } catch (err) {
    throw new IduraError(
      'id_token_invalid',
      `id_token rejected: ${err instanceof Error ? err.name : 'error'}`,
    );
  }
  if (typeof payload['nonce'] !== 'string' || !timingSafeEqualString(payload['nonce'], expectedNonce)) {
    throw new IduraError('nonce_mismatch', 'id_token nonce does not match');
  }
  const authAt = authenticatedAtS(payload);
  const nowS = nowMs / 1000;
  if (authAt === null || nowS - authAt > MAX_AUTH_AGE_S || authAt - nowS > CLOCK_TOLERANCE_S) {
    throw new IduraError('auth_too_old', 'Authentication is missing a time or is older than 10 minutes');
  }
  const age = payload[AGE_CLAIM];
  return {
    age:
      age !== null && typeof age === 'object' && !Array.isArray(age)
        ? (age as Record<string, unknown>)
        : null,
  };
}

export type AgeResult =
  | { result: 'verified'; auditId: string | null }
  | { result: 'rejected'; auditId: string | null }
  | { result: 'error'; errorCode: 'age_claim_missing' | 'country_mismatch' };

const AUDIT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Maps the age claim: is_over_{minAge} === true → verified, === false → rejected (an underage login completes
 * normally); claim missing or another country → error. auditId is Idura's audit reference (no personal data).
 */
export function ageResult(claims: AgeClaims, country: string, minAge: number): AgeResult {
  const age = claims.age;
  if (!age) return { result: 'error', errorCode: 'age_claim_missing' };
  if (age['country'] !== country) return { result: 'error', errorCode: 'country_mismatch' };
  const auditId =
    typeof age['auditId'] === 'string' && AUDIT_ID_RE.test(age['auditId']) ? age['auditId'] : null;
  const over = age[`is_over_${minAge}`];
  if (over === true) return { result: 'verified', auditId };
  if (over === false) return { result: 'rejected', auditId };
  return { result: 'error', errorCode: 'age_claim_missing' };
}

/**
 * Callback ?error= (no code): the user cancelled, the eID couldn't meet the required assurance level (MitID CTL002
 * "raise your assurance level"), or anything else. Only a sanitized code is kept.
 */
export function callbackErrorResult(
  error: string,
  description: string | undefined,
): { result: 'cancelled' } | { result: 'error'; errorCode: string } {
  const text = `${error} ${description ?? ''}`;
  if (/CTL002|assurance|\bial\b/i.test(text)) return { result: 'error', errorCode: 'assurance_level' };
  if (/cancel/i.test(text) || error === 'access_denied') return { result: 'cancelled' };
  const code = error
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 64);
  return { result: 'error', errorCode: code ? `oidc_${code}` : 'oidc_error' };
}
