// Sizing for the collab full-scene snapshot.
//
// A snapshot carries the whole scene plus every image inline (base64) in
// one text frame, and the room's frame cap is 32 MiB (see AGENTS.md).
// Image-heavy boards can exceed it and the socket is closed (1009), which
// looks like a permanent disconnect. The client measures the payload and
// drops the inline images when it would not fit.

/** Stay under the 32 MiB frame cap with headroom for the JSON envelope. */
export const COLLAB_SNAPSHOT_SAFE_BYTES = 24 * 1024 * 1024;

export interface SnapshotPlan {
  /** Whether the inline image payload fits the frame budget. */
  includeFiles: boolean;
  /** Measured JSON size of the elements + files payload. */
  bytes: number;
  limit: number;
}

export function planSnapshot(
  elements: readonly unknown[],
  files: Record<string, unknown>,
  limit: number = COLLAB_SNAPSHOT_SAFE_BYTES,
): SnapshotPlan {
  const bytes = JSON.stringify(elements).length + JSON.stringify(files).length;
  return { includeFiles: bytes <= limit, bytes, limit };
}
