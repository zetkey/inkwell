import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import { describe, expect, it, vi } from "vitest";

// The real package is the whole Excalidraw app and touches `document` at
// module scope, which the node test environment cannot satisfy. This mock
// ports `reconcileElements`' conflict rules from the installed bundle
// (dist/dev/data/reconcile): the locally editing/resizing element survives,
// newest `version` wins, equal versions resolve to the lowest `versionNonce`.
vi.mock("@excalidraw/excalidraw", () => ({
  reconcileElements: (
    local: readonly ExcalidrawElement[],
    remote: readonly ExcalidrawElement[],
    localAppState: AppState,
  ) => {
    const localById = new Map(local.map((element) => [element.id, element]));
    const merged: ExcalidrawElement[] = [];
    const seen = new Set<string>();
    for (const remoteElement of remote) {
      if (seen.has(remoteElement.id)) continue;
      const localElement = localById.get(remoteElement.id);
      const discardRemote =
        localElement !== undefined &&
        (localElement.id === localAppState.editingTextElement?.id ||
          localElement.id === localAppState.resizingElement?.id ||
          localElement.version > remoteElement.version ||
          (localElement.version === remoteElement.version &&
            localElement.versionNonce < remoteElement.versionNonce));
      merged.push(discardRemote && localElement ? localElement : remoteElement);
      seen.add(remoteElement.id);
    }
    for (const localElement of local) {
      if (!seen.has(localElement.id)) merged.push(localElement);
    }
    return merged;
  },
}));

import {
  applyOrder,
  changedElements,
  elementStamp,
  mergeRemoteElements,
  orderChanged,
  orderOf,
  stampElements,
} from "./merge";

// Minimal element satisfying what the diff/merge code reads. Cast at the
// boundary so the fixture stays readable.
function el(overrides: Partial<ExcalidrawElement> & { id: string }): ExcalidrawElement {
  return {
    type: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: "a0",
    ...overrides,
  } as ExcalidrawElement;
}

const appState = (overrides: Partial<AppState> = {}): AppState =>
  ({ editingTextElement: null, resizingElement: null, ...overrides }) as AppState;

describe("change detection", () => {
  it("treats an element as changed when only geometry moves", () => {
    const before = el({ id: "a" });
    const after = el({ id: "a", x: 42 });
    expect(elementStamp(before)).not.toBe(elementStamp(after));
  });

  it("treats a version bump as a change", () => {
    const before = el({ id: "a" });
    const after = el({ id: "a", version: 2 });
    expect(elementStamp(before)).not.toBe(elementStamp(after));
  });

  it("returns only changed and brand-new elements", () => {
    const known = stampElements([el({ id: "a" }), el({ id: "b" })]);
    const changed = changedElements(known, [
      el({ id: "a" }),
      el({ id: "b", version: 2 }),
      el({ id: "c" }),
    ]);
    expect(changed.map((element) => element.id)).toEqual(["b", "c"]);
  });

  it("treats a deletion as a change", () => {
    const known = stampElements([el({ id: "a" })]);
    expect(changedElements(known, [el({ id: "a", isDeleted: true })])).toHaveLength(1);
  });
});

describe("mergeRemoteElements", () => {
  it("takes the remote element when its version is newer", () => {
    const local = el({ id: "a", version: 2, x: 0 });
    const remote = el({ id: "a", version: 3, x: 50 });
    const merged = mergeRemoteElements([local], [remote], appState());
    expect(merged.find((element) => element.id === "a")?.x).toBe(50);
  });

  it("keeps the local element when it is newer", () => {
    const local = el({ id: "a", version: 4, x: 7 });
    const remote = el({ id: "a", version: 3, x: 50 });
    const merged = mergeRemoteElements([local], [remote], appState());
    expect(merged.find((element) => element.id === "a")?.x).toBe(7);
  });

  it("breaks equal-version ties by the lowest versionNonce", () => {
    const localLow = el({ id: "a", version: 2, versionNonce: 5, x: 1 });
    const remoteHigh = el({ id: "a", version: 2, versionNonce: 9, x: 2 });
    expect(
      mergeRemoteElements([localLow], [remoteHigh], appState()).find((e) => e.id === "a")?.x,
    ).toBe(1);

    const localHigh = el({ id: "a", version: 2, versionNonce: 9, x: 1 });
    const remoteLow = el({ id: "a", version: 2, versionNonce: 5, x: 2 });
    expect(
      mergeRemoteElements([localHigh], [remoteLow], appState()).find((e) => e.id === "a")?.x,
    ).toBe(2);
  });

  it("keeps the element the local user is editing", () => {
    const local = el({ id: "a", version: 1, x: 0 });
    const remote = el({ id: "a", version: 9, x: 99 });
    const merged = mergeRemoteElements(
      [local],
      [remote],
      appState({ editingTextElement: local } as Partial<AppState>),
    );
    expect(merged.find((element) => element.id === "a")?.x).toBe(0);
  });

  it("adds remote-only elements and keeps local-only ones", () => {
    const merged = mergeRemoteElements([el({ id: "local" })], [el({ id: "remote" })], appState());
    expect(merged.map((element) => element.id).sort()).toEqual(["local", "remote"]);
  });
});

describe("order", () => {
  it("detects an order change", () => {
    expect(orderChanged(["a", "b"], ["a", "b"])).toBe(false);
    expect(orderChanged(["a", "b"], ["b", "a"])).toBe(true);
    expect(orderChanged(["a"], ["a", "b"])).toBe(true);
    expect(orderOf([{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
  });

  it("applies the sender's order and appends unmentioned locals", () => {
    const ordered = applyOrder([{ id: "a" }, { id: "b" }, { id: "local" }], ["b", "a", "missing"]);
    expect(ordered.map((element) => element.id)).toEqual(["b", "a", "local"]);
  });

  it("leaves the incoming order alone when no order was sent", () => {
    const ordered = applyOrder([{ id: "b" }, { id: "a" }], undefined);
    expect(ordered.map((element) => element.id)).toEqual(["b", "a"]);
  });

  it("applies the remote order after reconciling", () => {
    const merged = mergeRemoteElements(
      [el({ id: "a" }), el({ id: "b" }), el({ id: "local" })],
      [el({ id: "a", version: 2 })],
      appState(),
      ["b", "a"],
    );
    expect(merged.map((element) => element.id)).toEqual(["b", "a", "local"]);
  });
});
