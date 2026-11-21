import { describe, expect, it } from "vitest";
import {
  CollabRoom,
  MAX_FRAME_CHARS,
  orderPeers,
  type Peer,
  type PeerEntry,
  presenceFrame,
} from "./collab";

// Duck-typed WebSocket + DurableObjectState harness. The DO only touches
// `send`, the attachment pair, `close`, and `ctx.getWebSockets()`.
interface FakeSocket {
  ws: WebSocket;
  sent: string[];
  att: PeerEntry;
}

function socket(peer: Peer, seq: number): FakeSocket {
  const att: PeerEntry = { peer, seq };
  const sent: string[] = [];
  const handle = {
    send: (frame: string) => sent.push(frame),
    close: () => {},
    serializeAttachment: (next: PeerEntry) => {
      att.peer = next.peer;
    },
    deserializeAttachment: () => att,
  };
  return { ws: handle as unknown as WebSocket, sent, att };
}

function peer(peerId: string, extra: Partial<Peer> = {}): Peer {
  return { peerId, id: `u-${peerId}`, name: peerId, color: "#000", active: true, ...extra };
}

function room(sockets: FakeSocket[]) {
  const state = { getWebSockets: () => sockets.map((s) => s.ws) } as unknown as DurableObjectState;
  return new CollabRoom(state);
}

function frames(sent: string[]): Record<string, unknown>[] {
  return sent.map((f) => JSON.parse(f) as Record<string, unknown>);
}

describe("CollabRoom frames", () => {
  it("refuses an oversized frame without parsing or relaying it", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);
    const oversized = `{"t":"noop","pad":"${"x".repeat(MAX_FRAME_CHARS)}"}`;

    r.webSocketMessage(a.ws, oversized);

    expect(frames(a.sent)).toEqual([{ t: "error", message: "frame too large" }]);
    expect(b.sent).toEqual([]);
  });

  it("relays elements to the other sockets with the sender's peerId", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);

    r.webSocketMessage(
      a.ws,
      JSON.stringify({ t: "elements", elements: [{ id: "el1" }], from: "spoofed" }),
    );

    expect(a.sent).toEqual([]);
    expect(frames(b.sent)).toEqual([{ t: "elements", elements: [{ id: "el1" }], from: "a" }]);
  });

  it("rejects a non-array elements payload", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);

    r.webSocketMessage(a.ws, JSON.stringify({ t: "elements", elements: "nope" }));

    expect(frames(a.sent)).toEqual([{ t: "error", message: "elements must be an array" }]);
    expect(b.sent).toEqual([]);
  });
});

describe("CollabRoom presence", () => {
  it("lists the oldest socket first (join)", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);

    r.webSocketMessage(a.ws, JSON.stringify({ t: "join" }));

    const joined = frames(a.sent)[0] as { t: string; peers: Peer[] };
    expect(joined.t).toBe("joined");
    expect(joined.peers.map((p) => p.peerId)).toEqual(["a", "b"]);
  });

  it("drops a closed socket from the broadcast list", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);

    r.webSocketClose(b.ws, 1000, "bye");

    const presence = frames(a.sent)[0] as { t: string; peers: Peer[] };
    expect(presence.t).toBe("presence");
    expect(presence.peers.map((p) => p.peerId)).toEqual(["a"]);
    // The closing socket is excluded from its own farewell broadcast.
    expect(b.sent).toEqual([]);
  });

  it("marks a peer idle via activity:false and broadcasts it", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);

    r.webSocketMessage(a.ws, JSON.stringify({ t: "activity", active: false }));

    for (const s of [a, b]) {
      const presence = frames(s.sent)[0] as { t: string; peers: Peer[] };
      expect(presence.t).toBe("presence");
      expect(presence.peers.find((p) => p.peerId === "a")?.active).toBe(false);
      expect(presence.peers.find((p) => p.peerId === "b")?.active).toBe(true);
    }
  });

  it("orders presence peers by accept sequence", () => {
    const entries: PeerEntry[] = [
      { peer: peer("new"), seq: 3 },
      { peer: peer("old"), seq: 1 },
      { peer: peer("mid"), seq: 2 },
    ];

    expect(orderPeers(entries).map((p) => p.peerId)).toEqual(["old", "mid", "new"]);
    expect(JSON.parse(presenceFrame(orderPeers(entries)))).toEqual({
      t: "presence",
      peers: orderPeers(entries),
    });
  });
});
