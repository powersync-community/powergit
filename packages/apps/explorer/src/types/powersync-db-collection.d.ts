declare module '@tanstack/powersync-db-collection' {
  import type { AbstractPowerSyncDatabase } from '@powersync/web'
  import type { CollectionConfig } from '@tanstack/db'

  export type PowerSyncCollectionOptions<T extends object> = {
    database: AbstractPowerSyncDatabase
    tableName: string
    schema?: unknown
  }

  export function powerSyncCollectionOptions<T extends object>(
    config: PowerSyncCollectionOptions<T>
  ): CollectionConfig<T>

  export function convertPowerSyncSchemaToSpecs<TSchema = unknown>(
    schema: TSchema
  ): Record<string, unknown>

  export class PowerSyncTransactor<T extends object = Record<string, unknown>> {
    constructor(options: { database: AbstractPowerSyncDatabase })
    applyTransaction(...args: Array<unknown>): Promise<void>
  }
}
