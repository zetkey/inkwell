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
  reconcileElements: () => [],
}));
vi.mock("@/data/auth", () => ({ useMe: () => ({ data: null }) }));

import { useCollab } from "./useCollab";

interface Element {
  id: string;
  version: number;
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

function Probe({ scene }: { scene: Element[] }) {
  const apiRef = { current: fakeApi(scene) };
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
  await act(async () => {
    root?.render(h(Probe, { scene }));
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

const frames = () => socket.sent.map((raw) => JSON.parse(raw) as { elements: Element[] });

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
