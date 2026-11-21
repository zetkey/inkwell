// Realtime collaboration for one Excalidraw scene.
//
// Owns the WebSocket lifecycle and the scene/presence bookkeeping; the
// pure merge/diff maths lives in `./merge` and the wire types in
// `./protocol`. The hook is transport-only: it never touches save
// state, so the autosave lifecycle keeps working unchanged.
//
// Echo control: every element the hook sends or applies is stamped in
// `knownRef`, our own pending delta is flushed before a remote merge is
// applied, and `applyingRef` suppresses flushes mid-apply. Excalidraw's
// `onChange` fires for remote applies too, so without this a merged scene
// would bounce back to the sender forever.

import { CaptureUpdateAction, UserIdleState } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  SocketId,
} from "@excalidraw/excalidraw/types";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMe } from "@/data/auth";
import { userDisplayName } from "@/lib/user";
import { shouldRetryConnect } from "./gating";
import {
  changedElements,
  mergeRemoteElements,
  orderChanged,
  orderOf,
  stampElements,
} from "./merge";
import { ownerCollabPath } from "./paths";
import { peerCursorFromFrame, shouldSendSnapshot } from "./presence";
import type {
  ClientMessage,
  ElementsMessage,
  Peer,
  PeerCursor,
  RemoteElementsMessage,
  ServerMessage,
} from "./protocol";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const DELTA_THROTTLE_MS = 100;
const CURSOR_THROTTLE_MS = 50;

// Excalidraw's own collab palette; a peer's color only has to be stable
// and distinct, so a name hash is enough.
const PEER_COLORS = [
  "#e03131",
  "#1971c2",
  "#2f9e44",
  "#f08c00",
  "#9c36b5",
  "#0c8599",
  "#e8590c",
  "#495057",
];

type PointerUpdatePayload = Parameters<NonNullable<ExcalidrawProps["onPointerUpdate"]>>[0];

type PeerState = Peer & { cursor?: PeerCursor };

export interface UseCollabOptions {
  /** Scene id; collab is disabled while null. */
  fileId: string | null;
  /** False for read-only/share-visitor editors. */
  enabled: boolean;
  apiRef: RefObject<ExcalidrawImperativeAPI | null>;
  /**
   * Endpoint path for the socket. Owner editors use the default
   * `/api/files/:id/collab`; share-token editors pass their route
   * (see `./paths`).
   */
  collabPath?: string;
}

export interface UseCollabResult {
  /** Drive Excalidraw's `<Excalidraw isCollaborating>` prop. */
  isCollaborating: boolean;
  /** Drive Excalidraw's `<Excalidraw onPointerUpdate>` prop. */
  onPointerUpdate: (payload: PointerUpdatePayload) => void;
  /** Call from `onChange` with the scene Excalidraw just reported. */
  notifySceneChange: (elements: readonly ExcalidrawElement[], files: BinaryFiles) => void;
}

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PEER_COLORS[hash % PEER_COLORS.length];
}

