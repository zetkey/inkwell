import { describe, expect, it } from "vitest";
import { CollabRoom, MAX_FRAME_CHARS } from "./collab";

// Minimal Durable Object harness: one socket with a peer attachment, and
// a capture of every frame the room sends back.
function room() {
  const sent: string[] = [];
  const attachment = {
    peer: { peerId: "p1", id: "u1", name: "U", color: "#000", active: true },
    seq: 1,
  };
  const ws = {
    send: (frame: string) => sent.push(frame),
    deserializeAttachment: () => attachment,
    serializeAttachment: () => {},
  } as unknown as WebSocket;
  const state = {
    getWebSockets: () => [ws],
    acceptWebSocket: () => {},
  } as unknown as DurableObjectState;
  return { room: new CollabRoom(state), ws, sent };
}

function errorOf(frame: string): { t: string; message: string } {
  return JSON.parse(frame) as { t: string; message: string };
}

describe("collab frame cap", () => {
  it("rejects a frame over 4 MiB without parsing it", () => {
    const { room: r, ws, sent } = room();
    const oversized = `{"t":"noop","pad":"${"x".repeat(MAX_FRAME_CHARS)}"}`;

    r.webSocketMessage(ws, oversized);

    expect(oversized.length).toBeGreaterThan(MAX_FRAME_CHARS);
    expect(sent).toHaveLength(1);
    expect(errorOf(sent[0])).toEqual({ t: "error", message: "frame too large" });
  });

  it("processes a frame of exactly 4 MiB", () => {
    const { room: r, ws, sent } = room();
    const prefix = '{"t":"noop","pad":"';
    const suffix = '"}';
    const exact = prefix + "x".repeat(MAX_FRAME_CHARS - prefix.length - suffix.length) + suffix;

    r.webSocketMessage(ws, exact);

    expect(exact.length).toBe(MAX_FRAME_CHARS);
    // Parsed and dispatched: an unknown type is answered as such.
    expect(errorOf(sent[0])).toEqual({ t: "error", message: "unknown message type" });
  });
});
