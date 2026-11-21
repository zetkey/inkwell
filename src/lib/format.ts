// Formatting helpers shared across the app (relative time, byte sizes).
//
// `relTime` was previously copy-pasted into BrowseView and SharedFolder.
// `fmtDateTime` was duplicated as `fmt` in ShareDialog.tsx.

/**
 * Human-friendly relative time: "just now", "5m ago", "3h ago", "2d ago",
 * or an absolute date for anything older than ~30 days.
 */
export function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Locale date + short time, e.g. "11/2/2026 14:32". */
export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * "Expires in 6d" / "expires Jan 12" / null when no expiry. Used by share
 * rows so the fact-of-expiry is at-a-glance visible without computing in
 * the component.
 */
export function expiresPhrase(expiresAt: number | null): string | null {
  if (expiresAt === null) return null;
  const now = Date.now();
  const diff = expiresAt - now;
  if (diff <= 0) return "expired";
  const days = Math.floor(diff / 86_400_000);
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(diff / 3_600_000));
    return `expires in ${hours}h`;
  }
  if (days <= 7) return `expires in ${days}d`;
  return `expires ${new Date(expiresAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

/** Byte size, e.g. "512 B", "1.5 KB", "12.0 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
