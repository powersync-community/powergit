# PowerSync-First Architecture Roadmap

## Vision
Create a development experience where every component—CLI, explorer, background jobs—operates purely through PowerSync replicas. Supabase and object storage are written through the daemon’s integrated bridge layer (running locally for dev and configurable for shared environments), so no developer tooling ever needs direct credentials.

## Current Status (2025-10-18)
- Local daemon manages the PowerSync SQLite replica, handles pushes/fetches, and writes Supabase mutations through its internal writer.
- Remote helper already delegates all Git operations to the daemon via `PowerSyncRemoteClient`.
- CLI now calls the daemon’s `/summary` endpoint for `psgit sync` instead of creating its own SQLite snapshot; documentation/tests updated accordingly.
- Explorer still authenticates directly against Supabase (`@supabase/supabase-js`) and uses `@powersync/web` to read data; no daemon integration yet.
- Auth today is manual: CLI caches Supabase JWTs in `~/.psgit/session.json`; explorer embeds Supabase anon key; remote helper relies on daemon env vars.

---

## Agent Notes (2025-10-08)
- Pinned workspace to `@powersync/common|node|web|react@0.0.0-dev-20251003085035` and used `pnpm.peerDependencyRules.allowedVersions` so the TanStack adapter peer constraint stays satisfied without modifying the submodule; added direct deps where needed for peer compliance.
- Added automatic PowerSync env injection in `scripts/dev-local-stack.mjs` so `pnpm dev:stack` exports `PS_*`/`POWERSYNC_*` values needed by the config parser and seeding. Verified via `node scripts/dev-local-stack.mjs --dry-run --print-exports`.
- Tightened `pnpm dev:stack` error handling so workspace builds and seed steps fail fast instead of logging warnings. Verified command now exits once `@pkg/cli` build fails on missing `objects` key.
- Removed the Supabase `powersync-push` function and demo seeding hook from `pnpm dev:stack`; docs/scripts now stop short of pushing sample commits until the daemon-backed flow replaces it.
- Next: wire the CLI/remote helper push path directly to the daemon/Supabase writer so automated seeding (or equivalent smoke tests) can return without edge functions.
- Blockers: daemon push path is still incomplete, so remote-helper pushes currently fail once they leave PowerSync.
- Implemented a Supabase writer inside the daemon that drains `getNextCrudTransaction()`, upserts to `refs/commits/file_changes`, and mirrors `objects` into `git_packs`. Writer is auto-enabled when `POWERSYNC_SUPABASE_URL` + service key are present and stops cleanly during shutdown. Added unit coverage to confirm bytea encoding and delete propagation; typecheck + vitest pass.
- Immediate follow-up: flesh out error/backoff strategy (currently simple retry loop) and add an end-to-end push that exercises the writer against real Supabase tables.
- Began migrating the daemon to PowerSync raw tables: shared schema now exposes synthetic `id` columns, Supabase schema mirrors the change, local SQLite tables are materialised separately (`raw_*`) with views to keep existing queries working, and Supabase writer/queries rely on the single-column key. Daemon bootstrap still needs a reliable way to create initial placeholder views so `powersync_drop_view` stops failing on a fresh replica.
- Updated the remote helper push path to stream via `PowerSyncRemoteClient.pushPack`, keeping pack uploads within the daemon's PowerSync raw tables and forwarding summary/pack metadata through the shared `options` structure. Local vitest remains blocked by the missing `@tanstack/db` workspace dependency, so tests couldn't be executed.
- Wired Vitest to load `@shared/core` directly from sources and skip the Supabase-dependent git e2e helper suite when the CLI isn't available; refreshed daemon writer tests to assert raw table upserts instead of legacy `git_packs`/`refs` names so both packages' test suites pass locally.
- Added Docker + Supabase CLI autodiscovery so the git e2e suite can launch the real local stack when the binaries (and daemon) are available, exporting `SUPABASE_BIN`/`DOCKER_BIN` via `pnpm dev:stack` for manual runs.

