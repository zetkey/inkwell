// R2 key layout. Kept in its own module so low-level helpers (responses)
// and the services that write those objects can share the layout without
// importing each other.

/** File blob. The `scenes/` prefix is historical — it predates the
 *  file-kind rename; changing it would mean copying every blob. */
export function r2FileKey(id: string): string {
  return `scenes/${id}.json`;
}

/** Thumbnail SVG. */
export function r2ThumbKey(id: string): string {
  return `thumbs/${id}.svg`;
}

/** One static-site asset, addressed by the manifest's relpath. */
export function r2StaticSiteAssetKey(id: string, relpath: string): string {
  return `static-sites/${id}/${relpath}`;
}

/** Prefix covering every asset of one static site. */
export function r2StaticSitePrefix(id: string): string {
  return `static-sites/${id}/`;
}
