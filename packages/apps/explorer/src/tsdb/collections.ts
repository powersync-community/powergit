
import * as React from 'react'
import { createCollection, type CollectionImpl } from '@tanstack/db'
import { usePowerSync } from '@powersync/react'
import { powerSyncCollectionOptions } from '@tanstack/powersync-db-collection'
import { refs, commits, file_changes, objects, repositories, import_jobs, type Database } from '../ps/schema'

type Collections = {
  refs: CollectionImpl<Database['refs']>
  commits: CollectionImpl<Database['commits']>
  file_changes: CollectionImpl<Database['file_changes']>
  objects: CollectionImpl<Database['objects']>
  repositories: CollectionImpl<Database['repositories']>
  import_jobs: CollectionImpl<Database['import_jobs']>
}

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
          table: refs,
        })
      ) as CollectionImpl<Database['refs']>,
      commits: createCollection(
        powerSyncCollectionOptions<Database['commits']>({
          database: db,
          table: commits,
        })
      ) as CollectionImpl<Database['commits']>,
      file_changes: createCollection(
        powerSyncCollectionOptions<Database['file_changes']>({
          database: db,
          table: file_changes,
        })
      ) as CollectionImpl<Database['file_changes']>,
      objects: createCollection(
        powerSyncCollectionOptions<Database['objects']>({
          database: db,
          table: objects,
        })
      ) as CollectionImpl<Database['objects']>,
      repositories: createCollection(
        powerSyncCollectionOptions<Database['repositories']>({
          database: db,
          table: repositories,
        })
      ) as CollectionImpl<Database['repositories']>,
      import_jobs: createCollection(
        powerSyncCollectionOptions<Database['import_jobs']>({
          database: db,
          table: import_jobs,
        })
      ) as CollectionImpl<Database['import_jobs']>,
    }
  }, [db])
}
