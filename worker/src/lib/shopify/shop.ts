const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** True for a canonical `x.myshopify.com` domain. Validate every shop value before using it in URLs or headers. */
export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

/** `x.myshopify.com` → `x` (the store handle used in admin.shopify.com URLs). */
export function storeHandle(shop: string): string {
  return shop.replace(/\.myshopify\.com$/, '');
}
