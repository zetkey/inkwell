// Client-side zip of (part of) a public folder share, built from the
// share payload and the share-token download endpoint. Mirrors the
// owner-side `features/actions/download.ts` but never touches owner APIs.

import type { FileMeta, FolderMeta } from "@/lib/api/client";
import { shares } from "@/lib/api/client";
import { filenameFromDisposition, safeSegment, uniquePath } from "@/lib/filename";

export function triggerDownload(url: string, filename?: string) {
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  else a.setAttribute("download", "");
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Zip the given folders (recursively, within the payload) and files and
 * trigger a download named `zipName`.
 */
export async function downloadShareZip(opts: {
  token: string;
  folders: FolderMeta[];
  files: FileMeta[];
  pickFolderIds: string[];
  pickFileIds: string[];
  zipName: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<void> {
  const byId = new Map(opts.folders.map((f) => [f.id, f]));
  const entries: Array<{ file: FileMeta; dir: string }> = [];
  const fileById = new Map(opts.files.map((f) => [f.id, f]));
  for (const id of opts.pickFileIds) {
    const f = fileById.get(id);
    if (f) entries.push({ file: f, dir: "" });
  }
  for (const rootId of opts.pickFolderIds) {
    const root = byId.get(rootId);
    if (!root) continue;
    for (const f of opts.files) {
      // Walk up from the file's folder; keep it if we reach `rootId`.
      const segs: string[] = [];
      let cur = f.folderId ? byId.get(f.folderId) : undefined;
      let inside = false;
      let guard = 0;
      while (cur && guard++ < 64) {
        if (cur.id === rootId) {
          inside = true;
          break;
        }
        segs.unshift(safeSegment(cur.name));
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      if (inside) entries.push({ file: f, dir: [safeSegment(root.name), ...segs].join("/") });
    }
  }
  if (entries.length === 0) throw new Error("Nothing to download");

  const used = new Set<string>();
  const out: Record<string, Uint8Array> = {};
  let done = 0;
  const queue = [...entries];
  async function worker() {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      const resp = await fetch(shares.folderFileDownloadUrl(opts.token, e.file.id), {
        credentials: "include",
      });
      if (!resp.ok) throw new Error(`Download failed for "${e.file.name}" (HTTP ${resp.status})`);
      const name =
        filenameFromDisposition(resp.headers.get("content-disposition")) ??
        safeSegment(e.file.name);
      const path = uniquePath(e.dir ? `${e.dir}/${safeSegment(name)}` : safeSegment(name), used);
      out[path] = new Uint8Array(await resp.arrayBuffer());
      opts.onProgress?.(++done, entries.length);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  const { zip } = await import("fflate");
  const data = await new Promise<Uint8Array>((resolve, reject) =>
    zip(out, { level: 6 }, (err, res) => (err ? reject(err) : resolve(res))),
  );
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/zip" }));
  triggerDownload(url, opts.zipName);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
