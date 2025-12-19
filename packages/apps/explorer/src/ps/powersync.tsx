
import * as React from 'react'
import { PowerSyncDatabase, SyncClientImplementation } from '@powersync/web'
import { PowerSyncContext } from '@powersync/react'
import { AppSchema } from './schema'
import { Connector } from './connector'
import { initTestFixtureBridge } from './test-fixture-bridge'
import { useSupabaseAuth } from './auth-context'
import {
  completeDaemonDeviceLogin,
  extractDeviceChallenge,
  fetchDaemonAuthStatus,
  isDaemonPreferred,
  obtainPowerSyncToken,
  type DaemonAuthStatus,
} from './daemon-client'
import { getAccessToken } from './supabase'
import { useAppNotices } from '../ui/notices'
import { useStatusRegistry } from '../ui/status-provider'

declare global {
  interface Window {
    __powersyncForceEnable?: boolean
    __powersyncForceDisable?: boolean
  }
}

function resolvePowerSyncDisabled(): boolean {
  const envDisabled = import.meta.env.VITE_POWERSYNC_DISABLED === 'true'
  const globalValue =
    typeof globalThis === 'object' && globalThis
      ? (globalThis as typeof globalThis & { __powersyncForceEnable?: unknown; __powersyncForceDisable?: unknown })
      : null
  if (globalValue) {
    if (globalValue.__powersyncForceEnable === true) {
      return false
    }
    if (globalValue.__powersyncForceDisable === true) {
      return true
    }
  }
  return envDisabled
}

const isPowerSyncDisabled = resolvePowerSyncDisabled()

const PLACEHOLDER_VALUES = new Set([
  'dev-token-placeholder',
  'anon-placeholder',
  'service-role-placeholder',
  'powersync-remote-placeholder',
])

function isPlaceholder(value: string | undefined | null): boolean {
  if (!value) return true
  const trimmed = value.trim()
  if (!trimmed) return true
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return true
  if (/^https?:\/\/localhost(?::\d+)?\/?$/i.test(trimmed) && trimmed.includes('8090')) return true
  return false
}

function readEnvString(name: string): string | null {
  const env = import.meta.env as Record<string, string | undefined>
  const value = env[name]
  if (isPlaceholder(value)) return null
  return value!.trim()
}

let pendingPowerSyncClose: Promise<unknown> | null = null

async function waitForPendingPowerSyncClose(timeoutMs = 10_000): Promise<void> {
  if (!pendingPowerSyncClose) return
  const pending = pendingPowerSyncClose
  try {
    const result = await Promise.race([
      pending.then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
    if (result === 'timeout') {
      if (import.meta.env.DEV) {
        console.debug('[PowerSync] pending close timed out; continuing without waiting')
      }
      if (pendingPowerSyncClose === pending) {
        pendingPowerSyncClose = null
      }
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.debug('[PowerSync] pending close rejected', error)
    }
    if (pendingPowerSyncClose === pending) {
      pendingPowerSyncClose = null
    }
  }
}

function isSchemaMismatchError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  if (!message) return false
  const normalized = message.toLowerCase()
  return normalized.includes('powersync_drop_view') || normalized.includes('powersync_replace_schema')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage))
    }, timeoutMs)
  })

  try {
    return (await Promise.race([promise, timeout])) as T
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

export interface DaemonAuthSnapshot {
  enabled: boolean
  status: DaemonAuthStatus | null
}

const DaemonAuthContext = React.createContext<DaemonAuthSnapshot>({ enabled: false, status: null })

export function useDaemonAuthSnapshot(): DaemonAuthSnapshot {
  return React.useContext(DaemonAuthContext)
}

export function createPowerSync() {
  const supportsWorker = typeof Worker !== 'undefined'
  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: 'repo-explorer.db',
    },
    flags: {
      disableSSRWarning: true,
      ...(supportsWorker ? {} : { useWebWorker: false }),
    },
  })
  if (import.meta.env.DEV) {
    const originalClose = db.close.bind(db)
    db.close = async (...args) => {
      console.debug('[PowerSync] PowerSyncDatabase.close invoked', new Error().stack)
      return originalClose(...args)
    }
  }
  return db
}

