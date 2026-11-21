import { describe, expect, it } from "vitest";
import type { StaticSiteFileBlob } from "../types";
import { assetSecurityHeaders, resolveAssetPath } from "./render";

describe("static-site asset headers", () => {
  it("sandboxes the document so it has an opaque origin (no app cookie access)", () => {
    const csp = assetSecurityHeaders("text/html").get("content-security-policy") ?? "";
    const sandbox = csp.split(";")[0].trim();

    expect(sandbox.startsWith("sandbox ")).toBe(true);
    expect(sandbox).toContain("allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
  });

  it("applies the same sandbox when the asset is an SVG document", () => {
    const csp = assetSecurityHeaders("image/svg+xml").get("content-security-policy") ?? "";

    expect(csp.split(";")[0].trim()).toContain("sandbox ");
    expect(csp).not.toContain("allow-same-origin");
  });

  it("keeps the framing and sniffing guards", () => {
    const headers = assetSecurityHeaders("text/html");

    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-type")).toBe("text/html");
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });
});

const manifest: StaticSiteFileBlob = {
  kind: "static-site",
  entry: "index.html",
  assets: [
    { path: "index.html", size: 1, contentType: "text/html", updatedAt: 0 },
    { path: "dir/index.html", size: 1, contentType: "text/html", updatedAt: 0 },
  ],
};

describe("resolveAssetPath", () => {
  it("serves the entry for the root request", () => {
    expect(resolveAssetPath(manifest, "")).toEqual({
      path: "index.html",
      contentType: "text/html",
    });
  });

  it("resolves a directory request to its index.html", () => {
    expect(resolveAssetPath(manifest, "dir/")).toEqual({
      path: "dir/index.html",
      contentType: "text/html",
    });
  });

  it("returns null for an unknown or traversing path", () => {
    expect(resolveAssetPath(manifest, "..")).toBeNull();
    expect(resolveAssetPath(manifest, "dir/../../index.html")).toBeNull();
  });
});
