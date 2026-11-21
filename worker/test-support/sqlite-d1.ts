/// <reference types="node" />
// Test-only D1 binding over in-memory SQLite.
//
// Lets repo tests exercise the real SQL (conditional UPDATEs, RETURNING,
// ON CONFLICT) instead of asserting on drizzle's generated strings, with
// no Miniflare or network. Implements just the surface drizzle's D1
// session touches: `prepare().bind().{all,run,raw}`.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export function sqliteD1(db: DatabaseSync): D1Database {
  return {
    // drizzle's `db.batch` runs statements in order; a single D1 batch is
    // one transaction, which in-memory SQLite already gives us here.
    async batch(statements: D1PreparedStatement[]) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
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
