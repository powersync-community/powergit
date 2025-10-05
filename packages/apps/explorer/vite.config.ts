import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const resolveFromRoot = (p: string) => path.resolve(fileURLToPath(new URL('.', import.meta.url)), p)

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

export default defineConfig({
  base: repoBase,
  plugins: [wasm(), topLevelAwait(), react()],
  define: { 'process.env': {} },
  resolve: {
    alias: {
      '@ps': resolveFromRoot('src/ps'),
      '@tsdb': resolveFromRoot('src/tsdb'),
      // Mock PowerSync for build to avoid IIFE format conflicts
      '@powersync/web': resolveFromRoot('src/mocks/powersync-web'),
      '@powersync/react': resolveFromRoot('src/mocks/powersync-react'),
    },
  },
  optimizeDeps: {
    exclude: ['@journeyapps/wa-sqlite', '@powersync/web'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  server: {
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
