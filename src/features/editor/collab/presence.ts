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
 * Exactly one client answers: the lowest peer id **among peers this
 * client has already seen** (self included). Unseen peers are excluded —
 * the newcomer cannot be elected because it has no unseen peer itself and
 * would never send. Peer ids are random per socket, so the election is
 * independent of join order, survives reconnects, and keeps N
 * simultaneous joiners at one snapshot instead of N.
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
  // Nothing new to deliver: stay quiet.
  if (!peers.some((peer) => !seen.has(peer.peerId))) return false;
  // Elect only among peers we already know (self included). An unseen
  // peer may be the one that just joined: it has nothing unseen itself,
  // so electing it would leave the newcomer with no snapshot at all.
  let elected = selfPeerId;
  for (const peer of peers) {
    if (!seen.has(peer.peerId)) continue;
    if (peer.peerId < elected) elected = peer.peerId;
  }
  return elected === selfPeerId;
}
