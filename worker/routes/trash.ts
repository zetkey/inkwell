// Trash routes mounted at `/api/trash`.
//
//   GET    /api/trash  — top-level Trash rows (`TrashItem[]`), newest first
//   DELETE /api/trash  — "Empty trash": purge every Trash row for good
//
// Per-item restore/purge live under `/api/items/*`. Semantics are in
// `services/trash.ts`.

import { Hono } from "hono";
import { jsonResponse } from "../lib/responses";
import { requireSession } from "../middleware/auth";
import type { AppEnv } from "../middleware/types";
import { emptyTrash, listTrash } from "../services/trash";

const r = new Hono<AppEnv>();

r.use("*", requireSession);

r.get("/", async (c) => {
  const owner = c.get("session").userId;
  const items = await listTrash(c.env, owner);
  return jsonResponse({ items });
});

r.delete("/", async (c) => {
  const owner = c.get("session").userId;
  const result = await emptyTrash(c.env, owner);
  // Items whose R2 objects could not be deleted keep their rows; report
  // the partial failure instead of claiming a clean empty.
  if (result.failed > 0) {
    return jsonResponse(
      {
        error: `${result.failed} item(s) could not be purged; they stay in Trash for a later retry`,
        purged: result.purged,
        failed: result.failed,
      },
      { status: 500 },
    );
  }
  return jsonResponse({ purged: result.purged });
});

export default r;
