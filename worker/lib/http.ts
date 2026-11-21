// Request-shape helpers shared by the upload routes.
//
// `content-length` is advisory (absent on chunked bodies), so callers must
// still check the buffered size; this only avoids buffering the obvious
// oversized case.

/** True when the request *declares* a body larger than `cap` bytes. */
export function bodyDeclaredTooLarge(req: Request, cap: number): boolean {
  return Number(req.headers.get("content-length") || "0") > cap;
}

/** Cap for JSON request bodies (metadata patches, bulk item batches,
 *  share settings). `JSON.parse` costs ~1 ms/MiB against the Free plan's
 *  10 ms CPU budget, and no legitimate JSON body here comes close to a
 *  megabyte — the bulk item cap is 500 refs (~30 KB). */
export const MAX_JSON_BYTES = 1024 * 1024;
