// Wire protocol for the Excalidraw realtime-collab endpoint
// (`/api/files/:id/collab`). One JSON message per text frame; this file
// is the single source of truth for both directions so client and server
// can't drift silently.

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

/** A participant as the server describes them. */
export interface Peer {
  peerId: string;
  /** Stable user id (empty for anonymous share visitors). */
  id: string;
  name: string;
  color: string;
  active?: boolean;
}

export interface PointerState {
  x: number;
  y: number;
  tool: string;
}

export type ButtonState = "up" | "down";
export type SelectedElementIds = Record<string, boolean>;

/** A peer's live cursor, as carried by server→client `cursor` messages. */
export interface PeerCursor {
  pointer: PointerState;
  button: ButtonState;
  selectedElementIds: SelectedElementIds;
}

// ─── Client → server ───────────────────────────────────────────────────

/** Must be the first message after open. */
export interface JoinMessage {
  t: "join";
  name: string;
  color: string;
}

/** Delta scene update: changed elements only; `order`/`files` are optional. */
export interface ElementsMessage {
  t: "elements";
  elements: ExcalidrawElement[];
  files?: BinaryFiles;
  order?: string[];
}

export interface CursorMessage {
  t: "cursor";
  pointer: PointerState;
  button: ButtonState;
  selectedElementIds: SelectedElementIds;
}

export interface ActivityMessage {
  t: "activity";
  active: boolean;
}

export type ClientMessage = JoinMessage | ElementsMessage | CursorMessage | ActivityMessage;

// ─── Server → client ───────────────────────────────────────────────────

export interface JoinedMessage {
  t: "joined";
  self: Peer;
  peers: Peer[];
}

export interface PresenceMessage {
  t: "presence";
  peers: Peer[];
}

export interface RemoteElementsMessage extends ElementsMessage {
  from: string;
}

/**
 * Server→client cursor frame. `cursor` is the peer's *pointer*
 * (`{x,y,tool}`); button and selection are top-level — matching the
 * server's relay in `worker/collab.ts`.
 */
export interface RemoteCursorMessage {
  t: "cursor";
  cursor: PointerState;
  button: ButtonState;
  selectedElementIds: SelectedElementIds;
  from: string;
  id: string;
  name: string;
  color: string;
}

export interface ErrorMessage {
  t: "error";
  message: string;
}

export type ServerMessage =
  | JoinedMessage
  | PresenceMessage
  | RemoteElementsMessage
  | RemoteCursorMessage
  | ErrorMessage;
