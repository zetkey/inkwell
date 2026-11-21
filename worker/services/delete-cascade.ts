// Permanent deletes and their R2 cleanup.
//
// Owner-facing "delete" is a soft delete now (see `services/trash.ts`);
// rows only disappear for real through Trash purge (`purgeItems`,
// `emptyTrash`, the daily `purgeExpired` cron) and user deletion. Both
// funnel their R2 cleanup through `deleteFileObjects` below so there is
// exactly one definition of "every R2 object a file owns".
//
// D1 honors FKs only with `PRAGMA foreign_keys = ON` (per connection),
// which Drizzle does NOT set. So we cascade explicitly.

import { eq } from "drizzle-orm";
import { getDb, t } from "../db/client";
import { chunk } from "../db/filters";
import * as filesRepo from "../db/repos/files";
import { r2FileKey, r2ThumbKey } from "../lib/keys";
import type { Env, FileKind } from "../types";
import { deleteAllStaticSiteAssets } from "./static-site";

// R2's multi-key delete accepts up to 1000 keys per call.
const R2_DELETE_BATCH = 1000;

/**
 * Removal of every R2 object owned by the given files: the blob
 * (`scenes/{id}.json`), the thumbnail and — for static sites — the whole
 * `static-sites/{id}/` prefix. When `kind` is unknown the prefix is listed
 * anyway (a no-op for non-sites) so callers can't under-clean.
 *
 * Blob + thumb keys go out in multi-key deletes so a large purge stays
 * well under the Worker subrequest budget; only static sites need the
 * per-file list call.
 *
 * Returns the ids whose cleanup failed. User deletion ignores it (best
 * effort); Trash purge uses it to keep those rows so a later run retries
 * instead of orphaning blobs.
 */
export async function deleteFileObjects(
  env: Env,
  files: readonly { id: string; kind?: FileKind }[],
): Promise<string[]> {
  if (files.length === 0) return [];
  const keyOwner = new Map<string, string>();
  for (const f of files) {
    keyOwner.set(r2FileKey(f.id), f.id);
    keyOwner.set(r2ThumbKey(f.id), f.id);
  }
  const failed = new Set<string>();
  for (const batch of chunk([...keyOwner.keys()], R2_DELETE_BATCH)) {
    try {
      await env.R2.delete(batch);
    } catch {
      // Retry one-by-one so only the keys that really failed keep their
      // row (a multi-delete error doesn't say which key was at fault).
      const results = await Promise.allSettled(batch.map((k) => env.R2.delete(k)));
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          const id = keyOwner.get(batch[i]);
          if (id) failed.add(id);
        }
      });
    }
  }
  await Promise.all(
    files
      .filter((f) => f.kind === undefined || f.kind === "static-site")
      .map(async (f) => {
        try {
          if (!(await deleteAllStaticSiteAssets(env, f.id))) failed.add(f.id);
        } catch {
          failed.add(f.id);
        }
      }),
  );
  return [...failed];
}

// Delete a user and everything they own: files (rows + R2 + thumbs),
// folders, tags + taggings, shares, and invites they created. Trashed
// files are included — they still own R2 objects.
// Best-effort on R2: a partial failure leaves orphan objects but D1
// stays consistent.
export async function deleteUserCascade(env: Env, userId: string): Promise<void> {
  const db = getDb(env);
  const fileRefs = await filesRepo.listAllIdsIncludingTrashed(env, userId);

  // Wipe owner-scoped rows from organization tables. Order matters
  // only for FK-honoring engines; with `PRAGMA foreign_keys = ON` D1
  // would cascade most of these. We run them explicitly so behavior
  // is the same on a connection without the pragma.
  await db.batch([
    db.delete(t.shares).where(eq(t.shares.owner, userId)),
    db.delete(t.taggings).where(eq(t.taggings.owner, userId)),
    db.delete(t.tags).where(eq(t.tags.owner, userId)),
    db.delete(t.files).where(eq(t.files.owner, userId)),
  ]);

  await deleteFileObjects(env, fileRefs);

  // Folders go after files (folders may be referenced by files via
  // ON DELETE SET NULL; with all the user's files gone it's a clean drop).
  // Then invites created by the user, then the user row itself.
  await db.batch([
    db.delete(t.folders).where(eq(t.folders.owner, userId)),
    db.delete(t.invites).where(eq(t.invites.created_by, userId)),
    db.delete(t.users).where(eq(t.users.id, userId)),
  ]);
}
