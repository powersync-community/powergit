
import { column, Schema, Table } from '@powersync/web'
import { buildPowerSyncSchema, powerSyncSchemaSpec } from '@shared/core/powersync/schema'

const { schema: appSchema, tables } = buildPowerSyncSchema<Schema, Table, Pick<typeof column, 'text' | 'integer'>>({
  createSchema: (tableMap) => new Schema(tableMap as Record<string, Table>),
  createTable: (columns, options) => new Table(columns, options),
  column: {
    text: column.text,
    integer: column.integer,
  },
})

type ColumnFactories = Pick<typeof column, 'text' | 'integer'>

type SchemaSpec = typeof powerSyncSchemaSpec

type ColumnDefinitionMap = {
  [K in keyof ColumnFactories]: ColumnFactories[K]
}

type TableColumnSpec<TableName extends keyof SchemaSpec> = SchemaSpec[TableName]['columns']

type TableColumnMap<TableName extends keyof SchemaSpec> = {
  [ColumnName in keyof TableColumnSpec<TableName>]: ColumnDefinitionMap[
    Extract<TableColumnSpec<TableName>[ColumnName], keyof ColumnDefinitionMap>
  ]
}

type SchemaTables = {
  [TableName in keyof SchemaSpec]: Table<TableColumnMap<TableName>>
}

const schemaTableMap = (() => {
  const entries = new Map<string, Table>()
  for (const table of appSchema.tables as Table[]) {
    entries.set(table.name, table)
  }
  return entries
})()

const typedTables = Object.fromEntries(
  Object.keys(powerSyncSchemaSpec).map((tableName) => {
    const table = schemaTableMap.get(tableName)
    if (!table) {
      throw new Error(`PowerSync schema missing table: ${tableName}`)
    }
    return [tableName, table]
  }),
) as SchemaTables

export const AppSchema = appSchema
export const { refs, commits, file_changes, objects } = typedTables

type ColumnValueMap = {
  text: string | null
  integer: number | null
}

type TableRow<TableName extends keyof SchemaSpec> = {
  [ColumnName in keyof TableColumnSpec<TableName>]: ColumnValueMap[
    Extract<TableColumnSpec<TableName>[ColumnName], keyof ColumnValueMap>
  ]
} & { id: string }

type DatabaseFromSpec = {
  [TableName in keyof SchemaSpec]: TableRow<TableName>
}

export type Database = DatabaseFromSpec
