import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { completeVerification } from '../services/verification';

// GET /oidc/callback — Idura redirects the shopper's browser here (top-level, directly on the Worker, not via the App
// Proxy). The answer is a 302 back to the store page with the result in the URL fragment. Only when the state is
// unknown or already used is there nowhere to go back to; then a small static page is shown.
// The query string holds the authorization code and state: it is never logged (lib/redact.ts drops query strings).

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const PAGE_TEXT = {
  en: {
    title: 'Age verification',
    body: 'This verification link has expired or was already used. Go back to the store and start the age verification again.',
  },
  da: {
    title: 'Aldersbekræftelse',
    body: 'Dette link er udløbet eller allerede brugt. Gå tilbage til butikken, og start aldersbekræftelsen igen.',
  },
  sv: {
    title: 'Åldersverifiering',
    body: 'Den här länken har gått ut eller har redan använts. Gå tillbaka till butiken och starta åldersverifieringen igen.',
  },
} as const;

/** First supported language from Accept-Language. */
export function pageLocale(header: string | undefined): keyof typeof PAGE_TEXT {
  for (const part of (header ?? '').split(',')) {
    const lang = part.split(';')[0]?.trim().slice(0, 2).toLowerCase();
    if (lang === 'da' || lang === 'sv' || lang === 'en') return lang;
  }
  return 'en';
}

function invalidStatePage(locale: keyof typeof PAGE_TEXT): string {
  const text = PAGE_TEXT[locale];
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${text.title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32em;margin:4em auto;padding:0 1em;line-height:1.5;color:#222}</style>
</head><body><h1>${text.title}</h1><p>${text.body}</p></body></html>`;
}

export const oidcRoutes = new Hono<AppBindings>();

oidcRoutes.get('/callback', async (c) => {
  const outcome = await completeVerification(c.env, new URL(c.req.url).searchParams, Date.now());
  if (outcome.kind === 'redirect') {
    return c.body(null, 302, { ...SECURITY_HEADERS, Location: outcome.url });
  }
  return c.html(invalidStatePage(pageLocale(c.req.header('Accept-Language'))), outcome.status, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
});
