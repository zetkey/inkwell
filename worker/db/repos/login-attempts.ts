// Login throttle storage: one row per `email|ip` key.
//
// The counter is incremented with a single UPSERT so concurrent failed
// logins can't lose increments: a lapsed window restarts at 1, otherwise
// `fails` grows.

import { eq, lt, sql } from "drizzle-orm";
import type { LoginAttemptRow } from "../../lib/login-throttle";
import { LOGIN_WINDOW_MS } from "../../lib/login-throttle";
import type { Env } from "../../types";
import { getDb, t } from "../client";

export async function load(env: Env, key: string): Promise<LoginAttemptRow | null> {
  const db = getDb(env);
  const row = await db
    .select({ fails: t.login_attempts.fails, reset_at: t.login_attempts.reset_at })
    .from(t.login_attempts)
    .where(eq(t.login_attempts.key, key))
    .get();
  return row ?? null;
}

/** Record one failure and return the counter's new value. */
export async function recordFailure(env: Env, key: string, at: number): Promise<number> {
  const db = getDb(env);
  const resetAt = at + LOGIN_WINDOW_MS;
  const row = await db
    .insert(t.login_attempts)
    .values({ key, fails: 1, reset_at: resetAt })
    .onConflictDoUpdate({
      target: t.login_attempts.key,
      set: {
        fails: sql`CASE WHEN ${t.login_attempts.reset_at} <= ${at} THEN 1 ELSE ${t.login_attempts.fails} + 1 END`,
        reset_at: sql`CASE WHEN ${t.login_attempts.reset_at} <= ${at} THEN ${resetAt} ELSE ${t.login_attempts.reset_at} END`,
      },
    })
    .returning({ fails: t.login_attempts.fails })
    .get();
  return row?.fails ?? 1;
}

export async function clear(env: Env, key: string): Promise<void> {
  const db = getDb(env);
  await db.delete(t.login_attempts).where(eq(t.login_attempts.key, key)).run();
}

/** Drop rows whose window has lapsed. Called from the daily cron: a
 *  successful login already deletes its own key, so this only clears
 *  abandoned counters. Returns the number of rows removed. */
export async function deleteExpired(env: Env, at: number): Promise<number> {
  const db = getDb(env);
  const result = await db.delete(t.login_attempts).where(lt(t.login_attempts.reset_at, at)).run();
  return result.meta.changes ?? 0;
}
