/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteD1 } from "../../test-support/sqlite-d1";
import type { Env } from "../../types";
import { orphanTagIds, replaceForEntity } from "./tags";

describe("orphanTagIds", () => {
  it("never returns an id the request is keeping", () => {
    expect(orphanTagIds(["t1", "t2", "t3"], ["t2"])).toEqual(["t1", "t3"]);
  });

  it("returns nothing when every candidate is kept", () => {
    expect(orphanTagIds(["t1", "t2"], ["t1", "t2", "t3"])).toEqual([]);
  });

  it("returns every candidate when nothing is kept", () => {
    expect(orphanTagIds(["t1", "t2"], [])).toEqual(["t1", "t2"]);
  });
});

// Real-SQL check of the GC: clearing one target's tags must delete only
// the tags that target was the last user of.
describe("replaceForEntity tag GC", () => {
  let db: DatabaseSync;
  let env: Env;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tags (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE taggings (tag_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    env = { DB: sqliteD1(db) } as unknown as Env;
  });

  function tag(id: string, name: string, targetId: string) {
    db.prepare("INSERT INTO tags VALUES (?, 'u1', ?, 1)").run(id, name);
    db.prepare("INSERT INTO taggings VALUES (?, 'file', ?, 'u1', 1)").run(id, targetId);
  }

  function tagIds(): string[] {
    return db
      .prepare("SELECT id FROM tags ORDER BY id")
      .all()
      .map((r) => String(r.id));
  }

  it("deletes the tag only the cleared target used", async () => {
    tag("tA", "shared-elsewhere", "file-a");
    tag("tB", "only-b", "file-b");

    await replaceForEntity(env, "u1", "file", "file-a", []);

    expect(tagIds()).toEqual(["tB"]);
  });

  it("keeps a tag still attached to another target", async () => {
    tag("tBoth", "both", "file-a");
    db.prepare("INSERT INTO taggings VALUES ('tBoth', 'file', 'file-b', 'u1', 1)").run();

    await replaceForEntity(env, "u1", "file", "file-a", []);

    expect(tagIds()).toEqual(["tBoth"]);
  });
});
