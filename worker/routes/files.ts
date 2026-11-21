// Owner-side file routes mounted at `/api/files`.
//
// File shares (`/api/files/:id/shares`) are mounted from the shares
// route module — see `worker/routes/shares.ts`.
//
// R2 layout (historical key prefix `scenes/{id}.json` is preserved —
// see worker/lib/responses.ts and the 0002_files_rename migration):
//   scenes/{id}.json   -- the file blob
//   thumbs/{id}.svg    -- optional SVG thumbnail
//
// Versioning: every successful PUT bumps `version` in D1. Clients
// should send `If-Match: <version>`; mismatch returns 409 with the
// current row.

import { Hono } from "hono";
import * as filesRepo from "../db/repos/files";
import * as foldersRepo from "../db/repos/folders";
import * as sharesRepo from "../db/repos/shares";
import * as tagsRepo from "../db/repos/tags";
import * as usersRepo from "../db/repos/users";
import { ownerRenderPayload, signRender } from "../lib/crypto";
import { bodyDeclaredTooLarge } from "../lib/http";
import { r2ThumbKey } from "../lib/keys";
import {
  errorResponse,
  jsonResponse,
  safeMime,
  serveThumb,
  streamFileResponse,
  streamRawFile,
} from "../lib/responses";
import { now } from "../lib/util";
import { requireSession } from "../middleware/auth";
import { parseJson, parseJsonOrEmpty } from "../middleware/body";
import type { AppEnv } from "../middleware/types";
import {
  createFile,
  createUploadedFile,
  MAX_FILE_BYTES,
  MAX_THUMB_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_USER_STORAGE_BYTES,
  mirrorRenameIntoExcalidrawBlob,
  normalizeImportedExcalidraw,
  putFileBlob,
} from "../services/file-blob";
import {
  type AssetSnapshot,
  AssetWriteError,
  applyDelete,
  applyReplaceAll,
  applySetEntry,
  applyUpserts,
  claimManifestVersion,
  commitManifest,
  contentTypeForPath,
  deletePendingPaths,
  MAX_SITE_ASSET_BYTES,
  MAX_SITE_ASSET_COUNT,
  MAX_SITE_TOTAL_BYTES,
  type PendingAsset,
  readManifest,
  releaseManifestClaim,
  restoreAssets,
  StaticSiteError,
  snapshotAssets,
  unzipSite,
  validateAssetPath,
  writeManifest,
  writePendingAssets,
} from "../services/static-site";
import { trashItems } from "../services/trash";
import type { FileKind, FileMeta, FileRow, StaticSiteFileBlob } from "../types";
import { normalizeFileKind, rowToMeta } from "../types";

const r = new Hono<AppEnv>();

r.use("*", requireSession);

// ─── List ────────────────────────────────────────────────────────────
//
// Query params:
//   folderId=<id>     — direct children of one folder
//   folderId=root     — files at the root level (folder_id IS NULL)
//   recursive=1       — combine with folderId=<id> for the whole subtree
//                       (ignored with folderId=root)
//   tag=<name>        — repeatable, AND-intersect by tag names
//   q=<text>          — case-insensitive name LIKE
//   starred=1         — only starred files, ordered by `starred_at DESC`
//   limit=<1..1000>   — max rows returned (applied after q/tag filters)
// No `folderId` param returns every file the caller owns. Trashed files
// never appear (the repo reads filter them out).
const MAX_LIST_LIMIT = 1000;

