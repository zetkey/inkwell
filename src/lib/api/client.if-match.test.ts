// The worker now REQUIRES `If-Match` on every blob PUT (428 without it),
// so each save path must carry the version it read.

import { afterEach, describe, expect, it, vi } from "vitest";
import { files, shares } from "./client";

const BLOB = { kind: "notes", format: "markdown-v1", source: "hello" } as const;

function stubFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const meta = { id: "f1", name: "Doc", kind: "notes", version: 8, updatedAt: 1, starredAt: null };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return Promise.resolve(
      new Response(JSON.stringify(meta), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("blob saves send If-Match", () => {
  it("files.save", async () => {
    const calls = stubFetch();

    await files.save("f1", 7, BLOB);

    expect(calls[0].url).toBe("/api/files/f1");
    expect(calls[0].headers["if-match"]).toBe('"7"');
  });

  it("shares.save", async () => {
    const calls = stubFetch();

    await shares.save("tok-1", 7, BLOB);

    expect(calls[0].url).toBe("/api/share/tok-1");
    expect(calls[0].headers["if-match"]).toBe('"7"');
  });

  it("shares.saveFolderFile", async () => {
    const calls = stubFetch();

    await shares.saveFolderFile("tok-1", "f1", 7, BLOB);

    expect(calls[0].url).toBe("/api/share/tok-1/files/f1");
    expect(calls[0].headers["if-match"]).toBe('"7"');
  });
});
