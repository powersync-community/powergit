import * as React from 'react'

export interface ResetPasswordScreenProps {
  onSubmit: (password: string) => Promise<void>
  onCancel: () => void | Promise<void>
}

export const ResetPasswordScreen: React.FC<ResetPasswordScreenProps> = ({ onSubmit, onCancel }) => {
  const [password, setPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSuccessMessage(null)

    if (password.length < 8) {
      setError('Use at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      await onSubmit(password)
      setSuccessMessage('Password updated. You can close this window or return to the explorer.')
      setPassword('')
      setConfirmPassword('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update password.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen w-full items-center justify-center px-4 py-12 sm:px-6">
        <section className="w-full max-w-md">
          <div className="rounded-3xl bg-white/90 px-8 py-10 shadow-2xl shadow-slate-900/10 ring-1 ring-slate-200/70 backdrop-blur">
            <header className="space-y-2 text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Powergit</p>
              <h2 className="text-2xl font-semibold text-slate-900">Set a new password</h2>
              <p className="text-sm text-slate-500">Choose a new password to finish resetting your account.</p>
            </header>

            {error ? (
              <div className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200" role="alert">
                {error}
              </div>
            ) : null}
            {successMessage ? (
              <div className="mt-6 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700 ring-1 ring-blue-200" role="status">
                {successMessage}
              </div>
            ) : null}

            <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
              <label className="flex flex-col gap-2 text-left">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">New password</span>
                <input
                  className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm shadow-sm placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-4 focus:ring-emerald-200/40"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="New password"
                  required
                />
              </label>
              <label className="flex flex-col gap-2 text-left">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Confirm password</span>
                <input
                  className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm shadow-sm placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-4 focus:ring-emerald-200/40"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Confirm password"
                  required
                />
              </label>

              <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                <button
                  type="submit"
                  className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm shadow-emerald-600/25 transition hover:bg-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-200/60 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={loading}
                >
                  {loading ? 'Updating…' : 'Update password'}
                </button>
                <button
                  type="button"
                  className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-emerald-200/40 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    void onCancel()
                  }}
                  disabled={loading}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  )
}
