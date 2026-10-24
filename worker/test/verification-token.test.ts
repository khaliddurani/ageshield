import { describe, expect, it } from 'vitest';
import {
  shopKeyMetafieldInput,
  shopTokenKey,
  signVerificationToken,
  verifyVerificationToken,
  type TokenPayload,
} from '../src/services/verification-token';
import { SHOP, SIGNING_KEY } from './helpers';

const NOW_S = 1_800_000_000;
const payload: TokenPayload = {
  v: 1,
  vid: '1b4e28ba-2fa1-4d3b-9c55-0f0e0d0c0b0a',
  shop: SHOP,
  min_age: 18,
  country: 'DK',
  audit_id: 'alu_test_123',
  iat: NOW_S,
  exp: NOW_S + 1800,
};

const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

describe('verification token', () => {
  it('round-trips: payload.signature, base64url, verified with the shop key', async () => {
    const token = await signVerificationToken(SIGNING_KEY, payload);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyVerificationToken(SIGNING_KEY, SHOP, token, NOW_S + 60)).toEqual({
      valid: true,
      payload,
    });
  });

  it('rejects a tampered payload or signature', async () => {
    const token = await signVerificationToken(SIGNING_KEY, payload);
    const [body = '', sig = ''] = token.split('.');
    const forged = btoa(JSON.stringify({ ...payload, min_age: 21 })).replace(/=+$/, '');
    expect(await verifyVerificationToken(SIGNING_KEY, SHOP, `${forged}.${sig}`, NOW_S)).toMatchObject({
      reason: 'bad_signature',
    });
    expect(await verifyVerificationToken(SIGNING_KEY, SHOP, `${body}.${flip(sig, 3)}`, NOW_S)).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('a token for one shop is invalid for another (per-shop keys)', async () => {
    const token = await signVerificationToken(SIGNING_KEY, payload);
    expect(await verifyVerificationToken(SIGNING_KEY, 'other.myshopify.com', token, NOW_S)).toMatchObject({
      valid: false,
    });
    expect(await shopTokenKey(SIGNING_KEY, SHOP)).not.toEqual(
      await shopTokenKey(SIGNING_KEY, 'other.myshopify.com'),
    );
  });

  it('expires after exp', async () => {
    const token = await signVerificationToken(SIGNING_KEY, payload);
    expect(await verifyVerificationToken(SIGNING_KEY, SHOP, token, payload.exp)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('rejects malformed tokens and a wrong-size master key', async () => {
    for (const bad of ['', 'abc', 'a.b.c', 'a.%%%', `${'x'.repeat(3000)}.y`]) {
      expect((await verifyVerificationToken(SIGNING_KEY, SHOP, bad, NOW_S)).valid, bad.slice(0, 10)).toBe(
        false,
      );
    }
    await expect(signVerificationToken(btoa('short'), payload)).rejects.toThrow(/32 bytes/);
  });

  it('the Phase 2 shop metafield holds the derived shop key, never the master key', async () => {
    const input = await shopKeyMetafieldInput(SIGNING_KEY, SHOP, 'gid://shopify/Shop/1');
    expect(input).toMatchObject({
      ownerId: 'gid://shopify/Shop/1',
      namespace: '$app',
      key: 'verification_key',
    });
    expect(input.value).not.toContain(SIGNING_KEY.replace(/=+$/, ''));
    expect(input.value).toHaveLength(43);
  });
});
