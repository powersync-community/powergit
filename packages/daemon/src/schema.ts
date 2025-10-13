import { Schema, Table, column } from '@powersync/node';
import { buildPowerSyncSchema } from '@shared/core';

const { schema } = buildPowerSyncSchema<Schema, Table<any>, Pick<typeof column, 'text' | 'integer'>>({
  createSchema: (tableMap) => new Schema(tableMap as Record<string, Table<any>>),
  createTable: (columns, options) => new Table(columns, options),
  column: {
    text: column.text,
    integer: column.integer,
  },
});

schema.withRawTables({
  refs: {
    put: {
      sql: `
        INSERT INTO raw_refs (id, org_id, repo_id, name, target_sha, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET
          org_id = excluded.org_id,
          repo_id = excluded.repo_id,
          name = excluded.name,
          target_sha = excluded.target_sha,
          updated_at = excluded.updated_at
      `.trim(),
      params: [
        'Id',
        { Column: 'org_id' },
        { Column: 'repo_id' },
        { Column: 'name' },
        { Column: 'target_sha' },
        { Column: 'updated_at' },
      ],
    },
    delete: {
      sql: 'DELETE FROM raw_refs WHERE id = ?',
      params: ['Id'],
    },
  },
  commits: {
    put: {
      sql: `
        INSERT INTO raw_commits (id, org_id, repo_id, sha, author_name, author_email, authored_at, message, tree_sha)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET
          org_id = excluded.org_id,
          repo_id = excluded.repo_id,
          sha = excluded.sha,
          author_name = excluded.author_name,
          author_email = excluded.author_email,
          authored_at = excluded.authored_at,
          message = excluded.message,
          tree_sha = excluded.tree_sha
      `.trim(),
      params: [
        'Id',
        { Column: 'org_id' },
        { Column: 'repo_id' },
        { Column: 'sha' },
        { Column: 'author_name' },
        { Column: 'author_email' },
        { Column: 'authored_at' },
        { Column: 'message' },
        { Column: 'tree_sha' },
      ],
    },
    delete: {
      sql: 'DELETE FROM raw_commits WHERE id = ?',
      params: ['Id'],
    },
  },
  file_changes: {
    put: {
      sql: `
        INSERT INTO raw_file_changes (id, org_id, repo_id, commit_sha, path, additions, deletions)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET
          org_id = excluded.org_id,
          repo_id = excluded.repo_id,
          commit_sha = excluded.commit_sha,
          path = excluded.path,
          additions = excluded.additions,
          deletions = excluded.deletions
      `.trim(),
      params: [
        'Id',
        { Column: 'org_id' },
        { Column: 'repo_id' },
        { Column: 'commit_sha' },
        { Column: 'path' },
        { Column: 'additions' },
        { Column: 'deletions' },
      ],
    },
    delete: {
      sql: 'DELETE FROM raw_file_changes WHERE id = ?',
      params: ['Id'],
    },
  },
  objects: {
    put: {
      sql: `
        INSERT INTO raw_objects (id, org_id, repo_id, pack_oid, pack_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id)
        DO UPDATE SET
          org_id = excluded.org_id,
          repo_id = excluded.repo_id,
          pack_oid = excluded.pack_oid,
          pack_bytes = excluded.pack_bytes,
          created_at = excluded.created_at
      `.trim(),
      params: [
        'Id',
        { Column: 'org_id' },
        { Column: 'repo_id' },
        { Column: 'pack_oid' },
        { Column: 'pack_bytes' },
        { Column: 'created_at' },
      ],
    },
    delete: {
      sql: 'DELETE FROM raw_objects WHERE id = ?',
      params: ['Id'],
    },
  },
});

export const AppSchema = schema;
