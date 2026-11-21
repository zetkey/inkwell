/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { LOGIN_WINDOW_MS } from "../../lib/login-throttle";
import { sqliteD1 } from "../../test-support/sqlite-d1";
import type { Env } from "../../types";
import { deleteExpired, load, recordFailure } from "./login-attempts";

let db: DatabaseSync;
let env: Env;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE login_attempts (
      key TEXT PRIMARY KEY,
      fails INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    )
  `);
  env = { DB: sqliteD1(db) } as unknown as Env;
});

function rows(): { key: string; fails: number; reset_at: number }[] {
  return db
    .prepare("SELECT key, fails, reset_at FROM login_attempts ORDER BY key")
    .all()
    .map((r) => ({ key: String(r.key), fails: Number(r.fails), reset_at: Number(r.reset_at) }));
}

describe("login attempts counter", () => {
  it("counts failures inside the window", async () => {
    const at = 1_000_000;
    expect(await recordFailure(env, "a|1.1.1.1", at)).toBe(1);
    expect(await recordFailure(env, "a|1.1.1.1", at + 1000)).toBe(2);
    expect((await load(env, "a|1.1.1.1"))?.fails).toBe(2);
  });

  it("restarts the window once it lapsed", async () => {
    const at = 1_000_000;
    await recordFailure(env, "a|1.1.1.1", at);
    await recordFailure(env, "a|1.1.1.1", at + 1000);

    const restarted = await recordFailure(env, "a|1.1.1.1", at + LOGIN_WINDOW_MS + 1);

    expect(restarted).toBe(1);
    expect((await load(env, "a|1.1.1.1"))?.reset_at).toBe(
      at + LOGIN_WINDOW_MS + 1 + LOGIN_WINDOW_MS,
    );
  });

  it("drops lapsed rows on the daily sweep and keeps active ones", async () => {
    const at = 1_000_000;
    db.exec(
      `INSERT INTO login_attempts VALUES ('lapsed|1.1.1.1', 5, ${at - 1}), ('active|2.2.2.2', 2, ${at + 1})`,
    );

    expect(await deleteExpired(env, at)).toBe(1);
    expect(rows()).toEqual([{ key: "active|2.2.2.2", fails: 2, reset_at: at + 1 }]);
  });
});
