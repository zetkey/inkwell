import { describe, expect, it, vi } from "vitest";
import type { FileRow } from "../types";

const mocks = vi.hoisted(() => ({
  listForOwner: vi.fn(),
  collectForMany: vi.fn(),
  countActiveByTarget: vi.fn(),
}));

vi.mock("../middleware/auth", () => ({
  // Authenticated request without touching D1.
  requireSession: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("session", { userId: "u1", email: "u1@example.com", isAdmin: false, expiresAt: 0 });
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../db/repos/files", () => ({ listForOwner: mocks.listForOwner }));
vi.mock("../db/repos/folders", () => ({}));
vi.mock("../db/repos/tags", () => ({ collectForMany: mocks.collectForMany }));
vi.mock("../db/repos/shares", () => ({ countActiveByTarget: mocks.countActiveByTarget }));

import filesRoutes from "./files";

function row(i: number): FileRow {
  return {
    id: `f${i}`,
    owner: "u1",
    folder_id: null,
    name: `file-${String(i).padStart(5, "0")}`,
    kind: "excalidraw",
    version: 1,
    size_bytes: 0,
    has_thumb: false,
    thumb_updated_at: 0,
    created_at: 1,
    updated_at: 2,
    deleted_at: null,
    trashed_via: null,
    starred_at: null,
  };
}

function fakeRepo(rows: FileRow[]) {
  mocks.listForOwner.mockResolvedValue(rows);
  mocks.collectForMany.mockResolvedValue(new Map());
  mocks.countActiveByTarget.mockResolvedValue(new Map());
}

const env = {} as never;

async function list(query: string) {
  const res = await filesRoutes.request(`http://localhost/${query}`, {}, env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/files list", () => {
  it("flags a filtered search that hit the row cap", async () => {
    fakeRepo(Array.from({ length: 1001 }, (_, i) => row(i)));

    const { status, body } = await list("?q=file");

    expect(status).toBe(200);
    expect(body.truncated).toBe(true);
  });

  it("does not flag a filtered search that scanned everything", async () => {
    fakeRepo(Array.from({ length: 5 }, (_, i) => row(i)));

    const { body } = await list("?q=file");

    expect(body.truncated).toBe(false);
    expect((body.files as unknown[]).length).toBe(5);
  });

  it("keeps the response shape unchanged when no filter is active", async () => {
    fakeRepo(Array.from({ length: 1000 }, (_, i) => row(i)));

    const { body } = await list("");

    expect(body).not.toHaveProperty("truncated");
    expect((body.files as unknown[]).length).toBe(1000);
  });
});
