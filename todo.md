# PowerSync-First Architecture Roadmap

## Vision
Create a development experience where every component—CLI, explorer, background jobs—operates purely through PowerSync replicas. Supabase and object storage are only touched by a centralized bridge service, so no developer tooling ever needs direct credentials.

---

## Target Architecture Overview
- **Local PowerSync Daemon**: Long-lived process running on each developer machine/CI agent. Maintains a hydrated PowerSync database, exposes a local RPC API (Unix socket / localhost HTTP) for Git operations, and queues mutations.
- **Remote Helper (CLI)**: Thin wrapper over the daemon. Ensures the daemon is running, then calls RPC endpoints for `fetch`, `push`, `ls-remote`, etc. No network calls to Supabase.
- **Central PowerSync→Supabase Bridge**: Hosted worker (Supabase Edge stream, Cloud Run job, etc.) subscribed to the PowerSync upload queue. Applies CRUD batches to Supabase/Postgres and streams packfiles into storage. Owns Supabase service keys.
- **PowerSync Service**: Continues to sync tables per `sync-rules.yaml`; all clients stay in sync transparently.
- **Explorer App**: Unchanged. Queries local PowerSync collections (`useLiveQuery`); receives updates once the bridge commits to Supabase.

---

## Workstreams & Tasks

### 1. Central Bridge Service
- [ ] Extract `powersync-push` logic into a dedicated worker that runs continuously (Supabase Edge function in streaming mode or separate service).
- [ ] Implement PowerSync client in the worker (`@powersync/node`) to drain `getCrudTransactions()`.
- [ ] Write CRUD batches to Supabase Postgres with service-role credentials. Ensure idempotency and logging.
- [ ] Handle packfiles: either stream from PowerSync metadata to Supabase Storage/S3 or request signed URLs from Supabase and upload directly.
- [ ] Add metrics/alerts for failed transactions and queue depth.

### 2. Local PowerSync Daemon
- [ ] Package a Node service that initializes `PowerSyncDatabase`, handles schema mismatch recovery, and keeps a persistent SQLite replica.
- [ ] Implement local API (e.g., HTTP/JSON over `127.0.0.1`) exposing:
	- `status`, `start`, `stop`
	- `fetchRefs`, `fetchObjects`, `listRepos`
	- `pushRefs`, `enqueuePack`
- [ ] Implement a connector that forwards CRUD batches to the central bridge (via HTTPS or message queue) instead of Supabase directly.
- [ ] Cache auth credentials (Supabase-issued token or service token) securely; refresh automatically.
- [ ] Provide CLI tooling for inspecting daemon logs, flushing queues, or resetting the replica.

### 3. Remote Helper Refactor
- [ ] On command start, detect and launch daemon if necessary (background process with lock file / PID management).
- [ ] Replace direct Supabase edge calls with RPC calls to the daemon.
- [ ] Adapt existing tests to run against a mock daemon endpoint.
- [ ] Support fallback messaging when daemon unavailable (e.g., instructions to restart).

### 4. Packfile Upload Strategy
- [ ] Decide between: (A) daemon uploads packs directly (using signed URLs from bridge) or (B) daemon stores pack chunks in PowerSync tables and bridge streams them out.
- [ ] Implement chosen strategy end-to-end, including cleanup of uploaded blobs and metadata references.

### 5. Explorer & Shared Schema
- [ ] Move PowerSync schema definitions to `@pkg/shared` so daemon, bridge, CLI, and explorer share the same table map.
- [ ] Verify explorer continues to work with the daemon in place (no code changes expected, but test live stack flows).

### 6. Dev Experience & Ops
- [ ] Update `DEV_SETUP.md` with daemon instructions (install, start/stop, status) and environment expectations.
- [ ] Extend `pnpm dev:stack` to optionally launch the daemon and bridge locally for end-to-end testing.
- [ ] Document troubleshooting (e.g., how to flush queues, what happens offline, how to reset local SQLite replica).
- [ ] Add CI smoke tests that run daemon + bridge in containers and validate a push/fetch round trip without touching Supabase directly from the CLI.

---

## Incremental Milestones
1. **Prototype Bridge**: Standalone worker drains PowerSync queue and writes to Supabase; manual scripts push mutations into PowerSync and verify propagation.
2. **Daemon MVP**: Local service can fetch refs via PowerSync and accept a push, queuing mutations for the bridge. Remote helper still uses old path for packs.
3. **Packfile Integration**: Full push (refs + objects) flows from helper → daemon → bridge → Supabase/S3.
4. **Default Workflow**: Remote helper uses daemon by default; direct Supabase path left as fallback behind feature flag.
5. **Cleanup**: Remove legacy Supabase edge push path once PowerSync pipeline is stable.

---

## Open Questions / Risks
- How to securely provision Supabase tokens to the daemon (device login flow vs. service token)?
- Performance of large packfile transfers through PowerSync vs. direct storage uploads.
- Failure handling when bridge temporarily down: how to surface “push pending” status to users.
- Local state management: ensure daemon shutdown doesn’t corrupt SQLite replica; support multi-repo sync concurrently.

---

