import { describe, expect, it } from "vitest";
import { canEditPermission, sharePermissionAllows } from "./types";

// permission, edit (save content), write (structural), collab (WebSocket)
const MATRIX = [
  ["read", false, false, false],
  ["write", true, true, false],
  ["collab", true, false, true],
] as const;

describe("share permission matrix", () => {
  it.each(MATRIX)("%s", (permission, edit, write, collab) => {
    expect(canEditPermission(permission)).toBe(edit);
    expect(sharePermissionAllows(permission, "edit")).toBe(edit);
    expect(sharePermissionAllows(permission, "write")).toBe(write);
    expect(sharePermissionAllows(permission, "collab")).toBe(collab);
  });
});
