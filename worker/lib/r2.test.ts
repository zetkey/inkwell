import { describe, expect, it } from "vitest";
import type { R2Like } from "./r2";
import { r2DeleteAll } from "./r2";

function env(
  multi: "ok" | "throw",
  perKeyFailures: readonly string[] = [],
): R2Like & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    R2: {
      delete: async (keys: string | string[]) => {
        if (Array.isArray(keys)) {
          calls.push(`multi:${keys.join(",")}`);
          if (multi === "throw") throw new Error("multi-delete unsupported");
          return;
        }
        calls.push(`single:${keys}`);
        if (perKeyFailures.includes(keys)) throw new Error("delete failed");
      },
    } as unknown as R2Bucket,
  };
}

describe("r2DeleteAll", () => {
  it("returns no failures when the multi-delete works", async () => {
    const e = env("ok");
    expect(await r2DeleteAll(e, ["a", "b"])).toEqual([]);
    expect(e.calls).toEqual(["multi:a,b"]);
  });

  it("falls back per key and reports only the keys that failed", async () => {
    const e = env("throw", ["b"]);
    expect(await r2DeleteAll(e, ["a", "b", "c"])).toEqual(["b"]);
    expect(e.calls).toEqual(["multi:a,b,c", "single:a", "single:b", "single:c"]);
  });

  it("does nothing for an empty key list", async () => {
    const e = env("ok");
    expect(await r2DeleteAll(e, [])).toEqual([]);
    expect(e.calls).toEqual([]);
  });
});
