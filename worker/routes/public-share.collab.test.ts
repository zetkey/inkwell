// Route-level tests for the restored guest collab upgrade routes.
//
// The routes only gate access and forward; the room itself is covered by
// `worker/collab.room.test.ts`. What matters here is that a `collab` link
// reaches the room for an excalidraw file and nothing else does.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ShareRow } from "../types";

const mocks = vi.hoisted(() => ({
  findActive: vi.fn(),
  touchAccess: vi.fn(),
  findByIdAnyOwner: vi.fn(),
  fileInSubtree: vi.fn(),
  displayName: vi.fn(),
  forwardCollab: vi.fn(),
  guestIdentity: vi.fn(),
}));

vi.mock("../db/repos/shares", () => ({
  findActive: mocks.findActive,
  touchAccess: mocks.touchAccess,
}));
vi.mock("../db/repos/files", () => ({ findByIdAnyOwner: mocks.findByIdAnyOwner }));
vi.mock("../db/repos/folders", () => ({ fileInSubtree: mocks.fileInSubtree }));
vi.mock("../db/repos/tags", () => ({}));
vi.mock("../db/repos/users", () => ({ displayName: mocks.displayName }));
vi.mock("./collab", () => ({
  forwardCollab: mocks.forwardCollab,
  guestIdentity: mocks.guestIdentity,
}));

import publicShareRoutes from "./public-share";

const env = {} as Env;
const execCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const guest = { id: "guest:abcdefghijkmnpqr", name: "smiling_fish" };

function share(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    token: "tok",
    owner: "u1",
    target_type: "file",
    target_id: "f1",
    permission: "collab",
    allow_download: true,
    label: null,
    created_at: 0,
    expires_at: null,
    revoked_at: null,
    last_accessed_at: null,
    ...overrides,
  };
}

function get(path: string): Promise<Response> {
  return publicShareRoutes.request(
    path,
    { headers: { upgrade: "websocket" } },
    env,
    execCtx,
  ) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.touchAccess.mockResolvedValue(undefined);
  mocks.guestIdentity.mockReturnValue(guest);
  mocks.forwardCollab.mockImplementation(async () => new Response("room", { status: 200 }));
});

describe("GET /api/share/:token/collab (file share)", () => {
  it("forwards a collab link on an excalidraw file to the room", async () => {
    mocks.findActive.mockResolvedValue(share());
    mocks.findByIdAnyOwner.mockResolvedValue({ id: "f1", kind: "excalidraw" });

    const res = await get("/tok/collab");

    expect(res.status).toBe(200);
    expect(mocks.forwardCollab).toHaveBeenCalledWith(env, expect.anything(), "f1", guest);
  });

  it("rejects a read link with 403 and never forwards", async () => {
    mocks.findActive.mockResolvedValue(share({ permission: "read" }));

    const res = await get("/tok/collab");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "collab requires a collaboration link" });
    expect(mocks.forwardCollab).not.toHaveBeenCalled();
  });

  it("rejects a write link (no realtime) with 403", async () => {
    mocks.findActive.mockResolvedValue(share({ permission: "write" }));

    expect((await get("/tok/collab")).status).toBe(403);
    expect(mocks.forwardCollab).not.toHaveBeenCalled();
  });

  it("rejects a non-excalidraw file with 404", async () => {
    mocks.findActive.mockResolvedValue(share());
    mocks.findByIdAnyOwner.mockResolvedValue({ id: "f1", kind: "notes" });

    const res = await get("/tok/collab");

    expect(res.status).toBe(404);
    expect(mocks.forwardCollab).not.toHaveBeenCalled();
  });

  it("rejects an unknown or revoked share with 404", async () => {
    mocks.findActive.mockResolvedValue(null);

    const res = await get("/tok/collab");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "invalid or expired token" });
  });

  it("does not accept a folder token on the file-share path", async () => {
    mocks.findActive.mockResolvedValue(share({ target_type: "folder", target_id: "d1" }));

    expect((await get("/tok/collab")).status).toBe(404);
    expect(mocks.forwardCollab).not.toHaveBeenCalled();
  });
});

describe("GET /api/share/:token/files/:fileId/collab (folder share)", () => {
  it("forwards when the file is inside the shared subtree", async () => {
    mocks.findActive.mockResolvedValue(share({ target_type: "folder", target_id: "d1" }));
    mocks.fileInSubtree.mockResolvedValue(true);
    mocks.findByIdAnyOwner.mockResolvedValue({ id: "f1", kind: "excalidraw" });

    const res = await get("/tok/files/f1/collab");

    expect(res.status).toBe(200);
    expect(mocks.fileInSubtree).toHaveBeenCalledWith(env, "u1", "f1", "d1");
    expect(mocks.forwardCollab).toHaveBeenCalledWith(env, expect.anything(), "f1", guest);
  });

  it("rejects a file outside the shared subtree with 404", async () => {
    mocks.findActive.mockResolvedValue(share({ target_type: "folder", target_id: "d1" }));
    mocks.fileInSubtree.mockResolvedValue(false);

    const res = await get("/tok/files/f2/collab");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "file not in shared folder" });
    expect(mocks.forwardCollab).not.toHaveBeenCalled();
  });

  it("rejects a read link on the folder path with 403", async () => {
    mocks.findActive.mockResolvedValue(
      share({ target_type: "folder", target_id: "d1", permission: "read" }),
    );

    expect((await get("/tok/files/f1/collab")).status).toBe(403);
    expect(mocks.forwardCollab).not.toHaveBeenCalled();
  });
});