## Agent Notes (2025-10-09)
- CLI e2e suite now boots the local Supabase stack via the shared `test-stack-hooks` helper, seeds refs/commits directly into the Postgres raw tables, and runs the compiled CLI binary so worker paths resolve correctly.
- Live CLI sync test auto-detects missing Docker/Supabase binaries or native `better-sqlite3` bindings and skips gracefully instead of hard failing; skip reason is logged for visibility.
- Next: ship a reliable `better-sqlite3` build (or alternative sqlite backend) in CI/dev images so the sync assertion can execute end-to-end without falling back to the skip path.

## Agent Notes (2025-10-13)
- Verified local `better-sqlite3` rebuild; CLI/remote-helper e2e now reach PowerSync. We removed the `powersync-remote-token` signer entirely and rely on Supabase-issued HS256 JWTs.
- Local stack now provisions a Supabase email/password automatically and exports them so the CLI/daemon can log in via the standard Supabase password flow.
- Decision: finish the daemon-first architecture so the helper becomes authless. The daemon will own token refresh and can surface an interactive login when credentials are missing.
- Immediate actions tracked below (add new workstream items): finish daemon RPC push/fetch, add interactive auth (browser/PKCE), remove helper’s Supabase dependency, and update CI harnesses.

## Agent Notes (2025-10-15)
- CLI now walks up from the package directory when resolving `.env.powersync-stack`, so `pnpm --filter @pkg/cli …` commands inherit the dev stack exports automatically.
- Added `psgit daemon stop` to issue `/shutdown` requests and poll until the daemon exits; the helper no longer leaves orphaned `pnpm --filter @svc/daemon start` processes.
- Guest login falls back to Supabase password auth when no token is provided, letting `pnpm --filter @pkg/cli cli login --guest` mint a JWT against the local stack without manual env tweaks.
- `pnpm dev:stack:down` now calls the new CLI command to terminate the daemon before tearing down Supabase/PowerSync services.

## Agent Notes (2025-10-18)
- Removed the remaining Supabase edge function clients (`invokeSupabaseEdgeFunction`, browser connector hooks, CLI login flow) and replaced them with env/daemon-based credential handling. CRUD uploads now hard-fail if a caller still expects the old functions so we surface unsupported write paths immediately.
- Deleted all edge function assets (`supabase/functions/*`, smoke script) and disabled Supabase's edge runtime in the local stack. Updated `dev-local-stack` to stop deploying functions and refreshed docs (`DEV_SETUP.md`, `docs/supabase.md`, `docs/env.local.example`) to reflect the daemon-owned flow.
- CLI `login` no longer accepts `--functions-url` or `--service-role-key`; use Supabase password login or manual tokens. Tests were updated accordingly; the live sync e2e still times out at 60 s after the stack bootstrap (needs follow-up to stabilise the daemon push path).
- CLI now delegates `psgit sync` to the daemon: we removed the local PowerSync database, call the daemon's new `/summary` endpoint, and print raw table counts instead of creating a SQLite snapshot. New RPCs (`/summary`) were added to the daemon and shared client; tests/docs updated accordingly.

## Agent Notes (2025-10-19)
- Explorer router is now wrapped with `SupabaseAuthProvider`; PowerSync only connects once a Supabase session is present and disconnects on logout. Connector fetches Supabase access tokens dynamically in place of static env secrets.
- Added Supabase client helper/context plus new `/auth`, `/vault`, and `/reset-password` routes with dedicated screens. Root layout redirects unauthenticated visitors to `/auth`, exposes a sign-out control, and keeps fixtures bridge initialisation intact.
- Introduced a local vault flow: authenticated users must create/unlock a passphrase-backed vault (`/vault`) before PowerSync connects. Vault metadata lives in `localStorage` (hashed via SHA-256 when available) and we expose lock/clear helpers for future daemon integration.
- Supabase helper now supports runtime-injected mock clients (used in unit tests) so we can run UI tests without real credentials.
- Explorer PowerSync connector now prefers a daemon-issued token when `VITE_POWERSYNC_USE_DAEMON=true`, falling back to Supabase sessions otherwise—ready for the upcoming daemon auth RPCs.
- Added unit coverage for the vault context plus React Testing Library suites for `AuthScreen`/`VaultScreen` flows to exercise create/unlock and guest pathways.
- Follow-ups: swap PowerSync token fetching to the daemon RPC once available (still using Supabase access tokens directly) and build end-to-end coverage for the new auth/vault flow.

