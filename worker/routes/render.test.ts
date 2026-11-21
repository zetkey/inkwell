import { describe, expect, it } from "vitest";
import { assetSecurityHeaders } from "./render";

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
