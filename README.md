
# PowerSync Git (pnpm v10) — Org‑Scoped Remote + Repo Explorer + **TanStack DB**

This monorepo prototypes:
- **git-remote-powersync** (TS remote helper for `powersync::https://…/orgs/<org_slug>/repos/<repo_slug>`)
- **Repo Explorer (React + Vite + Tailwind)** wired to **@powersync/web + @powersync/react**
- **TanStack DB integration** via the adapter from PR **powersync-ja/temp-tanstack-db#1** (`@tanstack/powersync-db-collection`)

Open **Agents.md** for the architecture.

## Prereqs
- Node 20+ and **pnpm 10**
- A PowerSync instance & token (dev token fine).

## Install
```bash
pnpm i
```

> We pin `@tanstack/powersync-db-collection` to the PR branch using `pnpm.overrides`. If you prefer, replace it with a commit SHA:
> ```json
> { "pnpm": { "overrides": { "@tanstack/powersync-db-collection": "github:powersync-ja/temp-tanstack-db#c887d90" } } }
> ```

## CLI: PowerSync remote
```bash
pnpm --filter @pkg/remote-helper build
pnpm --filter @pkg/cli build

cd /path/to/your/repo
psgit remote add powersync powersync::https://YOUR-ENDPOINT/orgs/acme/repos/infra
git fetch powersync
git push -u powersync main
git clone powersync::https://YOUR-ENDPOINT/orgs/acme/repos/infra
```

- Export `POWERSYNC_TOKEN` (or `POWERSYNC_REMOTE_TOKEN`) so the remote helper can authenticate with the PowerSync control plane.
- When using Supabase functions for authentication, set:
  - `POWERSYNC_SUPABASE_URL`
  - `POWERSYNC_SUPABASE_SERVICE_ROLE_KEY`
  - `POWERSYNC_SUPABASE_REMOTE_FN` (defaults to `powersync-remote-token`)

## Frontend: Repo Explorer
```bash
cp apps/explorer/.env.example .env   # edit endpoint + token
pnpm dev
```
- Org activity page at `/org/acme`
- Repo overview at `/org/acme/repo/infra`

### Env
```
VITE_POWERSYNC_ENDPOINT=https://YOUR-POWERSYNC-ENDPOINT
VITE_POWERSYNC_TOKEN=YOUR_DEV_TOKEN
VITE_POWERSYNC_DEFAULT_REPOS=infra # optional fallback list for org subscriptions
VITE_SUPABASE_URL=https://YOUR-SUPABASE-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
VITE_SUPABASE_SCHEMA=public
VITE_SUPABASE_POWERSYNC_CREDS_FN=powersync-creds
VITE_SUPABASE_POWERSYNC_UPLOAD_FN=powersync-upload
VITE_POWERSYNC_DISABLED=false # set true for local testing without a backend
```

### Supabase + PowerSync

- Follow the official [Supabase + PowerSync guide](https://docs.powersync.com/integration-guides/supabase-+-powersync) to provision your Supabase project and PowerSync instance.
- Deploy edge functions named in `VITE_SUPABASE_POWERSYNC_CREDS_FN` and `VITE_SUPABASE_POWERSYNC_UPLOAD_FN` that proxy to your PowerSync control/data plane. The explorer connector will automatically call these functions to fetch credentials and upload outbound CRUD batches.
- Ensure the Supabase functions return `{ endpoint, token }` for credentials and accept `{ operations }` payloads for CRUD uploads. Adjust function names in `.env` if you deviate from the defaults.

## Notes
- The adapter gives **live, reactive** queries (TanStack DB) backed by **PowerSync** local SQLite (offline‑first).
- We subscribe to **sync streams** (not sync rules) per org/repo in the UI.
- Remote helper is still stubbed; connect it to your backend + storage to fully enable fetch/push.
