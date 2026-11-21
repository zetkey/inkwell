// Realtime collaboration rooms for `kind === "excalidraw"` files.
//
// One Durable Object per file (`idFromName(fileId)`), reached through
// `worker/routes/collab.ts`. Uses the WebSocket Hibernation API: the
// room keeps NO instance state, so an idle room costs 0 duration and
// no storage. Per-socket identity lives in `serializeAttachment` only.
// The authoritative scene stays in R2 + D1 — this DO relays frames and
// never persists a document.
//
// Wire protocol (JSON text frames, one message per frame):
//
//   client → server   {t:"join",name,color}
//                     {t:"elements",elements,files?,order?}
//                     {t:"cursor",pointer,button,selectedElementIds}
//                     {t:"activity",active}
//   server → client   {t:"joined",self,peers}        (sender only)
//                     {t:"presence",peers}           (broadcast)
//                     {t:"elements",…,from}          (relay)
//                     {t:"cursor",cursor,…,from,id,name,color}
//                     {t:"error",message}            (sender only)

/** Max characters in one client frame. 4 MiB is ~2000x a normal
 *  collaborative delta and stays far below the 32 MiB transport limit,
 *  which is a memory ceiling, not a CPU budget. */
export const MAX_FRAME_CHARS = 4 * 1024 * 1024;

export const PEER_COLORS = [
  "#e11d48", // rose
  "#d97706", // amber
  "#0d9488", // teal
  "#2563eb", // blue
  "#7c3aed", // violet
  "#db2777", // pink
  "#65a30d", // lime
  "#0891b2", // cyan
] as const;

// Peer identity as carried by `joined.self` — no `active` (that is a
// presence-only field).
export interface PeerIdentity {
  peerId: string;
  id: string;
  name: string;
  color: string;
}

// One peer = one JSON entry in `presence`.
export interface Peer extends PeerIdentity {
  active: boolean;
}

// Per-socket attachment: peer identity plus its accept sequence.
// `seq` is what makes `peers[0]` deterministically the OLDEST socket —
// `getWebSockets()` order is not guaranteed (locally it is newest-first),
// and clients pick the snapshot sender from index 0.
export interface PeerEntry {
  peer: Peer;
  seq: number;
}

export function identityOf(peer: Peer): PeerIdentity {
  return { peerId: peer.peerId, id: peer.id, name: peer.name, color: peer.color };
}

export function orderPeers(entries: PeerEntry[]): Peer[] {
  return [...entries].sort((a, b) => a.seq - b.seq).map((e) => e.peer);
}

const MAX_NAME_LENGTH = 80;

// Deterministic palette pick so the same user keeps the same color
// across rooms and reconnects. shortcut: two users can collide on a
// color; upgrade to per-room assignment if that ever matters.
export function colorForUserId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (Math.imul(hash, 31) + userId.charCodeAt(i)) | 0;
  }
  return PEER_COLORS[(hash >>> 0) % PEER_COLORS.length];
}

export function presenceFrame(peers: Peer[]): string {
  return JSON.stringify({ t: "presence", peers });
}

function attachmentOf(ws: WebSocket): PeerEntry | null {
  const att = ws.deserializeAttachment() as PeerEntry | null;
  return att?.peer && typeof att.peer.peerId === "string" ? att : null;
}

// A socket can be closing; send() then throws. Presence is refreshed by
// the close handler, so swallowing here is enough.
function safeSend(ws: WebSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    // ignore — the socket is gone
  }
}

function sendError(ws: WebSocket, message: string): void {
  safeSend(ws, JSON.stringify({ t: "error", message }));
}

export class CollabRoom implements DurableObject {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    // Identity is injected by the Worker route (session-backed); a room
    // is never reachable directly with a forged identity.
    const userId = req.headers.get("x-collab-user-id");
    if (!userId) return new Response("missing user identity", { status: 401 });
    const name =
      (req.headers.get("x-collab-user-name") || "Guest").slice(0, MAX_NAME_LENGTH) || "Guest";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const self: Peer = {
      peerId: crypto.randomUUID(),
      id: userId,
      name,
      color: colorForUserId(userId),
      active: true,
    };
    server.serializeAttachment({ peer: self, seq: this.nextSeq() } satisfies PeerEntry);
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Accept order without any instance/storage state: the highest seq
  // among live sockets + 1. Attachments survive hibernation.
  private nextSeq(): number {
    let max = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const att = attachmentOf(socket);
      if (att && att.seq > max) max = att.seq;
    }
    return max + 1;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const att = attachmentOf(ws);
    if (!att) return;
    const self = att.peer;
    if (typeof message !== "string") {
      sendError(ws, "binary frames are not supported");
      return;
    }
    // Frames are incremental deltas (KBs); anything near the transport
    // ceiling is abuse or a pasted image. Refuse before JSON.parse so a
    // hostile frame cannot burn the room's CPU.
    if (message.length > MAX_FRAME_CHARS) {
      sendError(ws, "frame too large");
      return;
    }

    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(message);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("frame is not a JSON object");
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      sendError(ws, "invalid JSON frame");
      return;
    }

    switch (msg.t) {
      case "join":
        // Display name/color from the client are ignored on purpose: the
        // Worker already resolved the session identity.
        safeSend(ws, JSON.stringify({ t: "joined", self: identityOf(self), peers: this.peers() }));
        this.broadcastPresence();
        return;

      case "elements":
        if (!Array.isArray(msg.elements)) {
          sendError(ws, "elements must be an array");
          return;
        }
        // `undefined` extras are dropped by JSON.stringify.
        this.relay(ws, {
          t: "elements",
          elements: msg.elements,
          files: msg.files,
          order: msg.order,
          from: self.peerId,
        });
        return;

      case "cursor":
        this.relay(ws, {
          t: "cursor",
          cursor: msg.pointer ?? msg.cursor ?? null,
          button: msg.button,
          selectedElementIds: msg.selectedElementIds,
          from: self.peerId,
          id: self.id,
          name: self.name,
          color: self.color,
        });
        return;

      case "activity": {
        const active = msg.active === true;
        if (active === self.active) return;
        self.active = active;
        ws.serializeAttachment({ peer: self, seq: att.seq } satisfies PeerEntry);
        this.broadcastPresence();
        return;
      }

      default:
        sendError(ws, "unknown message type");
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // 1005/1006 are pseudo-codes (no status / abnormal) and cannot be
    // sent back; echoing them throws and would skip the presence update.
    const reply = code === 1005 || code === 1006 ? 1000 : code;
    try {
      ws.close(reply, reason);
    } catch {
      // already closed
    }
    this.broadcastPresence(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.broadcastPresence(ws);
  }

  private peers(): Peer[] {
    const entries: PeerEntry[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const att = attachmentOf(socket);
      if (att) entries.push(att);
    }
    return orderPeers(entries);
  }

  private relay(from: WebSocket, payload: Record<string, unknown>): void {
    const frame = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== from) safeSend(socket, frame);
    }
  }

  private broadcastPresence(exclude?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((socket) => socket !== exclude);
    const entries: PeerEntry[] = [];
    for (const socket of sockets) {
      const att = attachmentOf(socket);
      if (att) entries.push(att);
    }
    const frame = presenceFrame(orderPeers(entries));
    for (const socket of sockets) safeSend(socket, frame);
  }
}
