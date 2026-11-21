// @vitest-environment jsdom
//
// The drawio thumb sanitiser parses real XML and rebuilds it from a
// whitelist, so it needs a DOM. Cases cover the gaps the regex version
// had (character references, unquoted values, @import) plus the
// must-survive markup that keeps a thumbnail looking right.

import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./drawioSanitize";

const NORMAL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect x="1" y="2" width="10" height="10" fill="#e03131"/><text x="4" y="20" font-family="Helvetica">Hi</text></svg>';

describe("sanitizeSvg", () => {
  it("keeps a plain drawing, including viewBox and text", () => {
    const clean = sanitizeSvg(NORMAL_SVG);

    expect(clean).toContain('viewBox="0 0 120 60"');
    expect(clean).toContain("<text");
    expect(clean).toContain("Hi");
    expect(clean).toContain('fill="#e03131"');
  });

  it("removes script elements", () => {
    const clean = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><script type="text/javascript">alert(1)</script><rect/></svg>`,
    );

    expect(clean).not.toContain("script");
    expect(clean).not.toContain("alert(1)");
    expect(clean).toContain("<rect");
  });

  it("removes quoted event handlers", () => {
    const clean = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)" onclick='alert(2)' fill="red"/></svg>`,
    );

    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("onclick");
    expect(clean).toContain('fill="red"');
  });

  it("uploads nothing for unquoted event handlers (the XML is malformed)", () => {
    expect(sanitizeSvg("<svg><rect onload=alert(1)/></svg>")).toBe("");
  });

  it("removes href values hidden behind character references", () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:alert(1)"><rect/></a></svg>',
    );

    expect(clean).not.toContain("javascript");
    expect(clean).not.toContain("href");
    expect(clean).toContain("<rect");
  });

  it("uploads nothing for an unquoted javascript: href", () => {
    expect(
      sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><use href=javascript:alert(1) /></svg>'),
    ).toBe("");
  });

  it("removes style elements (and their @import)", () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://evil.example/x.css");</style><rect/></svg>',
    );

    expect(clean).not.toContain("style");
    expect(clean).not.toContain("@import");
    expect(clean).toContain("<rect");
  });

  it("removes foreignObject HTML labels", () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><rect/></svg>',
    );

    expect(clean).not.toContain("foreignObject");
    expect(clean).not.toContain("hi");
    expect(clean).toContain("<rect");
  });

  it("keeps inline data images and https links", () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAA" width="4" height="4"/><a href="https://example.com"><rect/></a></svg>',
    );

    expect(clean).toContain("data:image/png;base64,AAA");
    expect(clean).toContain("https://example.com");
  });

  it("drops src attributes with a non-image scheme", () => {
    const clean = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><image src="javascript:alert(1)" href="data:image/png;base64,AAA"/></svg>',
    );

    expect(clean).not.toContain("javascript");
    expect(clean).toContain("data:image/png;base64,AAA");
  });

  it("keeps an internal <use> but drops one that references another file", () => {
    const internal = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="#icon"/><symbol id="icon"><rect/></symbol></svg>',
    );
    const external = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/s.svg#icon"/><rect/></svg>',
    );

    expect(internal).toContain("<use");
    expect(internal).toContain("#icon");
    expect(external).not.toContain("<use");
    expect(external).toContain("<rect");
  });

  it("uploads nothing for a broken document", () => {
    expect(sanitizeSvg("<svg><rect></svg>")).toBe("");
  });
});
