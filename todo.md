# PowerSync Git Monorepo — Execution Log

## Current Status
- Supabase integration is now end-to-end for the remote helper push path: `uploadPushPack` forwards Git packs to the `powersync-push` edge function via `invokeSupabaseEdgeFunction`, and callers can override the function host with `POWERSYNC_SUPABASE_FUNCTIONS_URL` (used by tests + local stubs).
- Shared package exposes `PowerSyncRemoteClient` with async token provider support; CLI/remote helper compiles and their unit + integration suites pass (`pnpm --filter @pkg/remote-helper test`).
- Explorer app has stream hooks and optional Supabase-backed connector. Local `.env` now includes Supabase vars and `VITE_POWERSYNC_DISABLED` toggle to run without backend.
- Vitest unit coverage exists for shared utilities, remote helper token fetch/push, and stream helpers. Test matrix via `pnpm test` currently green.
- `DEV_SETUP.md` now has a concise quick-start, day-to-day command table, and cleaned testing notes to help onboard faster.

## In-Flight / Blocked
- Playwright end-to-end harness not implemented yet. `@playwright/test` dependency added but no config/tests. Need mocked PowerSync/Supabase layer (likely MSW or local server) before enabling CI.
- Supabase documentation lives in `docs/supabase.md`, but explorer README references only; ensure CLI + remote helper docs link back.
- Type-check for explorer still fails because `@tanstack/powersync-db-collection` comes from source; long term fix is to prebuild or vendor types.
- Supabase edge functions still POST to stub endpoints; need to wire real PowerSync backend/S3 storage and update config guidance now that push is flowing.

## Next Steps
1. Create Playwright setup (`packages/apps/explorer/playwright.config.ts`) with mock PowerSync API server (could reuse Supabase function mocks) and write first smoke test covering org listing + repo navigation. Hook into `pnpm test` or dedicated `pnpm --filter @app/explorer test:e2e` command.
2. Flesh out Supabase edge function examples (maybe under `supabase/functions/`). Include instructions in README for deploying them locally and in production. While doing so, incorporate the [PowerSync local dev Docker Compose flow](https://docs.powersync.com/self-hosting/local-development) so the repo can spin up PowerSync + Supabase locally (document compose file, env mapping, and how explorer/remote helper point at it).
3. Stand up real storage + PowerSync ingress for the Supabase functions (pack uploads currently sinkhole) and document required env wiring now that CLI push works via `POWERSYNC_SUPABASE_FUNCTIONS_URL` overrides.
4. Resolve TypeScript issues for explorer by generating local build of `@tanstack/powersync-db-collection` (e.g., run `pnpm -C node_modules/... build` postinstall) or stub necessary types.
5. Add more Vitest coverage: e.g., connector Supabase upload path (mock `getCrudBatch`), `PowerSyncRemoteClient.fetchPack` behavior with JSON pack fallback.

Share this file with the next agent for continuity.
