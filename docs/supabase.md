# Supabase Integration

The PowerSync-first architecture stores Git metadata in Supabase while the PowerSync daemon synchronises changes between the local replica and Supabase. The daemon now owns all Supabase connectivity—credential exchange, CRUD uploads, and storage mirroring—so no Supabase edge functions are required anywhere in the toolchain.

## Environment Variables

| Variable | Description |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL used by the explorer (e.g. `https://xyzcompany.supabase.co`). |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/public key that the browser can embed. |
| `VITE_SUPABASE_SCHEMA` | Optional schema override for browser reads (defaults to `public`). |
| `SUPABASE_URL` | Supabase project URL used by the daemon/CLI for server-side access. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key consumed by the daemon’s Supabase writer. |
| `SUPABASE_EMAIL` | Supabase user email used by the CLI/daemon for password-based login in development. |
| `SUPABASE_PASSWORD` | Matching Supabase user password; exported automatically by `pnpm dev:stack`. |
| `SUPABASE_JWT_SECRET` | The Supabase JWT secret required by the PowerSync service and daemon. |
| `POWERSYNC_DAEMON_DEVICE_URL` | Optional verification URL the daemon prints for device flows (e.g. `http://localhost:5783/auth`). |
| `POWERSYNC_DAEMON_DEVICE_AUTO_LAUNCH` | When `true`, the daemon attempts to open the verification URL in the default browser. |
| `POWERSYNC_DAEMON_DEVICE_TTL_MS` | Override (in milliseconds) for how long a device challenge remains valid (default 5 minutes). |

## Local Development

1. Apply the latest migrations (`supabase db push`). This targets the local stack if it is already running, or your linked Supabase project otherwise and ensures the `refs`, `commits`, `file_changes`, and `objects` tables exist.
2. Start the combined Supabase + PowerSync stack:
   ```bash
   pnpm dev:stack
   ```
   The script launches the Supabase containers, bootstraps the PowerSync services, ensures a development Supabase user exists, and synchronises those credentials into the `local-dev` profile stored under `~/.psgit` (override with `PSGIT_HOME` when you need an isolated config directory). Use `--print-exports` if you need shell exports; otherwise the profile provides everything the CLI, explorer, and tests need.
3. Profiles are refreshed automatically. Run `psgit profile list` to confirm the active profile (default is `local-dev`). Override ad‑hoc with `STACK_PROFILE=staging pnpm --filter @pkg/cli sync` (or similar) when targeting a remote environment.
4. Start the device flow so `psgit` and the daemon can reuse a Supabase-issued JWT:
   ```bash
   pnpm --filter @pkg/cli login
   ```
   The CLI prints a device code and, when `POWERSYNC_DAEMON_DEVICE_URL` is set, a ready-to-click URL. Visit the URL in a browser (the explorer exposes `/auth?device_code=…` for development at `http://localhost:5783`), sign in with the Supabase credentials exported by `pnpm dev:stack`, and the daemon will persist the resulting token.

5. Launch the explorer with the desired profile (`pnpm dev` for local, `STACK_PROFILE=staging pnpm --filter @app/explorer dev` for remote). Playwright helpers are available via `pnpm --filter @app/explorer test:e2e:local` or `pnpm --filter @app/explorer test:e2e:staging`. The explorer automatically completes pending device challenges when the user signs in, so you can re-run `psgit login` later without leaving the browser.

When you are done, run `pnpm dev:stack stop` (or `supabase stop`) to shut everything down.

## Production Notes

- Follow the official [Supabase + PowerSync guide](https://docs.powersync.com/integration-guides/supabase-+-powersync) for hosted environments.
- The daemon requires a Supabase service-role key (or service token) so it can persist refs, commits, and objects without exposing credentials to end users.
- In CI or other headless contexts, set `POWERSYNC_SERVICE_KEY` (or equivalent) so the daemon can authenticate without launching an interactive browser flow.

## Live Supabase Validation Run

Once you have a remote Supabase project populated with the PowerSync schema, you can exercise the full CLI workflow against it:

1. Export the following environment variables (their values should point at your hosted Supabase + PowerSync deployment):

   | Variable | Description |
   | --- | --- |
   | `PSGIT_TEST_REMOTE_URL` | `powersync::https://…/orgs/<org>/repos/<repo>` remote used for the round-trip test. |
   | `PSGIT_TEST_REMOTE_NAME` | Optional Git remote name override (defaults to `powersync`). |
   | `PSGIT_TEST_SUPABASE_URL` | Supabase project URL. |
   | `PSGIT_TEST_SUPABASE_EMAIL` | Supabase user email with permission to push refs. |
   | `PSGIT_TEST_SUPABASE_PASSWORD` | Matching Supabase user password. |
   | `PSGIT_TEST_ENDPOINT` | Optional PowerSync endpoint override (falls back to the one embedded in the remote URL). |

2. Run the validation suite:

   ```bash
   pnpm live:validate
   ```

   The script verifies the required environment variables and then executes `pnpm --filter @pkg/cli test -- --run src/cli.e2e.test.ts`, exercising the daemon-mediated fetch/push path against your live Supabase project. The output lists each step (remote add, sync, logout) along with any failures.

3. When you are finished, clear Supabase credentials if needed:

   ```bash
   pnpm --filter @pkg/cli logout
   ```

## Rotating Supabase Auth to RS256 (Optional)

The local stack and CLI default to Supabase’s HS256 tokens. If you later rotate your Supabase project to RS256, follow the official Supabase guidance and make sure PowerSync can fetch the new JWKS. After Supabase serves the RS256 keys, restart the PowerSync service so it reloads the configuration, then confirm that a fresh Supabase login works end-to-end.
