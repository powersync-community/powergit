import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDaemonServer } from '../server.js'

async function listenServer(
  options: Parameters<typeof createDaemonServer>[0],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createDaemonServer(options)
  const address = await server.listen()
  const host = address.address === '::' ? '127.0.0.1' : address.address
  const baseUrl = `http://${host}:${address.port}`
  return {
    baseUrl,
    close: () => server.close(),
  }
}

describe('createDaemonServer UI routes', () => {
  const originalUiDir = process.env.POWERSYNC_DAEMON_UI_DIR
  const originalSupabaseUrl = process.env.SUPABASE_URL
  const originalSupabaseAnonKey = process.env.SUPABASE_ANON_KEY

  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'powergit-daemon-ui-'))
    mkdirSync(join(tempDir, 'assets'), { recursive: true })
    writeFileSync(join(tempDir, 'index.html'), '<!doctype html><html><body>ui-ok</body></html>')
    writeFileSync(join(tempDir, 'assets', 'app.js'), 'console.log("asset-ok")')
    process.env.POWERSYNC_DAEMON_UI_DIR = tempDir
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
  })

  afterEach(() => {
    if (originalUiDir !== undefined) process.env.POWERSYNC_DAEMON_UI_DIR = originalUiDir
    else delete process.env.POWERSYNC_DAEMON_UI_DIR
    if (originalSupabaseUrl !== undefined) process.env.SUPABASE_URL = originalSupabaseUrl
    else delete process.env.SUPABASE_URL
    if (originalSupabaseAnonKey !== undefined) process.env.SUPABASE_ANON_KEY = originalSupabaseAnonKey
    else delete process.env.SUPABASE_ANON_KEY
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('serves the bundled explorer UI under /ui/', async () => {
    const { baseUrl, close } = await listenServer({
      host: '127.0.0.1',
      port: 0,
      getStatus: () => ({
        startedAt: new Date().toISOString(),
        connected: true,
        streamCount: 0,
      }),
    })

    try {
      const redirectRes = await fetch(`${baseUrl}/ui?x=1`, { redirect: 'manual' })
      expect(redirectRes.status).toBe(302)
      expect(redirectRes.headers.get('location')).toBe('/ui/?x=1')

      const indexRes = await fetch(`${baseUrl}/ui/`)
      expect(indexRes.status).toBe(200)
      expect(indexRes.headers.get('content-type')).toContain('text/html')
      expect(await indexRes.text()).toContain('ui-ok')

      const routeRes = await fetch(`${baseUrl}/ui/auth`)
      expect(routeRes.status).toBe(200)
      expect(routeRes.headers.get('content-type')).toContain('text/html')

      const assetRes = await fetch(`${baseUrl}/ui/assets/app.js`)
      expect(assetRes.status).toBe(200)
      expect(assetRes.headers.get('content-type')).toContain('application/javascript')
      expect(await assetRes.text()).toContain('asset-ok')

      const runtimeRes = await fetch(`${baseUrl}/ui/runtime-config.js`)
      expect(runtimeRes.status).toBe(200)
      expect(runtimeRes.headers.get('content-type')).toContain('application/javascript')
      const runtimeBody = await runtimeRes.text()
      expect(runtimeBody).toContain('__POWERGIT_RUNTIME_CONFIG__')
      expect(runtimeBody).toContain('https://example.supabase.co')

      const missingAsset = await fetch(`${baseUrl}/ui/missing.js`)
      expect(missingAsset.status).toBe(404)
    } finally {
      await close()
    }
  })
})