r.get("/", async (c) => {
  const owner = c.get("session").userId;
  const params = new URL(c.req.url).searchParams;

  let limit = MAX_LIST_LIMIT;
  const limitParam = params.get("limit");
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) {
      return errorResponse(400, `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    limit = n;
  }
  const starred = params.get("starred") === "1";

  const folderParam = params.get("folderId");
  const recursive = params.get("recursive") === "1";
  const tagFilters = params
    .getAll("tag")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const q = (params.get("q") || "").trim();
  const filtering = q !== "" || tagFilters.length > 0;
  // Without post-filters the repo can apply `limit` in SQL; otherwise
  // fetch the capped set and trim after filtering.
  const sqlLimit = filtering ? MAX_LIST_LIMIT : limit;

  let rows: FileRow[];
  if (folderParam === "root") {
    rows = await filesRepo.listAtRoot(c.env, owner);
  } else if (folderParam) {
    if (recursive) {
      const ids = await foldersRepo.descendantIds(c.env, owner, folderParam);
      rows = await foldersRepo.loadFilesInFolders(c.env, owner, ids);
    } else {
      rows = await filesRepo.listInFolder(c.env, owner, folderParam);
    }
  } else {
    rows = await filesRepo.listForOwner(c.env, owner, { starred, limit: sqlLimit });
  }
  // q/tag are applied in memory over the newest `MAX_LIST_LIMIT` rows, so
  // an older match beyond that window would vanish silently. Say so
  // instead: the client can narrow the query.
  const scanned = rows.length;
  const truncated = filtering && scanned >= MAX_LIST_LIMIT;

  if (starred && folderParam) {
    rows = rows
      .filter((r) => r.starred_at !== null)
      .sort((a, b) => (b.starred_at ?? 0) - (a.starred_at ?? 0));
  }

  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
  }

  const tagMap = await tagsRepo.collectForMany(
    c.env,
    "file",
    rows.map((r) => r.id),
  );
  if (tagFilters.length > 0) {
    rows = rows.filter((row) => {
      const t = tagMap.get(row.id) ?? [];
      return tagFilters.every((needle) => t.includes(needle));
    });
  }
  if (rows.length > limit) rows = rows.slice(0, limit);

  const shareMap = await sharesRepo.countActiveByTarget(
    c.env,
    owner,
    "file",
    rows.map((r) => r.id),
  );

  const out: FileMeta[] = rows.map((row) =>
    rowToMeta(row, tagMap.get(row.id) ?? [], { activeShareCount: shareMap.get(row.id) ?? 0 }),
  );
  return jsonResponse(filtering ? { files: out, truncated } : { files: out });
});

// ─── Create ──────────────────────────────────────────────────────────
interface CreateFileBody {
  name?: string;
  folderId?: string | null;
  tags?: string[];
  kind?: FileKind;
}

r.post("/", async (c) => {
  const owner = c.get("session").userId;
  const body = await parseJsonOrEmpty<CreateFileBody>(c);
  if (body instanceof Response) return body;
  const folderId: string | null = body.folderId ?? null;
  if (folderId !== null) {
    if (!(await foldersRepo.existsForOwner(c.env, owner, folderId))) {
      return errorResponse(404, "folder not found");
    }
  }

  const kind = normalizeFileKind(body.kind);
  // Generic files are opaque bytes: they are created only by POST
  // /api/files/upload, which streams the body. There is no JSON seed.
  if (kind === "file") {
    return errorResponse(400, "uploaded files are created via POST /api/files/upload");
  }

  const meta = await createFile(c.env, owner, folderId, body.name || "Untitled", kind, {
    tags: Array.isArray(body.tags) ? body.tags : undefined,
  });
  return jsonResponse(meta);
});

// ─── Import ──────────────────────────────────────────────────────────
//
// POST /api/files/import?name=<name>&folderId=<id>
//
// Body: the raw `.excalidraw` file, byte-for-byte as the user picked
// it. Creates an `excalidraw` file whose *initial* blob is the uploaded
// scene. Doing it in one request is the point: the create-then-PUT
// alternative would leave an empty file in the explorer whenever the
// PUT failed.
//
// The scene is normalized to Inkwell's stored blob shape (see
// `normalizeImportedExcalidraw`) so every downstream reader — download,
// rename mirroring, share rendering — sees the same shape the editor
// writes.
r.post("/import", async (c) => {
  const owner = c.get("session").userId;
  const params = new URL(c.req.url).searchParams;

  const folderId = params.get("folderId") || null;
  if (folderId !== null && !(await foldersRepo.existsForOwner(c.env, owner, folderId))) {
    return errorResponse(404, "folder not found");
  }

  if (bodyDeclaredTooLarge(c.req.raw, MAX_FILE_BYTES)) {
    return errorResponse(413, "file exceeds 4 MiB");
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) return errorResponse(400, "empty body");
  if (buf.byteLength > MAX_FILE_BYTES) return errorResponse(413, "file exceeds 4 MiB");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return errorResponse(400, "invalid JSON");
  }

  const name = (params.get("name") || "Untitled drawing").slice(0, 200);
  const blob = normalizeImportedExcalidraw(parsed, name);
  if (typeof blob === "string") return errorResponse(400, blob);

  const meta = await createFile(c.env, owner, folderId, name, "excalidraw", { seed: blob });
  return jsonResponse(meta);
});

// ─── Upload (generic file → kind "file") ─────────────────────────────
//
// POST /api/files/upload?name=<name>&folderId=<id>
//
// Body: the raw bytes (NOT multipart). The stored Content-Type comes from
// `?mime=` or the request's `Content-Type`. `Content-Length` is required
// — the body is streamed to R2 without buffering — and must not exceed
// `MAX_UPLOAD_BYTES`: 411 without it, 413 over the cap.
r.post("/upload", async (c) => {
  const owner = c.get("session").userId;
  const params = new URL(c.req.url).searchParams;

  const folderId = params.get("folderId") || null;
  if (folderId !== null && !(await foldersRepo.existsForOwner(c.env, owner, folderId))) {
    return errorResponse(404, "folder not found");
  }
  const name = (params.get("name") || "").trim().slice(0, 200);
  if (!name) return errorResponse(400, "name required");

  const lengthHeader = c.req.header("content-length");
  const size = lengthHeader === undefined ? Number.NaN : Number(lengthHeader);
  if (!Number.isInteger(size) || size < 0) return errorResponse(411, "Content-Length required");
  if (size > MAX_UPLOAD_BYTES) {
    return errorResponse(413, `file too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB)`);
  }

  const mime = safeMime(params.get("mime") || c.req.header("content-type"));

  // Quota first: refuse before the R2 write so an over-budget upload
  // leaves nothing behind. `size_bytes` counts Trash too (those blobs stay
  // in R2 until the purge), which the message points at.
  const used = await usersRepo.storageBytesUsed(c.env, owner);
  if (used + size > MAX_USER_STORAGE_BYTES) {
    const limit = Math.round(MAX_USER_STORAGE_BYTES / (1024 * 1024 * 1024));
    return errorResponse(
      413,
      `storage quota exceeded (${limit} GiB per user); empty Trash or delete files to free space`,
    );
  }

  const meta = await createUploadedFile(c.env, owner, folderId, name, {
    body: size === 0 ? null : c.req.raw.body,
    size,
    mime,
  });
  return jsonResponse(meta);
});

// ─── Read ────────────────────────────────────────────────────────────
// Metadata only — works for every kind, including uploaded files whose
// blob has no JSON form.
r.get("/:id/meta", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  const tags = await tagsRepo.listForEntity(c.env, "file", id);
  const shareMap = await sharesRepo.countActiveByTarget(c.env, owner, "file", [id]);
  return jsonResponse(rowToMeta(row, tags, { activeShareCount: shareMap.get(id) ?? 0 }));
});

// Raw bytes of an uploaded file, inline, with the stored Content-Type.
// HTML/SVG/XML are served with `Content-Security-Policy: sandbox`.
r.get("/:id/raw", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  if (row.kind !== "file") return errorResponse(400, "not an uploaded file");
  return await streamRawFile(c.env, row, { request: c.req.raw });
});

r.get("/:id", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  if (row.kind === "file") {
    return errorResponse(415, "uploaded file has no JSON blob; use /raw, /download or /meta");
  }
  return await streamFileResponse(c.env, row, { includeFolderId: true });
});

r.get("/:id/download", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  return await streamFileResponse(c.env, row, { download: true, includeFolderId: true });
});

// ─── Update (full body) ──────────────────────────────────────────────
//
// Body validation, R2 write, version bump, and JSON response live in
// `services/file-blob.ts#putFileBlob` so the share-token write paths
// can reuse them verbatim.
r.put("/:id", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  return await putFileBlob(c.env, row, c.req.raw);
});

// ─── Patch (rename / move / retag) ───────────────────────────────────
interface PatchFileBody {
  name?: string;
  folderId?: string | null;
  tags?: string[];
}

r.patch("/:id", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");

  const body = await parseJson<PatchFileBody>(c);
  if (body instanceof Response) return body;

  let nextName = row.name;
  let nextFolder: string | null = row.folder_id;

  if (body.name !== undefined) {
    const trimmed = body.name.trim().slice(0, 200);
    if (!trimmed) return errorResponse(400, "name required");
    nextName = trimmed;
  }
  if (body.folderId !== undefined && body.folderId !== row.folder_id) {
    if (body.folderId === null) {
      nextFolder = null;
    } else {
      if (!(await foldersRepo.existsForOwner(c.env, owner, body.folderId))) {
        return errorResponse(404, "folder not found");
      }
      nextFolder = body.folderId;
    }
  }

  const ts = now();
  await filesRepo.updateMeta(c.env, owner, id, {
    name: nextName,
    folder_id: nextFolder,
    updated_at: ts,
  });

  // Mirror the new name into the excalidraw blob's `appState.name`. We
  // deliberately do NOT bump `files.version` here — version is the
  // autosave optimistic-concurrency token, and bumping it would surface
  // as spurious 409s in an open editor mid-rename.
  // Excalidraw-only by design: drawio blobs carry an `mxfile`/`<diagram
  // name="…">` attribute that isn't surfaced in any Inkwell UI, so we
  // keep D1 as the canonical name and leave the XML untouched. Do NOT
  // add a drawio mirror here without first deciding whether the
  // `<diagram>` attr or any host-app metadata should track renames.
  if (body.name !== undefined && nextName !== row.name) {
    await mirrorRenameIntoExcalidrawBlob(c.env, row, nextName);
  }

  const tags = Array.isArray(body.tags)
    ? await tagsRepo.replaceForEntity(c.env, owner, "file", id, body.tags)
    : await tagsRepo.listForEntity(c.env, "file", id);

  return jsonResponse(
    rowToMeta({ ...row, name: nextName, folder_id: nextFolder, updated_at: ts }, tags),
  );
});

