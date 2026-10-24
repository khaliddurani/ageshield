import { describe, expect, it } from 'vitest';
import { createD1TokenStore } from '../src/lib/shopify/offline-token';
import { createTestD1 } from './d1';
import { SHOP } from './helpers';

const tokens = {
  accessTokenEnc: 'enc-access',
  accessTokenExpiresAt: 2000,
  refreshTokenEnc: 'enc-refresh',
  refreshTokenExpiresAt: 9000,
  scope: 'read_products',
};

describe('D1 token store', () => {
  it('creates the row once, saves tokens and loads them back', async () => {
    const { db } = await createTestD1();
    const store = createD1TokenStore(db);
    expect(await store.load(SHOP)).toBeNull();
    await store.ensureRow(SHOP, 100);
    await store.ensureRow(SHOP, 200);
    await store.save(SHOP, tokens, 300);
    expect(await store.load(SHOP)).toEqual({
      accessTokenEnc: 'enc-access',
      accessTokenExpiresAt: 2000,
      refreshTokenEnc: 'enc-refresh',
      refreshTokenExpiresAt: 9000,
      scope: 'read_products',
      uninstalledAt: null,
    });
  });

  it('lock: only one holder until it is released or expires', async () => {
    const { db } = await createTestD1();
    const store = createD1TokenStore(db);
    await store.ensureRow(SHOP, 0);
    expect(await store.tryLock(SHOP, 1000, 31_000)).toBe(true);
    expect(await store.tryLock(SHOP, 2000, 32_000)).toBe(false);
    await store.unlock(SHOP, 99_999); // someone else's lock value: no effect
    expect(await store.tryLock(SHOP, 3000, 33_000)).toBe(false);
    await store.unlock(SHOP, 31_000);
    expect(await store.tryLock(SHOP, 4000, 34_000)).toBe(true);
    expect(await store.tryLock(SHOP, 40_000, 70_000)).toBe(true); // previous lock expired
  });

  it('save after uninstall clears uninstalled_at and resets installed_at (reinstall)', async () => {
    const { db, query } = await createTestD1();
    const store = createD1TokenStore(db);
    await store.ensureRow(SHOP, 100);
    await db.prepare('UPDATE shops SET uninstalled_at = 500 WHERE shop = ?1').bind(SHOP).run();
    await store.save(SHOP, { ...tokens, scope: null }, 900);
    expect(query('SELECT installed_at, uninstalled_at, scope FROM shops')).toEqual([
      { installed_at: 900, uninstalled_at: null, scope: null },
    ]);
  });

  it('clearTokens removes both tokens', async () => {
    const { db } = await createTestD1();
    const store = createD1TokenStore(db);
    await store.ensureRow(SHOP, 0);
    await store.save(SHOP, tokens, 0);
    await store.clearTokens(SHOP);
    expect(await store.load(SHOP)).toMatchObject({ accessTokenEnc: null, refreshTokenEnc: null });
  });
});
