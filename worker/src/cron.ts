import type { Env } from './env';
import { purgeRateLimits } from './services/rate-limit';
import { queuePlanSyncs } from './services/billing';

// Daily cron (ARCHITECTURE §9). Each task runs independently so one failure doesn't skip the others.
// Offline tokens stay fresh through use: the daily plan sync refreshes each installed shop's token.

const WEBHOOK_EVENTS_RETENTION_MS = 7 * 86_400_000;
const RATE_LIMIT_RETENTION_MS = 86_400_000;

export async function runDailyCron(env: Env, now: number): Promise<void> {
  const tasks: [string, () => Promise<unknown>][] = [
    ['plan_sync', () => queuePlanSyncs(env)],
    ['rate_limits', () => purgeRateLimits(env.DB, now, RATE_LIMIT_RETENTION_MS)],
    [
      'webhook_events',
      () =>
        env.DB.prepare('DELETE FROM webhook_events WHERE received_at < ?1')
          .bind(now - WEBHOOK_EVENTS_RETENTION_MS)
          .run(),
    ],
  ];
  for (const [name, task] of tasks) {
    try {
      const result = await task();
      if (name === 'plan_sync') console.log(`cron ${name}: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(
        `cron ${name} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown'}`,
      );
    }
  }
}
