# Supabase Edge Functions

These functions back the local PowerSync demo stack. They are deployed automatically when you run `pnpm dev:stack` and can also be pushed manually via `supabase functions deploy`.

## JWT signing

- `powersync-creds` and `powersync-remote-token` require an RSA private key (`POWERSYNC_REMOTE_TOKEN_PRIVATE_KEY`) and always issue RS256 tokens whose `kid` matches Supabase’s JWKS entry.
- Set `POWERSYNC_REMOTE_TOKEN_KEY_ID`, `POWERSYNC_REMOTE_TOKEN_AUDIENCE`, `POWERSYNC_REMOTE_TOKEN_ISSUER`, and related env vars to mirror your Supabase Auth configuration. If any are missing the functions return HTTP 500.
- `powersync-remote` has `verify_jwt = true` so Supabase validates inbound tokens before the handler runs. The other demo functions (`powersync-creds`, `powersync-remote-token`) still disable verification because they accept the Supabase service role key directly; tighten those once you migrate callers to real Supabase auth flows.

## Local usage tips

- To redeploy after making changes run:

  ```bash
  pnpm dev:stack -- --skip-demo-seed --skip-sync-rules
  # or deploy specific functions
  supabase functions deploy powersync-creds powersync-remote-token
  ```

- Logs stream from the `supabase_edge_runtime_*` container. Tail them with:

  ```bash
  docker logs -f supabase_edge_runtime_powersync-git-local
  ```

- The remote helper and CLI call these endpoints via `invokeSupabaseEdgeFunction`, so set `POWERSYNC_SUPABASE_FUNCTIONS_URL` if you host them somewhere other than the default Supabase CLI URL.
