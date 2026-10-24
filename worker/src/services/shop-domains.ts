import { z } from 'zod';
import { AccessDeniedError, type AdminClient } from '../lib/shopify/admin';

// The store's own storefront domains (ARCHITECTURE §6): where a shopper may be sent back after the Idura login.
// Nordic stores often sell on separate market domains (.dk/.se/.no/.fi) with separate cart cookies, so the shopper
// must return to the domain they started on — but only if that host really belongs to the shop:
//   allowed = {x.myshopify.com} ∪ {shop.primaryDomain.host} ∪ {webPresences[].domain.host}
// read via the Admin API (webPresences needs read_markets), cached on the shops row for an hour and re-read on a
// cache miss (at most once a minute, so made-up hosts can't force API calls). A host is compared exactly after
// lower-casing; anything else falls back to the primary domain.

export const DOMAINS_TTL_MS = 60 * 60_000;
export const MISS_REFRESH_MIN_MS = 60_000;

const DOMAINS_QUERY = `#graphql
  query AgeShieldStorefrontDomains($after: String) {
    shop { primaryDomain { host } }
    webPresences(first: 50, after: $after) {
      nodes { domain { host } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRIMARY_DOMAIN_QUERY = `#graphql
  query AgeShieldPrimaryDomain { shop { primaryDomain { host } } }
`;

const cachedSchema = z.object({ primary: z.string(), hosts: z.array(z.string()) });
export type StorefrontDomains = z.infer<typeof cachedSchema>;

/** A plain DNS host name: lower-case labels, no port, no trailing dot, no userinfo. */
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export function normalizeHost(host: string): string | null {
  const lower = host.trim().toLowerCase();
  return HOST_RE.test(lower) ? lower : null;
}

interface DomainsResponse {
  shop: { primaryDomain: { host: string } };
  webPresences: {
    nodes: { domain: { host: string } | null }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Reads the domains from Shopify. Without read_markets (not granted yet) only the primary domain is known. */
export async function fetchStorefrontDomains(admin: AdminClient, shop: string): Promise<StorefrontDomains> {
  const hosts = new Set<string>([shop]);
  let primary: string;
  try {
    let after: string | null = null;
    let first: DomainsResponse | null = null;
    for (let page = 0; page < 10; page++) {
      const data: DomainsResponse = await admin.graphql<DomainsResponse>(DOMAINS_QUERY, { after });
      first ??= data;
      for (const node of data.webPresences.nodes) {
        const host = node.domain ? normalizeHost(node.domain.host) : null; // subfolder presences have no domain
        if (host) hosts.add(host);
      }
      if (!data.webPresences.pageInfo.hasNextPage) break;
      after = data.webPresences.pageInfo.endCursor;
    }
    primary = first?.shop.primaryDomain.host ?? shop;
  } catch (err) {
    if (!(err instanceof AccessDeniedError)) throw err;
    const data = await admin.graphql<{ shop: { primaryDomain: { host: string } } }>(PRIMARY_DOMAIN_QUERY);
    primary = data.shop.primaryDomain.host;
  }
  const normalizedPrimary = normalizeHost(primary) ?? shop;
  hosts.add(normalizedPrimary);
  return { primary: normalizedPrimary, hosts: [...hosts].sort() };
}

async function readCache(db: D1Database, shop: string) {
  const row = await db
    .prepare('SELECT storefront_domains, storefront_domains_at FROM shops WHERE shop = ?1')
    .bind(shop)
    .first<{ storefront_domains: string | null; storefront_domains_at: number | null }>();
  let value: StorefrontDomains | null = null;
  try {
    const parsed = cachedSchema.safeParse(JSON.parse(row?.storefront_domains ?? 'null'));
    value = parsed.success ? parsed.data : null;
  } catch {
    value = null;
  }
  return { value, at: row?.storefront_domains_at ?? null };
}

/**
 * The host to send the shopper back to: `requestedHost` if it is one of the shop's domains, else the primary
 * domain (else the myshopify domain). Lookup failures never block a verification; they fall back.
 */
export async function returnHostFor(
  db: D1Database,
  admin: () => AdminClient,
  shop: string,
  requestedHost: string | null | undefined,
  now: number,
): Promise<string> {
  const host = requestedHost ? normalizeHost(requestedHost) : null;
  if (host === shop) return shop;

  const cache = await readCache(db, shop);
  const age = cache.at === null ? Infinity : now - cache.at;
  const known = cache.value !== null && host !== null && cache.value.hosts.includes(host);
  const stale = cache.value === null || age >= DOMAINS_TTL_MS;
  const missWorthRefresh = host !== null && !known && age >= MISS_REFRESH_MIN_MS;

  let domains = cache.value;
  if (stale || missWorthRefresh) {
    try {
      domains = await fetchStorefrontDomains(admin(), shop);
      await db
        .prepare('UPDATE shops SET storefront_domains = ?2, storefront_domains_at = ?3 WHERE shop = ?1')
        .bind(shop, JSON.stringify(domains), now)
        .run();
    } catch (err) {
      console.error(
        `storefront domains for ${shop} not refreshed: ${err instanceof Error ? err.name : 'error'}`,
      );
    }
  }
  if (host !== null && domains?.hosts.includes(host)) return host;
  return domains?.primary ?? shop;
}
