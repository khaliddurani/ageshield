-- AgeShield D1 schema v1: base tables (same shape as RecallKit's). Restricted-product data lives in Shopify
-- (app-owned product metafield $app.age_restricted); see 0002 for the age-verification tables.

CREATE TABLE shops (
  shop                      TEXT PRIMARY KEY,          -- x.myshopify.com
  access_token_enc          TEXT,                      -- AES-GCM, base64(iv|ciphertext)
  access_token_expires_at   INTEGER,                   -- unix ms
  refresh_token_enc         TEXT,
  refresh_token_expires_at  INTEGER,
  refreshing_until          INTEGER,                   -- per-shop refresh/exchange lock
  scope                     TEXT,
  plan                      TEXT NOT NULL DEFAULT 'free',
  plan_handle               TEXT,                      -- App Pricing handle of the active subscription, if any
  subscription_id           TEXT,                      -- gid://shopify/AppSubscription/…
  trial_ends_at             INTEGER,                   -- createdAt + trialDays, unix ms
  current_period_end        INTEGER,
  plan_synced_at            INTEGER,                   -- last successful plan sync
  shop_name                 TEXT,
  iana_timezone             TEXT,                      -- Shopify shop.ianaTimezone; admin UI dates
  storefront_domains        TEXT,                      -- JSON {primary, hosts[]}: primary + market domains (services/shop-domains.ts)
  storefront_domains_at     INTEGER,                   -- when storefront_domains was fetched
  storefront_config_hash    TEXT,                      -- sha256 of the config last written to the app-data metafield
  installed_at              INTEGER NOT NULL,
  uninstalled_at            INTEGER
);

CREATE TABLE jobs (                                      -- user-visible progress for bulk operations
  id            TEXT PRIMARY KEY,
  shop          TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  type          TEXT NOT NULL,                          -- rules_sync
  status        TEXT NOT NULL,                          -- queued | running | done | failed | cancelled
  total         INTEGER NOT NULL DEFAULT 0,
  processed     INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_jobs_shop ON jobs(shop, created_at);

CREATE TABLE webhook_events (
  webhook_id    TEXT PRIMARY KEY,                       -- X-Shopify-Webhook-Id
  shop          TEXT NOT NULL,
  topic         TEXT NOT NULL,
  received_at   INTEGER NOT NULL
);
CREATE INDEX idx_wh_received ON webhook_events(received_at);

CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  shop          TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  details       TEXT,                                   -- JSON, no secrets, no personal data
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_shop ON audit_log(shop, created_at);

-- Fixed-window rate limiting for public endpoints (App Proxy). `key` holds a hash, never a raw IP.
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
