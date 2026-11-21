import { describe, expect, it } from "vitest";
import { sessionUnavailable } from "./auth";

describe("sessionUnavailable", () => {
  it("keeps the shell when a cached session exists", () => {
    // A background refetch failure keeps `data` in React Query; the user
    // stays signed in and the shell must keep rendering.
    expect(sessionUnavailable({ isError: true, hasData: true })).toBe(false);
  });

  it("shows the error state when the probe failed with nothing cached", () => {
    expect(sessionUnavailable({ isError: true, hasData: false })).toBe(true);
  });

  it("is quiet while the probe is healthy", () => {
    expect(sessionUnavailable({ isError: false, hasData: false })).toBe(false);
    expect(sessionUnavailable({ isError: false, hasData: true })).toBe(false);
  });
});
