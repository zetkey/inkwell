// In-app navigation guard: surfaces a Stay / Discard / Save & Leave
// dialog when the user tries to leave the editor while the save
// lifecycle is dirty.
//
// `<BrowserRouter>` (rather than the data router) means `useBlocker`
// isn't available, so we cover both in-app exits:
//   • the back button / ⌘K route, which call `requestLeave(cont)` with
//     their own continuation;
//   • browser Back, which we catch on `popstate`: the browser has
//     already moved, so we push the editor entry back (URL + router
//     state) and let the dialog decide. The queued continuation then
//     performs the navigation the user asked for.
// Tab close / hard reload still use the native `beforeunload` prompt.

import { useCallback, useEffect, useRef, useState } from "react";

export type LeaveBusyState = false | "save";

export interface UseLeaveConfirmOptions {
  isDirty: boolean;
  saveNow: () => Promise<boolean>;
  discardPendingLocalWork: () => void;
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
}

export function useLeaveConfirm(opts: UseLeaveConfirmOptions): UseLeaveConfirmResult {
  const { isDirty, saveNow, discardPendingLocalWork } = opts;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<LeaveBusyState>(false);
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
    setOpen(true);
  }, []);

  const cancel = useCallback(() => {
    if (busyRef.current) return;
    pendingRef.current = null;
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
    setOpen(false);
    const cont = pendingRef.current;
    pendingRef.current = null;
    cont?.();
  }, [discardPendingLocalWork]);

  const saveAndLeave = useCallback(async () => {
    setBusy("save");
    const ok = await saveNow();
    if (!ok) {
      // Save failed — leave the dialog open so the user can pick
      // another action (Stay / Discard).
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
  // The editor entry's URL + history state, captured while we're on it
  // (after a popstate `window.location` is already the destination).
  const hereRef = useRef<{ url: string; state: unknown } | null>(null);
  // Destination we asked `history.back()` to reach; the popstate it
  // causes must not open the dialog a second time.
  const expectedDestRef = useRef<string | null>(null);
  const lastUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const url = window.location.pathname + window.location.search + window.location.hash;
    // Only a real location change drops an expected destination: the
    // dialog closing re-renders while the continuation's popstate is
    // still on its way, and clearing it there would re-arm the guard.
    if (lastUrlRef.current !== url) {
      lastUrlRef.current = url;
      expectedDestRef.current = null;
    }
    hereRef.current = { url, state: window.history.state };
  });

  useEffect(() => {
    const onPopState = () => {
      const here = hereRef.current;
      if (!here || !dirtyRef.current || busyRef.current) return;
      const dest = window.location.pathname + window.location.search + window.location.hash;
      if (dest === here.url) return;
      if (expectedDestRef.current === dest) {
        // This is the navigation the dialog's continuation asked for.
        expectedDestRef.current = null;
        return;
      }
      // Put the editor entry back (the router reads `window.location`
      // live, so this keeps it on the editor) and let the dialog drive
      // the real navigation afterwards. Idempotent: a second Back
      // restores the same two entries.
      window.history.pushState(here.state, "", here.url);
      requestLeave(() => {
        expectedDestRef.current = dest;
        window.history.back();
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [requestLeave]);

  return { open, busy, requestLeave, onOpenChange, cancel, discard, saveAndLeave };
}
