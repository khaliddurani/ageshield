import { useEffect, useSyncExternalStore } from 'react';

// Minimal client-side router. App Bridge mirrors history changes into the admin URL; <s-link> clicks in the
// app nav arrive as `shopify:navigate` events. The query string (shop, host, embedded…) is kept on every
// navigation so a reload of the iframe is still recognized as an embedded load.

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** Set while a form has unsaved changes; navigation is then blocked and the save bar is shaken. */
let dirtyForm = false;
export function setNavigationBlocked(blocked: boolean) {
  dirtyForm = blocked;
}

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (dirtyForm) {
    // Only while a save bar is on the page; a flag left over from a removed form must not block navigation.
    if (document.querySelector('ui-save-bar')) {
      shopify.saveBar.leaveConfirmation().catch(() => undefined);
      return;
    }
    dirtyForm = false;
  }
  const url = `${path}${window.location.search}`;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.scrollTo(0, 0);
  notify();
}

/** Routes App Bridge navigation (s-app-nav, s-link) through the client-side router. */
export function useAppBridgeNavigation() {
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const href = target?.getAttribute('href') ?? (event as CustomEvent<{ href?: string }>).detail?.href;
      if (href?.startsWith('/')) navigate(href);
    };
    document.addEventListener('shopify:navigate', onNavigate);
    return () => document.removeEventListener('shopify:navigate', onNavigate);
  }, []);
}

/** Matches "/rules/:id" style patterns; returns params or null. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i] ?? '';
    const value = s[i] ?? '';
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(value);
    else if (part !== value) return null;
  }
  return params;
}
