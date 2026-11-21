// Lifecycle-internal debounce.
//
// Lived in `src/hooks/useDebounced.ts` as a "general utility" until the
// save lifecycle stopped needing it; the editor's thumbnail-export
// pipeline (`DrawioEditor`) is now the only consumer. Kept here so the
// shared-lifecycle surface stays self-contained.

import { useMemo, useRef } from "react";

/**
 * Returns a stable function that invokes `fn` with the latest arguments
 * after `delay`ms of inactivity. The wrapped function exposes
 * `flush()` to invoke immediately and `cancel()` to drop the pending
 * call. Latest closure of `fn` is always used, so the consumer doesn't
 * need to memoize it.
 */
export function useDebounced<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): { (...args: A): void; flush(): void; cancel(): void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<number | null>(null);
  const lastArgs = useRef<A | null>(null);

  const wrapped = useMemo(() => {
    const cancel = () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      // Drop any pending args so a later `flush()` (a subsequent
      // `beforeunload`, or the caller's own unmount flush) can't
      // resurrect a call the caller has explicitly cancelled. Without
      // this, clicking "Discard" in the leave dialog still persists
      // the discarded edits.
      lastArgs.current = null;
    };
    const flush = () => {
      if (lastArgs.current) {
        const args = lastArgs.current;
        lastArgs.current = null;
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        fnRef.current(...args);
      }
    };
    const debounced = (...args: A) => {
      lastArgs.current = args;
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const a = lastArgs.current;
        lastArgs.current = null;
        if (a) fnRef.current(...a);
      }, delay);
    };
    return Object.assign(debounced, { flush, cancel });
  }, [delay]);

  // No cancel-on-unmount: a later `flush()` (the caller's unmount
  // cleanup, or a beforeunload) must still be able to run the pending
  // call — that is what saves edits when the user navigates away
  // outside the leave dialog. Callers that mean to drop the work call
  // `cancel()` explicitly (e.g. "Discard").

  return wrapped;
}
