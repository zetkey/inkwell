import { describe, expect, it } from "vitest";
import {
  colorForUserId,
  identityOf,
  orderPeers,
  PEER_COLORS,
  type Peer,
  presenceFrame,
} from "./collab";

describe("colorForUserId", () => {
  it("is deterministic and stays inside the palette", () => {
    for (const id of ["u1", "abc", "3f0c1d9e-collab", "x".repeat(64)]) {
      expect(colorForUserId(id)).toBe(colorForUserId(id));
      expect(PEER_COLORS).toContain(colorForUserId(id));
    }
  });

  it("spreads a batch of ids over more than one color", () => {
    const seen = new Set(Array.from({ length: 32 }, (_, i) => colorForUserId(`user-${i}`)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("identityOf", () => {
  it("drops the presence-only `active` flag", () => {
    const peer: Peer = { peerId: "p1", id: "u1", name: "Ada", color: "#2563eb", active: true };
    expect(identityOf(peer)).toEqual({ peerId: "p1", id: "u1", name: "Ada", color: "#2563eb" });
  });
});

describe("orderPeers", () => {
  it("puts the oldest socket (lowest seq) first, newest-first input included", () => {
    const a: Peer = { peerId: "a", id: "u1", name: "A", color: "#2563eb", active: true };
    const b: Peer = { peerId: "b", id: "u2", name: "B", color: "#0d9488", active: true };
    const c: Peer = { peerId: "c", id: "u3", name: "C", color: "#7c3aed", active: false };
    expect(
      orderPeers([
        { peer: b, seq: 2 },
        { peer: a, seq: 1 },
        { peer: c, seq: 3 },
      ]),
    ).toEqual([a, b, c]);
  });
});

describe("presenceFrame", () => {
  it("serializes the wire shape", () => {
    const peers: Peer[] = [
      { peerId: "p1", id: "u1", name: "Ada", color: "#2563eb", active: true },
      { peerId: "p2", id: "u2", name: "Bob", color: "#0d9488", active: false },
    ];
    expect(JSON.parse(presenceFrame(peers))).toEqual({ t: "presence", peers });
  });

  it("serializes an empty room", () => {
    expect(JSON.parse(presenceFrame([]))).toEqual({ t: "presence", peers: [] });
  });
});
