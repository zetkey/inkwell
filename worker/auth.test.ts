/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, loginWithPassword, sessionHashPrefix, validateSession } from "./auth";
import type * as usersRepoModule from "./db/repos/users";
import { hmacSha256 } from "./lib/crypto";
import { hashPassword } from "./passwords";
import { sqliteD1 } from "./test-support/sqlite-d1";
import type { Env, UserRow } from "./types";

const repoMocks = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  insertIfAbsent: vi.fn(),
  bumpLastLogin: vi.fn(),
}));

// Only the login bootstrap is mocked; session validation runs the real
// `usersRepo.findById` against the SQLite shim below.
vi.mock("./db/repos/users", async (importOriginal) => ({
  ...(await importOriginal<typeof usersRepoModule>()),
  findByEmail: repoMocks.findByEmail,
  insertIfAbsent: repoMocks.insertIfAbsent,
  bumpLastLogin: repoMocks.bumpLastLogin,
}));

const SECRET = "test-secret-test-secret-test-secret";
const COOKIE = "inkwell_session";

let db: DatabaseSync;
let env: Env;

const HASH = "pbkdf2$sha256$100000$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA";

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u1",
    email: "u1@example.com",
    password_hash: HASH,
    first_name: "U",
    last_name: "One",
    is_admin: false,
    disabled: false,
    created_at: 1,
    updated_at: 1,
    last_login_at: null,
    ...overrides,
  };
}

function seed(row: UserRow) {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, first_name, last_name, is_admin, disabled, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.email,
    row.password_hash,
    row.first_name,
    row.last_name,
    row.is_admin ? 1 : 0,
    row.disabled ? 1 : 0,
    row.created_at,
    row.updated_at,
    row.last_login_at,
  );
}

function reqWithCookie(value: string): Request {
  return new Request("https://inkwell.test/api/me", { headers: { cookie: `${COOKIE}=${value}` } });
}

function cookieValue(setCookie: string): string {
  return setCookie.slice(`${COOKIE}=`.length).split(";")[0];
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    )
  `);
  env = {
    DB: sqliteD1(db),
    SESSION_SECRET: SECRET,
    SUPER_ADMIN_EMAIL: "admin@example.com",
    SUPER_ADMIN_PASSWORD: "bootstrap-pass",
  } as unknown as Env;
  repoMocks.findByEmail.mockReset();
  repoMocks.insertIfAbsent.mockReset();
  repoMocks.bumpLastLogin.mockReset();
});

describe("session cookie", () => {
  it("accepts a cookie minted for the current password hash", async () => {
    seed(user());
    const cookie = await createSessionCookie(env, user());

    const session = await validateSession(reqWithCookie(cookieValue(cookie)), env);
    expect(session?.userId).toBe("u1");
  });

  it("rejects a tampered signature", async () => {
    seed(user());
    const value = cookieValue(await createSessionCookie(env, user()));
    const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;

    expect(await validateSession(reqWithCookie(tampered), env)).toBeNull();
  });

  it("rejects an expired cookie even with a valid signature", async () => {
    seed(user());
    const payload = `u1.${Date.now() - 1000}.${sessionHashPrefix(HASH)}`;
    const sig = await hmacSha256(SECRET, payload);

    expect(await validateSession(reqWithCookie(`${payload}.${sig}`), env)).toBeNull();
  });

  it("rejects a disabled user", async () => {
    seed(user({ disabled: true }));
    const cookie = await createSessionCookie(env, user());

    expect(await validateSession(reqWithCookie(cookieValue(cookie)), env)).toBeNull();
  });

  it("revokes cookies minted before a password change", async () => {
    seed(user());
    const oldCookie = cookieValue(await createSessionCookie(env, user()));

    const nextHash = await hashPassword("new-password");
    db.prepare("UPDATE users SET password_hash = ? WHERE id = 'u1'").run(nextHash);

    expect(await validateSession(reqWithCookie(oldCookie), env)).toBeNull();
    const fresh = await createSessionCookie(env, user({ password_hash: nextHash }));
    expect((await validateSession(reqWithCookie(cookieValue(fresh)), env))?.userId).toBe("u1");
  });
});

describe("super-admin bootstrap", () => {
  it("lets two parallel first logins both succeed", async () => {
    // Simulate the real interleaving: both requests read "no user row"
    // before either INSERT lands, so only the ON CONFLICT path saves us.
    let firstReads = 0;
    const rows = new Map<string, UserRow>();
    repoMocks.findByEmail.mockImplementation(async (_env: Env, email: string) => {
      firstReads += 1;
      if (firstReads <= 2) return null;
      return rows.get(email) ?? null;
    });
    repoMocks.insertIfAbsent.mockImplementation(async (_env: Env, row: UserRow) => {
      if (rows.has(row.email)) return false;
      rows.set(row.email, row);
      return true;
    });
    repoMocks.bumpLastLogin.mockImplementation(async () => 1);

    const [a, b] = await Promise.all([
      loginWithPassword(env, "admin@example.com", "bootstrap-pass"),
      loginWithPassword(env, "admin@example.com", "bootstrap-pass"),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(rows.size).toBe(1);
  });

  it("still rejects a wrong bootstrap password", async () => {
    repoMocks.findByEmail.mockResolvedValue(null);

    const result = await loginWithPassword(env, "admin@example.com", "wrong");

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(repoMocks.insertIfAbsent).not.toHaveBeenCalled();
  });
});
