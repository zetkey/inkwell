import { describe, expect, it } from "vitest";
import { COLLAB_SNAPSHOT_SAFE_BYTES, planSnapshot } from "./snapshot";

describe("planSnapshot", () => {
  it("keeps inline files when the payload fits", () => {
    const plan = planSnapshot([{ id: "a", version: 1 }], { "file-1": { dataURL: "data:," } });

    expect(plan.includeFiles).toBe(true);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(plan.bytes).toBeLessThanOrEqual(plan.limit);
    expect(plan.limit).toBe(COLLAB_SNAPSHOT_SAFE_BYTES);
  });

  it("drops the inline files when the payload would exceed the limit", () => {
    const files = { "file-1": { dataURL: `data:image/png;base64,${"a".repeat(2_000)}` } };

    expect(planSnapshot([{ id: "a" }], files, 1_000).includeFiles).toBe(false);
    // The elements alone would still fit — only the images had to go.
    expect(planSnapshot([{ id: "a" }], {}, 1_000).includeFiles).toBe(true);
  });

  it("treats the limit itself as fitting", () => {
    const elements = [{ id: "a" }];
    const files = { "file-1": { dataURL: "x".repeat(500) } };
    const { bytes } = planSnapshot(elements, files);

    expect(planSnapshot(elements, files, bytes).includeFiles).toBe(true);
    expect(planSnapshot(elements, files, bytes - 1).includeFiles).toBe(false);
  });
});