// PUT /api/files/:id/tags — replace the tag set.
interface PutTagsBody {
  tags?: unknown;
}

r.put("/:id/tags", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  const body = await parseJson<PutTagsBody>(c);
  if (body instanceof Response) return body;
  const tags = await tagsRepo.replaceForEntity(c.env, owner, "file", id, body.tags);
  // Bump updated_at so the dashboard re-renders the card.
  const ts = now();
  await filesRepo.updateMeta(c.env, owner, id, { updated_at: ts });
  return jsonResponse({ id, tags, updatedAt: ts });
});

// ─── Delete (→ Trash) ────────────────────────────────────────────────
// Kept for compatibility; now a soft delete. Permanent deletion goes
// through Trash (`/api/items/purge`, `/api/trash`, the daily cron).
r.delete("/:id", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  await trashItems(c.env, owner, [{ type: "file", id }]);
  return jsonResponse({ ok: true });
});

// ─── Thumbnails ──────────────────────────────────────────────────────
// putThumb: writes the SVG to R2 and advances `thumb_updated_at` on
// every successful upload (not just the first). The token is the
// cache-bust value the client appends to `<img src=...?v=N>`; bumping
// it on every write is what makes content-addressed URLs work.
r.put("/:id/thumb", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");

  if (bodyDeclaredTooLarge(c.req.raw, MAX_THUMB_BYTES)) {
    return errorResponse(413, "thumbnail too large");
  }
  const buf = await c.req.raw.arrayBuffer();
  if (buf.byteLength === 0) return errorResponse(400, "empty body");
  if (buf.byteLength > MAX_THUMB_BYTES) return errorResponse(413, "thumbnail too large");

  await c.env.R2.put(r2ThumbKey(id), buf, {
    httpMetadata: { contentType: "image/svg+xml" },
  });
  // Always update the bust token; conditionally flip `has_thumb`. We do
  // not touch `version` or `updated_at` so list ordering and content
  // versioning are unaffected by thumb activity.
  const ts = now();
  await filesRepo.updateMeta(
    c.env,
    owner,
    id,
    row.has_thumb ? { thumb_updated_at: ts } : { has_thumb: true, thumb_updated_at: ts },
  );
  return jsonResponse({ ok: true });
});

