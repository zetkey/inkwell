// Which file the autosave must write to.
//
// The route param is not the answer: React runs the route page's cleanup
// before the editor's, and the page re-renders with `loaded = null` (the
// loading state) before the editor unmounts. Both leave the "current
// file" unavailable exactly when the unmount flush needs it, so the id is
// remembered here where it can only ever move to a real value.
//
// `saveTarget` throws instead of returning a no-op version: the save
// lifecycle then reports an error and keeps the edits dirty instead of
// marking a save that never happened as "saved".

export interface IdentifiedFile {
  meta: { id: string };
}

/** Remembers the last real file id across renders where `loaded` is null. */
export function lastLoadedId(
  previous: string | null,
  loaded: IdentifiedFile | null,
): string | null {
  return loaded?.meta.id ?? previous;
}

/** The id to PUT to; throws rather than silently dropping the save. */
export function saveTarget(id: string | null): string {
  if (!id) throw new Error("No file is loaded to save.");
  return id;
}
