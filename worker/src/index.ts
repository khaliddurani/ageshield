import { Hono } from 'hono';
import type { AppBindings, Env } from './env';
import { embeddedLoad } from './middleware/embedded-load';
import { sessionAuth } from './middleware/session-auth';
import { handleQueueBatch, type JobMessage } from './queue/handlers';
import { ZodError } from 'zod';
import { runDailyCron } from './cron';
import { meRoutes } from './routes/api/me';
import { billingRoutes } from './routes/api/billing';
import { settingsRoutes } from './routes/api/settings';
import { rulesRoutes } from './routes/api/rules';
import { verificationRoutes } from './routes/api/verifications';
import { RuleError } from './services/rules';
import { proxyRoutes } from './routes/proxy';
import { webhookRoutes } from './routes/webhooks';
import { oidcRoutes } from './routes/oidc';
import { TokenLockTimeoutError } from './lib/shopify/offline-token';
import { redactPath } from './lib/redact';

export const app = new Hono<AppBindings>();

app.get('/health', (c) => c.json({ ok: true }));

app.use('/api/*', sessionAuth);
app.route('/api', meRoutes);
app.route('/api', billingRoutes);
app.route('/api', settingsRoutes);
app.route('/api', rulesRoutes);
app.route('/api', verificationRoutes);
app.route('/webhooks', webhookRoutes);
app.route('/proxy', proxyRoutes);
app.route('/oidc', oidcRoutes);

// SPA shell + static assets (must stay after API, webhook, proxy and OIDC routes).
app.use('*', embeddedLoad);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  if (err instanceof RuleError) return c.json({ error: err.code, message: err.message }, err.status);
  if (err instanceof ZodError) {
    return c.json(
      {
        error: 'invalid_request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }
  if (err instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400);
  // Log the error name/message only — never request headers, query strings or tokens.
  console.error(
    `${c.req.method} ${redactPath(new URL(c.req.url).pathname)} failed: ${err.name}: ${err.message}`,
  );
  if (err instanceof TokenLockTimeoutError) return c.json({ error: 'busy' }, 503, { 'Retry-After': '1' });
  return c.json({ error: 'internal_error' }, 500);
});

/** Daily cron (ARCHITECTURE §9): housekeeping and plan sync. */
async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(runDailyCron(env, controller.scheduledTime));
}

export default {
  fetch: app.fetch,
  queue: handleQueueBatch,
  scheduled,
} satisfies ExportedHandler<Env, JobMessage>;
