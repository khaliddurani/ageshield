import { describe, expect, it } from 'vitest';
import { decryptString, encryptString } from '../src/lib/crypto';
import { ENCRYPTION_KEY } from './helpers';

describe('token encryption', () => {
  it('round-trips and uses a fresh IV each time', async () => {
    const a = await encryptString('shpat_secret', ENCRYPTION_KEY);
    const b = await encryptString('shpat_secret', ENCRYPTION_KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain('shpat_secret');
    expect(await decryptString(a, ENCRYPTION_KEY)).toBe('shpat_secret');
  });

  it('fails to decrypt with a different key', async () => {
    const other = btoa(String.fromCharCode(...new Array<number>(32).fill(7)));
    const encrypted = await encryptString('shpat_secret', ENCRYPTION_KEY);
    await expect(decryptString(encrypted, other)).rejects.toThrow();
  });

  it('rejects a key that is not 32 bytes', async () => {
    await expect(encryptString('x', btoa('short'))).rejects.toThrow(/32 bytes/);
  });
});
