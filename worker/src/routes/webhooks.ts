import { Hono, type Context } from 'hono';
import type { AppBindings } from '../env';
import { verifyWebhookHmac } from '../lib/shopify/hmac';
import { isValidShopDomain } from '../lib/shopify/shop';
import { toJobPayload, type WebhookTopic } from '../lib/shopify/webhook-payloads';

// Webhook intake (ARCHITECTURE §4): verify HMAC over the raw body, dedupe, enqueue, answer fast.
// Paths and topics must match the [webhooks] subscriptions in shopify.app*.toml.

const ROUTE_TOPICS: Record<string, readonly WebhookTopic[]> = {
  '/app/uninstalled': ['app/uninstalled'],
  '/app/scopes_update': ['app/scopes_update'],
  '/products': ['products/create', 'products/update'],
  '/compliance': ['customers/data_request', 'customers/redact', 'shop/redact'],
};

async function receiveWebhook(c: Context<AppBindings>, topics: readonly WebhookTopic[]) {
  const rawBody = await c.req.arrayBuffer();
  const valid = await verifyWebhookHmac(
    rawBody,
    c.req.header('X-Shopify-Hmac-Sha256'),
    c.env.SHOPIFY_API_SECRET,
  );
  if (!valid) return c.text('Unauthorized', 401);

  const topic = c.req.header('X-Shopify-Topic') as WebhookTopic | undefined;
  const shop = c.req.header('X-Shopify-Shop-Domain');
  const webhookId = c.req.header('X-Shopify-Webhook-Id');
  if (!topic || !topics.includes(topic) || !shop || !isValidShopDomain(shop) || !webhookId) {
    return c.text('Bad request', 400);
  }

  let payload: unknown;
  try {
    payload = toJobPayload(topic, JSON.parse(new TextDecoder().decode(rawBody)));
  } catch (err) {
    // Answer 200 anyway: retries would not fix the payload, and repeated failures delete the subscription.
    console.error(
      `webhook ${topic} for ${shop}: invalid payload (${err instanceof Error ? err.name : 'error'})`,
    );
    return c.text('OK', 200);
  }

  const inserted = await c.env.DB.prepare(
    `INSERT INTO webhook_events (webhook_id, shop, topic, received_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(webhook_id) DO NOTHING`,
  )
    .bind(webhookId, shop, topic, Date.now())
    .run();
  if (inserted.meta.changes === 0) return c.text('OK', 200); // duplicate delivery

  try {
    await c.env.JOBS.send({ type: topic, shop, payload });
  } catch (err) {
    // Forget the delivery so Shopify's retry is processed, not skipped as a duplicate.
    await c.env.DB.prepare('DELETE FROM webhook_events WHERE webhook_id = ?1').bind(webhookId).run();
    throw err;
  }
  return c.text('OK', 200);
}

export const webhookRoutes = new Hono<AppBindings>();
for (const [path, topics] of Object.entries(ROUTE_TOPICS)) {
  webhookRoutes.post(path, (c) => receiveWebhook(c, topics));
}
