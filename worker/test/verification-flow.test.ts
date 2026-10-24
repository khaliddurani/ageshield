import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { app } from '../src/index';
import { AGE_CLAIM, codeChallenge, resetIduraCaches } from '../src/lib/idura';
import { saveSettings, DEFAULT_SETTINGS } from '../src/services/settings';
import { completeVerification, START_RATE_LIMIT, STATE_TTL_MS } from '../src/services/verification';
import { verifyVerificationToken } from '../src/services/verification-token';
import { createTestD1, type TestD1 } from './d1';
import { FakeIdura, ISSUER } from './fake-idura';
import { FakeShopify } from './fake-shopify';
import {
  APP_URL,
  IDURA_CLIENT_ID,
  IDURA_CLIENT_SECRET,
  SHOP,
  SIGNING_KEY,
  makeEnv,
  seedShop,
} from './helpers';
import { signedQuery } from './signing';

// /verify/start looks up the shop's storefront domains with the shop's Admin client; the route gets a fake.
let shopify = new FakeShopify();
vi.mock('../src/lib/shopify/admin', async (original) => ({
  ...(await original<typeof import('../src/lib/shopify/admin')>()),
  adminClientForShop: () => shopify.admin,
}));

let d1: TestD1;
let idura: FakeIdura;
let env: Env;

