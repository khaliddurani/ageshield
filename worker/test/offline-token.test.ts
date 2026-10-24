import { describe, expect, it } from 'vitest';
import { decryptString, encryptString } from '../src/lib/crypto';
import {
  getOfflineAccessToken,
  NoOfflineTokenError,
  REFRESH_MARGIN_MS,
  type TokenManagerDeps,
} from '../src/lib/shopify/offline-token';
import { InvalidSubjectTokenError } from '../src/lib/shopify/token-exchange';
import { API_KEY, API_SECRET, ENCRYPTION_KEY, MemoryTokenStore, SHOP, json, queuedFetch } from './helpers';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

async function seed(store: MemoryTokenStore, access: string, accessExpiresAt: number, refresh = 'refresh-1') {
  await store.ensureRow(SHOP);
  await store.save(SHOP, {
    accessTokenEnc: await encryptString(access, ENCRYPTION_KEY),
    accessTokenExpiresAt: accessExpiresAt,
    refreshTokenEnc: await encryptString(refresh, ENCRYPTION_KEY),
    refreshTokenExpiresAt: NOW + 90 * 24 * HOUR,
    scope: 'read_products,read_orders',
  });
}

function deps(store: MemoryTokenStore, fetchFn: TokenManagerDeps['fetchFn']): TokenManagerDeps {
  return {
    store,
    credentials: { apiKey: API_KEY, apiSecret: API_SECRET },
    encryptionKey: ENCRYPTION_KEY,
    fetchFn,
    now: () => NOW,
    sleep: async () => {},
  };
}

const tokenResponse = (access: string, refresh: string) =>
  json({
    access_token: access,
    expires_in: 3600,
    refresh_token: refresh,
    refresh_token_expires_in: 7_776_000,
    scope: 'read_products,read_orders',
  });

function formBody(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body));
}

