// Editor save lifecycle.
//
// Owns the autosave loop both `ExcalidrawEditor` and `DrawioEditor`
// historically reimplemented:
//
//   * `versionRef` (the optimistic-concurrency token sent as `If-Match`)
//   * `inflightRef` / `savePromiseRef` — concurrency model so a save in
//     flight coalesces with newer changes rather than racing
//   * `savedFpRef` — fingerprint of the last successfully persisted
//     content, used to dedup no-op saves
//   * The 2.5s/15s-max `useDebounced` wrapper around the loop, plus `saveNow`
//     / `discardPendingLocalWork`
//   * The `beforeunload` (with `e.returnValue = ""` while dirty) +
//     `visibilitychange` flush listeners
//   * Resetting state when the parent loads a different file, or the same
//     file at a fresh version after an explicit conflict reload.
//
// A 409 never reloads on its own: it raises `onConflict` and leaves the
// local edits dirty so the page's conflict banner can ask the user.
//
// The hook is transport- and snapshot-agnostic: the editor passes a
// `getLatest()` closure that returns its current snapshot fingerprint
// + serialised blob, plus a `transport` that knows how to PUT the
// blob and re-fetch on conflict.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { errorMessage } from "@/lib/errors";
import type { EditorSaveStatus, SaveLifecycleTransport } from "./types";
import { useDebounced } from "./useDebounced";

// Autosave timing. 2.5s of idle time after the last change batches a
// burst of edits (typing, dragging) into one PUT while keeping the
// window for data loss short; the 15s max-wait guarantees a save even
// during continuous activity (e.g. a long drawing stroke session).
// Each save bumps the file version and fires a thumbnail upload, so we
// stay well above "per keystroke". Ctrl/⌘+S saves immediately.
export const SAVE_DEBOUNCE_MS = 2_500;
export const SAVE_MAX_WAIT_MS = 15_000;

/** True for the status message set after a 409 → reload. */
export function isConflictMessage(msg: string | null): boolean {
  return !!msg && /^(Refreshed:|Conflict)/.test(msg);
}

/**
 * Snapshot returned by `getLatest()`. The fingerprint is a cheap
 * content hash the editor computes; the blob is whatever the
 * transport's `save` accepts.
 */
export interface SaveSnapshot<TBlob> {
  fp: string;
  blob: TBlob;
}

export interface UseSaveLifecycleOptions<TBlob> {
  initialVersion: number;
  initialFingerprint: string;
  /** Read-only sessions (share-token reads) skip the entire save path. */
  readOnly: boolean;
  transport: SaveLifecycleTransport<TBlob>;
  /** Returns the latest in-memory snapshot to persist, or null if there
   *  is nothing pending. Called on every save attempt; the editor
   *  closes over its mutable snapshot ref. */
  getLatest: () => SaveSnapshot<TBlob> | null;
  /** Fired after each successful save with the snapshot that was
   *  written. Editors use this to schedule a thumbnail upload. */
  onSaved?: (saved: SaveSnapshot<TBlob>) => void;
  /** Fired when a save hits 409. The page opens its conflict banner and
   *  re-fetches on demand; the hook keeps the local edits dirty and never
   *  auto-reloads (a silent reload would throw the user's pending work
   *  away). */
  onConflict?: () => void;
  debounceMs?: number;
  maxWaitMs?: number;
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

export function useSaveLifecycle<TBlob>(
  opts: UseSaveLifecycleOptions<TBlob>,
): UseSaveLifecycleResult {
  const {
    initialVersion,
    initialFingerprint,
    readOnly,
    transport,
    getLatest,
    onSaved,
    onConflict,
    debounceMs = SAVE_DEBOUNCE_MS,
    maxWaitMs = SAVE_MAX_WAIT_MS,
  } = opts;

  // A freshly loaded scene matches the server by construction, so the
  // initial state is "saved", not "idle". Anything else surfaces a
  // misleading "Ready" indicator on first paint.
  const [status, setStatus] = useState<EditorSaveStatus>("saved");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Mutable refs so the debounced loop always sees the latest values
  // without re-creating itself.
  const versionRef = useRef(initialVersion);
  const savedFpRef = useRef(initialFingerprint);
  const inflightRef = useRef(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);

  // Capture the latest closures via refs so the inner loop's
  // dependency list stays small and the saveLatest callback is stable.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const getLatestRef = useRef(getLatest);
  getLatestRef.current = getLatest;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onConflictRef = useRef(onConflict);
  onConflictRef.current = onConflict;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // Set on 409. While paused, changes never schedule a PUT and `saveNow`
  // only re-surfaces the conflict; the user must Reload (reset) or
  // Discard to leave this state. Clearing it on anything else would turn
  // every later autosave into another doomed PUT.
  const conflictPausedRef = useRef(false);

  // ─── The save loop ──────────────────────────────────────────────────
  const saveLatest = useCallback(async (): Promise<boolean> => {
    if (readOnlyRef.current) return true;

    // Coalesce: if a save is already in flight, return its promise. The
    // running loop reads `latest` again on its next iteration, so a newer
    // snapshot pushed meanwhile still gets persisted.
    if (inflightRef.current) {
      return savePromiseRef.current ?? Promise.resolve(false);
    }

    const task = (async (): Promise<boolean> => {
      inflightRef.current = true;
      try {
        while (true) {
          const snapshot = getLatestRef.current();
          if (!snapshot || snapshot.fp === savedFpRef.current) {
            setStatus("saved");
            setErrorMsg(null);
            return true;
          }

          setStatus("saving");
          setErrorMsg(null);

          try {
            const res = await transportRef.current.save(versionRef.current, snapshot.blob);
            versionRef.current = res.version;
            savedFpRef.current = snapshot.fp;
            // Success: notify the editor (it may want to fire a thumb).
            // Fire-and-forget; thumb-pipeline-side dedup short-circuits
            // a no-op upload.
            try {
              onSavedRef.current?.(snapshot);
            } catch {
              // Don't let an onSaved error cancel further save laps.
            }
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
              // Never auto-reload here: the server copy would replace the
              // canvas and throw the user's pending work away. Pause all
              // further attempts; only the page's banner can Reload
              // (reset) or Discard.
              conflictPausedRef.current = true;
              onConflictRef.current?.();
              setStatus("error");
              setErrorMsg(
                "Conflict: another tab saved a newer version. Your edits are unsaved; reload to discard them, or keep editing.",
              );
            } else {
              setStatus("error");
              setErrorMsg(errorMessage(e, "save failed"));
            }
            return false;
          }

          // Lap done. If the latest snapshot already matches what we
          // just wrote, exit cleanly. Otherwise loop and persist the
          // newer snapshot too (a change came in mid-flight).
          const next = getLatestRef.current();
          if (!next || next.fp === savedFpRef.current) {
            setStatus("saved");
            setErrorMsg(null);
            return true;
          }
        }
      } finally {
        inflightRef.current = false;
        savePromiseRef.current = null;
      }
    })();

    savePromiseRef.current = task;
    return task;
  }, []);

