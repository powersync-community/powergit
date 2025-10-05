import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const resolveFromRoot = (p: string) => path.resolve(fileURLToPath(new URL('.', import.meta.url)), p)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@tanstack/powersync-db-collection': resolveFromRoot('node_modules/@tanstack/powersync-db-collection/packages/powersync-db-collection/src'),
    },
  },
})
