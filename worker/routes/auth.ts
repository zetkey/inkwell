// Public auth routes: login + logout.
//
// Mounted at `/api/auth`. Login bootstraps the super-admin on first
// run (see worker/auth.ts) and is throttled per `email|ip` key
// (worker/lib/login-throttle.ts).

import { Hono } from "hono";
import { clearSessionCookie, createSessionCookie, loginWithPassword } from "../auth";
import * as loginAttemptsRepo from "../db/repos/login-attempts";
import { isLoginThrottled, loginAttemptKey, retryAfterSeconds } from "../lib/login-throttle";
import { errorResponse, jsonResponse } from "../lib/responses";
import { now } from "../lib/util";
import { parseJson } from "../middleware/body";
import type { AppEnv } from "../middleware/types";

const r = new Hono<AppEnv>();

interface LoginBody {
  email?: string;
  password?: string;
}

r.post("/login", async (c) => {
  const body = await parseJson<LoginBody>(c);
  if (body instanceof Response) return body;
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return errorResponse(400, "email and password required");

  // `CF-Connecting-IP` is the client address Cloudflare saw; behind
  // another proxy of ours it degrades to one shared bucket ("unknown"),
  // which is still safer than an unbounded credential-stuffing surface.
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const key = loginAttemptKey(email, ip);
  const at = now();
  const attempt = await loginAttemptsRepo.load(c.env, key);
  if (isLoginThrottled(attempt, at)) {
    return jsonResponse(
      { error: "too many login attempts, try again later" },
      { status: 429, headers: { "retry-after": String(retryAfterSeconds(attempt, at)) } },
    );
  }

  const result = await loginWithPassword(c.env, email, password);
  if (!result.ok) {
    if (result.reason === "misconfigured") {
      return errorResponse(500, "server misconfigured: SUPER_ADMIN_PASSWORD missing");
    }
    await loginAttemptsRepo.recordFailure(c.env, key, at);
    if (result.reason === "disabled") return errorResponse(403, "account disabled");
    return errorResponse(401, "invalid email or password");
  }

  await loginAttemptsRepo.clear(c.env, key);
  const cookie = await createSessionCookie(c.env, result.user);
  return jsonResponse(
    {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.first_name,
      lastName: result.user.last_name,
      isAdmin: result.user.is_admin,
    },
    {
      status: 200,
      headers: { "set-cookie": cookie },
    },
  );
});

r.post(
  "/logout",
  () =>
    new Response(null, {
      status: 204,
      headers: { "set-cookie": clearSessionCookie() },
    }),
);

export default r;
