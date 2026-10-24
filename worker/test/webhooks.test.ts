import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { JobMessage } from '../src/queue/handlers';
import { createTestD1, type TestD1 } from './d1';
import { SHOP, makeEnv } from './helpers';
import { webhookHmac } from './signing';

let d1: TestD1;
let sent: JobMessage[];
let failSend: boolean;

function env() {
  const jobs = {
    send: async (msg: JobMessage) => {
      if (failSend) throw new Error('queue unavailable');
      sent.push(msg);
    },
  };
  return makeEnv({ DB: d1.db, JOBS: jobs as unknown as Queue<JobMessage> });
}

interface DeliveryOptions {
  path?: string;
  topic?: string;
  webhookId?: string;
  hmac?: string;
  shop?: string;
}

async function deliver(payload: unknown, opts: DeliveryOptions = {}) {
  const body = JSON.stringify(payload);
  return app.request(
    `/webhooks${opts.path ?? '/app/uninstalled'}`,
    {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': opts.hmac ?? (await webhookHmac(body)),
        'X-Shopify-Topic': opts.topic ?? 'app/uninstalled',
        'X-Shopify-Shop-Domain': opts.shop ?? SHOP,
        'X-Shopify-Webhook-Id': opts.webhookId ?? crypto.randomUUID(),
      },
    },
    env(),
  );
}

beforeEach(async () => {
  d1 = await createTestD1();
  sent = [];
  failSend = false;
});

describe('POST /webhooks/*', () => {
  it('valid HMAC → 200, recorded and enqueued', async () => {
    const res = await deliver({ id: 1 }, { webhookId: 'wh-1' });
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ type: 'app/uninstalled', shop: SHOP, payload: {} }]);
    expect(d1.query('SELECT webhook_id, topic FROM webhook_events')).toEqual([
      { webhook_id: 'wh-1', topic: 'app/uninstalled' },
    ]);
  });

  it('invalid HMAC → 401 and nothing enqueued', async () => {
    const res = await deliver({ id: 1 }, { hmac: await webhookHmac('{"id":2}') });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
    expect(d1.query('SELECT * FROM webhook_events')).toHaveLength(0);
  });

  it('HMAC made with another secret → 401', async () => {
    const res = await deliver({ id: 1 }, { hmac: await webhookHmac('{"id":1}', 'other-secret') });
    expect(res.status).toBe(401);
  });

  it('duplicate X-Shopify-Webhook-Id → 200 but enqueued only once', async () => {
    expect((await deliver({ id: 1 }, { webhookId: 'wh-dup' })).status).toBe(200);
    expect((await deliver({ id: 1 }, { webhookId: 'wh-dup' })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('topic not subscribed on this path → 400', async () => {
    const res = await deliver({ id: 1 }, { path: '/app/uninstalled', topic: 'shop/redact' });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('invalid shop domain header → 400', async () => {
    const res = await deliver({ id: 1 }, { shop: 'evil.com' });
    expect(res.status).toBe(400);
  });

  it('queue failure → 500 and the delivery is forgotten so Shopify can retry it', async () => {
    failSend = true;
    const res = await deliver({ id: 1 }, { webhookId: 'wh-retry' });
    expect(res.status).toBe(500);
    expect(d1.query('SELECT * FROM webhook_events')).toHaveLength(0);

    failSend = false;
    expect((await deliver({ id: 1 }, { webhookId: 'wh-retry' })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('compacts product payloads to the product gid and tags', async () => {
    const product = {
      id: 632910392,
      admin_graphql_api_id: 'gid://shopify/Product/632910392',
      title: 'Snus Original',
      body_html: '<p>long description</p>',
      tags: 'nicotine, snus ,',
      variants: [{ id: 808950810, barcode: '123' }],
    };
    const res = await deliver(product, { path: '/products', topic: 'products/update' });
    expect(res.status).toBe(200);
    expect(sent[0]).toEqual({
      type: 'products/update',
      shop: SHOP,
      payload: { productId: 'gid://shopify/Product/632910392', tags: ['nicotine', 'snus'] },
    });
  });

  it('products/delete is not subscribed (the metafield goes with the product) → 400', async () => {
    const res = await deliver({ id: 1 }, { path: '/products', topic: 'products/delete' });
    expect(res.status).toBe(400);
  });

  it('accepts all three compliance topics on /webhooks/compliance', async () => {
    const customer = { id: 191167, email: 'john@example.com', phone: null };
    const cases = [
      {
        topic: 'customers/data_request',
        payload: { customer, orders_requested: [1], data_request: { id: 9 } },
      },
      { topic: 'customers/redact', payload: { customer, orders_to_redact: [1] } },
      { topic: 'shop/redact', payload: { shop_id: 1, shop_domain: SHOP } },
    ];
    for (const { topic, payload } of cases) {
      const res = await deliver(payload, { path: '/compliance', topic });
      expect(res.status, topic).toBe(200);
    }
    expect(sent.map((m) => m.type)).toEqual(['customers/data_request', 'customers/redact', 'shop/redact']);
  });

  it('privacy requests never enqueue customer email or phone number', async () => {
    const customer = { id: 191167, email: 'john@example.com', phone: '+46701234567' };
    const shopInfo = { shop_id: 954889, shop_domain: SHOP };
    await deliver(
      { ...shopInfo, customer, orders_requested: [1], data_request: { id: 9 } },
      { path: '/compliance', topic: 'customers/data_request' },
    );
    await deliver(
      { ...shopInfo, customer, orders_to_redact: [1] },
      { path: '/compliance', topic: 'customers/redact' },
    );
    expect(sent.map((m) => m.payload)).toEqual([{ data_request: { id: '9' } }, { orders_to_redact: ['1'] }]);
    const queued = JSON.stringify(sent);
    expect(queued).not.toContain('+46701234567');
    expect(queued).not.toContain('john@example.com');
  });

  it('valid HMAC but unusable payload → 200 without enqueue (retries would not help)', async () => {
    const res = await deliver({ nope: true }, { path: '/compliance', topic: 'customers/data_request' });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

describe('only real routes answer', () => {
  const request = (path: string, method: string) => app.request(path, { method, body: '{}' }, env());

  it('unknown webhook path → 404', async () => {
    const res = await request('/webhooks/orders/create', 'POST');
    expect(res.status).toBe(404);
  });

  it('POST/PUT/DELETE to SPA paths → 405, never index.html', async () => {
    for (const [path, method] of [
      ['/', 'POST'],
      ['/settings', 'POST'],
      ['/x', 'PUT'],
      ['/index.html', 'DELETE'],
      ['/assets/index.js', 'PATCH'],
    ] as const) {
      const res = await request(path, method);
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get('content-type'), `${method} ${path}`).not.toContain('text/html');
    }
  });

  it('GET on a webhook path → 404', async () => {
    const res = await app.request('/webhooks/products', {}, env());
    expect(res.status).toBe(404);
  });
});
