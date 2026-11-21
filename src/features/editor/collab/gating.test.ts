import { describe, expect, it } from "vitest";
import { COLLAB_MAX_CONSECUTIVE_FAILURES, shouldOpenCollab, shouldRetryConnect } from "./gating";

describe("shouldOpenCollab", () => {
  it("opens for the owner editor", () => {
    expect(shouldOpenCollab("owner")).toBe(true);
  });

  it("opens for a collab share link", () => {
    expect(shouldOpenCollab("collab")).toBe(true);
  });

  it("stays closed for a write share link (editable, but no collab route)", () => {
    expect(shouldOpenCollab("write")).toBe(false);
  });

  it("stays closed for a read-only share link", () => {
    expect(shouldOpenCollab("read")).toBe(false);
  });
});

describe("shouldRetryConnect", () => {
  it("retries a few rejected connects, then gives up", () => {
    expect(shouldRetryConnect(1, false)).toBe(true);
    expect(shouldRetryConnect(COLLAB_MAX_CONSECUTIVE_FAILURES - 1, false)).toBe(true);
    expect(shouldRetryConnect(COLLAB_MAX_CONSECUTIVE_FAILURES, false)).toBe(false);
  });

  it("keeps reconnecting after a socket has opened once", () => {
    expect(shouldRetryConnect(COLLAB_MAX_CONSECUTIVE_FAILURES, true)).toBe(true);
    expect(shouldRetryConnect(50, true)).toBe(true);
  });
});
