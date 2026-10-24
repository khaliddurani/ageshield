// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineFakePolaris, fieldByLabel, typeInto } from '../test/fake-polaris';
import { TextArea, TextField } from './fields';

// Regression tests inherited from RecallKit: text ended up in the wrong form field (staging). Forms must use
// functional state updates so several fields changing before a re-render don't overwrite each other.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Form = { heading: string; body: string; button: string };
const EMPTY: Form = { heading: '', body: '', button: '' };
const LABELS: Record<keyof Form, string> = { heading: 'Heading', body: 'Body', button: 'Button' };
const VALUES: Form = { heading: 'Age check', body: 'You must be 18 or older.', button: 'Verify my age' };

let container: HTMLDivElement;
let root: Root;
let latest: Form;

function Harness() {
  const [form, setForm] = useState<Form>(EMPTY);
  useEffect(() => {
    latest = form;
  });
  const set = (key: keyof Form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <>
      <TextField label={LABELS.heading} value={form.heading} onChange={set('heading')} />
      <TextArea label={LABELS.body} value={form.body} onChange={set('body')} />
      <TextField label={LABELS.button} value={form.button} onChange={set('button')} />
    </>
  );
}

beforeAll(() => defineFakePolaris());

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const keys = Object.keys(LABELS) as (keyof Form)[];

describe('form fields: each field keeps its own value', () => {
  it('typing into each field one after another', async () => {
    for (const key of keys)
      await act(async () => typeInto(fieldByLabel(container, LABELS[key]), VALUES[key]));
    for (const key of keys) {
      expect(latest[key], key).toBe(VALUES[key]);
      expect((fieldByLabel(container, LABELS[key]) as HTMLElement & { value: string }).value, key).toBe(
        VALUES[key],
      );
    }
  });

  it('several fields changing before React re-renders (autofill) all keep their values', async () => {
    await act(async () => {
      for (const key of keys) typeInto(fieldByLabel(container, LABELS[key]), VALUES[key]);
    });
    for (const key of keys) expect(latest[key], key).toBe(VALUES[key]);
  });

  it('every field has its own name and autocomplete off', () => {
    const fields = [...container.querySelectorAll('s-text-field, s-text-area')];
    const names = fields.map((f) => f.getAttribute('name'));
    expect(names.every((n) => n !== null && n !== '')).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    for (const f of fields) expect(f.getAttribute('autocomplete'), f.getAttribute('label') ?? '').toBe('off');
  });
});

describe('field wrappers', () => {
  it('ignore input events that come from inside another element', async () => {
    const values: string[] = [];
    let calls = 0;
    function One() {
      const [value, setValue] = useState('');
      values.push(value);
      return (
        <TextField
          label="Outer"
          value={value}
          onChange={(v) => {
            calls++;
            setValue(v);
          }}
        />
      );
    }
    const box = document.createElement('div');
    document.body.appendChild(box);
    const r = createRoot(box);
    await act(async () => r.render(<One />));
    const host = fieldByLabel(box, 'Outer');
    const nested = document.createElement('s-text-field');
    host.appendChild(nested);
    await act(async () => typeInto(nested, 'from a nested field'));
    expect(calls).toBe(0);
    await act(async () => typeInto(host, 'own value'));
    expect(calls).toBe(1);
    expect(values.at(-1)).toBe('own value');
    await act(async () => r.unmount());
    box.remove();
  });
});