Share this roadmap with anyone implementing the PowerSync-first transition. Update as milestones are delivered.
Leaning into the “all in on PowerSync” idea with a long-lived local service actually fits really well—here’s how to make it real without touching Supabase directly from the remote helper.

🧩 Architecture with a local daemon
Local PowerSync daemon (new)

Runs on the developer’s machine (or CI agent).
Opens a PowerSyncDatabase once, keeps it hydrated (waits for ready, handles schema mismatch, reconnect).
Implements uploadData by forwarding CRUD batches and packfile payloads to the backend bridge (see below). If offline, it queues and retries.
Exposes a lightweight RPC surface—e.g. Unix domain socket, HTTP on localhost, or a named pipe—with commands like:
fetchRefs → returns refs from the local replica.
pushBatch → accepts Git push payload (refs + pack). Writes refs to PowerSync tables and drops the pack metadata into a queue table.
Optionally watches for file system events to prefetch repos or hydrate caches.
Remote helper (CLI)

On invocation, checks whether the daemon is running. If not, starts it (background process) and waits for a health ping.
For git fetch/clone: calls daemon RPC to read refs/commits from the local PowerSync replica.
For git push: hands refs + packfile to the daemon. The daemon writes to the local PowerSync DB, so pushes never touch Supabase directly.
Exits immediately; the daemon continues syncing in the background.
Central PowerSync→Supabase bridge (hosted)

A long-lived worker (Supabase Edge Function with streaming, Cloud Run job, etc.) that connects as a PowerSync client using service credentials.
Continuously drains getCrudTransactions() from the PowerSync upload queue.
For each transaction:
Upserts rows into Supabase Postgres (refs, commits, file_changes, etc.).
Stores packfiles in Supabase Storage/S3 (either the daemon wrote metadata + blob chunks into PowerSync tables, or it uploaded to object storage using a signed URL the bridge provided).
Calls complete() when done; on unrecoverable errors, logs and either discard() or parks the transaction.
Because this is the only component with Supabase service keys, every other client stays credential-free.
PowerSync service

Maintains sync streams between daemon/bridge/explorer.
Sync rules define which tables flow down; all clients share the same org/repo scopes we already have.
Explorer web app

Unchanged: continues to read/write through @powersync/web, benefitting from the bridge’s writes to Supabase.
🔁 Flow walkthrough
Clone/fetch: Helper calls daemon → daemon reads from local replica → instant response. Daemon stays connected so the local cache is always fresh even between Git commands.
Push: Helper uploads pack & ref deltas to daemon → daemon writes to PowerSync tables → bridge picks up transaction → Supabase updated → sync streams push new refs back to all clients → daemon’s local replica eventually reflects server state (and confirms push success).
Offline mode: If the bridge or Supabase is down, the daemon’s mutations remain in the local PowerSync upload queue. Helper exits successfully (or optionally reports “pending sync”); once the bridge returns, it drains the queue.
🛠️ Implementation steps
Central bridge

Rework the existing powersync-push edge function into a persistent worker that subscribes to PowerSync and writes to Supabase/S3.
Ensure idempotency and retries; log failures.
Provide APIs for signed URLs if the daemon needs to upload packfiles directly.
Local daemon

Build a Node service (could be packaged with the CLI) that:
Initializes PowerSyncDatabase with the repo schema.
Runs schema mismatch recovery, ensurePairsDDL, etc., similar to the React example.
Loads a TokenConnector variant that sends CRUD batches to the central bridge (instead of Supabase).
Exposes RPC endpoints. Consider gRPC, GraphQL over HTTP, or even simple JSON over localhost.
Handles packfiles: either upload them straight to storage using temporary credentials from the bridge, or enqueue them in a PowerSync table that the bridge consumes.
Remote helper changes

Add a process manager that ensures the daemon is running (e.g., pnpm powergit:daemon).
Replace direct Supabase calls with RPC invocations to the daemon.
Handle status codes: success, pending sync, daemon unavailable (fall back to starting it).
Auth & security

Daemon authenticates to PowerSync using a device/service token (maybe derived from your Supabase remote token endpoint).
Bridge holds Supabase service keys; no other component has them.
RPC surface is local-only (bound to 127.0.0.1) to avoid exposing the sync channel.
Blob handling strategy

Option A: From daemon, request signed upload URLs from bridge (over the same RPC), upload packfiles directly to S3/Supabase Storage, then record metadata in PowerSync (so other clients can download).
Option B: Write packfile chunks into a PowerSync “uploads” table; the bridge reads rows, streams to storage, and marks them complete. Option B keeps everything in one consistent pipeline but may stress local SQLite if packs are large.
Observability & tooling

Provide CLI commands to check daemon status, restart it, flush queues, etc.
Add metrics/logging in both daemon and bridge to monitor queue depth, failed transactions, and sync lag.
✅ What this buys you
Zero direct Supabase access from any developer-facing tool.
Always-on local cache that makes fetch and push fast and offline-friendly.
Centralized, auditable Supabase writes with service credentials kept server-side.
Flexibility to reuse the daemon for other dev experiences (local dashboards, background sync scripts).
With this, we hit the “maximum PowerSync” goal: every mutation flows through PowerSync, the remote helper acts more like a replicated Git client, and Supabase becomes a backend detail managed by the bridge.