beforeEach(async () => {
  resetIduraCaches();
  d1 = await createTestD1();
  seedShop(d1.raw);
  idura = await FakeIdura.create();
  shopify = new FakeShopify();
  env = makeEnv({ DB: d1.db });
  vi.stubGlobal('fetch', idura.fetch); // the routes use the global fetch (and jose's JWKS fetch)
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function start(body: unknown, ip = '203.0.113.7', query?: string) {
  return app.request(
    `/proxy/verify/start?${query ?? (await signedQuery())}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `${ip}, 10.0.0.1` },
    },
    env,
  );
}

interface StateRow {
  state: string;
  nonce: string;
  code_verifier: string;
  country: string;
  min_age: number;
  return_url: string;
  expires_at: number;
}
const stateRow = () => d1.query<StateRow>('SELECT * FROM oidc_states')[0] as StateRow;
const verifications = () =>
  d1.query<Record<string, unknown>>('SELECT * FROM verifications ORDER BY created_at, rowid');

/** Starts a login through the proxy and returns its state row (nonce wired into the fake tenant). */
async function begin(country = 'DK', minAge = 18, returnPath = '/products/snus?variant=1') {
  const res = await start({ country, minAge, returnPath, host: SHOP });
  expect(res.status).toBe(200);
  const row = stateRow();
  idura.nonce = row.nonce;
  return row;
}

function callback(params: Record<string, string>, now = idura.now) {
  return completeVerification(env, new URLSearchParams(params), now, { fetchFn: idura.fetch });
}

const fragmentOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1));

describe('POST /proxy/verify/start', () => {
  it('returns the Idura authorize URL with PKCE, state, nonce, age scope, acr and country hint — never a redirect', async () => {
    const res = await start({ country: 'DK', minAge: 18, returnPath: '/products/snus?variant=1#reviews' });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    const row = stateRow();
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      response_mode: 'query',
      client_id: IDURA_CLIENT_ID,
      redirect_uri: `${APP_URL}/oidc/callback`,
      scope: 'openid is_over_18',
      acr_values: 'urn:age-verification',
      login_hint: 'country:DK',
      state: row.state,
      nonce: row.nonce,
      code_challenge: await codeChallenge(row.code_verifier),
      code_challenge_method: 'S256',
    });
    expect(authorizeUrl).not.toContain(row.code_verifier);
    // No host sent: the shop's primary domain; the client's fragment is dropped.
    expect(row.return_url).toBe('https://snusbutik.dk/products/snus?variant=1');
    expect(
      row.expires_at -
        Number(d1.query<{ created_at: number }>('SELECT created_at FROM oidc_states')[0]?.created_at),
    ).toBe(STATE_TTL_MS);
  });

  it('returns the shopper to their own market domain, never to a foreign or look-alike host', async () => {
    const cases: [string, string][] = [
      ['snusbutik.se', 'https://snusbutik.se/products/x'],
      ['snusbutik.no', 'https://snusbutik.no/products/x'],
      [SHOP, `https://${SHOP}/products/x`],
      ['evil.com', 'https://snusbutik.dk/products/x'],
      ['snusbutik.se.evil.com', 'https://snusbutik.dk/products/x'],
      ['evil-snusbutik.se', 'https://snusbutik.dk/products/x'],
    ];
    for (const [host, expected] of cases) {
      d1.raw.run('DELETE FROM oidc_states');
      const res = await start({ country: 'DK', minAge: 18, returnPath: '/products/x', host });
      expect(res.status, host).toBe(200);
      expect(stateRow().return_url, host).toBe(expected);
    }
    expect(shopify.opCount('AgeShieldStorefrontDomains')).toBe(1); // cached on the shops row
  });

  it('accepts only store-relative return paths', async () => {
    for (const returnPath of [
      '//evil.com/x',
      'https://evil.com',
      '/\\evil.com',
      'products/x',
      '/a\nb',
      '\\\\evil',
    ]) {
      const res = await start({ country: 'DK', minAge: 18, returnPath });
      expect(res.status, JSON.stringify(returnPath)).toBe(400);
    }
    expect(d1.query('SELECT * FROM oidc_states')).toEqual([]);
  });

  it('validates the body with Zod (country, age, path)', async () => {
    for (const body of [
      { country: 'DE', minAge: 18, returnPath: '/' },
      { country: 'DK', minAge: 17, returnPath: '/' },
      { country: 'DK', minAge: '18', returnPath: '/' },
      { country: 'DK', minAge: 18 },
      'not json',
    ]) {
      expect((await start(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses countries the merchant has not enabled, and uninstalled shops', async () => {
    await saveSettings(d1.db, SHOP, { ...DEFAULT_SETTINGS, enabledCountries: ['SE'] }, 1);
    expect((await start({ country: 'DK', minAge: 18, returnPath: '/' })).status).toBe(403);
    expect((await start({ country: 'SE', minAge: 18, returnPath: '/' })).status).toBe(200);
    d1.raw.run('UPDATE shops SET uninstalled_at = 5');
    expect((await start({ country: 'SE', minAge: 18, returnPath: '/' })).status).toBe(404);
  });

  it('rate-limits per hashed client IP (no raw IP stored)', async () => {
    for (let i = 0; i < START_RATE_LIMIT.limit; i++) {
      expect((await start({ country: 'DK', minAge: 18, returnPath: '/' })).status).toBe(200);
    }
    const limited = await start({ country: 'DK', minAge: 18, returnPath: '/' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await start({ country: 'DK', minAge: 18, returnPath: '/' }, '198.51.100.1')).status).toBe(200);
    expect(JSON.stringify(d1.query('SELECT * FROM rate_limits'))).not.toContain('203.0.113.7');
  });

  it('requires a valid App Proxy signature', async () => {
    const res = await start(
      { country: 'DK', minAge: 18, returnPath: '/' },
      undefined,
      await signedQuery({}, 'wrong'),
    );
    expect(res.status).toBe(401);
  });

  it('Idura unreachable → 503 idp_unavailable, no state row', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }));
    const res = await start({ country: 'DK', minAge: 18, returnPath: '/' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'idp_unavailable' });
    expect(d1.query('SELECT * FROM oidc_states')).toEqual([]);
  });
});

