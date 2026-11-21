// Login throttle policy, kept pure so the decision is testable without
// D1: the route loads a row, asks these helpers, and records/clears the
// counter in `db/repos/login-attempts.ts`.

/** Failures allowed per window before the key is refused. */
export const LOGIN_MAX_FAILS = 5;
/** Failures allowed per window for the per-source (`ip|*`) bucket. Higher
 *  than the per-credential limit so one office NAT is not locked out by a
 *  single bad actor, while still bounding distributed guessing. */
export const LOGIN_IP_MAX_FAILS = 20;
/** Window length. A lapse restarts the count. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface LoginAttemptRow {
  fails: number;
  reset_at: number;
}

/** `email|ip` — the counter is per credential+source, not per account, so
 *  one attacker can't lock every user out of a shared email. */
export function loginAttemptKey(email: string, ip: string): string {
  return `${email.trim().toLowerCase()}|${ip}`;
}

/** Per-source key, independent of the email being tried. */
export function loginIpKey(ip: string): string {
  return `${ip}|*`;
}

export function isLoginThrottled(
  row: LoginAttemptRow | null,
  at: number,
  maxFails: number = LOGIN_MAX_FAILS,
): boolean {
  if (!row) return false;
  return row.reset_at > at && row.fails >= maxFails;
}

/** `Retry-After` seconds; always ≥ 1 while a window is active. */
export function retryAfterSeconds(row: LoginAttemptRow | null, at: number): number {
  if (!row) return 0;
  return Math.max(1, Math.ceil((row.reset_at - at) / 1000));
}
