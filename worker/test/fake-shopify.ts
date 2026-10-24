import { AccessDeniedError, type AdminClient } from '../src/lib/shopify/admin';

// In-memory stand-in for the Admin GraphQL API operations the app uses. Dispatches on the operation name in the
// query document; tests extend `handlers` for operations added later.

export interface FakeProduct {
  tags: string[];
  /** Collection gids the product belongs to. */
  collections: string[];
}

export class FakeShopify {
  /** `${ownerId}|${namespace}.${key}` → { type, value } */
  metafields = new Map<string, { type: string; value: string }>();
  /** Product gid → product. */
  products = new Map<string, FakeProduct>();
  /** Collections that exist (a rule may point at a deleted one). */
  collections = new Set<string>();
  /** Page size of connection queries (small values exercise cursors). */
  pageSize = 250;
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

  /** `$app.age_restricted` of a product as a number, or undefined. */
  ageRestriction(productGid: string): number | undefined {
    const mf = this.metafields.get(`${productGid}|$app.age_restricted`);
    return mf ? Number(mf.value) : undefined;
  }

  private page(ids: string[], after: unknown) {
    const start = typeof after === 'string' ? Number(after) : 0;
    const end = start + this.pageSize;
    return {
      nodes: ids.slice(start, end).map((id) => ({ id })),
      pageInfo: { hasNextPage: end < ids.length, endCursor: end < ids.length ? String(end) : null },
    };
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
      case 'AgeShieldCollectionProducts': {
        const id = v['id'] as string;
        if (!this.collections.has(id)) return { collection: null };
        const ids = [...this.products].filter(([, p]) => p.collections.includes(id)).map(([gid]) => gid);
        return { collection: { products: this.page(ids, v['after']) } };
      }
      case 'AgeShieldTaggedProducts': {
        const tag = /^tag:"(.*)"$/s.exec(v['query'] as string)?.[1]?.replace(/\\(.)/g, '$1') ?? '';
        const ids = [...this.products]
          .filter(([, p]) => p.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
          .map(([gid]) => gid);
        return { products: this.page(ids, v['after']) };
      }
      case 'AgeShieldProductsExist':
        return { nodes: (v['ids'] as string[]).map((id) => (this.products.has(id) ? { id } : null)) };
      case 'AgeShieldProductCollections': {
        const p = this.products.get(v['id'] as string);
        return { product: p ? { collections: { nodes: p.collections.map((id) => ({ id })) } } : null };
      }
      case 'AgeShieldMetafieldsSet': {
        const input = v['metafields'] as {
          ownerId: string;
          namespace: string;
          key: string;
          type: string;
          value: string;
        }[];
        if (input.length > 25) throw new Error('metafieldsSet accepts at most 25 metafields');
        const missing = input.find((m) => !this.products.has(m.ownerId));
        if (missing) {
          return {
            metafieldsSet: {
              metafields: [],
              userErrors: [{ field: ['ownerId'], message: 'Owner not found' }],
            },
          };
        }
        for (const m of input) {
          this.metafields.set(`${m.ownerId}|${m.namespace}.${m.key}`, { type: m.type, value: m.value });
        }
        return { metafieldsSet: { metafields: [], userErrors: [] } };
      }
      case 'AgeShieldMetafieldsDelete': {
        for (const m of v['metafields'] as { ownerId: string; namespace: string; key: string }[]) {
          this.metafields.delete(`${m.ownerId}|${m.namespace}.${m.key}`);
        }
        return { metafieldsDelete: { deletedMetafields: [], userErrors: [] } };
      }
      default:
        throw new AccessDeniedError(`FakeShopify: unexpected operation ${op}`);
    }
  }
}
