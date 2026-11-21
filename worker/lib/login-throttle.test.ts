import { describe, expect, it } from "vitest";
import {
  isLoginThrottled,
  LOGIN_IP_MAX_FAILS,
  LOGIN_MAX_FAILS,
  LOGIN_WINDOW_MS,
  loginAttemptKey,
  loginIpKey,
  retryAfterSeconds,
} from "./login-throttle";

const AT = 1_000_000;
const row = (fails: number, reset_at: number) => ({ fails, reset_at });

describe("login throttle policy", () => {
  it("keys on normalized email plus source ip", () => {
    expect(loginAttemptKey("  Admin@Example.com ", "1.2.3.4")).toBe("admin@example.com|1.2.3.4");
  });

  it("keys the per-source bucket independently of the email", () => {
    expect(loginIpKey("1.2.3.4")).toBe("1.2.3.4|*");
  });

  it("uses a higher threshold for the per-source bucket", () => {
    const active = row(LOGIN_MAX_FAILS, AT + LOGIN_WINDOW_MS);
    expect(isLoginThrottled(active, AT)).toBe(true);
    expect(isLoginThrottled(active, AT, LOGIN_IP_MAX_FAILS)).toBe(false);
    expect(
      isLoginThrottled(row(LOGIN_IP_MAX_FAILS, AT + LOGIN_WINDOW_MS), AT, LOGIN_IP_MAX_FAILS),
    ).toBe(true);
  });

  it("allows attempts below the limit inside the window", () => {
    expect(isLoginThrottled(row(LOGIN_MAX_FAILS - 1, AT + LOGIN_WINDOW_MS), AT)).toBe(false);
    expect(isLoginThrottled(null, AT)).toBe(false);
  });

  it("locks the key at the limit until the window lapses", () => {
    const active = row(LOGIN_MAX_FAILS, AT + LOGIN_WINDOW_MS);
    expect(isLoginThrottled(active, AT)).toBe(true);
    expect(isLoginThrottled(active, AT + LOGIN_WINDOW_MS)).toBe(false);
  });

  it("reports a positive Retry-After while locked", () => {
    expect(retryAfterSeconds(row(LOGIN_MAX_FAILS, AT + 90_000), AT)).toBe(90);
    expect(retryAfterSeconds(row(LOGIN_MAX_FAILS, AT + 500), AT)).toBe(1);
    expect(retryAfterSeconds(null, AT)).toBe(0);
  });
});