// getThumb: served via a content-addressed URL (`?v=<thumbUpdatedAt>`)
// so the response is safe to mark `immutable` for the browser, and we
// can store it in the Cloudflare edge cache. New content => new URL =>
// cold path runs again exactly once.
//
// The row lookup re-verifies ownership and hides thumbnails of trashed
// files (one indexed PK read ahead of the edge-cache lookup).
r.get("/:id/thumb", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  return await serveThumb(c.env, r2ThumbKey(id));
});

// ─── Static-site asset endpoints ────────────────────────────────────
//
// All four mutators share the same shape:
//   1. Load the file row, verify ownership + kind.
//   2. Read the current manifest from R2.
//   3. (`If-Match` precheck, mirroring the existing PUT contract.)
//   4. Mutate the manifest in memory via a `static-site.ts` helper
//      (throws `StaticSiteError` on validation failure).
//   5. Claim the next `version` (`claimManifestVersion`) — a lost race
//      returns 409 before any R2 write.
//   6. Publish the manifest and move the R2 objects: zip/delete write
//      the manifest first and touch assets around it (see each route);
//      upsert/entry use `commitManifest`, which claims and writes in one
//      step. A failed write rolls the claim back.
//   7. Return the refreshed `FileMeta` plus the new manifest.

async function loadStaticSite(
  env: AppEnv["Bindings"],
  owner: string,
  id: string,
): Promise<{ row: FileRow; manifest: StaticSiteFileBlob } | Response> {
  const row = await filesRepo.findById(env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  if (row.kind !== "static-site") return errorResponse(400, "file is not a static-site");
  const manifest = await readManifest(env, id);
  if (!manifest) return errorResponse(500, "manifest missing or invalid");
  return { row, manifest };
}

function checkIfMatch(req: Request, row: FileRow): Response | null {
  const ifMatch = req.headers.get("if-match");
  if (ifMatch === null) return null;
  const wanted = ifMatch.replace(/^"|"$/g, "");
  if (wanted !== String(row.version)) {
    return jsonResponse(
      { error: "version mismatch", currentVersion: row.version },
      { status: 409 },
    );
  }
  return null;
}

async function siteResponse(
  env: AppEnv["Bindings"],
  owner: string,
  row: FileRow,
  manifest: StaticSiteFileBlob,
  committed: { version: number; sizeBytes: number; updatedAt: number },
): Promise<Response> {
  const tags = await tagsRepo.listForEntity(env, "file", row.id);
  const shareMap = await sharesRepo.countActiveByTarget(env, owner, "file", [row.id]);
  const meta: FileMeta = {
    id: row.id,
    folderId: row.folder_id ?? null,
    name: row.name,
    kind: row.kind,
    tags,
    version: committed.version,
    sizeBytes: committed.sizeBytes,
    mime: row.mime ?? null,
    hasThumb: row.has_thumb,
    thumbUpdatedAt: row.thumb_updated_at,
    activeShareCount: shareMap.get(row.id) ?? 0,
    starredAt: row.starred_at ?? null,
    createdAt: row.created_at,
    updatedAt: committed.updatedAt,
  };
  return jsonResponse({ meta, manifest });
}

// GET /api/files/:id/manifest — convenience read for the editor tree.
// (The existing GET /api/files/:id already returns the same JSON, but
// this endpoint skips the `x-file-*` header dance and 415-on-binary-body
// expectations.)
r.get("/:id/manifest", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const loaded = await loadStaticSite(c.env, owner, id);
  if (loaded instanceof Response) return loaded;
  return jsonResponse(loaded.manifest);
});

