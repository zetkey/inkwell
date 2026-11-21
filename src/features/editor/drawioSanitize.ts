// Sanitise a drawio SVG export before it is uploaded as a thumbnail.
//
// `Graph.getSvg()` serialises whatever is in the diagram: HTML labels,
// hyperlinks, embedded images and any markup pasted into a label. The
// thumb is served as an image (scripts do not run in that context), so
// this is defence in depth for the stored object itself.
//
// Parsed as XML and rebuilt from a whitelist rather than pattern-matched:
// the regex version missed character references (`&#106;avascript:`),
// unquoted attribute values and `@import` inside `<style>`.

const SVG_NS = "http://www.w3.org/2000/svg";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/** Elements dropped whole: active content, external loads, CSS. */
const DROP_ELEMENTS: Record<string, true> = {
  script: true,
  foreignobject: true,
  style: true,
  iframe: true,
  object: true,
  embed: true,
  audio: true,
  video: true,
};

function isInternalRef(value: string): boolean {
  return value.trimStart().startsWith("#");
}

function isSafeUrl(value: string): boolean {
  const url = value.trim().toLowerCase();
  return url.startsWith("#") || url.startsWith("http:") || url.startsWith("https:");
}

function isSafeImageSrc(value: string): boolean {
  const url = value.trim().toLowerCase();
  return url.startsWith("data:image/") || url.startsWith("http:") || url.startsWith("https:");
}

/** `<use>` may only reference a fragment of this same document: an
 *  external file would be fetched (and could be a foreign document).
 *  Internal `<use href="#id">` symbol reuse keeps working. */
function hasOnlyInternalRefs(element: Element): boolean {
  for (const attr of element.attributes) {
    if (attr.localName.toLowerCase() === "href" && !isInternalRef(attr.value)) return false;
  }
  return true;
}

function scrubAttributes(element: Element): void {
  // `<image>` carries its bytes in `href` (SVG2) or `xlink:href`, so a
  // data:image value is a legitimate source there and nowhere else.
  const isImage = element.localName.toLowerCase() === "image";
  // Copy: `attributes` is live and removal re-indexes it.
  for (const attr of [...element.attributes]) {
    const name = attr.localName.toLowerCase();
    const value = attr.value;
    if (name.startsWith("on")) {
      element.removeAttributeNode(attr);
    } else if (name === "href") {
      if (!isSafeUrl(value) && !(isImage && isSafeImageSrc(value))) {
        element.removeAttributeNode(attr);
      }
    } else if (attr.name.toLowerCase() === "src" && !isSafeImageSrc(value)) {
      element.removeAttributeNode(attr);
    }
  }
}

export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  // A broken document is not worth uploading: no thumb beats a partial one.
  if (root?.localName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    return "";
  }

  for (const element of [...doc.getElementsByTagName("*")]) {
    const tag = element.localName.toLowerCase();
    if (Object.hasOwn(DROP_ELEMENTS, tag) || (tag === "use" && !hasOnlyInternalRefs(element))) {
      element.remove();
      continue;
    }
    scrubAttributes(element);
  }

  // Keep the root renderable when the source omitted the namespace.
  if (!root.hasAttribute("xmlns")) root.setAttributeNS(XMLNS_NS, "xmlns", SVG_NS);

  return new XMLSerializer().serializeToString(doc);
}
