import { AccessDeniedError, type AdminClient } from '../src/lib/shopify/admin';

// In-memory stand-in for the Admin GraphQL API operations the app uses. Dispatches on the operation name in the
// query document; tests extend `handlers` for operations added later.

export class FakeShopify {
  /** `${ownerId}|${namespace}.${key}` → { type, value } */
  metafields = new Map<string, { type: string; value: string }>();
  /** config/settings_data.json of the main theme (null = file missing). */
  settingsData: string | null = null;
  themeName = 'Dawn';
  calls: { op: string; variables: Record<string, unknown> }[] = [];
  /** Operation name → error thrown on the next call(s). */
  failures = new Map<string, Error>();
  /** Extra operation handlers (operation name → handler). */
  handlers = new Map<string, (variables: Record<string, unknown>) => unknown>();

  opCount(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  readonly admin: AdminClient = {
    graphql: async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'anonymous';
      this.calls.push({ op, variables });
      const failure = this.failures.get(op);
      if (failure) throw failure;
      return this.handle(op, variables) as T;
    },
  };

  private handle(op: string, v: Record<string, unknown>): unknown {
    const custom = this.handlers.get(op);
    if (custom) return custom(v);
    switch (op) {
      case 'AgeShieldMainThemeSettings':
        return {
          themes: {
            nodes: [
              {
                id: 'gid://shopify/OnlineStoreTheme/1',
                name: this.themeName,
                files: {
                  nodes:
                    this.settingsData === null
                      ? []
                      : [{ filename: 'config/settings_data.json', body: { content: this.settingsData } }],
                },
              },
            ],
          },
        };
      default:
        throw new AccessDeniedError(`FakeShopify: unexpected operation ${op}`);
    }
  }
}
