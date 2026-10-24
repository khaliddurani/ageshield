import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { makeEnv } from './helpers';

describe('worker', () => {
  it('GET /health returns ok', async () => {
    const res = await app.request('/health', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns JSON 404 for unknown non-HTML routes', async () => {
    const res = await app.request('/webhooks/unknown', { method: 'POST' }, makeEnv());
    expect(res.status).toBe(404);
  });
});
