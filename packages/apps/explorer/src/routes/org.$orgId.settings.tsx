import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { getSupabase } from '@ps/supabase'
import { useTheme } from '../ui/theme-context'
import { formatErrorMessage } from '../ui/format-error'

type OrgSummary = {
  org_id: string
  role: 'admin' | 'write' | 'read' | string
}

type OrgMember = {
  user_id: string
  email: string | null
  role: 'admin' | 'write' | 'read' | string
  created_at: string | null
  updated_at: string | null
}

type OrgInvite = {
  email: string
  role: 'admin' | 'write' | 'read' | string
  invited_by: string | null
  created_at: string | null
  updated_at: string | null
}

type InviteResult = {
  status?: string
  org_id?: string
  email?: string
  role?: string
  user_id?: string
}

export const Route = createFileRoute('/org/$orgId/settings' as any)({
  component: OrgSettingsRoute,
})

export function OrgSettingsRoute() {
  const { orgId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const supabase = getSupabase()

  const [members, setMembers] = React.useState<OrgMember[]>([])
  const [invites, setInvites] = React.useState<OrgInvite[]>([])
  const [myRole, setMyRole] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const [inviteEmail, setInviteEmail] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState<'read' | 'write' | 'admin'>('read')
  const [savingInvite, setSavingInvite] = React.useState(false)

  const isAdmin = myRole === 'admin'

  const load = React.useCallback(async () => {
    if (!supabase) {
      setError('Supabase is not configured for this environment.')
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const { data: orgs, error: orgsError } = await supabase.rpc('powergit_list_my_orgs')
      if (orgsError) throw orgsError
      const match = (Array.isArray(orgs) ? (orgs as OrgSummary[]) : []).find((row) => row.org_id === orgId)
      const role = match?.role ?? null
      setMyRole(role)

      const { data: rows, error: membersError } = await supabase.rpc('powergit_list_org_members', {
        target_org_id: orgId,
      })
      if (membersError) throw membersError
      setMembers(Array.isArray(rows) ? (rows as OrgMember[]) : [])

      if (role === 'admin') {
        const { data: inviteRows, error: invitesError } = await supabase.rpc('powergit_list_org_invites', {
          target_org_id: orgId,
        })
        if (invitesError) throw invitesError
        setInvites(Array.isArray(inviteRows) ? (inviteRows as OrgInvite[]) : [])
      } else {
        setInvites([])
      }
    } catch (err) {
      setError(formatErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [supabase, orgId])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!supabase) return
    const email = inviteEmail.trim()
    if (!email) return
    setSavingInvite(true)
    setError(null)
    setNotice(null)
    try {
      const { data, error: inviteError } = await supabase.rpc('powergit_invite_org_member', {
        target_org_id: orgId,
        target_email: email,
        target_role: inviteRole,
      })
      if (inviteError) throw inviteError
      const result = (data ?? null) as InviteResult | null
      if (result?.status === 'invited') {
        setNotice(`Invited ${email} as ${inviteRole}.`)
      } else if (result?.status === 'added') {
        setNotice(`Added ${email} as ${inviteRole}.`)
      } else {
        setNotice('Saved.')
      }
      setInviteEmail('')
      setInviteRole('read')
      await load()
    } catch (err) {
      setError(formatErrorMessage(err))
    } finally {
      setSavingInvite(false)
    }
  }

  const handleRoleChange = async (member: OrgMember, nextRole: 'read' | 'write' | 'admin') => {
    if (!supabase) return
    if (!member.email) {
      setError('Cannot update role: member email unavailable.')
      return
    }
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await supabase.rpc('powergit_invite_org_member', {
        target_org_id: orgId,
        target_email: member.email,
        target_role: nextRole,
      })
      if (updateError) throw updateError
      await load()
    } catch (err) {
      setError(formatErrorMessage(err))
    }
  }

  const handleRemove = async (member: OrgMember) => {
    if (!supabase) return
    setError(null)
    try {
      const { data, error: removeError } = await supabase.rpc('powergit_remove_org_member', {
        target_org_id: orgId,
        target_user_id: member.user_id,
      })
      if (removeError) throw removeError
      if (data !== true) {
        throw new Error('Member removal was not acknowledged.')
      }
      await load()
    } catch (err) {
      setError(formatErrorMessage(err))
    }
  }

  const handleCancelInvite = async (email: string) => {
    if (!supabase) return
    setError(null)
    setNotice(null)
    try {
      const { data, error: cancelError } = await supabase.rpc('powergit_cancel_org_invite', {
        target_org_id: orgId,
        target_email: email,
      })
      if (cancelError) throw cancelError
      if (data !== true) {
        throw new Error('Invite cancellation was not acknowledged.')
      }
      setNotice(`Cancelled invite for ${email}.`)
      await load()
    } catch (err) {
      setError(formatErrorMessage(err))
    }
  }

  const buildInviteLink = React.useCallback(() => {
    if (typeof window === 'undefined') return ''
    const base = typeof import.meta.env.BASE_URL === 'string' ? import.meta.env.BASE_URL : '/'
    const normalizedBase = base.replace(/\/$/, '')
    const path = `${normalizedBase}/orgs?accept=${encodeURIComponent(orgId)}`
    try {
      return new URL(path, window.location.origin).toString()
    } catch {
      return path
    }
  }, [orgId])

  const handleCopyInviteLink = async () => {
    const link = buildInviteLink()
    if (!link) return
    setNotice(null)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link)
        setNotice('Invite link copied to clipboard.')
        return
      }
    } catch {
      // fall through to prompt
    }
    if (typeof window !== 'undefined') {
      window.prompt('Copy this invite link:', link)
      setNotice('Invite link ready to copy.')
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
  const select = isDark
    ? 'rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const button = isDark
    ? 'inline-flex items-center justify-center rounded-xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-500/40 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-70'
    : 'inline-flex items-center justify-center rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-70'
  const link = isDark ? 'text-emerald-200 hover:text-emerald-100' : 'text-emerald-700 hover:text-emerald-600'
  const smallMuted = isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className={pageTitle}>Org settings: {orgId}</h2>
          <div className={smallMuted}>
            <Link to="/orgs" className={link}>
              ← Back to orgs
            </Link>
            {myRole ? (
              <span className="ml-3">
                Your role: <span className="font-medium">{myRole}</span>
              </span>
            ) : null}
          </div>
        </div>
        <div className={smallMuted}>{loading ? 'Loading…' : `${members.length} member${members.length === 1 ? '' : 's'}`}</div>
      </header>

      {error ? (
        <div className={isDark ? 'rounded-xl border border-red-400/30 bg-red-900/20 px-4 py-3 text-sm text-red-200' : 'rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'}>
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

      <section className={cardBase}>
        <form className="space-y-4" onSubmit={handleInvite}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex-1 space-y-2">
              <div className={label}>Invite member (email)</div>
              <input
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                className={input}
                placeholder="person@example.com"
                type="email"
                autoComplete="off"
                disabled={!isAdmin || savingInvite}
                required
              />
            </label>
            <label className="space-y-2">
              <div className={label}>Role</div>
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as 'read' | 'write' | 'admin')}
                className={select}
                disabled={!isAdmin || savingInvite}
              >
                <option value="read">read</option>
                <option value="write">write</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button type="submit" className={button} disabled={!isAdmin || savingInvite}>
              {savingInvite ? 'Inviting…' : 'Invite'}
            </button>
          </div>
          {!isAdmin ? <div className={smallMuted}>Only org admins can manage members.</div> : null}
        </form>
      </section>

      {isAdmin ? (
        <section className={cardBase}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className={isDark ? 'text-sm font-semibold text-slate-100' : 'text-sm font-semibold text-slate-900'}>
                Pending invitations
              </div>
              <div className={smallMuted}>Invitees must sign up (or sign in) before they can join this org.</div>
            </div>
            <button
              type="button"
              className={
                isDark
                  ? 'rounded-xl border border-slate-700 px-4 py-3 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60'
                  : 'rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60'
              }
              onClick={() => {
                void handleCopyInviteLink()
              }}
              disabled={invites.length === 0}
            >
              Copy invite link
            </button>
          </div>

          {invites.length === 0 ? (
            <div className={`mt-4 ${smallMuted}`}>No pending invitations.</div>
          ) : (
            <ul className="mt-4 divide-y divide-slate-200/20">
              {invites.map((invite) => (
                <li key={invite.email} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="space-y-1">
                    <div className={isDark ? 'text-sm font-semibold text-slate-100' : 'text-sm font-semibold text-slate-900'}>
                      {invite.email}
                    </div>
                    <div className={smallMuted}>Role: {invite.role ?? 'read'}</div>
                  </div>
                  <button
                    type="button"
                    className={
                      isDark
                        ? 'rounded-xl border border-slate-700 px-4 py-3 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60'
                        : 'rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60'
                    }
                    onClick={() => {
                      void handleCancelInvite(invite.email)
                    }}
                  >
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className={cardBase}>
        {loading ? (
          <div className={isDark ? 'text-sm text-slate-300' : 'text-sm text-slate-600'}>Loading members…</div>
        ) : members.length === 0 ? (
          <div className={smallMuted}>No members found.</div>
        ) : (
          <ul className="divide-y divide-slate-200/20">
            {members.map((member) => (
              <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="space-y-1">
                  <div className={isDark ? 'text-sm font-semibold text-slate-100' : 'text-sm font-semibold text-slate-900'}>
                    {member.email ?? member.user_id}
                  </div>
                  <div className={smallMuted}>
                    <span className="font-mono">{member.user_id}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <select
                    value={(member.role ?? 'read') as string}
                    onChange={(event) => {
                      void handleRoleChange(member, event.target.value as 'read' | 'write' | 'admin')
                    }}
                    className={select}
                    disabled={!isAdmin}
                    aria-label={`Role for ${member.email ?? member.user_id}`}
                  >
                    <option value="read">read</option>
                    <option value="write">write</option>
                    <option value="admin">admin</option>
                  </select>
                  <button
                    type="button"
                    className={
                      isDark
                        ? 'rounded-xl border border-slate-700 px-4 py-3 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60'
                        : 'rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60'
                    }
                    disabled={!isAdmin}
                    onClick={() => {
                      void handleRemove(member)
                    }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
