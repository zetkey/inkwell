// @vitest-environment jsdom
//
// The save target must survive the two things that happen before the
// editor's unmount flush: the route page re-rendering with `loaded = null`
// (its loading state) and the page's own cleanup running first.

import { act, createElement as h, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useSaveLifecycle } from "./lifecycle/useSaveLifecycle";
import { lastLoadedId, saveTarget } from "./saveTarget";

interface Loaded {
  meta: { id: string; version: number };
}

interface SaveCall {
  target: string;
  version: number;
}

/** Mirrors the pages' target handling and the real save lifecycle. */
function Page({ loaded, saves }: { loaded: Loaded | null; saves: SaveCall[] }) {
  const targetRef = useRef<string | null>(null);
  targetRef.current = lastLoadedId(targetRef.current, loaded);

  const lifecycle = useSaveLifecycle<string, Loaded>({
    initialVersion: 1,
    initialFingerprint: "seed",
    readOnly: false,
    transport: {
      save: async (version) => {
        saves.push({ target: saveTarget(targetRef.current), version });
        return { version: version + 1 };
      },
    },
    getLatest: () => ({ fp: "dirty", blob: "B" }),
  });

  const notify = lifecycle.notifyChange;
  useEffect(() => {
    notify();
  }, [notify]);

  return null;
}

describe("lastLoadedId", () => {
  it("only ever moves to a real id", () => {
    expect(lastLoadedId(null, null)).toBeNull();
    expect(lastLoadedId(null, { meta: { id: "file-a" } })).toBe("file-a");
    // The loading-state render must not forget the working copy.
    expect(lastLoadedId("file-a", null)).toBe("file-a");
    expect(lastLoadedId("file-a", { meta: { id: "file-b" } })).toBe("file-b");
  });
});

describe("saveTarget", () => {
  it("returns the id to PUT to", () => {
    expect(saveTarget("file-a")).toBe("file-a");
  });

  it("throws instead of reporting a save that never happened", () => {
    expect(() => saveTarget(null)).toThrow(/no file is loaded/i);
  });
});

describe("unmount flush", () => {
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
  });

  it("saves to the last loaded file after a null-loaded render and unmount", async () => {
    const saves: SaveCall[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(h(Page, { loaded: { meta: { id: "file-a", version: 3 } }, saves }));
    });

    // The page drops into its loading state before the editor unmounts;
    // a ref keyed on `loaded` would already be null here.
    await act(async () => {
      root?.render(h(Page, { loaded: null, saves }));
    });

    await act(async () => {
      root?.unmount();
    });
    root = null;

    expect(saves).toEqual([{ target: "file-a", version: 1 }]);
  });
});
