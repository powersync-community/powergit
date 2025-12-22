/**
 * Canonical profile defaults shared across the CLI and helper tooling.
 * Keep secrets (e.g. Supabase service role keys) out of source control.
 *
 * Notes:
 * - Supabase project URLs and anon keys are typically public (used in client apps).
 * - PowerSync tokens, Supabase service role keys, and user credentials are secrets.
 */

export const PROFILE_DEFAULTS = {
  'local-dev': {
    powersync: {
      url: 'http://127.0.0.1:55440',
    },
    daemon: {
      endpoint: 'http://127.0.0.1:5030',
      deviceLoginUrl: 'http://127.0.0.1:5030/ui/auth',
    },
    supabase: {
      url: 'http://127.0.0.1:55431',
    },
  },
  prod: {
    powersync: {
      url: 'https://69330b17af0dc7f75977d41a.powersync.journeyapps.com',
    },
    daemon: {
      deviceLoginUrl: 'http://127.0.0.1:5030/ui/auth',
    },
    supabase: {
      url: 'https://swycjfithtzfzwwekmnq.supabase.co',
      anonKey:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN3eWNqZml0aHR6Znp3d2VrbW5xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ4ODY1OTIsImV4cCI6MjA4MDQ2MjU5Mn0.XDfUuXI_DLGQnANxxw4slv0-9PrvZzT72ZaxBMuxA9U',
    },
  },
}

export function cloneProfileDefaults() {
  if (typeof structuredClone === 'function') {
    return structuredClone(PROFILE_DEFAULTS)
  }
  return JSON.parse(JSON.stringify(PROFILE_DEFAULTS))
}
