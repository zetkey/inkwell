import { describe, expect, it, vi } from "vitest";
import type { Env } from "./types";

const mocks = vi.hoisted(() => ({ verifyPassword: vi.fn() }));

vi.mock("./passwords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./passwords")>()),
  verifyPassword: mocks.verifyPassword,
}));
vi.mock("./db/repos/users", () => ({
  findByEmail: async () => null,
  insertIfAbsent: async () => false,
  bumpLastLogin: async () => 1,
}));

import { DUMMY_PASSWORD_HASH, loginWithPassword } from "./auth";

const env = { SUPER_ADMIN_EMAIL: "admin@example.com" } as unknown as Env;

describe("login anti-enumeration", () => {
  it("spends a password verification on an unknown email", async () => {
    mocks.verifyPassword.mockResolvedValue(false);

    const result = await loginWithPassword(env, "ghost@example.com", "whatever");

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(mocks.verifyPassword).toHaveBeenCalledWith("whatever", DUMMY_PASSWORD_HASH);
  });

  it("ships a syntactically valid PBKDF2 hash as the dummy", () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^pbkdf2\$sha256\$100000\$[\w-]+\$[\w-]+$/);
  });
});
