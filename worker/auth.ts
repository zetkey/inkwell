// Auth and session management for Inkwell.
//
// Session model: an HMAC-signed cookie of the form
//   <userId>.<expiresAtMs>.<base64url(hmacSha256(userId.expiresAt))>
// signed with SESSION_SECRET. Every authenticated request verifies the HMAC,
// re-reads the user row from D1, and rejects disabled / missing users.
// Refreshing the user row on every request lets admin actions (disable,
// demote, delete) take effect immediately rather than waiting for cookie
// expiry.
//
// First-run super-admin bootstrap: on a login attempt where the submitted
// email matches `SUPER_ADMIN_EMAIL` (case-insensitive) and no users row
// exists for that email, we create the super-admin with the supplied
// password (verified against `SUPER_ADMIN_PASSWORD`). After bootstrap, the
// admin manages their password via the UI; the env var is only consulted
// again if no row exists for that email.

import * as usersRepo from "./db/repos/users";
import { hmacSha256, newId, timingSafeEqual } from "./lib/crypto";
import { now } from "./lib/util";
import { hashPassword, verifyPassword } from "./passwords";
import type { Env, UserRow } from "./types";

const COOKIE_NAME = "inkwell_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface Session {
  userId: string;
  email: string;
  isAdmin: boolean;
  expiresAt: number;
}

// ─── Cookie helpers ───────────────────────────────────────────────────
/** Short, non-secret fingerprint of the stored password hash.
 *
 *  Rotating the password re-derives the hash (fresh salt), so this prefix
 *  changes with it. Cookies minted before the change stop matching in
 *  `validateSession` — that is what makes a password change revoke every
 *  existing session without a session table. */
export function sessionHashPrefix(passwordHash: string): string {
  const parts = passwordHash.split("$");
  const digest = parts.length === 5 ? parts[4] : passwordHash;
  return digest.slice(0, 8);
}

export async function createSessionCookie(
  env: Env,
  user: Pick<UserRow, "id" | "password_hash">,
): Promise<string> {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${user.id}.${expiresAt}.${sessionHashPrefix(user.password_hash)}`;
  const sig = await hmacSha256(env.SESSION_SECRET, payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}; Secure`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}

// Parses, verifies HMAC + expiry, then loads the user row. Returns null if
// the cookie is missing, tampered, expired, refers to a missing/disabled
// user, or was minted against a password hash that has since changed.
export async function validateSession(req: Request, env: Env): Promise<Session | null> {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  const value = match[1];
  const lastDot = value.lastIndexOf(".");
  if (lastDot < 0) return null;

  const payload = value.slice(0, lastDot);
  const sig = value.slice(lastDot + 1);
  const expected = await hmacSha256(env.SESSION_SECRET, payload);
  if (!timingSafeEqual(sig, expected)) return null;

  const [userId, expiresAtStr, hashPrefix] = payload.split(".");
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  if (!userId || !hashPrefix) return null;

  const user = await usersRepo.findById(env, userId);
  if (!user || user.disabled) return null;
  if (!timingSafeEqual(hashPrefix, sessionHashPrefix(user.password_hash))) return null;

  return {
    userId: user.id,
    email: user.email,
    isAdmin: user.is_admin,
    expiresAt,
  };
}

// ─── Login + bootstrap ────────────────────────────────────────────────

/**
 * Result of a login attempt. `user` is non-null on success. `reason` is set
 * for the caller to map to an HTTP status / error message.
 */
export type LoginResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: "invalid" | "disabled" | "misconfigured" };

/**
 * Attempts to log in a user by email + password. Runs the super-admin
 * bootstrap path automatically if the email matches `SUPER_ADMIN_EMAIL` and
 * the user row doesn't yet exist.
 */
export async function loginWithPassword(
  env: Env,
  rawEmail: string,
  password: string,
): Promise<LoginResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !password) return { ok: false, reason: "invalid" };

  const isBootstrapEmail =
    !!env.SUPER_ADMIN_EMAIL && email === env.SUPER_ADMIN_EMAIL.trim().toLowerCase();

  let user = await usersRepo.findByEmail(env, email);
  // Bootstrap super-admin on demand.
  if (!user && isBootstrapEmail) {
    if (!env.SUPER_ADMIN_PASSWORD) {
      return { ok: false, reason: "misconfigured" };
    }
    // The supplied password must match SUPER_ADMIN_PASSWORD to claim the
    // super-admin slot. We don't fall back to "create with whatever they
    // typed" because that would let any caller mint the first admin.
    if (!timingSafeEqual(password, env.SUPER_ADMIN_PASSWORD)) {
      return { ok: false, reason: "invalid" };
    }
    const candidate = await buildSuperAdmin(email, password);
    // Two first-run logins can race: `insertIfAbsent` lets exactly one
    // insert win and the other fall through to the winner's row instead
    // of blowing up on a UNIQUE violation.
    if (await usersRepo.insertIfAbsent(env, candidate)) {
      return { ok: true, user: candidate };
    }
    user = await usersRepo.findByEmail(env, email);
    if (!user) return { ok: false, reason: "invalid" };
  }

  if (!user) return { ok: false, reason: "invalid" };
  if (user.disabled) return { ok: false, reason: "disabled" };

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return { ok: false, reason: "invalid" };

  // Update last_login_at; ignore failures (non-critical).
  user.last_login_at = await usersRepo.bumpLastLogin(env, user.id);
  return { ok: true, user };
}

async function buildSuperAdmin(email: string, password: string): Promise<UserRow> {
  const ts = now();
  const hash = await hashPassword(password);
  return {
    id: newId(),
    email,
    password_hash: hash,
    first_name: "Super",
    last_name: "Admin",
    is_admin: true,
    disabled: false,
    created_at: ts,
    updated_at: ts,
    last_login_at: ts,
  };
}

// ─── Self-service password change ─────────────────────────────────────

export async function changeOwnPassword(
  env: Env,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; reason: "invalid_current" | "weak" | "missing" }> {
  if (!newPassword || newPassword.length < 8) return { ok: false, reason: "weak" };
  const user = await usersRepo.findById(env, userId);
  if (!user) return { ok: false, reason: "missing" };
  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) return { ok: false, reason: "invalid_current" };
  const newHash = await hashPassword(newPassword);
  await usersRepo.update(env, userId, { password_hash: newHash, updated_at: now() });
  return { ok: true };
}
