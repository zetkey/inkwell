// @vitest-environment jsdom
//
// Delta delivery contract: a frame only advances the collab baseline when
// the socket actually accepted it. A refused send (socket closed between
// the readyState check and the call) must leave `knownRef` alone so the
// next flush ships the same change instead of silently dropping it.

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "never" },
  UserIdleState: { ACTIVE: "active", AWAY: "away" },
  // Minimal stand-in for the real reconcile: union by id, newest version wins.
  reconcileElements: (
    local: Array<{ id: string; version: number }>,
    remote: Array<{ id: string; version: number }>,
  ) => {
    const byId = new Map(local.map((element) => [element.id, element]));
    for (const element of remote) {
      const previous = byId.get(element.id);
      if (!previous || element.version >= previous.version) byId.set(element.id, element);
    }
    return [...byId.values()];
  },
}));
vi.mock("@/data/auth", () => ({ useMe: () => ({ data: null }) }));

import { useCollab } from "./useCollab";

interface Element {
  id: string;
  version: number;
  text?: string;
}

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  failNextSend = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("socket closed");
    }
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }
}

function fakeApi(scene: Element[]) {
  return {
    getSceneElementsIncludingDeleted: () => scene,
    getFiles: () => ({}),
    getAppState: () => ({}),
    updateScene: () => {},
    addFiles: () => {},
  };
}

let root: Root | null = null;
let socket: FakeSocket;
let notify: ((elements: readonly Element[], files: Record<string, never>) => void) | null = null;

function Probe({ apiRef }: { apiRef: { current: ReturnType<typeof fakeApi> } }) {
  const collab = useCollab({
    fileId: "file-1",
    enabled: true,
    apiRef: apiRef as never,
  });
  notify = collab.notifySceneChange as never;
  return null;
}

