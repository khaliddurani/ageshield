import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Every UI language has exactly the English keys (a missing key would silently fall back to English).

const read = (lang: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'locales', `${lang}.json`), 'utf8')) as Record<
    string,
    Record<string, string>
  >;
const keys = (m: Record<string, Record<string, string>>) =>
  Object.entries(m)
    .flatMap(([section, entries]) => Object.keys(entries).map((k) => `${section}.${k}`))
    .sort();

it.each(['da', 'sv'])('%s has the same keys as en', (lang) => {
  expect(keys(read(lang))).toEqual(keys(read('en')));
});
