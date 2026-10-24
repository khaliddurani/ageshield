import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { buildStorefrontConfig, scriptSafeJson } from '../src/services/storefront-config';
import { DEFAULT_SETTINGS, type Settings } from '../src/services/settings';

// Theme app extension (extensions/age-gate): the real age-gate.js runs in a fresh jsdom window per test, with the
// data block the Liquid embed renders.

const EXT = join(import.meta.dirname, '..', '..', 'extensions', 'age-gate');
const read = (path: string) => readFileSync(join(EXT, path), 'utf8');
const SCRIPT = read('assets/age-gate.js');
const LOCALES = ['en.default', 'da', 'sv'] as const;
const locale = (name: string) =>
  (JSON.parse(read(`locales/${name}.json`)) as { age_gate: Record<string, string> }).age_gate;
const EN = locale('en.default');

const nowS = () => Math.floor(Date.now() / 1000);
function token(minAge: number, exp = nowS() + 1800): string {
  const b64url = (s: string) => Buffer.from(s).toString('base64url');
  const payload = {
    v: 1,
    vid: 'x',
    shop: 'demo-store.myshopify.com',
    min_age: minAge,
    country: 'DK',
    iat: 1,
    exp,
  };
  return `${b64url(JSON.stringify(payload))}.${b64url('s'.repeat(32))}`;
}