// POST /api/files/:id/assets — multipart upload of one or more files.
//
// Each `file` part's `filename` is treated as the asset relpath
// (browsers can use `formData.append("file", file, file.webkitRelativePath)`
// to preserve folder structure when the user drops a directory).
//
// Replace-or-append semantics per path. Validation runs against the
// *post-mutation* manifest before any R2 write so a 413/400 reply
// leaves R2 unchanged.
r.post("/:id/assets", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const loaded = await loadStaticSite(c.env, owner, id);
  if (loaded instanceof Response) return loaded;
  const { row, manifest } = loaded;

  const mismatch = checkIfMatch(c.req.raw, row);
  if (mismatch) return mismatch;

  // Cheap precheck: refuse outsized request bodies before parsing.
  if (bodyDeclaredTooLarge(c.req.raw, MAX_SITE_TOTAL_BYTES)) {
    return errorResponse(413, `upload exceeds ${MAX_SITE_TOTAL_BYTES} bytes`);
  }

  let parsed: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    parsed = await c.req.parseBody({ all: true });
  } catch {
    return errorResponse(400, "invalid multipart body");
  }

  const pending: PendingAsset[] = [];
  let totalBytes = 0;
  // `c.req.parseBody({ all: true })` returns arrays for repeated keys.
  // Accept any field that resolves to a File-ish value.
  for (const value of Object.values(parsed)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!(item instanceof File)) continue;
      const path = item.name;
      const err = validateAssetPath(path);
      if (err) return errorResponse(400, `asset "${path}": ${err}`);
      if (item.size > MAX_SITE_ASSET_BYTES) {
        return errorResponse(413, `asset "${path}" exceeds ${MAX_SITE_ASSET_BYTES} bytes`);
      }
      // Content-Length may be absent (chunked); bound the accumulated
      // decoded size before reading any more parts into memory.
      totalBytes += item.size;
      if (totalBytes > MAX_SITE_TOTAL_BYTES) {
        return errorResponse(413, `upload exceeds ${MAX_SITE_TOTAL_BYTES} bytes`);
      }
      const bytes = new Uint8Array(await item.arrayBuffer());
      pending.push({
        path,
        bytes,
        contentType: contentTypeForPath(path),
      });
    }
  }
  if (pending.length === 0) return errorResponse(400, "no files in request");
  if (pending.length > MAX_SITE_ASSET_COUNT) {
    return errorResponse(413, `too many files (max ${MAX_SITE_ASSET_COUNT})`);
  }

  let nextManifest: StaticSiteFileBlob;
  try {
    nextManifest = applyUpserts(manifest, pending);
  } catch (e) {
    if (e instanceof StaticSiteError) return errorResponse(e.status, e.message);
    throw e;
  }

  // Snapshot before claiming: the bytes we capture are the ones readers at
  // the current version see, and a read failure means we cannot promise a
  // rollback — refuse without touching D1 or R2.
  let snapshot: AssetSnapshot[];
  try {
    snapshot = await snapshotAssets(c.env, id, manifest, pending);
  } catch {
    return errorResponse(500, "could not read the current site; nothing was changed");
  }
  // Same order as the ZIP route: claim first so a lost race leaves R2 alone.
  const claim = await claimManifestVersion(c.env, row, nextManifest);
  if (!claim) return errorResponse(409, "version mismatch");
  try {
    await writePendingAssets(c.env, id, pending);
    await writeManifest(c.env, id, nextManifest);
  } catch (e) {
    await restoreAssets(c.env, id, snapshot);
    await releaseManifestClaim(c.env, row, claim);
    const wroteSome = e instanceof AssetWriteError && e.written > 0;
    return errorResponse(
      500,
      wroteSome
        ? "site update failed after writing some assets; upload again"
        : "site update failed; the previous manifest is still in place",
    );
  }
  return siteResponse(c.env, owner, row, nextManifest, claim);
});

