# CLAUDE.md — AgeShield (MerchantKits)

> Claude Code reads this file automatically. Keep it short and authoritative. Details: `docs/ARCHITECTURE.md`.
> When a rule here conflicts with a doc, THIS FILE WINS.

## What we are building
**AgeShield** — a public, embedded Shopify app by MerchantKits for legally required age verification with Nordic eIDs
(Denmark MitID, Swedish BankID, Norwegian BankID, Finnish Trust Network) through **Idura** (formerly Criipto) Verify's
Age Verification extension. Merchants mark restricted products; shoppers verify on the product page or in the cart; a
signed token in the cart proves it. Phase 2 enforces at checkout with a Function and records proof on orders.

- Owner: Karl (Khalid Durani), MerchantKits. Prod: https://ageshield.merchantkits.com · Staging:
  https://ageshield-staging.km-durani.workers.dev
- Architecture: `docs/ARCHITECTURE.md` · Phases: `docs/BUILD_PLAN.md` · Deploy + staging test: `docs/DEPLOY_CLOUDFLARE.md`
  · Scopes: `docs/SCOPES.md`
- Stack and lessons come from RecallKit (`E:\recallkit\RECALLKIT_STACK.md`). The old NestJS/GCP version is archived in
  `E:\ageshield-nestjs-archive` (not used).

## Stack (do not change without asking)
- **Backend:** Cloudflare Worker + **Hono** + TypeScript strict. D1 (raw SQL, `worker/migrations/`), Queues (`JOBS` +
  DLQ), daily cron. No R2.
- **Frontend:** React 18 + Vite SPA in `web/`, Polaris web components + App Bridge from Shopify's CDN (not npm), custom
  router, `useSaveBar` for every form.
- **Storefront:** theme app extension `extensions/age-gate/` — one app embed + vanilla JS + em-based CSS.
- **Identity:** Idura OIDC code flow with PKCE (`worker/src/lib/idura.ts`). Shopify: GraphQL Admin API only, through
  `lib/shopify/admin.ts`, API version from `SHOPIFY_API_VERSION`.
- Dev machine is **Windows**: every command must work in **PowerShell**.

## HARD RULES inherited from RecallKit / SignShield (never violate)
1. Shopify managed installation only (`use_legacy_install_flow = false`); no OAuth redirect flow.
2. Never intercept embedded loads: `embedded=1`/`id_token` → `index.html` immediately.
3. No `X-Frame-Options`; CSP `frame-ancestors https://{shop} https://admin.shopify.com` on every HTML response.
4. Auth = session token (HS256, aud, exp/nbf, iss = dest) + token exchange with the **exact** strings, form-encoded,
   raw ID token; expiring offline tokens; **one per-shop lock** for refresh and exchange. No cookies/localStorage for auth.
5. Webhooks declared in the toml; HMAC over the raw body, constant-time; 401 on bad HMAC; dedupe; 200 fast.
6. No bypass flags in production. Billing = Shopify App Pricing, read by plan **handle**. Plans are never unlimited.
7. Never modify theme files; theme app extension only. Theme Liquid reads app data via `$app` / `app.metafields`.
8. Minimum scopes; every scope used by shipped code and justified in `docs/SCOPES.md`. Adding a scope = ask Karl.
9. Secrets only via `wrangler secret put`; never print, log, commit or echo them. `.dev.vars` is git-ignored.
10. Encrypt Shopify tokens at rest (AES-GCM, `TOKEN_ENCRYPTION_KEY`).
11. Polaris multi-word attributes in **camelCase** (a test guards it); render form values as attributes.
12. Storefront CSS in **em**, never rem (Dawn's 62.5 % root). D1: ≤ 100 bound parameters per statement.
13. App Proxy follows redirects server-side and strips `Set-Cookie`. EU jurisdiction for production D1 at creation.

## AGESHIELD RULES
- **No personal data.** Never store, log or forward `sub`, `nameidentifier`, `sessionindex`, names, birth dates,
  CPR/personal numbers or plain IPs (hashed IP for rate limits only). Verifications keep country, age, result, error
  code and Idura's `auditId`.
- **The verification token travels only in the URL fragment** (`#ageshield=…`) and the cart attribute
  `_ageshield_token` — never in a query string, a log or a cookie. Storefront JS removes the fragment at once.
- **The App Proxy never redirects** and never sets cookies: `/verify/start` answers JSON `{authorizeUrl}`.
- `returnPath` is a store-relative path only; the return host must be one of the shop's own domains
  (`services/shop-domains.ts`), else the primary domain.
- id_token: RS256 via JWKS, iss, aud, nbf, nonce; **freshness ≤ 10 min on `authenticationinstant`/`iat`** (exp is years
  ahead); no `ial` requirement; read only `is_over_{requested N}` from `http://ageverification.criipto.com`.
- `oidc_states` rows are single use (deleted before anything else in the callback) and expire after 10 minutes.
- Tokens are signed with the **per-shop derived key**; the master `VERIFICATION_SIGNING_KEY` never leaves the Worker.
- Storefront gating is UX only; the Phase 2 Function is the enforcement. Keep buy-now buttons hidden on restricted
  products until then.
- Every user-facing string goes through i18n: admin `web/src/locales/{en,da,sv}.json`, storefront
  `extensions/age-gate/locales/`. Tests check key parity.
- Dev scripts live in `scripts/dev/` (never deployed) and must never print secrets or tokens.

## Code conventions
TypeScript strict, no `any`; Zod for every body, query and webhook payload; thin handlers, logic in `services/`;
tests (vitest + sql.js D1 harness, fake Shopify, fake Idura with jose keys) for every security-relevant path.

## Commands (PowerShell)
```powershell
npm install
npm run test; npm run typecheck; npm run lint; npm run build
npm run db:migrate:staging; npm run deploy:staging
shopify app config use shopify.app.staging.toml; shopify app deploy
```

## When unsure
Check shopify.dev / developers.cloudflare.com / docs.idura.app before guessing an API shape. During App Store review:
bug fixes only.
