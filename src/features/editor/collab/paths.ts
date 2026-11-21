// Where a scene's realtime-collab socket lives. One helper per access
// path so the owner editor and share-token editors can't drift from the
// server's routes.

/** Owner route (session cookie): `/api/files/:id/collab`. */
export function ownerCollabPath(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/collab`;
}

export type ShareCollabTarget =
  | { kind: "file"; token: string }
  | { kind: "folder"; token: string; fileId: string };

/**
 * Share-token routes (no session):
 *   file share   → `/api/share/:token/collab`
 *   folder share → `/api/share/:token/files/:fileId/collab`
 */
export function collabPathForShare(target: ShareCollabTarget): string {
  const token = encodeURIComponent(target.token);
  if (target.kind === "file") return `/api/share/${token}/collab`;
  return `/api/share/${token}/files/${encodeURIComponent(target.fileId)}/collab`;
}
