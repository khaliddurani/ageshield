// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { navigate, setNavigationBlocked } from '../router';
import { useSaveBar } from './save-bar';

// Staging M4 (2026-10-12): "Uncaught (in promise) Error: SaveBar with ID recall-details-save-bar not found" — the
// wizard called show/hide while its <ui-save-bar> wasn't rendered (loading, after unmount) without catching.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = 'test-save-bar';
/** Like App Bridge: rejects for an id that isn't in the document. */
const appBridge = (method: string) =>
  vi.fn((id?: string) =>
    id === undefined || document.getElementById(id)
      ? Promise.resolve()
      : Promise.reject(new Error(`SaveBar with ID ${id} not found (${method})`)),
  );

let saveBar: {
  show: ReturnType<typeof appBridge>;
  hide: ReturnType<typeof appBridge>;
  leaveConfirmation: ReturnType<typeof appBridge>;
};
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  saveBar = { show: appBridge('show'), hide: appBridge('hide'), leaveConfirmation: appBridge('leave') };
  (globalThis as unknown as { shopify: unknown }).shopify = { saveBar };
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  host.remove();
  setNavigationBlocked(false);
});

/** A page that renders its save bar only once loaded, like the Settings page. */
function Page({ ready, dirty }: { ready: boolean; dirty: boolean }) {
  useSaveBar(ID, dirty);
  return ready ? <ui-save-bar id={ID} /> : <p>Loading</p>;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it('never calls App Bridge for a save bar that is not rendered, and leaves no unhandled rejection', async () => {
  act(() => root.render(<Page ready={false} dirty={false} />)); // loading: no element yet
  act(() => root.render(<Page ready dirty />));
  act(() => root.render(<Page ready dirty={false} />));
  act(() => root.unmount()); // element removed before the cleanup runs
  await flush();

  expect(saveBar.show.mock.calls).toEqual([[ID]]);
  expect(saveBar.hide.mock.calls).toEqual([[ID]]);
  expect(unhandled).toEqual([]);
});

it('navigation asks for confirmation only while a save bar is on the page', async () => {
  act(() => root.render(<Page ready dirty />));
  const before = window.location.pathname;
  navigate('/elsewhere');
  expect(saveBar.leaveConfirmation).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe(before);

  // A blocked flag left over without a save bar must not trap the merchant on the page.
  act(() => root.unmount());
  setNavigationBlocked(true);
  navigate('/elsewhere');
  expect(saveBar.leaveConfirmation).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe('/elsewhere');
  await flush();
  expect(unhandled).toEqual([]);
});

it('every save bar goes through useSaveBar (no direct shopify.saveBar calls in pages)', () => {
  const src = join(__dirname, '..');
  const files = (readdirSync(src, { recursive: true }) as string[]).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/(save-bar\.ts|router\.tsx|\.d\.ts)$/.test(f),
  );
  const direct = files.filter((f) => readFileSync(join(src, f), 'utf8').includes('shopify.saveBar.'));
  expect(direct).toEqual([]);
});