## Agent Notes (2025-10-20)
- Hardened router redirects to avoid the infinite `navigate` loop that surfaced once Playwright started exercising the auth/vault flow. We now short-circuit duplicate redirects and centralise the vault gating in `__root` (`packages/apps/explorer/src/routes/__root.tsx`, `packages/apps/explorer/src/routes/auth.tsx`).
- Made the vault requirement runtime-tunable so tests can disable it by default. A `window.__powersyncRequireVault` override lets specific suites (auth-flow) re-enable the gate without recompiling (`packages/apps/explorer/src/ps/vault-context.tsx`).
- Playwright config defaults the explorer to run without a vault while the auth flow test opts in at runtime. Smoke tests seed fixtures under an authenticated Supabase mock with the vault disabled; the auth flow still covers the create/unlock round trip (`packages/apps/explorer/playwright.config.ts`, `packages/apps/explorer/tests/e2e/*.spec.ts`).
- Explorer e2e suite is back to green—`pnpm --filter @app/explorer test:e2e` runs both the smoke queries and auth flow without manual vault intervention.

## Next Steps / TODO (Auth & Explorer)

1. **Daemon Auth API**
   - File targets: `packages/daemon/src/server.ts`, `packages/daemon/src/auth/*`, and `packages/daemon/src/index.ts`.
   - ✅ `/auth/status`, `/auth/guest`, `/auth/device`, and `/auth/logout` endpoints proxy the daemon auth manager; credentials persist to `~/.psgit/session.json` and feed the PowerSync connector. `/auth/device` now issues challenge codes with structured context so other clients (Explorer/CLI) can finalize the flow.
   - ✅ Device/browser flow scaffolding: daemon tracks pending challenges, optionally launches a verification URL, and accepts completion via `/auth/device` with `challengeId + token` (Explorer wiring in place). Supabase OAuth/device-code integration remains to be wired.
   - ⏳ Expose proactive expiry/refresh logic so clients can prompt reauth before failure.

2. **CLI Login Flow**
   - File targets: `packages/cli/src/bin.ts`, `packages/cli/src/auth/login.ts`, `packages/cli/src/index.ts`.
   - ✅ `psgit login --guest` now proxies to daemon `/auth/guest`; manual tokens reuse the same path.
   - ✅ Default `psgit login` triggers `/auth/device`, surfaces device codes/verification URLs, and polls `/auth/status` until the daemon reports `ready/error/auth_required`.
   - ✅ `psgit sync` no longer depends on cached tokens; it ensures the daemon is ready/authenticated before reading repo summaries.
   - ⏳ Once the daemon can mint tokens autonomously, tighten CLI messaging around browser/device completion vs. retries.

3. **Explorer Authentication**
   - File targets: `packages/apps/explorer/src/screens/auth/*`, `packages/apps/explorer/src/routes/*`, `packages/apps/explorer/src/ps/*`.
   - ✅ Supabase helper/context, `/auth`, `/vault`, and `/reset-password` routes/screens implemented; vault gating in place; unit coverage added for auth + vault screens.
   - ⏳ Next auth tasks:
     - Wire explorer PowerSync connector to daemon-issued tokens once `/auth/status` etc. are available (replace direct Supabase access tokens).
     - Add Playwright coverage for the full `/auth → /vault → explorer → sign out → re-auth → unlock` flow using the injected Supabase mock (current attempt blocked on Vite mount timing).
     - Extend tests to cover guest/device login flows once the daemon endpoints exist.

4. **CLI ↔ Explorer Onboarding**
   - File targets: `packages/cli/src/bin.ts` (login command), `packages/apps/explorer/src/main.tsx` (listen for daemon status).
  - Implement `psgit login` fallback: if no credentials cached, launch explorer login UI (or instruct user to visit local login route). CLI polls `/auth/status` and exits once authenticated.

