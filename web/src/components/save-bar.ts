import { useEffect } from 'react';
import { setNavigationBlocked } from '../router';

/** True while the page contains this <ui-save-bar> (App Bridge rejects show/hide for an id it can't find). */
export function saveBarMounted(id: string): boolean {
  return document.getElementById(id)?.localName === 'ui-save-bar';
}

/**
 * Shows or hides a save bar — only while its element exists, and never leaves a rejected promise unhandled
 * (RecallKit staging: "Uncaught (in promise) Error: SaveBar with ID recall-details-save-bar not found" when a form
 * called hide before its save bar was rendered and after it was removed). A removed element takes its bar with it.
 */
export function setSaveBarVisible(id: string, visible: boolean): void {
  if (!saveBarMounted(id)) return;
  try {
    (visible ? shopify.saveBar.show(id) : shopify.saveBar.hide(id)).catch(() => undefined);
  } catch {
    // App Bridge not ready: nothing to show or hide yet.
  }
}

/**
 * Contextual Save Bar: shown and navigation blocked while `dirty`; hidden and unblocked on unmount. The <ui-save-bar>
 * must be rendered by the same component (pages render it only once loaded, so loading states are skipped).
 */
export function useSaveBar(id: string, dirty: boolean) {
  useEffect(() => {
    setNavigationBlocked(dirty);
    setSaveBarVisible(id, dirty);
  }, [id, dirty]);
  useEffect(
    () => () => {
      setNavigationBlocked(false);
      setSaveBarVisible(id, false);
    },
    [id],
  );
}
