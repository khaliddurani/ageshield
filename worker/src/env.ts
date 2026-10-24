import type { JobMessage } from './queue/handlers';

/** Bindings, vars and secrets available to the Worker (see wrangler.jsonc). */
export interface Env {
  // Bindings
  DB: D1Database;
  JOBS: Queue<JobMessage>;
  ASSETS: Fetcher;

  // Vars (wrangler.jsonc → env.<name>.vars)
  /** Public base URL of this Worker; the Idura redirect_uri is `${APP_URL}/oidc/callback`. */
  APP_URL: string;
  SHOPIFY_APP_HANDLE: string;
  SHOPIFY_API_VERSION: string;
  /** App Proxy subpath (`/apps/{subpath}/…` on the store domain); matches [app_proxy] in the app toml. */
  APP_PROXY_SUBPATH: string;

  // Secrets (wrangler secret put / .dev.vars) — never log these
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  /** Idura (formerly Criipto) Verify domain, e.g. "merchantkits.test.idura.broker" (no scheme). */
  IDURA_DOMAIN: string;
  IDURA_CLIENT_ID: string;
  IDURA_CLIENT_SECRET: string;
  /** 32 random bytes, base64: HMAC key of the storefront verification tokens. */
  VERIFICATION_SIGNING_KEY: string;
}

/** Per-request values set by middleware/session-auth.ts on /api/* routes (and `shop` by the App Proxy check). */
export interface AppVariables {
  shop: string;
  idToken: string;
}

export interface AppBindings {
  Bindings: Env;
  Variables: AppVariables;
}
