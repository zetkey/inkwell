import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, FileRow } from "../types";

const mocks = vi.hoisted(() => ({
  claimVersion: vi.fn(),
  findById: vi.fn(),
}));

vi.mock("../db/repos/files", () => ({
  claimVersion: mocks.claimVersion,
  findById: mocks.findById,
}));
vi.mock("../db/repos/tags", () => ({ listForEntity: async () => [] }));
vi.mock("../db/repos/shares", () => ({ countActiveByTarget: async () => new Map() }));

import { putFileBlob } from "./file-blob";

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

function fakeEnv(puts: string[]): Env {
  return {
    R2: {
      put: async (key: string) => {
        puts.push(key);
      },
    },
  } as unknown as Env;
}

const body = JSON.stringify({ elements: [], appState: {}, files: {} });

beforeEach(() => {
  mocks.claimVersion.mockReset();
  mocks.findById.mockReset();
});

describe("putFileBlob version claim", () => {
  it("does not touch R2 when the claim loses the race", async () => {
    mocks.claimVersion.mockResolvedValue(null);
    mocks.findById.mockResolvedValue(row({ version: 9 }));
    const puts: string[] = [];
    const env = fakeEnv(puts);
    const req = new Request("https://inkwell.test/api/files/file-1", {
      method: "PUT",
      headers: { "if-match": '"3"' },
      body,
    });

    const res = await putFileBlob(env, row(), req);

    expect(res.status).toBe(409);
    expect(puts).toEqual([]);
    expect(mocks.claimVersion).toHaveBeenCalledWith(
      env,
      "user-1",
      "file-1",
      expect.objectContaining({ expectedVersion: 3, sizeBytes: body.length }),
    );
    const json = (await res.json()) as { error: string; current: { version: number } };
    expect(json.error).toBe("version mismatch");
    expect(json.current.version).toBe(9);
  });

  it("claims the next version before writing R2", async () => {
    mocks.claimVersion.mockResolvedValue(4);
    const puts: string[] = [];
    const env = fakeEnv(puts);
    const req = new Request("https://inkwell.test/api/files/file-1", {
      method: "PUT",
      body,
    });

    const res = await putFileBlob(env, row(), req);

    expect(res.status).toBe(200);
    expect(puts).toEqual(["scenes/file-1.json"]);
    expect(mocks.claimVersion).toHaveBeenCalledWith(
      env,
      "user-1",
      "file-1",
      expect.objectContaining({ expectedVersion: undefined }),
    );
    const json = (await res.json()) as { version: number };
    expect(json.version).toBe(4);
  });
});
