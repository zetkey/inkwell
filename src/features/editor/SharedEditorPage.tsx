// SharedEditor handles both forms of share token:
//   /share/:token                  → file-share (loads /api/share/:token)
//   /share/:token/files/:fileId    → folder-share file (loads /api/share/:token/files/:fileId)
//
// Same layout as the owner editor: `<EditorHeader>` in visitor mode
// (no owner actions; "Shared · View only / Can edit / Live collaboration";
// Download when the link allows it) above the editor surface. The header's
// back button returns to the shared folder on folder-share file routes; on
// a top-level file-share token there's no parent and it's hidden.
// Read-only shares get the canvas in view mode; only `collab` links open
// the realtime socket.

import { useQueryClient } from "@tanstack/react-query";
import { lazy, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useSharedFile } from "@/data/shares";
import type { FileBlob, LoadedFile } from "@/lib/api/client";
import { shares } from "@/lib/api/client";
import { keys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { shouldOpenCollab } from "./collab/gating";
import { collabPathForShare } from "./collab/paths";
import { EditorErrorState, EditorLoadingState, EditorSuspense } from "./EditorChrome";
import { EditorHeader } from "./EditorHeader";
import type { RenderEditorHeader } from "./editorHeaderBridge";
import { SharedStaticSitePreviewRedirect } from "./StaticSitePreviewRedirect";
import { lastLoadedId, saveTarget } from "./saveTarget";

const DrawioEditor = lazy(() => import("@/features/editor/DrawioEditor"));
const ExcalidrawEditor = lazy(() => import("@/features/editor/ExcalidrawEditor"));
const ExcalidrawMenu = lazy(() => import("@/features/editor/ExcalidrawMenu"));
const MarkdownEditor = lazy(() => import("@/features/editor/MarkdownEditor"));

interface SharedEditorProps {
  /** Optional preloaded file; used by SharedTokenLanding to avoid a double fetch. */
  preloaded?: LoadedFile;
}

export function SharedEditorPage({ preloaded }: SharedEditorProps = {}) {
  const params = useParams<{ token: string; fileId?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const token = params.token || "";
  const fileId = params.fileId; // present only on folder-share routes

  // Skip the network when the parent page already resolved the file.
  const fileQuery = useSharedFile(preloaded ? "" : token, fileId);

  const [loaded, setLoaded] = useState<LoadedFile | null>(preloaded ?? null);
  // Non-blocking conflict banner after a 409 → reload (see EditorPage).
  const [conflict, setConflict] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  // Seed working copy on first arrival; thereafter the editor owns it.
  useEffect(() => {
    if (loaded) return;
    if (fileQuery.data) setLoaded(fileQuery.data);
  }, [fileQuery.data, loaded]);

  // Folder-share routes reuse this page for another file; clear the working
  // copy on a real transition so the seed effect above loads the new one and
  // the editor remounts instead of showing the previous file.
  const prevFileIdRef = useRef<string | null>(fileId ?? null);
  useEffect(() => {
    const next = fileId ?? null;
    if (prevFileIdRef.current !== null && prevFileIdRef.current !== next) {
      setLoaded(null);
      setConflict(false);
      setEditorKey((k) => k + 1);
    }
    prevFileIdRef.current = next;
  }, [fileId]);

  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  // Sticky id of the last real working copy (see `saveTarget`): the route
  // param and `loaded` are both unreliable when the unmount flush runs.
  const targetRef = useRef<string | null>(null);
  targetRef.current = lastLoadedId(targetRef.current, loaded);

  // Force-fresh reload after a 409 conflict. The working copy names the
  // file (see `save`); a folder-share route param may already be the next
  // file when this runs, so the fetch and the cache key follow `target`.
  const reload = useCallback(async () => {
    const target = saveTarget(targetRef.current);
    const cacheKey = fileId ? keys.publicShare.token(token, target) : keys.publicShare.token(token);
    const ls = await qc.fetchQuery({
      queryKey: cacheKey,
      queryFn: () => (fileId ? shares.loadFolderFile(token, target) : shares.load(token)),
      staleTime: 0,
    });
    if (loadedRef.current?.meta.id === target) {
      setLoaded(ls);
      setConflict(true);
    }
    return ls;
  }, [qc, token, fileId]);

  const save = useCallback(
    async (version: number, blob: FileBlob) => {
      // Write the file the visitor actually has open, not the route param:
      // on A→B this closure may already be B while the working copy (and
      // the scene) is still A.
      const target = saveTarget(targetRef.current);
      const m = fileId
        ? await shares.saveFolderFile(token, target, version, blob)
        : await shares.save(token, version, blob);
      const prev = loadedRef.current;
      const cacheKey = fileId
        ? keys.publicShare.token(token, target)
        : keys.publicShare.token(token);
      // The PUT succeeded, but the visitor may already be on another
      // shared file. Don't write this scene into it.
      if (!prev || prev.meta.id !== target) {
        qc.invalidateQueries({ queryKey: cacheKey, exact: true });
        return { version: m.version };
      }
      const nextLoaded: LoadedFile = {
        meta: {
          id: target,
          name: m.name,
          kind: m.kind,
          version: m.version,
          updatedAt: m.updatedAt,
          folderId: prev.meta.folderId,
          hasThumb: prev.meta.hasThumb,
          starredAt: prev.meta.starredAt ?? m.starredAt ?? null,
        },
        blob,
        permission: prev.permission,
        allowDownload: prev.allowDownload,
        sharedBy: prev.sharedBy,
        shareExpiresAt: prev.shareExpiresAt,
      };
      setLoaded((cur) => (cur && cur.meta.id === target ? nextLoaded : cur));
      qc.setQueryData(cacheKey, nextLoaded);
      return { version: m.version };
    },
    [qc, token, fileId],
  );

  // Excalidraw only reads `initialData` on mount; remount after a 409
  // reload so the canvas and the collab baseline match the fresh scene.
  const remountAfterConflict = useCallback((ls: LoadedFile) => {
    // The conflict may belong to a file the visitor already left.
    if (loadedRef.current?.meta.id !== ls.meta.id) return;
    setLoaded(ls);
    setEditorKey((k) => k + 1);
  }, []);

  if (fileQuery.isError) {
    return (
      <EditorErrorState message={errorMessage(fileQuery.error, "could not load shared file")} />
    );
  }
  if (!loaded) return <EditorLoadingState label="Loading shared file…" />;

  const writable = loaded.permission !== "read";
  const downloadHref = fileId
    ? shares.folderFileDownloadUrl(token, fileId)
    : shares.downloadUrl(token);
  // Guests have no session, so live collab runs through the share-token
  // route — and only the `collab` mode opens a WebSocket. `write` links are
  // editable without a live session; view-only links stay in view mode.
  const collabPath =
    loaded.permission === "collab" && loaded.meta.kind === "excalidraw"
      ? collabPathForShare(fileId ? { kind: "folder", token, fileId } : { kind: "file", token })
      : undefined;

  if (loaded.meta.kind === "static-site") {
    // Share-token visitors don't see the management surface for
    // static-site bundles — the file tree is an owner concept. We
    // bounce to the signed preview URL exactly the way the top-level
    // `/share/:token` dispatcher does for file shares, but minting
    // through the folder-share render endpoint when this is a
    // folder-share child (fileId present). The share render-session
    // endpoint re-checks `findActive`, so revoking the share kills
    // the outstanding session immediately.
    return (
      <SharedStaticSitePreviewRedirect token={token} fileId={fileId ?? null} blob={loaded.blob} />
    );
  }

  const renderHeader: RenderEditorHeader = (bridge) => (
    <EditorHeader
      bridge={bridge}
      file={{
        id: loaded.meta.id,
        name: loaded.meta.name,
        kind: loaded.meta.kind,
        version: loaded.meta.version,
        folderId: null,
      }}
      onBack={fileId ? () => navigate(`/share/${token}`) : null}
      backLabel="Back to shared folder"
      visitor={{
        expiresAt: loaded.shareExpiresAt,
        sharedBy: loaded.sharedBy
          ? `${loaded.sharedBy.firstName} ${loaded.sharedBy.lastName}`.trim() || null
          : null,
        permission: loaded.permission,
        allowDownload: loaded.allowDownload,
        onDownload: () => {
          void bridge.flush().then(() => {
            window.location.href = downloadHref;
          });
        },
      }}
      conflict={
        conflict
          ? {
              onReload: () => {
                bridge.discard();
                setConflict(false);
                setEditorKey((k) => k + 1);
              },
              onDismiss: () => setConflict(false),
            }
          : null
      }
    />
  );

  const common = {
    loaded,
    save: writable ? save : async () => ({ version: loaded.meta.version }),
    // No thumbnail uploads from share-token sessions — only the
    // owner's saves should advance the canonical thumb.
    saveThumb: null,
    reload,
    onReload: (ls: LoadedFile) => setLoaded(ls),
    renderHeader,
  };

  if (loaded.meta.kind === "drawio") {
    return (
      <EditorSuspense>
        <div className="h-dvh w-full overflow-hidden bg-background">
          <DrawioEditor key={editorKey} {...common} />
        </div>
      </EditorSuspense>
    );
  }

  if (loaded.meta.kind === "notes") {
    return (
      <EditorSuspense>
        <div className="h-dvh w-full overflow-hidden bg-background">
          <MarkdownEditor key={editorKey} {...common} />
        </div>
      </EditorSuspense>
    );
  }

  return (
    <EditorSuspense>
      <div className="h-dvh w-full overflow-hidden bg-background">
        <ExcalidrawEditor
          key={editorKey}
          {...common}
          onReload={remountAfterConflict}
          collabEnabled={shouldOpenCollab(loaded.permission)}
          collabPath={collabPath}
          chrome={
            <ExcalidrawMenu variant="shared" theme={themeMode} onSelectTheme={setThemeMode} />
          }
        />
      </div>
    </EditorSuspense>
  );
}
