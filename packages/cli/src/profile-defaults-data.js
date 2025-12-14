/**
 * Canonical profile defaults shared across the CLI and explorer build tools.
 * Keep environment-specific secrets out of source control; update this module
 * before publishing if endpoints or seeded credentials change.
 */

export const PROFILE_DEFAULTS = {
  'local-dev': {
    powersync: {
      url: 'http://127.0.0.1:55440',
    },
    daemon: {
      endpoint: 'http://127.0.0.1:5030',
      deviceLoginUrl: 'http://localhost:5783/auth',
    },
    supabase: {
      url: 'http://127.0.0.1:55431',
    },
  },
  prod: {
    powersync: {
      url: 'https://68f143d248cadbdadc3eef16.powersync.journeyapps.com',
    },
    supabase: {
      url: 'https://mcvxpinhffmvwutgsdua.supabase.co',
      anonKey:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jdnhwaW5oZmZtdnd1dGdzZHVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc3MDgwOTYsImV4cCI6MjA3MzI4NDA5Nn0.GxoIKA3hFmF3Gr86hwHBEoapEh2kCRnRIDMiNoSsX5Q',
    },
  },
}

export function cloneProfileDefaults() {
  if (typeof structuredClone === 'function') {
    return structuredClone(PROFILE_DEFAULTS)
  }
  return JSON.parse(JSON.stringify(PROFILE_DEFAULTS))
}
