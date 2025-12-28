import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ResetPasswordScreen } from '../screens/auth/ResetPasswordScreen'
import { signOut, updateCurrentUserPassword } from '@ps/supabase'
import { useSupabaseAuth } from '@ps/auth-context'

export const Route = createFileRoute('/reset-password' as any)({
  component: ResetPasswordRoute,
})

export function ResetPasswordRoute() {
  const { status } = useSupabaseAuth()
  const navigate = Route.useNavigate()
  const [completed, setCompleted] = React.useState(false)

  const handleSubmit = React.useCallback(
    async (password: string) => {
      await updateCurrentUserPassword(password)
      setCompleted(true)
      void navigate({ to: '/' })
    },
    [navigate],
  )

  const handleCancel = React.useCallback(async () => {
    await signOut().catch(() => undefined)
    void navigate({ to: '/auth' })
  }, [navigate])

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-slate-50 text-slate-900">
        <div className="mx-auto flex min-h-screen w-full items-center justify-center px-4 py-12 sm:px-6">
          <section className="w-full max-w-md">
            <div className="rounded-3xl bg-white/90 px-8 py-10 text-center shadow-2xl shadow-slate-900/10 ring-1 ring-slate-200/70 backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Powergit</p>
              <p className="mt-4 text-sm text-slate-500">Preparing reset form…</p>
            </div>
          </section>
        </div>
      </div>
    )
  }

  if (!completed && status === 'unauthenticated') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-slate-50 text-slate-900">
        <div className="mx-auto flex min-h-screen w-full items-center justify-center px-4 py-12 sm:px-6">
          <section className="w-full max-w-md">
            <div className="rounded-3xl bg-white/90 px-8 py-10 text-center shadow-2xl shadow-slate-900/10 ring-1 ring-slate-200/70 backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Powergit</p>
              <h2 className="mt-4 text-lg font-semibold text-slate-900">Password reset link expired</h2>
              <p className="mt-2 text-sm text-slate-500">Request a new reset email before trying again.</p>
              <div className="mt-6">
          <button
            type="button"
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm shadow-emerald-600/25 transition hover:bg-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-200/60"
            onClick={() => {
              void navigate({ to: '/auth' })
            }}
          >
            Return to sign in
          </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    )
  }

  return <ResetPasswordScreen onSubmit={handleSubmit} onCancel={handleCancel} />
}

export { ResetPasswordRoute as ResetPasswordRouteComponent }
