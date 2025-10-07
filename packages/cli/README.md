# PowerSync Git CLI (`psgit`)

`psgit` is a lightweight helper that keeps your local Git repository pointed at the PowerSync remote helper **and** can hydrate a local PowerSync SQLite snapshot for offline reads. With both the CLI and the `git-remote-powersync` binary on your `PATH`, standard `git push`/`git fetch` commands flow over PowerSync with no extra flags, and `psgit sync` gives you a fast way to mirror refs/commits/file metadata into SQLite.

## Install

Grab the published package from npm (replace `npm` with `pnpm` or `yarn` if you prefer another package manager):

```bash
npm install -g @pkg/cli
```

If you don’t want a global install, you can run it ad-hoc:

```bash
npx @pkg/cli remote add powersync powersync::https://<endpoint>/orgs/<org_slug>/repos/<repo_slug>
```

> **Heads up**
> The CLI configures Git to use the PowerSync remote helper. Make sure the helper is also installed—e.g. `npm install -g @pkg/remote-helper` so the executable `git-remote-powersync` is on your `PATH`.

## Authenticate once with `psgit login`

Before running commands that talk to PowerSync (for example `psgit sync`), sign in so the CLI can reuse the access token across invocations:

```bash
psgit login
```

By default this calls the Supabase credential signer (`powersync-creds`) using the service-role key that `pnpm dev:stack` exports. The returned RS256 token is cached under `~/.psgit/session.json` and automatically reused by the CLI.

Need to stash a token manually (for CI or when you already have one)?

```bash
psgit login --manual --endpoint https://powersync.example.com --token <JWT>
```

When you want to discard credentials, run `psgit logout` to delete the cache file.

## Add a PowerSync remote in seconds

From the root of any Git repository, run:

```bash
psgit remote add powersync powersync::https://<endpoint>/orgs/<org_slug>/repos/<repo_slug>
```

What this does:

- Checks whether a remote named `origin` already exists (you can override the name; see below).
- Adds the remote if missing, or updates its URL if you've pointed it elsewhere.
- Prints a confirmation so you know which endpoint was configured.

You can verify the remote with standard Git tooling:

```bash
git remote -v
```

### Choose a different remote name

Set the `REMOTE_NAME` environment variable to target a custom remote (for example, leave your existing `origin` alone and populate `powersync` instead):

```bash
REMOTE_NAME=powersync psgit remote add powersync powersync::https://<endpoint>/orgs/<org_slug>/repos/<repo_slug>
```

### CI / ephemeral usage

When you’re scripting inside CI, grab the CLI via `npx`/`pnpm dlx` so you don’t have to manage a global install:

```bash
pnpm dlx @pkg/cli remote add powersync powersync::https://<endpoint>/orgs/<org_slug>/repos/<repo_slug>
```

## Developing the CLI locally

If you’re contributing to the CLI itself, clone the repository and work from source:

```bash
pnpm install
pnpm --filter @pkg/cli run build
```

Helpful scripts:

- `pnpm --filter @pkg/cli run typecheck` – static checks via `tsc`
- `pnpm --filter @pkg/cli test` – Vitest suite (unit + e2e)
- `pnpm --filter @pkg/cli run build` – transpile to `dist/` and ensure the binary stays executable

Whenever you expand the CLI with new commands, remember to document them here and add coverage under `packages/cli/tests/`.

## Hydrate PowerSync metadata locally

Once a repository has a PowerSync remote configured you can mirror its refs, commits, and file metadata into a local SQLite database. This is useful for scripting, debugging the explorer, or warming TanStack DB collections.

```bash
psgit sync --db ./powersync.sqlite
```

### Flags

- `--remote` / `-r` – pick a non-default remote name (defaults to `origin` or `REMOTE_NAME` env var).
- `--db` / `--database` – override the SQLite file path. When omitted the CLI stores data in `~/.config/psgit/powersync.sqlite` (per `getDefaultDatabasePath`).

The command subscribes to the org-scoped PowerSync streams (`refs`, `commits`, `file_changes`, `objects`), waits for the first synchronization to finish, and prints the row counts that were replicated.

> **When do I need Docker Compose?**
>
> Only when you run PowerSync locally. If you are targeting a hosted PowerSync endpoint, `psgit sync` works as-is. For local development, use the Supabase-powered stack (`pnpm dev:stack`) which shells out to the Supabase CLI; the CLI spins up the required Docker containers for PowerSync + Supabase under the hood. See `docs/supabase.md` for the full walkthrough and required environment variables.

### Stack-backed end-to-end test

When you have the local PowerSync + Supabase stack running (for example via `pnpm dev:stack` or your own Docker Compose deployment), you can run an additional Vitest suite that exercises `psgit sync` against the live services. Provide the connection details through environment variables so the test can discover the stack:

| Variable | Purpose |
| --- | --- |
| `PSGIT_TEST_REMOTE_URL` | PowerSync remote URL (e.g. `powersync::https://localhost:8080/orgs/acme/repos/infra`). *Required to enable the test.* |
| `PSGIT_TEST_REMOTE_NAME` | Git remote name to target (defaults to `powersync`). |
| `PSGIT_TEST_FUNCTIONS_URL` | Base URL for Supabase edge functions (often `http://127.0.0.1:54321/functions/v1`). |
| `PSGIT_TEST_SERVICE_ROLE_KEY` | Supabase service-role key used to invoke the functions. |
| `PSGIT_TEST_SUPABASE_URL` | Supabase REST URL (optional; only needed when `invokeSupabaseEdgeFunction` falls back to the client). |
| `PSGIT_TEST_REMOTE_TOKEN` | Direct PowerSync token override (optional when your credential function already returns tokens). |
| `PSGIT_TEST_ENDPOINT` | Explicit PowerSync endpoint override (optional).
| `POWERSYNC_DATABASE_URL` | Connection string to the Supabase Postgres instance for seeding stream definitions (defaults to `postgres://postgres:postgres@127.0.0.1:55432/postgres`). |

With the stack up and variables exported, run the tests:

```bash
pnpm --filter @pkg/cli test
```

If a required variable is missing, the suite fails fast with a descriptive error so you never accidentally run the stub-only path.