5. **Testing / Coverage**
   - CLI: add e2e flows for guest login, device/browser login, missing credentials, expired credentials, invalid daemon state (`packages/cli/src/cli.e2e.test.ts`).
   - Explorer: add integration tests covering sign-in, sign-up, password reset, guest flow, and verifying PowerSync data appears post-auth (`packages/apps/explorer/tests/e2e/*`).
   - ✅ Daemon: coverage added for auth manager persistence, HTTP auth routes, and device challenge lifecycle (`packages/daemon/src/__tests__/auth-manager.test.ts`, `server-auth.test.ts`, `device-flow.test.ts`). Extend with negative cases once token refresh logic lands.
   - ✅ CLI unit tests updated for daemon auth helpers & sync path (`packages/cli/src/auth/login-daemon.test.ts`, `packages/cli/src/sync.test.ts`). Live-stack suite now skips gracefully when daemon credentials are absent.
   - ✅ Explorer unit coverage now exercises device challenge parsing (`packages/apps/explorer/src/ps/daemon-client.test.ts`).

6. **Docs / Dev Experience**
   - Update `DEV_SETUP.md`, `docs/supabase.md`, and explorer README to describe new auth flows, required env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_RESET_REDIRECT_URL`, etc.).
   - Document CLI commands (`psgit login --guest`, `psgit login`, `psgit logout`) and troubleshooting steps when daemon auth fails.

## Target Architecture Overview
- **Local PowerSync Daemon**: Long-lived process running on each developer machine/CI agent. Maintains a hydrated PowerSync database, exposes a local RPC API (Unix socket / localhost HTTP) for Git operations, and queues mutations.
- **Remote Helper (CLI)**: Thin wrapper over the daemon. Ensures the daemon is running, then calls RPC endpoints for `fetch`, `push`, `ls-remote`, etc. No network calls to Supabase.
- **Local PowerSync Daemon (with integrated Supabase writer)**: Long-lived process running on each developer machine/CI agent. Maintains a hydrated PowerSync database, exposes a local RPC API (Unix socket / localhost HTTP) for Git operations, and synchronises queued mutations directly to Supabase/Postgres and object storage. Owns (configurable) Supabase service credentials.
- **PowerSync Service**: Continues to sync tables per `sync-rules.yaml`; all clients stay in sync transparently.
- **Explorer App**: Unchanged. Queries local PowerSync collections (`useLiveQuery`); receives updates once the daemon commits to Supabase.

---

## Workstreams & Tasks

### 2. Local PowerSync Daemon
- [x] Package a Node service that initializes `PowerSyncDatabase`, handles schema mismatch recovery, and keeps a persistent SQLite replica. *(Implemented in `@svc/daemon` via `config.ts`, `database.ts`, `connector.ts`, and updated `startDaemon`.)*
- [ ] Implement local API (e.g., HTTP/JSON over `127.0.0.1`) exposing:
	- [x] `status` (`GET /health` served by `@svc/daemon/src/server.ts`)
	- [ ] `start`
	- [x] `stop` (`POST /shutdown` handled by daemon RPC server)
	- [x] `fetchRefs` (`GET /orgs/:orgId/repos/:repoId/refs` backed by daemon PowerSync replica)
	- [x] `fetchObjects` (`POST /orgs/:orgId/repos/:repoId/git/fetch` streaming latest pack from local replica)
	- [x] `listRepos` (`GET /orgs/:orgId/repos` summarizing repos from replicated refs)
	- [x] `pushRefs`, `enqueuePack` (`POST /orgs/:orgId/repos/:repoId/git/push` persists refs/commits + stores packs in PowerSync`)
- Shared schema now includes an `objects` table mirroring `git_packs` so packs replicate through PowerSync.
- [x] Implement a Supabase writer inside the daemon that drains `getCrudTransactions()` and applies mutations directly (supporting both local Docker Supabase and hosted instances via configuration).
- [ ] Handle packfile uploads from the daemon (local filesystem or remote storage via signed URLs).
- [ ] Cache auth credentials (Supabase-issued token or service token) securely; refresh automatically. *(Local persistence now handled by daemon auth manager; automatic refresh still pending.)*
- [ ] Provide CLI tooling for inspecting daemon logs, flushing queues, or resetting the replica.
- [ ] Expose full Git RPC surface (`fetchRefs`, `pushRefs`, `fetchObjects`, `enqueuePack`) over localhost for the helper to consume.
- [x] Surface `auth_required` / `ready` status endpoints the helper can poll. *(Implemented via `/auth/status` in `@svc/daemon`.)*
- [ ] Implement interactive Supabase/SSO login (browser or device code) when service credentials are missing; persist tokens locally.
- [x] Ensure PowerSync service trusts Supabase JWTs (export HS secret + base64 for local dev) so daemon-issued/ Supabase tokens succeed.

