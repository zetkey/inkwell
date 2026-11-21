// Filename helpers shared by the owner zip download and the public
// share zip: sanitise a path segment, de-duplicate colliding paths,
// and read the server's Content-Disposition filename.

export function safeSegment(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "untitled";
}

export function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const hasExt = dot > slash + 1;
  const base = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  for (let i = 2; ; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
}

export function filenameFromDisposition(h: string | null): string | null {
  if (!h) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(h);
  return plain ? plain[1] : null;
}
