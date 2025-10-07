const rawPowerSyncSchemaSpec = {
    refs: {
        columns: {
            org_id: 'text',
            repo_id: 'text',
            name: 'text',
            target_sha: 'text',
            updated_at: 'text',
        },
        indexes: {
            org_repo: ['org_id', 'repo_id'],
            name: ['name'],
        },
    },
    commits: {
        columns: {
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
            org_repo: ['org_id', 'repo_id'],
            author: ['author_email'],
        },
    },
    file_changes: {
        columns: {
            org_id: 'text',
            repo_id: 'text',
            commit_sha: 'text',
            path: 'text',
            additions: 'integer',
            deletions: 'integer',
        },
        indexes: {
            org_repo: ['org_id', 'repo_id'],
            path: ['path'],
        },
    },
};
const assertPowerSyncSchemaSpec = (spec) => spec;
export const powerSyncSchemaSpec = assertPowerSyncSchemaSpec(rawPowerSyncSchemaSpec);
export function buildPowerSyncSchema(factories) {
    const tables = Object.fromEntries(Object.entries(powerSyncSchemaSpec).map(([tableName, spec]) => {
        const columns = Object.fromEntries(Object.entries(spec.columns).map(([columnName, columnType]) => {
            const definition = factories.column[columnType];
            if (!definition)
                throw new Error(`Unsupported PowerSync column type: ${columnType}`);
            return [columnName, definition];
        }));
        const options = spec.indexes
            ? {
                indexes: Object.fromEntries(Object.entries(spec.indexes).map(([indexName, columnNames]) => [indexName, [...columnNames]])),
            }
            : undefined;
        const tableInstance = factories.createTable(columns, options);
        return [tableName, tableInstance];
    }));
    return { schema: factories.createSchema(tables), tables };
}
