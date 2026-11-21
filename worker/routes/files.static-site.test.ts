import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SITE_TOTAL_BYTES } from "../services/static-site";
import type { Env, FileRow } from "../types";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  claimVersion: vi.fn(),
  releaseVersion: vi.fn(),
  listForEntity: vi.fn(),
  countActiveByTarget: vi.fn(),
}));

vi.mock("../middleware/auth", () => ({
  requireSession: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("session", { userId: "u1", email: "u1@example.com", isAdmin: false, expiresAt: 0 });
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../db/repos/files", () => ({
  findById: mocks.findById,
  claimVersion: mocks.claimVersion,
  releaseVersion: mocks.releaseVersion,
}));
vi.mock("../db/repos/folders", () => ({}));
vi.mock("../db/repos/tags", () => ({ listForEntity: mocks.listForEntity }));
vi.mock("../db/repos/shares", () => ({ countActiveByTarget: mocks.countActiveByTarget }));

import filesRoutes from "./files";

const MANIFEST_KEY = "scenes/f1.json";
const OLD_MANIFEST = {
  kind: "static-site",
  entry: "index.html",
  assets: [
    { path: "index.html", size: 3, contentType: "text/html", updatedAt: 0 },
    { path: "old.html", size: 3, contentType: "text/html", updatedAt: 0 },
  ],
};

function row(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: "f1",
    owner: "u1",
    folder_id: null,
    name: "Site",
    kind: "static-site",
    version: 4,
    size_bytes: 6,
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

interface FakeR2Options {
  failPut?: boolean;
  failManifestPut?: boolean;
  /** Fail the Nth asset put (1-based), after earlier puts succeeded. */
  failAssetPutAt?: number;
}

function fakeEnv(events: string[], options: FakeR2Options = {}): Env {
  const store = new Map<string, string>([[MANIFEST_KEY, JSON.stringify(OLD_MANIFEST)]]);
  let assetPuts = 0;
  return {
    R2: {
      get: async (key: string) => {
        const value = store.get(key);
        if (value === undefined) return null;
        return {
          body: value,
          text: async () => value,
          arrayBuffer: async () => new TextEncoder().encode(value).buffer,
        };
      },
      put: async (key: string, value: unknown) => {
        if (options.failPut) throw new Error("R2 unavailable");
        if (options.failManifestPut && key === MANIFEST_KEY) throw new Error("R2 unavailable");
        if (options.failAssetPutAt && key.startsWith("static-sites/")) {
          assetPuts += 1;
          if (assetPuts === options.failAssetPutAt) throw new Error("R2 unavailable");
        }
        events.push(`put:${key}`);
        store.set(key, typeof value === "string" ? value : "bytes");
      },
      delete: async (keys: string | string[]) => {
        events.push(`delete:${Array.isArray(keys) ? keys.join(",") : keys}`);
        for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      },
    },
  } as unknown as Env;
}

function zipBody(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[path] = new TextEncoder().encode(text);
  return zipSync(entries, { level: 0 });
}

beforeEach(() => {
  mocks.findById.mockReset();
  mocks.claimVersion.mockReset();
  mocks.releaseVersion.mockReset();
  mocks.listForEntity.mockResolvedValue([]);
  mocks.countActiveByTarget.mockResolvedValue(new Map());
  mocks.findById.mockResolvedValue(row());
});

describe("POST /api/files/:id/assets/zip", () => {
  it("returns 409 without touching R2 when the claim loses", async () => {
    mocks.claimVersion.mockResolvedValue(null);
    const events: string[] = [];
    const c = fakeEnv(events);

    const res = await filesRoutes.request(
      "http://localhost/f1/assets/zip",
      { method: "POST", body: zipBody({ "index.html": "<h1>new</h1>" }) },
      c,
    );

    expect(res.status).toBe(409);
    expect(events).toEqual([]);
    expect(mocks.claimVersion).toHaveBeenCalledWith(
      c,
      "u1",
      "f1",
      expect.objectContaining({ expectedVersion: 4 }),
    );
  });

  it("publishes the manifest, then deletes only stale paths", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events);

    const res = await filesRoutes.request(
      "http://localhost/f1/assets/zip",
      { method: "POST", body: zipBody({ "index.html": "<h1>new</h1>" }) },
      c,
    );

    expect(res.status).toBe(200);
    expect(events).toEqual([
      "put:static-sites/f1/index.html",
      `put:${MANIFEST_KEY}`,
      "delete:static-sites/f1/old.html",
    ]);
    expect(mocks.releaseVersion).not.toHaveBeenCalled();
  });

  it("rolls the claim back and keeps the old manifest when an asset write fails", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events, { failPut: true });

    const res = await filesRoutes.request(
      "http://localhost/f1/assets/zip",
      { method: "POST", body: zipBody({ "index.html": "<h1>new</h1>" }) },
      c,
    );

    expect(res.status).toBe(500);
    expect(events).toEqual([]);
    expect(mocks.releaseVersion).toHaveBeenCalledWith(
      c,
      "u1",
      "f1",
      expect.objectContaining({ expectedVersion: 5, sizeBytes: 6, updatedAt: 2 }),
    );
    expect(await (await c.R2.get(MANIFEST_KEY))?.text()).toBe(JSON.stringify(OLD_MANIFEST));
  });

  it("rolls the claim back when the manifest write fails", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events, { failManifestPut: true });

    const res = await filesRoutes.request(
      "http://localhost/f1/assets/zip",
      { method: "POST", body: zipBody({ "index.html": "<h1>new</h1>" }) },
      c,
    );

    expect(res.status).toBe(500);
    expect(mocks.releaseVersion).toHaveBeenCalled();
    expect(events).toContain("put:static-sites/f1/index.html");
    expect(events.some((e) => e.startsWith("delete:"))).toBe(false);
  });
});

