import { Schema, Table, column } from '@powersync/node';
import { buildPowerSyncSchema } from '@shared/core/powersync/schema';

const { schema } = buildPowerSyncSchema<Schema, Table<any>, Pick<typeof column, 'text' | 'integer'>>({
  createSchema: (tableMap) => new Schema(tableMap as Record<string, Table<any>>),
  createTable: (columns, options) => new Table(columns, options),
  column: {
    text: column.text,
    integer: column.integer,
  },
});

export const AppSchema = schema;