export const PowerSyncProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const powerSync = React.useMemo(() => createPowerSync(), [])
  const { status, session } = useSupabaseAuth()
  const accessToken = session?.access_token ?? null
  const preferDaemon = isDaemonPreferred()
  const { showNotice, dismissNoticeByKey } = useAppNotices()
  const { publishStatus, dismissStatus } = useStatusRegistry()
  const [daemonStatus, setDaemonStatus] = React.useState<DaemonAuthStatus | null>(null)
  const [daemonReady, setDaemonReady] = React.useState(false)
  const closeDatabase = React.useCallback(() => {
    if (import.meta.env.DEV) {
      console.debug('[PowerSync] closeDatabase invoked')
    }
    const closePromise = powerSync.close().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('closed')) return
      console.warn('[PowerSync] failed to close database', error)
    })
    pendingPowerSyncClose = closePromise.finally(() => {
      if (pendingPowerSyncClose === closePromise) {
        pendingPowerSyncClose = null
      }
    })
    return closePromise
  }, [powerSync])

  const pendingCloseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const CLOSE_DEBOUNCE_MS = 3000

  React.useEffect(() => {
    if (pendingCloseTimerRef.current) {
      clearTimeout(pendingCloseTimerRef.current)
      pendingCloseTimerRef.current = null
    }
    return () => {
      if (pendingCloseTimerRef.current) {
        clearTimeout(pendingCloseTimerRef.current)
      }
      pendingCloseTimerRef.current = setTimeout(() => {
        pendingCloseTimerRef.current = null
        void closeDatabase()
      }, CLOSE_DEBOUNCE_MS)
    }
  }, [closeDatabase])

  React.useEffect(() => {
    if (!preferDaemon) {
      setDaemonStatus(null)
      setDaemonReady(false)
      return
    }
    if (isPowerSyncDisabled) return

    let disposed = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      if (disposed) return
      const status = await fetchDaemonAuthStatus()
      const nextReady = status?.status === 'ready'
      if (!disposed) {
        setDaemonStatus(status)
        setDaemonReady((prev) => (prev === nextReady ? prev : nextReady))
      }
      const delay = nextReady ? 10_000 : 3_000
      timeoutId = setTimeout(() => {
        void poll()
      }, delay)
    }

    void poll()

    return () => {
      disposed = true
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [preferDaemon])

  React.useEffect(() => {
    if (!preferDaemon) {
      dismissNoticeByKey('daemon-status')
      dismissStatus('daemon-auth')
      return
    }

    const status = daemonStatus
    if (!status) {
      const message = (
        <div className="space-y-1">
          <p>The explorer could not reach the local PowerSync daemon. Start it to enable Git sync features.</p>
          <p className="text-xs text-slate-600">
            Try running <code>pnpm --filter @app/explorer dev</code> or <code>pnpm --filter @powersync-community/powergit-daemon start</code>.
          </p>
        </div>
      )
      showNotice({
        key: 'daemon-status',
        variant: 'error',
        title: 'PowerSync daemon unavailable',
        message,
        dismissible: true,
      })
      publishStatus({
        key: 'daemon-auth',
        tone: 'error',
        message,
        order: 10,
      })
      return
    }

    if (status.status === 'ready') {
      dismissNoticeByKey('daemon-status')
      dismissStatus('daemon-auth')
      return
    }

    if (status.status === 'pending') {
      const challenge = extractDeviceChallenge(status)
      const message = (
        <div className="space-y-1">
          <div>{status.reason ?? 'Waiting for daemon authentication to complete…'}</div>
          {challenge ? (
            <div className="text-xs text-slate-600">
              Device code: <code>{challenge.challengeId}</code>
              {challenge.verificationUrl ? (
                <>
                  {' '}
                  ·{' '}
                  <a href={challenge.verificationUrl} target="_blank" rel="noreferrer" className="underline">
                    Open verification URL
                  </a>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )
      showNotice({
        key: 'daemon-status',
        variant: 'warning',
        title: 'PowerSync daemon waiting for login',
        message,
        dismissible: true,
      })
      publishStatus({
        key: 'daemon-auth',
        tone: 'warning',
        message,
        order: 10,
      })
      return
    }

    if (status.status === 'auth_required') {
      const message = (
        <div className="space-y-1">
          <div>{status.reason ?? 'Run `powergit login --guest` to proceed.'}</div>
        </div>
      )
      showNotice({
        key: 'daemon-status',
        variant: 'warning',
        title: 'PowerSync daemon requires authentication',
        message,
        dismissible: true,
      })
      publishStatus({
        key: 'daemon-auth',
        tone: 'error',
        message,
        order: 10,
      })
      return
    }

    if (status.status === 'error') {
      const message = status.reason ?? 'The daemon reported an error while fetching credentials.'
      showNotice({
        key: 'daemon-status',
        variant: 'error',
        title: 'PowerSync daemon error',
        message,
        dismissible: true,
      })
      publishStatus({
        key: 'daemon-auth',
        tone: 'error',
        message,
        order: 10,
      })
      return
    }

    dismissStatus('daemon-auth')
  }, [
    daemonStatus,
    dismissNoticeByKey,
    dismissStatus,
    preferDaemon,
    publishStatus,
    showNotice,
  ])

  React.useEffect(() => {
    if (isPowerSyncDisabled) return
    if (status === 'error') return
    if (status !== 'authenticated') return
    if (!preferDaemon && !accessToken) return
    if (preferDaemon && !daemonReady) return

    let disposed = false
    const connector = new Connector({
      getToken: async () => {
        const token = await obtainPowerSyncToken()
        if (!token) {
          if (preferDaemon) {
            throw new Error('PowerSync token unavailable from daemon. Ensure the daemon is running and authenticated.')
          }
          throw new Error('PowerSync token unavailable. Check Supabase session or configure VITE_POWERSYNC_TOKEN.')
        }
        return token
      },
    })

    const INIT_TIMEOUT_MS = 20_000
    const CONNECT_TIMEOUT_MS = 30_000

    const connectOnce = async (attempt: number): Promise<void> => {
      if (import.meta.env.DEV) {
        console.debug('[PowerSyncProvider] connecting', {
          preferDaemon,
          daemonReady,
          hasAccessToken: !!accessToken,
          attempt,
        })
      }

      await waitForPendingPowerSyncClose()
      await withTimeout(powerSync.init(), INIT_TIMEOUT_MS, 'PowerSync init timed out.')
      await withTimeout(
        powerSync.connect(connector, { clientImplementation: SyncClientImplementation.RUST }),
        CONNECT_TIMEOUT_MS,
        'PowerSync connect timed out.',
      )

      if (import.meta.env.DEV) {
        const options = powerSync.connectionOptions
        console.debug('[PowerSyncProvider] connect resolved', {
          status: powerSync.currentStatus.toJSON(),
          connectionOptions: options ?? null,
        })
      }
    }

    const ensureConnected = async (): Promise<void> => {
      let attempt = 0
      while (!disposed) {
        const currentStatus = powerSync.currentStatus.toJSON()
        if (currentStatus.connected) {
          attempt = 0
          await delay(5_000)
          continue
        }
        if (currentStatus.connecting) {
          await delay(500)
          continue
        }

        attempt += 1
        try {
          await connectOnce(attempt)
          attempt = 0
          continue
        } catch (error) {
          if (disposed) return

          if (attempt === 1 && isSchemaMismatchError(error)) {
            console.warn('[PowerSync] schema mismatch detected; clearing local cache and retrying')
            const disconnectAndClear = (powerSync as unknown as {
              disconnectAndClear?: (options: { clearLocal?: boolean }) => Promise<void>
            }).disconnectAndClear
            if (typeof disconnectAndClear === 'function') {
              try {
                await disconnectAndClear.call(powerSync, { clearLocal: true })
              } catch (clearError) {
                console.error('[PowerSync] failed to clear local database after schema mismatch', clearError)
              }
            } else {
              try {
                await powerSync.close({ disconnect: true })
              } catch (closeError) {
                console.error('[PowerSync] failed to close database after schema mismatch', closeError)
              }
            }

            attempt = 0
            await delay(250)
            continue
          }

          console.error('[PowerSync] failed to connect', error)

          const baseDelayMs = 500 * 2 ** Math.min(attempt - 1, 6)
          const delayMs = Math.min(30_000, baseDelayMs)
          await delay(delayMs)
        }
      }
    }

    void ensureConnected()

    return () => {
      disposed = true
    }
  }, [powerSync, status, accessToken, preferDaemon, daemonReady])

  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __powersyncDb?: PowerSyncDatabase }).__powersyncDb = powerSync
    return () => {
      delete (window as unknown as { __powersyncDb?: PowerSyncDatabase }).__powersyncDb
    }
  }, [powerSync])

  React.useEffect(() => {
    if (import.meta.env.DEV) {
      console.debug('[PowerSyncProvider] initializing test fixture bridge')
    }
    initTestFixtureBridge()
  }, [])

  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    const dispose = powerSync.registerListener({
      statusChanged: (status) => {
        try {
          console.debug('[PowerSync][status]', status.toJSON())
        } catch {
          console.debug('[PowerSync][status]', status)
        }
      },
    })
    return () => {
      dispose?.()
    }
  }, [powerSync])

  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    const logger = powerSync.logger as unknown as {
      [key: string]: ((...args: unknown[]) => void) | undefined
    }
    if (!logger) return
    const methods: Array<keyof typeof logger> = ['trace', 'debug', 'info', 'warn', 'error']
    const restore: Array<() => void> = []
    for (const method of methods) {
      const original = typeof logger[method] === 'function' ? (logger[method] as (...args: unknown[]) => void) : null
      if (!original) continue
      logger[method] = (...args: unknown[]) => {
        console.debug(`[PowerSync][sdk][${String(method)}]`, ...args)
        if (method === 'error') {
          args.forEach((arg, index) => {
            console.debug('[PowerSync][sdk][error-arg]', index, arg)
            const errors = (arg as { errors?: unknown }).errors
            if (Array.isArray(errors) && errors.length > 0) {
              console.debug('[PowerSync][sdk][aggregate]', index, errors)
            }
            const cause = (arg as { cause?: unknown }).cause
            if (cause) {
              console.debug('[PowerSync][sdk][cause]', index, cause)
            }
          })
        }
        original.apply(logger, args as [])
      }
      restore.push(() => {
        logger[method] = original
      })
    }
    return () => {
      restore.forEach((fn) => fn())
    }
  }, [powerSync])

  const daemonSnapshot = React.useMemo<DaemonAuthSnapshot>(
    () => ({ enabled: preferDaemon, status: daemonStatus }),
    [preferDaemon, daemonStatus],
  )

  const pendingDeviceRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!preferDaemon) {
      pendingDeviceRef.current = null
      return
    }
    const challenge = extractDeviceChallenge(daemonStatus)
    if (!challenge) {
      pendingDeviceRef.current = null
      return
    }
    if (pendingDeviceRef.current === challenge.challengeId) {
      return
    }
    pendingDeviceRef.current = challenge.challengeId

    let cancelled = false
    const complete = async () => {
      const token = await getAccessToken()
      if (!token) {
        pendingDeviceRef.current = null
        return
      }
      const endpoint = readEnvString('VITE_POWERSYNC_ENDPOINT')
      const ok = await completeDaemonDeviceLogin({
        challengeId: challenge.challengeId,
        token,
        endpoint,
        expiresAt: challenge.expiresAt ?? null,
      })
      if (!ok && !cancelled) {
        pendingDeviceRef.current = null
      }
    }

    void complete()

    return () => {
      cancelled = true
    }
  }, [preferDaemon, daemonStatus, session?.access_token])

  return (
    <DaemonAuthContext.Provider value={daemonSnapshot}>
      <PowerSyncContext.Provider value={powerSync}>{children}</PowerSyncContext.Provider>
    </DaemonAuthContext.Provider>
  )
}
