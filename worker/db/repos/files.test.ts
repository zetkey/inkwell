/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteD1 } from "../../test-support/sqlite-d1";
import type { Env } from "../../types";
import { claimVersion, releaseVersion } from "./files";

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
  env = { DB: sqliteD1(db) } as unknown as Env;
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

describe("filesRepo.releaseVersion", () => {
  it("restores the previous version and blob-derived fields", async () => {
    expect(
      await claimVersion(env, "u1", "f1", { expectedVersion: 3, sizeBytes: 200, updatedAt: 10 }),
    ).toBe(4);

    const released = await releaseVersion(env, "u1", "f1", {
      expectedVersion: 4,
      sizeBytes: 100,
      updatedAt: 1,
    });

    expect(released).toBe(true);
    expect(read("version")).toBe(3);
    expect(read("size_bytes")).toBe(100);
    expect(read("updated_at")).toBe(1);
    // The client's original If-Match works again — no spurious 409.
    expect(
      await claimVersion(env, "u1", "f1", { expectedVersion: 3, sizeBytes: 200, updatedAt: 20 }),
    ).toBe(4);
  });

  it("never rolls back a version a later writer advanced", async () => {
    await claimVersion(env, "u1", "f1", { expectedVersion: 3, sizeBytes: 200, updatedAt: 10 });
    await claimVersion(env, "u1", "f1", { expectedVersion: 4, sizeBytes: 300, updatedAt: 11 });

    const released = await releaseVersion(env, "u1", "f1", {
      expectedVersion: 4,
      sizeBytes: 100,
      updatedAt: 1,
    });

    expect(released).toBe(false);
    expect(read("version")).toBe(5);
    expect(read("size_bytes")).toBe(300);
  });
});
