import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
}

function fakeEnv(events: string[], options: FakeR2Options = {}): Env {
  const store = new Map<string, string>([[MANIFEST_KEY, JSON.stringify(OLD_MANIFEST)]]);
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