// POST /api/files/:id/assets/zip — raw ZIP body, replace mode.
//
// The whole prior asset set is dropped; any single top-level directory
// in the ZIP is stripped so `mybundle/index.html` becomes `index.html`.
// If the existing `entry` survives the upload it stays as entry;
// otherwise the shallowest .html file in the new bundle is picked.
r.post("/:id/assets/zip", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const loaded = await loadStaticSite(c.env, owner, id);
  if (loaded instanceof Response) return loaded;
  const { row, manifest } = loaded;

  const mismatch = checkIfMatch(c.req.raw, row);
  if (mismatch) return mismatch;

  if (bodyDeclaredTooLarge(c.req.raw, MAX_SITE_TOTAL_BYTES)) {
    return errorResponse(413, `upload exceeds ${MAX_SITE_TOTAL_BYTES} bytes`);
  }

  const buf = await c.req.raw.arrayBuffer();
  if (buf.byteLength === 0) return errorResponse(400, "empty body");
  // Content-Length may be absent (chunked); bound the buffered body too.
  if (buf.byteLength > MAX_SITE_TOTAL_BYTES) {
    return errorResponse(413, `upload exceeds ${MAX_SITE_TOTAL_BYTES} bytes`);
  }

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSite(new Uint8Array(buf));
  } catch (e) {
    if (e instanceof StaticSiteError) return errorResponse(e.status, e.message);
    return errorResponse(400, "invalid ZIP");
  }

  // Drop ZIP directory entries (paths ending in `/`) and any empty
  // keys before any further processing. Many `zip -r` flavors emit
  // explicit directory entries; treating them as files would either
  // trip path validation or pollute the common-prefix scan.
  const entries: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(raw)) {
    if (!path || path.endsWith("/")) continue;
    entries[path] = bytes;
  }

  // Strip a single common top-level directory, if any. This matches
  // richdoc's export shape (`out.zip` containing `out/index.html`).
  const stripped = stripCommonPrefix(entries);

  const pending: PendingAsset[] = [];
  for (const [path, bytes] of Object.entries(stripped)) {
    if (!path) continue;
    const err = validateAssetPath(path);
    if (err) return errorResponse(400, `entry "${path}": ${err}`);
    pending.push({
      path,
      bytes,
      contentType: contentTypeForPath(path),
    });
  }

  let nextManifest: StaticSiteFileBlob;
  try {
    // Try to preserve the existing entry, else `applyReplaceAll`
    // picks the shallowest .html.
    nextManifest = applyReplaceAll(pending, manifest.entry);
  } catch (e) {
    if (e instanceof StaticSiteError) return errorResponse(e.status, e.message);
    throw e;
  }

  // Snapshot the paths this bundle will overwrite before claiming (see the
  // multipart route): a read failure refuses the request untouched, and the
  // claim→manifest window stays short.
  let snapshot: AssetSnapshot[];
  try {
    snapshot = await snapshotAssets(c.env, id, manifest, pending);
  } catch {
    return errorResponse(500, "could not read the current site; nothing was changed");
  }

  // Claim before any R2 mutation: a lost race must leave the old site
  // byte-for-byte intact, so the 409 path never writes or deletes.
  const claim = await claimManifestVersion(c.env, row, nextManifest);
  if (!claim) return errorResponse(409, "version mismatch");

  try {
    // Overwrite in place, then publish the manifest. Existing paths are
    // simply replaced; leftovers are removed after the manifest landed.
    await writePendingAssets(c.env, id, pending);
    await writeManifest(c.env, id, nextManifest);
  } catch (e) {
    await restoreAssets(c.env, id, snapshot);
    await releaseManifestClaim(c.env, row, claim);
    const wroteSome = e instanceof AssetWriteError && e.written > 0;
    return errorResponse(
      500,
      wroteSome
        ? "site update failed after writing some assets; upload again"
        : "site update failed; the previous manifest is still in place",
    );
  }

  // Best-effort cleanup of assets the new manifest no longer references
  // (`deletePendingPaths` never throws). A failed delete leaves orphan
  // R2 objects, never a manifest pointing at missing bytes.
  const nextPaths = new Set(nextManifest.assets.map((a) => a.path));
  await deletePendingPaths(
    c.env,
    id,
    manifest.assets.map((a) => a.path).filter((p) => !nextPaths.has(p)),
  );
  return siteResponse(c.env, owner, row, nextManifest, claim);
});

