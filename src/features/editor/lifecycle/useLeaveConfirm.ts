// In-app navigation guard: surfaces a Stay / Discard / Save & Leave
// dialog when the user tries to leave the editor while the save
// lifecycle is dirty.
//
// `<BrowserRouter>` (rather than the data router) means `useBlocker`
// isn't available, so we cover both in-app exits:
//   • the back button / ⌘K route, which call `requestLeave(cont)` with
//     their own continuation;
//   • browser Back, which we catch on `popstate`: the browser has already
//     moved and the router has followed it, so we move back to the editor
//     **through the router** and let the dialog decide. A raw
//     `history.pushState` would leave the router on the destination, which
//     unmounts the editor and never shows the dialog.
// Tab close / hard reload still use the native `beforeunload` prompt.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export type LeaveBusyState = false | "save";

export interface UseLeaveConfirmOptions {
  isDirty: boolean;
  saveNow: () => Promise<boolean>;
  discardPendingLocalWork: () => void;
  /** Save lifecycle error, surfaced after a failed Save & Leave attempt. */
  errorMessage?: string | null;
}

export interface UseLeaveConfirmResult {
  open: boolean;
  busy: LeaveBusyState;
  /** Editor calls this from its back-button handler. If clean,
   *  `cont()` runs immediately; otherwise the dialog opens with the
   *  continuation queued. */
  requestLeave: (cont: () => void) => void;
  /** Bound to the dialog's onOpenChange — closes if not in flight. */
  onOpenChange: (open: boolean) => void;
  /** Stay button (alias for onOpenChange(false)). */
  cancel: () => void;
  /** Discard button: drop pending edits and run the queued continuation. */
  discard: () => void;
  /** Save & Leave button: persist, then run the queued continuation
   *  (or stay open if the save errored). */
  saveAndLeave: () => Promise<void>;
  /** Why the last Save & Leave attempt failed; null while there is none. */
  errorMessage: string | null;
}

export function useLeaveConfirm(opts: UseLeaveConfirmOptions): UseLeaveConfirmResult {
  const { isDirty, saveNow, discardPendingLocalWork, errorMessage } = opts;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<LeaveBusyState>(false);
  // Set only after a failed Save & Leave: the lifecycle's own error text is
  // read live from props on the next render, so a stale closure can't win.
  const [saveFailed, setSaveFailed] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);

  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const requestLeave = useCallback((cont: () => void) => {
    if (!dirtyRef.current) {
      cont();
      return;
    }
    pendingRef.current = cont;
    setSaveFailed(false);
    setOpen(true);
  }, []);

  const cancel = useCallback(() => {
    if (busyRef.current) return;
    pendingRef.current = null;
    setSaveFailed(false);
    setOpen(false);
  }, []);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) cancel();
    },
    [cancel],
  );

  const discard = useCallback(() => {
    discardPendingLocalWork();
    setBusy(false);
    setSaveFailed(false);
    setOpen(false);
    const cont = pendingRef.current;
    pendingRef.current = null;
    cont?.();
  }, [discardPendingLocalWork]);

  const saveAndLeave = useCallback(async () => {
    setBusy("save");
    setSaveFailed(false);
    const ok = await saveNow();
    if (!ok) {
      // Save failed — leave the dialog open so the user can pick another
      // action, and show why.
      setSaveFailed(true);
      setBusy(false);
      return;
    }
    setBusy(false);
    setOpen(false);
    const cont = pendingRef.current;
    pendingRef.current = null;
    cont?.();
  }, [saveNow]);

  // ─── Browser Back guard ────────────────────────────────────────────
  // The editor's URL and history index, captured while we are on it
  // (after a popstate, `window.location` is already the destination).
  // Cross-document entries never fire a popstate here — the document is
  // unloaded instead — so every destination is same-origin and its path
  // identifies it; no origin has to be reconstructed.
  const hereRef = useRef<{ url: string; idx: number | null } | null>(null);
  // URL a pending `history.go(-1)` of ours is expected to land on; that
  // popstate must not open the dialog a second time.
  const expectedPopRef = useRef<string | null>(null);

  useEffect(() => {
    const state = window.history.state as { idx?: unknown } | null;
    hereRef.current = {
      url: window.location.pathname + window.location.search + window.location.hash,
      idx: typeof state?.idx === "number" ? state.idx : null,
    };
  });

  useEffect(() => {
    const urlNow = () => window.location.pathname + window.location.search + window.location.hash;

    const onPopState = () => {
      const here = hereRef.current;
      if (!here) return;
      const dest = urlNow();
      const expected = expectedPopRef.current;
      expectedPopRef.current = null;
      if (expected === dest) return; // our own step back to the destination

      if (!dirtyRef.current) return; // clean: let the navigation through
      if (dest === here.url) return;

      const state = window.history.state as { idx?: unknown } | null;
      const destIdx = typeof state?.idx === "number" ? state.idx : null;
      const delta = here.idx !== null && destIdx !== null ? here.idx - destIdx : null;

      // Re-enter the editor entry through the router, synchronously: the
      // router would otherwise render the destination on its next commit
      // and unmount this dialog. `navigate` (push) truncates the forward
      // entry, which after a Back is this same editor URL, so the history
      // stack ends up unchanged — Stay does not trap the user and the
      // destination survives. The continuation steps back onto it.
      navigate(here.url);
      requestLeave(() => {
        if (delta !== null && delta > 0) {
          // Back: retrace exactly one entry, no URL rebuild.
          expectedPopRef.current = dest;
          navigate(-1);
          return;
        }
        // Forward / no index: replace, so the destination is not pushed
        // twice. (A forward popstate while dirty is rare: it needs a
        // Forward into the editor after an earlier Back.)
        navigate(dest, { replace: true });
      });
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [navigate, requestLeave]);

  return {
    open,
    busy,
    requestLeave,
    onOpenChange,
    cancel,
    discard,
    saveAndLeave,
    errorMessage: saveFailed
      ? (errorMessage ?? "Could not save. Try again, or discard your changes.")
      : null,
  };
}
