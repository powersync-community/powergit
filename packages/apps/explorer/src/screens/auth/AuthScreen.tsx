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
    } catch (err) {
      console.error(`[AuthScreen] ${mode === 'signin' ? 'sign-in' : 'sign-up'} failed`, err)
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
        <div className="grid w-full max-w-5xl items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          <aside className="hidden flex-col gap-6 rounded-3xl border border-slate-200 bg-white/85 px-8 py-10 text-slate-700 shadow-2xl shadow-slate-400/15 backdrop-blur lg:flex">
            <div className="space-y-3">
              <span className="inline-flex w-fit rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-medium uppercase tracking-wide text-blue-700">
                PowerSync + Git
              </span>
              <h1 className="text-4xl font-semibold leading-tight text-slate-900">
                Explore replicated repos without leaving the browser.
              </h1>
            </div>
            <ul className="space-y-3 text-sm">
              <li>• Authenticate with Supabase and stream data via PowerSync.</li>
              <li>• Inspect orgs, branches, commits, and file history offline.</li>
              <li>• Push changes through the daemon for a full local-first loop.</li>
            </ul>
          </aside>
          <section className="w-full">
            <div className="card space-y-6 px-8 py-10">
              <header className="space-y-1.5">
                <h2 className="text-2xl font-semibold text-slate-900" data-testid="auth-heading">
                  Welcome back
                </h2>
                <p className="text-sm text-slate-500">
                  Sign in with your Supabase account or create a new workspace.
                </p>
              </header>
              {error ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                  {error}
                </div>
              ) : null}
              {infoMessage ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700" role="status">
                  {infoMessage}
                </div>
              ) : null}
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSubmit(onSignIn, 'signin')
                }}
              >
                <input
                  className="input h-12"
                  placeholder="Email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
                <input
                  className="input h-12"
                  placeholder="Password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-xs font-medium text-blue-600 hover:text-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-400/60 rounded"
                    onClick={() => {
                      void handlePasswordReset()
                    }}
                    disabled={resetting || !email}
                  >
                    {resetting ? 'Sending reset link…' : 'Forgot password?'}
                  </button>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button type="submit" className="btn w-full" disabled={!email || !password || signingIn}>
                    {signingIn ? 'Signing in…' : 'Sign In'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary w-full"
                    onClick={() => void handleSubmit(onSignUp, 'signup')}
                    disabled={!email || !password || signingUp}
                  >
                    {signingUp ? 'Creating…' : 'Create Account'}
                  </button>
                </div>
              </form>
              {allowGuest && onGuestSignIn ? (
                <div className="space-y-3 border-slate-200 pt-4">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                    <span className="h-px flex-1 bg-slate-200" />
                    <span>or</span>
                    <span className="h-px flex-1 bg-slate-200" />
                  </div>
                  <button
                    type="button"
                    className="btn-secondary w-full"
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
    </div>
  )
}
