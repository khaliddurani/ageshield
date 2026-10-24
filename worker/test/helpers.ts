import { SignJWT } from 'jose';
import type { Env } from '../src/env';
import type { EncryptedTokenSet, StoredTokens, TokenStore } from '../src/lib/shopify/offline-token';

export const API_KEY = 'test-client-id';
export const API_SECRET = 'test-client-secret';
export const SHOP = 'demo-store.myshopify.com';
// 32 zero-to-31 bytes, base64. Test-only key.
export const ENCRYPTION_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
// 32 bytes of 0x2a, base64. Test-only key.
export const SIGNING_KEY = btoa(String.fromCharCode(...new Array<number>(32).fill(42)));
export const IDURA_DOMAIN = 'merchantkits.test.idura.broker';
export const IDURA_CLIENT_ID = 'urn:merchantkits:ageshield';
export const IDURA_CLIENT_SECRET = 'test-idura-secret';
export const APP_URL = 'https://ageshield-staging.example.workers.dev';

export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta name="shopify-api-key" content="%VITE_SHOPIFY_API_KEY%" />
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

export function makeEnv(overrides: Partial<Env> = {}): Env {
  const assets = {
    fetch: async (input: Request | string) => {
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      if (path.startsWith('/assets/')) {
        return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
      }
      return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
  return {
    ASSETS: assets,
    APP_URL,
    SHOPIFY_APP_HANDLE: 'ageshield-staging',
    SHOPIFY_API_VERSION: '2026-10',
    APP_PROXY_SUBPATH: 'ageshield-staging',
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    IDURA_DOMAIN,
    IDURA_CLIENT_ID,
    IDURA_CLIENT_SECRET,
    VERIFICATION_SIGNING_KEY: SIGNING_KEY,
    ...overrides,
  } as unknown as Env;
}

interface TokenClaims {
  aud?: string;
  iss?: string;
  dest?: string;
  exp?: number;
  nbf?: number;
}

export async function signIdToken(claims: TokenClaims = {}, secret = API_SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ dest: claims.dest ?? `https://${SHOP}`, sid: 'session-1' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(claims.iss ?? `https://${SHOP}/admin`)
    .setAudience(claims.aud ?? API_KEY)
    .setSubject('42')
    .setIssuedAt(now)
    .setNotBefore(claims.nbf ?? now)
    .setExpirationTime(claims.exp ?? now + 60)
    .sign(new TextEncoder().encode(secret));
}

/** In-memory TokenStore with the same lock semantics as the D1 store. */
export class MemoryTokenStore implements TokenStore {
  rows = new Map<string, StoredTokens & { refreshingUntil: number | null }>();
  saves = 0;

  async load(shop: string): Promise<StoredTokens | null> {
    const row = this.rows.get(shop);
    return row ? { ...row } : null;
  }
  async ensureRow(shop: string): Promise<void> {
    if (!this.rows.has(shop)) {
      this.rows.set(shop, {
        accessTokenEnc: null,
        accessTokenExpiresAt: null,
        refreshTokenEnc: null,
        refreshTokenExpiresAt: null,
        scope: null,
        uninstalledAt: null,
        refreshingUntil: null,
      });
    }
  }
  async tryLock(shop: string, now: number, until: number): Promise<boolean> {
    const row = this.rows.get(shop);
    if (!row || (row.refreshingUntil !== null && row.refreshingUntil >= now)) return false;
    row.refreshingUntil = until;
    return true;
  }
  async unlock(shop: string, until: number): Promise<void> {
    const row = this.rows.get(shop);
    if (row && row.refreshingUntil === until) row.refreshingUntil = null;
  }
  async save(shop: string, tokens: EncryptedTokenSet): Promise<void> {
    const row = this.rows.get(shop);
    if (!row) throw new Error('save without row');
    Object.assign(row, tokens, { scope: tokens.scope ?? row.scope, uninstalledAt: null });
    this.saves++;
  }
  async clearTokens(shop: string): Promise<void> {
    const row = this.rows.get(shop);
    if (row) {
      Object.assign(row, {
        accessTokenEnc: null,
        accessTokenExpiresAt: null,
        refreshTokenEnc: null,
        refreshTokenExpiresAt: null,
      });
    }
  }
}

export interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** Fake fetch that returns queued responses in order and records each request. */
export function queuedFetch(responses: Response[]) {
  const requests: RecordedRequest[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request to ${url}`);
    return next;
  };
  return { fn, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Inserts an installed shop row (no tokens unless given). */
export function seedShop(
  raw: { run(sql: string, params?: (string | number | null)[]): unknown },
  shop = SHOP,
  plan = 'free',
): void {
  raw.run("INSERT INTO shops (shop, installed_at, plan, scope) VALUES (?, 1, ?, 'read_products')", [
    shop,
    plan,
  ]);
}
