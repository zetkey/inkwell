import { describe, expect, it } from "vitest";
import { guestIdentity } from "./collab";

const NAME = /^[a-z]+(_[a-z]+)+$/;

describe("guestIdentity", () => {
  it("keeps the token-derived peer id", () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    expect(guestIdentity(token).id).toBe(`share:${token}`);
    expect(guestIdentity(token).id).toBe(`share:${token}`);
  });

  it("uses a random animal name, never the token itself", () => {
    const token = "XYZ0123456789";
    const { name } = guestIdentity(token);
    expect(name).toMatch(NAME);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).not.toContain(token.toLowerCase());
  });
});
