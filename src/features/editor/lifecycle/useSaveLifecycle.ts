// Editor save lifecycle (React adapter).
//
// The behaviour lives in `SaveLoop` (debounce, coalescing loop, 409
// reload, discard/reset) so it can be tested without a DOM. This hook
// only wires it to React: status state, the live dep bag, and the
// beforeunload / visibilitychange / unmount flush listeners.
//
// The unmount flush is what saves edits when the user leaves through a
// browser Back (or any path that bypasses the header's leave dialog).
// `SaveLoop.dispose()` runs the pending debounced save before stopping,
// and `discardPendingLocalWork()` is the explicit way to drop it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SAVE_DEBOUNCE_MS, SaveLoop, type SaveLoopLive, type SaveSnapshot } from "./saveLoop";
import type { EditorSaveStatus } from "./types";

export type { SaveSnapshot };
export { SAVE_DEBOUNCE_MS };

export interface UseSaveLifecycleOptions<TBlob, TLoaded extends { meta: { version: number } }>
  extends Omit<SaveLoopLive<TBlob, TLoaded>, "onSaved" | "onReload"> {
  initialVersion: number;
  initialFingerprint: string;
  onSaved?: (saved: SaveSnapshot<TBlob>) => void;
  onReload?: (loaded: TLoaded, freshVersion: number) => void;
  debounceMs?: number;
}

export interface UseSaveLifecycleResult {
  status: EditorSaveStatus;
  errorMessage: string | null;
  isDirty: boolean;
  /** Tell the lifecycle that the editor pushed a fresh snapshot.
   *  Triggers dedup against `savedFp` and schedules the debounced
   *  save when content differs. */
  notifyChange: () => void;
  /** Cancel the debounce and force-save the current latest. Returns
   *  `true` on success (or read-only no-op), `false` if the save
   *  errored or hit a 409. */
  saveNow: () => Promise<boolean>;
  /** Discard pending local work (the dialog Discard branch). */
  discardPendingLocalWork: () => void;
  /** Reset state when the parent loads a different file (or the
   *  same file at a fresh version after an external reload). */
  reset: (newVersion: number, newFingerprint: string) => void;
}

export function useSaveLifecycle<TBlob, TLoaded extends { meta: { version: number } }>(
  opts: UseSaveLifecycleOptions<TBlob, TLoaded>,
): UseSaveLifecycleResult {
  const { initialVersion, initialFingerprint, debounceMs, ...live } = opts;
  // A freshly loaded scene matches the server by construction, so the
  // initial state is "saved", not "idle".
  const [status, setStatus] = useState<EditorSaveStatus>("saved");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loopRef = useRef<SaveLoop<TBlob, TLoaded> | null>(null);
  if (loopRef.current === null) {
    loopRef.current = new SaveLoop<TBlob, TLoaded>({
      initialVersion,
      initialFingerprint,
      debounceMs,
      onStatus: (next, error) => {
        setStatus(next);
        setErrorMsg(error);
      },
      live,
    });
  }
  const loop = loopRef.current;
  // Editors pass fresh closures every render; the loop always reads the
  // latest ones (the old hook did the same through refs).
  loop.live = live;

  const isDirty =
    !live.readOnly && (status === "dirty" || status === "saving" || status === "error");
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // ─── Browser unload guard + unmount flush ──────────────────────────
  useEffect(() => {
    loop.attach();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      loop.flush();
      if (isDirtyRef.current) {
        e.preventDefault();
        // Modern browsers ignore the string but require `returnValue`
        // to be set to anything to trigger their built-in prompt.
        e.returnValue = "";
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") loop.flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      loop.dispose();
    };
  }, [loop]);

  const notifyChange = useCallback(() => loop.notifyChange(), [loop]);
  const saveNow = useCallback(() => loop.saveNow(), [loop]);
  const discardPendingLocalWork = useCallback(() => loop.discard(), [loop]);
  const reset = useCallback(
    (newVersion: number, newFingerprint: string) => loop.reset(newVersion, newFingerprint),
    [loop],
  );

  return useMemo(
    () => ({
      status,
      errorMessage: errorMsg,
      isDirty,
      notifyChange,
      saveNow,
      discardPendingLocalWork,
      reset,
    }),
    [status, errorMsg, isDirty, notifyChange, saveNow, discardPendingLocalWork, reset],
  );
}
