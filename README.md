# Powergit

Powergit is a local-first Git explorer that mirrors repositories into PowerSync so you can browse branches, files, and commit history through a fast, reactive UI—no external network calls required once synced.

## Run Locally

```bash
pnpm install
pnpm dev:stack:up
pnpm dev
```

## Run prod locally

```bash
pnpm install
pnpm dev:prod   
```

> `pnpm dev:prod` uses `.env.prod` (remote Supabase/PowerSync). Use `pnpm dev:stack` if you want a local Docker-backed stack.

## Demos

### Create a repo from the CLI

https://github.com/user-attachments/assets/e05f20bb-78f5-4a7b-acc9-f662a9ac8a66


Create a repo and push to it using the `powergit::` remote from your terminal.

### Observe the created repo in Explorer

https://github.com/user-attachments/assets/67746738-34cc-4275-b0ae-39985af9b907

Browse branches, files, and history once the repo has been mirrored into PowerSync.

### Explore a Github repository

https://github.com/user-attachments/assets/5052ef0e-14f6-4428-b621-286e7e28bbd1


Clone a repository via `git clone powergit::/org/repo` and let the helper stream packs locally.

### Create an org


https://github.com/user-attachments/assets/a11c560a-fd57-4a54-b6c6-3b51c5e1206b


Create organizations (and later manage members/repos) directly from the Explorer UI.

## How it works
In this repo we have built a custom git remote protocol that allows us to push git data into a Supabase database. We can later use PowerSync to see the data in the frontend. We use the powersync-tanstack-db package to query the database and show it reactively using the `@tanstack/powersync-db-collection` package.

## Why PowerSync instead of TanStack DB alone
TanStack DB gives us a great query layer, but it does not include a sync engine or durable storage. PowerSync is the replicated store that keeps the Git metadata and pack metadata in step across the daemon and the explorer.

- Offline-first persistence: PowerSync streams `refs`, `commits`, `file_changes`, and `objects` into SQLite (daemon) and IndexedDB (browser), so TanStack DB queries stay fast and continue to work without network access.
- Delta sync, not re-downloads: after the initial push of a large repo, only new refs/commits are streamed; the UI never has to resync the full history on each launch.
- Shared cache across surfaces: the daemon, CLI, and browser all query the same replicated tables via `@tanstack/powersync-db-collection`, avoiding bespoke cache plumbing while honoring the Supabase/PowerSync auth model.
- Pack handling: pack bytes stay in Supabase Storage while PowerSync ships the lightweight metadata we query. The explorer pulls packs lazily and indexes them locally, keeping PowerSync focused on the syncable metadata layer.

## Architecture Overview
At a high level the happy path looks like this:

1. **Import request (UI → daemon).** A user pastes a GitHub URL into the explorer. The frontend posts that payload to the local daemon. The daemon clones the repo, configures the custom `powergit::` remote, fetches every ref, and pushes the data into Supabase via our remote-helper.
2. **Persist metadata + packs.** During `git push --mirror`, the daemon writes refs/commits/file_changes rows into Supabase tables and uploads each pack file to the Supabase Storage bucket (`git-packs`). Only metadata lands in `public.objects`; the raw pack bytes live in storage.
3. **PowerSync replication.** The PowerSync service streams those tables down to every connected explorer instance. The browser uses `@powersync/web` + TanStack DB collections to reactively query refs, commits, file changes, and the lightweight pack metadata.
4. **File tree & viewer.** When the explorer receives the first pack row for a repo, `gitStore.indexPacks` downloads the pack via the daemon’s signed URL endpoint, indexes it inside the browser’s virtual FS, and marks the referenced commit as “ready.” The file tree then renders real Git entries while the viewer can read blobs directly from the locally indexed pack.
5. **Commit explorer.** The commit view queries the replicated commits/refs table via `@tanstack/powersync-db-collection` and renders filters, diffs, and history without any additional backend calls.

This flow means that after the initial clone/push, all navigation (branch switching, file viewing, commit diffing) happens entirely locally with the data mirrored inside PowerSync.
