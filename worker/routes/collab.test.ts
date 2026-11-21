import { describe, expect, it } from "vitest";
import { guestIdentity } from "./collab";

const NAME = /^[a-z]+(_[a-z]+)+$/;
const GUEST_ID = /^guest:[0-9a-hjkmnp-tv-z]{16}$/;

describe("guestIdentity", () => {
  it("mints a fresh per-connection id, never the token", () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const a = guestIdentity();
    expect(a.id).toMatch(GUEST_ID);
    expect(a.id).not.toContain(token);
    // Two connections on the same share link must be distinct peers.
    expect(guestIdentity().id).not.toBe(a.id);
  });

  it("uses a random animal name", () => {
    const { name } = guestIdentity();
    expect(name).toMatch(NAME);
    expect(name.length).toBeLessThanOrEqual(40);
  });
});
