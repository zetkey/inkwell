import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { FileBlob, LoadedFile, MarkdownNotesFileBlob, NotesFileBlob } from "@/lib/api/client";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { EditorHeaderBridge, RenderEditorHeader } from "./editorHeaderBridge";
import { LeaveConfirmDialog } from "./lifecycle/LeaveConfirmDialog";
import { useLeaveConfirm } from "./lifecycle/useLeaveConfirm";
import { useSaveLifecycle } from "./lifecycle/useSaveLifecycle";
import { useThumbPipeline } from "./lifecycle/useThumbPipeline";
import { MarkdownEditorChrome } from "./MarkdownEditorChrome";
import { CodeMirrorEditor } from "./markdown/CodeMirrorEditor";
import {
  fingerprintMarkdown,
  isCanonicalMarkdownBlob,
  notesBlobToMarkdown,
} from "./markdown/compat";
import { MarkdownPreview } from "./markdown/MarkdownPreview";
import { type MarkdownSnapshot, MarkdownSync } from "./markdown/markdownSync";
import { markdownToThumbSvg } from "./markdown/thumb";
import { loadNotesFont } from "./notes/fontLoader";
import { fontStack, useNotesPreferences, widthMaxClass } from "./notes/preferences";

type SaveFn = (version: number, blob: FileBlob) => Promise<{ version: number }>;
type ThumbFn = ((svg: string) => Promise<void>) | null;

export interface MarkdownEditorProps {
  loaded: LoadedFile;
  save: SaveFn;
  saveThumb: ThumbFn;
  onThumbSaved?: () => void;
  onReload?: (loaded: LoadedFile) => void;
  reload?: () => Promise<LoadedFile>;
  renderHeader?: RenderEditorHeader;
}

function initialSource(blob: NotesFileBlob): string | null {
  return isCanonicalMarkdownBlob(blob) ? blob.source : null;
}

