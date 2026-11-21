/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteD1 } from "../test-support/sqlite-d1";
import type { Env } from "../types";
import { purgeItems } from "./trash";

// Purge must not drop a D1 row whose R2 objects could not be deleted:
// the row is the only record that says the bytes still exist.
let db: DatabaseSync;

function seed() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'excalidraw',
      folder_id TEXT, name TEXT NOT NULL DEFAULT '', size_bytes INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER, trashed_via TEXT
    );
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, parent_id TEXT,
      name TEXT NOT NULL DEFAULT '', deleted_at INTEGER, trashed_via TEXT
    );
    CREATE TABLE taggings (
      tag_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      owner TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE shares (
      token TEXT PRIMARY KEY, owner TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  db.exec(
    "INSERT INTO files (id, owner, kind, deleted_at, name) VALUES ('f1', 'u1', 'excalidraw', 5, 'Gone')",
  );
}

function env(failDelete: boolean): Env {
  return {
    DB: sqliteD1(db),
    R2: {
      delete: async (keys: string | string[]) => {
        if (failDelete) throw new Error("R2 unavailable");
        void keys;
      },
      list: async () => ({ objects: [], truncated: false }),
    },
  } as unknown as Env;
}

function fileRows(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n);
}

beforeEach(seed);

describe("purgeItems R2 failure", () => {
  it("keeps the D1 row and reports the failure", async () => {
    const result = await purgeItems(env(true), "u1", [{ type: "file", id: "f1" }]);

    expect(result).toEqual({ purged: 0, failed: 1 });
    expect(fileRows()).toBe(1);
  });

  it("deletes the row once the objects are gone", async () => {
    const result = await purgeItems(env(false), "u1", [{ type: "file", id: "f1" }]);

    expect(result).toEqual({ purged: 1, failed: 0 });
    expect(fileRows()).toBe(0);
  });
});
