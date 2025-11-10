# Powergit

Powergit is a local-first Git explorer that mirrors repositories into PowerSync so you can browse branches, files, and commit history through a fast, reactive UI—no external network calls required once synced.

## Run Locally

```bash
pnpm install
pnpm dev:stack:up
pnpm dev
```

> Requires Docker to be running for the PowerSync + Supabase stack.

## Screenshots

![Powergit screenshot 1](s1.png)
View files and branches.

![Powergit screenshot 2](s2.png)
Uses Tanstack DB integration to handle queries for the commit explorer.
![Powergit screenshot 3](s3.png)
You can view diffs.

## How it works
In this repo we have built a custom git remote protocol that allows us to push git data into a Supabase database. We can later use PowerSync to see the data in the frontend. We use the powersync-tanstack-db package to query the database and show it reactively using the `@tanstack/powersync-db-collection` package.

## Architecture Overview
At a high level the happy path looks like this:

1. **Import request (UI → daemon).** A user pastes a GitHub URL into the explorer. The frontend posts that payload to the local daemon. The daemon clones the repo, configures the custom `powersync::` remote, fetches every ref, and pushes the data into Supabase via our remote-helper.
2. **Persist metadata + packs.** During `git push --mirror`, the daemon writes refs/commits/file_changes rows into Supabase tables and uploads each pack file to the Supabase Storage bucket (`git-packs`). Only metadata lands in `public.objects`; the raw pack bytes live in storage.
3. **PowerSync replication.** The PowerSync service streams those tables down to every connected explorer instance. The browser uses `@powersync/web` + TanStack DB collections to reactively query refs, commits, file changes, and the lightweight pack metadata.
4. **File tree & viewer.** When the explorer receives the first pack row for a repo, `gitStore.indexPacks` downloads the pack via the daemon’s signed URL endpoint, indexes it inside the browser’s virtual FS, and marks the referenced commit as “ready.” The file tree then renders real Git entries while the viewer can read blobs directly from the locally indexed pack.
5. **Commit explorer.** The commit view queries the replicated commits/refs table via `@tanstack/powersync-db-collection` and renders filters, diffs, and history without any additional backend calls.

This flow means that after the initial clone/push, all navigation (branch switching, file viewing, commit diffing) happens entirely locally with the data mirrored inside PowerSync.
