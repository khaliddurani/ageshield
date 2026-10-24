/**
 * Runs `fn` unless a call is already in flight in `slot`, in which case the caller gets that same promise — so a
 * double-click, or Next and the save bar's Save in the same moment, can't start a second request. `slot` is usually
 * a React ref, so it survives re-renders. A new call starts once the previous one settled (success or failure).
 */
export function singleFlight<T>(slot: { current: Promise<T> | null }, fn: () => Promise<T>): Promise<T> {
  slot.current ??= fn().finally(() => {
    slot.current = null;
  });
  return slot.current;
}
