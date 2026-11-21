import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByIdAnyOwner: vi.fn(),
  existsForOwner: vi.fn(),
  findByTokenForOwner: vi.fn(),
  revoke: vi.fn(),
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
  findByIdAnyOwner: mocks.findByIdAnyOwner,
}));
vi.mock("../db/repos/folders", () => ({ existsForOwner: mocks.existsForOwner }));
vi.mock("../db/repos/shares", () => ({
  findByTokenForOwner: mocks.findByTokenForOwner,
  revoke: mocks.revoke,
  listForTarget: async () => [],
  listAllForOwnerWithTarget: async () => [],
  update: async () => {},
}));
// Only the DELETE handlers under test; keep the create/rotate services out
// of the module graph so their real repo imports never load.
vi.mock("../services/share-create", () => ({ createShareRow: vi.fn() }));
vi.mock("../services/share-cascade", () => ({ rotateShare: vi.fn() }));

import type { AppEnv } from "../middleware/types";
import { fileSharesNested, folderSharesNested } from "./shares";

// The routers are mounted by the parent app, which is what supplies the
// `:id` path param; mount them the same way here.
const app = new Hono<AppEnv>();
app.route("/api/files/:id/shares", fileSharesNested);
app.route("/api/folders/:id/shares", folderSharesNested);

const env = {} as never;
beforeEach(() => {
  vi.resetAllMocks();
});

const share = (target_type: string, target_id: string) => ({
  token: "t",
  owner: "u1",
  target_type,
  target_id,
});

async function deleteFileShare(id: string, token: string) {
  const res = await app.request(
    `http://localhost/api/files/${id}/shares/${token}`,
    {
      method: "DELETE",
    },
    env,
  );
  return res.status;
}

async function deleteFolderShare(id: string, token: string) {
  const res = await app.request(
    `http://localhost/api/folders/${id}/shares/${token}`,
    {
      method: "DELETE",
    },
    env,
  );
  return res.status;
}

describe("DELETE /api/files/:id/shares/:token", () => {
  it("refuses a token minted for a different file", async () => {
    mocks.findById.mockResolvedValue({ id: "a1", kind: "excalidraw" });
    mocks.findByTokenForOwner.mockResolvedValue(share("file", "other-file"));

    expect(await deleteFileShare("a1", "t")).toBe(404);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("refuses a folder token on the file router", async () => {
    mocks.findById.mockResolvedValue({ id: "a1", kind: "excalidraw" });
    mocks.findByTokenForOwner.mockResolvedValue(share("folder", "a1"));

    expect(await deleteFileShare("a1", "t")).toBe(404);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("revokes the token bound to this file", async () => {
    mocks.findById.mockResolvedValue({ id: "a1", kind: "excalidraw" });
    mocks.findByTokenForOwner.mockResolvedValue(share("file", "a1"));
    mocks.revoke.mockResolvedValue(true);

    expect(await deleteFileShare("a1", "t")).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(env, "u1", "t");
  });
});

describe("DELETE /api/folders/:id/shares/:token", () => {
  it("refuses a token minted for a different folder", async () => {
    mocks.existsForOwner.mockResolvedValue(true);
    mocks.findByTokenForOwner.mockResolvedValue(share("folder", "other-folder"));

    expect(await deleteFolderShare("d1", "t")).toBe(404);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("revokes the token bound to this folder", async () => {
    mocks.existsForOwner.mockResolvedValue(true);
    mocks.findByTokenForOwner.mockResolvedValue(share("folder", "d1"));
    mocks.revoke.mockResolvedValue(true);

    expect(await deleteFolderShare("d1", "t")).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(env, "u1", "t");
  });
});
