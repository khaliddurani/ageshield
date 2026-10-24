# AgeShield — Architecture (Phase 1)

AgeShield is a public, embedded Shopify app by MerchantKits for legally required age verification with Nordic national
eIDs (Denmark MitID, Swedish BankID, Norwegian BankID, Finnish Trust Network) through **Idura** (formerly Criipto)
Verify's Age Verification extension. The stack and conventions are RecallKit's (`E:\recallkit\RECALLKIT_STACK.md`).

Section numbers are referenced from code comments (`ARCHITECTURE §n`); keep them stable.

## 1. Components and folders

| Part | What |
|---|---|
| `worker/` | Cloudflare Worker, Hono, TypeScript strict. Admin API (`/api/*`), App Proxy (`/proxy/*`), Idura callback (`/oidc/callback`), webhooks, queue consumer, daily cron. |
| `web/` | React 18 + Vite SPA, Polaris web components + App Bridge from Shopify's CDN; served by the Worker (static assets, `run_worker_first`). |
| `extensions/age-gate/` | Theme app extension: one **app embed** (`blocks/age_gate.liquid`), `assets/age-gate.js` (vanilla), `assets/age-gate.css` (em-based), `locales/` en/da/sv. |
| D1 `DB` | App state (raw SQL, `worker/migrations/`). Production database created with `--jurisdiction eu`. |
| Queue `JOBS` (+ DLQ) | Webhook processing, rule → metafield sync runs, plan sync. |
| Shopify | Source of truth for the storefront: product metafield `$app.age_restricted`, app-data metafield `ageshield.config`. |

```
worker/src/
  index.ts            routes, error mapping, fetch/queue/scheduled exports
  env.ts              bindings, vars, secrets
  lib/                crypto (AES-GCM), idura (OIDC client), redact, time
  lib/shopify/        session-token, token-exchange, offline-token, admin, hmac, shop, webhook-payloads
  middleware/         embedded-load, session-auth
  routes/             api/{me,billing,settings,rules,verifications}, proxy, oidc, webhooks
  services/           business logic (see sections below)
  queue/handlers.ts   job router
  cron.ts             daily housekeeping
```

## 2. Data model (D1)

**No personal data anywhere.** Never store `sub`, `nameidentifier`, `sessionindex`, names, birth dates, CPR/personal
numbers or plain IPs. Rate limiting stores `sha256` of the client IP only.

| Table | Purpose |
|---|---|
| `shops` | Install state, AES-GCM encrypted expiring offline + refresh tokens, per-shop refresh lock, plan sync columns, cached storefront domains, hash of the published storefront config. |
| `settings` | Per shop: enabled countries (JSON), default min age (15/16/18/21), gate mode (`product_page` / `cart`), popup texts per locale (JSON), brand colour. |
| `restricted_rules` | `product` / `collection` / `tag` rules with an optional own min age. |
| `restricted_products` | Mirror of the `$app.age_restricted` metafield (what was written) + the current sync run's desired value. |
| `oidc_states` | One row per started login: state (PK), nonce, PKCE verifier, country, min age, absolute return URL; 10-minute lifetime; deleted by the callback. |
| `verifications` | One row per finished login: country, min age, result (`verified`/`rejected`/`cancelled`/`error`), error code, Idura `auditId`, token expiry; `used_order_gid`/`used_at` for Phase 2. |
| `jobs`, `webhook_events`, `audit_log`, `rate_limits` | As in RecallKit. |

CHECK constraints enforce countries, ages, results and rule shapes. `shop/redact` deletes every table's rows
(`services/compliance.ts` `SHOP_TABLES`; a test fails if a table with a `shop` column is missing).

## 3. Shopify auth (copied from RecallKit)

### 3.1 Install
Shopify managed installation (`use_legacy_install_flow = false`). No OAuth redirect flow.

### 3.2 Embedded load (`middleware/embedded-load.ts`)
`embedded=1` / `id_token` → `index.html` immediately with `Content-Security-Policy: frame-ancestors https://{shop}
https://admin.shopify.com` and no `X-Frame-Options`; the `shopify-api-key` meta is injected per environment. A
non-embedded hit with a valid shop → 302 to the admin app URL. `/api/`, `/webhooks/`, `/proxy/`, `/oidc/` never get the
SPA shell.

### 3.3 API auth (`middleware/session-auth.ts`)
`Authorization: Bearer <App Bridge ID token>`, verified with jose (HS256, `aud` = client id, `exp`/`nbf` 5 s skew,
`iss` = `dest` host). Then an expiring offline token is ensured: stored token, refresh (≥ 5 min before expiry) or token
exchange with the exact Shopify strings, all under one per-shop lock. Invalid → 401 + `X-Shopify-Retry-Invalid-Session-Request: 1`.

