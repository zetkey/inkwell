// Guard for `pnpm db:generate`.
//
// Migrations 0001–0004 are hand-written; `drizzle/meta/_journal.json` only
// tracks 0000. Running `drizzle-kit generate` against that drift would
// invent a snapshot from scratch and emit destructive SQL. There is no
// safe reconstruction, so this script refuses and points at the real
// workflow instead.
const message = [
  "drizzle-kit generate is disabled in this repo: migrations are hand-written.",
  "",
  "Why: drizzle/meta/_journal.json only records 0000; 0001-0004 were authored",
  "by hand (see drizzle/*.sql). Regenerating snapshots from the schema would",
  'treat every existing table as "unknown" and emit DROP/CREATE statements.',
  "",
  "How to add a migration:",
  "  1. Write drizzle/000N_<slug>.sql by hand (CREATE/ALTER only; safe to",
  "     run before the new Worker is deployed).",
  "  2. Mirror the change in worker/db/schema.ts so Drizzle queries typecheck.",
  "  3. pnpm db:migrate:local    # try it on the local D1",
  "  4. pnpm db:migrate:remote   # or let the deploy workflow apply it",
  "",
  "pnpm db:migrate:local / pnpm db:migrate:remote are unaffected.",
].join("\n");

console.error(message);
process.exit(1);
