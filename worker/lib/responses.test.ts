import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { FileRow } from "../types";
import { MAX_SITE_ZIP_BYTES, streamFileResponse } from "./responses";

const blob = {
  elements: [{ id: "el1", type: "rectangle", x: 0, y: 0 }],
  appState: { viewBackgroundColor: "#ffffff" },
  files: { file1: { id: "file1", mimeType: "image/png" } },
};

function row(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: "file-1",
    owner: "user-1",
    folder_id: null,
    name: "Sketch",
    kind: "excalidraw",
    version: 3,
    size_bytes: 128,
    has_thumb: false,
    thumb_updated_at: 0,
    created_at: 1,
    updated_at: 2,
    deleted_at: null,
    trashed_via: null,
    starred_at: null,
    ...overrides,
  };
}

function envWith(json: string) {
  const bytes = new TextEncoder().encode(json);
  return {
    R2: {
      get: async () => ({ body: bytes, text: async () => json }),
    },
  } as unknown as { R2: R2Bucket };
}

describe("streamFileResponse downloads", () => {
  it("wraps an excalidraw blob in a canonical export envelope", async () => {
    const stored = JSON.stringify({ ...blob, type: "stale", version: 99, source: "elsewhere" });
    const res = await streamFileResponse(envWith(stored), row(), { download: true });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Sketch.excalidraw"');
    const body = await res.json();
    expect(body).toEqual({
      type: "excalidraw",
      version: 2,
      source: "inkwell",
      elements: blob.elements,
      appState: blob.appState,
      files: blob.files,
    });
  });

  it("leaves the non-download body envelope-free for editor load", async () => {
    const res = await streamFileResponse(envWith(JSON.stringify(blob)), row());
    const body = await res.json();

    expect(body).not.toHaveProperty("type");
    expect(body).toEqual(blob);
  });

  it("returns 500 for a malformed excalidraw blob on download", async () => {
    const stored = JSON.stringify({ elements: {}, appState: {}, files: {} });
    const res = await streamFileResponse(envWith(stored), row(), { download: true });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "invalid excalidraw blob" });
  });
});

// Static-site downloads fan-out R2 reads into a store-only ZIP. The R2
// fake records reads so a test can prove the size guard fires before any
// asset is fetched.
function siteEnv(manifest: unknown, assets: Record<string, Uint8Array>, reads: string[]) {
  return {
    R2: {
      get: async (key: string) => {
        reads.push(key);
        if (key === "scenes/file-1.json") {
          const text = JSON.stringify(manifest);
          const bytes = new TextEncoder().encode(text);
          return { body: bytes, text: async () => text, arrayBuffer: async () => bytes.buffer };
        }
        const bytes = assets[key];
        if (!bytes) return null;
        return {
          body: bytes,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.buffer,
        };
      },
    },
  } as unknown as { R2: R2Bucket };
}

function siteManifest(sizes: { path: string; size: number }[]) {
  return {
    kind: "static-site",
    entry: sizes[0]?.path ?? "index.html",
    assets: sizes.map((a) => ({ ...a, contentType: "text/html", updatedAt: 0 })),
  };
}

describe("streamFileResponse static-site ZIP", () => {
  it("packs assets store-only, preserving paths and bytes", async () => {
    const html = new TextEncoder().encode("<h1>hi</h1>");
    const css = new TextEncoder().encode("h1{color:red}");
    const reads: string[] = [];
    const env = siteEnv(
      siteManifest([
        { path: "index.html", size: html.byteLength },
        { path: "style.css", size: css.byteLength },
      ]),
      { "static-sites/file-1/index.html": html, "static-sites/file-1/style.css": css },
      reads,
    );

    const res = await streamFileResponse(env, row({ kind: "static-site" }), { download: true });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Sketch.zip"');
    const zipped = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(zipped).sort()).toEqual(["index.html", "style.css"]);
    expect(new TextDecoder().decode(zipped["index.html"])).toBe("<h1>hi</h1>");
    expect(new TextDecoder().decode(zipped["style.css"])).toBe("h1{color:red}");
  });

  it("refuses an oversized site before reading any asset", async () => {
    const reads: string[] = [];
    const env = siteEnv(
      siteManifest([{ path: "big.bin", size: MAX_SITE_ZIP_BYTES + 1 }]),
      {},
      reads,
    );

    const res = await streamFileResponse(env, row({ kind: "static-site" }), { download: true });

    expect(res.status).toBe(413);
    expect(reads).toEqual(["scenes/file-1.json"]);
  });
});