## 4. Webhooks and privacy (`routes/webhooks.ts`, `services/compliance.ts`)

Declared in the toml: `app/uninstalled`, `app/scopes_update`, `products/create|update`, compliance topics. HMAC over
the raw body → dedupe on `X-Shopify-Webhook-Id` → enqueue → 200. Customer email and phone are stripped before
queueing. AgeShield stores no customer data, so `customers/data_request` and `customers/redact` only write an audit
entry; `shop/redact` deletes everything (skipped if the shop reinstalled).

## 5. Restricted products → `$app.age_restricted` (`services/rules.ts`, `services/restriction-sync.ts`)

Rules live in D1; the result lives in Shopify as the app-owned product metafield `$app.age_restricted`
(`number_integer`, declared in the toml with storefront `public_read`). The theme embed and the Phase 2 Function read it.

- **Sync run** (one `jobs` row, type `rules_sync`), queued after every rule change or default-age change:
  - *collect*: one queue message per page (≤ 250 products) per rule: products by id (existence checked), collection
    products, products by `tag:"…"`. `desired_min_age` = the strictest age of all matching rules.
  - *apply*: ≤ 100 products per message; `metafieldsSet` in batches of 25 where the value differs, then
    `metafieldsDelete` for products no rule covers any more.
  - A newer run cancels older ones; their remaining messages stop. Failures: non-retryable at once, others after the
    last retry → `jobs.status = failed` (shown in the UI with a retry button).
- **Webhooks** `products/create|update`: re-evaluate that one product (tags from the payload, collections by one query
  if collection rules exist). No API call for shops without rules; no write when nothing changed (no update loop).
- Edge case: a product edited in Shopify during the short window of a running sync may need the next sync to settle.

## 6. Verification flow

```
storefront JS ──POST /apps/{subpath}/verify/start {country, minAge, returnPath, host}──▶ App Proxy ─▶ Worker /proxy/verify/start
          ◀──────────────────── 200 {authorizeUrl} (JSON; never a redirect, never a cookie) ──────────
browser ──▶ https://{IDURA_DOMAIN}/oauth2/authorize?…  ──(eID login)──▶ GET {APP_URL}/oidc/callback?code&state
          ◀── 302 https://{shop domain}{returnPath}#ageshield=<token>   |   #ageshield_status=<status>&ageshield_age=…&ageshield_country=…
storefront JS: remove fragment (history.replaceState) → POST /cart/update.js {attributes: {_ageshield_token}}
```

### 6.1 Start (`routes/proxy.ts`, `services/verification.ts`)
App Proxy signature + timestamp (±5 min) on every request; Zod body; `returnPath` must be a store-relative path (no
scheme, `//`, backslash, control characters; fragment dropped); rate limit 20 per 10 min per hashed client IP; shop
must be installed and the country enabled. Creates the `oidc_states` row (256-bit state, nonce, PKCE verifier).

### 6.2 Return host (`services/shop-domains.ts`)
Nordic stores often sell on separate market domains (.dk/.se/.no/.fi) with separate cart cookies. The shopper's
`host` is used only if it is exactly (lower-cased) one of the shop's domains: the myshopify domain, `shop.primaryDomain`,
`webPresences[].domain` (scope `read_markets`). Cached on `shops` for 1 h; a miss re-reads at most once a minute.
Anything else — foreign or look-alike hosts — falls back to the primary domain. Without `read_markets` only the primary
domain is known.

### 6.3 Idura (`lib/idura.ts`)
Discovery document (cached 1 h; issuer and all endpoints must be on `https://{IDURA_DOMAIN}`). Authorize:
`response_type=code`, `scope=openid is_over_{N}`, `acr_values=urn:age-verification`, `login_hint=country:{CC}`,
`state`, `nonce`, `code_challenge` (S256). Token: `Authorization: Basic base64(urlenc(client_id):urlenc(secret))` +
`code_verifier`. id_token: RS256 via JWKS, `iss`, `aud`, `nbf`, nonce (constant time). `exp` is set years ahead by the
tenant, so freshness is enforced on `authenticationinstant` (else `iat`): at most 10 minutes old. No `ial` is required
(it is `low` even for valid users).

Claims used: `http://ageverification.criipto.com` → `{ country, auditId, is_over_{N} }` for the requested N only.

