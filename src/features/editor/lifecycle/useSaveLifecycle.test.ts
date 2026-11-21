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

let api: UseSaveLifecycleResult | null = null;
let root: Root | null = null;

function Probe({
  save,
  onConflict,
}: {
  save: (version: number, blob: NotesBlob) => Promise<{ version: number }>;
  onConflict?: () => void;
}) {
  api = useSaveLifecycle<NotesBlob>({
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

  it("pauses saves after 409 until an explicit reload or discard", async () => {
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

    // Paused: further changes never schedule another doomed PUT.
    await act(async () => {
      lifecycle.notifyChange();
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(save).toHaveBeenCalledTimes(1);

    // "Keep editing" + ⌘S: no network, banner re-surfaces (onConflict).
    let ok = true;
    await act(async () => {
      ok = await lifecycle.saveNow();
    });
    expect(ok).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledTimes(2);

    // Explicit reload (reset) clears the pause and adopts the new version.
    await act(async () => {
      lifecycle.reset(9, "base");
    });
    await act(async () => {
      await lifecycle.saveNow();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toBe(9);
  });

  it("discard clears the conflict pause", async () => {
    let failing = true;
    const save = vi.fn(async (_version: number, _blob: NotesBlob) => {
      if (failing) throw new ApiError(409, "version conflict");
      return { version: 2 };
    });
    const lifecycle = await mount({ save });

    await act(async () => {
      lifecycle.notifyChange();
      await vi.advanceTimersByTimeAsync(2_600);
    });
    expect(api?.status).toBe("error");

    await act(async () => {
      lifecycle.discardPendingLocalWork();
    });
    failing = false;
    snapshot.current = { fp: "v2", blob: { kind: "notes", source: "b" } };
    await act(async () => {
      await lifecycle.saveNow();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(api?.status).toBe("saved");
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
