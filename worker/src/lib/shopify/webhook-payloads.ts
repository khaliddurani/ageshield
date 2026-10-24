import { z } from 'zod';

// Zod schemas for the webhook payloads we use. Unknown fields are stripped, so queue messages stay small.

const idSchema = z.union([z.number(), z.string()]).transform((v) => String(v));

export const WEBHOOK_TOPICS = [
  'app/uninstalled',
  'app/scopes_update',
  'products/create',
  'products/update',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export const appScopesUpdateSchema = z.object({
  current: z.array(z.string()),
});

/** products/create|update as delivered by Shopify (REST-style JSON): only what the rule matching needs. */
const productWebhookSchema = z.object({
  id: idSchema,
  admin_graphql_api_id: z.string().optional(),
  // Comma-separated in REST payloads ("a, b"); an array in some API versions.
  tags: z.union([z.string(), z.array(z.string())]).nullish(),
});

/** Compact product job for the age-restriction sync. */
export const productJobSchema = z.object({
  productId: z.string(),
  tags: z.array(z.string()),
});
export type ProductJob = z.infer<typeof productJobSchema>;

// Only the request ids are kept. Shopify also sends the customer's email and phone number; AgeShield stores no
// customer data, so they are dropped here and never enter the queue (or the dead-letter queue).
export const customersDataRequestSchema = z.object({
  data_request: z.object({ id: idSchema }),
});
export type CustomersDataRequest = z.infer<typeof customersDataRequestSchema>;

export const customersRedactSchema = z.object({
  orders_to_redact: z.array(idSchema).default([]),
});
export type CustomersRedact = z.infer<typeof customersRedactSchema>;

export const shopRedactSchema = z.object({
  shop_domain: z.string(),
});

const productGid = (id: string) => `gid://shopify/Product/${id}`;

export function compactProduct(payload: unknown): ProductJob {
  const product = productWebhookSchema.parse(payload);
  const tags = Array.isArray(product.tags) ? product.tags : (product.tags ?? '').split(',');
  return {
    productId: product.admin_graphql_api_id ?? productGid(product.id),
    tags: tags.map((t) => t.trim()).filter((t) => t !== ''),
  };
}

/** Validates a webhook payload for `topic` and returns the queue payload. Throws ZodError if invalid. */
export function toJobPayload(topic: WebhookTopic, payload: unknown): unknown {
  switch (topic) {
    case 'app/uninstalled':
      return {};
    case 'app/scopes_update':
      return appScopesUpdateSchema.parse(payload);
    case 'products/create':
    case 'products/update':
      return compactProduct(payload);
    case 'customers/data_request':
      return customersDataRequestSchema.parse(payload);
    case 'customers/redact':
      return customersRedactSchema.parse(payload);
    case 'shop/redact':
      return shopRedactSchema.parse(payload);
  }
}
