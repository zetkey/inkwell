import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_SITE_ZIP_BYTES } from "../lib/responses";
import { MAX_SITE_TOTAL_BYTES, StaticSiteError, unzipSite, validateAssetPath } from "./static-site";

describe("validateAssetPath", () => {
  it("accepts ordinary relative paths", () => {
    expect(validateAssetPath("index.html")).toBeNull();
    expect(validateAssetPath("assets/app.js")).toBeNull();
  });

  it("rejects empty, traversal, and empty-segment paths", () => {
    expect(validateAssetPath("")).toBeTruthy();
    expect(validateAssetPath("a/../../b")).toBeTruthy();
    expect(validateAssetPath("a//b")).toBeTruthy();
  });

  it("rejects paths over the length cap", () => {
    const seg = "a".repeat(200);
    expect(validateAssetPath(Array(5).fill(seg).join("/"))).toBeTruthy();
    expect(validateAssetPath(Array(4).fill(seg).join("/"))).toBeNull();
  });
});

describe("unzipSite", () => {
  it("inflates a small archive", () => {
    const zip = zipSync({ "index.html": new TextEncoder().encode("<h1>hi</h1>") }, { level: 0 });

    const out = unzipSite(zip);
    expect(new TextDecoder().decode(out["index.html"])).toBe("<h1>hi</h1>");
  });

  it("rejects a single entry above the per-asset cap before inflating", () => {
    const zip = zipSync({ "huge.bin": new Uint8Array(30 * 1024 * 1024) }, { level: 0 });

    let error: unknown;
    try {
      unzipSite(zip);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(StaticSiteError);
    expect((error as StaticSiteError).status).toBe(413);
    expect((error as StaticSiteError).message).toContain("huge.bin");
  });

  it("rejects garbage as a bad ZIP", () => {
    expect(() => unzipSite(new Uint8Array([1, 2, 3, 4]))).toThrow(StaticSiteError);
  });
});

describe("site caps", () => {
  it("keeps the ZIP download cap below the site total cap", () => {
    expect(MAX_SITE_ZIP_BYTES).toBeLessThan(MAX_SITE_TOTAL_BYTES);
  });
});
