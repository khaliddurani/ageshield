# Access scopes — justification for Shopify app review

Every scope in `shopify.app.toml` / `shopify.app.staging.toml` is used by shipped code. Keep this file, both tomls and
the review submission in sync.

| Scope | Why AgeShield needs it |
|---|---|
| `read_products` | Expands the merchant's collection and tag rules into products and reads product tags, so the app knows which products are age-restricted. |
| `write_products` | Sets and removes the app-owned product metafield `$app.age_restricted` (the minimum age); no other product data is written. |
| `read_themes` | Reads the live theme's `config/settings_data.json` to show on the Dashboard whether the Age gate app embed is enabled (read-only; the app never edits themes). |
