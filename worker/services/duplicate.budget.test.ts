import { describe, expect, it } from "vitest";
import type { Env, FileRow } from "../types";
import { DuplicateError, duplicateItems } from "./duplicate";

function row(id: string): FileRow {
  return {
    id,
    owner: "u1",
    folder_id: null,
    name: id,
    kind: "excalidraw",
    version: 1,
    size_bytes: 10,
    has_thumb: false,
    thumb_updated_at: 0,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    trashed_via: null,
    starred_at: null,
  };
}

// Any DB or R2 touch is a failure: the budget check must run first.
function forbiddenEnv(): Env {
  const thrower = () => {
    throw new Error("storage touched before the copy budget check");
  };
  return {
    DB: { prepare: thrower, batch: thrower, exec: thrower },
    R2: { get: thrower, put: thrower, list: thrower, delete: thrower },
  } as unknown as Env;
}

describe("duplicate copy budget", () => {
  it("refuses 300 files up front without touching storage", async () => {
    const refs = Array.from({ length: 300 }, (_, i) => ({
      type: "file" as const,
      id: `f${i}`,
    }));
    const sourceFiles = new Map(refs.map((r) => [r.id, row(r.id)]));

    let error: unknown;
    try {
      await duplicateItems(forbiddenEnv(), "u1", refs, sourceFiles, undefined);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(DuplicateError);
    expect((error as DuplicateError).status).toBe(413);
    expect((error as DuplicateError).message).toContain("smaller batches");
  });
});
