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

## Agent workflow
- While you work, keep `todo.md` up to date with progress, blockers, and next steps so the next agent has continuity.
- Any time you rebuild the PowerSync core (`third_party/powersync-sqlite-core`), reapply the pnpm patches so the fresh `libpowersync*.wasm`/`libpowersync*.dylib` land in consumers: `pnpm patch @powersync/web`, copy the new wasm artifacts into the patch workspace, `pnpm patch-commit …`, repeat for `@powersync/node`, then `pnpm install --force` and restart dev servers so the explorer picks up the new binaries (check the symlink under `packages/apps/explorer/node_modules/@powersync/web` if in doubt).
- The dev stack now exports `POWERSYNC_DAEMON_ENDPOINT` + `POWERSYNC_DAEMON_TOKEN` alongside the existing PowerSync env vars; it also keeps the `local-dev` profile in sync. Set `STACK_PROFILE` before invoking CLI/daemon flows so the auto-started daemon authenticates correctly when targeting alternative stacks.

## Remote helper (unchanged)
Our `git-remote-powersync` supports the Git remote‑helper protocol (`capabilities`, `list`, `fetch`, `push`, `option`). It parses the org/repo slugs, resolves to IDs, and scopes all operations by `{org_id, repo_id}`.

## Explorer (web)
Routes: `/:orgId` and `/:orgId/repo/:repoId/*`. Each route subscribes to the 4 org‑scoped streams. UI queries use **TanStack DB `useLiveQuery`** on collections (`refs`, `commits`, `file_changes`).

## Daemon-first auth transition (2025-10-13)
Goal: remove Supabase/PowerSync credential handling from the Git remote-helper entirely. The helper should only speak to the local daemon; the daemon owns PowerSync connectivity, token refresh, and Supabase write-through.

### Current gaps
- Daemon push/fetch path is incomplete; packs/refs still bypass it.
- No interactive auth UX if the daemon lacks credentials.

### Target flow
1. **Daemon owns RPC surface**  
   - Expose `fetchRefs`, `fetchObjects`, `pushRefs`, `enqueuePack`, `status`, etc. over localhost.  
   - Helper invokes these RPCs only; no Supabase env vars required.

2. **Interactive login for daemon**  
   - On startup (or when tokens expire) daemon launches a browser/device-code flow to Supabase/SSO.  
   - After user signs in, daemon caches the PowerSync token/service creds locally and marks itself “authenticated”.

3. **Helper orchestration**  
   - Helper ensures daemon is running, waits for `status` to report `ready`.  
   - If daemon replies `auth_required`, helper prints instructions and exits (no direct login fallback).

4. **CI / headless**  
   - Provide a service-token mode (`POWERSYNC_SERVICE_KEY`) so CI can start the daemon non-interactively.  
   - Tests should still call daemon RPCs; skip browser prompts when service credentials are present.

### Work items
- [ ] Finish daemon push path: accept Git refs + packs over RPC, write to local PowerSync DB, queue storage uploads.  
- [ ] Wire helper commands to daemon RPCs; delete direct Supabase token logic.  
- [ ] Implement auth UX in daemon (browser launch, PKCE, local cache, logout).  
- [ ] Update e2e harness to start daemon + simulate interactive auth (e.g., seeded service token).  
- [ ] Refresh docs (`DEV_SETUP.md`, `docs/supabase.md`) to describe the new flow and required environment.
- [x] Decide whether the daemon should rely on Supabase-issued JWTs (per Supabase + PowerSync guide) or continue minting custom RS256 tokens; update auth plumbing accordingly. *(Supabase JWTs now default; RS signer removed.)*
- [x] Provision the PowerSync service with the appropriate JWKS (or enable dev bypass) so whichever token source we pick validates locally. *(Local stack now exports HS secret + base64; service fetches Supabase JWKS automatically.)*
