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

import { lazy, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useSharedFile } from "@/data/shares";
import type { LoadedFile } from "@/lib/api/client";
import { shares } from "@/lib/api/client";
import { keys } from "@/lib/api/query-keys";
import { errorMessage } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { shouldOpenCollab } from "./collab/gating";
import { collabPathForShare } from "./collab/paths";
import { EditorErrorState, EditorLoadingState, EditorSuspense } from "./EditorChrome";
import { EditorHeader } from "./EditorHeader";
import { type RenderEditorHeader, staticBridge } from "./editorHeaderBridge";
import { FileViewer } from "./FileViewer";
import { SharedStaticSitePreviewRedirect } from "./StaticSitePreviewRedirect";
import { useWorkingCopy } from "./useWorkingCopy";

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
  const token = params.token || "";
  const fileId = params.fileId; // present only on folder-share routes

  // Skip the network when the parent page already resolved the file.
  const fileQuery = useSharedFile(preloaded ? "" : token, fileId);

  // Working copy + sticky save target + 409 recovery (see `useWorkingCopy`).
  // Seeded from `preloaded` when the landing page already resolved the file.
  const {
    loaded,
    setLoaded,
    conflict,
    setConflict,
    editorKey,
    bumpEditorKey,
    save,
    reload,
    remountAfterConflict,
  } = useWorkingCopy(
    {
      save: (target, version, blob) =>
        fileId
          ? shares.saveFolderFile(token, target, version, blob)
          : shares.save(token, version, blob),
      load: (target) => (fileId ? shares.loadFolderFile(token, target) : shares.load(token)),
      cacheKey: (target) =>
        fileId ? keys.publicShare.token(token, target) : keys.publicShare.token(token),
      nextLoaded: (prev, meta, blob) => ({
        meta: {
          id: prev.meta.id,
          name: meta.name,
          kind: meta.kind,
          version: meta.version,
          updatedAt: meta.updatedAt,
          folderId: prev.meta.folderId,
          hasThumb: prev.meta.hasThumb,
          starredAt: prev.meta.starredAt ?? meta.starredAt ?? null,
        },
        blob,
        permission: prev.permission,
        allowDownload: prev.allowDownload,
        sharedBy: prev.sharedBy,
        shareExpiresAt: prev.shareExpiresAt,
      }),
    },
    preloaded ?? null,
  );

  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  // Seed working copy on first arrival; thereafter the editor owns it.
  useEffect(() => {
    if (loaded) return;
    if (fileQuery.data) setLoaded(fileQuery.data);
  }, [fileQuery.data, loaded, setLoaded]);

  // Folder-share routes reuse this page for another file; clear the working
  // copy on a real transition so the seed effect above loads the new one and
  // the editor remounts instead of showing the previous file.
  const prevFileIdRef = useRef<string | null>(fileId ?? null);
  useEffect(() => {
    const next = fileId ?? null;
    if (prevFileIdRef.current !== null && prevFileIdRef.current !== next) {
      setLoaded(null);
      setConflict(false);
      bumpEditorKey();
    }
    prevFileIdRef.current = next;
  }, [fileId, setLoaded, setConflict, bumpEditorKey]);

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

  if (loaded.meta.kind === "file") {
    // Uploaded file: read-only viewer under the visitor header.
    const rawUrl = fileId ? shares.folderFileRawUrl(token, fileId) : shares.rawUrl(token);
    return (
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-background">
        <EditorHeader
          bridge={staticBridge()}
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
            permission: "read",
            allowDownload: loaded.allowDownload,
            onDownload: () => {
              window.location.href = downloadHref;
            },
          }}
        />
        <main className="min-h-0 flex-1">
          <FileViewer
            name={loaded.meta.name}
            mime={loaded.meta.mime ?? null}
            sizeBytes={loaded.meta.sizeBytes ?? null}
            rawUrl={rawUrl}
            downloadUrl={loaded.allowDownload ? downloadHref : null}
          />
        </main>
      </div>
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
        // The redesigned header only knows read/write; a collab link is
        // editable, so show it as "Can edit".
        permission: loaded.permission === "collab" ? "write" : loaded.permission,
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
                void reload()
                  .then((ls) => {
                    setConflict(false);
                    remountAfterConflict(ls);
                  })
                  .catch((e: unknown) => {
                    // Keep the banner; tell the user why nothing changed.
                    toast.error(errorMessage(e, "Reload failed — try again"));
                  });
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
    onConflict: () => setConflict(true),
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
