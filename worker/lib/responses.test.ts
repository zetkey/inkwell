import { describe, expect, it } from "vitest";
import type { FileRow } from "../types";
import { streamFileResponse } from "./responses";

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
