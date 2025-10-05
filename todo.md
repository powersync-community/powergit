# PowerSync Git Monorepo — Execution Log

## Current Status
- Supabase integration is partially wired: explorer connector and remote helper can source credentials via Supabase edge functions (`powersync-creds`, `powersync-upload`, `powersync-remote-token`). Missing piece: verifying Supabase functions exist and documenting server helper env for CLI (placeholders only).
- Shared package exposes `PowerSyncRemoteClient` with async token provider support; CLI/remote helper compiles and unit tests pass (`pnpm test`).
- Explorer app has stream hooks and optional Supabase-backed connector. Local `.env` now includes Supabase vars and `VITE_POWERSYNC_DISABLED` toggle to run without backend.
- Vitest unit coverage exists for shared utilities, remote helper token fetch, and stream helpers. Test matrix runs via `pnpm test` (all packages) successfully.

## In-Flight / Blocked
- Playwright end-to-end harness not implemented yet. `@playwright/test` dependency added but no config/tests. Need mocked PowerSync/Supabase layer (likely MSW or local server) before enabling CI.
- Remote helper push command still stubbed (currently returns `error push-not-implemented`). Requires connecting to backend once Supabase functions ready.
- Supabase documentation lives in `docs/supabase.md`, but explorer README references only; ensure CLI + remote helper docs link back.
- Type-check for explorer still fails because `@tanstack/powersync-db-collection` comes from source; long term fix is to prebuild or vendor types.

## Next Steps
1. Create Playwright setup (`packages/apps/explorer/playwright.config.ts`) with mock PowerSync API server (could reuse Supabase function mocks) and write first smoke test covering org listing + repo navigation. Hook into `pnpm test` or dedicated `pnpm --filter @app/explorer test:e2e` command.
2. Flesh out Supabase edge function examples (maybe under `supabase/functions/`). Include instructions in README for deploying them locally and in production. While doing so, incorporate the [PowerSync local dev Docker Compose flow](https://docs.powersync.com/self-hosting/local-development) so the repo can spin up PowerSync + Supabase locally (document compose file, env mapping, and how explorer/remote helper point at it).
3. Implement remote helper `push` pipeline: fetch pack payload from STDIN, forward to Supabase-hosted API, handle status responses (success/error) per ref spec.
4. Resolve TypeScript issues for explorer by generating local build of `@tanstack/powersync-db-collection` (e.g., run `pnpm -C node_modules/... build` postinstall) or stub necessary types.
5. Add more Vitest coverage: e.g., connector Supabase upload path (mock `getCrudBatch`), `PowerSyncRemoteClient.fetchPack` behavior with JSON pack fallback.

Share this file with the next agent for continuity.
