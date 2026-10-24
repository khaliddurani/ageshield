// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

// Polaris reads multi-word properties from their lowercased name ("gridtemplatecolumns"). Kebab-case attributes are
// silently ignored: the Home metrics stacked full-width on staging (Phase 9) because of grid-template-columns.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('camelCase props reach custom elements under the lowercased attribute name Polaris reads', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<s-grid gridTemplateColumns="1fr 1fr" />));
  expect(host.querySelector('s-grid')?.getAttribute('gridtemplatecolumns')).toBe('1fr 1fr');
  act(() => root.unmount());
});

it('no Polaris element uses a kebab-case attribute', () => {
  const dir = join(__dirname);
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.tsx'));
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/<s-[a-z-]+\b[^>]*?\s([a-z]+(?:-[a-z]+)+)=/g))
      offenders.push(`${f}: ${m[1]}`);
  }
  expect(offenders).toEqual([]);
});
