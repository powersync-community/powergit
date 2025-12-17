import * as React from 'react'

export interface AuthScreenProps {
  onSignIn: (email: string, password: string) => Promise<void>
  onSignUp: (email: string, password: string) => Promise<void>
  onResetPassword: (email: string) => Promise<void>
  onGuestSignIn?: () => Promise<void>
  allowGuest?: boolean
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  onSignIn,
  onSignUp,
  onResetPassword,
  onGuestSignIn,
  allowGuest = false,
}) => {
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [infoMessage, setInfoMessage] = React.useState<string | null>(null)
  const [signingIn, setSigningIn] = React.useState(false)
  const [signingUp, setSigningUp] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)
  const [guestLoading, setGuestLoading] = React.useState(false)

  const resetFeedback = () => {
    setError(null)
    setInfoMessage(null)
  }

  const handleSubmit = async (
    callback: (emailAddress: string, userPassword: string) => Promise<void>,
    mode: 'signin' | 'signup',
  ) => {
    resetFeedback()
    if (!email || !password) {
      setError('Email and password are required.')
      return
    }

    if (mode === 'signin') setSigningIn(true)
    if (mode === 'signup') setSigningUp(true)

    try {
      await callback(email, password)
      if (mode === 'signup') {
        setInfoMessage('Account created. Check your email for a confirmation link, then sign in.')
      }
    } catch (err) {
      console.error(`[AuthScreen] ${mode} failed`, err)
      const message = err instanceof Error ? err.message : 'Authentication failed.'
      setError(message)
    } finally {
      if (mode === 'signin') setSigningIn(false)
      if (mode === 'signup') setSigningUp(false)
    }
  }

  const handleGuest = async () => {
    if (!onGuestSignIn) return
    resetFeedback()
    setGuestLoading(true)
    try {
      await onGuestSignIn()
    } catch (err) {
      console.error('[AuthScreen] guest sign-in failed', err)
      const message = err instanceof Error ? err.message : 'Guest sign-in failed.'
      setError(message)
    } finally {
      setGuestLoading(false)
    }
  }

  const handlePasswordReset = async () => {
    resetFeedback()
    if (!email) {
      setError('Enter your email to receive a reset link.')
      return
    }
    setResetting(true)
    try {
      await onResetPassword(email)
      setInfoMessage('If that email exists, a reset link is on its way.')
    } catch (err) {
      console.error('[AuthScreen] password reset failed', err)
      const message = err instanceof Error ? err.message : 'Failed to send reset email.'
      setError(message)
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen w-full items-center justify-center px-4 py-12 sm:px-6">
        <section className="w-full max-w-md">
          <div className="rounded-3xl bg-white/90 px-8 py-10 shadow-2xl shadow-slate-900/10 ring-1 ring-slate-200/70 backdrop-blur">
            <header className="space-y-2 text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Powergit</p>
              <h2 className="text-2xl font-semibold text-slate-900" data-testid="auth-heading">
                Sign in
              </h2>
              <p className="text-sm text-slate-500">
                Sign in or create an account to continue.
              </p>
            </header>

            {error ? (
              <div className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200" role="alert">
                {error}
              </div>
            ) : null}
            {infoMessage ? (
              <div className="mt-6 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700 ring-1 ring-blue-200" role="status">
                {infoMessage}
              </div>
            ) : null}

            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                void handleSubmit(onSignIn, 'signin')
              }}
            >
              <label className="flex flex-col gap-2 text-left">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Email</span>
                <input
                  className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm shadow-sm placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-4 focus:ring-emerald-200/40"
                  placeholder="Email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label className="flex flex-col gap-2 text-left">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Password</span>
                <input
                  className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm shadow-sm placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-4 focus:ring-emerald-200/40"
                  placeholder="Password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>

              <div className="flex justify-end">
                <button
                  type="button"
                  className="rounded-md text-xs font-medium text-slate-500 transition hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40"
                  onClick={() => {
                    void handlePasswordReset()
                  }}
                  disabled={resetting || !email}
                >
                  {resetting ? 'Sending reset link…' : 'Forgot password?'}
                </button>
              </div>

              <button
                type="submit"
                className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm shadow-emerald-600/25 transition hover:bg-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-200/60 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!email || !password || signingIn || signingUp}
              >
                {signingIn ? 'Signing in…' : 'Sign In'}
              </button>

              <button
                type="button"
                className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-emerald-200/40 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleSubmit(onSignUp, 'signup')}
                disabled={!email || !password || signingIn || signingUp}
              >
                {signingUp ? 'Creating account…' : 'Create account'}
              </button>
            </form>

            {allowGuest && onGuestSignIn ? (
              <div className="mt-6 space-y-3">
                <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
                  <span className="h-px flex-1 bg-slate-200" />
                  <span>or</span>
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
                <button
                  type="button"
                  className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-emerald-200/40 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void handleGuest()}
                  disabled={guestLoading}
                  data-testid="guest-continue-button"
                >
                  {guestLoading ? 'Joining…' : 'Continue as guest'}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
