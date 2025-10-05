# Agents.md — PowerSync “Sync Streams” Git Remote (Org‑Scoped) + TanStack DB

## Why
We’re showcasing **local‑first Git** where the **local porcelain** is system git, and the **remote transport** (clone/fetch/push) is handled by a PowerSync‑backed remote helper. The **web explorer** uses **TanStack DB** collections backed by PowerSync via the **PowerSync↔TanStack adapter** from PR `powersync-ja/temp-tanstack-db#1`.

- **Control plane:** refs/commits/inventory in Postgres (streamed to clients via **Sync Streams**)
- **Data plane:** Git packfiles in S3‑compatible storage (e.g., Supabase Storage)
- **Client:** PowerSync Web SDK + **TanStack DB collections** (offline, live, optimistic)

## Org scoping (URLs & streams)
Remote URL format:
```
powersync::https://<endpoint>/orgs/<org_slug>/repos/<repo_slug>
```
Stream names (server side; client subscribes per org+repo):
```
orgs/{org_id}/repos/{repo_id}/refs
orgs/{org_id}/repos/{repo_id}/commits
orgs/{org_id}/repos/{repo_id}/file_changes
orgs/{org_id}/repos/{repo_id}/objects
```

## Adapter (from PR)
Using `@tanstack/powersync-db-collection` from the PR to create TanStack DB collections on top of PowerSync SQLite.
Key entry points:
- `powerSyncCollectionOptions({ database, tableName, schema? })`
- `convertPowerSyncSchemaToSpecs(AppSchema)`
- `PowerSyncTransactor` for explicit TanStack → PowerSync transaction persistence

See **README.md** for how to install directly from the PR branch during development.

## Remote helper (unchanged)
Our `git-remote-powersync` supports the Git remote‑helper protocol (`capabilities`, `list`, `fetch`, `push`, `option`). It parses the org/repo slugs, resolves to IDs, and scopes all operations by `{org_id, repo_id}`.

## Explorer (web)
Routes: `/:orgId` and `/:orgId/repo/:repoId/*`. Each route subscribes to the 4 org‑scoped streams. UI queries use **TanStack DB `useLiveQuery`** on collections (`refs`, `commits`, `file_changes`).