// DELETE /api/files/:id/assets/:path{.+} — remove one asset by
// relpath. Hono's bare `*` wildcard isn't exposed as a route
// parameter, so we use a regex-named param `:path{.+}` which
// matches "any non-empty remainder including slashes."
r.delete("/:id/assets/:path{.+}", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  // `c.req.param('path')` returns the captured tail with slashes
  // preserved. Already URL-decoded by Hono.
  const path = c.req.param("path") ?? "";
  const pathErr = validateAssetPath(path);
  if (pathErr) return errorResponse(400, pathErr);

  const loaded = await loadStaticSite(c.env, owner, id);
  if (loaded instanceof Response) return loaded;
  const { row, manifest } = loaded;

  const mismatch = checkIfMatch(c.req.raw, row);
  if (mismatch) return mismatch;

  let nextManifest: StaticSiteFileBlob;
  try {
    nextManifest = applyDelete(manifest, path);
  } catch (e) {
    if (e instanceof StaticSiteError) return errorResponse(e.status, e.message);
    throw e;
  }

  // Claim first, then publish the manifest, and only then delete the
  // object: a lost race or a failed write leaves the old manifest
  // pointing at bytes that still exist.
  const claim = await claimManifestVersion(c.env, row, nextManifest);
  if (!claim) return errorResponse(409, "version mismatch");
  try {
    await writeManifest(c.env, id, nextManifest);
  } catch {
    await releaseManifestClaim(c.env, row, claim);
    return errorResponse(500, "site update failed; the previous manifest is still in place");
  }
  await deletePendingPaths(c.env, id, [path]);
  return siteResponse(c.env, owner, row, nextManifest, claim);
});

