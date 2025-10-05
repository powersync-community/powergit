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

## Local Development

1. Run `supabase start` to spin up the local stack.
2. Deploy the edge functions from `supabase/functions/*` to the local emulator.
3. Copy `.env.example` → `.env` and fill in the Supabase URLs/keys that the CLI prints when it boots.
4. Start the explorer: `pnpm dev`.
5. The connector now retrieves credentials via Supabase and pushes optimistic updates through the `powersync-upload` function.
