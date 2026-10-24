import { Hono } from 'hono';
import type { AppBindings } from '../../env';
import { dashboardSummary, listQuerySchema, listVerifications } from '../../services/verification-stats';

// /api/verifications — Verifications page (paginated, no personal data) and /api/dashboard — Dashboard numbers.

export const verificationRoutes = new Hono<AppBindings>()
  .get('/verifications', async (c) => {
    const query = listQuerySchema.parse(c.req.query());
    return c.json(await listVerifications(c.env.DB, c.get('shop'), query));
  })
  .get('/dashboard', async (c) => c.json(await dashboardSummary(c.env.DB, c.get('shop'), Date.now())));
