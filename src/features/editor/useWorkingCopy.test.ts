// @vitest-environment jsdom
//
// The working-copy hook owns the invariants both editor pages rely on:
// saves follow the last loaded file even when `loaded` is already null,
// a PUT that finishes after the user moved on never overwrites the new
// file, and a conflict reload only remounts the file still on screen.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FileBlob, FileMeta, LoadedFile } from "@/lib/api/client";
import {
  type UseWorkingCopyResult,
  useWorkingCopy,
  type WorkingCopyTransport,
} from "./useWorkingCopy";

const BLOB: FileBlob = { kind: "notes", format: "markdown-v1", source: "x" };

function loadedFile(id: string, version: number): LoadedFile {
  return {
    meta: {
      id,
      name: id,
      kind: "notes",
      version,
      updatedAt: 1,
      folderId: null,
      hasThumb: false,
      starredAt: null,
    },
    blob: BLOB,
    permission: "write",
    allowDownload: true,
    sharedBy: null,
    shareExpiresAt: null,
  };
}

function metaOf(id: string, version: number): FileMeta {
  return {
    id,
    folderId: null,
    name: id,
    kind: "notes",
    tags: [],
    version,
    sizeBytes: 1,
    mime: null,
    hasThumb: false,
    thumbUpdatedAt: 0,
    activeShareCount: 0,
    starredAt: null,
    createdAt: 0,
    updatedAt: 1,
  };
}

function harness(options: { deferred?: boolean } = {}) {
  const saves: Array<{ target: string; version: number }> = [];
  const loads: string[] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  if (options.deferred) {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  }
  const transport: WorkingCopyTransport = {
    save: async (target, version) => {
      saves.push({ target, version });
      if (gate) await gate;
      return metaOf(target, version + 1);
    },
    load: async (target) => {
      loads.push(target);
      return loadedFile(target, 9);
    },
    cacheKey: (target) => ["test", target],
    nextLoaded: (prev, meta, blob) => ({
      ...prev,
      meta: { ...prev.meta, version: meta.version },
      blob,
    }),
  };
  return {
    transport,
    saves,
    loads,
    // Only present when `deferred` is set.
    release: () => release?.(),
  };
}

let root: Root | null = null;
let api: UseWorkingCopyResult | null = null;

function Probe({ transport, initial }: { transport: WorkingCopyTransport; initial: LoadedFile }) {
  api = useWorkingCopy(transport, initial);
  return null;
}

async function mount(transport: WorkingCopyTransport, initial: LoadedFile) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      h(QueryClientProvider, { client: new QueryClient() }, h(Probe, { transport, initial })),
    );
  });
  if (!api) throw new Error("hook did not mount");
  return api;
}

describe("useWorkingCopy", () => {
  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    api = null;
    document.body.innerHTML = "";
  });

  it("saves to the last loaded file after `loaded` goes null", async () => {
    const t = harness();
    const wc = await mount(t.transport, loadedFile("file-a", 3));

    await act(async () => {
      wc.setLoaded(null);
    });
    await act(async () => {
      await wc.save(3, BLOB);
    });

    expect(t.saves).toEqual([{ target: "file-a", version: 3 }]);
    expect(api?.loaded).toBeNull();
  });

  it("keeps the live blob when our own save returns a new one", async () => {
    const t = harness();
    const initial = loadedFile("file-a", 3);
    const wc = await mount(t.transport, initial);
    const saved: FileBlob = { kind: "notes", format: "markdown-v1", source: "typed" };

    await act(async () => {
      await wc.save(3, saved);
    });

    // Meta advances, but the mounted editor's blob reference must not:
    // a new reference would make the editors re-seed themselves and drop
    // keystrokes typed while the PUT was in flight.
    expect(api?.loaded?.meta.version).toBe(4);
    expect(api?.loaded?.blob).toBe(initial.blob);
  });

  it("does not overwrite a file the user moved to mid-save", async () => {
    const t = harness({ deferred: true });
    const wc = await mount(t.transport, loadedFile("file-a", 3));

    let pending: Promise<{ version: number }> | null = null;
    await act(async () => {
      pending = wc.save(3, BLOB);
    });
    await act(async () => {
      wc.setLoaded(loadedFile("file-b", 4));
    });
    await act(async () => {
      t.release();
      if (pending) await pending;
    });

    // The PUT landed on A; the UI is still B.
    expect(t.saves).toEqual([{ target: "file-a", version: 3 }]);
    expect(api?.loaded?.meta.id).toBe("file-b");
    expect(await pending).toEqual({ version: 4 });
  });

  it("remounts only for the file still on screen", async () => {
    const t = harness();
    const wc = await mount(t.transport, loadedFile("file-a", 3));

    await act(async () => {
      wc.remountAfterConflict(loadedFile("file-b", 4));
    });
    expect(api?.editorKey).toBe(0);

    await act(async () => {
      wc.remountAfterConflict(loadedFile("file-a", 5));
    });
    expect(api?.editorKey).toBe(1);
    expect(api?.loaded?.meta.version).toBe(5);
  });

  it("reloads the sticky target and raises the conflict banner", async () => {
    const t = harness();
    const wc = await mount(t.transport, loadedFile("file-a", 3));

    await act(async () => {
      await wc.reload();
    });

    expect(t.loads).toEqual(["file-a"]);
    expect(api?.conflict).toBe(true);
    expect(api?.loaded?.meta.version).toBe(9);
  });
});
