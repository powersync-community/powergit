
import * as React from 'react'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { usePowerSync, useStatus } from '@powersync/react'
import { signOut } from '@ps/supabase'
import { isDaemonPreferred, notifyDaemonLogout } from '@ps/daemon-client'
import { useSupabaseAuth } from '@ps/auth-context'
import { StatusViewport } from '../ui/status-provider'
import { ThemeProvider, useTheme } from '../ui/theme-context'
import { CiDark, CiLight, CiUser } from 'react-icons/ci'

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
  const [profileMenuOpen, setProfileMenuOpen] = React.useState(false)
  const profileMenuButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const profileMenuRef = React.useRef<HTMLDivElement | null>(null)
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
    if (!profileMenuOpen) return

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (profileMenuButtonRef.current?.contains(target)) return
      if (profileMenuRef.current?.contains(target)) return
      setProfileMenuOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProfileMenuOpen(false)
      }
    }

    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('touchstart', onPointerDown)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('touchstart', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [profileMenuOpen])

  React.useEffect(() => {
    if (authStatus === 'unauthenticated' && !isAuthRoute && pathname !== '/auth') {
      const redirect = `${pathname}${location.search ?? ''}`
      void navigate({ to: '/auth', search: { redirect } as any, replace: true })
    }
  }, [authStatus, isAuthRoute, pathname, location.search, navigate])

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
  const menuPanel = isDark
    ? 'absolute right-0 top-full z-50 mt-2 w-80 origin-top-right rounded-2xl border border-slate-700 bg-slate-900/95 p-2 shadow-xl shadow-slate-950/60 backdrop-blur'
    : 'absolute right-0 top-full z-50 mt-2 w-80 origin-top-right rounded-2xl border border-slate-200 bg-white p-2 shadow-xl shadow-slate-900/10'
  const menuItem = isDark
    ? 'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40 disabled:cursor-not-allowed disabled:opacity-60'
    : 'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60'
  const menuDivider = isDark ? 'my-2 border-slate-700' : 'my-2 border-slate-200'
  const navLinkBase =
    'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2'
  const navLinkClass = ({ active }: { active: boolean }) =>
    `${navLinkBase} ${
      isDark
        ? active
          ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100'
          : 'border-slate-700 bg-slate-900/70 text-slate-200 hover:bg-slate-800'
        : active
          ? 'border-emerald-500/30 bg-emerald-50 text-emerald-800'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 shadow-sm'
    }`

  const connectionLabel = status.connected ? 'Connected' : status.connecting ? 'Connecting…' : 'Offline'
  const syncSuffix = status.connected || status.connecting ? (!status.hasSynced ? ' · syncing…' : '') : ''
  const connectionTitle = `${connectionLabel}${syncSuffix}`
  const connectionDot = status.connected
    ? 'bg-emerald-400'
    : status.connecting
      ? 'bg-amber-400 animate-pulse'
      : isDark
        ? 'bg-rose-400'
        : 'bg-rose-500'

  const trimmedUserLabel = userLabel.trim()
  const profileInitial = trimmedUserLabel.length > 0 ? trimmedUserLabel[0]!.toUpperCase() : null
  const profileButtonClass = `inline-flex h-10 w-10 items-center justify-center rounded-full border text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40 ${
    isDark
      ? 'border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800'
      : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-100 shadow-sm'
  }`

  return (
    <div className={`min-h-screen transition-colors duration-300 ${shellBackground}`}>
      <div className="space-y-6 p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <header className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <h1 className="flex items-center gap-2 text-xl font-bold">
                <span>Powergit</span>
                <span
                  role="img"
                  aria-label={connectionTitle}
                  title={connectionTitle}
                  className={`h-2.5 w-2.5 rounded-full ${connectionDot}`}
                />
              </h1>
              <nav className="flex flex-wrap items-center gap-2">
                <Link to="/" className={navLinkClass({ active: location.pathname === '/' })}>
                  Home
                </Link>
                <Link to="/orgs" className={navLinkClass({ active: location.pathname.startsWith('/orgs') })}>
                  Orgs
                </Link>
              </nav>
            </div>

            <div className="relative flex items-center">
              <button
                ref={profileMenuButtonRef}
                type="button"
                className={profileButtonClass}
                aria-label="Open profile menu"
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                onClick={() => {
                  setProfileMenuOpen((current) => !current)
                }}
                title={userLabel}
              >
                {profileInitial ? profileInitial : <CiUser className="h-5 w-5" aria-hidden />}
              </button>

              {profileMenuOpen ? (
                <div ref={profileMenuRef} className={menuPanel} role="menu">
                  <div className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold ${
                          isDark
                            ? 'border-slate-600 bg-slate-950 text-slate-100'
                            : 'border-slate-200 bg-slate-50 text-slate-800'
                        }`}
                        aria-hidden
                      >
                        {profileInitial ? profileInitial : <CiUser className="h-5 w-5" aria-hidden />}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{userLabel}</div>
                        <div className={`mt-1 flex items-center gap-2 text-xs ${headerSubText}`}>
                          <span className={`h-2 w-2 rounded-full ${connectionDot}`} aria-hidden />
                          <span className="truncate">{connectionTitle}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <hr className={menuDivider} />

                  <div className="px-3 py-2">
                    <div
                      className={
                        isDark
                          ? 'text-xs font-semibold uppercase tracking-wide text-slate-400'
                          : 'text-xs font-semibold uppercase tracking-wide text-slate-500'
                      }
                    >
                      Storage
                    </div>
                    <div className="mt-2">
                      <span className={`${chipBase} ${chipClass}`} title={storageTitle} data-testid="storage-status">
                        {backendLabel} · {persistedLabel}
                      </span>
                    </div>
                  </div>

                  <hr className={menuDivider} />

                  <button
                    type="button"
                    onClick={() => {
                      toggleTheme()
                      setProfileMenuOpen(false)
                    }}
                    aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                    data-testid="theme-toggle"
                    className={menuItem}
                    role="menuitem"
                  >
                    {theme === 'dark' ? <CiLight className="h-5 w-5" aria-hidden /> : <CiDark className="h-5 w-5" aria-hidden />}
                    <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                  </button>

                  <button
                    type="button"
                    className={`${menuItem} ${isDark ? 'text-red-200 hover:bg-red-900/20' : 'text-red-700 hover:bg-red-50'}`}
                    onClick={() => {
                      setProfileMenuOpen(false)
                      void handleSignOut()
                    }}
                    disabled={signingOut}
                    role="menuitem"
                  >
                    <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
                  </button>
                </div>
              ) : null}
            </div>
          </header>
          <StatusViewport />
        </div>
        <Outlet />
      </div>
    </div>
  )
}
