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

/** Validate the declared size of a JSON request body before it is parsed.
 *
 *  `"missing-length"` means no usable `Content-Length`, which in practice
 *  is a chunked body: with no declared size the cap cannot be enforced
 *  before `JSON.parse`, so mutating JSON routes answer 411 instead of
 *  buffering an unbounded body. `"too-large"` is over the cap (413).
 *  `null` means the body may be parsed. */
export function jsonBodyProblem(
  req: Request,
  cap: number = MAX_JSON_BYTES,
): "missing-length" | "too-large" | null {
  const header = req.headers.get("content-length");
  if (header === null) return "missing-length";
  const size = Number(header);
  if (!Number.isInteger(size) || size < 0) return "missing-length";
  return size > cap ? "too-large" : null;
}
