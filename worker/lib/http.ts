// Request-shape helpers shared by the upload routes.
//
// `content-length` is advisory (absent on chunked bodies), so callers must
// still check the buffered size; this only avoids buffering the obvious
// oversized case.

/** True when the request *declares* a body larger than `cap` bytes. */
export function bodyDeclaredTooLarge(req: Request, cap: number): boolean {
  return Number(req.headers.get("content-length") || "0") > cap;
}
