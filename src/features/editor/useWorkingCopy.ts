// One file's working copy: what the editor is showing, which file a save
// must write to, and how a 409 is recovered.
//
// Both editor pages had their own copy of this. The invariants live here
// once: the PUT follows the loaded file (never the route param, even when
// the route already moved on), a late PUT never overwrites a different
// file's UI or cache, and a conflict reload remounts the editor only when
// the user is still looking at that file.

import { useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";
import type { FileBlob, FileMeta, LoadedFile } from "@/lib/api/client";
import { lastLoadedId, saveTarget } from "./saveTarget";

export interface WorkingCopyTransport {
  /** PUT the blob with optimistic concurrency (If-Match is the API's job). */
  save: (target: string, version: number, blob: FileBlob) => Promise<FileMeta>;
  /** Re-fetch the file after a 409. */
  load: (target: string) => Promise<LoadedFile>;
  /** Query entry that mirrors this working copy. */
  cacheKey: (target: string) => readonly unknown[];
  /** Assemble the new working copy from the PUT result. */
  nextLoaded: (prev: LoadedFile, meta: FileMeta, blob: FileBlob) => LoadedFile;
  /** Extra cache refresh after a save that landed on the active file. */
  onSaved?: () => void;
}

export interface UseWorkingCopyResult {
  loaded: LoadedFile | null;
  setLoaded: Dispatch<SetStateAction<LoadedFile | null>>;
  conflict: boolean;
  setConflict: Dispatch<SetStateAction<boolean>>;
  /** Sticky id of the file a save belongs to (thumbnails use it too). */
  getTarget: () => string | null;
  editorKey: number;
  bumpEditorKey: () => void;
  save: (version: number, blob: FileBlob) => Promise<{ version: number }>;
  reload: () => Promise<LoadedFile>;
  /** After a 409 reload: re-seed and remount, if that file is still shown. */
  remountAfterConflict: (loaded: LoadedFile) => void;
}

export function useWorkingCopy(
  transport: WorkingCopyTransport,
  initial: LoadedFile | null = null,
): UseWorkingCopyResult {
  const qc = useQueryClient();
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const [loaded, setLoaded] = useState<LoadedFile | null>(initial);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  // Sticky id of the last real working copy (see `saveTarget`): it survives
  // the loading-state render and the page's cleanup, which both run before an
  // editor's unmount flush.
  const targetRef = useRef<string | null>(null);
  targetRef.current = lastLoadedId(targetRef.current, loaded);
  const getTarget = useCallback((): string | null => targetRef.current, []);

  const [conflict, setConflict] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const bumpEditorKey = useCallback(() => setEditorKey((key) => key + 1), []);

  const remountAfterConflict = useCallback((ls: LoadedFile) => {
    // The conflict may belong to a file the user already left.
    if (loadedRef.current?.meta.id !== ls.meta.id) return;
    setLoaded(ls);
    setEditorKey((key) => key + 1);
  }, []);

  const reload = useCallback(async () => {
    const target = saveTarget(targetRef.current);
    const active = transportRef.current;
    const ls = await qc.fetchQuery({
      queryKey: active.cacheKey(target),
      queryFn: () => active.load(target),
      staleTime: 0,
    });
    // The save lifecycle still gets `ls`; the working copy is replaced only
    // when it is still the file this reload was for.
    if (loadedRef.current?.meta.id === target) {
      setLoaded(ls);
      setConflict(true);
    }
    return ls;
  }, [qc]);

  const save = useCallback(
    async (version: number, blob: FileBlob): Promise<{ version: number }> => {
      // The PUT must land on the file whose scene the editor holds — the
      // working copy, not the route param.
      const target = saveTarget(targetRef.current);
      const active = transportRef.current;
      const meta = await active.save(target, version, blob);
      const prev = loadedRef.current;
      // The PUT succeeded, but the UI may have moved on. Writing this scene
      // into it would corrupt what's on screen; invalidate instead so a
      // revisit refetches the saved version.
      if (!prev || prev.meta.id !== target) {
        qc.invalidateQueries({ queryKey: active.cacheKey(target), exact: true });
        return { version: meta.version };
      }
      const nextLoaded = active.nextLoaded(prev, meta, blob);
      // The live editor still holds the scene it is editing; replacing
      // `blob` here would make the editors re-seed themselves and drop
      // keystrokes typed during the PUT. Only meta/version advance.
      setLoaded((cur) =>
        cur && cur.meta.id === target ? { ...nextLoaded, blob: prev.blob } : cur,
      );
      // The cache, by contrast, should reflect the persisted content.
      qc.setQueryData(active.cacheKey(target), nextLoaded);
      active.onSaved?.();
      return { version: meta.version };
    },
    [qc],
  );

  return {
    loaded,
    setLoaded,
    conflict,
    setConflict,
    getTarget,
    editorKey,
    bumpEditorKey,
    save,
    reload,
    remountAfterConflict,
  };
}
