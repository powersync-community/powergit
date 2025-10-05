// Mock PowerSync React for build compatibility
import { createContext, useContext } from 'react'

export const PowerSyncContext = createContext<any>(null)

export function PowerSyncProvider({ children, database }: any) {
  return PowerSyncContext.Provider({ value: database, children })
}

export function usePowerSync() {
  const context = useContext(PowerSyncContext)
  if (!context) {
    console.warn('usePowerSync must be used within a PowerSyncProvider')
    return null
  }
  return context
}

export function useStatus() {
  return 'connected'
}