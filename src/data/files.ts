// File data hooks.
//
// IMPORTANT: file *save* (the autosave PUT for an open editor) is NOT
// a `useMutation` here. The save-lifecycle hook in
// `src/features/editor/lifecycle/useSaveLifecycle.ts` has its own
// dedup ref, version handshake, and 409-reload-then-reset semantics
// that don't compose with mutation lifecycle. The save closure stays
// in the editor page and does its own optimistic cache update.
//
// `useFile` IS a query, but with `staleTime: Infinity` so the editor
// owns the working copy after first arrival; we never refetch in the
// background and clobber unsaved edits. Reload-after-409 is done via
// `queryClient.fetchQuery` from the page.
//
// Mutations (create/rename/move/delete/tags) go through the shared
// item actions instead, which write the cache optimistically.

import { useQuery } from "@tanstack/react-query";
import {
  type ApiError,
  type FileMeta,
  type FilesQuery,
  files,
  type LoadedFile,
} from "@/lib/api/client";
import { keys } from "@/lib/api/query-keys";

// ─── Queries ──────────────────────────────────────────────────────────
export function useFiles(query: FilesQuery) {
  return useQuery<FileMeta[], ApiError>({
    queryKey: keys.files.list(query),
    queryFn: () => files.list(query),
  });
}

export function useFile(id: string) {
  return useQuery<LoadedFile, ApiError>({
    queryKey: keys.files.detail(id),
    queryFn: () => files.load(id),
    enabled: !!id,
    retry: false,
    // Editor owns the working copy after first arrival.
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
