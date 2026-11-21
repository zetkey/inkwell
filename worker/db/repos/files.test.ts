/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types";
import { claimVersion } from "./files";

// `claimVersion` is one conditional UPDATE, so its concurrency contract
// is SQL semantics: two claims against the same version, one wins.
// Exercise the real SQL against in-memory SQLite through a tiny
// D1-compatible binding instead of asserting on drizzle's output.
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              return { results: db.prepare(sql).all(...(params as SQLInputValue[])) };
            },
            async run() {
              const result = db.prepare(sql).run(...(params as SQLInputValue[]));
              return { success: true, meta: { changes: Number(result.changes) } };
            },
            // drizzle's typed `.get()` path goes through `.raw()`.
            async raw() {
              const stmt = db.prepare(sql);
              const names = stmt.columns().map((c) => c.name);
              return stmt
                .all(...(params as SQLInputValue[]))
                .map((row) => names.map((name) => row[name]));
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

let db: DatabaseSync;
let env: Env;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(
    "INSERT INTO files (id, owner, version, size_bytes, updated_at) VALUES ('f1', 'u1', 3, 100, 1)",
  );
  env = { DB: d1(db) } as unknown as Env;
});

function read(column: string): unknown {
  return db.prepare(`SELECT ${column} AS v FROM files WHERE id = 'f1'`).get()?.v;
}

describe("filesRepo.claimVersion", () => {
  it("lets the first claim on a version win and loses the second", async () => {
    expect(
      await claimVersion(env, "u1", "f1", { expectedVersion: 3, sizeBytes: 200, updatedAt: 10 }),
    ).toBe(4);
    expect(
      await claimVersion(env, "u1", "f1", { expectedVersion: 3, sizeBytes: 201, updatedAt: 11 }),
    ).toBeNull();

    expect(read("version")).toBe(4);
    // The losing claim must not have touched the blob-derived fields.
    expect(read("size_bytes")).toBe(200);
    expect(read("updated_at")).toBe(10);
  });

  it("always bumps when no version is expected", async () => {
    expect(await claimVersion(env, "u1", "f1", { sizeBytes: 300, updatedAt: 20 })).toBe(4);
    expect(await claimVersion(env, "u1", "f1", { sizeBytes: 400, updatedAt: 30 })).toBe(5);

    expect(read("version")).toBe(5);
    expect(read("size_bytes")).toBe(400);
  });

  it("does not claim a row owned by someone else", async () => {
    expect(await claimVersion(env, "u2", "f1", { sizeBytes: 1, updatedAt: 1 })).toBeNull();
    expect(read("version")).toBe(3);
  });
});
