import { describe, expect, it } from "vitest";
import { peerCursorFromFrame, shouldSendSnapshot } from "./presence";
import type { Peer, RemoteCursorMessage } from "./protocol";

const peer = (peerId: string): Peer => ({
  peerId,
  id: peerId,
  name: peerId,
  color: "#1971c2",
  active: true,
});

const cursorFrame = (overrides: Partial<RemoteCursorMessage> = {}): RemoteCursorMessage => ({
  t: "cursor",
  cursor: { x: 12, y: 34, tool: "pointer" },
  button: "down",
  selectedElementIds: { el1: true },
  from: "p1",
  id: "u1",
  name: "Ada",
  color: "#1971c2",
  ...overrides,
});

describe("peerCursorFromFrame", () => {
  it("regroups the pointer and the top-level button/selection", () => {
    expect(peerCursorFromFrame(cursorFrame())).toEqual({
      pointer: { x: 12, y: 34, tool: "pointer" },
      button: "down",
      selectedElementIds: { el1: true },
    });
  });

  it("drops a null pointer instead of rendering a cursor at 0,0", () => {
    expect(
      peerCursorFromFrame(
        cursorFrame({ cursor: null as unknown as RemoteCursorMessage["cursor"] }),
      ),
    ).toBeUndefined();
  });
});

describe("shouldSendSnapshot", () => {
  it("is false without a self peer id", () => {
    expect(shouldSendSnapshot(undefined, [peer("a"), peer("b")], new Set())).toBe(false);
  });

  it("is false for an empty room", () => {
    expect(shouldSendSnapshot("a", [], new Set())).toBe(false);
  });

  it("lets only the oldest peer answer", () => {
    expect(shouldSendSnapshot("b", [peer("a"), peer("b")], new Set(["a"]))).toBe(false);
    expect(shouldSendSnapshot("a", [peer("a"), peer("b")], new Set(["a"]))).toBe(true);
  });

  it("stays quiet when every peer is already known", () => {
    expect(shouldSendSnapshot("a", [peer("a"), peer("b")], new Set(["a", "b"]))).toBe(false);
  });

  it("answers a peer joining or reconnecting with a new id", () => {
    const seen = new Set(["a", "b"]);
    expect(shouldSendSnapshot("a", [peer("a"), peer("b"), peer("c")], seen)).toBe(true);
  });
});
