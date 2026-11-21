// Static-site service.
//
// Owns everything that's specific to the `static-site` file kind:
//
//   * Manifest shape construction, validation, and read/write to R2.
//   * Asset path validation (relpath rules).
//   * Content-type resolution from extension.
//   * R2 layout for per-asset objects under `static-sites/<id>/<relpath>`.
//   * Bulk delete of an entire site's assets (used by file + user cascade).
//   * Mutators that keep the R2 truth and the manifest in lockstep —
//     the manifest is rewritten last so a crash leaves orphan R2
//     objects (harmless) but never a manifest pointing at missing data.
//
// The manifest is stored at the canonical `r2FileKey(id)` (i.e.
// `scenes/<id>.json`) so the existing `streamFileResponse` and
// `GET /api/files/:id` plumbing serves it without any kind branching.
// Direct PUTs of the manifest are rejected in `putFileBlob` — owners
// mutate via the asset endpoints, which call into here.

import { unzipSync } from "fflate";
import * as filesRepo from "../db/repos/files";
import { r2FileKey, r2StaticSiteAssetKey, r2StaticSitePrefix } from "../lib/keys";
import { r2DeleteAll } from "../lib/r2";
import { escapeMarkup, now } from "../lib/util";
import {
  type Env,
  type FileRow,
  isStaticSiteBlob,
  type StaticSiteAsset,
  type StaticSiteFileBlob,
} from "../types";

// ─── Caps ───────────────────────────────────────────────────────────
/** Single-asset upload cap. Independent of the 4 MiB blob cap: assets are
 *  served/streamed, never parsed as one JSON document by the Worker. */
export const MAX_SITE_ASSET_BYTES = 25 * 1024 * 1024;
/** Whole-site total cap (sum across all assets, uncompressed). */
export const MAX_SITE_TOTAL_BYTES = 25 * 1024 * 1024;
/** Maximum number of assets per site. */
export const MAX_SITE_ASSET_COUNT = 500;
/** Per-segment and full-path string caps. */
export const MAX_ASSET_PATH_BYTES = 1000;

// `lib/responses.ts#MAX_SITE_ZIP_BYTES` (the single-ZIP download cap) must
// stay below `MAX_SITE_TOTAL_BYTES`; a test asserts that.

// ─── Path validation ────────────────────────────────────────────────
//
// Asset paths are forward-slash, lowercased only in lookups (preserved
// in storage). Rules:
//   * no leading `/`
//   * no empty segments (rules out `foo//bar` and trailing `/`)
//   * no `.` or `..` segments
//   * no NUL or backslash anywhere
//   * length cap to avoid pathological R2 keys
//
// Returns null on success, an error message otherwise.
export function validateAssetPath(p: string): string | null {
  if (typeof p !== "string") return "path must be a string";
  if (!p) return "path required";
  if (p.length > MAX_ASSET_PATH_BYTES) return `path too long (max ${MAX_ASSET_PATH_BYTES} chars)`;
  if (p.startsWith("/")) return "path must not start with /";
  if (p.includes("\\")) return "path must not contain backslash";
  if (p.includes("\0")) return "path must not contain NUL";
  const parts = p.split("/");
  for (const seg of parts) {
    if (!seg) return "path must not contain empty segments";
    if (seg === "." || seg === "..") return "path must not contain . or .. segments";
    if (seg.length > 255) return "path segment too long";
  }
  return null;
}

/** Reject layouts where one path is a strict directory prefix of
 *  another (e.g. `assets` as a file vs. `assets/foo.css` as a dir).
 *  Operates on the *post-mutation* manifest. */
export function findPathPrefixCollision(paths: string[]): string | null {
  const set = new Set(paths);
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      const ancestor = segs.slice(0, i).join("/");
      if (set.has(ancestor)) {
        return `path "${p}" collides with file "${ancestor}"`;
      }
    }
  }
  return null;
}

