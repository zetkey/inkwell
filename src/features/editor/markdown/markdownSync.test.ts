// Typing cost on a large document: one fingerprint per quiet window
// instead of one per keystroke, and the unmount flush still reports the
// newest text. Uses a synthetic 2 MB document (the number the audit
// cares about) and asserts call counts, not timing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKDOWN_FLUSH_MS, type MarkdownSnapshot, MarkdownSync } from "./markdownSync";

const BIG = "a".repeat(2 * 1024 * 1024);

function harness(initial: MarkdownSnapshot = { source: "seed", fp: "fp:seed" }) {
  const fingerprint = vi.fn((source: string) => `fp:${source.length}:${source.charCodeAt(0) || 0}`);
  const flushed: MarkdownSnapshot[] = [];
  const sync = new MarkdownSync({
    initial,
    fingerprint,
    onFlush: (snapshot) => flushed.push(snapshot),
  });
  return { sync, fingerprint, flushed };
}

describe("MarkdownSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("fingerprints once per quiet window for 10 keystrokes on a 2 MB document", () => {
    const h = harness({ source: BIG, fp: "fp:big" });

    for (let i = 0; i < 10; i++) h.sync.push(`${BIG}${i}`);
    expect(h.fingerprint).not.toHaveBeenCalled();
    expect(h.flushed).toHaveLength(0);

    vi.advanceTimersByTime(MARKDOWN_FLUSH_MS - 1);
    expect(h.fingerprint).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(h.fingerprint).toHaveBeenCalledTimes(1);
    expect(h.flushed).toHaveLength(1);
    expect(h.flushed[0].source.endsWith("9")).toBe(true);
  });

  it("reports the newest text when the editor unmounts mid-window", () => {
    const h = harness();

    h.sync.push("draft-1");
    h.sync.push("draft-2");
    h.sync.dispose();

    expect(h.fingerprint).toHaveBeenCalledTimes(1);
    expect(h.flushed).toEqual([{ source: "draft-2", fp: "fp:7:100" }]);
    vi.advanceTimersByTime(MARKDOWN_FLUSH_MS * 4);
    expect(h.flushed).toHaveLength(1);
  });

  it("hashes lazily and caches for the save path", () => {
    const h = harness();

    h.sync.push("x");
    h.sync.push("xy");

    expect(h.sync.read()).toEqual({ source: "xy", fp: "fp:2:120" });
    expect(h.sync.read()).toEqual({ source: "xy", fp: "fp:2:120" });
    expect(h.fingerprint).toHaveBeenCalledTimes(1);
  });

  it("drops the pending window on discard", () => {
    const h = harness();

    h.sync.push("discarded");
    h.sync.discard();
    h.sync.dispose();
    vi.advanceTimersByTime(MARKDOWN_FLUSH_MS * 4);

    expect(h.fingerprint).not.toHaveBeenCalled();
    expect(h.flushed).toHaveLength(0);
  });

  it("re-baselines on reset without reporting the old document", () => {
    const h = harness();

    h.sync.push("dirty");
    h.sync.reset({ source: "fresh", fp: "fp:fresh" });
    vi.advanceTimersByTime(MARKDOWN_FLUSH_MS * 4);

    expect(h.flushed).toHaveLength(0);
    expect(h.sync.read()).toEqual({ source: "fresh", fp: "fp:fresh" });
  });
});
