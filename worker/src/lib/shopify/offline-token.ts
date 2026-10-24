import type { Env } from '../../env';
import { decryptString, encryptString } from '../crypto';
import {
  exchangeSessionToken,
  refreshOfflineToken,
  RefreshTokenExpiredError,
  type AppCredentials,
  type FetchFn,
  type OfflineTokenSet,
} from './token-exchange';

/** Refresh when the access token expires within this margin. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** Per-shop lock lifetime; a crashed holder can't block refreshes longer than this. */
const LOCK_TTL_MS = 30_000;
const LOCK_POLL_MS = 250;
const MAX_LOCK_WAITS = 40;

/** Encrypted token columns of a `shops` row. */
export interface StoredTokens {
  accessTokenEnc: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenEnc: string | null;
  refreshTokenExpiresAt: number | null;
  scope: string | null;
  uninstalledAt: number | null;
}

export interface EncryptedTokenSet {
  accessTokenEnc: string;
  accessTokenExpiresAt: number;
  refreshTokenEnc: string;
  refreshTokenExpiresAt: number | null;
  scope: string | null;
}

/** Persistence for offline tokens + the per-shop refresh lock (`shops.refreshing_until`). */
export interface TokenStore {
  load(shop: string): Promise<StoredTokens | null>;
  ensureRow(shop: string, now: number): Promise<void>;
  /** Acquire the lock until `until` if it is free or expired. Returns true when acquired. */
  tryLock(shop: string, now: number, until: number): Promise<boolean>;
  unlock(shop: string, until: number): Promise<void>;
  save(shop: string, tokens: EncryptedTokenSet, now: number): Promise<void>;
  clearTokens(shop: string): Promise<void>;
}

export interface TokenManagerDeps {
  store: TokenStore;
  credentials: AppCredentials;
  encryptionKey: string;
  fetchFn?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GetTokenOptions {
  /** Raw ID token from the current request; enables token exchange when no usable offline token exists. */
  idToken?: string;
  /** Access token Shopify just rejected with 401; forces a refresh if it is still the stored one. */
  rejectedToken?: string;
}

export interface OfflineAccess {
  accessToken: string;
  scope: string | null;
}

/** No usable offline token and no ID token to exchange: the merchant must open the app again. */
export class NoOfflineTokenError extends Error {
  override name = 'NoOfflineTokenError';
}

export class TokenLockTimeoutError extends Error {
  override name = 'TokenLockTimeoutError';
}

type Plan =
  | { kind: 'use'; accessToken: string }
  | { kind: 'refresh'; refreshToken: string; accessToken: string | null }
  | { kind: 'exchange' }
  | { kind: 'reauth' };

async function plan(
  row: StoredTokens | null,
  now: number,
  opts: GetTokenOptions,
  encryptionKey: string,
): Promise<Plan> {
  const missing = { kind: opts.idToken ? 'exchange' : 'reauth' } as const;
  if (!row || row.uninstalledAt !== null || !row.accessTokenEnc || !row.refreshTokenEnc) return missing;

  const accessToken = await decryptString(row.accessTokenEnc, encryptionKey);
  const fresh = (row.accessTokenExpiresAt ?? 0) - REFRESH_MARGIN_MS > now;
  if (fresh && accessToken !== opts.rejectedToken) return { kind: 'use', accessToken };

  if (row.refreshTokenExpiresAt !== null && row.refreshTokenExpiresAt <= now) return missing;
  const refreshToken = await decryptString(row.refreshTokenEnc, encryptionKey);
  const stillValid = (row.accessTokenExpiresAt ?? 0) > now && accessToken !== opts.rejectedToken;
  return { kind: 'refresh', refreshToken, accessToken: stillValid ? accessToken : null };
}

async function persist(deps: TokenManagerDeps, shop: string, set: OfflineTokenSet, now: number) {
  await deps.store.save(
    shop,
    {
      accessTokenEnc: await encryptString(set.accessToken, deps.encryptionKey),
      accessTokenExpiresAt: set.accessTokenExpiresAt,
      refreshTokenEnc: await encryptString(set.refreshToken, deps.encryptionKey),
      refreshTokenExpiresAt: set.refreshTokenExpiresAt,
      scope: set.scope,
    },
    now,
  );
  return { accessToken: set.accessToken, scope: set.scope };
}

/**
 * Returns a usable expiring offline access token for `shop`, refreshing (≥5 min before expiry) or running
 * token exchange as needed. Refresh and exchange both run under the per-shop lock: Shopify retires the
 * result of one if the other runs at the same time for the same store.
 */
export async function getOfflineAccessToken(
  deps: TokenManagerDeps,
  shop: string,
  opts: GetTokenOptions = {},
): Promise<OfflineAccess> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let wait = 0; wait <= MAX_LOCK_WAITS; wait++) {
    const row = await deps.store.load(shop);
    const first = await plan(row, now(), opts, deps.encryptionKey);
    if (first.kind === 'use') return { accessToken: first.accessToken, scope: row?.scope ?? null };
    if (first.kind === 'reauth') throw new NoOfflineTokenError(`No offline token for ${shop}`);

    if (!row) await deps.store.ensureRow(shop, now());
    const until = now() + LOCK_TTL_MS;
    if (!(await deps.store.tryLock(shop, now(), until))) {
      // Another request is refreshing. Keep using the current token while it is still valid.
      if (first.kind === 'refresh' && first.accessToken) {
        return { accessToken: first.accessToken, scope: row?.scope ?? null };
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }

    try {
      // Re-check under the lock: another request may have finished just before we acquired it.
      const locked = await deps.store.load(shop);
      const next = await plan(locked, now(), opts, deps.encryptionKey);
      if (next.kind === 'use') return { accessToken: next.accessToken, scope: locked?.scope ?? null };
      if (next.kind === 'reauth') throw new NoOfflineTokenError(`No offline token for ${shop}`);

      if (next.kind === 'refresh') {
        try {
          const set = await refreshOfflineToken(
            shop,
            next.refreshToken,
            deps.credentials,
            now(),
            deps.fetchFn,
          );
          return await persist(deps, shop, { ...set, scope: set.scope ?? locked?.scope ?? null }, now());
        } catch (err) {
          if (!(err instanceof RefreshTokenExpiredError)) throw err;
          await deps.store.clearTokens(shop);
          if (!opts.idToken) throw new NoOfflineTokenError(`Refresh token expired for ${shop}`);
        }
      }

      if (!opts.idToken) throw new NoOfflineTokenError(`No offline token for ${shop}`);
      const set = await exchangeSessionToken(shop, opts.idToken, deps.credentials, now(), deps.fetchFn);
      return await persist(deps, shop, set, now());
    } finally {
      await deps.store.unlock(shop, until);
    }
  }
  throw new TokenLockTimeoutError(`Timed out waiting for the token lock of ${shop}`);
}