export function useCollab({
  fileId,
  enabled,
  apiRef,
  collabPath,
}: UseCollabOptions): UseCollabResult {
  const { data: me } = useMe();
  const name = me ? userDisplayName(me) : "Guest";
  const color = useMemo(() => colorFor(name), [name]);

  const [connected, setConnected] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const selfRef = useRef<Peer | null>(null);
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  // Element id → stamp of the last state we sent or applied.
  const knownRef = useRef<Map<string, string>>(new Map());
  // Image ids already shipped or received; each is sent at most once.
  const sentFilesRef = useRef<Set<string>>(new Set());
  const lastOrderRef = useRef<string[]>([]);
  const applyingRef = useRef(false);
  // Peer ids this client has already accounted for; a new id triggers the
  // snapshot handshake (see `shouldSendSnapshot`).
  const presenceSeenRef = useRef<Set<string>>(new Set());
  const pendingSceneRef = useRef<{
    elements: readonly ExcalidrawElement[];
    files: BinaryFiles;
  } | null>(null);
  const deltaTimerRef = useRef<number | null>(null);
  const cursorTimerRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<PointerUpdatePayload | null>(null);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const pushCollaborators = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const selfPeerId = selfRef.current?.peerId;
    const collaborators = new Map<SocketId, Collaborator>();
    for (const peer of peersRef.current.values()) {
      if (peer.peerId === selfPeerId) continue;
      const cursor = peer.cursor;
      collaborators.set(peer.peerId as SocketId, {
        username: peer.name,
        color: { background: peer.color, stroke: peer.color },
        id: peer.id,
        userState: peer.active === false ? UserIdleState.AWAY : UserIdleState.ACTIVE,
        ...(cursor
          ? {
              pointer: cursor.pointer as unknown as NonNullable<Collaborator["pointer"]>,
              button: cursor.button,
              selectedElementIds: cursor.selectedElementIds as unknown as NonNullable<
                Collaborator["selectedElementIds"]
              >,
            }
          : {}),
      });
    }
    api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
  }, [apiRef]);

  const flushDelta = useCallback(() => {
    deltaTimerRef.current = null;
    const pending = pendingSceneRef.current;
    if (!pending || applyingRef.current) return;
    // Offline: keep the pending snapshot (and `knownRef`) untouched so the
    // next change after reconnect still has something to ship.
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    pendingSceneRef.current = null;

    const changed = changedElements(knownRef.current, pending.elements);
    const order = orderOf(pending.elements);
    const sendOrder = orderChanged(lastOrderRef.current, order);

    const files: BinaryFiles = {};
    for (const [id, file] of Object.entries(pending.files)) {
      if (sentFilesRef.current.has(id)) continue;
      files[id] = file;
    }

    if (changed.length === 0 && !sendOrder && Object.keys(files).length === 0) return;

    knownRef.current = stampElements(pending.elements);
    if (sendOrder) lastOrderRef.current = order;

    const message: ElementsMessage = { t: "elements", elements: changed };
    // shortcut: images ride inline in a single text frame, so one very large
    // pasted screenshot can exceed the endpoint's frame limit; upgrade to a
    // chunked/blob upload if users hit that cap.
    if (Object.keys(files).length > 0) {
      message.files = files;
      for (const id of Object.keys(files)) sentFilesRef.current.add(id);
    }
    if (sendOrder) message.order = order;
    send(message);
  }, [send]);

  // Full-scene answer to a freshly seen peer (see `shouldSendSnapshot`).
  // Stamping `knownRef` from the same scene keeps the regular delta path
  // quiet: the snapshot already carries everything, so no echo follows.
  const sendFullSnapshot = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElementsIncludingDeleted();
    const order = orderOf(elements);
    const files = api.getFiles();
    knownRef.current = stampElements(elements);
    lastOrderRef.current = order;
    for (const id of Object.keys(files)) sentFilesRef.current.add(id);
    // Pending edits are part of this snapshot; a stale delta must not follow.
    pendingSceneRef.current = null;
    // shortcut: whole scene plus every image (inline base64) in one frame —
    // image-heavy boards can approach the endpoint's frame limit; upgrade to
    // chunked snapshots if that happens.
    send({
      t: "elements",
      elements: [...elements],
      order,
      ...(Object.keys(files).length > 0 ? { files } : {}),
    });
  }, [apiRef, send]);

  // Remote scene → local one. Ship our own pending delta first, so an
  // edit made between throttles isn't swallowed by the merge. `knownRef`
  // is then stamped before `updateScene`, so the `onChange` it triggers
  // sees no diff (no echo).
  const applyRemote = useCallback(
    (message: RemoteElementsMessage) => {
      const api = apiRef.current;
      if (!api) return;
      if (pendingSceneRef.current) {
        if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current);
        flushDelta();
      }
      applyingRef.current = true;
      try {
        const merged = mergeRemoteElements(
          api.getSceneElementsIncludingDeleted(),
          message.elements,
          api.getAppState(),
          message.order,
        );
        knownRef.current = stampElements(merged);
        lastOrderRef.current = orderOf(merged);
        api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
        if (message.files) {
          const incoming = Object.entries(message.files);
          if (incoming.length === 0) return;
          // Added to `sentFilesRef` so they are not shipped back as "new".
          for (const [id] of incoming) sentFilesRef.current.add(id);
          api.addFiles(incoming.map(([, file]) => file) as BinaryFileData[]);
        }
      } finally {
        applyingRef.current = false;
      }
    },
    [apiRef, flushDelta],
  );

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.t) {
        case "joined":
          selfRef.current = message.self;
          presenceSeenRef.current = new Set([
            message.self.peerId,
            ...message.peers.map((peer) => peer.peerId),
          ]);
          peersRef.current = new Map(message.peers.map((peer) => [peer.peerId, peer]));
          pushCollaborators();
          break;
        case "presence": {
          // Decide before `seen` grows: a peer id we never saw means someone
          // joined or reconnected and may be missing unsaved edits.
          const sendSnapshot = shouldSendSnapshot(
            selfRef.current?.peerId,
            message.peers,
            presenceSeenRef.current,
          );
          const next = new Map<string, PeerState>();
          for (const peer of message.peers) {
            presenceSeenRef.current.add(peer.peerId);
            const previous = peersRef.current.get(peer.peerId);
            next.set(peer.peerId, previous?.cursor ? { ...peer, cursor: previous.cursor } : peer);
          }
          peersRef.current = next;
          pushCollaborators();
          if (sendSnapshot) sendFullSnapshot();
          break;
        }
        case "cursor": {
          const previous = peersRef.current.get(message.from);
          peersRef.current.set(message.from, {
            peerId: message.from,
            id: message.id,
            name: message.name,
            color: message.color,
            active: previous?.active ?? true,
            cursor: peerCursorFromFrame(message),
          });
          pushCollaborators();
          break;
        }
        case "elements":
          applyRemote(message);
          break;
        case "error":
          console.error(`collab: ${message.message}`);
          break;
      }
    },
    [applyRemote, pushCollaborators, sendFullSnapshot],
  );

  const notifySceneChange = useCallback(
    (elements: readonly ExcalidrawElement[], files: BinaryFiles) => {
      if (!enabled) return;
      pendingSceneRef.current = { elements, files };
      if (deltaTimerRef.current === null) {
        deltaTimerRef.current = window.setTimeout(flushDelta, DELTA_THROTTLE_MS);
      }
    },
    [enabled, flushDelta],
  );

  const onPointerUpdate = useCallback(
    (payload: PointerUpdatePayload) => {
      if (!enabled) return;
      pendingCursorRef.current = payload;
      if (cursorTimerRef.current !== null) return;
      cursorTimerRef.current = window.setTimeout(() => {
        cursorTimerRef.current = null;
        const next = pendingCursorRef.current;
        pendingCursorRef.current = null;
        if (!next) return;
        send({
          t: "cursor",
          pointer: { x: next.pointer.x, y: next.pointer.y, tool: next.pointer.tool },
          button: next.button,
          selectedElementIds: apiRef.current?.getAppState().selectedElementIds ?? {},
        });
      }, CURSOR_THROTTLE_MS);
    },
    [apiRef, enabled, send],
  );

  // Baseline: the scene the server already has. Only edits after this
  // point are shipped as deltas (a full-scene push on join would race
  // the server snapshot and re-send every stored image).
  useEffect(() => {
    if (!enabled || !fileId) return;
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElementsIncludingDeleted();
    knownRef.current = stampElements(elements);
    lastOrderRef.current = orderOf(elements);
    sentFilesRef.current = new Set(Object.keys(api.getFiles()));
  }, [enabled, fileId, apiRef]);

  useEffect(() => {
    if (!enabled || !fileId || typeof WebSocket === "undefined") return;
    let disposed = false;
    let attempt = 0;
    // Connects that closed without ever opening (auth rejections look
    // exactly like this); a socket that opened once always retries.
    let failures = 0;
    let everOpened = false;
    let retryTimer: number | null = null;
    let socket: WebSocket | null = null;

    const scheduleReconnect = () => {
      if (disposed) return;
      failures += 1;
      if (!shouldRetryConnect(failures, everOpened)) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      retryTimer = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed) return;
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(
        `${scheme}://${location.host}${collabPath ?? ownerCollabPath(fileId)}`,
      );
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed) {
          socket?.close();
          return;
        }
        attempt = 0;
        failures = 0;
        everOpened = true;
        setConnected(true);
        send({ t: "join", name, color });
        // Edits made while offline kept their pending snapshot; ship it now.
        if (pendingSceneRef.current && deltaTimerRef.current === null) {
          deltaTimerRef.current = window.setTimeout(flushDelta, DELTA_THROTTLE_MS);
        }
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handleServerMessage(message);
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        setConnected(false);
        scheduleReconnect();
      };
      // `error` is always followed by `close`, which owns the retry.
      socket.onerror = () => {};
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
      socket = null;
      socketRef.current = null;
      selfRef.current = null;
      peersRef.current = new Map();
      // A reconnect gets a new peerId; re-seeding from `joined` is what lets
      // the room notice us as fresh and heal our stale scene.
      presenceSeenRef.current = new Set();
      apiRef.current?.updateScene({
        collaborators: new Map(),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
  }, [apiRef, collabPath, color, enabled, fileId, flushDelta, handleServerMessage, name, send]);

  // Away/active presence.
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => send({ t: "activity", active: true });
    const onBlur = () => send({ t: "activity", active: false });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled, send]);

  useEffect(() => {
    return () => {
      if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current);
      if (cursorTimerRef.current !== null) window.clearTimeout(cursorTimerRef.current);
    };
  }, []);

  return {
    isCollaborating: enabled && connected,
    onPointerUpdate,
    notifySceneChange,
  };
}
