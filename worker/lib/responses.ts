// HTTP response helpers shared across routes.
//
// Routes return `Response` objects directly (they do not throw HttpError;
// the error middleware handles uncaught exceptions only). These helpers
// exist so handlers can stay one-liners and so behaviorally significant
// response shapes (the `{error}` envelope, R2-cached thumbnails, file
// downloads) live in one place rather than being copy-pasted.

import { zipSync } from "fflate";
import { isStaticSiteBlob, r2StaticSiteAssetKey } from "../services/static-site";
import type { ExcalidrawFileBlob, FileBlob, FileKind, FileRow } from "../types";
import { assertNever } from "./util";

/** Total site bytes we will ZIP for a download. Store-only `zipSync`
 *  costs ~2.4 ms per MiB of incompressible bytes in workerd (measured
 *  4 MB ≈ 9 ms), so 3 MiB leaves headroom under the Free plan's 10 ms
 *  CPU budget for the manifest read and R2 fan-out. */
export const MAX_SITE_ZIP_BYTES = 3 * 1024 * 1024;

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}

// ─── R2-cached thumbnails ─────────────────────────────────────────────
// Used by both the owner endpoint (`/api/files/:id/thumb`) and the
// share-token endpoints (`/api/share/:token/thumb`,
// `/api/share/:token/files/:fileId/thumb`).
//
// Cache key is the request URL only (no per-user partitioning), which
// is safe because:
//   1. The auth gate (or share-token resolution) runs upstream — only
//      authenticated/token-valid callers ever reach this helper.
//   2. File IDs are unguessable.
// Pre-existing soft leak (no owner check on owner-side thumbs) is
// documented for follow-up; this caching layer doesn't make it worse.
export async function serveR2WithCache(
  env: { R2: R2Bucket },
  ctx: { waitUntil(promise: Promise<unknown>): void } | null,
  req: Request | null,
  key: string,
): Promise<Response> {
  const cache = caches.default;
  if (req) {
    const cached = await cache.match(req);
    if (cached) return cached;
  }
  const obj = await env.R2.get(key);
  if (!obj) return errorResponse(404, "no thumbnail");
  const resp = new Response(obj.body, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Content-addressed URL (`?v=<thumbUpdatedAt>`) ⇒ a given URL
      // never changes content. Safe to mark immutable.
      "cache-control": "private, max-age=31536000, immutable",
      etag: obj.httpEtag,
    },
  });
  if (req && ctx) ctx.waitUntil(cache.put(req, resp.clone()));
  return resp;
}

