import en from './locales/en.json';
import da from './locales/da.json';
import sv from './locales/sv.json';

type Messages = typeof en;
export type MessageKey = {
  [S in keyof Messages]: `${S & string}.${keyof Messages[S] & string}`;
}[keyof Messages];

const catalogs: Record<string, Messages> = { en, da, sv };

function detectLocale(): string {
  const param = new URLSearchParams(window.location.search).get('locale') ?? navigator.language;
  const lang = param.slice(0, 2).toLowerCase();
  return lang in catalogs ? lang : 'en';
}

/** Language of the app UI (en, da or sv). */
export const uiLocale = detectLocale();
const messages = catalogs[uiLocale] ?? en;

const pluralRules = new Intl.PluralRules(uiLocale);
const PLURAL_RE = /\{(\w+), plural, ((?:=?\w+ \{[^{}]*\}\s*)+)\}/g;
const FORM_RE = /(=?\w+) \{([^{}]*)\}/g;

/** "{count, plural, one {# product} other {# products}}" → the form for `count` in the UI language; "#" = the number. */
function plurals(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLURAL_RE, (match, name: string, body: string) => {
    if (!(name in vars)) return match;
    // Values may come pre-formatted ("1,999"): pick the form from the digits, print the value as given.
    const shown = String(vars[name]);
    const n = typeof vars[name] === 'number' ? vars[name] : Number(shown.replace(/[^\d.-]/g, ''));
    const forms = new Map([...body.matchAll(FORM_RE)].map((f) => [f[1] ?? '', f[2] ?? '']));
    const form = forms.get(`=${n}`) ?? forms.get(pluralRules.select(n)) ?? forms.get('other') ?? '';
    return form.replace(/#/g, shown);
  });
}

/**
 * Look up a UI string ("section.key"), falling back to English. `{name}` placeholders are filled from `vars`; counts
 * use ICU-style plurals.
 */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const [section, name] = key.split('.') as [keyof Messages, string];
  const lookup = (m: Messages) => (m[section] as Record<string, string | undefined>)[name];
  const template = lookup(messages) ?? lookup(en) ?? key;
  return plurals(template, vars).replace(/\{(\w+)\}/g, (match, v: string) =>
    v in vars ? String(vars[v]) : match,
  );
}

/** "A, B and C" in the UI language. */
export function formatList(items: string[]): string {
  const locale = uiLocale === 'en' ? 'en-GB' : uiLocale;
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
}
