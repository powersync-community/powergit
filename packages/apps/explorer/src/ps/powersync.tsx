
import * as React from 'react'
import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { PowerSyncContext } from '@powersync/react'
import { AppSchema } from './schema'
import { Connector } from './connector'
import { initTestFixtureBridge } from './test-fixture-bridge'

const isPowerSyncDisabled = import.meta.env.VITE_POWERSYNC_DISABLED === 'true'
const isMultiTabCapable = typeof SharedWorker !== 'undefined'

export function createPowerSync() {
  const flags = { enableMultiTabs: isMultiTabCapable, useWebWorker: true }
  return new PowerSyncDatabase({
    schema: AppSchema,
    database: new WASQLiteOpenFactory({
      dbFilename: 'repo-explorer.db',
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
      flags,
    }),
    flags,
  })
}

export const PowerSyncProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const powerSync = React.useMemo(() => createPowerSync(), [])

  React.useEffect(() => {
    let disposed = false
    const connector = new Connector()

    const run = async () => {
      try {
        await powerSync.init()
        if (!isPowerSyncDisabled) {
          await powerSync.connect(connector)
        }
      } catch (error) {
        if (!disposed) {
          console.error('[PowerSync] failed to initialize', error)
        }
      }
    }

    void run()

    return () => {
      disposed = true
      void powerSync.close({ disconnect: true }).catch((error) => {
        console.warn('[PowerSync] failed to close database', error)
      })
    }
  }, [powerSync])

  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __powersyncDb?: PowerSyncDatabase }).__powersyncDb = powerSync
    return () => {
      delete (window as unknown as { __powersyncDb?: PowerSyncDatabase }).__powersyncDb
    }
  }, [powerSync])

  React.useEffect(() => {
    if (import.meta.env.DEV) {
      console.debug('[PowerSyncProvider] initializing test fixture bridge')
    }
    initTestFixtureBridge()
  }, [])

  return <PowerSyncContext.Provider value={powerSync}>{children}</PowerSyncContext.Provider>
}