// ─── ZIP intake ─────────────────────────────────────────────────────
/** Inflate an uploaded site ZIP with a pre-inflation size guard.
 *
 *  Each entry's header declares its uncompressed size, so the filter can
 *  reject a zip bomb before fflate allocates anything for it — the route's
 *  `content-length` check only sees compressed bytes. Throwing from the
 *  filter aborts the whole extraction. */
export function unzipSite(buf: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  let entries = 0;
  try {
    return unzipSync(buf, {
      filter: (file) => {
        const isDir = file.name.endsWith("/");
        // Only an **empty** directory entry is free: fflate still allocates
        // `originalSize` bytes for a `dir/` name, so a "directory" carrying a
        // payload must go through the size checks like any asset. It stays
        // out of the entry count either way.
        if (isDir && file.originalSize === 0) return true;
        if (!isDir) {
          entries += 1;
          if (entries > MAX_SITE_ASSET_COUNT) {
            throw new StaticSiteError(413, `too many entries (max ${MAX_SITE_ASSET_COUNT})`);
          }
        }
        if (file.originalSize > MAX_SITE_ASSET_BYTES) {
          throw new StaticSiteError(
            413,
            `asset "${file.name}" exceeds ${MAX_SITE_ASSET_BYTES} bytes`,
          );
        }
        total += file.originalSize;
        if (total > MAX_SITE_TOTAL_BYTES) {
          throw new StaticSiteError(413, `uncompressed site exceeds ${MAX_SITE_TOTAL_BYTES} bytes`);
        }
        return true;
      },
    });
  } catch (e) {
    if (e instanceof StaticSiteError) throw e;
    throw new StaticSiteError(400, "invalid ZIP");
  }
}

// ─── Content-type map ───────────────────────────────────────────────
const CONTENT_TYPE_MAP: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};

export function contentTypeForPath(p: string): string {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = p.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}

// ─── Manifest IO ────────────────────────────────────────────────────
export function emptyManifest(entry = "index.html"): StaticSiteFileBlob {
  return { kind: "static-site", entry, assets: [] };
}

/** Validate a parsed manifest. Returns null on success or an error
 *  message. Also enforces the path-prefix-collision invariant and that
 *  `entry` exists in `assets`. */
export function validateManifest(m: StaticSiteFileBlob): string | null {
  if (!isStaticSiteBlob(m)) return "invalid static-site manifest shape";
  const entryErr = validateAssetPath(m.entry);
  if (entryErr) return `entry: ${entryErr}`;
  if (m.assets.length === 0) return "static-site must have at least one asset";
  if (m.assets.length > MAX_SITE_ASSET_COUNT) {
    return `too many assets (max ${MAX_SITE_ASSET_COUNT})`;
  }
  const paths: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const a of m.assets) {
    const pErr = validateAssetPath(a.path);
    if (pErr) return `asset "${a.path}": ${pErr}`;
    if (seen.has(a.path)) return `duplicate asset path "${a.path}"`;
    seen.add(a.path);
    if (a.size < 0 || a.size > MAX_SITE_ASSET_BYTES) {
      return `asset "${a.path}" size out of range`;
    }
    total += a.size;
    paths.push(a.path);
  }
  if (total > MAX_SITE_TOTAL_BYTES) {
    return `site total ${total} exceeds cap ${MAX_SITE_TOTAL_BYTES}`;
  }
  const collision = findPathPrefixCollision(paths);
  if (collision) return collision;
  if (!seen.has(m.entry)) return `entry "${m.entry}" not present in assets`;
  return null;
}