// POST /api/files/:id/render-session — mint a short-lived signed URL
// prefix the owner's editor (or any preview iframe) can use to serve
// the site through `/sites/:id/:sig/<relpath>`.
//
// No payload is required — the owner is taken from the session and
// the signature is bound to (file id, owner id). The returned prefix
// has a trailing slash so the caller can concat `manifest.entry`.
r.post("/:id/render-session", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const row = await filesRepo.findById(c.env, owner, id);
  if (!row) return errorResponse(404, "file not found");
  if (row.kind !== "static-site") return errorResponse(400, "file is not a static-site");
  const signed = await signRender(c.env.SESSION_SECRET, ownerRenderPayload(row.id, row.owner));
  return jsonResponse({
    prefix: `/sites/${row.id}/${signed.sig}/`,
    expiresAt: signed.expiresAt,
  });
});

// PUT /api/files/:id/entry — set the entry asset.
r.put("/:id/entry", async (c) => {
  const owner = c.get("session").userId;
  const id = c.req.param("id");
  const body = await parseJson<{ path?: unknown }>(c);
  if (body instanceof Response) return body;
  if (typeof body.path !== "string") return errorResponse(400, "path required");

  const loaded = await loadStaticSite(c.env, owner, id);
  if (loaded instanceof Response) return loaded;
  const { row, manifest } = loaded;

  const mismatch = checkIfMatch(c.req.raw, row);
  if (mismatch) return mismatch;

  let nextManifest: StaticSiteFileBlob;
  try {
    nextManifest = applySetEntry(manifest, body.path);
  } catch (e) {
    if (e instanceof StaticSiteError) return errorResponse(e.status, e.message);
    throw e;
  }

  const committed = await commitManifest(c.env, row, nextManifest);
  if (!committed) return errorResponse(409, "version mismatch");
  return siteResponse(c.env, owner, row, nextManifest, committed);
});

/**
 * If every key in `entries` shares the same top-level directory,
 * strip it. Otherwise return `entries` unchanged. Helps users who
 * `zip -r mybundle.zip mybundle/` end up with a flat layout.
 */
function stripCommonPrefix(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const keys = Object.keys(entries).filter((k) => k.length > 0);
  if (keys.length === 0) return entries;
  const first = keys[0];
  const slash = first.indexOf("/");
  if (slash < 0) return entries;
  const prefix = first.slice(0, slash + 1);
  for (const k of keys) {
    if (!k.startsWith(prefix)) return entries;
  }
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k.slice(prefix.length)] = v;
  }
  return out;
}

export default r;
