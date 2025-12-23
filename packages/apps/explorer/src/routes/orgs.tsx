import * as React from 'react'
import { createFileRoute, Link, useLocation } from '@tanstack/react-router'
import { getSupabase } from '@ps/supabase'
import { useTheme } from '../ui/theme-context'
import { formatErrorMessage } from '../ui/format-error'

type OrgSummary = {
  org_id: string
  name: string | null
  role: 'admin' | 'write' | 'read' | string
  created_at: string | null
}

type OrgInvite = {
  org_id: string
  org_name: string | null
  role: 'admin' | 'write' | 'read' | string
  invited_by: string | null
  created_at: string | null
  updated_at: string | null
}

export const Route = createFileRoute('/orgs' as any)({
  component: OrgsRoute,
})

export function OrgsRoute() {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const supabase = getSupabase()
  const navigate = Route.useNavigate()
  const location = useLocation()

  const [orgs, setOrgs] = React.useState<OrgSummary[]>([])
  const [invites, setInvites] = React.useState<OrgInvite[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const [orgId, setOrgId] = React.useState('')
  const [name, setName] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [acceptingOrg, setAcceptingOrg] = React.useState<string | null>(null)
  const acceptAttemptedRef = React.useRef<string | null>(null)

  const acceptOrgId = React.useMemo(() => {
    const search = location.search ?? ''
    if (!search) return null
    const params = new URLSearchParams(search)
    const raw = params.get('accept') ?? params.get('org') ?? params.get('orgId')
    if (!raw || !raw.trim()) return null
    return raw.trim()
  }, [location.search])

  const loadOrgs = React.useCallback(async () => {
    if (!supabase) {
      setError('Supabase is not configured for this environment.')
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('powergit_list_my_orgs')
      if (rpcError) throw rpcError
      setOrgs(Array.isArray(data) ? (data as OrgSummary[]) : [])

      const { data: inviteData, error: invitesError } = await supabase.rpc('powergit_list_my_org_invites')
      if (invitesError) throw invitesError
      setInvites(Array.isArray(inviteData) ? (inviteData as OrgInvite[]) : [])
    } catch (err) {
      setError(formatErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [supabase])

  React.useEffect(() => {
    void loadOrgs()
  }, [loadOrgs])

  const acceptInvite = React.useCallback(
    async (targetOrgId: string, clearUrl: boolean) => {
      if (!supabase) return
      if (!targetOrgId || !targetOrgId.trim()) return
      setAcceptingOrg(targetOrgId)
      setError(null)
      setNotice(null)
      try {
        const { data, error: acceptError } = await supabase.rpc('powergit_accept_org_invite', {
          target_org_id: targetOrgId,
        })
        if (acceptError) throw acceptError
        if (data !== true) {
          throw new Error('Invite acceptance was not acknowledged.')
        }
        setNotice(`Joined org "${targetOrgId}".`)
        await loadOrgs()
      } catch (err) {
        setError(formatErrorMessage(err))
      } finally {
        setAcceptingOrg(null)
        if (clearUrl) {
          void navigate({ to: '/orgs', replace: true })
        }
      }
    },
    [supabase, loadOrgs, navigate],
  )

  React.useEffect(() => {
    if (!acceptOrgId || !supabase) return
    if (acceptAttemptedRef.current === acceptOrgId) return
    acceptAttemptedRef.current = acceptOrgId
    void acceptInvite(acceptOrgId, true)
  }, [acceptOrgId, supabase, acceptInvite])

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!supabase) {
      setError('Supabase is not configured for this environment.')
      return
    }
    const trimmed = orgId.trim()
    if (!trimmed) return
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      const { error: rpcError } = await supabase.rpc('powergit_create_org', {
        org_id: trimmed,
        name: name.trim() || null,
      })
      if (rpcError) throw rpcError
      setOrgId('')
      setName('')
      await loadOrgs()
    } catch (err) {
      setError(formatErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const pageTitle = isDark ? 'text-2xl font-semibold text-slate-100' : 'text-2xl font-semibold text-slate-900'
  const cardBase = isDark
    ? 'rounded-2xl border border-slate-700 bg-slate-900/70 px-6 py-5 shadow-lg shadow-slate-900/40'
    : 'rounded-2xl border border-slate-200 bg-white px-6 py-5 shadow-sm'
  const label = isDark ? 'text-xs font-semibold uppercase tracking-wide text-slate-400' : 'text-xs font-semibold uppercase tracking-wide text-slate-500'
  const input = isDark
    ? 'w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const button = isDark
    ? 'inline-flex items-center justify-center rounded-xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-500/40 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-70'
    : 'inline-flex items-center justify-center rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-70'
  const link = isDark ? 'text-emerald-200 hover:text-emerald-100' : 'text-emerald-700 hover:text-emerald-600'
  const smallMuted = isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className={pageTitle}>Orgs</h2>
        <div className={isDark ? 'text-sm text-slate-400' : 'text-sm text-slate-500'}>
          {loading ? 'Loading…' : `${orgs.length} org${orgs.length === 1 ? '' : 's'}`}
        </div>
      </header>

      {error ? (
        <div
          className={
            isDark
              ? 'rounded-xl border border-red-400/30 bg-red-900/20 px-4 py-3 text-sm text-red-200'
              : 'rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'
          }
        >
          {error}
        </div>
      ) : null}

      {notice ? (
        <div
          className={
            isDark
              ? 'rounded-xl border border-emerald-400/30 bg-emerald-900/20 px-4 py-3 text-sm text-emerald-100'
              : 'rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800'
          }
        >
          {notice}
        </div>
      ) : null}

      {invites.length > 0 ? (
        <section className={cardBase}>
          <div className={isDark ? 'text-sm font-semibold text-slate-100' : 'text-sm font-semibold text-slate-900'}>
            Pending invitations
          </div>
          <div className={smallMuted}>Accept an invite to join the org.</div>
          <ul className="mt-4 divide-y divide-slate-200/20">
            {invites.map((invite) => (
              <li key={invite.org_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="space-y-1">
                  <div className={isDark ? 'text-base font-semibold text-slate-100' : 'text-base font-semibold text-slate-900'}>
                    {invite.org_id}
                  </div>
                  <div className={smallMuted}>
                    {invite.org_name ? invite.org_name : '—'} · Role: <span className="font-medium">{invite.role ?? 'read'}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={button}
                  disabled={acceptingOrg === invite.org_id}
                  onClick={() => {
                    void acceptInvite(invite.org_id, false)
                  }}
                >
                  {acceptingOrg === invite.org_id ? 'Accepting…' : 'Accept'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={cardBase}>
        <form className="space-y-4" onSubmit={handleCreate}>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <div className={label}>Org ID</div>
              <input
                value={orgId}
                onChange={(event) => setOrgId(event.target.value)}
                className={input}
                placeholder="acme"
                autoComplete="off"
                required
              />
            </label>
            <label className="space-y-2">
              <div className={label}>Display Name (optional)</div>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={input}
                placeholder="Acme Inc"
                autoComplete="off"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className={isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'}>
              Note: org IDs starting with <code className="font-mono">gh-</code> are reserved for GitHub imports.
            </div>
            <button type="submit" className={button} disabled={creating}>
              {creating ? 'Creating…' : 'Create org'}
            </button>
          </div>
        </form>
      </section>

      <section className={cardBase}>
        {loading ? (
          <div className={isDark ? 'text-sm text-slate-300' : 'text-sm text-slate-600'}>Loading orgs…</div>
        ) : orgs.length === 0 ? (
          <div className={isDark ? 'text-sm text-slate-400' : 'text-sm text-slate-500'}>
            No org memberships yet.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200/20">
            {orgs.map((org) => {
              const roleLabel = (org.role ?? 'read').toString()
              return (
                <li key={org.org_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="space-y-1">
                    <div className={isDark ? 'text-base font-semibold text-slate-100' : 'text-base font-semibold text-slate-900'}>
                      {org.org_id}
                    </div>
                    <div className={isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'}>
                      {org.name ? org.name : '—'} · Role: <span className="font-medium">{roleLabel}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Link to="/org/$orgId" params={{ orgId: org.org_id }} className={link}>
                      Activity →
                    </Link>
                    <Link to="/org/$orgId/settings" params={{ orgId: org.org_id }} className={link}>
                      Settings →
                    </Link>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
