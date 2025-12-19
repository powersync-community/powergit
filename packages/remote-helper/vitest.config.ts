import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

function sharedSrc(path: string) {
  return resolve(here, '..', 'shared', 'src', path)
}

export default defineConfig({
  resolve: {
    alias: [
      { find: '@powersync-community/powergit-core/node', replacement: sharedSrc('node.ts') },
      { find: '@powersync-community/powergit-core', replacement: sharedSrc('index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
    },
  },
})
