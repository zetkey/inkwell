// Public URL builders for share / invite tokens.
//
// Centralized so we can change the URL shape (e.g. add a subpath, a
// signature segment, or a custom domain) in exactly one place.

/** Public viewer URL for a share token. */
export const shareUrl = (token: string): string => `${location.origin}/share/${token}`;

/** Invite acceptance URL for an invite token. */
export const inviteUrl = (token: string): string => `${location.origin}/invite/${token}`;

/** Percent-encode each path segment of a signed-URL suffix without
 *  touching the slashes. */
export function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
