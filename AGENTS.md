- Admin user credentials for local development
  ```
  UN:admin@inkwell.com
  PW:admin
  ```

## Cloudflare Free plan constraint

Inkwell must run entirely on the Workers **Free** plan. Hold this constraint on every change.

- Never add a Paid-plan feature or binding. Durable Objects are allowed only as SQLite-backed rooms (`new_sqlite_classes`); KV-backed `new_classes` is unavailable. No Queues, Workers AI, Images, Browser Rendering, Hyperdrive, or extra DO namespaces without a product decision.
- Current bindings, keep as-is: `COLLAB` (DO SQLite room, WebSocket hibernation), `DB` (D1), `R2`, `ASSETS` (SPA), daily cron `0 4 * * *`, custom domain `inkwell.zetkey.my.id`.
- Free quotas to design against: DO 100k requests/day and 13k GB-s/day (each WS upgrade is 1 request; incoming WS messages bill at 20:1, so ~2M messages/day); D1 100k rows written/day + 5 GB; R2 free tier (10 GB-month, 1M Class A / 10M Class B ops per month); Workers 10 ms CPU per invocation; WebSocket frames ≤ 32 MiB.
- Keep per-frame and per-request work tiny: send deltas, not scenes; no per-keystroke writes; images ride inline in one frame, so large pastes can approach the frame cap.
- Verify every change with `pnpm typecheck`, `pnpm test`, and `wrangler deploy --dry-run --outdir /tmp/inkwell-dryrun` — it must pass without introducing a binding.
- If a feature approaches a quota (collab room count, autosave cadence, large uploads), say so explicitly and ask for a product decision; never raise usage silently.

