// Public auth routes: login + logout.
//
// Mounted at `/api/auth`. Login bootstraps the super-admin on first
// run (see worker/auth.ts) and is throttled per `email|ip` key
// (worker/lib/login-throttle.ts).

import { Hono } from "hono";
import { clearSessionCookie, createSessionCookie, loginWithPassword } from "../auth";
import * as loginAttemptsRepo from "../db/repos/login-attempts";
import {
  isLoginThrottled,
  LOGIN_IP_MAX_FAILS,
  loginAttemptKey,
  loginIpKey,
  retryAfterSeconds,
} from "../lib/login-throttle";
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
  const emailKey = loginAttemptKey(email, ip);
  const ipKey = loginIpKey(ip);
  const at = now();
  // Two buckets: per credential+source (low threshold, stops guessing one
  // account) and per source (high threshold, stops spraying many emails).
  const [emailAttempt, ipAttempt] = await Promise.all([
    loginAttemptsRepo.load(c.env, emailKey),
    loginAttemptsRepo.load(c.env, ipKey),
  ]);
  if (isLoginThrottled(emailAttempt, at) || isLoginThrottled(ipAttempt, at, LOGIN_IP_MAX_FAILS)) {
    const wait = Math.max(retryAfterSeconds(emailAttempt, at), retryAfterSeconds(ipAttempt, at));
    return jsonResponse(
      { error: "too many login attempts, try again later" },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }

  const result = await loginWithPassword(c.env, email, password);
  if (!result.ok) {
    if (result.reason === "misconfigured") {
      return errorResponse(500, "server misconfigured: SUPER_ADMIN_PASSWORD missing");
    }
    await Promise.all([
      loginAttemptsRepo.recordFailure(c.env, emailKey, at),
      loginAttemptsRepo.recordFailure(c.env, ipKey, at),
    ]);
    if (result.reason === "disabled") return errorResponse(403, "account disabled");
    return errorResponse(401, "invalid email or password");
  }

  await Promise.all([
    loginAttemptsRepo.clear(c.env, emailKey),
    loginAttemptsRepo.clear(c.env, ipKey),
  ]);
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
