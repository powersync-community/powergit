import * as React from 'react'
import { createFileRoute, useLocation } from '@tanstack/react-router'
import { AuthScreen } from '../screens/auth/AuthScreen'
import {
  isAnonymousSignInSupported,
  isSupabaseConfigured,
  sendPasswordResetEmail,
  signInAnonymously,
  signInWithPassword,
  signUpWithPassword,
  signOut,
} from '@ps/supabase'
import { completeDaemonDeviceLogin } from '@ps/daemon-client'
import { useSupabaseAuth } from '@ps/auth-context'

export const Route = createFileRoute('/auth' as any)({
  component: AuthRoute,
})

export function AuthRoute() {
  const { status, isConfigured, error, session } = useSupabaseAuth()
  const navigate = Route.useNavigate()
  const allowGuest = React.useMemo(() => isAnonymousSignInSupported(), [])
  const location = useLocation()
  const redirectSpec = React.useMemo(() => {
    const search = location.search ?? ''
    if (!search) return null
    const params = new URLSearchParams(search)
    const raw = params.get('redirect')
    if (!raw || !raw.trim()) return null
    const redirect = raw.trim()
    if (!redirect.startsWith('/') || redirect.startsWith('//')) return null

    try {
      const parsed = new URL(redirect, 'http://localhost')
      const basepath = import.meta.env.BASE_URL !== '/' ? import.meta.env.BASE_URL.replace(/\/$/, '') : ''
      let pathname = parsed.pathname
      if (basepath && pathname === basepath) {
        pathname = '/'
      } else if (basepath && pathname.startsWith(`${basepath}/`)) {
        pathname = pathname.slice(basepath.length)
      }

      if (pathname.startsWith('/auth') || pathname.startsWith('/reset-password')) {
        return null
      }

      const searchObject = Object.fromEntries(parsed.searchParams.entries())
      return {
        to: pathname,
        search: Object.keys(searchObject).length > 0 ? searchObject : undefined,
      }
    } catch {
      return null
    }
  }, [location.search])
  const deviceFlowActive = React.useMemo(() => {
    const search = location.search ?? ''
    if (!search) return false
    const params = new URLSearchParams(search)
    if (params.has('device_code')) return true
    if (params.has('challenge')) return true
    if (params.has('state')) return true
    return false
  }, [location.search])
  const deviceCode = React.useMemo(() => {
    const search = location.search ?? ''
    if (!search) return null
    const params = new URLSearchParams(search)
    return params.get('device_code') ?? params.get('challenge') ?? params.get('state')
  }, [location.search])
  const daemonUrlOverride = React.useMemo(() => {
    const search = location.search ?? ''
    if (!search) return null
    const params = new URLSearchParams(search)
    const raw = params.get('daemon_url') ?? params.get('daemonUrl') ?? params.get('daemon')
    if (!raw || !raw.trim()) return null
    try {
      const parsed = new URL(raw.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      const host = parsed.hostname
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return null
    }
  }, [location.search])
  const [deviceLoginState, setDeviceLoginState] = React.useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [deviceLoginError, setDeviceLoginError] = React.useState<string | null>(null)
  const attemptedDeviceCode = React.useRef<string | null>(null)
  const [signingOut, setSigningOut] = React.useState(false)
  const redirectedRef = React.useRef(false)

  const handleSignOut = React.useCallback(async () => {
    setSigningOut(true)
    try {
      await signOut()
    } catch (err) {
      console.error('[AuthRoute] failed to sign out', err)
    } finally {
      setSigningOut(false)
    }
  }, [])

  React.useEffect(() => {
    if (!deviceFlowActive && status === 'authenticated') {
      if (!redirectedRef.current) {
        redirectedRef.current = true
        const destination = redirectSpec?.to ?? '/'
        const navigation: Record<string, unknown> = { to: destination, replace: true }
        if (redirectSpec?.search) {
          navigation.search = redirectSpec.search
        }
        void navigate(navigation as any)
      }
    } else {
      redirectedRef.current = false
    }
  }, [status, navigate, deviceFlowActive, redirectSpec?.to, redirectSpec?.search])

  React.useEffect(() => {
    if (!deviceFlowActive) return
    if (!deviceCode || typeof deviceCode !== 'string' || deviceCode.trim().length === 0) return
    if (status !== 'authenticated') return
    if (!session?.access_token || !session.refresh_token) return

    if (attemptedDeviceCode.current === deviceCode) return
    attemptedDeviceCode.current = deviceCode

    let cancelled = false
    setDeviceLoginState('submitting')
    setDeviceLoginError(null)

    const complete = async () => {
      const ok = await completeDaemonDeviceLogin({
        challengeId: deviceCode,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_in: typeof session.expires_in === 'number' ? session.expires_in : null,
          expires_at: typeof session.expires_at === 'number' ? session.expires_at : null,
        },
        daemonBaseUrl: daemonUrlOverride,
      })
      if (cancelled) return
      if (ok) {
        setDeviceLoginState('done')
        return
      }
      setDeviceLoginState('error')
      const daemonTarget = (() => {
        if (daemonUrlOverride) return daemonUrlOverride
        if (typeof window !== 'undefined') {
          const { hostname, pathname, origin } = window.location
          const isLocalhost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
          if (isLocalhost && pathname.startsWith('/ui/')) {
            return origin
          }
        }
        return 'http://127.0.0.1:5030'
      })()
      setDeviceLoginError(
        `Could not reach the local PowerSync daemon (${daemonTarget}) or the request timed out. Ensure \`powergit-daemon\` is running. If DevTools shows "net::ERR_BLOCKED_BY_CLIENT", disable ad blockers/privacy shields for this page and try again.`,
      )
    }

    void complete()

    return () => {
      cancelled = true
    }
  }, [
    deviceFlowActive,
    deviceCode,
    status,
    session?.access_token,
    session?.refresh_token,
    session?.expires_at,
    session?.expires_in,
    daemonUrlOverride,
  ])

  if (!isConfigured && !isSupabaseConfigured()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 text-center">
        <div className="max-w-md space-y-3 rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow">
          <h2 className="text-xl font-semibold text-slate-900">Supabase environment missing</h2>
          <p className="text-sm text-slate-600">
            Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in your explorer environment to enable
            authentication.
          </p>
        </div>
      </div>
    )
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-500">
        <span className="text-sm font-medium">Checking session…</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 text-center">
        <div className="max-w-md space-y-3 rounded-2xl border border-red-200 bg-red-50 px-6 py-8 text-red-700 shadow">
          <h2 className="text-lg font-semibold">Authentication unavailable</h2>
          <p className="text-sm">{error?.message ?? 'Failed to initialise Supabase session.'}</p>
        </div>
      </div>
    )
  }

  if (status === 'authenticated' && deviceFlowActive) {
    const deviceMessage = (() => {
      switch (deviceLoginState) {
        case 'submitting':
          return 'Submitting your Supabase session to the local daemon…'
        case 'done':
          return 'CLI login complete. You can return to the terminal.'
        case 'error':
          return deviceLoginError ?? 'Failed to complete CLI login.'
        default:
          return 'Keep this tab open until the CLI reports success.'
      }
    })()
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 text-center">
        <div className="max-w-md space-y-4 rounded-2xl border border-slate-200 bg-white px-6 py-8 text-slate-700 shadow">
          <h2 className="text-lg font-semibold text-slate-900">Daemon login in progress</h2>
          <p className="text-sm">
            You&rsquo;re already signed in. We&rsquo;ll reuse this session to finish the CLI login automatically.
          </p>
          <p className="text-sm">{deviceMessage}</p>
          <p className="text-xs text-slate-500">
            Need to switch accounts? Sign out below and sign back in with the desired credentials.
          </p>
          <button
            type="button"
            className="btn-secondary w-full text-sm"
            onClick={() => {
              void handleSignOut()
            }}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <AuthScreen
      allowGuest={allowGuest}
      onSignIn={signInWithPassword}
      onSignUp={signUpWithPassword}
      onResetPassword={sendPasswordResetEmail}
      onGuestSignIn={allowGuest ? signInAnonymously : undefined}
    />
  )
}

export { AuthRoute as AuthRouteComponent }
