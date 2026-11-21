// R2 helpers shared by the services that clean up objects.
//
// R2's multi-key delete accepts an array on supported runtimes; where it
// does not (or when the whole call fails) we fall back to per-key deletes
// so one bad key cannot hide the others.

export interface R2Like {
  R2: R2Bucket;
}

/** Delete `keys` (multi-key first, per-key fallback). Returns the keys that
 *  could not be deleted — empty on full success. Never throws for R2
 *  failures; a listing/permission error surfaces as every key failing. */
export async function r2DeleteAll(env: R2Like, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  try {
    await env.R2.delete([...keys]);
    return [];
  } catch {
    const results = await Promise.allSettled(keys.map((k) => env.R2.delete(k)));
    const failed: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") failed.push(keys[i]);
    });
    return failed;
  }
}
