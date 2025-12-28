# Supabase + PowerSync

Powergit stores Git metadata in Supabase Postgres and Git pack bytes in Supabase Storage. PowerSync replicates the metadata to local replicas (SQLite in the daemon, IndexedDB in the browser) so the Explorer stays fast and works offline after the first sync.

## What we store

- **Tables (Supabase Postgres):** `refs`, `commits`, `file_changes`, `objects`, `repositories`, `import_jobs`
- **Storage:** pack bytes live in Supabase Storage (default bucket `git-packs`); `objects.storage_key` points to the blob

## Two import modes

### 1) Local daemon (development/offline)

This is the default “happy path” in local development: cloning happens on your machine and the daemon pushes into Supabase.

1. Start the local stack (Supabase + PowerSync):

   ```bash
   pnpm dev:stack
   ```

2. Start the explorer against the local stack:

   ```bash
   pnpm dev
   ```

3. Stop the stack when you’re done:

   ```bash
   pnpm dev:stack stop
   ```

### 2) Supabase Edge Function → GitHub Actions (hosted/prod)

In prod-like deployments, cloning does not run on the user’s machine. The Explorer dispatches an import job, and a GitHub Actions runner performs the clone + push.

Flow overview:

- Explorer calls the Supabase Edge Function at `supabase/functions/github-import`.
- The Edge Function dispatches `.github/workflows/clone-and-push.yml`.
- The workflow runs the Powergit daemon on the runner, clones the target repo, and pushes to `powergit::/<org>/<repo>`.
- The Explorer watches `import_jobs` (replicated by PowerSync) for status and can link to the Actions run.

Local smoke test for this path:

1. Create `supabase/.env` (not committed) with GitHub workflow dispatch settings (copy from `.env.github.example`).
2. Run `pnpm dev:stack` (the script auto-starts `supabase functions serve` when `supabase/.env` exists).
3. Run the Explorer in prod-mode locally:

   ```bash
   pnpm dev:prod
   ```

## Device login (daemon auth)

Run `powergit login` once per profile (or from this repo: `pnpm --filter @powersync-community/powergit login`).

It prints a device code and an `Open:` URL. The URL is derived from:

- `daemon.deviceLoginUrl` in your profile, or
- `POWERGIT_DAEMON_DEVICE_URL` (fallback `POWERSYNC_DAEMON_DEVICE_URL`, default `http://localhost:5783/auth`)

Credentials are stored under `~/.powergit/daemon/<profile>/`.

## Live CLI tests (optional)

`pnpm --filter @powersync-community/powergit test` runs unit tests plus an optional live-stack suite.

To enable the live suite against a real Supabase/PowerSync stack, export:

- `POWERGIT_TEST_REMOTE_URL` (required)
- `POWERGIT_TEST_SUPABASE_URL`
- `POWERGIT_TEST_SUPABASE_EMAIL`
- `POWERGIT_TEST_SUPABASE_PASSWORD`

For local stack runs, you can also set `POWERSYNC_DATABASE_URL` to seed PowerSync stream definitions.

## Production checklist

These are the “must match” pieces between Supabase, PowerSync, and the Explorer build:

1. **Database schema/migrations:** `pnpm prod:migrate` (applies `supabase/migrations/*`, including the PowerSync publication updates for `repositories` / `import_jobs`).
2. **PowerSync sync rules:** deploy `supabase/powersync/sync-rules.yaml` to your PowerSync instance (dashboard).
3. **Edge function:** `pnpm prod:supabase:functions:deploy:github-import` (if you use the GitHub Actions import path).
4. **Explorer build-time env:** set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_POWERSYNC_ENDPOINT` in your hosting environment.
5. **GitHub secrets (if using our workflows):** see `.github/workflows/clone-and-push.yml` for the full list (notably `SUPABASE_*` and `POWERGIT_EMAIL`/`POWERGIT_PASSWORD`).

## Troubleshooting

- **Explorer shows “Offline” / no repos:** confirm `VITE_POWERSYNC_ENDPOINT` points at the correct PowerSync URL and the user has a valid token.
- **Tables exist in Supabase but don’t appear in the UI:** ensure the PowerSync publication includes the tables (see `supabase/migrations/*`) and your deployed PowerSync sync rules include `repositories` + `import_jobs`.
- **Local stack port conflicts:** `pnpm dev:stack` respects `SUPABASE_API_PORT` / `SUPABASE_PORT` and `POWERSYNC_PORT` (see `scripts/dev-local-stack.mjs`).
