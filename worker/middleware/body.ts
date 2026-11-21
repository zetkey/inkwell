// JSON body parsing helper.
//
// Replaces ~14 inline try/catch parsers in the old handlers. Both modes
// refuse a body whose `Content-Length` exceeds `MAX_JSON_BYTES` before
// calling `json()`: `JSON.parse` on a large body costs CPU against the
// Free plan's 10 ms budget, and a chunked (length-less) body is still
// bounded by the platform's request-size limit.
//
// Two modes:
//   * `parseJson<T>(c)`: returns parsed body or a 400 response on
//     malformed JSON. The route checks `if (parsed instanceof Response)
//     return parsed`.
//   * `parseJsonOrEmpty<T>(c)`: returns parsed body or `{}` on missing /
//     malformed JSON. Used by routes whose body fields are all optional
//     and where an empty body is a no-op (e.g. createFile with all
//     defaults, share create with default permission). An oversized body
//     is still a hard 413, never `{}`.

import type { Context } from "hono";
import { bodyDeclaredTooLarge, MAX_JSON_BYTES } from "../lib/http";
import { errorResponse } from "../lib/responses";
import type { AppEnv } from "./types";

function tooLarge(c: Context<AppEnv>): Response | null {
  if (!bodyDeclaredTooLarge(c.req.raw, MAX_JSON_BYTES)) return null;
  return errorResponse(413, `request body exceeds ${MAX_JSON_BYTES} bytes`);
}

export async function parseJson<T>(c: Context<AppEnv>): Promise<T | Response> {
  const oversized = tooLarge(c);
  if (oversized) return oversized;
  try {
    return (await c.req.raw.json()) as T;
  } catch {
    return errorResponse(400, "invalid JSON");
  }
}

export async function parseJsonOrEmpty<T>(c: Context<AppEnv>): Promise<T | Response> {
  const oversized = tooLarge(c);
  if (oversized) return oversized;
  try {
    return (await c.req.raw.json()) as T;
  } catch {
    return {} as T;
  }
}
