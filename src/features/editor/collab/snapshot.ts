// Sizing for collab frames.
//
// A scene snapshot or a delta carries the whole image payload inline
// (base64) in one text frame, and the room's frame cap is 32 MiB (see
// AGENTS.md). Image-heavy boards can exceed it and the socket is closed
// (1009), which looks like a permanent disconnect. Payloads are measured
// in UTF-8 bytes — `String.length` counts UTF-16 code units, so non-ASCII
// labels (or base64 with multi-byte characters) would under-measure.

/** Stay under the 32 MiB frame cap with headroom for the JSON envelope. */
export const COLLAB_SNAPSHOT_SAFE_BYTES = 24 * 1024 * 1024;

const textEncoder = new TextEncoder();

/** JSON size of a message payload in UTF-8 bytes. */
export function jsonBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

export interface SnapshotPlan {
  /** Elements alone cannot fit one frame: send nothing and let the
   *  bounded delta path catch up instead of killing the socket. */
  skip: boolean;
  /** Whether the inline image payload fits the frame budget. */
  includeFiles: boolean;
  elementsBytes: number;
  filesBytes: number;
  limit: number;
}

export function planSnapshot(
  elements: readonly unknown[],
  files: Record<string, unknown>,
  limit: number = COLLAB_SNAPSHOT_SAFE_BYTES,
): SnapshotPlan {
  const elementsBytes = jsonBytes(elements);
  const filesBytes = jsonBytes(files);
  const skip = elementsBytes > limit;
  return {
    skip,
    includeFiles: !skip && elementsBytes + filesBytes <= limit,
    elementsBytes,
    filesBytes,
    limit,
  };
}

export interface FilesFramePlan<TFile> {
  /** Files that fit alongside `elementsBytes` in one frame. */
  files: Record<string, TFile>;
  filesBytes: number;
}

/**
 * Greedy pick of the not-yet-sent files that fit one frame. Files left
 * out are deliberately absent from the result: the caller must not mark
 * them as sent, so a later, smaller frame can still deliver them.
 */
export function pickFilesForFrame<TFile>(
  pendingFiles: Record<string, TFile>,
  elementsBytes: number,
  limit: number = COLLAB_SNAPSHOT_SAFE_BYTES,
): FilesFramePlan<TFile> {
  const files: Record<string, TFile> = {};
  let filesBytes = 0;
  for (const [id, file] of Object.entries(pendingFiles)) {
    const size = jsonBytes(file);
    if (elementsBytes + filesBytes + size > limit) continue;
    files[id] = file;
    filesBytes += size;
  }
  return { files, filesBytes };
}
