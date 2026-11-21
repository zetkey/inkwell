// Pure collab gating decisions, kept out of the hooks so they can be
// tested without a socket.
//
// A share link's `write` permission is editable but has no collab
// route; opening the socket anyway falls back to the owner path and
// 401-loops (and leaks realtime to a logged-in owner). Only `collab`
// links — and the owner editor — get a socket.

export type SharePermission = "read" | "write" | "collab";
export type CollabAccess = SharePermission | "owner";

/** Failed connects in a row, never having opened, before we stop. */
export const COLLAB_MAX_CONSECUTIVE_FAILURES = 3;

/** Owner editors and `collab` share links open the realtime socket. */
export function shouldOpenCollab(access: CollabAccess): boolean {
  return access === "owner" || access === "collab";
}

/**
 * Retry policy for the socket. A connect that never opened is most
 * likely an auth/permission answer (401/403), so give up after a few;
 * once a socket has opened, transient drops keep reconnecting.
 */
export function shouldRetryConnect(consecutiveFailures: number, everOpened: boolean): boolean {
  return everOpened || consecutiveFailures < COLLAB_MAX_CONSECUTIVE_FAILURES;
}
