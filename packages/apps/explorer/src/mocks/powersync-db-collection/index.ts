import type { AbstractPowerSyncDatabase } from '@powersync/web'
import type { CollectionConfig, InferSchemaOutput } from '@tanstack/db'

export type PowerSyncCollectionOptions<T extends object, TSchema = never> = {
  database: AbstractPowerSyncDatabase
  tableName: string
  schema?: TSchema
}

export function powerSyncCollectionOptions<T extends object, TSchema = never>(
  config: PowerSyncCollectionOptions<T, TSchema>
): CollectionConfig<T, string, never> & {
  schema?: TSchema
  utils: {
    getMeta: () => { tableName: string; trackedTableName: string }
  }
} {
  // Return a collection config that works with TanStack DB 0.4.3
  return {
    getKey: (item: T) => (item as any).id || (item as any).key || String(Math.random()),
    sync: {
      sync: ({ collection, begin, write, commit }) => {
        // Mock sync implementation for TanStack DB 0.4.3
        console.log('Mock PowerSync sync called for table:', config.tableName)
        begin()
        // In a real implementation, this would sync with PowerSync
        commit()
      },
      getSyncMetadata: () => ({}),
      rowUpdateMode: 'partial' as const
    },
    schema: config.schema,
    utils: {
      getMeta: () => ({
        tableName: config.tableName,
        trackedTableName: `__${config.tableName}_tracking_mock`
      })
    }
  } as CollectionConfig<T, string, never> & {
    schema?: TSchema
    utils: {
      getMeta: () => { tableName: string; trackedTableName: string }
    }
  }
}

export function convertPowerSyncSchemaToSpecs<TSchema = unknown>(
  schema: TSchema
): Record<string, unknown> {
  // Convert PowerSync schema to TanStack DB specs
  // For now, return a simple mapping
  if (typeof schema === 'object' && schema !== null) {
    const specs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      specs[key] = {
        name: key,
        schema: value,
      }
    }
    return specs
  }
  return {}
}

export class PowerSyncTransactor<T extends object = Record<string, unknown>> {
  constructor(private options: { database: AbstractPowerSyncDatabase }) {}

  async applyTransaction(...args: Array<unknown>): Promise<void> {
    // Mock implementation - in real usage this would apply transactions to PowerSync
    console.log('PowerSyncTransactor.applyTransaction called with:', args)
  }
}
