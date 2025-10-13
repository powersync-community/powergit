export type PowerSyncColumnType = 'text' | 'integer'

export interface PowerSyncTableSpec {
  columns: Record<string, PowerSyncColumnType>
  indexes?: Record<string, readonly string[]>
}

export type PowerSyncSchemaSpec = Record<string, PowerSyncTableSpec>

const rawPowerSyncSchemaSpec = {
  refs: {
    columns: {
      id: 'text',
      org_id: 'text',
      repo_id: 'text',
      name: 'text',
      target_sha: 'text',
      updated_at: 'text',
    },
    indexes: {
      id: ['id'],
      org_repo: ['org_id', 'repo_id'],
      name: ['name'],
    },
  },
  commits: {
    columns: {
      id: 'text',
      org_id: 'text',
      repo_id: 'text',
      sha: 'text',
      author_name: 'text',
      author_email: 'text',
      authored_at: 'text',
      message: 'text',
      tree_sha: 'text',
    },
    indexes: {
      id: ['id'],
      org_repo: ['org_id', 'repo_id'],
      author: ['author_email'],
    },
  },
  file_changes: {
    columns: {
      id: 'text',
      org_id: 'text',
      repo_id: 'text',
      commit_sha: 'text',
      path: 'text',
      additions: 'integer',
      deletions: 'integer',
    },
    indexes: {
      id: ['id'],
      org_repo: ['org_id', 'repo_id'],
      path: ['path'],
    },
  },
  objects: {
    columns: {
      id: 'text',
      org_id: 'text',
      repo_id: 'text',
      pack_oid: 'text',
      pack_bytes: 'text',
      created_at: 'text',
    },
    indexes: {
      id: ['id'],
      org_repo_created: ['org_id', 'repo_id', 'created_at'],
      pack_oid: ['pack_oid'],
    },
  },
} as const

const assertPowerSyncSchemaSpec = <TSpec extends PowerSyncSchemaSpec>(spec: TSpec) => spec

export const powerSyncSchemaSpec = assertPowerSyncSchemaSpec(rawPowerSyncSchemaSpec)

export type PowerSyncTableName = keyof typeof powerSyncSchemaSpec

type ColumnFactoryMap<TColumnMap extends Record<PowerSyncColumnType, unknown>> = TColumnMap

export function buildPowerSyncSchema<TSchema, TTable, TColumnMap extends ColumnFactoryMap<Record<PowerSyncColumnType, unknown>>>(
  factories: {
    createSchema: (tables: Record<PowerSyncTableName, TTable>) => TSchema
    createTable: (
      columns: Record<string, TColumnMap[PowerSyncColumnType]>,
      options?: { indexes?: Record<string, string[]> },
    ) => TTable
    column: TColumnMap
  },
): { schema: TSchema; tables: Record<PowerSyncTableName, TTable> } {
  const tables = Object.fromEntries(
    Object.entries(powerSyncSchemaSpec).map(([tableName, spec]) => {
      const columns = Object.fromEntries(
        Object.entries(spec.columns).map(([columnName, columnType]) => {
          const definition = factories.column[columnType]
          if (!definition) throw new Error(`Unsupported PowerSync column type: ${columnType}`)
          return [columnName, definition]
        }),
      ) as Record<string, TColumnMap[PowerSyncColumnType]>

      const options = spec.indexes
        ? {
            indexes: Object.fromEntries(
              Object.entries(spec.indexes).map(([indexName, columnNames]) => [indexName, [...columnNames]]),
            ),
          }
        : undefined
      const tableInstance = factories.createTable(columns, options)
      return [tableName, tableInstance]
    }),
  ) as Record<PowerSyncTableName, TTable>

  return { schema: factories.createSchema(tables), tables }
}
