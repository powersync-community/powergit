# Powergit CLI (`powergit`)

`powergit` ships `git-remote-powergit` (a Git remote helper) plus a small CLI for login/profile management. Once a `powergit::...` remote is configured, you use normal Git commands (`git push`, `git fetch`) and the helper streams data into Powergit’s Supabase/PowerSync stack.

## Quick start (hosted PowerSync)

1. Install the CLI (global install recommended):

   ```bash
   npm install -g @powersync-community/powergit
   ```

   This provides:

   - `powergit`
   - `powergit-daemon`
   - `git-remote-powergit` (Git remote helper)

2. From your Git repo, add a PowerSync remote (Git-first flow):

   ```bash
   git remote add powersync powergit::/<org_slug>/<repo_slug>
   ```

   > Prefer the convenience wrapper? `powergit remote add` is equivalent and will update an existing remote if needed.

3. Authenticate once so the daemon can talk to PowerSync (required for pushes/fetches):

   ```bash
   powergit login
   ```

4. Use normal Git commands:

   ```bash
   git push powersync main
   git fetch powersync
   ```

> For `git push`/`git fetch` to work with `powergit::...` remotes, Git must find `git-remote-powergit` on your `PATH` (global install, or local install with `node_modules/.bin` on your `PATH`).

## Point a repo at PowerSync

From the root of any Git repository, add the remote with Git:

```bash
git remote add powersync powergit::/<org_slug>/<repo_slug>
```

Prefer the convenience wrapper? This does the same thing and updates the remote if it already exists:

```bash
powergit remote add powersync powergit::/<org_slug>/<repo_slug>
```

You can verify the remote with standard Git tooling:

```bash
git remote -v
```

> **Why `powergit::`?**
> Git uses the prefix before `::` to pick a remote helper binary named `git-remote-<prefix>`. We ship `git-remote-powergit`, so the URL must start with `powergit::`.

### Shorthand remote URLs (profiles)

`powergit::/<org>/<repo>` uses the default profile (production out of the box). To target another stack, create a profile that bundles **both** the PowerSync and Supabase endpoints, then reference that profile in the remote URL:

```bash
powergit profile set staging \
  --set powersync.url=https://powersync.staging.example.com \
  --set supabase.url=https://staging.supabase.co \
  --set supabase.anonKey=<anon-key>

# Optional (only needed for server-side workflows/tests that require elevated Supabase access):
powergit profile set staging --set supabase.serviceRoleKey=<service-role-key>

git remote add powersync powergit::staging/<org>/<repo>
```

Supabase config (URL/anon key) and your login session are **not** part of the remote URL. Keep them in the profile/env (and never put a `supabase.serviceRoleKey` in a Git remote).

### Choose a different remote name

With plain Git, just pick any remote name you like (`powersync` is the default convention). If you use `powergit remote add`, set the `REMOTE_NAME` environment variable or pass `--remote` to target a custom name:

```bash
REMOTE_NAME=staging powergit remote add powersync powergit::/<org_slug>/<repo_slug>
```

## Authenticate once with `powergit login`

Before running commands that talk to PowerSync (push/fetch or `powergit sync`), sign in so the daemon can reuse the access token across invocations:

```bash
powergit login
```

`powergit login` starts a device-code flow. The daemon prints a device code and an `Open:` URL — open it, sign in with Supabase, and keep the tab open until the CLI reports success. The Supabase session is cached per profile under `~/.powergit/daemon/<profile>/session.json` and reused by the daemon.

By default the daemon serves the device-login page locally at `http://127.0.0.1:5030/ui/auth`.

If you don’t see an `Open:` URL, set `daemon.deviceLoginUrl` in your profile or export `POWERGIT_DAEMON_DEVICE_URL` (fallback `POWERSYNC_DAEMON_DEVICE_URL`) — useful when the daemon runs somewhere other than localhost.

If the browser can’t POST back to your local daemon (e.g. `net::ERR_BLOCKED_BY_CLIENT`), try an incognito window or disable ad blockers/privacy shields for the device login page.

To discard credentials, run `powergit logout`.

## Inspect PowerSync metadata quickly

Once a repository has a PowerSync remote configured you can ask the daemon for the current counts of refs, commits, file changes, and objects that it is tracking for that repo:

```bash
powergit sync
```

### Flags

- `--remote` / `-r` – pick a non-default remote name (defaults to `powersync` or `REMOTE_NAME` env var).

The command ensures the daemon is running (starting it if auto-start is enabled), reuses the cached credentials from `powergit login`, and makes a lightweight RPC call to the daemon. The daemon responds with counts derived from its PowerSync tables (`refs`, `commits`, `file_changes`, `objects`), so the CLI no longer creates or maintains its own SQLite database file.

## CI / ephemeral usage

When you’re scripting inside CI, install the package so `git-remote-powergit` is on `PATH` (global install or add `node_modules/.bin` to `PATH`). You can still use `npx`/`pnpm dlx` for one-off `powergit` commands, but Git needs the helper binary available when it runs.

```bash
pnpm dlx @powersync-community/powergit remote add powersync powergit::/<org_slug>/<repo_slug>
```

## Local stack (optional)

For local development, Supabase + PowerSync stack setup, and live CLI tests, see `docs/supabase.md`.

## Developing the CLI locally

If you’re contributing to the CLI itself, clone the repository and work from source:

```bash
pnpm install
pnpm --filter @powersync-community/powergit run build
```

Helpful scripts:

- `pnpm --filter @powersync-community/powergit run typecheck` – static checks via `tsc`
- `pnpm --filter @powersync-community/powergit test` – Vitest suite (unit + e2e)
- `pnpm --filter @powersync-community/powergit run build` – transpile to `dist/` and ensure the binary stays executable

Whenever you expand the CLI with new commands, remember to document them here and add coverage under `packages/cli/src/__tests__/`.
