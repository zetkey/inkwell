// Route-level tests for the restored uploaded-file routes:
// POST /upload, GET /:id/meta, GET /:id/raw (including HTTP Range).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_USER_STORAGE_BYTES } from "../services/file-blob";
import type { Env, FileRow } from "../types";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  insert: vi.fn(),
  existsForOwner: vi.fn(),
  listForEntity: vi.fn(),
  countActiveByTarget: vi.fn(),
  storageBytesUsed: vi.fn(),
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
  insert: mocks.insert,
}));
vi.mock("../db/repos/folders", () => ({ existsForOwner: mocks.existsForOwner }));
vi.mock("../db/repos/tags", () => ({ listForEntity: mocks.listForEntity }));
vi.mock("../db/repos/shares", () => ({ countActiveByTarget: mocks.countActiveByTarget }));
vi.mock("../db/repos/users", () => ({ storageBytesUsed: mocks.storageBytesUsed }));

import filesRoutes from "./files";

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function row(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: "f1",
    owner: "u1",
    folder_id: null,
    name: "pic.png",
    kind: "file",
    version: 3,
    size_bytes: BYTES.byteLength,
    mime: "image/png",
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

interface PutRecord {
  key: string;
  body: Uint8Array;
  contentType?: string;
}

/** Minimal R2 that honours `get(key, { range: Headers })` the way the real
 *  binding does: a satisfiable range returns the slice plus `range`, and an
 *  unsatisfiable one throws. */
function fakeEnv(bytes: Uint8Array = BYTES): { env: Env; puts: PutRecord[] } {
  const puts: PutRecord[] = [];
  const r2 = {
    get: async (_key: string, opts?: { range?: Headers }) => {
      const raw = opts?.range?.get("range") ?? null;
      const size = bytes.byteLength;
      const full = () => ({ body: new Response(bytes).body, size });
      if (!raw) return full();
      const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
      if (!m) return full();
      const [, startStr, endStr] = m;
      let offset: number;
      let length: number;
      if (startStr === "") {
        const suffix = Number(endStr);
        if (!Number.isInteger(suffix) || suffix <= 0) throw new Error("unsatisfiable");
        offset = Math.max(0, size - suffix);
        length = size - offset;
      } else {
        offset = Number(startStr);
        if (offset >= size) throw new Error("unsatisfiable");
        length = endStr === "" ? size - offset : Math.min(Number(endStr), size - 1) - offset + 1;
        if (length <= 0) throw new Error("unsatisfiable");
      }
      return {
        body: new Response(bytes.subarray(offset, offset + length)).body,
        size,
        range: { offset, length },
      };
    },
    head: async () => ({ size: bytes.byteLength }),
    put: async (
      key: string,
      value: unknown,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      const body =
        value instanceof ReadableStream
          ? new Uint8Array(await new Response(value).arrayBuffer())
          : new Uint8Array(value as ArrayBuffer);
      puts.push({ key, body, contentType: opts?.httpMetadata?.contentType });
    },
    delete: async () => {},
  };
  return { env: { R2: r2 } as unknown as Env, puts };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsForOwner.mockResolvedValue(true);
  mocks.storageBytesUsed.mockResolvedValue(0);
  mocks.insert.mockResolvedValue(undefined);
  mocks.findById.mockResolvedValue(row());
  mocks.listForEntity.mockResolvedValue([]);
  mocks.countActiveByTarget.mockResolvedValue(new Map());
});

describe("POST /api/files/upload", () => {
  it("streams the bytes to R2 and returns the file meta", async () => {
    const { env, puts } = fakeEnv();
    const body = new Uint8Array([1, 2, 3, 4]);

    const res = await filesRoutes.request(
      "/upload?name=pic.png&folderId=folder-1",
      {
        method: "POST",
        body,
        headers: { "content-type": "image/png", "content-length": String(body.byteLength) },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "pic.png",
      kind: "file",
      mime: "image/png",
      sizeBytes: 4,
      folderId: "folder-1",
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].key.startsWith("scenes/")).toBe(true);
    expect(puts[0].contentType).toBe("image/png");
    expect([...puts[0].body]).toEqual([1, 2, 3, 4]);
    expect(mocks.insert).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ kind: "file", size_bytes: 4, mime: "image/png", owner: "u1" }),
    );
  });

  it("refuses a chunked body with no Content-Length (411)", async () => {
    const { env, puts } = fakeEnv();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const req = new Request("http://localhost/upload?name=x.bin", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as unknown as RequestInit);

    const res = await filesRoutes.request(req, undefined, env);

    expect(res.status).toBe(411);
    expect(puts).toHaveLength(0);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses an upload that would exceed the owner's storage quota", async () => {
    const { env, puts } = fakeEnv();
    mocks.storageBytesUsed.mockResolvedValue(MAX_USER_STORAGE_BYTES);

    const res = await filesRoutes.request(
      "/upload?name=x.bin",
      { method: "POST", body: new Uint8Array([1]), headers: { "content-length": "1" } },
      env,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: expect.stringContaining("storage quota exceeded"),
    });
    expect(puts).toHaveLength(0);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe("GET /api/files/:id/meta", () => {
  it("answers metadata for an uploaded file without reading the blob", async () => {
    const { env } = fakeEnv();
    mocks.listForEntity.mockResolvedValue(["alpha"]);
    mocks.countActiveByTarget.mockResolvedValue(new Map([["f1", 2]]));

    const res = await filesRoutes.request("/f1/meta", {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "f1",
      kind: "file",
      mime: "image/png",
      sizeBytes: BYTES.byteLength,
      tags: ["alpha"],
      activeShareCount: 2,
    });
  });
});

describe("GET /api/files/:id/raw", () => {
  it("serves the whole object with accept-ranges when no Range is sent", async () => {
    const { env } = fakeEnv();

    const res = await filesRoutes.request("/f1/raw", {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...BYTES]);
  });

  it("answers a satisfiable Range with 206 and the slice", async () => {
    const { env } = fakeEnv();

    const res = await filesRoutes.request("/f1/raw", { headers: { range: "bytes=2-5" } }, env);

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3, 4, 5]);
  });

  it("answers an unsatisfiable Range with 416 and the object size", async () => {
    const { env } = fakeEnv();

    const res = await filesRoutes.request("/f1/raw", { headers: { range: "bytes=99-" } }, env);

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });
});
