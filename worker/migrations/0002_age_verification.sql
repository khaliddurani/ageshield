-- Age verification (Phase 1). NO personal data in any table: never sub, name, birthdate, personal/CPR numbers or
-- plain IPs. Verifications record country, threshold and result only.

CREATE TABLE settings (
  shop               TEXT PRIMARY KEY REFERENCES shops(shop) ON DELETE CASCADE,
  enabled_countries  TEXT NOT NULL DEFAULT '["DK","SE","NO","FI"]',     -- JSON array of DK | SE | NO | FI
  default_min_age    INTEGER NOT NULL DEFAULT 18 CHECK (default_min_age IN (15, 16, 18, 21)),
  gate_mode          TEXT NOT NULL DEFAULT 'product_page' CHECK (gate_mode IN ('product_page', 'cart')),
  popup_texts        TEXT NOT NULL DEFAULT '{}',                        -- JSON { "<locale>": { heading, body, button } }
  brand_color        TEXT,                                              -- #rrggbb
  updated_at         INTEGER NOT NULL
);

CREATE TABLE restricted_rules (
  id            TEXT PRIMARY KEY,
  shop          TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('product', 'collection', 'tag')),
  resource_gid  TEXT,                                   -- product / collection gid (type product | collection)
  tag           TEXT,                                   -- product tag (type tag), matched case-insensitively
  min_age       INTEGER CHECK (min_age IS NULL OR min_age IN (15, 16, 18, 21)),   -- NULL = settings.default_min_age
  created_at    INTEGER NOT NULL,
  CHECK ((type = 'tag' AND tag IS NOT NULL AND resource_gid IS NULL)
      OR (type IN ('product', 'collection') AND resource_gid IS NOT NULL AND tag IS NULL))
);
CREATE UNIQUE INDEX idx_rules_unique ON restricted_rules(shop, type, COALESCE(resource_gid, lower(tag)));

-- Mirror of the app-owned product metafield $app.age_restricted (Shopify is the source of truth for storefront and
-- Function). min_age = value written to Shopify (NULL: not written yet); desired_* = result of the current sync run.
CREATE TABLE restricted_products (
  shop             TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  product_gid      TEXT NOT NULL,
  min_age          INTEGER,
  desired_min_age  INTEGER,
  desired_run      TEXT,                                -- jobs.id of the sync run that computed desired_min_age
  synced_at        INTEGER,
  PRIMARY KEY (shop, product_gid)
);
CREATE INDEX idx_rp_run ON restricted_products(shop, desired_run);

-- One row per started Idura login: single use (deleted by the callback), 10-minute lifetime, purged by the cron.
CREATE TABLE oidc_states (
  state          TEXT PRIMARY KEY,                      -- random, 256 bit
  shop           TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  nonce          TEXT NOT NULL,
  code_verifier  TEXT NOT NULL,                         -- PKCE
  country        TEXT NOT NULL CHECK (country IN ('DK', 'SE', 'NO', 'FI')),
  min_age        INTEGER NOT NULL CHECK (min_age IN (15, 16, 18, 21)),
  return_url     TEXT NOT NULL,                         -- absolute https://{store host}/… built by the Worker
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX idx_oidc_expires ON oidc_states(expires_at);

CREATE TABLE verifications (
  id                TEXT PRIMARY KEY,                   -- uuid, "vid" in the verification token
  shop              TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  country           TEXT NOT NULL CHECK (country IN ('DK', 'SE', 'NO', 'FI')),
  min_age           INTEGER NOT NULL CHECK (min_age IN (15, 16, 18, 21)),
  result            TEXT NOT NULL CHECK (result IN ('verified', 'rejected', 'cancelled', 'error')),
  error_code        TEXT,                               -- result 'error' only: assurance_level, id_token_invalid, …
  audit_id          TEXT,                               -- Idura audit reference (auditId claim); no personal data
  created_at        INTEGER NOT NULL,
  token_expires_at  INTEGER,                            -- verified only
  used_order_gid    TEXT,                               -- Phase 2: order the token was used for
  used_at           INTEGER
);
CREATE INDEX idx_verifications_shop ON verifications(shop, created_at);