export default function MarkdownEditor({
  loaded,
  save,
  saveThumb,
  onThumbSaved,
  onReload,
  reload,
  renderHeader,
}: MarkdownEditorProps) {
  const readOnly = loaded.permission === "read";
  const blob = loaded.blob as NotesFileBlob;
  const canonical = initialSource(blob);
  const [source, setSource] = useState<string | null>(canonical);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { resolved } = useTheme();
  const { width, font, layout } = useNotesPreferences();
  const selectedFont = fontStack(font);
  const initialFingerprint = fingerprintMarkdown(canonical ?? "");
  // Blob produced by our own last save. The parent stores that object in
  // `loaded.blob`; re-seeding from it would rewind CodeMirror while the
  // user keeps typing.
  const ownBlobRef = useRef<FileBlob | null>(null);
  const thumb = useThumbPipeline({ saveThumb, onThumbSaved, readOnly });

  // Typing only records the newest text; the fingerprint, the preview
  // re-render and the save notification are debounced (see `MarkdownSync`).
  const flushRef = useRef<(snapshot: MarkdownSnapshot) => void>(() => {});
  const syncRef = useRef<MarkdownSync | null>(null);
  if (syncRef.current === null) {
    syncRef.current = new MarkdownSync({
      initial: { source: canonical ?? "", fp: initialFingerprint },
      fingerprint: fingerprintMarkdown,
      onFlush: (snapshot) => flushRef.current(snapshot),
    });
  }
  const sync = syncRef.current;

  // Registered before the save lifecycle so these run first on unmount /
  // tab close: the flush reports the newest text while the lifecycle can
  // still schedule the save (afterwards it has already stopped). Without
  // this, continuous typing never crosses the debounce window and the
  // keyboard-only path to the server (beforeunload) would miss it.
  useEffect(() => {
    const flush = () => sync.flush();
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flush);
      sync.dispose();
    };
  }, [sync]);

  // Bumped when a fresh document is loaded so CodeMirror applies it even
  // though `source` normally trails the editor's own doc.
  const [resetNonce, setResetNonce] = useState(0);

  const lifecycle = useSaveLifecycle<FileBlob, LoadedFile>({
    initialVersion: loaded.meta.version,
    initialFingerprint,
    readOnly,
    transport: { save, reload },
    getLatest: () => {
      const latest = sync.read();
      return {
        fp: latest.fp,
        blob: {
          kind: "notes",
          format: "markdown-v1",
          source: latest.source,
        } satisfies MarkdownNotesFileBlob,
      };
    },
    onSaved: (saved) => {
      ownBlobRef.current = saved.blob;
      const persisted = saved.blob as MarkdownNotesFileBlob;
      thumb.request(saved.fp, async () => markdownToThumbSvg(persisted.source));
    },
    onReload,
  });

  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;
  flushRef.current = (snapshot) => {
    setSource(snapshot.source);
    lifecycleRef.current.notifyChange();
  };
  const thumbRef = useRef(thumb);
  thumbRef.current = thumb;
  const loadedVersionRef = useRef(loaded.meta.version);
  loadedVersionRef.current = loaded.meta.version;

  useEffect(() => {
    if (loaded.blob === ownBlobRef.current) return;
    let cancelled = false;
    setLoadError(null);
    const currentBlob = loaded.blob as NotesFileBlob;
    void notesBlobToMarkdown(currentBlob)
      .then((markdown) => {
        if (cancelled) return;
        const fp = fingerprintMarkdown(markdown);
        sync.reset({ source: markdown, fp });
        setSource(markdown);
        setResetNonce((n) => n + 1);
        thumbRef.current.reset();
        lifecycleRef.current.reset(loadedVersionRef.current, fp);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setSource(null);
          setLoadError(
            reason instanceof Error ? reason.message : "Unable to open this Markdown file.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
    // Our own save swaps the blob reference too; that case is skipped
    // above so it can't overwrite unsaved CodeMirror state.
  }, [loaded.blob, sync]);

  useEffect(() => {
    void loadNotesFont(font);
  }, [font]);

  // One transaction: record the text only. The debounced flush mirrors it
  // into React state and notifies the save lifecycle.
  const handleChange = useCallback(
    (next: string) => {
      sync.push(next);
    },
    [sync],
  );

  // Discard must also drop the un-reported window, or the unmount flush
  // would hand the discarded text to the save lifecycle.
  const discardPendingLocalWork = useCallback(() => {
    sync.discard();
    lifecycleRef.current.discardPendingLocalWork();
  }, [sync]);

  const leave = useLeaveConfirm({
    isDirty: lifecycle.isDirty,
    saveNow: lifecycle.saveNow,
    discardPendingLocalWork,
  });
  const { saveNow } = lifecycle;
  const { requestLeave } = leave;
  const bridge = useMemo<EditorHeaderBridge>(
    () => ({
      status: source === null ? "loading" : readOnly ? null : lifecycle.status,
      errorMessage: loadError ?? lifecycle.errorMessage,
      saveNow: readOnly || source === null ? null : () => void saveNow(),
      flush: saveNow,
      discard: discardPendingLocalWork,
      requestLeave,
      toolbar: <MarkdownEditorChrome />,
    }),
    [
      source,
      readOnly,
      loadError,
      lifecycle.status,
      lifecycle.errorMessage,
      saveNow,
      discardPendingLocalWork,
      requestLeave,
    ],
  );

  const previewSource = useDeferredValue(source ?? "");
  const showSource = layout !== "preview";
  const showPreview = layout !== "source";

  return (
    <div className="flex h-full w-full flex-col">
      {renderHeader?.(bridge)}
      {source === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {loadError ?? "Preparing Markdown…"}
        </div>
      ) : (
        <div
          className={cn(
            "markdown-editor-layout min-h-0 flex-1",
            layout === "split" && "markdown-layout-split",
          )}
        >
          {showSource && (
            <section className="markdown-source-pane min-h-0" aria-label="Markdown source">
              <div className={cn("mx-auto h-full w-full", widthMaxClass(width))}>
                <CodeMirrorEditor
                  value={source}
                  resetKey={resetNonce}
                  onChange={handleChange}
                  readOnly={readOnly}
                  dark={resolved === "dark"}
                  fontFamily={selectedFont}
                />
              </div>
            </section>
          )}
          {showPreview && (
            <section
              className="markdown-preview-pane min-h-0 overflow-y-auto"
              aria-label="Markdown preview"
            >
              <div
                className={cn("mx-auto w-full px-5 py-8 sm:px-8 lg:py-10", widthMaxClass(width))}
              >
                <MarkdownPreview
                  source={previewSource}
                  dark={resolved === "dark"}
                  fontFamily={selectedFont}
                />
              </div>
            </section>
          )}
        </div>
      )}
      <LeaveConfirmDialog
        open={leave.open}
        busy={leave.busy}
        onOpenChange={leave.onOpenChange}
        onDiscard={leave.discard}
        onSaveAndLeave={() => void leave.saveAndLeave()}
      />
    </div>
  );
}
