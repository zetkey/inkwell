// @vitest-environment jsdom
//
// The live save lifecycle: autosave after a change, conflicts that keep
// the local edits dirty (no silent auto-reload), and the fact that
// "discard" cannot cancel a PUT that is already in flight.

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { type UseSaveLifecycleResult, useSaveLifecycle } from "./useSaveLifecycle";

interface NotesBlob {
  kind: "notes";
  source: string;
}

interface Loaded {
  meta: { version: number };
}

let api: UseSaveLifecycleResult | null = null;
let root: Root | null = null;

function Probe({
  save,
  onConflict,
}: {
  save: (version: number, blob: NotesBlob) => Promise<{ version: number }>;
  onConflict?: () => void;
}) {
  api = useSaveLifecycle<NotesBlob, Loaded>({
    initialVersion: 1,
    initialFingerprint: "base",
    readOnly: false,
    transport: { save },
    getLatest: () => snapshot.current,
    onConflict,
  });
  return null;
}

const snapshot: { current: { fp: string; blob: NotesBlob } } = {
  current: { fp: "v1", blob: { kind: "notes", source: "a" } },
};

async function mount(opts: {
  save: (version: number, blob: NotesBlob) => Promise<{ version: number }>;
  onConflict?: () => void;
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(h(Probe, opts));
  });
  if (!api) throw new Error("hook did not mount");
  return api;
}

describe("useSaveLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    snapshot.current = { fp: "v1", blob: { kind: "notes", source: "a" } };
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    api = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("autosaves after a change settles", async () => {
    const save = vi.fn(async (_version: number, _blob: NotesBlob) => ({ version: 2 }));
    const lifecycle = await mount({ save });

    await act(async () => {
      lifecycle.notifyChange();
    });
    expect(api?.status).toBe("dirty");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, snapshot.current.blob);
    expect(api?.status).toBe("saved");
    expect(api?.isDirty).toBe(false);
  });

  it("keeps local edits dirty on 409 and never reloads on its own", async () => {
    const save = vi.fn(async (_version: number, _blob: NotesBlob) => {
      throw new ApiError(409, "version conflict");
    });
    const onConflict = vi.fn();
    const lifecycle = await mount({ save, onConflict });

    await act(async () => {
      lifecycle.notifyChange();
      await vi.advanceTimersByTimeAsync(2_600);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(api?.status).toBe("error");
    expect(api?.errorMessage).toMatch(/^Conflict/);
    // The canvas keeps the unsaved work, so the unload/leave guard must
    // still treat the editor as dirty.
    expect(api?.isDirty).toBe(true);

    // No silent reload: the next attempt still uses the original
    // If-Match version (a reload would have advanced it).
    await act(async () => {
      await lifecycle.saveNow();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0]).toBe(1);
    expect(save.mock.calls[1][0]).toBe(1);
    expect(api?.isDirty).toBe(true);
  });

  it("cannot cancel a save that is already in flight", async () => {
    // No debounce involved: `saveNow` writes immediately, so real timers
    // keep React's act scheduling simple.
    vi.useRealTimers();
    // `Promise.withResolvers` is ES2024; this project's lib is ES2022, so
    // the executor form is the only option (documented exception).
    let release!: (value: { version: number }) => void;
    const gate = new Promise<{ version: number }>((resolve) => {
      release = resolve;
    });
    const save = vi.fn((_version: number, _blob: NotesBlob) => gate);
    const lifecycle = await mount({ save });

    let pending!: Promise<boolean>;
    await act(async () => {
      lifecycle.notifyChange();
      pending = lifecycle.saveNow();
    });
    expect(save).toHaveBeenCalledTimes(1);

    // "Discard" only drops the debounce; the PUT is already on the wire.
    await act(async () => {
      lifecycle.discardPendingLocalWork();
      release({ version: 2 });
    });
    expect(await pending).toBe(true);

    // The write landed and advanced the version: the next save must send
    // If-Match version 2, not 1.
    snapshot.current = { fp: "v2", blob: { kind: "notes", source: "b" } };
    await act(async () => {
      await lifecycle.saveNow();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toBe(2);
  });
});
