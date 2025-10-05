
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

3. **Start the local services** (Supabase API, Postgres, PowerSync functions) in one terminal:

   ```bash
   pnpm dev:stack
   ```

   The script listens on ports `55431-55435`, deploys edge functions under `supabase/functions`, and prints connection info. Keep this terminal running.

4. **Launch the explorer UI** in another terminal:

   ```bash
   pnpm dev
   ```

   Vite serves `http://localhost:5173`. The explorer picks up `.env.local`, connects to the local Supabase + PowerSync stack, and streams org/repo data into TanStack DB. Set `VITE_POWERSYNC_DISABLED=true` to work fully offline with cached data.

5. **Stop everything** with <kbd>Ctrl</kbd>+<kbd>C</kbd> in both terminals when you wrap up.

## Day-to-day commands

| Task | Command |
| --- | --- |
| Run workspace unit tests | `pnpm test` |
| Run explorer Playwright smoke tests | `pnpm --filter @app/explorer test:e2e` |
| Type check all packages | `pnpm typecheck` |
| Build the remote helper | `pnpm --filter @pkg/remote-helper build` |
| Build the CLI (`psgit`) | `pnpm --filter @pkg/cli build` |

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
- `VITE_POWERSYNC_DISABLED=true` during e2e runs to keep tests deterministic.
- Default timeouts: 30 s overall, 10 s per action for quick feedback.

## Wrapping up

- The remote helper is stubbed; integrate it with your own backend + storage to fully support fetch/push.
- Update `todo.md` as you work so the next contributor picks up seamlessly.
