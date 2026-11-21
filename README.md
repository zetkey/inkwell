# Inkwell

[![Formatting](https://github.com/ThilinaTLM/inkwell/actions/workflows/format.yml/badge.svg)](https://github.com/ThilinaTLM/inkwell/actions/workflows/format.yml)
[![Linting](https://github.com/ThilinaTLM/inkwell/actions/workflows/lint.yml/badge.svg)](https://github.com/ThilinaTLM/inkwell/actions/workflows/lint.yml)
[![Unit tests](https://github.com/ThilinaTLM/inkwell/actions/workflows/test.yml/badge.svg)](https://github.com/ThilinaTLM/inkwell/actions/workflows/test.yml)
[![Build](https://github.com/ThilinaTLM/inkwell/actions/workflows/build.yml/badge.svg)](https://github.com/ThilinaTLM/inkwell/actions/workflows/build.yml)

A small, self-hosted dashboard for [Excalidraw](https://excalidraw.com/) and
[draw.io](https://www.drawio.com/) diagrams, built to run entirely on
Cloudflare. File blobs live in **R2**, the metadata index lives in **D1**,
and a single **Worker** serves both the React SPA and the API. No servers
to babysit, no egress fees.

> **Honoring the work this stands on.** Inkwell is just a thin wrapper around
> the wonderful [Excalidraw](https://github.com/excalidraw/excalidraw) editor
> — all the actual drawing, the hand-drawn aesthetic, the interaction model,
> and the file format are theirs. This project only adds: persistent storage,
> a multi-file dashboard, and share links. If you like Inkwell, the credit
> belongs upstream; please consider supporting [Excalidraw+](https://plus.excalidraw.com/)
> or contributing to the open-source project.
>
> Design ideas were also borrowed (with thanks) from
> [ExcaliDash](https://github.com/ZimengXiong/ExcaliDash),
> [excalidraw-persist](https://github.com/ozencb/excalidraw-persist), and
> [excalidraw-full](https://github.com/BetterAndBetterII/excalidraw-full).

## Why this exists

The free Excalidraw web app keeps your drawings in browser local storage —
one canvas at a time. Excalidraw+ solves the multi-file problem but is a
hosted paid product. Inkwell is the smallest thing that could possibly be:
**"my Excalidraw and draw.io, with many saved files, organized in folders,
on Cloudflare."**

Features at a glance:

- A file-manager-style **app shell**: top bar, sidebar (Library, folder
  tree, tags, Settings, Users), a details panel and a status bar on every
  signed-in page
- **Explorer views**: Grid, Compact, Details (sortable list with column
  chooser) and Columns (Miller). The view is remembered per folder.
  Multi-select (click, ⌘/Ctrl-click, ⇧-click, rubber band, ⌘A), inline
  rename, quick look, drag-and-drop move (onto folders, breadcrumbs, the
  sidebar tree or Trash; hold ⌥/Alt to duplicate), cut/copy/paste
- **Keyboard first**: every action is available from a button, a context
  menu and a shortcut. The **command palette** (⌘K / Ctrl+K) searches files,
  folders, tags and commands. The **shortcut sheet** (`?`) lists every
  binding, and shortcuts can be rebound in *Settings → Shortcuts*.
  Moves, renames, tag edits, stars and trashing can be undone (⌘Z or the
  toast's *Undo* button).
- **Trash** with restore, *Delete forever*, *Empty trash* and an automatic
  purge after 30 days. **Starred** and **Recent** views, and tag pages.
- **Duplicate** files and whole folders (including R2 blobs, thumbnails and
  static-site assets)
- **Uploads for every file kind**: drop files or folders from the desktop, or
  use Upload / `U`. `.excalidraw`, `.drawio`/`.xml`, Markdown/text (preserved
  as Markdown) and `.zip`/HTML bundles (Static sites) are supported, with
  conflict handling (keep both / replace / skip) and an upload tray.
- Multi-file dashboard with **folders** (nested, per-user) and **tags**
- Four equal-priority file kinds today: Excalidraw, draw.io, **Markdown** via
  [CodeMirror](https://codemirror.net/) with GFM, Mermaid and TeX previews,
  and **Static sites** for publishing uploaded HTML/CSS/JS bundles
- **Share links** for individual files or whole folder subtrees, read or
  read-write, with optional expiry and downloads, managed from one filterable
  *Shared links* page
- **Email + password auth**, invitation-only signup (invites can carry a
  note), super-admin bootstrap
- Client-rendered SVG thumbnails, debounced autosave, optimistic concurrency

## Architecture

```
Browser (React + Excalidraw + CodeMirror)
   │
   │  fetch (HttpOnly cookie session)
   ▼
Cloudflare Worker  ──►  R2  file blobs + SVG thumbnails
                   ──►  D1  metadata index (users, folders, files, tags, shares)
```

Key choices:

- **R2 holds the bytes, D1 holds the index.** Listing the dashboard never
  hits R2 — D1 returns metadata in milliseconds. R2 is only touched on open
  and save.
- **Static-site files** are multi-asset bundles: the canonical JSON blob
  is a *manifest* listing every uploaded file, and each asset lives at
  `static-sites/{id}/{relpath}` in R2. The Worker serves them through a
  signed `/sites/...` (owner) and `/shared/...` (share-token) routes so uploaded JS
  cannot read session cookies or call `/api/*` as the owner. See
  [`worker/services/static-site.ts`](./worker/services/static-site.ts)
  and [`worker/routes/render.ts`](./worker/routes/render.ts).
- **Markdown is stored as source**, not an editor-specific syntax tree. The
  CodeMirror editor and unified/remark preview support GFM, Mermaid diagrams,
  KaTeX formulas and highlighted code. Legacy BlockNote blobs are converted in
  the browser when first opened and remain untouched until the user saves.
- **Optimistic concurrency** via an integer `version` column and `If-Match`.
- **Client-side SVG thumbnails** (`exportToSvg` on a debounce). No
  server-side rendering required.
- **Static SPA served by the Worker via the `[assets]` binding.** One
  deploy unit, one URL.
- **Trash is a soft delete.** `files` and `folders` carry `deleted_at` and
  `trashed_via`. Trashing a folder marks its whole subtree, and every read
  path filters trashed rows, so share links to trashed items return 404.
  Restoring puts an item back in its original folder. If that folder is
  gone, is itself trashed, or the move would exceed the maximum folder
  depth, the item goes to Home instead. A daily cron (`0 4 * * *`, the
  `scheduled` handler in `worker/index.ts`) permanently purges items that
  were trashed more than 30 days ago, cleaning up R2 first.
- **Stars** are a `starred_at` timestamp on files and folders.
- **Bulk item API** for mixed file/folder selections:
  `POST /api/items/{move,trash,restore,purge,star,duplicate}` (at most 500
  refs per request; each request runs as one D1 batch), plus
  `GET`/`DELETE /api/trash`.
- **Uploads use the existing endpoints.** Files are classified in the
  browser. Excalidraw goes through `/api/files/import`; draw.io and Markdown
  are created and then saved; static sites use the assets/zip endpoints.
  There is no dedicated upload endpoint.
- **Front end:** a single command registry (`src/lib/commands/`) drives the
  keyboard shortcuts, context menus, the command palette and the shortcut
  sheet. Item operations are implemented once, in
  `src/features/actions/useItemActions.ts`, with optimistic cache updates
  and undo. App-wide dialogs are mounted once, in `src/features/dialogs/`.
  Device-local explorer preferences live in `src/lib/explorerPrefs.ts`.

The API surface lives under `/api/*` in [`worker/`](./worker); the SPA
lives in [`src/`](./src). Routes and schemas are the source of truth — see
the code rather than this README.

## Quick start

Prerequisites: Node 20+, pnpm, a Cloudflare account, and
[wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

```bash
pnpm install                     # also installs the repo Git hooks
pnpm drawio:assets               # optional but required for draw.io files
wrangler login

# 1. Provision storage
wrangler r2 bucket create inkwell
wrangler d1 create inkwell        # paste the printed database_id into wrangler.toml

# 2. Apply migrations
pnpm db:migrate:local              # local dev
pnpm db:migrate:remote             # production

# 3. Set secrets (production)
wrangler secret put SUPER_ADMIN_EMAIL
wrangler secret put SUPER_ADMIN_PASSWORD
wrangler secret put SESSION_SECRET   # 32+ random bytes; e.g. `openssl rand -hex 32`

# 4. Develop (two terminals)
pnpm dev:worker                    # wrangler dev
pnpm dev                           # vite

# 5. Deploy
pnpm drawio:assets               # ensure ./public/drawio exists before building
pnpm run deploy                  # NB: bare `pnpm deploy` hits pnpm's builtin
```

### Automatic deploys (GitHub Actions)

[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) ships every
push to `main` (or a manual dispatch from the Actions tab), in this order:
install → `pnpm check:ci` → `pnpm test` → `pnpm drawio:assets` →
`pnpm build` → **`wrangler d1 migrations apply inkwell --remote`** →
`wrangler deploy`.

The migration step is idempotent: `wrangler` records applied files in
`d1_migrations`, so a push with no new migration is a no-op. It runs
*before* the Worker so new code never meets an old schema; a failed
migration aborts the deploy and leaves the previous Worker live.

Add both credentials as repository secrets on `zetkey/inkwell`:

```bash
gh secret set CLOUDFLARE_API_TOKEN     # Workers Scripts:Edit, Workers R2 Storage:Edit, D1:Edit, Workers Routes:Edit, Zone:Read
gh secret set CLOUDFLARE_ACCOUNT_ID    # `pnpm exec wrangler whoami` prints the account id
```

Create the token in the Cloudflare dashboard → *My Profile* → *API Tokens* →
the **Edit Cloudflare Workers** template.

Production D1 migrations are applied by that step, so a normal push needs no
manual migration. To apply them by hand (or when deploying with
`pnpm run deploy`), run `pnpm db:migrate:remote` first — it must finish
before the new Worker starts serving.

For local dev, copy `.dev.vars.example` to `.dev.vars` and adjust. The
super-admin row is created lazily on the first login attempt that matches
`SUPER_ADMIN_EMAIL` + `SUPER_ADMIN_PASSWORD`. Further accounts come in via
single-use invite links generated from the **Users** panel.

Draw.io support uses a pinned first-party static asset snapshot under
`public/drawio/`. That directory is intentionally git-ignored because the
upstream webapp is large; regenerate it with `pnpm drawio:assets` before a
build or deploy that needs draw.io editing.

See [`package.json`](./package.json) for the full script list.

### Tests

```bash
pnpm test     # vitest: keymap, fuzzy matcher, selection, upload classifier, naming, trash maths…
pnpm smoke    # Playwright end-to-end smoke against a running `pnpm dev` + `pnpm dev:worker`
```

`pnpm smoke` logs in with `SMOKE_EMAIL` / `SMOKE_PASSWORD` (falling back to
the super-admin credentials in `.dev.vars`). It targets `SMOKE_BASE_URL`,
which defaults to `http://localhost:3838`. It creates its own fixtures and
purges them afterwards; the invite check needs an admin account. On the
first run, install the browser with `pnpm exec playwright install chromium`.

## Upgrading to the redesign (migration 0003)

Migration `drizzle/0003_trash_stars.sql` adds `deleted_at`, `trashed_via`
and `starred_at` to `files` and `folders` and `note` to `invites`, plus
their indexes. It only adds columns, but back up production before applying
it:

```bash
pnpm db:migrate:local                                   # try it locally first
wrangler d1 export inkwell --remote --output backup-$(date +%F).sql
pnpm db:migrate:remote
pnpm run deploy                                         # new Worker needs the new columns
```

Apply the migration **before** deploying the new Worker. The old Worker
ignores the new columns, but the new one requires them. The deploy also
registers the daily purge cron from `wrangler.toml`.

**Behaviour change:** deleting a folder used to delete the folder and move
its children up to the parent. Now the **whole subtree goes to Trash**, and
it can be restored for 30 days. `DELETE /api/files/:id` and
`DELETE /api/folders/:id` also move items to Trash rather than deleting them
permanently.

## Writing a migration

Migrations are **hand-written**. `drizzle/meta/_journal.json` only tracks
`0000_init`; `0001`–`0004` were authored directly in `drizzle/*.sql` and
never had snapshots generated. Reconstructing those snapshots by hand is
not safe, and letting `drizzle-kit generate` run against the drift would
treat every existing table as unknown and emit `DROP`/`CREATE` statements.

So `pnpm db:generate` is a guard: it prints this explanation and exits 1.
To add a migration:

1. Write `drizzle/000N_<slug>.sql` by hand (`CREATE`/`ALTER` only, safe to
   apply before the new Worker is live).
2. Mirror the change in `worker/db/schema.ts` so Drizzle queries typecheck.
3. `pnpm db:migrate:local`, then `pnpm db:migrate:remote` (or let the
   deploy workflow apply it).

`pnpm db:migrate:local` and `pnpm db:migrate:remote` are unaffected.

## Costs

For a personal instance (hundreds of files, infrequent saves), expected
monthly cost is **$0** — Workers, R2, and D1 free tiers cover it
comfortably, and R2 has no egress fees.

## Limitations
- **Collaboration auth is connect-time only.** A share token or session is
  validated when the WebSocket upgrades; revoking it takes effect on the
  next reconnect (per-message revalidation is too expensive on the Free
  plan).

- **File blobs are capped at 4 MiB.** Every save and download parses (and,
  for export, re-stringifies) the whole blob synchronously; on the Workers
  Free plan (10 ms CPU) ~4 MiB is what stays inside that budget. Uploads
  above the cap answer `413 file exceeds 4 MiB`.
- **Static-site assets are capped separately:** 25 MiB per asset, 25 MiB
  per site, and a single-ZIP download of up to 3 MiB (store-only, so the
  CPU cost stays bounded).
- **Real-time collaboration is Excalidraw-only.** Owner editors and share
  links in `Live` mode join a Durable Object room per file (free-plan
  quota); notes, draw.io and static-site editors stay single-writer, where
  a `version` check catches the common concurrent-save case.
- **Collab frames are capped at 4 MiB each.** Scenes over the snapshot
  budget (3 MiB) travel as batched `elements` frames, inline images ride
  only when they fit one frame, and an element too large for a single
  frame is skipped instead of killing the room for everyone.
- **No password recovery flow.** Admins can re-issue an invite; there is
  no email-bound reset.
- **No touch drag-and-drop.** On touch devices, use the Move dialog or the
  bulk bar. Starred items can't be reordered manually.

## License

Inkwell is licensed under the [Apache License 2.0](./LICENSE). Excalidraw
itself is MIT-licensed by the Excalidraw authors — all credit for the
drawing experience belongs to them.