describe('getOfflineAccessToken', () => {
  it('uses a stored token that is not near expiry without calling Shopify', async () => {
    const store = new MemoryTokenStore();
    await seed(store, 'access-1', NOW + HOUR);
    const { fn, requests } = queuedFetch([]);
    const result = await getOfflineAccessToken(deps(store, fn), SHOP);
    expect(result.accessToken).toBe('access-1');
    expect(requests).toHaveLength(0);
  });

  it('refreshes when the token expires within 5 minutes and stores the rotated tokens encrypted', async () => {
    const store = new MemoryTokenStore();
    await seed(store, 'access-1', NOW + REFRESH_MARGIN_MS - 1);
    const { fn, requests } = queuedFetch([tokenResponse('access-2', 'refresh-2')]);

    const result = await getOfflineAccessToken(deps(store, fn), SHOP);

    expect(result.accessToken).toBe('access-2');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(new Headers(requests[0]?.init?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = formBody(requests[0]?.init);
    expect(Object.fromEntries(body)).toEqual({
      client_id: API_KEY,
      client_secret: API_SECRET,
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });

    const row = store.rows.get(SHOP);
    expect(row?.accessTokenEnc).not.toContain('access-2');
    expect(await decryptString(row?.accessTokenEnc ?? '', ENCRYPTION_KEY)).toBe('access-2');
    expect(await decryptString(row?.refreshTokenEnc ?? '', ENCRYPTION_KEY)).toBe('refresh-2');
    expect(row?.accessTokenExpiresAt).toBe(NOW + HOUR);
    expect(row?.refreshingUntil).toBeNull();
  });

  it('refreshes when Shopify rejected the current token', async () => {
    const store = new MemoryTokenStore();
    await seed(store, 'access-1', NOW + HOUR);
    const { fn } = queuedFetch([tokenResponse('access-2', 'refresh-2')]);
    const result = await getOfflineAccessToken(deps(store, fn), SHOP, { rejectedToken: 'access-1' });
    expect(result.accessToken).toBe('access-2');
  });

  it('runs token exchange with the exact URNs when the shop has no token', async () => {
    const store = new MemoryTokenStore();
    const { fn, requests } = queuedFetch([tokenResponse('access-1', 'refresh-1')]);

    const result = await getOfflineAccessToken(deps(store, fn), SHOP, { idToken: 'raw.id.token' });

    expect(result.accessToken).toBe('access-1');
    expect(Object.fromEntries(formBody(requests[0]?.init))).toEqual({
      client_id: API_KEY,
      client_secret: API_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'raw.id.token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
    expect(store.rows.get(SHOP)?.scope).toBe('read_products,read_orders');
  });

  it('falls back to token exchange when the refresh token is rejected', async () => {
    const store = new MemoryTokenStore();
    await seed(store, 'access-1', NOW - 1);
    const { fn, requests } = queuedFetch([
      json({ error: 'invalid_grant' }, 401),
      tokenResponse('access-2', 'refresh-2'),
    ]);
    const result = await getOfflineAccessToken(deps(store, fn), SHOP, { idToken: 'raw.id.token' });
    expect(result.accessToken).toBe('access-2');
    expect(formBody(requests[1]?.init).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:token-exchange',
    );
  });

  it('requires re-auth when the refresh token is rejected and there is no ID token (cron/webhook path)', async () => {
    const store = new MemoryTokenStore();
    await seed(store, 'access-1', NOW - 1);
    const { fn } = queuedFetch([json({ error: 'invalid_grant' }, 401)]);
    await expect(getOfflineAccessToken(deps(store, fn), SHOP)).rejects.toBeInstanceOf(NoOfflineTokenError);
    expect(store.rows.get(SHOP)?.accessTokenEnc).toBeNull();
  });

  it('surfaces a rejected ID token so the API can answer 401 + retry header', async () => {
    const store = new MemoryTokenStore();
    const { fn } = queuedFetch([json({ error: 'invalid_subject_token' }, 400)]);
    await expect(
      getOfflineAccessToken(deps(store, fn), SHOP, { idToken: 'expired.id.token' }),
    ).rejects.toBeInstanceOf(InvalidSubjectTokenError);
    expect(store.rows.get(SHOP)?.refreshingUntil).toBeNull();
  });

  it('runs token exchange again after uninstall (reinstall)', async () => {
    const store = new MemoryTokenStore();
    await seed(store, 'old-access', NOW + HOUR);
    const row = store.rows.get(SHOP);
    if (row) row.uninstalledAt = NOW - HOUR;
    const { fn } = queuedFetch([tokenResponse('new-access', 'new-refresh')]);
    const result = await getOfflineAccessToken(deps(store, fn), SHOP, { idToken: 'raw.id.token' });
    expect(result.accessToken).toBe('new-access');
    expect(store.rows.get(SHOP)?.uninstalledAt).toBeNull();
  });

  it('keeps using the current token while another request holds the refresh lock', async () => {
    const store = new MemoryTokenStore();
    await seed(store, 'access-1', NOW + REFRESH_MARGIN_MS - 1);
    const row = store.rows.get(SHOP);
    if (row) row.refreshingUntil = NOW + 10_000;
    const { fn, requests } = queuedFetch([]);
    const result = await getOfflineAccessToken(deps(store, fn), SHOP);
    expect(result.accessToken).toBe('access-1');
    expect(requests).toHaveLength(0);
  });

  it('waits for the lock holder when the current token is unusable, then uses its result', async () => {
    const store = new MemoryTokenStore();
    await seed(store, 'access-1', NOW - 1);
    const row = store.rows.get(SHOP);
    if (row) row.refreshingUntil = NOW + 10_000;
    const { fn, requests } = queuedFetch([]);
    const d = deps(store, fn);
    d.sleep = async () => {
      // Simulate the other request finishing its refresh.
      await seed(store, 'access-2', NOW + HOUR, 'refresh-2');
      const r = store.rows.get(SHOP);
      if (r) r.refreshingUntil = null;
    };
    const result = await getOfflineAccessToken(d, SHOP);
    expect(result.accessToken).toBe('access-2');
    expect(requests).toHaveLength(0);
  });
});
