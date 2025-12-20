# Supabase + PowerSync

Powergit stores Git metadata in Supabase Postgres and streams it to clients via PowerSync. The explorer reads from the local PowerSync replica (browser SQLite) so the UI stays fast and keeps working offline after the first sync.

## What we store

- **Tables (Supabase Postgres):** `refs`, `commits`, `file_changes`, `objects`, `repositories`, `import_jobs`
- **Storage:** pack bytes live in Supabase Storage (default bucket `git-packs`); `objects.storage_key` points to the blob

## Local development (recommended)

1. Start the local stack:

   ```bash
   pnpm dev:stack
   ```

   This runs `supabase start`, starts the local PowerSync service, ensures the schema from `supabase/schema.sql` is applied, seeds PowerSync sync rules from `supabase/powersync/sync-rules.yaml`, and syncs a `local-dev` profile into `~/.powergit/profiles.json`.

2. Start the explorer against the local stack:

   ```bash
   pnpm dev
   ```

3. Stop everything when you’re done:

   ```bash
   pnpm dev:stack stop
   ```

### Device login (sharing a Supabase token)

When you need the daemon + browser to share a Supabase-issued token (useful for tests and some auth flows):

```bash
pnpm --filter @powersync-community/powergit login
```

The CLI prints a device code and a verification URL (`POWERSYNC_DAEMON_DEVICE_URL`, default `http://localhost:5783/auth`). Open it, sign in, and the token is stored under `~/.powergit/daemon/<profile>/`.

### CLI live tests (optional)

When you have the local PowerSync + Supabase stack running (for example via `pnpm dev:stack` or your own Docker Compose deployment), you can run an additional Vitest suite that exercises `powergit sync` against the live services. Provide the connection details through environment variables so the test can discover the stack:

| Variable | Purpose |
| --- | --- |
| `POWERGIT_TEST_REMOTE_URL` | Powergit remote URL (e.g. `powergit::/acme/infra`, `powergit::staging/acme/infra`, or `powergit::local-dev/acme/infra`). *Required to enable the test.* |
| `POWERGIT_TEST_REMOTE_NAME` | Git remote name to target (defaults to `powersync`). |
| `POWERGIT_TEST_SUPABASE_URL` | Supabase REST URL (used for password login). |
| `POWERGIT_TEST_SUPABASE_EMAIL` | Supabase user email used for HS256 login. |
| `POWERGIT_TEST_SUPABASE_PASSWORD` | Supabase user password used for HS256 login. |
| `POWERGIT_TEST_ENDPOINT` | Explicit PowerSync endpoint override (optional). |
| `POWERSYNC_DATABASE_URL` | Connection string to the Supabase Postgres instance for seeding stream definitions (defaults to `postgres://postgres:postgres@127.0.0.1:55432/postgres`). |

With the stack up and variables exported, run the tests:

```bash
pnpm --filter @powersync-community/powergit test
```

If a required variable is missing, the suite fails fast with a descriptive error so you never accidentally run the stub-only path.

## Daemonless import (GitHub Actions + Edge Function)

For prod-like imports where the browser dispatches a GitHub Action (instead of using the local daemon), we use a Supabase Edge Function (`supabase/functions/github-import`) that triggers `.github/workflows/clone-and-push.yml`.

Local setup:

1. Create `supabase/.env` (not committed) with the GitHub workflow dispatch settings (copy from `.env.github.example`).
2. Start the stack (`pnpm dev:stack`). The script auto-starts `supabase functions serve` if `supabase/.env` exists.
3. Run the explorer in prod-mode locally:

   ```bash
   pnpm dev:prod
   ```

## Production checklist

These are the “must match” pieces between Supabase, PowerSync, and the explorer build:

1. **Database schema/migrations:** `pnpm prod:migrate` (applies `supabase/migrations/*`, including the PowerSync publication updates for `repositories` / `import_jobs`).
2. **PowerSync sync rules:** deploy `supabase/powersync/sync-rules.yaml` to your PowerSync instance (dashboard).
3. **Edge function:** `pnpm prod:supabase:functions:deploy:github-import` (if you use the GitHub Actions import path).
4. **Explorer build-time env:** set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_POWERSYNC_ENDPOINT` in your hosting environment.
5. **GitHub secrets (if using our workflows):**
   - Pages build (`.github/workflows/pages.yml`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `POWERSYNC_URL`
   - Import workflow (`.github/workflows/clone-and-push.yml`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `POWERGIT_EMAIL`, `POWERGIT_PASSWORD` (and optionally `POWERSYNC_EDGE_BASE_URL`)

## Troubleshooting

- **Explorer shows “Offline” / no repos:** confirm `VITE_POWERSYNC_ENDPOINT` points at the correct PowerSync URL and the user has a valid token.
- **Tables exist in Supabase but don’t appear in the UI:** ensure the PowerSync publication includes the tables (see `supabase/migrations/*`) and your deployed PowerSync sync rules include `repositories` + `import_jobs`.
- **Local stack port conflicts:** `pnpm dev:stack` respects `SUPABASE_API_PORT` / `SUPABASE_PORT` and `POWERSYNC_PORT` (see `scripts/dev-local-stack.mjs`).

## Environment variable reference

Most users should rely on profiles + `.env.local` / `.env.prod`. These are the main knobs:

- **Browser:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_POWERSYNC_ENDPOINT`, `VITE_POWERSYNC_USE_DAEMON`
- **Daemon/CI:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `POWERSYNC_URL`
- **GitHub Actions import path:** `VITE_POWERSYNC_EDGE_BASE_URL` (optional override), plus Edge Function secrets in `supabase/.env`
