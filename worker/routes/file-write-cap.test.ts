import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../middleware/types";
import type { FileRow } from "../types";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByIdAnyOwner: vi.fn(),
  claimVersion: vi.fn(),
  releaseVersion: vi.fn(),
  // Mutated per test: the folder-share path only accepts a folder target.
  share: {
    token: "tok",
    owner: "u1",
    target_type: "file",
    target_id: "f1",
    permission: "write",
    allow_download: true,
  },
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
// Both share write paths read `c.var.share` from the middleware; the
// token itself is irrelevant to the body cap.
vi.mock("../middleware/share-token", () => ({
  requireShareToken:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set("share", mocks.share);
      await next();
    },
}));
vi.mock("../db/repos/files", () => ({
  findById: mocks.findById,
  findByIdAnyOwner: mocks.findByIdAnyOwner,
  claimVersion: mocks.claimVersion,
  releaseVersion: mocks.releaseVersion,
}));
vi.mock("../db/repos/folders", () => ({
  existsForOwner: async () => true,
  fileInSubtree: async () => true,
}));
vi.mock("../db/repos/tags", () => ({ listForEntity: async () => [] }));
vi.mock("../db/repos/shares", () => ({
  countActiveByTarget: async () => new Map(),
  findActive: async () => null,
}));

import { MAX_FILE_BYTES, MAX_THUMB_BYTES } from "../services/file-blob";
import filesRoutes from "./files";
import publicShareRoutes from "./public-share";

const app = new Hono<AppEnv>();
app.route("/api/files", filesRoutes);
app.route("/api/share", publicShareRoutes);

function row(): FileRow {
  return {
    id: "f1",
    owner: "u1",
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
  };
}

function fakeEnv(puts: string[]): AppEnv["Bindings"] {
  return {
    R2: {
      put: async (key: string) => {
        puts.push(key);
      },
    },
  } as unknown as AppEnv["Bindings"];
}

const oversized = () => new Uint8Array(MAX_FILE_BYTES + 1);

beforeEach(() => {
  mocks.share.target_type = "file";
  mocks.share.target_id = "f1";
  mocks.findById.mockReset().mockResolvedValue(row());
  mocks.findByIdAnyOwner.mockReset().mockResolvedValue(row());
  mocks.claimVersion.mockReset().mockResolvedValue(4);
  mocks.releaseVersion.mockReset();
});

describe("blob cap on every write path", () => {
  it("owner PUT rejects a body over 4 MiB without writing", async () => {
    const puts: string[] = [];
    const res = await app.request(
      "http://localhost/api/files/f1",
      { method: "PUT", body: oversized() },
      fakeEnv(puts),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "file exceeds 4 MiB" });
    expect(puts).toEqual([]);
    expect(mocks.claimVersion).not.toHaveBeenCalled();
  });

  it("file-share PUT rejects a body over 4 MiB without writing", async () => {
    const puts: string[] = [];
    const res = await app.request(
      "http://localhost/api/share/tok",
      { method: "PUT", body: oversized() },
      fakeEnv(puts),
    );

    expect(res.status).toBe(413);
    expect(puts).toEqual([]);
    expect(mocks.claimVersion).not.toHaveBeenCalled();
  });

  it("thumbnail PUT rejects an oversized Content-Length before buffering", async () => {
    const puts: string[] = [];
    const res = await app.request(
      "http://localhost/api/files/f1/thumb",
      {
        method: "PUT",
        headers: { "content-length": String(MAX_THUMB_BYTES + 1) },
      },
      fakeEnv(puts),
    );

    expect(res.status).toBe(413);
    expect(puts).toEqual([]);
  });

  it("folder-share PUT rejects a body over 4 MiB without writing", async () => {
    mocks.share.target_type = "folder";
    mocks.share.target_id = "d1";
    const puts: string[] = [];
    const res = await app.request(
      "http://localhost/api/share/tok/files/f1",
      { method: "PUT", body: oversized() },
      fakeEnv(puts),
    );

    expect(res.status).toBe(413);
    expect(puts).toEqual([]);
    expect(mocks.claimVersion).not.toHaveBeenCalled();
  });
});