### 3. Remote Helper Refactor
- [x] On command start, detect and launch daemon if necessary (background process with lock file / PID management).
- [x] Replace direct Supabase edge calls with RPC calls to the daemon.
- [ ] Adapt existing tests to run against a mock daemon endpoint.
- [x] Support fallback messaging when daemon unavailable (e.g., instructions to restart).
- [x] Remove Supabase credential logic (`powersync-remote-token` calls) once daemon RPCs land; helper becomes HS256-only (Supabase login).
- [ ] Update CLI/remote-helper e2e suites to expect daemon-mediated auth (simulate service token in CI).

### 4. Packfile Upload Strategy
- [ ] Decide between: (A) daemon uploads packs directly (using signed URLs) or (B) daemon stores pack chunks in PowerSync tables and streams them out via its Supabase writer.
- [ ] Implement chosen strategy end-to-end, including cleanup of uploaded blobs and metadata references.

### 5. Explorer & Shared Schema
- [ ] Move PowerSync schema definitions to `@pkg/shared` so daemon, Supabase writer, CLI, and explorer share the same table map.
- [ ] Verify explorer continues to work with the daemon in place (no code changes expected, but test live stack flows).

### 6. Dev Experience & Ops
- [ ] Update `DEV_SETUP.md` with daemon instructions (install, start/stop, status) and environment expectations.
- [ ] Extend `pnpm dev:stack` to optionally launch the daemon (with Supabase writer enabled) locally for end-to-end testing.
- [ ] Document troubleshooting (e.g., how to flush queues, what happens offline, how to reset local SQLite replica).
- [ ] Add CI smoke tests that run the daemon’s Supabase writer in containers and validate a push/fetch round trip without touching Supabase directly from the CLI.

---

## Incremental Milestones
1. **Prototype Bridge**: Standalone worker drains PowerSync queue and writes to Supabase; manual scripts push mutations into PowerSync and verify propagation.
- 2. **Daemon MVP**: Local service can fetch refs via PowerSync and accept a push, queuing mutations for its Supabase writer. Remote helper still uses old path for packs.
- 3. **Packfile Integration**: Full push (refs + objects) flows from helper → daemon → Supabase/S3.
- 4. **Default Workflow**: Remote helper relies on the daemon’s integrated writer by default; direct Supabase path left as fallback behind feature flag.
5. **Cleanup**: Remove legacy Supabase edge push path once PowerSync pipeline is stable.

---

## Open Questions / Risks
- How to securely provision Supabase tokens to the daemon (device login flow vs. service token)?
- Performance of large packfile transfers through PowerSync vs. direct storage uploads.
- Failure handling when Supabase temporarily down: how to surface “push pending” status to users.
- Local state management: ensure daemon shutdown doesn’t corrupt SQLite replica; support multi-repo sync concurrently.

---

Share this roadmap with anyone implementing the PowerSync-first transition. Update as milestones are delivered.
Leaning into the “all in on PowerSync” idea with a long-lived local service actually fits really well—here’s how to make it real without touching Supabase directly from the remote helper.

🧩 Architecture with a local daemon
Local PowerSync daemon (new)

Runs on the developer’s machine (or CI agent).
Opens a PowerSyncDatabase once, keeps it hydrated (waits for ready, handles schema mismatch, reconnect).
Implements uploadData by applying CRUD batches and packfile payloads directly to Supabase (see below). If offline, it queues and retries.
Exposes a lightweight RPC surface—e.g. Unix domain socket, HTTP on localhost, or a named pipe—with commands like:
fetchRefs → returns refs from the local replica.
pushBatch → accepts Git push payload (refs + pack). Writes refs to PowerSync tables and drops the pack metadata into a queue table.
Optionally watches for file system events to prefetch repos or hydrate caches.
Remote helper (CLI)

