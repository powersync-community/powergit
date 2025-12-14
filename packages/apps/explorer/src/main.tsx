
import React from 'react'
import ReactDOM from 'react-dom/client'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import './index.css'
import { PowerSyncProvider } from './ps/powersync'
import { SupabaseAuthProvider } from './ps/auth-context'
import { useCoreStreams } from './ps/streams'
import { NoticeProvider } from './ui/notices'
import { StatusProvider } from './ui/status-provider'
import './ps/git-store-config'

const router = createRouter({ routeTree })
declare module '@tanstack/react-router' { interface Register { router: typeof router } }

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as typeof window & { __appRouter?: typeof router }).__appRouter = router
}

const PowerSyncCoreStreamSubscriptions: React.FC = () => {
  useCoreStreams()
  return null
}

const app = (
  <NoticeProvider>
    <StatusProvider>
      <SupabaseAuthProvider>
        <PowerSyncProvider>
          <PowerSyncCoreStreamSubscriptions />
          <RouterProvider router={router} />
        </PowerSyncProvider>
      </SupabaseAuthProvider>
    </StatusProvider>
  </NoticeProvider>
)

const root = import.meta.env.VITE_DISABLE_STRICT_MODE === 'true' ? (
  app
) : (
  <React.StrictMode>{app}</React.StrictMode>
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  root,
)
