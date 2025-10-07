# Supabase Integration

The repo explorer and remote helper can be wired to Supabase edge functions so that PowerSync credentials and CRUD uploads are brokered by your Supabase project. Follow the official [Supabase + PowerSync integration guide](https://docs.powersync.com/integration-guides/supabase-+-powersync) and then map the outputs into the environment variables used here.

## Environment Variables

| Variable | Description |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL (e.g. `https://xyzcompany.supabase.co`). |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/public key exposed to the browser. |
| `VITE_SUPABASE_SCHEMA` | Optional schema for the client (defaults to `public`). |
| `VITE_SUPABASE_POWERSYNC_CREDS_FN` | Edge function name that returns `{ endpoint, token }`. Defaults to `powersync-creds`. |
| `VITE_SUPABASE_POWERSYNC_UPLOAD_FN` | Edge function that receives outbound CRUD batches. Defaults to `powersync-upload`. |
| `POWERSYNC_SUPABASE_URL` | (Remote helper) Supabase project URL for server-side calls. |
| `POWERSYNC_SUPABASE_SERVICE_ROLE_KEY` | (Remote helper) Service role key used to invoke edge functions securely. |
| `POWERSYNC_SUPABASE_REMOTE_FN` | (Remote helper) Function that returns remote-helper tokens. |
| `POWERSYNC_REMOTE_TOKEN_PRIVATE_KEY` | (Remote helper, required) PEM-encoded RSA private key for RS256 signing. |
| `POWERSYNC_REMOTE_TOKEN_KEY_ID` | (Remote helper, required) JWKS key ID that matches the Supabase-published RS256 key. |
| `POWERSYNC_REMOTE_TOKEN_AUDIENCE` | (Remote helper) Comma-separated audiences to embed in issued tokens (defaults to `authenticated`). |
| `POWERSYNC_REMOTE_TOKEN_ISSUER` | (Remote helper) Issuer claim for signed tokens (defaults to `powersync-dev-stack`). |
| `POWERSYNC_REMOTE_TOKEN_SUBJECT` | (Remote helper) Subject claim for signed tokens (defaults to `powersync-remote-helper`). |
| `POWERSYNC_REMOTE_TOKEN_ROLE` | (Remote helper) Role claim mirroring Supabase auth roles (defaults to `service_role`). |

## Edge Function Contracts

### `powersync-creds`

```ts
export interface CredentialResponse {
  endpoint: string
  token: string
}
```

Return the PowerSync endpoint and a scoped sync token for the active org/repo user.

### `powersync-upload`

```ts
interface UploadPayload {
  operations: Array<any>
}
```

Receive CRUD batches from the browser client. Forward these to your PowerSync backend or Supabase storage pipeline, then respond `{ ok: true }` when processed.

### `powersync-remote-token`

The remote helper can call this function with `{ remoteUrl }` to exchange for a PowerSync access token. Set `POWERSYNC_SUPABASE_REMOTE_FN` to the deployed function name and export the service role key in `POWERSYNC_SUPABASE_SERVICE_ROLE_KEY`.

This function always signs tokens with the RSA private key supplied via `POWERSYNC_REMOTE_TOKEN_PRIVATE_KEY`. Ensure the `kid` matches an entry in your Supabase JWKS so PowerSync can validate the tokens it receives.

## Deploying edge functions

### Local emulator

1. Start the Supabase stack (`pnpm dev:stack`). The script automatically runs `supabase functions serve powersync-creds`, `powersync-upload`, `powersync-remote-token`, and `powersync-push` with `--env-file supabase/.env`.
2. When iterating on a single function, you can hot-reload it without restarting the full stack:

  ```bash
  supabase functions serve powersync-remote-token --env-file supabase/.env --no-verify-jwt
  ```

  The `--no-verify-jwt` flag keeps development friction low while you validate new payloads. For end-to-end testing, prefer leaving `pnpm dev:stack` in charge so all functions reload together and the `.env.powersync-stack` exports stay accurate.

### Deploying to Supabase Cloud

1. Log into Supabase and target your project:

  ```bash
  supabase login
  supabase link --project-ref <your-project-ref>
  ```

2. Push the database schema generated via `pnpm schema:migrate`:

  ```bash
  pnpm schema:migrate -- --prod
  supabase db push
  ```

  The extra slug (`--prod`) keeps production migrations distinct from local smoke tests.

3. Deploy the edge functions (all at once or individually):

  ```bash
  supabase functions deploy powersync-creds --no-verify-jwt
  supabase functions deploy powersync-upload --no-verify-jwt
  supabase functions deploy powersync-remote-token --no-verify-jwt
  supabase functions deploy powersync-push --no-verify-jwt
  ```

  When ready to enforce JWT verification, redeploy each function without `--no-verify-jwt` after you confirm the RS256 key is configured (see below).

4. Verify health and logs from the CLI:

  ```bash
  supabase functions list
  supabase functions logs --name powersync-remote-token --limit 20
  ```

  Combine with the remote helper smoke call:

  ```bash
  curl -sS "https://<your-project>.supabase.co/functions/v1/powersync-remote-token" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"remoteUrl":"powersync::https://example.com/orgs/demo/repos/infra"}' | jq
  ```

### Re-enabling `verify_jwt`

1. Ensure RS256 secrets from [Rotating Supabase Auth to RS256](#rotating-supabase-auth-to-rs256-production-readiness) are set via `supabase secrets set`.
2. Deploy `powersync-remote-token` first without `--no-verify-jwt` so the signer enforces JWT verification immediately.
3. Update `.env.local` (or secrets in production) so the explorer and remote helper use the RS256 tokens issued by the function.
4. Redeploy `powersync-creds`, `powersync-upload`, and `powersync-push` without `--no-verify-jwt`. Run `curl` or the CLI smoke tests (`pnpm seed:stack`) to confirm they accept the RS256-signed tokens.
5. Once all traffic flows, delete any leftover HS256 tokens or secrets to avoid confusion.

## Smoke testing edge functions

Run the bundled smoke script to validate that `verify_jwt` is enforced and the function returns data when authenticated:

```bash
pnpm supabase:smoke -- \
  --url http://127.0.0.1:55431/functions/v1 \
  --auth "$SUPABASE_SERVICE_ROLE_KEY" \
  --require-verify
```

- `--url` should point at your Supabase Functions gateway (local or cloud).
- `--auth` accepts a service role key; without it the script skips the authenticated call.
- Include `--require-verify` once you’ve redeployed without `--no-verify-jwt`; the script fails if the unauthenticated request doesn’t return `401`/`403`.
- Use `--payload` or `--function` to target other functions if needed, e.g. `--function powersync-upload --payload '{"operations":[]}'`.

The script logs the exact responses so you can paste them into incident reports or CI artifacts.

## Local Development

1. Apply the latest migrations (including `supabase/migrations/20241007090000_powersync_git_tables.sql`) with `supabase db push`. This runs against the local stack if it’s already up, or your linked Supabase project otherwise.
2. Run `pnpm dev:stack` to start the local Supabase stack (requires Supabase CLI in PATH). Ports are overridden in `supabase/config.toml` to avoid conflicts.
3. Deploy the edge functions from `supabase/functions/*` to the local emulator (already wired into `pnpm dev:stack` once linked).
4. Export local env overrides (see `docs/env.local.example`) so both the explorer and remote helper hit the Supabase emulator + PowerSync container.
  - Copy the example: `cp docs/env.local.example .env.local` and tweak tokens/endpoints as needed.
5. Seed the demo repository so the explorer has commits and refs to render: `pnpm seed:stack`. This expects the `POWERSYNC_SEED_REMOTE_URL`/`PSGIT_TEST_REMOTE_URL` vars that `pnpm dev:stack` exports; re-run the stack script (or source the `.env.powersync-stack` it emits) before seeding.
6. Cache CLI credentials once: `pnpm --filter @pkg/cli login`.
7. Start the explorer: `pnpm dev` or `pnpm --filter @app/explorer test:e2e`.
8. When finished, run `supabase stop` to tear down the containers.
9. The connector now retrieves credentials via Supabase and pushes optimistic updates through the `powersync-upload` function.

  ### Generating migrations from `schema.sql`

  When you update `supabase/schema.sql`, run `pnpm schema:migrate` from the repo root. This copies the schema into a timestamped file under `supabase/migrations/` and immediately executes `supabase db push` so your local stack stays in sync. Pass an optional slug to customize the filename: `pnpm schema:migrate -- init`.

## Rotating Supabase Auth to RS256 (Production Readiness)

1. **Switch the algorithm in Supabase.** In the Supabase dashboard, open *Authentication → Settings → JWT* and change the signing algorithm to **RS256**. Download the new private key bundle immediately—this is the only chance to export it.
2. **Record key metadata.** Note the generated key ID (`kid`) and audience values from the dashboard or the JWKS endpoint (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`). You will reuse them when minting service tokens.
3. **Store secrets for edge functions.** Use Supabase CLI or the dashboard to add:
   ```bash
   supabase secrets set \
     POWERSYNC_REMOTE_TOKEN_PRIVATE_KEY="$(cat private-key.pem)" \
     POWERSYNC_REMOTE_TOKEN_KEY_ID="powersync-rs-key" \
     POWERSYNC_REMOTE_TOKEN_AUDIENCE="authenticated" \
     POWERSYNC_REMOTE_TOKEN_ISSUER="powersync-prod" \
     POWERSYNC_REMOTE_TOKEN_SUBJECT="powersync-remote-helper" \
     POWERSYNC_REMOTE_TOKEN_ROLE="service_role"
   ```
   Adjust the values (especially `kid`, issuer, and audience) to match your project conventions.
4. **Deploy the updated signer.** Redeploy `supabase/functions/powersync-remote-token` so it reads the new secrets and starts issuing RS256 tokens.
5. **Restart PowerSync with the Supabase config.** The repository now mounts `supabase/powersync/config.yaml` by default, which expects Supabase’s JWKS. Restart the container or redeploy the service so it reloads the config.
6. **Validate the flow.** Use the remote helper to request a token (`powersync-remote-token`) and verify it against the Supabase JWKS. Once confirmed, re-enable `verify_jwt` for the edge functions (this repo ships with it enabled for `powersync-remote`).