On invocation, checks whether the daemon is running. If not, starts it (background process) and waits for a health ping.
For git fetch/clone: calls daemon RPC to read refs/commits from the local PowerSync replica.
For git push: hands refs + packfile to the daemon. The daemon writes to the local PowerSync DB, so pushes never touch Supabase directly.
Exits immediately; the daemon continues syncing in the background.
Daemon-integrated Supabase writer

The daemon itself connects as a PowerSync client using service credentials (local or remote) and continuously drains `getCrudTransactions()` from its upload queue.
For each transaction it:
Upserts rows into Supabase Postgres (refs, commits, file_changes, etc.).
Stores packfiles in Supabase Storage/S3 (remote) or a developer-provided local object store, depending on the environment.
Calls `complete()` when done; on unrecoverable errors, logs and either `discard()` or parks the transaction.
Because the daemon owns this responsibility, every other client stays credential-free.
PowerSync service

Maintains sync streams between daemon/explorer (and any other local clients).
Sync rules define which tables flow down; all clients share the same org/repo scopes we already have.
Explorer web app

Unchanged: continues to read/write through @powersync/web, benefitting from the daemon’s writes to Supabase.
🔁 Flow walkthrough
Clone/fetch: Helper calls daemon → daemon reads from local replica → instant response. Daemon stays connected so the local cache is always fresh even between Git commands.
Push: Helper uploads pack & ref deltas to daemon → daemon writes to PowerSync tables → daemon’s Supabase writer drains the queue and updates Supabase → sync streams push new refs back to all clients → daemon’s local replica eventually reflects server state (and confirms push success).
Offline mode: If Supabase is unreachable, the daemon’s mutations remain in the local PowerSync upload queue. Helper exits successfully (or optionally reports “pending sync”); once Supabase returns, the daemon drains the queue.
🛠️ Implementation steps
Local daemon

Build a Node service (could be packaged with the CLI) that:
Initializes PowerSyncDatabase with the repo schema.
Runs schema mismatch recovery, ensurePairsDDL, etc., similar to the React example.
Loads a TokenConnector variant that applies CRUD batches directly to Supabase (local or remote) from within the daemon.
Exposes RPC endpoints. Consider gRPC, GraphQL over HTTP, or even simple JSON over localhost.
Handles packfiles: either upload them straight to storage using temporary credentials (signed URLs) or enqueue them in a PowerSync table that the writer consumes.
Remote helper changes

Add a process manager that ensures the daemon is running (e.g., pnpm powergit:daemon).
Replace direct Supabase calls with RPC invocations to the daemon.
Handle status codes: success, pending sync, daemon unavailable (fall back to starting it).
Auth & security

Daemon authenticates to PowerSync using a device/service token (maybe derived from your Supabase remote token endpoint).
Daemon holds Supabase service keys (via config); no other component has them. During development the same daemon config can target local Docker Supabase, while production environments can point at hosted Supabase.
RPC surface is local-only (bound to 127.0.0.1) to avoid exposing the sync channel.
Blob handling strategy

Option A: Request signed upload URLs (e.g., via Supabase functions) and upload packfiles directly to S3/Supabase Storage, then record metadata in PowerSync (so other clients can download).
Option B: Write packfile chunks into a PowerSync “uploads” table; the daemon’s Supabase writer reads rows, streams to storage, and marks them complete. Option B keeps everything in one consistent pipeline but may stress local SQLite if packs are large.
Observability & tooling

Provide CLI commands to check daemon status, restart it, flush queues, etc.
Add metrics/logging in the daemon to monitor queue depth, failed transactions, and sync lag.
✅ What this buys you
Zero direct Supabase access from any developer-facing tool.
Always-on local cache that makes fetch and push fast and offline-friendly.
Centralized, auditable Supabase writes with service credentials kept inside the daemon (local for dev, configurable for shared environments).
Flexibility to reuse the daemon for other dev experiences (local dashboards, background sync scripts).
With this, we hit the “maximum PowerSync” goal: every mutation flows through PowerSync, the remote helper acts more like a replicated Git client, and Supabase becomes a backend detail managed by the daemon’s integrated writer.
