# Powergit

Powergit is a local-first Git explorer that mirrors repositories into Supabase (Postgres + Storage) and streams metadata to the UI via PowerSync, so you can browse branches, files, and commit history from a fast local replica.

The explorer is live [here](https://powersync-community.github.io/powergit/).

## Quick start (local dev)

```bash
pnpm install
pnpm dev:stack
```

In another terminal:

```bash
pnpm dev
```

## Quick start (prod-like)

```bash
pnpm install
pnpm dev:prod
```

> `pnpm dev:prod` uses `.env.prod` (remote Supabase/PowerSync). Use `pnpm dev` + `pnpm dev:stack` for a local Docker-backed stack.

## Demos


### 1) Create a repo from the CLI

https://github.com/user-attachments/assets/e05f20bb-78f5-4a7b-acc9-f662a9ac8a66

Create a repo and push to it using the `powergit::` remote from your terminal.

### 2) Observe the created repo in Explorer

https://github.com/user-attachments/assets/67746738-34cc-4275-b0ae-39985af9b907

Browse branches, files, and history once the repo has been mirrored into PowerSync.

### 3) Clone a GitHub repo (mirror into PowerSync)

https://github.com/user-attachments/assets/5052ef0e-14f6-4428-b621-286e7e28bbd1

Clone a repository via `git clone powergit::/org/repo` and let the helper stream packs locally.

### 4) Create an org

https://github.com/user-attachments/assets/a11c560a-fd57-4a54-b6c6-3b51c5e1206b

Create organizations (and later manage members/repos) directly from the Explorer UI.

## How it works
Powergit has two parts:

- A Git remote helper (`git-remote-powergit`) that streams Git packs + metadata into Supabase when you push to a `powergit::...` remote.
- An Explorer UI that subscribes to PowerSync streams and queries the local replica with TanStack DB (fast + offline after the first sync).

### Import / clone flows

#### Local daemon (dev/offline)

1. Explorer calls your local daemon (`VITE_POWERSYNC_USE_DAEMON=true`) with a GitHub URL.
2. The daemon clones from GitHub, then pushes to `powergit::/<org>/<repo>` (the helper uploads packs to Storage and writes metadata to Postgres).
3. PowerSync replicates the tables to the browser; the UI becomes fully local for browsing.

#### Supabase Edge Function → GitHub Actions (hosted/prod)

1. Explorer calls the Supabase Edge Function (`VITE_POWERSYNC_ACTIONS_IMPORT=true`).
2. The function dispatches `.github/workflows/clone-and-push.yml`.
3. GitHub Actions runs the Powergit daemon on the runner, clones the target repo, and pushes to `powergit::/<org>/<repo>`.
4. Explorer follows progress via `import_jobs` (replicated by PowerSync) and can link to the Actions run.

## Why PowerSync instead of TanStack DB alone
TanStack DB is the query layer. PowerSync is the sync engine + durable local replica (SQLite/IndexedDB) that makes the Explorer fast and usable offline.

- PowerSync handles incremental replication of Git metadata (`refs`, `commits`, `file_changes`, `objects`).
- The Explorer queries the same replica across sessions (no refetching full history on each load).
- Pack bytes live in Supabase Storage and are downloaded/indexed lazily for file viewing.

## Docs

- `docs/supabase.md` – local stack, Edge Function + Actions import, production checklist.
- `docs/profiles/remote.example.md` – profile setup and remote URL conventions.
- `packages/cli/README.md` – CLI usage (`powergit login`, `powergit remote add`, etc.).
