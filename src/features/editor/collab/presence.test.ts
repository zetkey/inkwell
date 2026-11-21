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

  it("lets only the lowest peer id answer, whatever the order", () => {
    // Order is deliberately reversed: election must not depend on it.
    expect(shouldSendSnapshot("b", [peer("b"), peer("a")], new Set(["a"]))).toBe(false);
    expect(shouldSendSnapshot("a", [peer("b"), peer("a")], new Set(["a"]))).toBe(true);
  });

  it("picks exactly one sender in a three-peer room", () => {
    const peers = [peer("c"), peer("b"), peer("a")];
    const seen = new Set(["a", "b"]);
    const senders = ["a", "b", "c"].filter((self) => shouldSendSnapshot(self, peers, seen));
    expect(senders).toEqual(["a"]);
  });

  it("includes self in the election even when absent from peers", () => {
    // A presence frame may not list the receiver; a lower self id still
    // makes it the elected sender, a higher one stays quiet.
    expect(shouldSendSnapshot("a", [peer("b")], new Set())).toBe(true);
    expect(shouldSendSnapshot("c", [peer("b")], new Set())).toBe(false);
  });

  it("stays quiet when every peer is already known", () => {
    expect(shouldSendSnapshot("a", [peer("a"), peer("b")], new Set(["a", "b"]))).toBe(false);
  });

  it("answers a peer joining or reconnecting with a new id", () => {
    const seen = new Set(["a", "b"]);
    expect(shouldSendSnapshot("a", [peer("a"), peer("b"), peer("c")], seen)).toBe(true);
  });
});
