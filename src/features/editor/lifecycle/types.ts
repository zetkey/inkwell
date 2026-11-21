// Public types for the editor save lifecycle.
//
// `EditorSaveStatus` mirrors the values the topbar / Drawio status
// control branches on; both editors must agree on these names.

export type EditorSaveStatus = "dirty" | "saving" | "saved" | "error";

/**
 * Transport interface the lifecycle calls into. The editor wires this
 * to its specific persistence client (owner `files.save`, share-token
 * `shares.save`, etc.).
 *
 * There is deliberately no `reload` here: a 409 pauses saves and the
 * page's conflict banner performs the explicit re-fetch, so the hook
 * never replaces the canvas behind the user's back.
 */
export interface SaveLifecycleTransport<TBlob> {
  /** Persist the blob. Throw `ApiError(409)` on optimistic-concurrency conflict. */
  save: (version: number, blob: TBlob) => Promise<{ version: number }>;
}
