/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteD1 } from "../test-support/sqlite-d1";
import type { Env, FileRow } from "../types";
import { copyOpsFor, DuplicateError, duplicateItems } from "./duplicate";

function row(id: string, overrides: Partial<FileRow> = {}): FileRow {
  return {
    id,
    owner: "u1",
    folder_id: null,
    name: id,
    kind: "excalidraw",
    version: 1,
    size_bytes: 10,
    mime: null,
    has_thumb: false,
    thumb_updated_at: 0,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    trashed_via: null,
    starred_at: null,
    ...overrides,
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

  it("counts four R2 ops per file and two per static-site asset", async () => {
    const plain = Array.from({ length: 267 }, (_, i) => row(`f${i}`, { has_thumb: true }));
    const site = row("site", { kind: "static-site" });
    const manifest = {
      kind: "static-site",
      entry: "index.html",
      assets: Array.from({ length: 500 }, (_, i) => ({
        path: `a${i}.txt`,
        size: 1,
        contentType: "text/plain",
        updatedAt: 0,
      })),
    };
    const env = {
      R2: {
        get: async () => ({
          text: async () => JSON.stringify(manifest),
        }),
      },
    } as unknown as Env;

    expect(await copyOpsFor(env, plain)).toBe(267 * 4);
    expect(await copyOpsFor(env, [site])).toBe(4 + 1 + 500 * 2);
  });
});

// Integration: real SQL for the plumbing, fake R2 for the copy itself.
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER, trashed_via TEXT, starred_at INTEGER,
      icon TEXT, color TEXT, description TEXT, status TEXT, pinned_at INTEGER
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, folder_id TEXT, name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'excalidraw', version INTEGER NOT NULL DEFAULT 1,
      size_bytes INTEGER NOT NULL DEFAULT 0, has_thumb INTEGER NOT NULL DEFAULT 0,
      thumb_updated_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, trashed_via TEXT, starred_at INTEGER,
      mime TEXT
    );
    CREATE TABLE taggings (
      tag_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      owner TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  return db;
}

function seedFile(db: DatabaseSync, id: string, overrides: Record<string, unknown> = {}) {
  const cols = {
    id,
    owner: "u1",
    folder_id: null,
    name: id,
    kind: "excalidraw",
    version: 1,
    size_bytes: 10,
    has_thumb: 0,
    thumb_updated_at: 0,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    trashed_via: null,
    starred_at: null,
    ...overrides,
  };
  const names = Object.keys(cols);
  db.prepare(
    `INSERT INTO files (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...(Object.values(cols) as never[]));
}

function storeEnv(db: DatabaseSync, options: { failGet?: string } = {}) {
  const store = new Map<string, string>([
    ["scenes/f1.json", '{"elements":[],"appState":{},"files":{}}'],
    ["scenes/f2.json", '{"elements":[],"appState":{},"files":{}}'],
  ]);
  const puts: string[] = [];
  const env = {
    DB: sqliteD1(db),
    R2: {
      get: async (key: string) => {
        if (options.failGet && key === options.failGet) throw new Error("R2 read failed");
        const found = store.get(key);
        if (found === undefined) return null;
        return { body: found, text: async () => found, httpMetadata: undefined };
      },
      put: async (key: string, value: unknown) => {
        puts.push(key);
        store.set(key, typeof value === "string" ? value : "bytes");
      },
      delete: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      },
      list: async () => ({ objects: [], truncated: false }),
    },
  } as unknown as Env;
  return { env, store, puts };
}

describe("duplicate budget in context", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  it("refuses a static site with 500 assets before copying anything", async () => {
    seedFile(db, "site", { kind: "static-site", size_bytes: 500 });
    const manifest = {
      kind: "static-site",
      entry: "a0.txt",
      assets: Array.from({ length: 500 }, (_, i) => ({
        path: `a${i}.txt`,
        size: 1,
        contentType: "text/plain",
        updatedAt: 0,
      })),
    };
    const env = {
      DB: sqliteD1(db),
      R2: {
        get: async () => ({ text: async () => JSON.stringify(manifest) }),
        put: async () => {
          throw new Error("must not copy");
        },
        list: async () => ({ objects: [], truncated: false }),
        delete: async () => {},
      },
    } as unknown as Env;

    let error: unknown;
    try {
      await duplicateItems(
        env,
        "u1",
        [{ type: "file", id: "site" }],
        new Map([["site", row("site", { kind: "static-site" })]]),
        undefined,
      );
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(DuplicateError);
    expect((error as DuplicateError).status).toBe(413);
    expect((error as DuplicateError).message).toContain("R2 budget");
  });

  it("removes the copies it already wrote when a later file fails", async () => {
    seedFile(db, "f1");
    seedFile(db, "f2");
    const { env, store } = storeEnv(db, { failGet: "scenes/f2.json" });
    const sourceFiles = new Map([
      ["f1", row("f1")],
      ["f2", row("f2")],
    ]);

    await expect(
      duplicateItems(
        env,
        "u1",
        [
          { type: "file", id: "f1" },
          { type: "file", id: "f2" },
        ],
        sourceFiles,
        undefined,
      ),
    ).rejects.toThrow();

    // Only the two source blobs remain: every copy was cleaned up.
    expect([...store.keys()].sort()).toEqual(["scenes/f1.json", "scenes/f2.json"]);
  });
});