describe('GET /oidc/callback', () => {
  it('verified adult (Theo71754 shape) → token in the fragment, single-use state, no personal data stored', async () => {
    const row = await begin();
    const outcome = await callback({ code: 'auth-code-1', state: row.state });
    expect(outcome.kind).toBe('redirect');
    const url = outcome.kind === 'redirect' ? outcome.url : '';
    expect(url.startsWith(`https://${SHOP}/products/snus?variant=1#ageshield=`)).toBe(true);
    expect(new URL(url).search).toBe('?variant=1'); // token never in the query string

    const token = fragmentOf(url).get('ageshield') ?? '';
    const check = await verifyVerificationToken(SIGNING_KEY, SHOP, token, Math.floor(idura.now / 1000) + 60);
    expect(check).toMatchObject({
      valid: true,
      payload: { v: 1, shop: SHOP, min_age: 18, country: 'DK', audit_id: 'alu_test_123' },
    });

    const [v] = verifications();
    expect(v).toMatchObject({
      shop: SHOP,
      country: 'DK',
      min_age: 18,
      result: 'verified',
      audit_id: 'alu_test_123',
    });
    expect(check.valid && check.payload.vid).toBe(v?.['id']);
    expect(v?.['token_expires_at']).toBe((Math.floor(idura.now / 1000) + 1800) * 1000);
    const stored =
      JSON.stringify(d1.query('SELECT * FROM verifications')) +
      JSON.stringify(d1.query('SELECT * FROM audit_log'));
    for (const secret of ['pseudonym', 'nameid', 'session-must', 'dkmitid'])
      expect(stored).not.toContain(secret);

    expect(d1.query('SELECT * FROM oidc_states')).toEqual([]);
    expect(await callback({ code: 'auth-code-1', state: row.state })).toEqual({ kind: 'page', status: 400 });
  });

  it('exchanges the code with Basic client auth (form-encoded id:secret) and the PKCE verifier', async () => {
    const row = await begin();
    await callback({ code: 'auth-code-1', state: row.state });
    const [req] = idura.tokenRequests;
    const expected = btoa(
      `${encodeURIComponent(IDURA_CLIENT_ID)}:${encodeURIComponent(IDURA_CLIENT_SECRET)}`,
    );
    expect(req?.headers.get('authorization')).toBe(`Basic ${expected}`);
    expect(req?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(req?.body ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      client_id: IDURA_CLIENT_ID,
      redirect_uri: `${APP_URL}/oidc/callback`,
      code_verifier: row.code_verifier,
    });
  });

  it('underage (Phil62998 shape, is_over_18: false) → rejected, no token', async () => {
    const row = await begin();
    idura.claims = { [AGE_CLAIM]: { country: 'DK', auditId: 'alu_minor', is_over_18: false } };
    const outcome = await callback({ code: 'c', state: row.state });
    const fragment = fragmentOf(outcome.kind === 'redirect' ? outcome.url : 'https://x');
    expect(Object.fromEntries(fragment)).toEqual({
      ageshield_status: 'rejected',
      ageshield_age: '18',
      ageshield_country: 'DK',
    });
    expect(verifications()[0]).toMatchObject({
      result: 'rejected',
      audit_id: 'alu_minor',
      token_expires_at: null,
    });
  });

  it('reads the claim for the requested threshold (is_over_21 for a 21+ product)', async () => {
    let row = await begin('DK', 21);
    idura.claims = { [AGE_CLAIM]: { country: 'DK', auditId: 'a', is_over_21: true } };
    let outcome = await callback({ code: 'c', state: row.state });
    expect(outcome.kind === 'redirect' && fragmentOf(outcome.url).has('ageshield')).toBe(true);

    d1.raw.run('DELETE FROM verifications');
    row = await begin('DK', 21);
    idura.claims = { [AGE_CLAIM]: { country: 'DK', auditId: 'a', is_over_18: true } }; // wrong threshold only
    outcome = await callback({ code: 'c', state: row.state });
    expect(outcome.kind === 'redirect' && fragmentOf(outcome.url).get('ageshield_status')).toBe('error');
    expect(verifications()[0]).toMatchObject({ result: 'error', error_code: 'age_claim_missing' });
  });

  it('claim missing or another country → error', async () => {
    let row = await begin();
    idura.claims = { [AGE_CLAIM]: undefined };
    await callback({ code: 'c', state: row.state });
    row = await begin();
    idura.claims = { [AGE_CLAIM]: { country: 'SE', is_over_18: true } };
    await callback({ code: 'c', state: row.state });
    expect(verifications().map((v) => v['error_code'])).toEqual(['age_claim_missing', 'country_mismatch']);
  });

  it('maps callback errors: cancel → cancelled, CTL002 → assurance, other → error with its code', async () => {
    const cases: [Record<string, string>, string, string, string | null][] = [
      [{ error: 'access_denied', error_description: 'User cancelled' }, 'cancelled', 'cancelled', null],
      [
        { error: 'access_denied', error_description: 'CTL002: raise your assurance level' },
        'assurance',
        'error',
        'assurance_level',
      ],
      [{ error: 'server_error', error_description: 'boom' }, 'error', 'error', 'oidc_server_error'],
    ];
    for (const [params, status, result, code] of cases) {
      const row = await begin();
      const outcome = await callback({ ...params, state: row.state });
      expect(outcome.kind === 'redirect' && fragmentOf(outcome.url).get('ageshield_status')).toBe(status);
      expect(verifications().at(-1)).toMatchObject({ result, error_code: code });
    }
    expect(idura.tokenRequests).toEqual([]);
  });

  it('expired state (>10 min) → expired, recorded, state deleted', async () => {
    const row = await begin();
    const outcome = await callback({ code: 'c', state: row.state }, row.expires_at + 1);
    expect(outcome.kind === 'redirect' && fragmentOf(outcome.url).get('ageshield_status')).toBe('expired');
    expect(verifications()[0]).toMatchObject({ result: 'error', error_code: 'state_expired' });
    expect(d1.query('SELECT * FROM oidc_states')).toEqual([]);
  });

  it('unknown or malformed state → static page, nothing recorded', async () => {
    expect(await callback({ code: 'c', state: 'x'.repeat(43) })).toEqual({ kind: 'page', status: 400 });
    expect(await callback({ code: 'c', state: '../../etc' })).toEqual({ kind: 'page', status: 400 });
    expect(await callback({ code: 'c' })).toEqual({ kind: 'page', status: 400 });
    expect(verifications()).toEqual([]);
  });

  describe('id_token checks', () => {
    const rejectedWith = async (setup: () => void, code: string) => {
      const row = await begin();
      setup();
      const outcome = await callback({ code: 'c', state: row.state });
      expect(outcome.kind === 'redirect' && fragmentOf(outcome.url).get('ageshield_status')).toBe('error');
      expect(verifications().at(-1)).toMatchObject({ result: 'error', error_code: code });
    };

    it('signature from a key not in the JWKS', () =>
      rejectedWith(() => (idura.signWithOtherKey = true), 'id_token_invalid'));
    it('wrong audience', () =>
      rejectedWith(() => (idura.claims = { aud: 'urn:other:app' }), 'id_token_invalid'));
    it('wrong issuer', () =>
      rejectedWith(() => (idura.claims = { iss: 'https://evil.idura.broker' }), 'id_token_invalid'));
    it('nbf in the future', () =>
      rejectedWith(() => (idura.claims = { nbf: Math.floor(idura.now / 1000) + 3600 }), 'id_token_invalid'));
    it('nonce mismatch', () => rejectedWith(() => (idura.claims = { nonce: 'replayed' }), 'nonce_mismatch'));
    it('authentication older than 10 minutes, even though exp is years ahead', () =>
      rejectedWith(
        () => (idura.claims = { authenticationinstant: new Date(idura.now - 11 * 60_000).toISOString() }),
        'auth_too_old',
      ));
    it('falls back to iat when authenticationinstant is missing', () =>
      rejectedWith(
        () => (idura.claims = { authenticationinstant: undefined, iat: Math.floor(idura.now / 1000) - 3600 }),
        'auth_too_old',
      ));
    it('token endpoint rejects the code', () =>
      rejectedWith(
        () =>
          (idura.tokenError = {
            status: 400,
            body: { error: 'invalid_grant', error_description: 'code used' },
          }),
        'token_exchange_failed',
      ));
  });

  it('does not require any ial value', async () => {
    const row = await begin();
    idura.claims = { ial: 'low' };
    const outcome = await callback({ code: 'c', state: row.state });
    expect(outcome.kind === 'redirect' && fragmentOf(outcome.url).has('ageshield')).toBe(true);
  });

  it('end to end over HTTP: 302 to the store with no-referrer, and the code is never logged', async () => {
    const row = await begin();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    idura.signWithOtherKey = true; // forces an error path that logs
    const res = await app.request(`/oidc/callback?code=secret-code-123&state=${row.state}`, {}, env);
    const logged = spy.mock.calls.flat().join(' ');
    spy.mockRestore();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(
      new RegExp(`^https://${SHOP}/products/snus\\?variant=1#ageshield_status=error`),
    );
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(logged).not.toContain('secret-code-123');
    expect(logged).not.toContain(row.state);

    const page = await app.request(
      `/oidc/callback?code=x&state=${row.state}`,
      { headers: { 'Accept-Language': 'da-DK' } },
      env,
    );
    expect(page.status).toBe(400);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Aldersbekræftelse');
  });

  it('rejects a discovery document whose endpoints point elsewhere', async () => {
    const row = await begin();
    resetIduraCaches();
    idura.discoveryOverride = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: 'https://evil.example.com/token',
      jwks_uri: `${ISSUER}/.well-known/jwks`,
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await callback({ code: 'c', state: row.state });
    spy.mockRestore();
    expect(verifications()[0]).toMatchObject({ result: 'error', error_code: 'discovery_failed' });
    expect(idura.tokenRequests).toEqual([]);
  });
});
