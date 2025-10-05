
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Welcome</h2>
      <p>Pick an org to view activity.</p>
      <Link to="/org/$orgId" params={{orgId:'acme'}} className="text-blue-600 underline">Go to org "acme" →</Link>
    </div>
  )
}
