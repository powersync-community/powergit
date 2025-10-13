
import * as React from 'react'
import { createCollection, type CollectionImpl } from '@tanstack/db'
import { usePowerSync } from '@powersync/react'
import { convertPowerSyncSchemaToSpecs, powerSyncCollectionOptions } from '@tanstack/powersync-db-collection'
import { AppSchema, type Database } from '../ps/schema'

type Collections = {
  refs: CollectionImpl<Database['refs']>
  commits: CollectionImpl<Database['commits']>
  file_changes: CollectionImpl<Database['file_changes']>
  objects: CollectionImpl<Database['objects']>
}

const collectionSpecs = convertPowerSyncSchemaToSpecs(AppSchema)

export function useCollections(): Collections {
  const db = usePowerSync()

  return React.useMemo(() => {
    if (!db) {
      throw new Error('PowerSync database is not available')
    }

    return {
      refs: createCollection(
        powerSyncCollectionOptions<Database['refs']>({
          database: db,
          tableName: 'refs',
          schema: collectionSpecs.refs,
        })
      ) as unknown as CollectionImpl<Database['refs']>,
      commits: createCollection(
        powerSyncCollectionOptions<Database['commits']>({
          database: db,
          tableName: 'commits',
          schema: collectionSpecs.commits,
        })
      ) as unknown as CollectionImpl<Database['commits']>,
      file_changes: createCollection(
        powerSyncCollectionOptions<Database['file_changes']>({
          database: db,
          tableName: 'file_changes',
          schema: collectionSpecs.file_changes,
        })
      ) as unknown as CollectionImpl<Database['file_changes']>,
      objects: createCollection(
        powerSyncCollectionOptions<Database['objects']>({
          database: db,
          tableName: 'objects',
          schema: collectionSpecs.objects,
        })
      ) as unknown as CollectionImpl<Database['objects']>,
    }
  }, [db])
}