// ─── File blob streaming ─────────────────────────────────────────────
// Streams the R2-stored file blob to the caller with the canonical set
// of `x-file-*` response headers the SPA reads. Used by:
//   * GET /api/files/:id  (owner)
//   * GET /api/files/:id/download  (owner, with download=true)
//   * GET /api/share/:token  (file share)
//   * GET /api/share/:token/download  (file share)
//   * GET /api/share/:token/files/:fileId  (folder share child)
//   * GET /api/share/:token/files/:fileId/download  (folder share child)
//
// `includeFolderId` is owner-only: we don't surface owner-side folder
// IDs to share-token recipients. The same flag gates `x-file-starred-at`
// (unix-ms, or "" when not starred) — stars are the owner's private state.
export async function streamFileResponse(
  env: { R2: R2Bucket },
  row: FileRow,
  opts: { download?: boolean; includeFolderId?: boolean } = {},
): Promise<Response> {
  const obj = await env.R2.get(r2FileKey(row.id));
  if (!obj) return errorResponse(404, "file blob missing in R2");
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    etag: `"${row.version}"`,
    "x-file-id": row.id,
    "x-file-name": encodeURIComponent(row.name),
    "x-file-kind": row.kind,
    "x-file-version": String(row.version),
    "x-file-updated-at": String(row.updated_at),
    "x-file-has-thumb": row.has_thumb ? "1" : "0",
    "cache-control": "no-store",
  };
  if (opts.includeFolderId) {
    headers["x-file-folder-id"] = row.folder_id ?? "";
    headers["x-file-starred-at"] = row.starred_at === null ? "" : String(row.starred_at);
  }
  if (opts.download) {
    if (row.kind === "notes") {
      const parsed = await parseStoredFileBlob(obj);
      if (
        parsed?.kind === "notes" &&
        "format" in parsed &&
        parsed.format === "markdown-v1" &&
        typeof parsed.source === "string"
      ) {
        headers["content-disposition"] = `attachment; filename="${safeFilename(row.name)}.md"`;
        headers["content-type"] = "text/markdown; charset=utf-8";
        return new Response(parsed.source, { headers });
      }
      if (!parsed?.kind || parsed.kind !== "notes" || !("blocks" in parsed)) {
        return errorResponse(500, "invalid Markdown blob");
      }
      // Legacy BlockNote documents remain JSON until the browser has
      // converted and saved them as canonical Markdown.
      headers["content-disposition"] =
        `attachment; filename="${safeFilename(row.name)}.notes.json"`;
      return new Response(JSON.stringify(parsed), { headers });
    }
    headers["content-disposition"] =
      `attachment; filename="${safeFilename(row.name)}.${downloadExtensionForKind(row.kind)}"`;
    if (row.kind === "excalidraw") {
      // Storage is envelope-free (the editor round-trips
      // `{elements, appState, files}`), but a `.excalidraw` file must
      // carry the export envelope: Excalidraw's `isValidExcalidrawData`
      // requires `type === "excalidraw"` or the import fails.
      const parsed = (await parseStoredFileBlob(obj)) as ExcalidrawFileBlob | null;
      if (!parsed || !Array.isArray(parsed.elements)) {
        return errorResponse(500, "invalid excalidraw blob");
      }
      return new Response(
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "inkwell",
          elements: parsed.elements,
          appState: parsed.appState ?? {},
          files: parsed.files ?? {},
        }),
        { headers },
      );
    }
    if (row.kind === "drawio") {
      const parsed = await parseStoredFileBlob(obj);
      if (!parsed || !isDrawioBlob(parsed)) return errorResponse(500, "invalid draw.io blob");
      headers["content-type"] = "application/xml; charset=utf-8";
      return new Response(parsed.xml, { headers });
    }
    if (row.kind === "static-site") {
      // Re-package the site's R2 assets into a single ZIP. The
      // manifest lists every asset path, so we fan-out R2 reads and
      // feed the result to fflate. Store-only (`level: 0`) on purpose:
      // deflating 4 MB of incompressible bytes measured ~61 ms CPU in
      // workerd versus ~9 ms store-only, and the Free plan budget is
      // 10 ms per request. `MAX_SITE_ZIP_BYTES` keeps the rest of the
      // request (manifest read, R2 fan-out, copies) inside that budget;
      // bigger sites stay reachable through their per-asset URLs.
      const manifest = await parseStoredFileBlob(obj);
      if (!manifest || !isStaticSiteBlob(manifest)) {
        return errorResponse(500, "invalid static-site manifest");
      }
      const totalBytes = manifest.assets.reduce((sum, a) => sum + a.size, 0);
      if (totalBytes > MAX_SITE_ZIP_BYTES) {
        return errorResponse(
          413,
          `site is too large to ZIP (max ${MAX_SITE_ZIP_BYTES} bytes); open the site URL to download assets individually`,
        );
      }
      const entries: Record<string, Uint8Array> = {};
      for (const a of manifest.assets) {
        const assetObj = await env.R2.get(r2StaticSiteAssetKey(row.id, a.path));
        if (!assetObj) {
          return errorResponse(500, `missing asset "${a.path}" in R2`);
        }
        entries[a.path] = new Uint8Array(await assetObj.arrayBuffer());
      }
      const zip = zipSync(entries, { level: 0 });
      headers["content-type"] = "application/zip";
      return new Response(zip, { headers });
    }
  }
  return new Response(obj.body, { headers });
}

// `scenes/` here is a historical R2 key prefix kept to avoid a blob copy
// during the scenes → files rename. The function name reflects the
// product vocabulary; the storage layout is unchanged.
export function r2FileKey(id: string): string {
  return `scenes/${id}.json`;
}
export function r2ThumbKey(id: string): string {
  return `thumbs/${id}.svg`;
}

function safeFilename(name: string): string {
  // Strip path-unsafe characters; keep it ASCII-friendly. Stripping the ASCII
  // control range \x00-\x1F is the explicit intent of this filter.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: see comment above
  const base = name.replace(/[\\/:*?"<>|\x00-\x1F]/g, "_").trim() || "file";
  return base.slice(0, 80);
}

function downloadExtensionForKind(kind: FileKind): "excalidraw" | "drawio" | "zip" {
  switch (kind) {
    case "drawio":
      return "drawio";
    case "excalidraw":
      return "excalidraw";
    case "notes":
      // Notes downloads are handled above because the extension depends
      // on whether the stored blob is canonical Markdown or legacy JSON.
      throw new Error("notes extension requires blob inspection");
    case "static-site":
      // Re-packaged ZIP — see `streamFileResponse` for the build.
      return "zip";
    default:
      return assertNever(kind);
  }
}

function isDrawioBlob(blob: FileBlob): blob is FileBlob & { kind: "drawio"; xml: string } {
  return (
    (blob as { kind?: unknown }).kind === "drawio" &&
    typeof (blob as { xml?: unknown }).xml === "string"
  );
}

export async function parseStoredFileBlob(obj: R2ObjectBody): Promise<FileBlob | null> {
  try {
    return JSON.parse(await obj.text()) as FileBlob;
  } catch {
    return null;
  }
}
