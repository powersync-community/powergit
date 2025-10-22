import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PowerSyncDatabase } from '@powersync/node';
import { ensureLocalSchema } from '../local-schema.js';
import { createPowerSyncDatabase } from '../database.js';

interface QueryResultRow {
  [key: string]: unknown;
}

async function createEphemeralDatabase(): Promise<{ database: PowerSyncDatabase; dbPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ps-crud-test-'));
  const dbPath = join(dir, 'replica.db');
  const database = await createPowerSyncDatabase({ dbPath });
  await ensureLocalSchema(database);
  return { database, dbPath, dir };
}

async function disposeDatabase(database: PowerSyncDatabase | null, dir: string | null): Promise<void> {
  if (database) {
    await database.close({ disconnect: true }).catch(() => undefined);
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function firstRow<T extends QueryResultRow>(
  database: PowerSyncDatabase,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  return database.writeTransaction(async (tx) => {
    const result = await tx.execute(sql, params);
    const rows: unknown = (result as { rows?: unknown })?.rows;
    if (!rows) return null;
    if (Array.isArray(rows)) {
      return (rows[0] as T | undefined) ?? null;
    }
    const maybeObj = rows as { item?: (index: number) => unknown };
    if (typeof maybeObj.item === 'function') {
      return (maybeObj.item(0) as T | undefined) ?? null;
    }
    return null;
  });
}

interface CrudPayload {
  op: string;
  id: string;
  type: string;
  data?: Record<string, unknown>;
}

async function readLatestCrudPayload(database: PowerSyncDatabase): Promise<CrudPayload | null> {
  const row = await firstRow<{ data: string | null }>(
    database,
    'SELECT data FROM ps_crud ORDER BY id DESC LIMIT 1',
  );
  if (!row?.data) return null;
  return JSON.parse(row.data) as CrudPayload;
}

describe('ensureLocalSchema triggers', () => {
  let database: PowerSyncDatabase | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    await disposeDatabase(database, dir);
    database = null;
    dir = null;
  });

  it('creates triggers that enqueue via powersync_crud', async () => {
    const setup = await createEphemeralDatabase();
    database = setup.database;
    dir = setup.dir;

    const triggerNames = [
      'ps_refs_insert',
      'ps_commits_insert',
      'ps_file_changes_insert',
      'ps_objects_insert',
    ];

    for (const triggerName of triggerNames) {
      const triggerSql = await firstRow<{ sql: string }>(
        database,
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        [triggerName],
      );

      expect(triggerSql?.sql).toBeDefined();
      expect(triggerSql?.sql).toContain('INSERT INTO powersync_crud');
    }
  });

  it('enqueues git metadata table writes through the powersync_crud vtable', async () => {
    const setup = await createEphemeralDatabase();
    database = setup.database;
    dir = setup.dir;

    const now = new Date().toISOString();

    const cases = [
      () => {
        const id = randomUUID();
        const orgId = `org-${id}`;
        const repoId = `repo-${id}`;
        return {
          type: 'refs',
          id,
          insert: {
            sql: `INSERT INTO refs (id, org_id, repo_id, name, target_sha, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [id, orgId, repoId, 'refs/heads/main', 'deadbeef', now],
            expectedData: {
              id,
              org_id: orgId,
              repo_id: repoId,
              name: 'refs/heads/main',
              target_sha: 'deadbeef',
              updated_at: now,
            },
          },
          delete: {
            sql: 'DELETE FROM refs WHERE id = ?',
            args: [id],
          },
        };
      },
      () => {
        const id = randomUUID();
        const orgId = `org-${id}`;
        const repoId = `repo-${id}`;
        const sha = `commit-${id.slice(0, 8)}`;
        return {
          type: 'commits',
          id,
          insert: {
            sql: `INSERT INTO commits (id, org_id, repo_id, sha, author_name, author_email, authored_at, message, tree_sha)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              id,
              orgId,
              repoId,
              sha,
              'Coder',
              'coder@example.com',
              now,
              'Initial commit',
              `tree-${id.slice(0, 8)}`,
            ],
            expectedData: {
              id,
              org_id: orgId,
              repo_id: repoId,
              sha,
              author_name: 'Coder',
              author_email: 'coder@example.com',
              authored_at: now,
              message: 'Initial commit',
              tree_sha: `tree-${id.slice(0, 8)}`,
            },
          },
          delete: {
            sql: 'DELETE FROM commits WHERE id = ?',
            args: [id],
          },
        };
      },
      () => {
        const id = randomUUID();
        const orgId = `org-${id}`;
        const repoId = `repo-${id}`;
        const commitSha = `commit-${id.slice(0, 8)}`;
        return {
          type: 'file_changes',
          id,
          insert: {
            sql: `INSERT INTO file_changes (id, org_id, repo_id, commit_sha, path, additions, deletions)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [id, orgId, repoId, commitSha, 'README.md', 10, 2],
            expectedData: {
              id,
              org_id: orgId,
              repo_id: repoId,
              commit_sha: commitSha,
              path: 'README.md',
              additions: 10,
              deletions: 2,
            },
          },
          delete: {
            sql: 'DELETE FROM file_changes WHERE id = ?',
            args: [id],
          },
        };
      },
      () => {
        const id = randomUUID();
        const orgId = `org-${id}`;
        const repoId = `repo-${id}`;
        return {
          type: 'objects',
          id,
          insert: {
            sql: `INSERT INTO objects (id, org_id, repo_id, pack_oid, pack_bytes, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [id, orgId, repoId, `pack-${id.slice(0, 8)}`, '68656c6c6f', now],
            expectedData: {
              id,
              org_id: orgId,
              repo_id: repoId,
              pack_oid: `pack-${id.slice(0, 8)}`,
              pack_bytes: '68656c6c6f',
              created_at: now,
            },
          },
          delete: {
            sql: 'DELETE FROM objects WHERE id = ?',
            args: [id],
          },
        };
      },
    ] as Array<() => {
      type: string;
      id: string;
      insert: { sql: string; args: unknown[]; expectedData: Record<string, unknown> };
      delete: { sql: string; args: unknown[] };
    }>;

    for (const factory of cases) {
      const testCase = factory();

      await database.writeTransaction(async (tx) => {
        await tx.execute('DELETE FROM ps_crud');
        await tx.execute(testCase.insert.sql, testCase.insert.args);
      });

      const insertPayload = await readLatestCrudPayload(database);
      expect(insertPayload).not.toBeNull();
      expect(insertPayload).toMatchObject({
        op: 'PUT',
        id: testCase.id,
        type: testCase.type,
      });
      expect(insertPayload?.data).toMatchObject(testCase.insert.expectedData);

      await database.writeTransaction(async (tx) => {
        await tx.execute('DELETE FROM ps_crud');
        await tx.execute(testCase.delete.sql, testCase.delete.args);
      });

      const deletePayload = await readLatestCrudPayload(database);
      expect(deletePayload).not.toBeNull();
      expect(deletePayload).toMatchObject({
        op: 'DELETE',
        id: testCase.id,
        type: testCase.type,
      });
      expect(deletePayload?.data).toBeUndefined();
    }
  });
});