interface PageOptions {
  template?: 'product' | 'cart' | 'collection';
  productAge?: number | null;
  cartAge?: number;
  cartToken?: string;
  settings?: Partial<Settings>;
  hash?: string;
  locale?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const PRODUCT_HTML = `<main>
  <form action="/cart/add" method="post" id="product-form">
    <button type="submit" name="add" id="add">Add to cart</button>
    <div class="shopify-payment-button" id="buy-now"><button>Buy it now</button></div>
  </form>
</main>
<div id="drawer"><button type="submit" name="checkout" id="drawer-checkout">Check out</button></div>`;

const CART_HTML = `<main><form action="/cart" method="post"><button type="submit" name="checkout" id="checkout">Check out</button></form></main>`;

// The worker test tsconfig has no DOM lib (it would clash with the Workers types): just what these tests use.
interface TestElement {
  id: string;
  disabled: boolean;
  textContent: string | null;
  nextElementSibling: TestElement | null;
  classList: { contains(name: string): boolean };
  getAttribute(name: string): string | null;
  click(): void;
  dispatchEvent(event: unknown): boolean;
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void;
  appendChild(node: TestElement): TestElement;
}
interface TestWindow {
  eval(code: string): unknown;
  fetch: unknown;
  AgeShield: unknown;
  location: { hash: string; href: string };
  document: {
    querySelector(selector: string): TestElement | null;
    querySelectorAll(selector: string): Iterable<TestElement>;
    createElement(tag: string): TestElement;
  };
  Event: new (
    type: string,
    init?: { bubbles?: boolean; cancelable?: boolean },
  ) => { defaultPrevented: boolean };
  requestAnimationFrame(callback: () => void): number;
}

function page(opts: PageOptions = {}) {
  const template = opts.template ?? 'product';
  const data = {
    config: JSON.parse(
      scriptSafeJson(
        buildStorefrontConfig(
          { APP_PROXY_SUBPATH: 'ageshield-staging' },
          { ...DEFAULT_SETTINGS, ...opts.settings },
        ),
      ),
    ),
    productAge: template === 'product' ? (opts.productAge === undefined ? 18 : opts.productAge) : null,
    cartAge: opts.cartAge ?? 0,
    template,
    token: opts.cartToken ?? '',
    locale: opts.locale ?? 'en',
    root: '/',
    i18n: EN,
  };
  const html = `<!doctype html><html><body>${template === 'cart' ? CART_HTML : PRODUCT_HTML}
    <script type="application/json" id="ageshield-data">${JSON.stringify(data)}</script></body></html>`;
  const dom = new JSDOM(html, {
    url: `https://snusbutik.se/${template === 'cart' ? 'cart' : 'products/snus?variant=1'}${opts.hash ?? ''}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const window = dom.window as TestWindow;
  const fetchMock = vi.fn(
    opts.fetch ??
      (async (url: string) =>
        url.includes('/cart/update.js') ? new Response('{}') : new Response('{}', { status: 500 })),
  );
  window.fetch = fetchMock;
  const navigate = vi.fn();
  window.AgeShield = { navigate };
  window.eval(SCRIPT);
  const $ = (sel: string) => window.document.querySelector(sel) as TestElement;
  const message = () => $('.ageshield__message')?.textContent ?? '';
  return { window, $, fetchMock, navigate, message };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('restricted product page (gate mode product_page)', () => {
  it('blocks add to cart, hides buy-now, offers one button per enabled country', () => {
    const { $, window } = page();
    expect($('#add').disabled).toBe(true);
    expect($('#add').getAttribute('aria-disabled')).toBe('true');
    expect($('#buy-now').classList.contains('ageshield-hidden')).toBe(true);
    const buttons = [...window.document.querySelectorAll('.ageshield__button')].map((b) => b.textContent);
    expect(buttons).toEqual(['MitID', 'BankID (Sweden)', 'BankID (Norway)', 'Finnish bank ID']);
    expect($('.ageshield__body').textContent).toContain('You must be 18+');
    expect($('.ageshield').nextElementSibling?.id).toBe('product-form'); // placed right above the form
  });

  it('stops a submit even if the theme re-enabled the button', () => {
    const { $, window } = page();
    $('#add').disabled = false;
    const event = new window.Event('submit', { bubbles: true, cancelable: true });
    $('#product-form').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('verify: POSTs to the App Proxy (country, age, path, host) and navigates to the Idura URL', async () => {
    const authorizeUrl = 'https://merchantkits.test.idura.broker/oauth2/authorize?x=1';
    const { $, fetchMock, navigate } = page({
      fetch: async () => Response.json({ authorizeUrl }),
    });
    $('[data-country="DK"]').click();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/apps/ageshield-staging/verify/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      country: 'DK',
      minAge: 18,
      returnPath: '/products/snus?variant=1',
      host: 'snusbutik.se',
    });
    expect(navigate).toHaveBeenCalledWith(authorizeUrl);
  });

  it('never navigates to a non-https URL; rate limit and errors show a message', async () => {
    let answer = Response.json({ authorizeUrl: 'javascript:alert(1)' });
    const { $, navigate, message } = page({ fetch: async () => answer });
    $('[data-country="SE"]').click();
    await flush();
    expect(navigate).not.toHaveBeenCalled();
    expect(message()).toBe(EN['error']);
    answer = new Response('{}', { status: 429 });
    $('[data-country="SE"]').click();
    await flush();
    expect(message()).toBe(EN['rate_limited']);
  });

  it('only the merchant’s countries; merchant texts for the shop language win', () => {
    const { window, $ } = page({
      settings: {
        enabledCountries: ['DK', 'SE'],
        popupTexts: { sv: { heading: 'Ålderskoll', body: 'Endast 18+', button: 'Legitimera dig med' } },
      },
      locale: 'sv',
    });
    expect(
      [...window.document.querySelectorAll('[data-country]')].map((b) => b.getAttribute('data-country')),
    ).toEqual(['DK', 'SE']);
    expect($('.ageshield__heading').textContent).toBe('Ålderskoll');
    expect($('.ageshield__body').textContent).toBe('Endast 18+');
  });
});

describe('returning from the eID login', () => {
  it('#ageshield=<token>: removes the fragment, saves the cart attribute, unblocks, shows "Age verified ✓"', async () => {
    const t = token(18);
    const { window, $, fetchMock } = page({ hash: `#ageshield=${t}` });
    expect(window.location.hash).toBe('');
    expect(window.location.href).toBe('https://snusbutik.se/products/snus?variant=1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/cart/update.js');
    expect(JSON.parse(String(init.body))).toEqual({ attributes: { _ageshield_token: t } });
    await flush();
    expect($('#add').disabled).toBe(false);
    expect($('.ageshield__verified').textContent).toBe('Age verified ✓');
    expect($('#buy-now').classList.contains('ageshield-hidden')).toBe(true); // buy-now skips the cart token
  });

  it('cart attribute could not be saved → still blocked, error message', async () => {
    const { $, message } = page({
      hash: `#ageshield=${token(18)}`,
      fetch: async () => new Response('', { status: 500 }),
    });
    await flush();
    await flush();
    expect($('#add').disabled).toBe(true);
    expect(message()).toBe(EN['error']);
  });

  it.each([
    ['rejected', '18', 'DK', 'You must be 18+ to buy this product'],
    ['cancelled', '18', 'SE', 'Verification cancelled, try again'],
    ['assurance', '18', 'DK', "Your MitID doesn't have the required security level"],
    ['assurance', '18', 'SE', "Your eID doesn't have the required security level"],
    ['expired', '18', 'DK', EN['expired']],
    ['nonsense', '18', 'DK', EN['error']],
  ])('#ageshield_status=%s → clear message, still blocked', (status, age, country, text) => {
    const { window, $, message, fetchMock } = page({
      hash: `#ageshield_status=${status}&ageshield_age=${age}&ageshield_country=${country}`,
    });
    expect(window.location.hash).toBe('');
    expect(message()).toBe(text);
    expect($('#add').disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a malformed token in the fragment is ignored', () => {
    const { $, fetchMock } = page({ hash: '#ageshield=<script>' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect($('#add').disabled).toBe(true);
  });
});

describe('token already in the cart', () => {
  it('a valid token for the age unblocks without a new login', () => {
    expect(page({ cartToken: token(18) }).$('#add').disabled).toBe(false);
    expect(page({ productAge: 16, cartToken: token(18) }).$('#add').disabled).toBe(false);
  });

  it('an expired token, or one for a lower age, keeps it blocked', () => {
    expect(page({ cartToken: token(18, nowS() - 1) }).$('#add').disabled).toBe(true);
    expect(page({ productAge: 21, cartToken: token(18) }).$('#add').disabled).toBe(true);
  });
});

describe('checkout blocking', () => {
  it('cart page with restricted items: checkout blocked until verified', () => {
    const blocked = page({ template: 'cart', cartAge: 18 });
    expect(blocked.$('#checkout').disabled).toBe(true);
    expect(blocked.$('.ageshield__body').textContent).toContain('Your cart contains products for 18+');
    expect(page({ template: 'cart', cartAge: 18, cartToken: token(18) }).$('#checkout').disabled).toBe(false);
  });

  it('gate mode cart: add to cart allowed, drawer checkout blocked once a restricted product was added', async () => {
    const { $, window } = page({ settings: { gateMode: 'cart' } });
    expect($('#add').disabled).toBe(false);
    expect($('#drawer-checkout').disabled).toBe(false);
    $('#product-form').addEventListener('submit', (e) => e.preventDefault()); // jsdom can't navigate
    $('#add').click();
    // Blocking is re-applied on the next DOM change (themes re-render drawers after adding).
    $('#drawer').appendChild(window.document.createElement('span'));
    // The script re-applies in the frame after the mutation; check one frame later.
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
    );
    expect($('#drawer-checkout').disabled).toBe(true);
  });
});

describe('extension files', () => {
  it('the stylesheet uses no rem units (Dawn sets the root font size to 62.5%)', () => {
    const css = read('assets/age-gate.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/[\d.]+rem\b/g) ?? []).toEqual([]);
    expect(css).toContain('font-size: inherit');
  });

  it('every locale has the same keys and the placeholders the script fills', () => {
    const keys = Object.keys(EN).sort();
    for (const name of LOCALES) {
      const messages = locale(name);
      expect(Object.keys(messages).sort(), name).toEqual(keys);
      for (const key of ['body', 'body_checkout', 'body_cart', 'rejected']) {
        expect(messages[key], `${name}.${key}`).toContain('{age}');
      }
    }
  });

  it('the Liquid embed passes every translation the script uses', () => {
    const liquid = read('blocks/age_gate.liquid');
    // Literal keys only (t('key') or t('key', …)); t('method_' + country) is covered by the loop below.
    const used = new Set([...SCRIPT.matchAll(/\bt\('([a-z_]+)'[,)]/g)].map((m) => m[1]));
    for (const country of ['dk', 'se', 'no', 'fi']) used.add(`method_${country}`);
    for (const key of used) {
      expect(liquid, key).toContain(`"${key}": {{ 'age_gate.${key}' | t | json }}`);
      expect(EN[key ?? ''], key).toBeTruthy();
    }
  });

  it('the embed reads the app-owned product metafield and the app-data config metafield', () => {
    const liquid = read('blocks/age_gate.liquid');
    expect(liquid).toContain("product.metafields['$app'].age_restricted.value");
    expect(liquid).toContain('app.metafields.ageshield.config.value');
    expect(liquid).toContain(`cart.attributes['_ageshield_token']`);
    expect(liquid).toMatch(/"target": "body"/);
  });

  it('the script never uses innerHTML (all text via textContent)', () => {
    expect(SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('storefront config metafield', () => {
  it('is script-safe JSON: merchant text cannot close the <script> tag', () => {
    const json = scriptSafeJson(
      buildStorefrontConfig(
        { APP_PROXY_SUBPATH: 'ageshield' },
        {
          ...DEFAULT_SETTINGS,
          popupTexts: {
            en: {
              heading: '</script><img src=x onerror=alert(1)>',
              body: 'a & b',
              button: String.fromCharCode(0x2028),
            },
          },
        },
      ),
    );
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json).texts.en.heading).toBe('</script><img src=x onerror=alert(1)>');
  });
});
