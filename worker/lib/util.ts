// Tiny non-HTTP helpers shared across the worker.

export function now(): number {
  return Date.now();
}

// Exhaustiveness guard for discriminated unions. A `default` branch that
// returns `assertNever(value)` will fail TS compilation if a new variant
// is added to the union without a matching case.
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${String(value)}`);
}

/** Escape the characters that terminate HTML/XML text or attributes.
 *  Shared by the static-site seed HTML and the draw.io name attribute,
 *  which both need exactly this set (`& < > "`). */
export function escapeMarkup(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
