// Sanitise a drawio SVG export before it is uploaded as a thumbnail.
//
// `Graph.getSvg()` serialises whatever is in the diagram, including HTML
// labels (`<foreignObject>`), hyperlinks and any markup a user pasted.
// The thumb is served as an image and rendered in an `<img>`, which
// already blocks scripts, but the stored asset should not carry active
// content at all — this strips it before the PUT.
//
// String-based on purpose: the editor runs in the browser but the rule
// set is small and must be testable without a DOM parser.

export function sanitizeSvg(svg: string): string {
  return (
    svg
      // Whole elements first, so their contents can't leave dangling tags.
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<script\b[^>]*\/>/gi, "")
      .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "")
      .replace(/<foreignObject\b[^>]*\/>/gi, "")
      // Event handlers, quoted and unquoted.
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
      // Links that would run script.
      .replace(/\b(href|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, "")
      .replace(/\b(href|xlink:href)\s*=\s*'\s*javascript:[^']*'/gi, "")
      // Anchors themselves are not meaningful on a thumbnail; unwrap them
      // and keep the drawing they wrap (all remaining hrefs are inert).
      .replace(/<\/?a\b[^>]*>/gi, "")
  );
}
