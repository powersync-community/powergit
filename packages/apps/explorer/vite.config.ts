import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadProfileEnvironment } from '../../cli/src/profile-env.js'
import { PROFILE_DEFAULTS } from '../../cli/src/profile-defaults-data.js'

const resolveFromRoot = (p: string) => path.resolve(fileURLToPath(new URL('.', import.meta.url)), p)
const bufferPolyfillPath = resolveFromRoot(
  '../../../node_modules/.pnpm/buffer@5.7.1/node_modules/buffer/index.js',
)

const repoRoot = resolveFromRoot('../../..')

const STACK_ENV_FALLBACKS: Record<string, string[]> = {
  VITE_SUPABASE_URL: ['PSGIT_TEST_SUPABASE_URL'],
  VITE_SUPABASE_ANON_KEY: ['PSGIT_TEST_SUPABASE_ANON_KEY'],
  VITE_SUPABASE_SCHEMA: [],
  VITE_POWERSYNC_ENDPOINT: ['POWERSYNC_URL', 'PSGIT_TEST_ENDPOINT'],
  VITE_POWERSYNC_DAEMON_URL: ['POWERSYNC_DAEMON_URL', 'PSGIT_TEST_DAEMON_URL'],
  VITE_POWERSYNC_USE_DAEMON: ['POWERSYNC_USE_DAEMON'],
  POWERSYNC_DAEMON_DEVICE_URL: ['POWERSYNC_DAEMON_DEVICE_URL'],
}

const profileEnv = loadProfileEnvironment({
  startDir: repoRoot,
  updateState: false,
})
const combinedEnv = profileEnv.combinedEnv
const profileName = profileEnv.profile?.name ?? 'local-dev'
const profileConfig = profileEnv.profile?.config ?? {}
const defaultProfileConfig =
  (PROFILE_DEFAULTS && typeof PROFILE_DEFAULTS === 'object' ? PROFILE_DEFAULTS[profileName] : null) ??
  (PROFILE_DEFAULTS && typeof PROFILE_DEFAULTS === 'object' ? PROFILE_DEFAULTS['local-dev'] : null) ??
  {}

const PROFILE_TO_VITE_TARGETS: Record<string, string[]> = {
  VITE_SUPABASE_URL: ['supabase.url'],
  VITE_SUPABASE_ANON_KEY: ['supabase.anonKey'],
  VITE_SUPABASE_SCHEMA: ['supabase.schema'],
  VITE_POWERSYNC_ENDPOINT: ['powersync.url'],
  VITE_POWERSYNC_DAEMON_URL: ['daemon.endpoint', 'powersync.daemonUrl'],
  POWERSYNC_DAEMON_DEVICE_URL: [
    'daemon.deviceLoginUrl',
    'daemon.deviceUrl',
    'powersync.deviceLoginUrl',
    'powersync.deviceUrl',
  ],
}

const PLACEHOLDER_PATTERNS: Array<(value: string) => boolean> = [
  (value) => value.trim().length === 0,
  (value) => value.trim().toLowerCase() === 'dev-token-placeholder',
  (value) => value.trim().toLowerCase() === 'anon-placeholder',
  (value) => value.trim().toLowerCase() === 'service-role-placeholder',
  (value) => value.trim().toLowerCase() === 'powersync-remote-placeholder',
  (value) =>
    /^https?:\/\/localhost(?::\d+)?\/?$/.test(value.trim().toLowerCase()) && value.includes('8090'),
]

const isPlaceholder = (rawValue: string | undefined | null): boolean => {
  if (typeof rawValue !== 'string') return true
  const value = rawValue.trim()
  if (!value) return true
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern(value))
}

const valueFromCombined = (key: string): string | undefined => {
  const value = combinedEnv[key]
  if (typeof value === 'string' && !isPlaceholder(value)) {
    return value.trim()
  }
  return undefined
}

const valueFromProfileConfig = (path: string): string | undefined => {
  const segments = path.split('.')
  const lookup = (source: unknown): string | undefined => {
    let cursor: unknown = source
    for (const segment of segments) {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
        return undefined
      }
      cursor = (cursor as Record<string, unknown>)[segment]
    }
    if (typeof cursor === 'string' && cursor.trim().length > 0) {
      return cursor.trim()
    }
    return undefined
  }
  return lookup(profileConfig) ?? lookup(defaultProfileConfig)
}

