import { describe, expect, it } from 'vitest';
import { InvalidSessionTokenError, verifySessionToken } from '../src/lib/shopify/session-token';
import { API_KEY, API_SECRET, SHOP, signIdToken } from './helpers';

const now = () => Math.floor(Date.now() / 1000);

describe('verifySessionToken', () => {
  it('accepts a valid token and returns the shop from dest', async () => {
    const token = await signIdToken();
    const result = await verifySessionToken(token, API_KEY, API_SECRET);
    expect(result.shop).toBe(SHOP);
  });

  it('rejects a wrong audience', async () => {
    const token = await signIdToken({ aud: 'some-other-app' });
    await expect(verifySessionToken(token, API_KEY, API_SECRET)).rejects.toBeInstanceOf(
      InvalidSessionTokenError,
    );
  });

  it('rejects an expired token', async () => {
    const token = await signIdToken({ exp: now() - 30, nbf: now() - 90 });
    await expect(verifySessionToken(token, API_KEY, API_SECRET)).rejects.toBeInstanceOf(
      InvalidSessionTokenError,
    );
  });

  it('allows 5 seconds of clock skew on nbf', async () => {
    const token = await signIdToken({ nbf: now() + 3 });
    await expect(verifySessionToken(token, API_KEY, API_SECRET)).resolves.toMatchObject({ shop: SHOP });
  });

  it('rejects a token not yet valid beyond the skew', async () => {
    const token = await signIdToken({ nbf: now() + 60, exp: now() + 120 });
    await expect(verifySessionToken(token, API_KEY, API_SECRET)).rejects.toBeInstanceOf(
      InvalidSessionTokenError,
    );
  });

  it('rejects a bad signature', async () => {
    const token = await signIdToken({}, 'wrong-secret');
    await expect(verifySessionToken(token, API_KEY, API_SECRET)).rejects.toBeInstanceOf(
      InvalidSessionTokenError,
    );
  });

  it('rejects a dest that is not a myshopify.com domain', async () => {
    const token = await signIdToken({
      dest: 'https://evil.example.com',
      iss: 'https://evil.example.com/admin',
    });
    await expect(verifySessionToken(token, API_KEY, API_SECRET)).rejects.toBeInstanceOf(
      InvalidSessionTokenError,
    );
  });

  it('rejects mismatched iss and dest hosts', async () => {
    const token = await signIdToken({ iss: 'https://other-store.myshopify.com/admin' });
    await expect(verifySessionToken(token, API_KEY, API_SECRET)).rejects.toBeInstanceOf(
      InvalidSessionTokenError,
    );
  });

  it('rejects garbage', async () => {
    await expect(verifySessionToken('not-a-jwt', API_KEY, API_SECRET)).rejects.toBeInstanceOf(
      InvalidSessionTokenError,
    );
  });
});
