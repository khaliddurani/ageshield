import { beforeEach, describe, expect, it } from 'vitest';
import { runJob } from '../src/queue/handlers';
import { SHOP_TABLES } from '../src/services/compliance';
import { createTestD1, type TestD1 } from './d1';
import { SHOP, makeEnv, seedShop } from './helpers';

const NOW = 1_800_000_000_000;
let d1: TestD1;
const env = () => makeEnv({ DB: d1.db });
const run = (type: string, payload: unknown, shop = SHOP) =>
  runJob({ type, shop, payload }, env(), { now: () => NOW });

beforeEach(async () => {
  d1 = await createTestD1();
  seedShop(d1.raw);
});

describe('GDPR handlers', () => {
  it('customers/data_request: nothing stored about customers, acknowledged in the audit log', async () => {
    await run('customers/data_request', { data_request: { id: '9' } });
    expect(d1.query('SELECT action, details FROM audit_log')).toEqual([
      { action: 'customers_data_request', details: JSON.stringify({ requestId: '9', records: 0 }) },
    ]);
  });

  it('customers/redact: nothing to delete, acknowledged in the audit log', async () => {
    await run('customers/redact', { orders_to_redact: ['1', '2'] });
    expect(d1.query('SELECT action, details FROM audit_log')).toEqual([
      { action: 'customers_redact', details: JSON.stringify({ orders: 2, records: 0 }) },
    ]);
  });

  it('shop/redact is skipped while the shop is installed (reinstalled after uninstall)', async () => {
    await run('shop/redact', { shop_domain: SHOP });
    expect(d1.query('SELECT shop FROM shops')).toHaveLength(1);
    expect(d1.query('SELECT action FROM audit_log')).toEqual([{ action: 'shop_redact_skipped' }]);
  });

  it('shop/redact after uninstall deletes every row of that shop only', async () => {
    seedShop(d1.raw, 'other.myshopify.com');
    await run('app/uninstalled', {});
    d1.raw.run(
      "INSERT INTO webhook_events (webhook_id, shop, topic, received_at) VALUES ('w1', ?, 'app/uninstalled', 1)",
      [SHOP],
    );
    await run('shop/redact', { shop_domain: SHOP });
    for (const table of SHOP_TABLES) {
      expect(d1.query(`SELECT * FROM ${table} WHERE shop = ?`, SHOP), table).toEqual([]);
    }
    expect(d1.query('SELECT shop FROM shops')).toEqual([{ shop: 'other.myshopify.com' }]);
  });

  it('SHOP_TABLES covers every table with a shop column', () => {
    const tables = d1
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((t) => t.name)
      .filter((name) =>
        d1.query<{ name: string }>(`PRAGMA table_info(${name})`).some((c) => c.name === 'shop'),
      );
    expect([...SHOP_TABLES].sort()).toEqual(tables.sort());
  });
});
