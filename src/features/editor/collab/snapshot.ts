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

/** One frame of a batched scene snapshot (see `batchElements`). */
export const COLLAB_SNAPSHOT_BATCH_BYTES = 8 * 1024 * 1024;

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

export interface DeltaPlan<TFile> {
  /** Changed elements alone exceed one frame: send nothing and keep the
   *  pending scene so a later, smaller change can carry the diff. */
  skip: boolean;
  elementsBytes: number;
  /** The not-yet-sent files that fit beside the elements. */
  files: Record<string, TFile>;
  filesBytes: number;
  limit: number;
}

export function planDelta<TFile>(
  changed: readonly unknown[],
  pendingFiles: Record<string, TFile>,
  limit: number = COLLAB_SNAPSHOT_SAFE_BYTES,
): DeltaPlan<TFile> {
  const elementsBytes = jsonBytes(changed);
  if (elementsBytes > limit) {
    return { skip: true, elementsBytes, files: {}, filesBytes: 0, limit };
  }
  const picked = pickFilesForFrame(pendingFiles, elementsBytes, limit);
  return {
    skip: false,
    elementsBytes,
    files: picked.files,
    filesBytes: picked.filesBytes,
    limit,
  };
}

/**
 * Split a scene into frames that each stay under `limit`. A single element
 * that cannot fit a frame on its own is dropped: one oversized paste must
 * not close the socket for everyone. Ordering is preserved.
 */
export function batchElements<T>(
  elements: readonly T[],
  limit: number = COLLAB_SNAPSHOT_BATCH_BYTES,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 2; // "[]"
  for (const element of elements) {
    const size = jsonBytes(element) + 1;
    if (size > limit) continue;
    if (current.length > 0 && bytes + size > limit) {
      batches.push(current);
      current = [];
      bytes = 2;
    }
    current.push(element);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