async function mount(scene: Element[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // One ref for the whole mount: a fresh object per render would re-subscribe
  // the socket effect.
  const apiRef = { current: fakeApi(scene) };
  await act(async () => {
    root?.render(h(Probe, { apiRef }));
  });
  socket = FakeSocket.instances[0];
}

/** One local change plus the 100 ms delta throttle. */
async function change(elements: Element[]) {
  await act(async () => {
    notify?.(elements, {});
    await vi.advanceTimersByTimeAsync(100);
  });
}

const frames = (sock: FakeSocket = socket) =>
  sock.sent
    .map((raw) => JSON.parse(raw) as { t: string; elements?: Element[] })
    .filter((message) => message.t === "elements");

async function open(sock: FakeSocket) {
  await act(async () => {
    sock.onopen?.();
  });
}

describe("useCollab delta baseline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    globalThis.WebSocket = FakeSocket as never;
    notify = null;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("advances the baseline only for a delivered frame", async () => {
    const el: Element = { id: "e1", version: 1 };
    await mount([]);

    await change([el]);
    expect(frames()).toHaveLength(1);
    expect(frames()[0].elements).toEqual([el]);

    // Unchanged scene: the baseline already covers it, so nothing is sent.
    await change([el]);
    expect(frames()).toHaveLength(1);
  });

  it("re-sends the local scene after a reconnect", async () => {
    const el: Element = { id: "e1", version: 1 };
    // The API's scene, i.e. what the catch-up queues.
    const scene: Element[] = [];
    await mount(scene);
    await open(socket);

    // First sync: e1 becomes part of the baseline.
    scene.push(el);
    await change([el]);
    expect(frames()).toHaveLength(1);

    // Drop, reconnect: the next socket must forget that baseline and ship
    // the whole local scene again, so edits missed while offline are healed.
    await act(async () => {
      socket.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const reconnected = FakeSocket.instances[1];
    expect(reconnected).toBeDefined();
    await open(reconnected);
    // The room answers the join with our fresh peer identity, then the
    // throttled catch-up frame goes out with the whole local scene.
    await act(async () => {
      reconnected.onmessage?.({
        data: JSON.stringify({
          t: "joined",
          self: { peerId: "me-2", id: "u1", name: "Me", color: "#000000" },
          peers: [],
        }),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const sent = frames(reconnected);
    expect(sent).toHaveLength(1);
    expect(sent[0].elements).toEqual([el]);
  });

  it("retries a refused snapshot batch and only then advances the baseline", async () => {
    const big = (id: string): Element => ({ id, version: 1, text: "x".repeat(900_000) });
    // Bigger than the 3 MiB snapshot budget, so it goes out in batches.
    const scene = [big("b1"), big("b2"), big("b3"), big("b4")];
    await mount(scene);
    await open(socket);
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          t: "joined",
          self: { peerId: "me", id: "u1", name: "Me", color: "#000000" },
          peers: [],
        }),
      });
    });

    // A fresh peer appears and we are the oldest attachment, so we owe it a
    // snapshot. First batch goes out now, the rest on the next tick.
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          t: "presence",
          peers: [
            { peerId: "me", id: "u1", name: "Me", color: "#000000" },
            { peerId: "p1", id: "u2", name: "Peer", color: "#111111" },
          ],
        }),
      });
    });
    expect(frames()).toHaveLength(1);

    // The second batch is refused (socket closed between the checks).
    socket.failNextSend = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(frames()).toHaveLength(1);

    // The next flush retries the queue before sending anything else.
    await act(async () => {
      notify?.(scene, {});
      await vi.advanceTimersByTimeAsync(100);
    });
    const sent = frames();
    expect(sent).toHaveLength(2);
    expect(sent[1].elements?.map((element) => element.id)).toEqual(["b4"]);

    // Only now is the baseline current: the same scene ships nothing.
    await act(async () => {
      notify?.(scene, {});
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(frames()).toHaveLength(2);
  });

  it("ships an oversized delta as batches instead of stalling", async () => {
    const big = (id: string): Element => ({ id, version: 1, text: "x".repeat(900_000) });
    // Bigger than one frame, so the delta has to go out as batches.
    const scene = [big("b1"), big("b2"), big("b3"), big("b4")];
    await mount([]);
    await open(socket);

    await act(async () => {
      notify?.(scene, {});
      await vi.advanceTimersByTimeAsync(100);
    });
    // First batch is out; the rest are queued, so the baseline has not moved.
    expect(frames()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(frames()).toHaveLength(2);

    // Everything is sent now: the same scene produces no further frames.
    await act(async () => {
      notify?.(scene, {});
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(frames()).toHaveLength(2);
  });

  it("re-sends a local element a peer frame did not carry", async () => {
    const scene: Element[] = [];
    await mount(scene);
    await open(socket);

    // A local edit the room has not seen (no flush happened).
    scene.push({ id: "local", version: 1 });

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ t: "elements", elements: [{ id: "remote", version: 1 }] }),
      });
    });

    // The merge must not make the local element look delivered.
    await act(async () => {
      notify?.([...scene], {});
      await vi.advanceTimersByTimeAsync(100);
    });
    const sent = frames();
    expect(sent).toHaveLength(1);
    expect(sent[0].elements?.map((element) => element.id)).toEqual(["local"]);
  });

  it("re-sends the scene when the server rejects a frame", async () => {
    const el: Element = { id: "e1", version: 1 };
    const scene: Element[] = [];
    await mount(scene);
    await open(socket);

    scene.push(el);
    await change([el]);
    expect(frames()).toHaveLength(1);

    // The room refused something we already counted as sent.
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ t: "error", message: "too many messages" }) });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const sent = frames();
    expect(sent).toHaveLength(2);
    expect(sent[1].elements).toEqual([el]);
  });

  it("paces snapshot batches instead of bursting them", async () => {
    const big = (id: string): Element => ({ id, version: 1, text: "x".repeat(900_000) });
    // 10 elements -> four 3 MiB batches, sent one per tick.
    const scene = Array.from({ length: 10 }, (_, index) => big(`b${index}`));
    await mount(scene);
    await open(socket);
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          t: "joined",
          self: { peerId: "me", id: "u1", name: "Me", color: "#000000" },
          peers: [],
        }),
      });
    });
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          t: "presence",
          peers: [
            { peerId: "me", id: "u1", name: "Me", color: "#000000" },
            { peerId: "p1", id: "u2", name: "Peer", color: "#111111" },
          ],
        }),
      });
    });

    expect(frames()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    // One batch every 50 ms, not the whole queue at once.
    expect(frames()).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(frames()).toHaveLength(4);
  });

  it("re-sends the same change when the socket refuses the frame", async () => {
    const el: Element = { id: "e1", version: 1 };
    await mount([]);

    socket.failNextSend = true;
    await change([el]);
    expect(socket.sent).toHaveLength(0);

    // The baseline never advanced, so the retry carries the element again.
    await change([el]);
    expect(frames()).toHaveLength(1);
    expect(frames()[0].elements).toEqual([el]);
  });
});
