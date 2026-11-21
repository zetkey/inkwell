import { describe, expect, it } from "vitest";
import { parseSharePermission } from "./client";

describe("parseSharePermission", () => {
  it("keeps all three share modes as-is", () => {
    expect(parseSharePermission("read")).toBe("read");
    expect(parseSharePermission("write")).toBe("write");
    expect(parseSharePermission("collab")).toBe("collab");
  });

  it("falls back to read for missing or unknown values", () => {
    expect(parseSharePermission(null)).toBe("read");
    expect(parseSharePermission(undefined)).toBe("read");
    expect(parseSharePermission("")).toBe("read");
    expect(parseSharePermission("admin")).toBe("read");
  });
});
