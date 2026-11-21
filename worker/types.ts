// Shared Worker types. Mirrors the bindings declared in wrangler.toml.
//
// Row types are inferred from the Drizzle schema in `worker/db/schema.ts`
// and re-exported here so handlers don't have to import from two places.
// Public ("wire") shapes and `rowTo*Public` mappers stay hand-written —
// they are the JSON contract with the SPA and changing them must be a
// deliberate act.

import type { InferSelectModel } from "drizzle-orm";
import type * as t from "./db/schema";

export interface Env {
  ASSETS: Fetcher;
  R2: R2Bucket;
  DB: D1Database;
  // Durable Object namespace backing realtime collaboration rooms
  // (one room per excalidraw file id). See worker/collab.ts.
  COLLAB: DurableObjectNamespace;
  // Secrets — set via `wrangler secret put`.
  SUPER_ADMIN_EMAIL: string;
  SUPER_ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  // Vars
  ALLOWED_ORIGINS?: string;
}

// ─── Users ────────────────────────────────────────────────────────────
export type UserRow = InferSelectModel<typeof t.users>;

// What we hand to clients. Never includes the password hash.
export interface UserPublic {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

export function rowToUserPublic(r: UserRow): UserPublic {
  return {
    id: r.id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    isAdmin: r.is_admin,
    disabled: r.disabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastLoginAt: r.last_login_at,
  };
}

// Admin-list rows include an aggregated file count (live files only) and
// storage use (trashed files included — they still occupy R2).
export type AdminUserRow = UserRow & { file_count: number; storage_bytes: number };

export interface AdminUserPublic extends UserPublic {
  fileCount: number;
  storageBytes: number;
}

export function rowToAdminUserPublic(r: AdminUserRow): AdminUserPublic {
  return {
    ...rowToUserPublic(r),
    fileCount: r.file_count,
    storageBytes: r.storage_bytes,
  };
}

// ─── Invites ──────────────────────────────────────────────────────────
export type InviteRow = InferSelectModel<typeof t.invites>;

export type InviteStatus = "pending" | "used" | "revoked" | "expired";

export interface InvitePublic {
  token: string;
  status: InviteStatus;
  createdBy: string; // user id of creator
  createdByEmail?: string; // joined for admin listing
  createdAt: number;
  expiresAt: number | null;
  usedByUserId: string | null;
  usedByEmail?: string | null; // joined for admin listing
  usedAt: number | null;
  revokedAt: number | null;
  note: string | null;
}

export function inviteStatus(r: InviteRow, nowMs: number): InviteStatus {
  if (r.revoked_at) return "revoked";
  if (r.used_at) return "used";
  if (r.expires_at !== null && r.expires_at <= nowMs) return "expired";
  return "pending";
}

// Row shape returned by the admin listing JOIN. Fields suffixed `_email`
// come from joined `users` rows (creator and user-who-used).
export type InviteAdminRow = InviteRow & {
  created_by_email: string | null;
  used_by_email: string | null;
};

export function rowToInvitePublic(r: InviteRow | InviteAdminRow, nowMs: number): InvitePublic {
  const out: InvitePublic = {
    token: r.token,
    status: inviteStatus(r, nowMs),
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedByUserId: r.used_by_user_id,
    usedAt: r.used_at,
    revokedAt: r.revoked_at,
    note: r.note ?? null,
  };
  if ("created_by_email" in r) {
    out.createdByEmail = r.created_by_email ?? undefined;
    out.usedByEmail = r.used_by_email;
  }
  return out;
}

// ─── Folders ──────────────────────────────────────────────────────────
export type FolderRow = InferSelectModel<typeof t.folders>;

// Compact preview info for a single file inside a folder. Used by
// `FolderCard` to render thumbnails between the folds. Carries only
// what the card needs — not the full FileMeta.
export type FileKind = "excalidraw" | "drawio" | "notes" | "static-site" | "file";

/** Coerce arbitrary user input to a known FileKind. `"file"` (generic
 *  uploaded bytes) is recognised here so callers can tell it apart and
 *  refuse it where a JSON seed would be needed — uploads are created only
 *  through `POST /api/files/upload`, never by `createFile`. Anything that
 *  isn't an explicit known variant collapses to "excalidraw", the default
 *  file type. This is the single boundary where untrusted `kind` values
 *  become typed. */
export function normalizeFileKind(input: unknown): FileKind {
  if (input === "drawio") return "drawio";
  if (input === "notes") return "notes";
  if (input === "static-site") return "static-site";
  if (input === "file") return "file";
  return "excalidraw";
}

export interface FilePreview {
  id: string;
  kind: FileKind;
  hasThumb: boolean;
  thumbUpdatedAt: number;
}

export interface FolderMeta {
  id: string;
  parentId: string | null;
  name: string;
  tags: string[];
  fileCount: number; // direct children only
  subfolderCount: number; // direct children only
  /** Up to 3 most-recently-updated files inside this folder, newest first.
   *  `previews[0]` is the front-most paper in the FolderCard stack. */
  previews: FilePreview[];
  /** Number of currently-active share tokens whose target is this folder.
   *  Used by `FolderCard` to render the "shared" pill. Always 0 in
   *  visitor (folder-share) responses so recipients can't infer how many
   *  other shares the owner has. */
  activeShareCount: number;
  /** unix-ms when the owner starred this item; `null` if not starred. */
  starredAt: number | null;
  /** Curated icon key (see `lib/folder-meta.ts`); `null` = default. */
  icon: string | null;
  /** Curated colour key; `null` = default. */
  color: string | null;
  /** Free text, ≤ 280 chars. */
  description: string | null;
  /** `null` = not set (display as active). */
  status: "active" | "paused" | "done" | null;
  /** unix-ms when pinned to Home; `null` if not pinned. */
  pinnedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function rowToFolderMeta(
  r: FolderRow,
  extras: {
    tags?: string[];
    fileCount?: number;
    subfolderCount?: number;
    previews?: FilePreview[];
    activeShareCount?: number;
  } = {},
): FolderMeta {
  return {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    tags: extras.tags ?? [],
    fileCount: extras.fileCount ?? 0,
    subfolderCount: extras.subfolderCount ?? 0,
    previews: extras.previews ?? [],
    activeShareCount: extras.activeShareCount ?? 0,
    starredAt: r.starred_at ?? null,
    icon: r.icon ?? null,
    color: r.color ?? null,
    description: r.description ?? null,
    status: r.status ?? null,
    pinnedAt: r.pinned_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── Files ────────────────────────────────────────────────────────────
export type FileRow = InferSelectModel<typeof t.files>;

// API-facing metadata (omits internal fields). `folderId` is `null` when
// the file lives at the root level (no parent folder).
export interface FileMeta {
  id: string;
  folderId: string | null;
  name: string;
  kind: FileKind;
  tags: string[];
  version: number;
  sizeBytes: number;
  /** Content-Type of an uploaded `kind: "file"`; `null` for every other kind. */
  mime: string | null;
  hasThumb: boolean;
  /** Cache-bust token for `/api/files/:id/thumb`. Bumped to `now()` on
   *  every successful thumb upload; `0` means no thumb yet. */
  thumbUpdatedAt: number;
  /** Number of currently-active share tokens whose target is this file.
   *  Used by `FileCard` to render the "shared" pill. Always 0 in
   *  visitor responses (folder-share listing) so recipients can't infer
   *  how many other shares the owner has. */
  activeShareCount: number;
  /** unix-ms when the owner starred this item; `null` if not starred. */
  starredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function rowToMeta(
  r: FileRow,
  tags: string[] = [],
  extras: { activeShareCount?: number } = {},
): FileMeta {
  return {
    id: r.id,
    folderId: r.folder_id ?? null,
    name: r.name,
    kind: r.kind,
    tags,
    version: r.version,
    sizeBytes: r.size_bytes,
    mime: r.mime ?? null,
    hasThumb: r.has_thumb,
    thumbUpdatedAt: r.thumb_updated_at,
    activeShareCount: extras.activeShareCount ?? 0,
    starredAt: r.starred_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── Trash ────────────────────────────────────────────────────────────────────
// Wire shapes for `/api/trash` and `/api/items/restore`. Mirrors
// `TrashItem` / `RestoredItem` / `MovePrevious` in src/lib/api/client.ts.
export interface TrashItemPublic {
  type: "file" | "folder";
  id: string;
  name: string;
  kind?: FileKind;
  /** e.g. "Home / A / B" — where the item lived when it was trashed. */
  originalPath: string;
  originalParentId: string | null;
  deletedAt: number;
  purgeAt: number;
  /** Folders only: files + folders trashed along with it. */
  itemCount?: number;
  sizeBytes?: number;
}

export interface RestoredItemPublic {
  type: "file" | "folder";
  id: string;
  parentId: string | null;
  relocatedToRoot: boolean;
}

export interface MovePreviousPublic {
  type: "file" | "folder";
  id: string;
  parentId: string | null;
}

// ─── Tags ─────────────────────────────────────────────────────────────
export type TagRow = InferSelectModel<typeof t.tags>;

export interface TagPublic {
  id: string;
  name: string;
  fileCount: number;
  folderCount: number;
}

export type TagTargetType = "file" | "folder";

// What the client PUTs as a file blob. We don't validate the inner shape
// of `elements` / `appState` / `files` — Excalidraw owns that schema and
// it changes between versions. We just round-trip the JSON.
export interface ExcalidrawFileBlob {
  /** Optional for backward compatibility with existing stored blobs. */
  kind?: "excalidraw";
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export interface DrawioFileBlob {
  kind: "drawio";
  xml: string;
}

/** Type guard for a stored draw.io blob. Lives here (not in the
 *  file-blob service) so the response layer can narrow without importing
 *  the service and creating a module cycle. */
export function isDrawioBlob(blob: FileBlob): blob is DrawioFileBlob {
  return (
    (blob as { kind?: unknown }).kind === "drawio" &&
    typeof (blob as { xml?: unknown }).xml === "string"
  );
}

/** Canonical representation for Markdown documents. The internal
 * `notes` kind is retained for database and API compatibility. */
export interface MarkdownNotesFileBlob {
  kind: "notes";
  format: "markdown-v1";
  source: string;
}

/** Legacy BlockNote JSON, accepted so existing documents remain readable. */
export interface LegacyNotesFileBlob {
  kind: "notes";
  blocks: unknown[];
}

export type NotesFileBlob = MarkdownNotesFileBlob | LegacyNotesFileBlob;

/** One asset inside a static-site bundle. Paths are forward-slash,
 *  no leading slash, no `..`, no empty segments. `contentType` is
 *  resolved from the extension at upload time so the render route
 *  can serve assets without re-sniffing. */
export interface StaticSiteAsset {
  path: string;
  size: number;
  contentType: string;
  /** unix-ms of the most recent upload of this asset. */
  updatedAt: number;
}

/** Manifest for a `kind === "static-site"` file. Stored as the
 *  canonical R2 JSON blob (same key path as the other kinds) so
 *  `streamFileResponse` and the existing reader plumbing work
 *  unchanged. Mutations go through dedicated asset endpoints; direct
 *  PUTs of this manifest are rejected to keep R2 and the manifest
 *  consistent. */
export interface StaticSiteFileBlob {
  kind: "static-site";
  /** Asset path served for the root request (`GET /sites/.../` or `GET /shared/.../`).
   *   Must exist in `assets`. */
  entry: string;
  /** Sorted alphabetically by path. */
  assets: StaticSiteAsset[];
}

export type FileBlob = ExcalidrawFileBlob | DrawioFileBlob | NotesFileBlob | StaticSiteFileBlob;

// ─── Shares (polymorphic) ────────────────────────────────────────────
// read   = view only
// write  = save file content, no realtime room
// collab = save file content + join the realtime room
export type SharePermission = "read" | "write" | "collab";
export type ShareTargetType = "file" | "folder";

// Saving file content: write and collab links (not read).
export function canEditPermission(p: SharePermission): boolean {
  return p !== "read";
}

// What a link is allowed to do. "edit" = save file content, "write" =
// structural operations (create/delete files, assets), "collab" = open
// a realtime WebSocket room.
export type ShareNeed = "edit" | "write" | "collab";

export function sharePermissionAllows(permission: SharePermission, need: ShareNeed): boolean {
  if (need === "collab") return permission === "collab";
  if (!canEditPermission(permission)) return false;
  return need === "edit" || permission === "write";
}

export type ShareRow = InferSelectModel<typeof t.shares>;

export interface SharePublic {
  token: string;
  targetType: ShareTargetType;
  targetId: string;
  targetName?: string; // joined for listing
  permission: SharePermission;
  allowDownload: boolean;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastAccessedAt: number | null;
}

export function rowToSharePublic(r: ShareRow, targetName?: string): SharePublic {
  return {
    token: r.token,
    targetType: r.target_type,
    targetId: r.target_id,
    targetName,
    permission: r.permission,
    allowDownload: r.allow_download,
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastAccessedAt: r.last_accessed_at,
  };
}

export function isShareActive(r: ShareRow, nowMs: number): boolean {
  if (r.revoked_at) return false;
  if (r.expires_at !== null && r.expires_at <= nowMs) return false;
  return true;
}

/** Shape guard for a stored static-site manifest. Lives here (not in the
 *  static-site service) so the response layer can narrow without importing
 *  a service. */
export function isStaticSiteBlob(blob: unknown): blob is StaticSiteFileBlob {
  if (!blob || typeof blob !== "object") return false;
  const o = blob as { kind?: unknown; entry?: unknown; assets?: unknown };
  if (o.kind !== "static-site") return false;
  if (typeof o.entry !== "string" || !o.entry) return false;
  if (!Array.isArray(o.assets)) return false;
  for (const a of o.assets) {
    if (!a || typeof a !== "object") return false;
    const r = a as Record<string, unknown>;
    if (typeof r.path !== "string") return false;
    if (typeof r.size !== "number") return false;
    if (typeof r.contentType !== "string") return false;
    if (typeof r.updatedAt !== "number") return false;
  }
  return true;
}
