
# PowerSync Git (pnpm v10) — Org‑Scoped Remote + Repo Explorer + **TanStack DB**

This monorepo prototypes:
- **git-remote-powersync** (TS remote helper for `powersync::https://…/orgs/<org_slug>/repos/<repo_slug>`)
- **Repo Explorer (React + Vite + Tailwind)** wired to **@powersync/web + @powersync/react**
- **TanStack DB integration** via the adapter from PR **powersync-ja/temp-tanstack-db#1** (`@tanstack/powersync-db-collection`)

Open **Agents.md** for the architecture.

## Prereqs

- Node 20+ and **pnpm 10**
- Supabase CLI (for the local stack)
- Docker (Desktop, colima, or similar)
- Optional but useful: a PowerSync instance + token (the local stack can run without it for UI work)

## Quick start: local stack + explorer

> The goal: bring up Supabase + PowerSync locally and browse data in the explorer with the fewest possible commands.

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Bootstrap environment variables (first run only)**

   ```bash
   cp docs/env.local.example .env.local
   ```

   Edit `.env.local` if you have real Supabase/PowerSync credentials. The defaults match the local stack started below.

3. **Apply the database schema** (first time after pulling changes)

   ```bash
   supabase db push
   ```

   This applies the SQL migration under `supabase/migrations/20241007090000_powersync_git_tables.sql`, provisioning the `refs`, `commits`, `file_changes`, and `git_packs` tables required by both the CLI and explorer.

