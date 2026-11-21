import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, FileRow } from "../types";

const mocks = vi.hoisted(() => ({
  claimVersion: vi.fn(),
  releaseVersion: vi.fn(),
  findById: vi.fn(),
}));

vi.mock("../db/repos/files", () => ({
  claimVersion: mocks.claimVersion,
  releaseVersion: mocks.releaseVersion,
  findById: mocks.findById,
}));
vi.mock("../db/repos/tags", () => ({ listForEntity: async () => [] }));
vi.mock("../db/repos/shares", () => ({ countActiveByTarget: async () => new Map() }));

import { MAX_FILE_BYTES, mirrorRenameIntoExcalidrawBlob, putFileBlob } from "./file-blob";

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

function fakeEnv(
  puts: string[],
  putFailure?: { failPut?: boolean; headSize?: number | null },
): Env {
  return {
    R2: {
      put: async (key: string) => {
        if (putFailure?.failPut) throw new Error("R2 unavailable");
        puts.push(key);
      },
      head: async () => {
        const size = putFailure?.headSize;
        return size === null || size === undefined ? null : { size };
      },
    },
  } as unknown as Env;
}

const body = JSON.stringify({ elements: [], appState: {}, files: {} });

beforeEach(() => {
  mocks.claimVersion.mockReset();
  mocks.releaseVersion.mockReset();
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
      headers: { "if-match": '"3"' },
      body,
    });

    const res = await putFileBlob(env, row(), req);

    expect(res.status).toBe(200);
    expect(puts).toEqual(["scenes/file-1.json"]);
    expect(mocks.claimVersion).toHaveBeenCalledWith(
      env,
      "user-1",
      "file-1",
      expect.objectContaining({ expectedVersion: 3 }),
    );
    const json = (await res.json()) as { version: number };
    expect(json.version).toBe(4);
  });
});

