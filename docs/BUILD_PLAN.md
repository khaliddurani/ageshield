# AgeShield — Build plan

## Phase 1 — Age verification on the storefront ✅ (built 2026-10-24, staging test pending)

- Scaffold on the RecallKit stack (auth, webhooks, billing sync, GDPR, test harness).
- D1 data model without personal data; rules → `$app.age_restricted` sync job; product webhooks.
- Idura Age Verification flow (PKCE, JWKS, freshness on `authenticationinstant`, result mapping, per-shop signed
  token in the URL fragment); return to the shopper's own market domain (`read_markets`).
- Theme app embed: notice, eID buttons, button blocking, fragment → cart attribute `_ageshield_token`, en/da/sv.
- Admin UI: Dashboard (setup checklist, 30-day counts, embed status), Settings, Restricted products, Verifications,
  Plans.

## Phase 2 — Real enforcement and per-order proof

1. **Shop key metafield:** on install/app load, write the shop's derived token key to an app-owned shop metafield
   (`shopKeyMetafieldInput()` in `services/verification-token.ts`); declare it in both tomls without storefront or
   merchant access. Never the master `VERIFICATION_SIGNING_KEY`.
2. **Cart and checkout validation Function** (works on all plans): for cart lines whose product has
   `$app.age_restricted`, require cart attribute `_ageshield_token` with a valid HMAC (shop key from the metafield),
   `exp` in the future, `shop` = this shop and `min_age` ≥ the highest line age; otherwise block checkout with a
   localized message.
3. **`orders/create` webhook** (adds `read_orders`, ask first): verify the token from the order's note attributes, mark
   the `vid` single-use (`verifications.used_order_gid`, `used_at`; a reused vid is flagged), write an order metafield
   with the result, country, min age and Idura `audit_id` as per-order proof, and tag/flag orders with restricted
   products but no valid token.
4. Consider accelerated checkout support once the Function enforces (buy-now buttons are hidden in Phase 1).

## Phase 3 — Commercial launch

- Real plans and server-side limits (monthly verifications; never unlimited), plan limit notices.
- CSV export of verifications (no personal data).
- Norwegian (nb) and Finnish (fi) locales for admin UI and storefront.
- **App Proxy subpath:** support merchants who changed the proxy URL (today the Settings page asks them not to).
- App Store listing, screenshots, review checklist (copy RecallKit's `docs/SHOPIFY_REVIEW_CHECKLIST.md` method).
