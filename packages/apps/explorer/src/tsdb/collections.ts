
import * as React from 'react'
import { createCollection } from '@tanstack/react-db'
import { eq } from '@tanstack/db'
import { usePowerSync } from '@powersync/react'
import { AppSchema } from '../ps/schema'
import { powerSyncCollectionOptions, convertPowerSyncSchemaToSpecs } from '@tanstack/powersync-db-collection'

const specs = convertPowerSyncSchemaToSpecs(AppSchema)

export function useCollections() {
  const db = usePowerSync()
  return React.useMemo(() => ({
    refs: createCollection(powerSyncCollectionOptions({ database: db, tableName: 'refs', schema: specs.refs })),
    commits: createCollection(powerSyncCollectionOptions({ database: db, tableName: 'commits', schema: specs.commits })),
    file_changes: createCollection(powerSyncCollectionOptions({ database: db, tableName: 'file_changes', schema: specs.file_changes })),
    eq, // re-export helper for convenience
  }), [db])
}
