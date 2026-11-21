import { describe, expect, it } from "vitest";
import {
  CollabRoom,
  MAX_FRAME_CHARS,
  MAX_ROOM_SOCKETS,
  orderPeers,
  type Peer,
  type PeerEntry,
  presenceFrame,
  RATE_LIMIT_MAX_MESSAGES,
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

    expect(frames(a.sent)).toEqual([{ t: "error", message: "invalid elements" }]);
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

describe("CollabRoom limits", () => {
  it("caps a room at MAX_ROOM_SOCKETS sockets", async () => {
    const sockets = Array.from({ length: MAX_ROOM_SOCKETS }, (_, i) =>
      socket(peer(`p${i}`), i + 1),
    );
    const r = room(sockets);

    const res = await r.fetch(
      new Request("https://room.test/", {
        headers: { Upgrade: "websocket", "x-collab-user-id": "u-extra" },
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("room full");
  });

  it("throttles a socket that floods messages", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);
    const frame = JSON.stringify({ t: "elements", elements: [{ id: "el" }] });

    for (let i = 0; i < 45; i++) r.webSocketMessage(a.ws, frame);

    const errors = frames(a.sent).filter((f) => f.message === "too many messages");
    const relays = b.sent.length;
    expect(errors).toHaveLength(5);
    expect(relays).toBe(RATE_LIMIT_MAX_MESSAGES);
  });

  it("processes a normal burst of 20 messages", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);
    const frame = JSON.stringify({ t: "elements", elements: [{ id: "el" }] });

    for (let i = 0; i < 20; i++) r.webSocketMessage(a.ws, frame);

    expect(a.sent).toEqual([]);
    expect(b.sent).toHaveLength(20);
  });

  it("rejects elements whose id is not a string", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);

    r.webSocketMessage(a.ws, JSON.stringify({ t: "elements", elements: [{ id: 1 }] }));

    expect(frames(a.sent)).toEqual([{ t: "error", message: "invalid elements" }]);
    expect(b.sent).toEqual([]);
  });

  it("rejects a cursor with a non-numeric position", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);

    r.webSocketMessage(
      a.ws,
      JSON.stringify({ t: "cursor", pointer: { x: "a", y: 1, tool: "selection" } }),
    );

    expect(frames(a.sent)).toEqual([{ t: "error", message: "invalid cursor" }]);
    expect(b.sent).toEqual([]);
  });

  it("rejects an invalid button or selection map", () => {
    const a = socket(peer("a"), 1);
    const r = room([a]);

    r.webSocketMessage(a.ws, JSON.stringify({ t: "cursor", button: "sideways" }));
    r.webSocketMessage(a.ws, JSON.stringify({ t: "cursor", selectedElementIds: { x: 1 } }));

    expect(frames(a.sent)).toEqual([
      { t: "error", message: "invalid cursor" },
      { t: "error", message: "invalid cursor" },
    ]);
  });

  it("relays a well-formed cursor with the sender identity", () => {
    const a = socket(peer("a"), 1);
    const b = socket(peer("b"), 2);
    const r = room([a, b]);

    r.webSocketMessage(
      a.ws,
      JSON.stringify({
        t: "cursor",
        pointer: { x: 10, y: 20, tool: "selection" },
        button: "down",
        selectedElementIds: { el1: true },
      }),
    );

    expect(frames(b.sent)).toEqual([
      {
        t: "cursor",
        cursor: { x: 10, y: 20, tool: "selection" },
        button: "down",
        selectedElementIds: { el1: true },
        from: "a",
        id: "u-a",
        name: "a",
        color: "#000",
      },
    ]);
  });
});
