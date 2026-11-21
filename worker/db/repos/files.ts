// File repository: pure data access for `files`.
//
// Every read here filters out trashed rows via `notTrashed` unless the
// function name says otherwise (`…IncludingTrashed`). Trash-aware code
// lives in `services/trash.ts`.

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Env, FileRow } from "../../types";
import { getDb, t } from "../client";
import { notTrashed } from "../filters";

export async function findById(env: Env, owner: string, id: string): Promise<FileRow | null> {
  const db = getDb(env);
  const row = await db
    .select()
    .from(t.files)
    .where(and(eq(t.files.id, id), eq(t.files.owner, owner), notTrashed(t.files)))
    .get();
  return row ?? null;
}

// Trash endpoints need to see rows regardless of `deleted_at`.
export async function findByIdIncludingTrashed(
  env: Env,
  owner: string,
  id: string,
): Promise<FileRow | null> {
  const db = getDb(env);
  const row = await db
    .select()
    .from(t.files)
    .where(and(eq(t.files.id, id), eq(t.files.owner, owner)))
    .get();
  return row ?? null;
}

// No owner filter — used by share-token reads and folder-share child
// access where the owner is determined by the share row, not the caller.
// Trashed files are invisible here, which is what makes share links to
// trashed items 404.
export async function findByIdAnyOwner(env: Env, id: string): Promise<FileRow | null> {
  const db = getDb(env);
  const row = await db
    .select()
    .from(t.files)
    .where(and(eq(t.files.id, id), notTrashed(t.files)))
    .get();
  return row ?? null;
}

export async function listForOwner(
  env: Env,
  owner: string,
  opts: { limit?: number; starred?: boolean } = {},
): Promise<FileRow[]> {
  const db = getDb(env);
  const limit = opts.limit ?? 1000;
  if (opts.starred) {
    return await db
      .select()
      .from(t.files)
      .where(and(eq(t.files.owner, owner), notTrashed(t.files), isNotNull(t.files.starred_at)))
      .orderBy(desc(t.files.starred_at))
      .limit(limit)
      .all();
  }
  return await db
    .select()
    .from(t.files)
    .where(and(eq(t.files.owner, owner), notTrashed(t.files)))
    .orderBy(desc(t.files.updated_at))
    .limit(limit)
    .all();
}

// Every file id + kind the owner has, trashed or not, uncapped. Used by
// user deletion, which must clean up R2 for everything.
export async function listAllIdsIncludingTrashed(
  env: Env,
  owner: string,
): Promise<{ id: string; kind: FileRow["kind"] }[]> {
  const db = getDb(env);
  return await db
    .select({ id: t.files.id, kind: t.files.kind })
    .from(t.files)
    .where(eq(t.files.owner, owner))
    .all();
}

export async function listInFolder(
  env: Env,
  owner: string,
  folderId: string,
  limit = 1000,
): Promise<FileRow[]> {
  const db = getDb(env);
  return await db
    .select()
    .from(t.files)
    .where(and(eq(t.files.owner, owner), eq(t.files.folder_id, folderId), notTrashed(t.files)))
    .orderBy(desc(t.files.updated_at))
    .limit(limit)
    .all();
}

export async function listAtRoot(env: Env, owner: string, limit = 1000): Promise<FileRow[]> {
  const db = getDb(env);
  return await db
    .select()
    .from(t.files)
    .where(and(eq(t.files.owner, owner), isNull(t.files.folder_id), notTrashed(t.files)))
    .orderBy(desc(t.files.updated_at))
    .limit(limit)
    .all();
}

// ─── Mutations ───────────────────────────────────────────────────────
export async function insert(env: Env, row: FileRow): Promise<void> {
  const db = getDb(env);
  await db.insert(t.files).values(row).run();
}

/** Atomically advance `version` (and the blob-derived fields) by one.
 *
 *  One conditional UPDATE, so concurrent saves cannot both succeed: pass
 *  `expectedVersion` (the client's `If-Match`) and only the writer whose
 *  version still matches gets a new version back; everyone else gets
 *  `null` and must reload. With no `expectedVersion` the bump is still
 *  atomic — it just doesn't lose to a version check.
 *
 *  Returns the new version, or `null` when no row matched.
 */
export async function claimVersion(
  env: Env,
  owner: string,
  id: string,
  patch: { expectedVersion?: number; sizeBytes: number; updatedAt: number },
): Promise<number | null> {
  const db = getDb(env);
  const conds = [eq(t.files.id, id), eq(t.files.owner, owner)];
  if (patch.expectedVersion !== undefined) {
    conds.push(eq(t.files.version, patch.expectedVersion));
  }
  const row = await db
    .update(t.files)
    .set({
      version: sql`${t.files.version} + 1`,
      size_bytes: patch.sizeBytes,
      updated_at: patch.updatedAt,
    })
    .where(and(...conds))
    .returning({ version: t.files.version })
    .get();
  return row?.version ?? null;
}

export async function updateMeta(
  env: Env,
  owner: string,
  id: string,
  patch: Partial<FileRow>,
): Promise<void> {
  const db = getDb(env);
  await db
    .update(t.files)
    .set(patch)
    .where(and(eq(t.files.id, id), eq(t.files.owner, owner)))
    .run();
}
