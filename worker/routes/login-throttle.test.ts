import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../middleware/types";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  recordFailure: vi.fn(),
  clear: vi.fn(),
  loginWithPassword: vi.fn(),
}));

vi.mock("../db/repos/login-attempts", () => ({
  load: mocks.load,
  recordFailure: mocks.recordFailure,
  clear: mocks.clear,
  deleteExpired: vi.fn(),
}));
vi.mock("../auth", () => ({
  loginWithPassword: mocks.loginWithPassword,
  createSessionCookie: async () => "inkwell_session=stub",
  clearSessionCookie: () => "inkwell_session=; Max-Age=0",
}));

import authRoutes from "./auth";

const app = new Hono<AppEnv>();
app.route("/api/auth", authRoutes);

const env = {} as never;
const at = Date.now();

function login(email: string, ip: string) {
  return app.request(
    "http://localhost/api/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ email, password: "pw" }),
    },
    env,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue(null);
  mocks.recordFailure.mockResolvedValue(1);
  mocks.clear.mockResolvedValue(undefined);
  mocks.loginWithPassword.mockResolvedValue({
    ok: true,
    user: {
      id: "u1",
      email: "u1@example.com",
      password_hash: "pbkdf2$sha256$100000$a$b",
      first_name: "U",
      last_name: "One",
      is_admin: false,
      disabled: false,
      created_at: 1,
      updated_at: 1,
      last_login_at: 1,
    },
  });
});

describe("login throttle buckets", () => {
  it("keeps blocking a source whose IP bucket is exhausted, even after a valid login", async () => {
    mocks.load.mockImplementation(async (_env: unknown, key: string) =>
      key.endsWith("|*") ? { fails: 20, reset_at: at + 60_000 } : null,
    );

    const res = await login("someone@example.com", "1.1.1.1");

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(mocks.loginWithPassword).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("clears only the email bucket on success, never the IP bucket", async () => {
    const res = await login("someone@example.com", "1.1.1.1");

    expect(res.status).toBe(200);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.clear).toHaveBeenCalledWith(env, "someone@example.com|1.1.1.1");
    expect(mocks.clear).not.toHaveBeenCalledWith(env, "1.1.1.1|*");
  });
});
