
import { column, Schema, Table } from '@powersync/web'
import { buildPowerSyncSchema, powerSyncSchemaSpec } from '@shared/core'

const { schema, tables } = buildPowerSyncSchema<Schema, Table, Pick<typeof column, 'text' | 'integer'>>({
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

const typedTables = tables as SchemaTables
const typedSchema = schema as Schema<SchemaTables>

export const AppSchema = typedSchema
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
