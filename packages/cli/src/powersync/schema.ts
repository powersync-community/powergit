import { Schema, Table, column } from '@powersync/node'
import { buildPowerSyncSchema, powerSyncSchemaSpec, type PowerSyncColumnType } from '@shared/core'

const { schema: appSchema, tables } = buildPowerSyncSchema<Schema, Table<any>, Pick<typeof column, 'text' | 'integer'>>({
  createSchema: (tableMap) => new Schema(tableMap as Record<string, Table<any>>),
  createTable: (columns, options) => new Table(columns, options),
  column: {
    text: column.text,
    integer: column.integer,
  },
})

export const AppSchema = appSchema
export const PowerSyncTables = tables

export type TableName = keyof typeof powerSyncSchemaSpec
export type TableColumnNames<TName extends TableName> = keyof typeof powerSyncSchemaSpec[TName]['columns']

type ColumnValue<TColumnType extends string> = TColumnType extends 'integer' ? number | null : string | null

export type DatabaseRow<TName extends TableName> = {
  [ColumnName in TableColumnNames<TName>]: ColumnValue<
    Extract<typeof powerSyncSchemaSpec[TName]['columns'][ColumnName], PowerSyncColumnType>
  >
} & { id: string }

export type Database = {
  [Table in TableName]: DatabaseRow<Table>
}