export async function readManifest(env: Env, id: string): Promise<StaticSiteFileBlob | null> {
  const obj = await env.R2.get(r2FileKey(id));
  if (!obj) return null;
  try {
    const parsed = JSON.parse(await obj.text()) as unknown;
    return isStaticSiteBlob(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeManifest(
  env: Env,
  id: string,
  manifest: StaticSiteFileBlob,
): Promise<void> {
  // Always sort assets alphabetically before writing so diffs and
  // listings are deterministic.
  const sorted: StaticSiteFileBlob = {
    ...manifest,
    assets: [...manifest.assets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  await env.R2.put(r2FileKey(id), JSON.stringify(sorted), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Paginated delete of every R2 object under a site's prefix.
 *
 *  Returns true when every page deleted cleanly. A false result (or a
 *  throw from the listing) means objects may remain, which callers that
 *  also delete the D1 row — Trash purge — must treat as "row stays, retry
 *  next run" rather than swallow. */
export async function deleteAllStaticSiteAssets(env: Env, id: string): Promise<boolean> {
  const prefix = r2StaticSitePrefix(id);
  let ok = true;
  let cursor: string | undefined;
  do {
    const list = await env.R2.list({ prefix, cursor, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (keys.length > 0) {
      const failed = await r2DeleteAll(env, keys);
      if (failed.length > 0) ok = false;
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return ok;
}

// ─── Manifest mutations ─────────────────────────────────────────────
//
// All mutators take the *current* manifest, return the next one, and
// throw a typed error on validation failure. Callers are responsible
// for writing R2 objects (or removing them) before persisting the
// next manifest via `commitManifest`.

export class StaticSiteError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One asset's bytes + resolved metadata, ready to be written. */
export interface PendingAsset {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

/** Apply a batch of (path → bytes) upserts to a manifest in-place
 *  (immutably) and return the new manifest. Existing entries with the
 *  same path are replaced; the asset's `updatedAt` is refreshed.
 *
 *  Throws `StaticSiteError` if any path is invalid, if the resulting
 *  asset count exceeds `MAX_SITE_ASSET_COUNT`, if the resulting total
 *  size exceeds `MAX_SITE_TOTAL_BYTES`, or if any individual asset
 *  exceeds `MAX_SITE_ASSET_BYTES`. */
export function applyUpserts(
  manifest: StaticSiteFileBlob,
  pending: PendingAsset[],
): StaticSiteFileBlob {
  const ts = now();
  const next = new Map<string, StaticSiteAsset>();
  for (const a of manifest.assets) next.set(a.path, a);
  for (const p of pending) {
    const err = validateAssetPath(p.path);
    if (err) throw new StaticSiteError(400, `asset "${p.path}": ${err}`);
    if (p.bytes.byteLength > MAX_SITE_ASSET_BYTES) {
      throw new StaticSiteError(413, `asset "${p.path}" exceeds ${MAX_SITE_ASSET_BYTES} bytes`);
    }
    next.set(p.path, {
      path: p.path,
      size: p.bytes.byteLength,
      contentType: p.contentType,
      updatedAt: ts,
    });
  }
  if (next.size > MAX_SITE_ASSET_COUNT) {
    throw new StaticSiteError(413, `too many assets (max ${MAX_SITE_ASSET_COUNT})`);
  }
  let total = 0;
  for (const a of next.values()) total += a.size;
  if (total > MAX_SITE_TOTAL_BYTES) {
    throw new StaticSiteError(413, `site total ${total} exceeds cap ${MAX_SITE_TOTAL_BYTES}`);
  }
  const paths = Array.from(next.keys());
  const collision = findPathPrefixCollision(paths);
  if (collision) throw new StaticSiteError(409, collision);
  return {
    kind: "static-site",
    entry: manifest.entry,
    assets: Array.from(next.values()).sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
}

/** Remove one asset by path. Refuses to remove the entry (callers must
 *  change the entry first). */
export function applyDelete(manifest: StaticSiteFileBlob, path: string): StaticSiteFileBlob {
  if (!manifest.assets.some((a) => a.path === path)) {
    throw new StaticSiteError(404, `asset "${path}" not found`);
  }
  if (manifest.entry === path) {
    throw new StaticSiteError(409, `cannot delete entry asset "${path}" — change entry first`);
  }
  if (manifest.assets.length <= 1) {
    // Defense in depth: the entry-check above already catches this,
    // since a single-asset site has that asset as the entry.
    throw new StaticSiteError(409, "static-site must have at least one asset");
  }
  return {
    ...manifest,
    assets: manifest.assets.filter((a) => a.path !== path),
  };
}

/** Replace the entry. The new path must exist in the manifest. */
export function applySetEntry(manifest: StaticSiteFileBlob, path: string): StaticSiteFileBlob {
  const err = validateAssetPath(path);
  if (err) throw new StaticSiteError(400, `entry: ${err}`);
  if (!manifest.assets.some((a) => a.path === path)) {
    throw new StaticSiteError(404, `entry "${path}" not present in assets`);
  }
  return { ...manifest, entry: path };
}

/** Replace the entire asset set (used by ZIP-replace upload). */
export function applyReplaceAll(
  pending: PendingAsset[],
  preferredEntry: string,
): StaticSiteFileBlob {
  if (pending.length === 0) {
    throw new StaticSiteError(400, "static-site must have at least one asset");
  }
  const ts = now();
  const map = new Map<string, StaticSiteAsset>();
  let total = 0;
  for (const p of pending) {
    const err = validateAssetPath(p.path);
    if (err) throw new StaticSiteError(400, `asset "${p.path}": ${err}`);
    if (p.bytes.byteLength > MAX_SITE_ASSET_BYTES) {
      throw new StaticSiteError(413, `asset "${p.path}" exceeds ${MAX_SITE_ASSET_BYTES} bytes`);
    }
    if (map.has(p.path)) throw new StaticSiteError(409, `duplicate asset "${p.path}"`);
    total += p.bytes.byteLength;
    map.set(p.path, {
      path: p.path,
      size: p.bytes.byteLength,
      contentType: p.contentType,
      updatedAt: ts,
    });
  }
  if (map.size > MAX_SITE_ASSET_COUNT) {
    throw new StaticSiteError(413, `too many assets (max ${MAX_SITE_ASSET_COUNT})`);
  }
  if (total > MAX_SITE_TOTAL_BYTES) {
    throw new StaticSiteError(413, `site total ${total} exceeds cap ${MAX_SITE_TOTAL_BYTES}`);
  }
  const collision = findPathPrefixCollision(Array.from(map.keys()));
  if (collision) throw new StaticSiteError(409, collision);

  // Resolve entry: prefer the caller's choice if it exists, else the
  // shallowest .html file, else 400.
  let entry = preferredEntry;
  if (!map.has(entry)) {
    const htmls = Array.from(map.keys())
      .filter((p) => /\.html?$/i.test(p))
      .sort((a, b) => {
        const da = a.split("/").length;
        const db = b.split("/").length;
        if (da !== db) return da - db;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    if (htmls.length === 0) {
      throw new StaticSiteError(400, "no .html file found in upload — cannot pick entry");
    }
    entry = htmls[0];
  }

  return {
    kind: "static-site",
    entry,
    assets: Array.from(map.values()).sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
}

// ─── R2 + manifest co-write ─────────────────────────────────────────
//
// Two phases:
//   1. Validate via the in-memory mutator (throws on failure).
//   2. Write R2 objects, then write manifest, then bump the D1 row.
//
// The R2 writes happen *before* the manifest write so a partial crash
// leaves orphan R2 objects (cleaned on next `deleteAllStaticSiteAssets`)
// but never a manifest pointing at missing bytes.

/** Thrown when some assets of an upload were written before one failed,
 *  so callers can tell the user the site is partially updated. */
export class AssetWriteError extends Error {
  constructor(public written: number) {
    super(`asset write failed after ${written} object(s)`);
  }
}

/** Captured bytes of one asset that a pending write is about to replace. */
export interface AssetSnapshot {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

/** R2 reads issued in parallel while snapshotting old asset bytes. */
const SNAPSHOT_CONCURRENCY = 8;
/** R2 writes issued in parallel when putting snapped bytes back. */
const RESTORE_CONCURRENCY = 16;

/** Snapshot the current R2 bytes of every pending path that already exists
 *  in `manifest`, so a failed upload can put the previous bytes back.
 *
 *  Why: R2 overwrites are not transactional. The claim rollback restores
 *  the D1 `version`/`size_bytes`, but without this the asset objects the
 *  failed upload managed to write would keep serving new bytes under the
 *  old version — a reader that loaded version N would see content that is
 *  not version N.
 *
 *  Run this *before* claiming the next version: a read failure propagates
 *  (the caller refuses the request without touching D1), and the snapshot
 *  never sits inside the claim→manifest window. Reads run in bounded
 *  batches so a 300-asset overwrite still fans out a handful at a time.
 *
 *  A path whose object is missing from R2 is skipped — there is nothing to
 *  restore for it. */
export async function snapshotAssets(
  env: Env,
  id: string,
  manifest: StaticSiteFileBlob,
  pending: readonly PendingAsset[],
): Promise<AssetSnapshot[]> {
  const existing = new Map(manifest.assets.map((a) => [a.path, a]));
  const targets = pending.flatMap((p) => {
    const entry = existing.get(p.path);
    return entry ? [{ path: p.path, contentType: entry.contentType }] : [];
  });

  const out: AssetSnapshot[] = [];
  for (let i = 0; i < targets.length; i += SNAPSHOT_CONCURRENCY) {
    const batch = targets.slice(i, i + SNAPSHOT_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ path, contentType }) => {
        const obj = await env.R2.get(r2StaticSiteAssetKey(id, path));
        if (!obj) return null;
        return {
          path,
          bytes: new Uint8Array(await obj.arrayBuffer()),
          contentType,
        };
      }),
    );
    for (const r of results) if (r) out.push(r);
  }
  return out;
}

/** Put snapped bytes back after a failed write. Best-effort and never
 *  throws: the caller reports the 500 either way, and a path that cannot
 *  be restored is the same state a crash mid-upload would leave. Writes run
 *  in bounded batches so a 500-asset restore does not fire 500 puts at
 *  once. */
export async function restoreAssets(
  env: Env,
  id: string,
  snapshots: readonly AssetSnapshot[],
): Promise<void> {
  for (let i = 0; i < snapshots.length; i += RESTORE_CONCURRENCY) {
    const batch = snapshots.slice(i, i + RESTORE_CONCURRENCY);
    await Promise.allSettled(
      batch.map((s) =>
        env.R2.put(r2StaticSiteAssetKey(id, s.path), s.bytes, {
          httpMetadata: { contentType: s.contentType },
        }),
      ),
    );
  }
}

/** Write assets in modest parallel batches. Returns the number written;
 *  throws `AssetWriteError` (carrying the count that did land) on the
 *  first batch that fails. */
export async function writePendingAssets(
  env: Env,
  id: string,
  pending: PendingAsset[],
): Promise<number> {
  // Run uploads in modest parallel batches to avoid spraying every
  // request at R2 at once for large uploads.
  const BATCH = 16;
  let written = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      slice.map((p) =>
        env.R2.put(r2StaticSiteAssetKey(id, p.path), p.bytes, {
          httpMetadata: { contentType: p.contentType },
        }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    written += slice.length - failed;
    if (failed > 0) throw new AssetWriteError(written);
  }
  return written;
}

export async function deletePendingPaths(env: Env, id: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  // Best-effort: a leftover object is wasted storage, never a broken
  // manifest (the caller deletes assets only after publishing the new one).
  await r2DeleteAll(
    env,
    paths.map((p) => r2StaticSiteAssetKey(id, p)),
  );
}

export interface ManifestClaim {
  version: number;
  sizeBytes: number;
  updatedAt: number;
}

/** Claim the next manifest version *without* touching R2.
 *
 *  Asset-mutating routes call this first so a lost race leaves the stored
 *  manifest and assets untouched; they then write R2 and finish with
 *  `writeManifest`. Returns null when another writer already advanced the
 *  row (caller → 409). */
export async function claimManifestVersion(
  env: Env,
  row: FileRow,
  next: StaticSiteFileBlob,
): Promise<ManifestClaim | null> {
  const totalBytes = next.assets.reduce((a, b) => a + b.size, 0);
  const updatedAt = now();
  const version = await filesRepo.claimVersion(env, row.owner, row.id, {
    expectedVersion: row.version,
    sizeBytes: totalBytes,
    updatedAt,
  });
  if (version === null) return null;
  return { version, sizeBytes: totalBytes, updatedAt };
}

/** Undo a claim whose R2 work failed. Conditional on the row still being
 *  at the claimed version, so a later writer is never rolled back. */
export async function releaseManifestClaim(
  env: Env,
  row: FileRow,
  claim: ManifestClaim,
): Promise<void> {
  await filesRepo.releaseVersion(env, row.owner, row.id, {
    expectedVersion: claim.version,
    sizeBytes: row.size_bytes,
    updatedAt: row.updated_at,
  });
}

/** Commit a manifest + bump the file row's version, size, updated_at.
 *
 *  Claim first, write the manifest second, and roll the claim back if the
 *  write throws — a failed commit must not leave `version` ahead of the
 *  stored manifest. Returns the new version, or `null` when another writer
 *  already advanced the row (caller → 409). */
export async function commitManifest(
  env: Env,
  row: FileRow,
  next: StaticSiteFileBlob,
): Promise<ManifestClaim | null> {
  const claim = await claimManifestVersion(env, row, next);
  if (!claim) return null;
  try {
    await writeManifest(env, row.id, next);
  } catch (e) {
    await releaseManifestClaim(env, row, claim);
    throw e;
  }
  return claim;
}

// ─── Seed initial asset for a brand-new static-site ────────────────
//
// Called by `createFileInFolder` and the owner-side create endpoint
// right after the file row is inserted. Writes a minimal placeholder
// `index.html` to R2 and returns the seed manifest so the caller can
// store it as the canonical blob.

const SEED_INDEX_HTML = (name: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeMarkup(name)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.6; color: #1f2937; }
  h1 { font-weight: 700; letter-spacing: -0.01em; }
  p { color: #4b5563; }
  code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.95em; }
</style>
</head>
<body>
<h1>${escapeMarkup(name)}</h1>
<p>This is an empty static site. Upload files (or a <code>.zip</code> archive) to replace this page.</p>
</body>
</html>
`;

/** Build the seed asset bytes (no R2 writes). The caller chains this
 *  with `writeSeedSite` after the file row exists. */
export function buildSeedAsset(name: string): PendingAsset {
  const html = SEED_INDEX_HTML(name);
  return {
    path: "index.html",
    bytes: new TextEncoder().encode(html),
    contentType: contentTypeForPath("index.html"),
  };
}

/** Write the seed `index.html` to R2 and write the seed manifest.
 *  Returns the seed manifest and the seed byte count. */
export async function writeSeedSite(
  env: Env,
  id: string,
  name: string,
): Promise<{ manifest: StaticSiteFileBlob; bytes: number }> {
  const seed = buildSeedAsset(name);
  await writePendingAssets(env, id, [seed]);
  const manifest: StaticSiteFileBlob = {
    kind: "static-site",
    entry: "index.html",
    assets: [
      {
        path: seed.path,
        size: seed.bytes.byteLength,
        contentType: seed.contentType,
        updatedAt: now(),
      },
    ],
  };
  await writeManifest(env, id, manifest);
  return { manifest, bytes: seed.bytes.byteLength };
}