| Outcome | Stored result | Fragment |
|---|---|---|
| `is_over_N === true` | `verified` (+ `audit_id`, token expiry) | `#ageshield=<token>` |
| `is_over_N === false` (underage logins complete normally) | `rejected` (+ `audit_id`) | `#ageshield_status=rejected` |
| claim missing / other country / id_token invalid / too old / token endpoint error | `error` + code | `#ageshield_status=error` |
| callback `error=access_denied` / "cancel" | `cancelled` | `#ageshield_status=cancelled` |
| MitID CTL002 / "assurance" | `error` + `assurance_level` | `#ageshield_status=assurance` |
| state older than 10 min | `error` + `state_expired` | `#ageshield_status=expired` |

The state row is deleted first (single use, also on failure). Unknown/used state → small static page (no redirect
target is known). The callback URL (code, state) is never logged (`lib/redact.ts`).

### 6.4 Verification token (`services/verification-token.ts`)
`base64url(JSON payload) "." base64url(HMAC-SHA256)`, payload `{v:1, vid, shop, min_age, country, audit_id, iat, exp}`,
`exp = iat + 30 min`. Signed with a **per-shop key** = HMAC-SHA256(`VERIFICATION_SIGNING_KEY`, `"ageshield-shop-key:v1:" + shop`),
so a token is only valid for its shop and Phase 2 can give the checkout Function just that shop's key. Only ever in
the URL fragment and the cart attribute `_ageshield_token` — never in a query string or a log.

**Phase 2 prep:** `shopKeyMetafieldInput()` builds the `metafieldsSet` input for an app-owned shop metafield
`$app.verification_key` holding the derived shop key (never the master key). Not called in Phase 1; Phase 2 declares
the metafield without storefront/merchant access and writes it on install/app load.

## 7. Storefront (`extensions/age-gate`, `services/storefront-config.ts`, `services/theme-status.ts`)

- **App embed** (`target: body`) renders data only where needed: a product with `$app.age_restricted`, or a cart
  containing one (`cart.items[].product.metafields['$app'].age_restricted`).
- **Config** reaches Liquid without Worker calls: the app-data metafield `app.metafields.ageshield.config`
  (owner `AppInstallation`, `multi_line_text_field` holding script-safe JSON — `<`, `>`, `&`, U+2028/9 escaped) with
  enabled countries, gate mode, popup texts, brand colour and the App Proxy path. Written on settings save and on app
  load when its hash differs; uninstall resets the hash (Shopify deletes app-data metafields).
- **Gate modes**: `product_page` — add to cart blocked on restricted products until verified; `cart` — add freely,
  checkout (cart page and drawers) blocked until verified. In both, checkout buttons stay blocked while the cart holds
  restricted items without a valid token, and **buy-now / accelerated checkout buttons are hidden on restricted product
  pages** (they skip the cart and its token).
- UX only: buttons are disabled and actions stopped in a capture listener; a MutationObserver re-applies after theme
  re-renders. **Phase 2's checkout Function is the real enforcement.**
- **Theme status**: `config/settings_data.json` of the main theme (`read_themes`) → embed enabled? Deep link
  `admin.shopify.com/store/{store}/themes/current/editor?context=apps&activateAppId={api_key}/age_gate`.

**Known limitation — App Proxy subpath:** the storefront uses the subpath from `APP_PROXY_SUBPATH`
(`/apps/ageshield`, staging `/apps/ageshield-staging`). Shopify lets merchants change an app proxy's URL; if they do,
the storefront can't reach the app until Phase 3 supports it. The Settings page tells merchants not to change it.

## 8. Billing (copied from RecallKit)

Shopify App Pricing; plan read via `currentAppInstallation.activeSubscriptions` (by handle). Phase 1 plans are
placeholders, all **capped** (every verification is a paid Idura transaction; a test forbids unlimited plans), not
enforced yet.

## 9. Queue and cron

Queue jobs: webhook topics, `rules/sync`, `billing/sync`. Daily cron (`0 3 * * *`): plan sync jobs, purge rate-limit
windows, expired `oidc_states`, and webhook dedupe rows older than 7 days.

## 10. Scopes

`read_products`, `write_products`, `read_themes`, `read_markets` — justified in [SCOPES.md](SCOPES.md).

## 11. Security and logging rules

Zod on every input; constant-time compares (webhook HMAC, proxy signature, nonce, token signature); secrets only via
`wrangler secret put`; logs carry error names/codes and redacted paths only — never tokens, codes, states, claims or
IPs; storefront strings are set with `textContent`.