4. **Start the local services** (Supabase API, Postgres, PowerSync functions) in one terminal:

   ```bash
   pnpm dev:stack
   ```

   The script listens on ports `55431-55435`, deploys edge functions under `supabase/functions`, and prints connection info. Keep this terminal running.

   > Need deeper deployment guidance (e.g., Supabase Cloud, `verify_jwt`, RS256 secrets)? See [docs/supabase.md](docs/supabase.md#deploying-edge-functions) for the production playbook.

   > Tip: whenever you change `supabase/powersync/config.yaml` run `pnpm seed:streams` to mirror the updated sync rules into the Supabase database. The script keeps Supabase and the PowerSync container config in sync so the CLI and explorer see the same stream definitions.

   Command palette:

   - `pnpm dev:stack stop` stops Supabase, Docker Compose, and edge functions once you're done.
   - Append `-- --log` (or run `pnpm dev:stack:up`) to tee all output into `logs/dev-stack/<timestamp>.log` while still mirroring to the terminal.
   - `pnpm dev:stack:down` is a shorthand for `pnpm dev:stack stop -- --log` if you prefer the legacy alias.
   - Need a dry run? `pnpm dev:stack -- --dry-run` prints each step without executing it.

5. **Authenticate the CLI** so `psgit` can reuse credentials:

   ```bash
   pnpm --filter @pkg/cli login
   ```

   The command contacts the `powersync-creds` edge function (using the service-role key exported by `pnpm dev:stack`) and caches the RS256 token under `~/.psgit/session.json`. Future CLI commands reuse the cached token automatically. To inspect the stored credentials or clear them, run `psgit login --manual ...` or `psgit logout`.

6. **Launch the explorer UI** in another terminal:

   ```bash
   pnpm dev
   ```

   Vite serves `http://localhost:5173`. The explorer picks up `.env.local`, connects to the local Supabase + PowerSync stack, and streams org/repo data into TanStack DB. Set `VITE_POWERSYNC_DISABLED=true` to work fully offline with cached data.

7. **Stop everything** with <kbd>Ctrl</kbd>+<kbd>C</kbd> in both terminals when you wrap up.

## Day-to-day commands

| Task | Command |
| --- | --- |
| Run workspace unit tests | `pnpm test` |
| Run explorer Playwright smoke tests | `pnpm --filter @app/explorer test:e2e` |
| Type check all packages | `pnpm typecheck` |
| Build the remote helper | `pnpm --filter @pkg/remote-helper build` |
| Build the CLI (`psgit`) | `pnpm --filter @pkg/cli build` |
| Cache PowerSync CLI credentials | `pnpm --filter @pkg/cli login` |
| Start local Supabase + PowerSync stack | `pnpm dev:stack` |
| Stop local stack | `pnpm dev:stack stop` |

> Top-level helpers mirror these: `pnpm dev` proxies to the explorer dev server and `pnpm dev:stack` starts the Supabase + PowerSync bootstrapper.

## Development notes

### PowerSync adapter pin

We pin `@tanstack/powersync-db-collection` to the PR branch via `pnpm.overrides`. Replace it with a commit SHA if you prefer:

```json
{
  "pnpm": {
    "overrides": {
      "@tanstack/powersync-db-collection": "github:powersync-ja/temp-tanstack-db#c887d90"
    }
  }
}
```

### Explorer environment template

Copy `docs/env.local.example` and tweak as needed. Key entries:

```
VITE_POWERSYNC_ENDPOINT=https://YOUR-POWERSYNC-ENDPOINT
VITE_POWERSYNC_TOKEN=YOUR_DEV_TOKEN
VITE_POWERSYNC_DEFAULT_REPOS=infra
VITE_SUPABASE_URL=https://YOUR-SUPABASE-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
VITE_SUPABASE_SCHEMA=public
VITE_SUPABASE_POWERSYNC_CREDS_FN=powersync-creds
VITE_SUPABASE_POWERSYNC_UPLOAD_FN=powersync-upload
VITE_POWERSYNC_DISABLED=false
```

### PowerSync raw tables

- PowerSync stores sync data locally in SQLite tables (`refs`, `commits`, `file_changes`, `objects`) that mirror the org-scoped streams.
- Inspect them through `PowerSyncDatabase` (for example, `await db.query('SELECT * FROM refs')`) or via Chromium DevTools → Application → Storage → IndexedDB → `wa-sqlite`.

### Supabase + PowerSync backend

- Follow the official [Supabase + PowerSync guide](https://docs.powersync.com/integration-guides/supabase-+-powersync) when pointing at real infrastructure.
- Deploy edge functions referenced by `VITE_SUPABASE_POWERSYNC_CREDS_FN` and `VITE_SUPABASE_POWERSYNC_UPLOAD_FN`; the explorer uses them for credential exchange and uploading pending batches.

## CLI helper workflow (`psgit`)

1. Build once per change: `pnpm --filter @pkg/cli build` (outputs `packages/cli/dist`).
2. From any git repo, wire the PowerSync remote helper:
   ```bash
   psgit remote add powersync powersync::https://YOUR-ENDPOINT/orgs/acme/repos/infra
   git fetch powersync
   git push -u powersync main
   git clone powersync::https://YOUR-ENDPOINT/orgs/acme/repos/infra
   ```
3. Export credentials so the remote helper can reach the PowerSync control plane:
   - `POWERSYNC_TOKEN` (or `POWERSYNC_REMOTE_TOKEN`)
   - `POWERSYNC_SUPABASE_REMOTE_FN` when brokering tokens via Supabase (defaults to `powersync-remote-token`)
4. The local stack now includes Supabase **and** a PowerSync container. After running `pnpm dev:stack`, you can connect to the PowerSync API at `http://127.0.0.1:55440` (override with `POWERSYNC_PORT`). Adjust `POWERSYNC_DATABASE_URL` or other env vars in `supabase/docker-compose.powersync.yml` if you need different credentials. Bring the stream definitions online with `pnpm seed:streams`; from there you can interact with refs/commits using the CLI or explorer as needed.

5. To debug metadata locally, mirror the org-scoped streams into SQLite:
   ```bash
   psgit sync --db ./powersync.sqlite
   ```
   - Add `--remote <name>` (or `REMOTE_NAME`) to target a non-default remote.
   - Requires a reachable PowerSync endpoint. For local dev, run `pnpm dev:stack` to let the Supabase CLI launch Supabase plus the bundled PowerSync Docker container (no extra commands required).

## Testing cheat sheet

### Unit & type tests

```bash
# Run everything in the workspace
pnpm test

# Package-specific unit tests
pnpm --filter @pkg/remote-helper test
pnpm --filter @pkg/shared test

# Static type analysis
pnpm typecheck
```

### End-to-end tests

```bash
# Explorer smoke tests
pnpm --filter @app/explorer test:e2e

# Target a specific browser
pnpm --filter @app/explorer test:e2e --project=chromium
```

### Test configuration notes

- Playwright serves the explorer on port `5191` to avoid clashing with the dev server.
- During Playwright runs we now default `VITE_POWERSYNC_DISABLED=false` so tests exercise the live PowerSync stack by default. Set `VITE_POWERSYNC_DISABLED=true` (and optionally `VITE_POWERSYNC_USE_FIXTURES=true`) if you need the old fixture-only behavior.
- Default timeouts: 30 s overall, 10 s per action for quick feedback.

## Wrapping up

- The remote helper is stubbed; integrate it with your own backend + storage to fully support fetch/push.
- Update `todo.md` as you work so the next contributor picks up seamlessly.
