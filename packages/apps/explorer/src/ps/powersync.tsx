
import * as React from 'react'
import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { PowerSyncContext } from '@powersync/react'
import { AppSchema } from './schema'
import { Connector } from './connector'

export function createPowerSync() {
  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: new WASQLiteOpenFactory({
      dbFilename: 'repo-explorer.db',
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
      flags: { enableMultiTabs: typeof SharedWorker !== 'undefined' }
    }),
    flags: { enableMultiTabs: typeof SharedWorker !== 'undefined' }
  })
  if (import.meta.env.VITE_POWERSYNC_DISABLED !== 'true') {
    const connector = new Connector()
    db.connect(connector)
  }
  return db
}

export const PowerSyncProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const powerSync = React.useMemo(() => createPowerSync(), [])
  return <PowerSyncContext.Provider value={powerSync}>{children}</PowerSyncContext.Provider>
}
