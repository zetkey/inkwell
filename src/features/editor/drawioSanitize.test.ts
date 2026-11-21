import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./drawioSanitize";

const NORMAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect x="1" y="2" width="10" height="10" fill="#e03131" stroke-width="2"/><text x="4" y="20" font-family="Helvetica">Hi</text></svg>`;

describe("sanitizeSvg", () => {
  it("leaves a plain drawing untouched", () => {
    expect(sanitizeSvg(NORMAL_SVG)).toBe(NORMAL_SVG);
  });

  it("removes script elements", () => {
    const svg = `<svg>${'<script type="text/javascript">alert(1)</script>'}<rect/></svg>`;

    expect(sanitizeSvg(svg)).toBe("<svg><rect/></svg>");
  });

  it("removes event handler attributes", () => {
    const svg = `<svg><rect onload="alert(1)" onclick='alert(2)' onmouseover=alert(3) fill="red"/></svg>`;

    expect(sanitizeSvg(svg)).toBe('<svg><rect fill="red"/></svg>');
  });

  it("removes javascript: links but keeps https anchors' contents", () => {
    const jsHref = '<svg><a href="javascript:alert(1)"><rect/></a></svg>';
    const xlink = "<svg><a xlink:href='javascript:alert(1)'><rect/></a></svg>";
    const safe = '<svg><a href="https://example.com" target="_blank"><rect/></a></svg>';

    expect(sanitizeSvg(jsHref)).toBe("<svg><rect/></svg>");
    expect(sanitizeSvg(xlink)).toBe("<svg><rect/></svg>");
    expect(sanitizeSvg(safe)).toBe("<svg><rect/></svg>");
  });

  it("removes foreignObject HTML labels", () => {
    const svg =
      '<svg><foreignObject width="10" height="10"><div>hi</div></foreignObject><rect/></svg>';

    expect(sanitizeSvg(svg)).toBe("<svg><rect/></svg>");
  });
});
