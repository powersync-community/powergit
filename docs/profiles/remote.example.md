# Remote profile example

`psgit` manages per-environment settings in `~/.psgit/profiles.json`. The first run seeds two entries:

- `local-dev` pointing at the local Supabase/PowerSync stack.
- `prod` sourced from the bundled defaults in `packages/cli/src/profile-defaults-data.js` (edit that file before publishing to change the baked-in endpoints/keys).

To add additional environments (for example staging), create a remote entry with `psgit profile set` and feed it to any command via `STACK_PROFILE=<profile> …`.

```bash
# Add or update a staging profile
psgit profile set staging \
  --set powersync.url=https://powersync-staging.example.com \
  --set daemon.token=<service-token-or-jwt> \
  --set supabase.url=https://your-project.supabase.co \
  --set supabase.anonKey=<anon-key> \
  --set supabase.serviceRoleKey=<service-role-key>

# Optional extras
psgit profile set staging \
  --set supabase.email=staging-bot@example.com \
  --set supabase.password=<supabase-password>

# Run workspace commands against staging
STACK_PROFILE=staging pnpm --filter @app/explorer dev
pnpm --filter @app/explorer test:e2e:staging
STACK_PROFILE=staging pnpm live:validate

# Build the explorer bundle against production defaults
STACK_PROFILE=prod pnpm --filter @app/explorer build
```

Resulting profile JSON (for reference):

```json
{
  "staging": {
    "powersync": {
      "url": "https://powersync-staging.example.com"
    },
    "daemon": {
      "token": "<service-token-or-jwt>"
    },
    "supabase": {
      "url": "https://your-project.supabase.co",
      "anonKey": "<anon-key>",
      "serviceRoleKey": "<service-role-key>",
      "email": "staging-bot@example.com",
      "password": "<supabase-password>"
    }
  }
}
```
