import { describe, expect, it } from "vitest";
import { pruneEditsToPaths } from "./sitePaths";

const assets = [{ path: "index.html" }, { path: "css/app.css" }];

describe("pruneEditsToPaths", () => {
  it("drops edits for files the other client deleted", () => {
    // A conflict refresh must not let the next save resurrect `old.css`.
    expect(
      pruneEditsToPaths(
        { "index.html": "<h1>x</h1>", "css/app.css": "body{}", "old.css": "gone{}" },
        assets,
      ),
    ).toEqual({ "index.html": "<h1>x</h1>", "css/app.css": "body{}" });
  });

  it("keeps every edit when all paths still exist", () => {
    const edits = { "index.html": "<h1>x</h1>", "css/app.css": "body{}" };
    expect(pruneEditsToPaths(edits, assets)).toEqual(edits);
  });

  it("drops everything when the site became empty", () => {
    expect(pruneEditsToPaths({ "index.html": "x" }, [])).toEqual({});
  });
});
