-- Login throttle: per-key failure counter (`email|ip`).
-- Hand-written: drizzle-kit's journal here only tracks 0000 (0001–0003
-- were also authored by hand), and `wrangler d1 migrations apply` reads
-- the folder, not the journal.
CREATE TABLE `login_attempts` (
  `key` text PRIMARY KEY NOT NULL,
  `fails` integer DEFAULT 0 NOT NULL,
  `reset_at` integer NOT NULL
);
