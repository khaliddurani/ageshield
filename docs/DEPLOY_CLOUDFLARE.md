# Deploying AgeShield (Cloudflare + Shopify), PowerShell

Run everything from `E:\ageshield`. Wrangler is a dev dependency (`npx wrangler …`); the Shopify CLI is global.
Never paste secret values into chat, commit them or put them on a command line: `wrangler secret put` prompts for them.

## 1. One-time Cloudflare resources

```powershell
npm install
npx wrangler login
npx wrangler whoami                     # account with the km-durani workers.dev subdomain (Workers Paid plan)

# Staging
npx wrangler d1 create ageshield-db-staging
npx wrangler queues create ageshield-jobs-staging
npx wrangler queues create ageshield-dlq-staging

# Production (EU data location can only be chosen when the database is created)
npx wrangler d1 create ageshield-db --jurisdiction eu
npx wrangler queues create ageshield-jobs
npx wrangler queues create ageshield-dlq
```

Copy each printed `database_id` into `wrangler.jsonc` (`env.staging` / `env.production` → `d1_databases[0].database_id`,
replacing `00000000-…`).

## 2. Shopify apps

Create two apps in the Partner Dashboard (Apps → Create app; it opens the Dev Dashboard): **AgeShield Staging** and
**AgeShield**. For each, copy the **Client ID** into `client_id` of `shopify.app.staging.toml` / `shopify.app.toml`, and
the generated **app handle** into the toml `handle` and `wrangler.jsonc` `SHOPIFY_APP_HANDLE`. (Don't use
`shopify app config link`: it rewrites the toml from the remote app.)

## 3. Secrets

Generate the two 32-byte keys (run once per key; Windows PowerShell 5.1 compatible):

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RNGCryptoServiceProvider]::new().GetBytes($b)
[Convert]::ToBase64String($b)
```

Set them (each command prompts for the value):

```powershell
npx wrangler secret put SHOPIFY_API_KEY --env staging            # staging app Client ID
npx wrangler secret put SHOPIFY_API_SECRET --env staging         # staging app Client secret
npx wrangler secret put TOKEN_ENCRYPTION_KEY --env staging       # 32 random bytes, base64 (new key)
npx wrangler secret put VERIFICATION_SIGNING_KEY --env staging   # 32 random bytes, base64 (another new key)
npx wrangler secret put IDURA_DOMAIN --env staging               # merchantkits.test.idura.broker (no https://)
npx wrangler secret put IDURA_CLIENT_ID --env staging            # urn:merchantkits:ageshield
npx wrangler secret put IDURA_CLIENT_SECRET --env staging
npx wrangler secret list --env staging                           # names only
# production: the same with --env production (own Shopify app credentials, own keys, production Idura tenant)
```

Changing `VERIFICATION_SIGNING_KEY` later invalidates all open tokens (30 minutes); `TOKEN_ENCRYPTION_KEY` must never
change while shops are installed (stored tokens could no longer be decrypted).

Local dev only: copy `.dev.vars.example` to `.dev.vars` (git-ignored).

## 4. Migrations and Worker

```powershell
npm run test; npm run typecheck; npm run lint
npm run db:migrate:staging          # wrangler d1 migrations apply ageshield-db-staging --env staging --remote
npm run deploy:staging              # builds web/ and deploys ageshield-staging
Invoke-RestMethod https://ageshield-staging.km-durani.workers.dev/health    # → ok: True
```

Production: `npm run db:migrate:prod`, `npm run deploy:prod` (the custom domain `ageshield.merchantkits.com` is created on
the first deploy because merchantkits.com is a Cloudflare zone).

## 5. Shopify app config and theme extension

```powershell
shopify app config use shopify.app.staging.toml
shopify app deploy                  # scopes, webhooks, app proxy, metafield definition, age-gate extension
git diff extensions/age-gate/shopify.extension.toml    # the CLI should have added the extension uid — commit it
```

If `uid` was not added, run `shopify app deploy` again and check the CLI output; the uid must stay the same for both
apps' deploys of this extension file.

## 6. Staging test checklist

1. **Dev store:** Partner Dashboard → Stores → Add store → Development store (Dawn is the default theme). Note the
   storefront password.
2. **Install:** Dev Dashboard → AgeShield Staging → Install → choose the dev store. The app opens embedded with no
   OAuth screen. Check `npx wrangler tail --env staging` shows `GET /api/me` 200.
3. **Dashboard:** setup checklist shows 0 of 4. Click **Enable in theme editor** → App embeds → Age gate is on → **Save**.
   Back in the app: **Check again** → *Enabled*.
4. **Settings:** keep all four countries, default age 18, *On the product page*; Save. Toast "Settings saved".
5. **Test product:** Shopify admin → Products → Add product "Test snus" (price, active, Online Store), tag `snus`, save.
   AgeShield → Restricted products → Product tag `snus` → **Add tag**. Wait for "Up to date"; the count shows 1. On the
   product in Shopify admin, Metafields shows *Age restriction* = 18.
6. **Pass — Theo71754 (27), product-page mode:** open the product in a private window (enter the store password).
   Notice + four eID buttons; Add to cart disabled; Buy it now hidden. Click **MitID** → MitID test login (app simulator)
   as **Theo71754** → back on the product page with "Age verified ✓", and the address bar has **no** `#ageshield…`.
   Add to cart works. Console check:
   `fetch('/cart.js').then(r => r.json()).then(c => console.log(c.attributes))` → `_ageshield_token` present.
   Checkout opens.
7. **Reject — Phil62998 (14), product-page mode:** new private window → product → MitID → **Phil62998** → "You must be
   18+ to buy this product"; Add to cart stays disabled; no token in the cart.
8. **Cancel:** start MitID and cancel → "Verification cancelled, try again".
9. **Cart mode:** Settings → *In the cart, before checkout* → Save. New private window → product: Add to cart works,
   notice says verification happens before checkout. Cart page: checkout disabled with the notice. **MitID →
   Theo71754** → back on the cart page, "Age verified ✓", checkout enabled. New private window, same with **Phil62998**
   → rejected message, checkout stays disabled. (Also try the cart drawer's checkout button: blocked → goes to the cart.)
10. **Admin results:** Verifications lists the logins (verified / under age / cancelled, country MitID (Denmark), 18+),
    no names or numbers. Dashboard: 30-day counts match; setup 4 of 4 (the checklist disappears).
11. **Logs:** in `npx wrangler tail --env staging` no line contains `code=`, `state=`, `ageshield=` or a token.
12. **Uninstall/reinstall (optional):** uninstall, reinstall, open the app → embed config is published again (storefront
    keeps working with your settings).

## 7. Operations

```powershell
npx wrangler tail --env staging
npx wrangler d1 execute ageshield-db-staging --env staging --remote --command "SELECT result, COUNT(*) FROM verifications GROUP BY result"
npx wrangler queues list
```
