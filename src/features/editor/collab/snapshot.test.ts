import { describe, expect, it } from "vitest";
import {
  batchElements,
  COLLAB_SNAPSHOT_SAFE_BYTES,
  pickFilesForFrame,
  planDelta,
  planSnapshot,
} from "./snapshot";

const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("planSnapshot", () => {
  it("keeps inline files when the payload fits", () => {
    const plan = planSnapshot([{ id: "a", version: 1 }], { "file-1": { dataURL: "data:," } });

    expect(plan.skip).toBe(false);
    expect(plan.includeFiles).toBe(true);
    expect(plan.elementsBytes + plan.filesBytes).toBeLessThanOrEqual(plan.limit);
    expect(plan.limit).toBe(COLLAB_SNAPSHOT_SAFE_BYTES);
  });

  it("drops the inline files when the payload would exceed the limit", () => {
    const files = { "file-1": { dataURL: `data:image/png;base64,${"a".repeat(2_000)}` } };

    expect(planSnapshot([{ id: "a" }], files, 1_000).includeFiles).toBe(false);
    // The elements alone would still fit — only the images had to go.
    expect(planSnapshot([{ id: "a" }], {}, 1_000).includeFiles).toBe(true);
  });

  it("measures UTF-8 bytes, not UTF-16 length", () => {
    // 600 "é" are 600 UTF-16 code units but 1200 UTF-8 bytes: a
    // `.length`-based budget would call this payload 620-ish and let it
    // through a 1000-byte frame.
    const files = { "file-1": { dataURL: "é".repeat(600) } };
    const plan = planSnapshot([{ id: "a" }], files, 1_000);

    expect(plan.filesBytes).toBe(utf8(files));
    expect(plan.filesBytes).toBeGreaterThan(1_000);
    expect(plan.skip).toBe(false);
    expect(plan.includeFiles).toBe(false);
  });

  it("skips the snapshot when the elements alone exceed the limit", () => {
    const elements = [{ id: "a", text: "é".repeat(600) }];
    const plan = planSnapshot(elements, {}, 1_000);

    expect(plan.elementsBytes).toBeGreaterThan(1_000);
    expect(plan.skip).toBe(true);
    expect(plan.includeFiles).toBe(false);
  });

  it("treats the limit itself as fitting", () => {
    const elements = [{ id: "a" }];
    const files = { "file-1": { dataURL: "x".repeat(500) } };
    const { elementsBytes, filesBytes } = planSnapshot(elements, files);
    const exact = elementsBytes + filesBytes;

    expect(planSnapshot(elements, files, exact).includeFiles).toBe(true);
    expect(planSnapshot(elements, files, exact - 1).includeFiles).toBe(false);
  });
});

describe("pickFilesForFrame", () => {
  it("only includes the files that fit, leaving the rest undelivered", () => {
    const twentyMiB = 20 * 1024 * 1024;
    const pending = {
      big1: { dataURL: "a".repeat(twentyMiB) },
      big2: { dataURL: "b".repeat(twentyMiB) },
    };

    const { files, filesBytes } = pickFilesForFrame(pending, 1_024);

    expect(Object.keys(files)).toEqual(["big1"]);
    expect(filesBytes).toBeLessThanOrEqual(COLLAB_SNAPSHOT_SAFE_BYTES);
    // The dropped file is absent, so the caller cannot mark it as sent and
    // a later, smaller frame can still ship it.
    expect(files.big2).toBeUndefined();
  });

  it("includes nothing when the elements already fill the budget", () => {
    const pending = { small: { dataURL: "a".repeat(10) } };

    expect(pickFilesForFrame(pending, 1_000, 1_000).files).toEqual({});
  });

  it("keeps every file that fits together", () => {
    const pending = { a: { dataURL: "a".repeat(100) }, b: { dataURL: "b".repeat(100) } };

    expect(Object.keys(pickFilesForFrame(pending, 10, 1_000).files)).toEqual(["a", "b"]);
  });
});

describe("planDelta", () => {
  it("sends nothing when the changed elements alone exceed the budget", () => {
    const changed = [{ id: "paste", text: "é".repeat(600) }];
    const plan = planDelta(changed, { "file-1": { dataURL: "x" } }, 1_000);

    expect(plan.skip).toBe(true);
    expect(plan.elementsBytes).toBeGreaterThan(1_000);
    // No files are even considered: the caller must keep its baseline.
    expect(plan.files).toEqual({});
  });

  it("picks the files that fit beside the changed elements", () => {
    const files = {
      big: { dataURL: "a".repeat(995) },
      small: { dataURL: "b".repeat(10) },
    };
    const plan = planDelta([{ id: "a" }], files, 1_000);

    expect(plan.skip).toBe(false);
    expect(Object.keys(plan.files)).toEqual(["small"]);
  });
});

describe("batchElements", () => {
  const el = (id: string, text = "") => ({ id, text });

  it("splits a scene into frames under the limit", () => {
    const batches = batchElements(
      [el("a", "x".repeat(400)), el("b", "x".repeat(400)), el("c")],
      500,
    );

    expect(batches.map((batch) => batch.map((e) => e.id))).toEqual([["a"], ["b", "c"]]);
  });

  it("drops an element that cannot fit a frame on its own", () => {
    const batches = batchElements([el("huge", "x".repeat(2_000)), el("ok")], 500);

    expect(batches).toEqual([[el("ok")]]);
  });

  it("keeps one frame when everything fits", () => {
    expect(batchElements([el("a"), el("b")], 1_000)).toEqual([[el("a"), el("b")]]);
  });
});
