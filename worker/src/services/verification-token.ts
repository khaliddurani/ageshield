import { z } from 'zod';
import { base64url } from '../lib/idura';
import { timingSafeEqual } from '../lib/shopify/hmac';

// Signed verification token (ARCHITECTURE §6): handed to the storefront in the URL fragment after a verified login,
// stored as the cart attribute "_ageshield_token", and checked again in Phase 2 (cart/checkout Function, orders/create).
//
// Format: base64url(JSON payload) "." base64url(HMAC-SHA256(shop key, base64url payload)).
// The shop key is derived per shop: HMAC-SHA256(VERIFICATION_SIGNING_KEY, "ageshield-shop-key:v1:" + shop). Phase 2
// stores only that shop's key in an app-owned shop metafield for the Function, so a leaked metafield can never forge
// tokens for another store, and VERIFICATION_SIGNING_KEY itself never leaves the Worker.

export const TOKEN_VERSION = 1;
export const TOKEN_TTL_S = 30 * 60;

export const tokenPayloadSchema = z.object({
  v: z.literal(TOKEN_VERSION),
  vid: z.string().uuid(),
  shop: z.string(),
  min_age: z.union([z.literal(15), z.literal(16), z.literal(18), z.literal(21)]),
  country: z.enum(['DK', 'SE', 'NO', 'FI']),
  /** Idura audit reference (no personal data); Phase 2 writes it to the order as proof. */
  audit_id: z.string().nullable(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type TokenPayload = z.infer<typeof tokenPayloadSchema>;

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const padded = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    return base64ToBytes(padded);
  } catch {
    return null;
  }
}

async function hmac(key: BufferSource, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}

/** The shop's token key (32 bytes). `signingKey` is VERIFICATION_SIGNING_KEY (32 random bytes, base64). */
export async function shopTokenKey(signingKey: string, shop: string): Promise<Uint8Array<ArrayBuffer>> {
  const master = base64ToBytes(signingKey);
  if (master.byteLength !== 32) throw new Error('VERIFICATION_SIGNING_KEY must be 32 bytes, base64-encoded');
  return hmac(master, `ageshield-shop-key:v1:${shop}`);
}

export async function signVerificationToken(signingKey: string, payload: TokenPayload): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(tokenPayloadSchema.parse(payload))));
  const key = await shopTokenKey(signingKey, payload.shop);
  return `${body}.${base64url(await hmac(key, body))}`;
}

export type TokenCheck =
  | { valid: true; payload: TokenPayload }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'wrong_shop' | 'expired' };

/**
 * Verifies signature (constant-time, with the key of `shop`), payload shape, shop and expiry. Phase 2's Function does
 * the same with the shop key from the metafield; orders/create additionally marks the vid as used.
 */
export async function verifyVerificationToken(
  signingKey: string,
  shop: string,
  token: string,
  nowS: number,
): Promise<TokenCheck> {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined || token.length > 2048)
    return { valid: false, reason: 'malformed' };
  const received = base64urlToBytes(signature);
  if (!received) return { valid: false, reason: 'malformed' };
  const key = await shopTokenKey(signingKey, shop);
  if (!timingSafeEqual(received, await hmac(key, body))) {
    return { valid: false, reason: 'bad_signature' };
  }
  const json = base64urlToBytes(body);
  let parsed: z.ZodSafeParseResult<TokenPayload>;
  try {
    parsed = tokenPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(json ?? new Uint8Array())));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!parsed.success) return { valid: false, reason: 'malformed' };
  if (parsed.data.shop !== shop) return { valid: false, reason: 'wrong_shop' };
  if (parsed.data.exp <= nowS) return { valid: false, reason: 'expired' };
  return { valid: true, payload: parsed.data };
}

// --- Phase 2 preparation (not called yet) ------------------------------------------------------------------------

/** App-owned shop metafield the Phase 2 Function reads the shop key from (docs/BUILD_PLAN.md, Phase 2). */
export const SHOP_KEY_METAFIELD = {
  namespace: '$app',
  key: 'verification_key',
  type: 'single_line_text_field',
};

/**
 * metafieldsSet input that stores the shop key (base64url) on the shop. Phase 2 calls this on install / app load and
 * declares the metafield in the toml without storefront or merchant access (app-only), so the key never reaches the
 * storefront or the admin UI.
 */
export async function shopKeyMetafieldInput(signingKey: string, shop: string, shopGid: string) {
  return {
    ownerId: shopGid,
    ...SHOP_KEY_METAFIELD,
    value: base64url(await shopTokenKey(signingKey, shop)),
  };
}
