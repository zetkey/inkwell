// Pure scene maths for realtime collaboration.
//
// The transport lives in `useCollab`; everything here is testable
// without a socket, a DOM, or a mounted Excalidraw:
//
//   • `elementStamp` / `changedElements` — which elements a client must
//     ship as a delta (version triple + a content signature, because a
//     remote peer can reuse our version numbers but not our geometry).
//   • `mergeRemoteElements` — remote scene onto the local one, using
//     Excalidraw's own `reconcileElements` so "element I'm editing
//     wins", version wins, and equal-version ties are broken by the
//     lowest versionNonce exactly as Excalidraw's native collab does.
//   • `applyOrder` — the sender's z-order, with local elements the
//     message didn't mention appended (not dropped).

import { reconcileElements } from "@excalidraw/excalidraw";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

// Geometry/content fields that change without necessarily bumping
// `version` (restore, import, programmatic mutation). Comparing them
// keeps a delta from silently missing an edit.
const SIGNATURE_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "angle",
  "points",
  "text",
  "fileId",
  "isDeleted",
] as const;

export function elementSignature(element: ExcalidrawElement): string {
  const raw = element as unknown as Record<string, unknown>;
  return SIGNATURE_FIELDS.map((key) => JSON.stringify(raw[key] ?? null)).join("|");
}

/** Everything that changes when the element is meaningfully edited. */
export function elementStamp(element: ExcalidrawElement): string {
  return `${element.version}|${element.versionNonce}|${element.updated}|${elementSignature(element)}`;
}

export function stampElements(elements: readonly ExcalidrawElement[]): Map<string, string> {
  return new Map(elements.map((element) => [element.id, elementStamp(element)]));
}

export function isElementChanged(
  before: ExcalidrawElement | undefined,
  after: ExcalidrawElement,
): boolean {
  return !before || elementStamp(before) !== elementStamp(after);
}

/**
 * Elements whose stamp differs from `known` — new elements included.
 * Deletions travel as `isDeleted: true` elements (Excalidraw keeps
 * tombstones), so nothing is inferred from a missing id.
 */
export function changedElements(
  known: ReadonlyMap<string, string>,
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  return elements.filter((element) => known.get(element.id) !== elementStamp(element));
}

export function orderOf(elements: readonly { id: string }[]): string[] {
  return elements.map((element) => element.id);
}

export function orderChanged(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) return true;
  }
  return false;
}

/**
 * Reorder `elements` to match `order`. Ids in `order` that no longer
 * exist are skipped; elements `order` didn't mention keep their relative
 * order and are appended (a delta sender only ships the ids it knows).
 *
 * No order in the message → leave the incoming order untouched, since
 * `reconcileElements` already ordered by fractional index.
 */
export function applyOrder<T extends { id: string }>(
  elements: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order || order.length === 0) return [...elements];
  const byId = new Map(elements.map((element) => [element.id, element]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of order) {
    const element = byId.get(id);
    if (!element || seen.has(id)) continue;
    ordered.push(element);
    seen.add(id);
  }
  for (const element of elements) {
    if (!seen.has(element.id)) ordered.push(element);
  }
  return ordered;
}

/**
 * Remote scene onto the local one. Delegates the conflict rules to
 * Excalidraw (`reconcileElements`): newest version wins, equal versions
 * resolve by lowest `versionNonce`, and the element the local user is
 * currently editing/resizing always survives.
 */
export function mergeRemoteElements(
  local: readonly ExcalidrawElement[],
  remote: readonly ExcalidrawElement[],
  localAppState: AppState,
  order?: readonly string[],
): ExcalidrawElement[] {
  const reconciled = reconcileElements(
    local as unknown as readonly OrderedExcalidrawElement[],
    remote as unknown as readonly RemoteExcalidrawElement[],
    localAppState,
  ) as readonly ExcalidrawElement[];
  return applyOrder(reconciled, order);
}
