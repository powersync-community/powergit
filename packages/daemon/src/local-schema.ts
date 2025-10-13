import type { PowerSyncDatabase } from '@powersync/node';

const TABLE_SPECS = [
  {
    name: 'refs',
    baseTable: 'raw_refs',
    selectColumns: ['name', 'target_sha', 'updated_at'],
    createTable: `
      CREATE TABLE IF NOT EXISTS raw_refs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        name TEXT NOT NULL,
        target_sha TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_raw_refs_org_repo ON raw_refs(org_id, repo_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_refs_org_repo_name ON raw_refs(org_id, repo_id, name);
    `,
  },
  {
    name: 'commits',
    baseTable: 'raw_commits',
    selectColumns: ['sha', 'author_name', 'author_email', 'authored_at', 'message', 'tree_sha'],
    createTable: `
      CREATE TABLE IF NOT EXISTS raw_commits (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        authored_at TEXT NOT NULL,
        message TEXT NOT NULL,
        tree_sha TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_raw_commits_org_repo ON raw_commits(org_id, repo_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_commits_org_repo_sha ON raw_commits(org_id, repo_id, sha);
      CREATE INDEX IF NOT EXISTS idx_raw_commits_author_email ON raw_commits(author_email);
    `,
  },
  {
    name: 'file_changes',
    baseTable: 'raw_file_changes',
    selectColumns: ['commit_sha', 'path', 'additions', 'deletions'],
    createTable: `
      CREATE TABLE IF NOT EXISTS raw_file_changes (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        path TEXT NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_raw_file_changes_org_repo ON raw_file_changes(org_id, repo_id);
      CREATE INDEX IF NOT EXISTS idx_raw_file_changes_path ON raw_file_changes(path);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_file_changes_commit_path ON raw_file_changes(org_id, repo_id, commit_sha, path);
    `,
  },
  {
    name: 'objects',
    baseTable: 'raw_objects',
    selectColumns: ['pack_oid', 'pack_bytes', 'created_at'],
    createTable: `
      CREATE TABLE IF NOT EXISTS raw_objects (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        pack_oid TEXT NOT NULL,
        pack_bytes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_raw_objects_org_repo_created ON raw_objects(org_id, repo_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_objects_oid ON raw_objects(org_id, repo_id, pack_oid);
    `,
  },
] as const;

async function ensureTableAndTriggers(database: PowerSyncDatabase, spec: typeof TABLE_SPECS[number]): Promise<void> {
  await database.writeTransaction(async (tx) => {
    await tx.execute(`DROP VIEW IF EXISTS ${spec.name};`);
    await tx.execute(`DROP TABLE IF EXISTS ${spec.name};`);
    const statements = spec.createTable
      .split(';')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    for (const statement of statements) {
      await tx.execute(statement);
    }
    const projections = ['id', 'org_id', 'repo_id', ...spec.selectColumns].join(', ');
    await tx.execute(
      `CREATE VIEW ${spec.name} AS
        SELECT ${projections}
        FROM ${spec.baseTable};`,
    );
  });
}

export async function ensureLocalSchema(database: PowerSyncDatabase): Promise<void> {
  for (const spec of TABLE_SPECS) {
    await ensureTableAndTriggers(database, spec);
  }
}
