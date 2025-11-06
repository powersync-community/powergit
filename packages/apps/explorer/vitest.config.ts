import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadProfileEnvironment } from '../../cli/src/profile-env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const resolveFromRoot = (relativePath: string) => resolve(__dirname, relativePath)
const bufferPolyfillPath = resolveFromRoot('../../../node_modules/.pnpm/buffer@5.7.1/node_modules/buffer/index.js')

const repoRoot = resolve(__dirname, '..', '..', '..')
const profileEnv = loadProfileEnvironment({ startDir: repoRoot, updateState: false })

for (const [key, value] of Object.entries(profileEnv.combinedEnv)) {
  if (typeof process.env[key] !== 'string' || process.env[key]?.trim().length === 0) {
    process.env[key] = value
  }
}

export default defineConfig({
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
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    setupFiles: [],
    coverage: {
      provider: 'istanbul',
    },
  },
})
