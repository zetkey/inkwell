// Save-loop behaviour: the four ways edits used to get lost or write
// over a newer version. The loop is framework-free (see `saveLoop.ts`),
// so these run on fake timers with a fake transport and no DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { SaveLoop, type SaveSnapshot } from "./saveLoop";

interface Loaded {
  meta: { version: number };
  blob: string;
}

function harness(overrides?: Partial<{ readOnly: boolean }>) {
  let latest: SaveSnapshot<string> = { fp: "a", blob: "A" };
  const saves: Array<{ version: number; blob: string }> = [];
  const statuses: string[] = [];

  const transport = {
    save: vi.fn(async (version: number, blob: string) => {
      saves.push({ version, blob });
      return { version: version + 1 };
    }),
    reload: vi.fn(async (): Promise<Loaded> => ({ meta: { version: 7 }, blob: "FRESH" })),
  };

  const loop = new SaveLoop<string, Loaded>({
    initialVersion: 3,
    initialFingerprint: "0",
    live: {
      readOnly: overrides?.readOnly ?? false,
      transport,
      getLatest: () => latest,
      onReload: (fresh) => {
        latest = { fp: "fresh", blob: fresh.blob };
      },
    },
    onStatus: (status, error) => statuses.push(error ? `${status}:${error}` : status),
  });

  return {
    loop,
    saves,
    statuses,
    transport,
    setLatest: (fp: string, blob: string) => {
      latest = { fp, blob };
    },
  };
}

/** Transport whose saves stay in flight until the test resolves them. */
function deferredHarness() {
  const saves: Array<{ version: number; blob: string }> = [];
  const resolvers: Array<() => void> = [];
  let latest: SaveSnapshot<string> = { fp: "a", blob: "A" };
  const transport = {
    save: vi.fn(
      (version: number, blob: string) =>
        new Promise<{ version: number }>((resolve) => {
          saves.push({ version, blob });
          resolvers.push(() => resolve({ version: version + 1 }));
        }),
    ),
  };
  const loop = new SaveLoop<string, Loaded>({
    initialVersion: 3,
    initialFingerprint: "0",
    live: {
      readOnly: false,
      transport,
      getLatest: () => latest,
    },
    onStatus: () => {},
  });
  return {
    loop,
    saves,
    resolvers,
    setLatest: (fp: string, blob: string) => {
      latest = { fp, blob };
    },
  };
}

/** Let resolved promises / queued microtasks run under fake timers. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("SaveLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("saves a scheduled edit when the editor unmounts", async () => {
    const h = harness();

    h.loop.notifyChange();
    expect(h.saves).toHaveLength(0);

    // Component unmount, before the 30s debounce fires.
    h.loop.dispose();
    await settle();
    expect(h.saves).toEqual([{ version: 3, blob: "A" }]);

    // The unmount flush replaced the debounce; nothing fires later.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.saves).toHaveLength(1);
  });

  it("takes another lap when an edit lands during an in-flight save", async () => {
    const h = deferredHarness();

    h.loop.notifyChange();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.saves).toEqual([{ version: 3, blob: "A" }]);

    h.setLatest("b", "B");
    h.loop.notifyChange();

    h.resolvers[0]();
    await settle();
    expect(h.saves[1]).toEqual({ version: 4, blob: "B" });

    h.resolvers[1]();
    await settle();
    expect(h.saves).toHaveLength(2);

    h.loop.dispose();
    await settle();
    expect(h.saves).toHaveLength(2);
  });

  it("finishes the in-flight lap even when the editor unmounted", async () => {
    const h = deferredHarness();

    h.loop.notifyChange();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.saves).toEqual([{ version: 3, blob: "A" }]);

    // The user typed while the PUT was in flight, then navigated away.
    h.setLatest("b", "B");
    h.loop.notifyChange();
    h.loop.dispose();

    h.resolvers[0]();
    await settle();
    expect(h.saves[1]).toEqual({ version: 4, blob: "B" });

    h.resolvers[1]();
    await settle();
    expect(h.saves).toHaveLength(2);

    // The loop is done; nothing more is PUT after the unmount.
    h.setLatest("c", "C");
    h.loop.notifyChange();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(h.saves).toHaveLength(2);
  });

  it("reloads on 409, raises the version baseline, and stops writing the stale scene", async () => {
    const h = harness();
    const conflict = new ApiError(409, "version conflict");
    h.transport.save.mockRejectedValueOnce(conflict);

    h.loop.notifyChange();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(h.transport.reload).toHaveBeenCalledTimes(1);
    expect(h.saves).toHaveLength(0);
    expect(h.statuses.at(-1)).toContain("another tab saved a newer version");

    // Stale canvas: even another change must not be written back.
    h.setLatest("c", "C");
    h.loop.notifyChange();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(h.saves).toHaveLength(0);

    // Host re-seeded from the reload: next save carries the fresh version.
    h.loop.reset(7, "fresh");
    h.setLatest("d", "D");
    h.loop.notifyChange();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(h.saves).toEqual([{ version: 7, blob: "D" }]);
  });

  it("drops pending work on discard, including the unmount flush", async () => {
    const h = harness();

    h.loop.notifyChange();
    h.loop.discard();
    expect(h.statuses.at(-1)).toBe("saved");

    await vi.advanceTimersByTimeAsync(60_000);
    h.loop.dispose();
    await settle();
    expect(h.transport.save).not.toHaveBeenCalled();
  });

  it("saves again after a StrictMode cleanup re-arms the loop", async () => {
    const h = harness();

    // StrictMode (dev) runs cleanup -> setup on the same hook instance.
    h.loop.dispose();
    h.loop.attach();

    h.setLatest("e", "E");
    h.loop.notifyChange();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(h.saves).toEqual([{ version: 3, blob: "E" }]);
  });

  it("saves nothing in a read-only session", async () => {
    const h = harness({ readOnly: true });

    h.loop.notifyChange();
    h.loop.dispose();
    await settle();
    expect(h.transport.save).not.toHaveBeenCalled();
  });
});
