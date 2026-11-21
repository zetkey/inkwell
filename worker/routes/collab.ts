// Realtime collaboration upgrade routes.
//
// `GET /api/files/:id/collab` (owner) lives here; the token-gated guest
// variants live in `worker/routes/public-share.ts` and share the same
// `forwardCollab` helper. The Worker never speaks WebSocket itself — it
// validates access, then forwards the upgrade to the per-file
// `CollabRoom` Durable Object with the identity headers the room trusts.
// The room relays frames; R2 + D1 stay authoritative.

import { Hono } from "hono";
import * as filesRepo from "../db/repos/files";
import * as usersRepo from "../db/repos/users";
import { randomGuestName } from "../lib/guest-name";
import { errorResponse } from "../lib/responses";
import { requireSession } from "../middleware/auth";
import type { AppEnv } from "../middleware/types";

export interface CollabIdentity {
  /** Stable peer id for the room: owner user id, or `share:<token>`. */
  id: string;
  name: string;
}

// Guest identity is derived from the share token alone — never from
// client input or cookies. The peer id stays token-derived and stable;
// the display name is a random animal phrase so two guests on the same
// token stay distinguishable by peerId + name.
export function guestIdentity(token: string): CollabIdentity {
  return { id: `share:${token}`, name: randomGuestName() };
}

// Shared upgrade forwarder for the owner and share-token routes: one
// place for the 426 guard and the identity headers.
export async function forwardCollab(
  env: AppEnv["Bindings"],
  req: Request,
  fileId: string,
  identity: CollabIdentity,
): Promise<Response> {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(426, "expected websocket upgrade");
  }
  const headers = new Headers(req.headers);
  headers.set("x-collab-user-id", identity.id);
  headers.set("x-collab-user-name", identity.name);
  headers.set("x-collab-file-id", fileId);

  const stub = env.COLLAB.get(env.COLLAB.idFromName(fileId));
  return await stub.fetch(new Request(req, { headers }));
}

const r = new Hono<AppEnv>();

r.use("*", requireSession);

r.get("/:id/collab", async (c) => {
  const owner = c.get("session").userId;
  const fileId = c.req.param("id");

  // findById already scopes to `owner` and hides Trash rows.
  const row = await filesRepo.findById(c.env, owner, fileId);
  if (row?.kind !== "excalidraw") return errorResponse(404, "file not found");

  const who = await usersRepo.displayName(c.env, owner);
  const name = who ? `${who.firstName} ${who.lastName}`.trim() : "";
  return await forwardCollab(c.env, c.req.raw, row.id, { id: owner, name: name || "Guest" });
});

export default r;