interface ShopTokenRow {
  access_token_enc: string | null;
  access_token_expires_at: number | null;
  refresh_token_enc: string | null;
  refresh_token_expires_at: number | null;
  scope: string | null;
  uninstalled_at: number | null;
}

export function createD1TokenStore(db: D1Database): TokenStore {
  return {
    async load(shop) {
      const row = await db
        .prepare(
          `SELECT access_token_enc, access_token_expires_at, refresh_token_enc, refresh_token_expires_at,
                  scope, uninstalled_at
             FROM shops WHERE shop = ?1`,
        )
        .bind(shop)
        .first<ShopTokenRow>();
      if (!row) return null;
      return {
        accessTokenEnc: row.access_token_enc,
        accessTokenExpiresAt: row.access_token_expires_at,
        refreshTokenEnc: row.refresh_token_enc,
        refreshTokenExpiresAt: row.refresh_token_expires_at,
        scope: row.scope,
        uninstalledAt: row.uninstalled_at,
      };
    },
    async ensureRow(shop, now) {
      await db
        .prepare('INSERT INTO shops (shop, installed_at) VALUES (?1, ?2) ON CONFLICT(shop) DO NOTHING')
        .bind(shop, now)
        .run();
    },
    async tryLock(shop, now, until) {
      const res = await db
        .prepare(
          `UPDATE shops SET refreshing_until = ?1
            WHERE shop = ?2 AND (refreshing_until IS NULL OR refreshing_until < ?3)`,
        )
        .bind(until, shop, now)
        .run();
      return res.meta.changes === 1;
    },
    async unlock(shop, until) {
      await db
        .prepare('UPDATE shops SET refreshing_until = NULL WHERE shop = ?1 AND refreshing_until = ?2')
        .bind(shop, until)
        .run();
    },
    async save(shop, tokens, now) {
      await db
        .prepare(
          `UPDATE shops SET
             access_token_enc = ?1, access_token_expires_at = ?2,
             refresh_token_enc = ?3, refresh_token_expires_at = ?4,
             scope = COALESCE(?5, scope),
             installed_at = CASE WHEN uninstalled_at IS NOT NULL THEN ?6 ELSE installed_at END,
             uninstalled_at = NULL
           WHERE shop = ?7`,
        )
        .bind(
          tokens.accessTokenEnc,
          tokens.accessTokenExpiresAt,
          tokens.refreshTokenEnc,
          tokens.refreshTokenExpiresAt,
          tokens.scope,
          now,
          shop,
        )
        .run();
    },
    async clearTokens(shop) {
      await db
        .prepare(
          `UPDATE shops SET access_token_enc = NULL, access_token_expires_at = NULL,
                            refresh_token_enc = NULL, refresh_token_expires_at = NULL
            WHERE shop = ?1`,
        )
        .bind(shop)
        .run();
    },
  };
}

export function tokenManagerFromEnv(env: Env): TokenManagerDeps {
  return {
    store: createD1TokenStore(env.DB),
    credentials: { apiKey: env.SHOPIFY_API_KEY, apiSecret: env.SHOPIFY_API_SECRET },
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
  };
}
