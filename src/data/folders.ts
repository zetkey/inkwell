// Folder data hooks.

import { useQuery } from "@tanstack/react-query";
import { type ApiError, type FolderMeta, folders } from "@/lib/api/client";
import { keys } from "@/lib/api/query-keys";

export function useFolders() {
  return useQuery<FolderMeta[], ApiError>({
    queryKey: keys.folders.list(),
    queryFn: () => folders.list(),
  });
}