describe("putFileBlob rollback", () => {
  it("releases the claim when the R2 write fails", async () => {
    mocks.claimVersion.mockResolvedValue(4);
    const puts: string[] = [];
    const env = fakeEnv(puts, { failPut: true, headSize: null });
    const req = new Request("https://inkwell.test/api/files/file-1", {
      method: "PUT",
      headers: { "if-match": '"3"' },
      body,
    });

    const res = await putFileBlob(env, row(), req);

    expect(res.status).toBe(500);
    expect(puts).toEqual([]);
    expect(mocks.releaseVersion).toHaveBeenCalledWith(
      env,
      "user-1",
      "file-1",
      expect.objectContaining({
        expectedVersion: 4,
        sizeBytes: 128,
        updatedAt: 2,
      }),
    );
  });

  it("does not release the claim on success", async () => {
    mocks.claimVersion.mockResolvedValue(4);
    const env = fakeEnv([]);

    const res = await putFileBlob(
      env,
      row(),
      new Request("https://inkwell.test/api/files/file-1", {
        method: "PUT",
        headers: { "if-match": '"3"' },
        body,
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.releaseVersion).not.toHaveBeenCalled();
  });
});

describe("putFileBlob body cap", () => {
  it("locks the shared blob cap at 4 MiB", () => {
    expect(MAX_FILE_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_FILE_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("rejects an oversized Content-Length before claiming or buffering", async () => {
    const puts: string[] = [];
    const env = fakeEnv(puts);
    const req = new Request("https://inkwell.test/api/files/file-1", {
      method: "PUT",
      headers: { "content-length": String(30 * 1024 * 1024), "if-match": '"3"' },
    });

    const res = await putFileBlob(env, row(), req);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "file exceeds 4 MiB" });
    expect(puts).toEqual([]);
    expect(mocks.claimVersion).not.toHaveBeenCalled();
  });

  it("rejects a buffered body just over the cap without touching R2", async () => {
    const puts: string[] = [];
    const env = fakeEnv(puts);
    // No Content-Length on purpose: the byteLength guard must catch it.
    const oversized = new Uint8Array(MAX_FILE_BYTES + 1);

    const res = await putFileBlob(
      env,
      row(),
      new Request("https://inkwell.test/api/files/file-1", {
        method: "PUT",
        headers: { "if-match": '"3"' },
        body: oversized,
      }),
    );

    expect(res.status).toBe(413);
    expect(puts).toEqual([]);
    expect(mocks.claimVersion).not.toHaveBeenCalled();
  });
});

describe("mirrorRenameIntoExcalidrawBlob", () => {
  it("writes only if the blob still has the etag it read", async () => {
    const calls: { key: string; options: unknown }[] = [];
    const blob = JSON.stringify({ elements: [], appState: { name: "old" }, files: {} });
    const env = {
      R2: {
        get: async () => ({ httpEtag: '"etag-1"', text: async () => blob }),
        put: async (key: string, _body: unknown, options: unknown) => {
          calls.push({ key, options });
        },
      },
    } as unknown as Env;

    await mirrorRenameIntoExcalidrawBlob(env, row(), "new name");

    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("scenes/file-1.json");
    expect(calls[0].options).toEqual(
      expect.objectContaining({ onlyIf: { etagMatches: '"etag-1"' } }),
    );
  });

  it("retries once on a lost precondition, then succeeds", async () => {
    const blob = JSON.stringify({ elements: [], appState: {}, files: {} });
    const etags = ['"etag-1"', '"etag-2"'];
    const puts: unknown[] = [];
    const env = {
      R2: {
        get: async () => ({
          size: 64,
          httpEtag: etags.shift() ?? '"etag-3"',
          text: async () => blob,
        }),
        put: async (_key: string, _body: unknown, options: unknown) => {
          puts.push(options);
          if (puts.length === 1) throw new Error("precondition failed");
        },
      },
    } as unknown as Env;

    await expect(mirrorRenameIntoExcalidrawBlob(env, row(), "new name")).resolves.toBeUndefined();

    expect(puts).toHaveLength(2);
    expect(puts[0]).toEqual(expect.objectContaining({ onlyIf: { etagMatches: '"etag-1"' } }));
    expect(puts[1]).toEqual(expect.objectContaining({ onlyIf: { etagMatches: '"etag-2"' } }));
  });

  it("gives up quietly when both attempts lose the precondition", async () => {
    const blob = JSON.stringify({ elements: [], appState: {}, files: {} });
    let puts = 0;
    const env = {
      R2: {
        get: async () => ({ size: 64, httpEtag: '"e"', text: async () => blob }),
        put: async () => {
          puts += 1;
          throw new Error("precondition failed");
        },
      },
    } as unknown as Env;

    await expect(mirrorRenameIntoExcalidrawBlob(env, row(), "new name")).resolves.toBeUndefined();
    expect(puts).toBe(2);
  });

  it("never parses a blob over the mirror size cap", async () => {
    let read = false;
    let put = false;
    const env = {
      R2: {
        get: async () => ({
          size: 300 * 1024,
          httpEtag: '"e"',
          text: async () => {
            read = true;
            return "{}";
          },
        }),
        put: async () => {
          put = true;
        },
      },
    } as unknown as Env;

    await mirrorRenameIntoExcalidrawBlob(env, row(), "new name");

    expect(read).toBe(false);
    expect(put).toBe(false);
  });

  it("resolves when reading the blob throws", async () => {
    const env = {
      R2: {
        get: async () => {
          throw new Error("R2 down");
        },
      },
    } as unknown as Env;

    await expect(mirrorRenameIntoExcalidrawBlob(env, row(), "new name")).resolves.toBeUndefined();
  });

  it("does nothing for non-excalidraw files", async () => {
    let touched = false;
    const env = {
      R2: {
        get: async () => {
          touched = true;
          return null;
        },
      },
    } as unknown as Env;

    await mirrorRenameIntoExcalidrawBlob(env, row({ kind: "drawio" }), "x");

    expect(touched).toBe(false);
  });
});

describe("putFileBlob ambiguous put failures", () => {
  const bodyLength = new TextEncoder().encode(body).byteLength;

  it("treats a failed put as success when the stored size already matches", async () => {
    mocks.claimVersion.mockResolvedValue(4);
    const env = fakeEnv([], { failPut: true, headSize: bodyLength });
    const req = new Request("https://inkwell.test/api/files/file-1", {
      method: "PUT",
      headers: { "if-match": '"3"' },
      body,
    });

    const res = await putFileBlob(env, row(), req);

    expect(res.status).toBe(200);
    expect((await res.json()) as { version: number }).toMatchObject({ version: 4 });
    expect(mocks.releaseVersion).not.toHaveBeenCalled();
  });

  it("rolls the claim back when the stored size is still the old one", async () => {
    mocks.claimVersion.mockResolvedValue(4);
    const env = fakeEnv([], { failPut: true, headSize: 128 });
    const req = new Request("https://inkwell.test/api/files/file-1", {
      method: "PUT",
      headers: { "if-match": '"3"' },
      body,
    });

    const res = await putFileBlob(env, row(), req);

    expect(res.status).toBe(500);
    expect(mocks.releaseVersion).toHaveBeenCalledWith(
      env,
      "user-1",
      "file-1",
      expect.objectContaining({ expectedVersion: 4 }),
    );
  });
});

describe("putFileBlob If-Match requirement", () => {
  it("answers 428 without claiming or writing when the header is missing", async () => {
    const puts: string[] = [];
    const env = fakeEnv(puts);

    const res = await putFileBlob(
      env,
      row(),
      new Request("https://inkwell.test/api/files/file-1", { method: "PUT", body }),
    );

    expect(res.status).toBe(428);
    expect(await res.json()).toEqual({
      error: "If-Match required: send the file version you loaded",
    });
    expect(mocks.claimVersion).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it("treats a non-numeric If-Match as a version conflict", async () => {
    const puts: string[] = [];
    const env = fakeEnv(puts);

    const res = await putFileBlob(
      env,
      row(),
      new Request("https://inkwell.test/api/files/file-1", {
        method: "PUT",
        headers: { "if-match": "not-a-version" },
        body,
      }),
    );

    expect(res.status).toBe(409);
    expect(mocks.claimVersion).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });
});
