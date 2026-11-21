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
  // The editor's URL, captured while we are on it (after a popstate,
  // `window.location` is already the destination).
  const hereUrlRef = useRef<string | null>(null);
  useEffect(() => {
    hereUrlRef.current = window.location.pathname + window.location.search + window.location.hash;
  });

  useEffect(() => {
    const onPopState = () => {
      const here = hereUrlRef.current;
      if (!here || !dirtyRef.current || busyRef.current) return;
      const dest = window.location.pathname + window.location.search + window.location.hash;
      if (dest === here) return;
      // Restore the editor in the router so it stays mounted and the dialog
      // can decide. `replace` keeps the history length unchanged; the
      // continuation replaces the pending destination instead of pushing a
      // second entry, so leaving does not grow the back stack.
      navigate(here, { replace: true });
      requestLeave(() => navigate(dest, { replace: true }));
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
