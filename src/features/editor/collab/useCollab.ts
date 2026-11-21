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
import { batchElements, planDelta, planSnapshot } from "./snapshot";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const DELTA_THROTTLE_MS = 100;
const CURSOR_THROTTLE_MS = 50;
// The room drops clients over ~40 messages/s. Batches drain one per tick,
// paced well under that so a queue of them cannot compete with cursors.
const SNAPSHOT_BATCH_GAP_MS = 50;
// A frame the server refused is retried once the room has calmed down.
const REJECTED_FRAME_RETRY_MS = 250;

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

  /** Returns whether the frame actually went out; callers only advance
   *  their baselines (`knownRef`, `sentFilesRef`) on `true`. */
  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      // Closed between the readyState check and the call.
      return false;
    }
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

  // Scene frames left over when the whole scene cannot fit one frame; each
  // drains on its own tick. `snapshotSceneRef` is the scene the queue is
  // delivering, stamped only once the last batch is on the wire.
  const snapshotQueueRef = useRef<Array<{ elements: ExcalidrawElement[]; order?: string[] }>>([]);
  const snapshotTimerRef = useRef<number | null>(null);
  const snapshotSceneRef = useRef<{
    elements: ExcalidrawElement[];
    order: string[];
    /** Ids that actually fit a batch; only these count as delivered. */
    queuedIds: Set<string>;
  } | null>(null);
  // Elements too big for any frame, already reported once.
  const oversizedWarnedRef = useRef<Set<string>>(new Set());

  /** One warning per oversized element, so the stall is visible but quiet. */
  const warnOversized = useCallback((elements: readonly ExcalidrawElement[]) => {
    const fresh = elements.filter((element) => !oversizedWarnedRef.current.has(element.id));
    if (fresh.length === 0) return;
    for (const element of fresh) oversizedWarnedRef.current.add(element.id);
    console.warn(`collab: element too large to sync (${fresh.map((el) => el.id).join(", ")})`);
  }, []);

  /** Sends the next queued batch. A refused frame stays at the front of the
   *  queue and the baseline is left alone, so the next open/flush retries it. */
  const drainSnapshotQueue = useCallback((): boolean => {
    snapshotTimerRef.current = null;
    const batch = snapshotQueueRef.current[0];
    if (!batch) return true;
    const delivered = send({
      t: "elements",
      elements: batch.elements,
      ...(batch.order ? { order: batch.order } : {}),
    });
    if (!delivered) return false;
    snapshotQueueRef.current.shift();
    if (snapshotQueueRef.current.length > 0) {
      snapshotTimerRef.current = window.setTimeout(drainSnapshotQueue, SNAPSHOT_BATCH_GAP_MS);
      return true;
    }
    // The queue is on the wire: later deltas can be incremental for the
    // elements it carried. Anything the batcher could not fit stays out of
    // the baseline, so it is still "not sent" on the next flush.
    const scene = snapshotSceneRef.current;
    snapshotSceneRef.current = null;
    if (scene) {
      const stamps = stampElements(scene.elements);
      for (const [id, stamp] of stamps) {
        if (scene.queuedIds.has(id)) knownRef.current.set(id, stamp);
      }
      lastOrderRef.current = scene.order;
    }
    return true;
  }, [send]);

  const flushDelta = useCallback(() => {
    deltaTimerRef.current = null;
    const pending = pendingSceneRef.current;
    if (!pending || applyingRef.current) return;
    // Offline: keep the pending snapshot (and `knownRef`) untouched so the
    // next change after reconnect still has something to ship.
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    // A full-scene snapshot is still in flight: a delta now would only repeat
    // it (the baseline stays stale until the queue ends). Retry the queue
    // and keep the pending scene for the next flush.
    if (snapshotQueueRef.current.length > 0) {
      drainSnapshotQueue();
      return;
    }

    const changed = changedElements(knownRef.current, pending.elements);
    const order = orderOf(pending.elements);
    const sendOrder = orderChanged(lastOrderRef.current, order);

    const pendingFiles: BinaryFiles = {};
    for (const [id, file] of Object.entries(pending.files)) {
      if (!sentFilesRef.current.has(id)) pendingFiles[id] = file;
    }

    // Budget the frame before sending: the changed elements always go, then
    // as many images as still fit. Anything left out stays un-sent, so a
    // later, smaller frame can deliver it.
    // shortcut: the `order` list is not measured; it is ids only and the
    // 3 MiB budget leaves 1 MiB of headroom under the room's 4 MiB cap.
    const plan = planDelta(changed, pendingFiles);
    if (plan.skip) {
      // The change (or a reconnect scene) cannot fit one frame. Going quiet
      // would leave the baseline stale, so every later change would compute
      // the same oversized diff and be skipped forever. Ship it as batches
      // instead; the baseline advances when the queue drains.
      const batches = batchElements(changed);
      if (batches.length === 0) {
        // Every element that needs sending is bigger than one frame on its
        // own. Nothing is delivered, so nothing is stamped; warn once instead
        // of looping silently on every change.
        warnOversized(changed);
        pendingSceneRef.current = null;
        return;
      }
      snapshotQueueRef.current = batches.map((batch, index) =>
        index === 0 ? { elements: batch, order } : { elements: batch },
      );
      // `changed` is derived from `pending.elements`, so the queue covers the
      // whole pending scene; only the batched ids become the baseline.
      snapshotSceneRef.current = {
        elements: [...pending.elements],
        order,
        queuedIds: new Set(batches.flat().map((element) => element.id)),
      };
      pendingSceneRef.current = null;
      drainSnapshotQueue();
      return;
    }
    const files = plan.files;

    if (changed.length === 0 && !sendOrder && Object.keys(files).length === 0) {
      pendingSceneRef.current = null;
      return;
    }

    const message: ElementsMessage = { t: "elements", elements: changed };
    if (sendOrder) message.order = order;
    // shortcut: images ride inline in a single text frame, so one very large
    // pasted screenshot can exceed the endpoint's frame limit; upgrade to a
    // chunked/blob upload if users hit that cap.
    if (Object.keys(files).length > 0) message.files = files;

    // Only a delivered frame may advance the baseline; a failed send is
    // retried with the same content on the next flush.
    if (!send(message)) return;

    pendingSceneRef.current = null;
    knownRef.current = stampElements(pending.elements);
    if (sendOrder) lastOrderRef.current = order;
    for (const id of Object.keys(files)) sentFilesRef.current.add(id);
  }, [drainSnapshotQueue, send, warnOversized]);

  // Full-scene answer to a freshly seen peer (see `shouldSendSnapshot`).
  // Stamping `knownRef` from the same scene keeps the regular delta path
  // quiet: the snapshot already carries everything, so no echo follows.
  const sendFullSnapshot = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElementsIncludingDeleted();
    const order = orderOf(elements);
    const files = api.getFiles();
    const fileIds = Object.keys(files);
    const plan = planSnapshot(elements, files);

    // A newer full snapshot supersedes anything still queued from an older
    // scene (the queue would otherwise replay stale geometry afterwards).
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    snapshotQueueRef.current = [];
    snapshotSceneRef.current = null;

    if (plan.skip) {
      // Geometry alone cannot fit one frame. Going silent would leave a
      // peer joining a huge board with an empty canvas, so deliver it in
      // budget-sized batches instead (first one now, the rest per tick).
      const batches = batchElements([...elements]);
      if (batches.length === 0) {
        // The whole scene is made of frames too large to send: report it and
        // leave the baseline untouched rather than pretending it shipped.
        warnOversized(elements);
        return;
      }
      snapshotQueueRef.current = batches.map((batch, index) =>
        index === 0 ? { elements: batch, order } : { elements: batch },
      );
      // The baseline advances only when the last batch is on the wire (see
      // `drainSnapshotQueue`); a refused batch is retried, not dropped.
      snapshotSceneRef.current = {
        elements: [...elements],
        order,
        queuedIds: new Set(batches.flat().map((element) => element.id)),
      };
      // The snapshot covers whatever was pending when it started.
      pendingSceneRef.current = null;
      drainSnapshotQueue();
      return;
    }

    // shortcut: inline base64 images dominate the frame (4 MiB cap). Above
    // the 3 MiB budget the snapshot ships geometry only and leaves the
    // files un-sent, so the next delta delivers them in budget-sized
    // frames — until then a peer keeps whatever images it already had.
    // Upgrade to chunked image transfer if live delivery on join matters.
    const includeFiles = fileIds.length > 0 && plan.includeFiles;
    const delivered = send({
      t: "elements",
      elements: [...elements],
      order,
      ...(includeFiles ? { files } : {}),
    });
    if (!delivered) return;

    knownRef.current = stampElements(elements);
    lastOrderRef.current = order;
    // Pending edits are part of this snapshot; a stale delta must not follow.
    pendingSceneRef.current = null;
    if (includeFiles) {
      for (const id of fileIds) sentFilesRef.current.add(id);
    }
  }, [apiRef, drainSnapshotQueue, send, warnOversized]);

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
        const baseline = knownRef.current;
        const localBefore = api.getSceneElementsIncludingDeleted();
        // Elements the room has never received (a skipped delta, an offline
        // edit): merging a peer's frame must not make them look delivered.
        const neverSent = localBefore.filter((element) => !baseline.has(element.id));
        const merged = mergeRemoteElements(
          localBefore,
          message.elements,
          api.getAppState(),
          message.order,
        );
        const stamps = stampElements(merged);
        for (const element of neverSent) stamps.delete(element.id);
        knownRef.current = stamps;
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
        case "error": {
          // Rate limit / oversized frame: the server refuses after `send()`
          // already succeeded, so anything stamped from that frame is gone.
          // Drop the baseline and re-send the scene through the batch path.
          if (message.message === "too many messages" || message.message === "frame too large") {
            // A batch queue that was draining counted those frames as sent;
            // drop it so the retry starts the scene from the beginning.
            if (snapshotTimerRef.current !== null) {
              window.clearTimeout(snapshotTimerRef.current);
              snapshotTimerRef.current = null;
            }
            snapshotQueueRef.current = [];
            snapshotSceneRef.current = null;
            knownRef.current = new Map();
            lastOrderRef.current = [];
            const api = apiRef.current;
            if (api) {
              pendingSceneRef.current = {
                elements: api.getSceneElementsIncludingDeleted(),
                files: api.getFiles(),
              };
              if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current);
              deltaTimerRef.current = window.setTimeout(flushDelta, REJECTED_FRAME_RETRY_MS);
            }
            return;
          }
          console.error(`collab: ${message.message}`);
          break;
        }
      }
    },
    [apiRef, applyRemote, flushDelta, pushCollaborators, sendFullSnapshot],
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
    // Anything queued for a batch snapshot belongs to the previous scene.
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    snapshotQueueRef.current = [];
    snapshotSceneRef.current = null;
    oversizedWarnedRef.current = new Set();
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
    // Survives reconnects inside this effect, so the next open can tell
    // "first connect" (HTTP baseline is correct) from "we were away".
    let hadOpened = false;
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
        const reconnected = hadOpened;
        hadOpened = true;
        setConnected(true);
        send({ t: "join", name, color });

        // A batch snapshot that ran out of socket retries from here.
        if (snapshotQueueRef.current.length > 0) drainSnapshotQueue();

        if (reconnected) {
          // The room kept its copy while we were away, so our delta baseline
          // is stale: drop it and ship the local scene instead. The server
          // reconciles versions, and the peers see our new peerId and answer
          // with their own snapshots (see `shouldSendSnapshot`).
          knownRef.current = new Map();
          lastOrderRef.current = [];
          const api = apiRef.current;
          if (api) {
            pendingSceneRef.current = {
              elements: api.getSceneElementsIncludingDeleted(),
              files: api.getFiles(),
            };
          }
        }

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
      snapshotQueueRef.current = [];
      snapshotSceneRef.current = null;
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
  }, [
    apiRef,
    collabPath,
    color,
    drainSnapshotQueue,
    enabled,
    fileId,
    flushDelta,
    handleServerMessage,
    name,
    send,
  ]);

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
      if (snapshotTimerRef.current !== null) window.clearTimeout(snapshotTimerRef.current);
    };
  }, []);

  return {
    isCollaborating: enabled && connected,
    onPointerUpdate,
    notifySceneChange,
  };
}
