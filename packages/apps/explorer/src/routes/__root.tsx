
import * as React from 'react'
import { Outlet, Link } from '@tanstack/react-router'
import { useStatus } from '@powersync/react'

export const Route = () => {
  const status = useStatus()
  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Repo Explorer</h1>
          <div className="text-sm text-gray-500">
            {status.connected ? 'Connected' : 'Offline'}{!status.hasSynced ? ' · syncing…' : ''}
          </div>
        </div>
        <nav className="space-x-4">
          <Link to="/" className="[&.active]:font-semibold">Home</Link>
          <Link to="/org/$orgId" params={{orgId:'acme'}} className="[&.active]:font-semibold">Org: acme</Link>
          <Link to="/org/$orgId/repo/$repoId" params={{orgId:'acme', repoId:'infra'}} className="[&.active]:font-semibold">Repo: acme/infra</Link>
        </nav>
      </header>
      <Outlet />
    </div>
  )
}
