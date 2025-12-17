
import * as React from 'react'
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { usePowerSync, useStatus } from '@powersync/react'
import { signOut } from '@ps/supabase'
import { isDaemonPreferred, notifyDaemonLogout } from '@ps/daemon-client'
import { useSupabaseAuth } from '@ps/auth-context'
import { StatusViewport } from '../ui/status-provider'
import { ThemeProvider, useTheme } from '../ui/theme-context'
import { CiDark, CiLight } from 'react-icons/ci'

export const Route = () => (
  <ThemeProvider>
    <AppShell />
  </ThemeProvider>
)

const AppShell: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { status: authStatus, session } = useSupabaseAuth()
  const powerSync = usePowerSync()
  const status = useStatus()
  const [signingOut, setSigningOut] = React.useState(false)
  const preferDaemon = React.useMemo(() => isDaemonPreferred(), [])
  const { theme, toggleTheme } = useTheme()
  const [storagePersisted, setStoragePersisted] = React.useState<boolean | null>(null)
  const [sqliteConfig, setSqliteConfig] = React.useState<
    | {
        vfs: string | null
        useWebWorker: boolean | null
        multiTabs: boolean | null
      }
    | null
  >()
  const runtimeSupport = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return { opfs: false, idb: false, secure: false, isolated: false }
    }
    const opfs = typeof navigator !== 'undefined' && Boolean(navigator.storage && 'getDirectory' in navigator.storage)
    const idb = typeof indexedDB !== 'undefined'
    const secure = window.isSecureContext
    const isolated = typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false
    return { opfs, idb, secure, isolated }
  }, [])
  const isAuthRoute = React.useMemo(() => {
    const path = location.pathname ?? ''
    return path.startsWith('/auth') || path.startsWith('/reset-password')
  }, [location.pathname])
  const pathname = location.pathname ?? ''

  React.useEffect(() => {
    if (authStatus === 'unauthenticated' && !isAuthRoute && pathname !== '/auth') {
      void navigate({ to: '/auth', replace: true })
    }
  }, [authStatus, isAuthRoute, pathname, navigate])

  React.useEffect(() => {
    if (typeof window === 'undefined') return
    if (!navigator.storage?.persisted) return
    let cancelled = false
    navigator.storage
      .persisted()
      .then((value) => {
        if (!cancelled) setStoragePersisted(value)
      })
      .catch(() => {
        if (!cancelled) setStoragePersisted(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const loadConfig = async () => {
      try {
        await powerSync.waitForReady()
        const adapter = powerSync.database as unknown as {
          getConfiguration?: () => unknown
        }
        const config = typeof adapter.getConfiguration === 'function' ? adapter.getConfiguration() : null
        if (cancelled) return
        if (!config) {
          setSqliteConfig(null)
          return
        }
        const configAny = config as {
          vfs?: unknown
          flags?: { useWebWorker?: unknown; enableMultiTabs?: unknown }
        }
        setSqliteConfig({
          vfs: typeof configAny.vfs === 'string' ? configAny.vfs : null,
          useWebWorker: typeof configAny.flags?.useWebWorker === 'boolean' ? configAny.flags.useWebWorker : null,
          multiTabs: typeof configAny.flags?.enableMultiTabs === 'boolean' ? configAny.flags.enableMultiTabs : null,
        })
      } catch (_error) {
        if (!cancelled) setSqliteConfig(null)
      }
    }

    void loadConfig()

    return () => {
      cancelled = true
    }
  }, [powerSync])

  if (isAuthRoute) {
    return <Outlet />
  }

  const isDark = theme === 'dark'
  const fullScreenBase = `flex min-h-screen items-center justify-center px-4 text-center ${
    isDark ? 'bg-slate-950 text-slate-200' : 'bg-slate-100 text-slate-600'
  }`

  if (authStatus === 'loading') {
    return (
      <div className={fullScreenBase}>
        <span className="text-sm font-medium">Loading session…</span>
      </div>
    )
  }

  if (authStatus === 'error') {
    const cardClasses = isDark
      ? 'max-w-md space-y-3 rounded-2xl border border-red-400/30 bg-red-900/30 px-6 py-8 text-red-100 shadow-lg shadow-red-900/40'
      : 'max-w-md space-y-3 rounded-2xl border border-red-200 bg-white px-6 py-8 text-red-700 shadow'
    return (
      <div className={fullScreenBase}>
        <div className={cardClasses}>
          <h2 className="text-lg font-semibold">Authentication failed</h2>
          <p className="text-sm">Reload the page or try signing in again.</p>
          <button
            type="button"
            className="mt-4 inline-flex items-center justify-center rounded-md bg-red-500 px-3 py-2 text-sm font-medium text-white shadow transition hover:bg-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            onClick={() => {
              void navigate({ to: '/auth' })
            }}
          >
            Go to sign in
          </button>
        </div>
      </div>
    )
  }

  if (authStatus !== 'authenticated') {
    return (
      <div className={fullScreenBase}>
        <span className="text-sm font-medium">Redirecting to sign in…</span>
      </div>
    )
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      if (preferDaemon) {
        const ok = await notifyDaemonLogout().catch((error) => {
          console.warn('[Explorer] failed to notify daemon logout', error)
          return false
        })
        if (!ok) {
          console.warn('[Explorer] daemon logout notification was not acknowledged')
        }
      }
      await signOut()
      void navigate({ to: '/auth' })
    } catch (error) {
      console.error('[Explorer] failed to sign out', error)
    } finally {
      setSigningOut(false)
    }
  }

  const userLabel = session?.user?.email ?? session?.user?.id ?? 'Signed in'
  const shellBackground = isDark ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'
  const headerSubText = isDark ? 'text-slate-400' : 'text-slate-500'
  const userText = isDark ? 'text-slate-400' : 'text-slate-500'
  const chipBase =
    'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
  const chipClass = (() => {
    const persisted = storagePersisted
    if (persisted === true) {
      return isDark
        ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
        : 'border-emerald-500/30 bg-emerald-50 text-emerald-800'
    }
    if (persisted === false) {
      return isDark
        ? 'border-amber-400/40 bg-amber-500/10 text-amber-100'
        : 'border-amber-500/30 bg-amber-50 text-amber-800'
    }
    return isDark
      ? 'border-slate-700 bg-slate-900/70 text-slate-200'
      : 'border-slate-200 bg-white text-slate-700 shadow-sm'
  })()
  const persistedLabel =
    storagePersisted === true ? 'persisted' : storagePersisted === false ? 'best-effort' : 'unknown'
  const backendLabel = (() => {
    if (sqliteConfig === undefined) return 'DB'
    const vfs = sqliteConfig?.vfs
    if (vfs === 'OPFSCoopSyncVFS') return 'OPFS'
    if (vfs === 'AccessHandlePoolVFS') return 'OPFS'
    if (vfs === 'IDBBatchAtomicVFS') return 'IDB'
    if (runtimeSupport.opfs) return 'OPFS'
    if (runtimeSupport.idb) return 'IDB'
    return 'Storage'
  })()
  const webWorkerLabel =
    sqliteConfig?.useWebWorker == null ? 'unknown' : sqliteConfig.useWebWorker ? 'yes' : 'no'
  const multiTabsLabel = sqliteConfig?.multiTabs == null ? 'unknown' : sqliteConfig.multiTabs ? 'yes' : 'no'
  const storageTitle = [
    `Backend: ${backendLabel}`,
    `VFS: ${sqliteConfig?.vfs ?? 'unknown'}`,
    `Persistence: ${persistedLabel}`,
    `Web worker: ${webWorkerLabel}`,
    `Multi-tabs: ${multiTabsLabel}`,
    `Secure context: ${runtimeSupport.secure ? 'yes' : 'no'}`,
    `Cross-origin isolated: ${runtimeSupport.isolated ? 'yes' : 'no'}`,
    `Daemon mode: ${preferDaemon ? 'on' : 'off'}`,
  ].join('\n')
  const signOutClasses = isDark
    ? 'inline-flex items-center rounded-md border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'inline-flex items-center rounded-md border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'

  return (
    <div className={`min-h-screen transition-colors duration-300 ${shellBackground}`}>
      <div className="space-y-6 p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">Powergit</h1>
              <div className={`text-sm ${headerSubText}`}>
                {status.connected ? 'Connected' : status.connecting ? 'Connecting…' : 'Offline'}
                {status.connected || status.connecting ? (!status.hasSynced ? ' · syncing…' : '') : ''}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className={`${chipBase} ${chipClass}`} title={storageTitle} data-testid="storage-status">
                {backendLabel} · {persistedLabel}
              </span>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                data-testid="theme-toggle"
                className={`inline-flex h-10 w-10 items-center justify-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40 ${
                  isDark ? 'border-slate-600 bg-slate-900 text-slate-200 hover:bg-slate-800' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                {theme === 'dark' ? <CiLight className="h-5 w-5" aria-hidden /> : <CiDark className="h-5 w-5" aria-hidden />}
              </button>
              <div className="flex items-center gap-2 text-xs">
                <span className={userText}>{userLabel}</span>
                <button
                  type="button"
                  className={signOutClasses}
                  onClick={() => {
                    void handleSignOut()
                  }}
                  disabled={signingOut}
                >
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </div>
          </header>
          <StatusViewport />
        </div>
        <Outlet />
      </div>
    </div>
  )
}