  const debouncedSave = useDebounced(
    () => {
      void saveLatest();
    },
    debounceMs,
    maxWaitMs,
  );

  // ─── Public API ────────────────────────────────────────────────────
  const notifyChange = useCallback(() => {
    if (readOnlyRef.current) return;
    // Paused after a conflict: never schedule another doomed PUT.
    if (conflictPausedRef.current) return;
    const snapshot = getLatestRef.current();
    if (!snapshot) return;

    // Cheap dedup: if the current snapshot matches the last persisted
    // content, drop the change. Without this, the editor's onChange
    // (which fires on cursor / selection / zoom / pan ticks for
    // Excalidraw, or on every drawio autosave reply) would queue a
    // save every few seconds of canvas activity even when the user isn't
    // editing.
    if (snapshot.fp === savedFpRef.current) {
      if (!inflightRef.current) {
        debouncedSave.cancel();
        setStatus("saved");
        setErrorMsg(null);
      }
      return;
    }

    setStatus((s) => (s === "saving" ? s : "dirty"));
    setErrorMsg(null);
    debouncedSave();
  }, [debouncedSave]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (readOnlyRef.current) return true;
    debouncedSave.cancel();
    if (conflictPausedRef.current) {
      // Explicit save (⌘S) while paused: no PUT, just bring the banner
      // back so the user can Reload (discard) or keep editing.
      onConflictRef.current?.();
      return false;
    }
    return saveLatest();
  }, [debouncedSave, saveLatest]);

  // Cancels pending work only: an already in-flight PUT cannot be aborted
  // and will still land on the server. Callers that need that guarantee
  // must block the leave until `saveNow()` resolves. Discard is also the
  // escape hatch from a conflict pause.
  const discardPendingLocalWork = useCallback(() => {
    debouncedSave.cancel();
    conflictPausedRef.current = false;
    if (!inflightRef.current) {
      setStatus("saved");
      setErrorMsg(null);
    }
  }, [debouncedSave]);

  const reset = useCallback(
    (newVersion: number, newFingerprint: string) => {
      versionRef.current = newVersion;
      savedFpRef.current = newFingerprint;
      conflictPausedRef.current = false;
      savePromiseRef.current = null;
      debouncedSave.cancel();
      setStatus("saved");
      setErrorMsg(null);
    },
    [debouncedSave],
  );

  // ─── Browser unload guard ──────────────────────────────────────────
  // Live-ref the dirty flag so the listener doesn't re-bind on every
  // status tick. A conflict (`error`) is *dirty*: the hook no longer
  // auto-reloads, so the local edits are still unsaved until the user
  // takes the banner's Reload or Discard.
  const isDirty = !readOnly && (status === "dirty" || status === "saving" || status === "error");
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      debouncedSave.flush();
      if (isDirtyRef.current) {
        e.preventDefault();
        // Modern browsers ignore the string but require `returnValue`
        // to be set to anything to trigger their built-in prompt.
        e.returnValue = "";
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") debouncedSave.flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      debouncedSave.flush();
    };
  }, [debouncedSave]);

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