// `POST /:id/assets` (multipart) follows the same claim → write → publish
// order as the ZIP route so a lost race never leaves orphan assets.
function assetForm(name: string, text: string): FormData {
  const form = new FormData();
  form.append(name, new File([text], name, { type: "text/html" }));
  return form;
}

describe("POST /api/files/:id/assets", () => {
  it("returns 409 without writing when the claim loses", async () => {
    mocks.claimVersion.mockResolvedValue(null);
    const events: string[] = [];
    const c = fakeEnv(events);

    const res = await filesRoutes.request(
      "http://localhost/f1/assets",
      { method: "POST", body: assetForm("page.html", "<h1>x</h1>") },
      c,
    );

    expect(res.status).toBe(409);
    expect(events).toEqual([]);
  });

  it("claims, writes the asset, then the manifest", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events);

    const res = await filesRoutes.request(
      "http://localhost/f1/assets",
      { method: "POST", body: assetForm("page.html", "<h1>x</h1>") },
      c,
    );

    expect(res.status).toBe(200);
    expect(events).toEqual(["put:static-sites/f1/page.html", `put:${MANIFEST_KEY}`]);
    expect(mocks.releaseVersion).not.toHaveBeenCalled();
  });

  it("rolls the claim back when the manifest write fails", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events, { failManifestPut: true });

    const res = await filesRoutes.request(
      "http://localhost/f1/assets",
      { method: "POST", body: assetForm("page.html", "<h1>x</h1>") },
      c,
    );

    expect(res.status).toBe(500);
    expect(mocks.releaseVersion).toHaveBeenCalledWith(
      c,
      "u1",
      "f1",
      expect.objectContaining({ expectedVersion: 5 }),
    );
    expect(events).toEqual(["put:static-sites/f1/page.html"]);
  });
});

describe("partial asset writes", () => {
  it("reports that some assets landed and still rolls the version back", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events, { failAssetPutAt: 2 });
    const form = new FormData();
    form.append("a.html", new File(["<h1>a</h1>"], "a.html", { type: "text/html" }));
    form.append("b.html", new File(["<h1>b</h1>"], "b.html", { type: "text/html" }));

    const res = await filesRoutes.request(
      "http://localhost/f1/assets",
      { method: "POST", body: form },
      c,
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "site update failed after writing some assets; upload again",
    });
    // First asset landed; the manifest was never written.
    expect(events).toEqual(["put:static-sites/f1/a.html"]);
    expect(mocks.releaseVersion).toHaveBeenCalledWith(
      c,
      "u1",
      "f1",
      expect.objectContaining({ expectedVersion: 5 }),
    );
  });
});

describe("ZIP post-buffer cap", () => {
  it("rejects an oversized buffered body even without a truthful Content-Length", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events);
    const body = new Uint8Array(MAX_SITE_TOTAL_BYTES + 1);

    const res = await filesRoutes.request(
      "http://localhost/f1/assets/zip",
      { method: "POST", headers: { "content-length": "10" }, body },
      c,
    );

    expect(res.status).toBe(413);
    expect(events).toEqual([]);
    expect(mocks.claimVersion).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/files/:id/assets/:path", () => {
  it("returns 409 without deleting when the claim loses", async () => {
    mocks.claimVersion.mockResolvedValue(null);
    const events: string[] = [];
    const c = fakeEnv(events);

    const res = await filesRoutes.request(
      "http://localhost/f1/assets/old.html",
      { method: "DELETE" },
      c,
    );

    expect(res.status).toBe(409);
    expect(events).toEqual([]);
  });

  it("writes the manifest before deleting the object", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events);

    const res = await filesRoutes.request(
      "http://localhost/f1/assets/old.html",
      { method: "DELETE" },
      c,
    );

    expect(res.status).toBe(200);
    expect(events).toEqual([`put:${MANIFEST_KEY}`, "delete:static-sites/f1/old.html"]);
  });

  it("keeps the object when the manifest write fails", async () => {
    mocks.claimVersion.mockResolvedValue(5);
    const events: string[] = [];
    const c = fakeEnv(events, { failManifestPut: true });

    const res = await filesRoutes.request(
      "http://localhost/f1/assets/old.html",
      { method: "DELETE" },
      c,
    );

    expect(res.status).toBe(500);
    expect(events).toEqual([]);
    expect(mocks.releaseVersion).toHaveBeenCalledWith(
      c,
      "u1",
      "f1",
      expect.objectContaining({ expectedVersion: 5 }),
    );
  });
});
