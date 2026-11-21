// Presence-side pure helpers: turning a server cursor frame into the
// Excalidraw collaborator shape, and deciding who owes a fresh peer a
// scene snapshot.

import type { Peer, PeerCursor, RemoteCursorMessage } from "./protocol";

/**
 * Server frames carry the peer's pointer directly in `cursor` and keep
 * `button` / `selectedElementIds` at the top level; `pushCollaborators`
 * wants them grouped. A `null` pointer (client sent neither field) is
 * dropped instead of rendering a bogus cursor at 0,0.
 */
export function peerCursorFromFrame(frame: RemoteCursorMessage): PeerCursor | undefined {
  if (!frame.cursor) return undefined;
  return {
    pointer: frame.cursor,
    button: frame.button,
    selectedElementIds: frame.selectedElementIds ?? {},
  };
}

/**
 * Whether this client should answer a presence update with a full scene
 * snapshot.
 *
 * The server builds `peers` from `ctx.getWebSockets()`, i.e. socket
 * creation order, so index 0 is the room's oldest attachment. Only that
 * peer answers a fresh face: everyone else stays quiet, so N simultaneous
 * joiners cost one snapshot instead of N, and a client that reconnects
 * (new peerId) gets healed by the oldest remaining peer.
 *
 * Snapshots exist because the delta baseline is the HTTP-loaded scene:
 * collaborators' unsaved edits (30s autosave debounce) and anything
 * missed while offline would otherwise stay invisible.
 */
export function shouldSendSnapshot(
  selfPeerId: string | null | undefined,
  peers: readonly Peer[],
  seen: ReadonlySet<string>,
): boolean {
  if (!selfPeerId || peers.length === 0) return false;
  if (peers[0].peerId !== selfPeerId) return false;
  return peers.some((peer) => !seen.has(peer.peerId));
}