function resolveEnvValue(key: string, fallbacks: string[], defaults: Record<string, string>): string | undefined {
  const direct = process.env[key]
  if (typeof direct === 'string' && !isPlaceholder(direct)) {
    return direct.trim()
  }

  const profileValue = valueFromCombined(key)
  if (profileValue) {
    return profileValue
  }

  for (const fallback of fallbacks) {
    const fallbackDirect = process.env[fallback]
    if (typeof fallbackDirect === 'string' && !isPlaceholder(fallbackDirect)) {
      return fallbackDirect.trim()
    }
    const fallbackProfile = valueFromCombined(fallback)
    if (fallbackProfile) {
      return fallbackProfile
    }
  }

  return defaults[key]
}

function applyProfileEnv() {
  const defaults: Record<string, string> = {
    VITE_SUPABASE_URL: 'http://127.0.0.1:55431',
    VITE_SUPABASE_ANON_KEY:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    VITE_SUPABASE_SCHEMA: 'public',
    VITE_POWERSYNC_ENDPOINT: 'http://127.0.0.1:55440',
    VITE_POWERSYNC_DAEMON_URL: 'http://127.0.0.1:5030',
    VITE_POWERSYNC_USE_DAEMON: 'true',
    POWERSYNC_DAEMON_DEVICE_URL: 'http://localhost:5783/auth',
  }

  for (const [key, value] of Object.entries(combinedEnv)) {
    const current = process.env[key]
    if (typeof current !== 'string' || isPlaceholder(current)) {
      process.env[key] = value
    }
  }

  for (const [target, paths] of Object.entries(PROFILE_TO_VITE_TARGETS)) {
    const current = process.env[target]
    if (typeof current === 'string' && !isPlaceholder(current)) {
      continue
    }
    for (const path of paths) {
      const profileValue = valueFromProfileConfig(path)
      if (profileValue) {
        process.env[target] = profileValue
        break
      }
    }
  }

  for (const [target, fallbacks] of Object.entries(STACK_ENV_FALLBACKS)) {
    const resolved = resolveEnvValue(target, fallbacks, defaults)
    if (resolved) {
      process.env[target] = resolved
    }
  }

  if (!process.env.VITE_PORT) {
    process.env.VITE_PORT = '5783'
  }
}

applyProfileEnv()

const repoBase = (() => {
  if (process.env.GITHUB_PAGES?.toLowerCase() === 'true') {
    const repo = process.env.GITHUB_REPOSITORY?.split('/')?.[1]
    if (repo) {
      return `/${repo}/`
    }
  }
  if (process.env.VITE_BASE_PATH) {
    const base = process.env.VITE_BASE_PATH.trim()
    if (base) return base.endsWith('/') ? base : `${base}/`
  }
  return '/'
})()

const devServerPort = (() => {
  const candidate = process.env.VITE_PORT ?? process.env.PORT ?? '5783'
  const parsed = Number.parseInt(candidate, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5783
})()

const ghPagesSpaFallback = () => {
  let outDir = 'dist'
  return {
    name: 'powergit-gh-pages-spa-fallback',
    apply: 'build' as const,
    configResolved(config: { build: { outDir: string } }) {
      outDir = config.build.outDir
    },
    async closeBundle() {
      if (process.env.GITHUB_PAGES?.toLowerCase() !== 'true') return
      const indexPath = path.resolve(outDir, 'index.html')
      const notFoundPath = path.resolve(outDir, '404.html')
      const html = await fs.readFile(indexPath)
      await fs.writeFile(notFoundPath, html)
    },
  }
}

export default defineConfig({
  base: repoBase,
  plugins: [wasm(), topLevelAwait(), react(), ghPagesSpaFallback()],
  define: { 'process.env': {} },
  envPrefix: ['VITE_', 'POWERSYNC_', 'PSGIT_'],
  resolve: {
    alias: {
      '@ps': resolveFromRoot('src/ps'),
      '@tsdb': resolveFromRoot('src/tsdb'),
      '@shared/core/powersync/schema': resolveFromRoot('../../shared/src/powersync/schema.ts'),
      '@shared/core/powersync/streams': resolveFromRoot('../../shared/src/powersync/streams.ts'),
      '@shared/core/': `${resolveFromRoot('../../shared/src')}/`,
      '@shared/core': resolveFromRoot('../../shared/src/index.ts'),
      buffer: bufferPolyfillPath,
    },
  },
  optimizeDeps: {
    include: ['buffer'],
    exclude: ['@journeyapps/wa-sqlite', '@powersync/web'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  server: {
    port: devServerPort,
    strictPort: true,
    host: '127.0.0.1',
    fs: {
      allow: [resolveFromRoot('../../..')],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
})
