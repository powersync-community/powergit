
import * as React from 'react'
import { createCollection } from '@tanstack/react-db'
import { usePowerSync } from '@powersync/react'
import { AppSchema, type Database } from '../ps/schema'

type Collections = {
  refs: any
  commits: any
  file_changes: any
}

export function useCollections(): Collections {
  const db = usePowerSync()
  return React.useMemo(() => {
    // Create simple mock collections for now
    // TODO: Integrate with real PowerSync when ready
    return {
      refs: createCollection({
        getKey: (item: any) => item.id || String(Math.random()),
        sync: {
          sync: () => {
            console.log('Mock sync for refs')
          }
        }
      }),
      commits: createCollection({
        getKey: (item: any) => item.id || String(Math.random()),
        sync: {
          sync: () => {
            console.log('Mock sync for commits')
          }
        }
      }),
      file_changes: createCollection({
        getKey: (item: any) => item.id || String(Math.random()),
        sync: {
          sync: () => {
            console.log('Mock sync for file_changes')
          }
        }
      }),
    }
  }, [db])
}
