import { createHash } from 'node:crypto';
import type { PowerSyncDatabase } from '@powersync/node';
import type {
  GitCommitSummary,
  GitPushSummary,
  GitRefSummary,
  PackRow,
  PowerSyncTableName,
  RefRow,
  RepoSummaryRow,
} from '@shared/core';
import { powerSyncSchemaSpec } from '@shared/core/powersync/schema';

type WriteContext = Parameters<Parameters<PowerSyncDatabase['writeTransaction']>[0]>[0];

export interface ListRefsOptions {
  orgId: string;
  repoId: string;
  limit?: number;
}

export async function listRefs(database: PowerSyncDatabase, options: ListRefsOptions): Promise<RefRow[]> {
  const { orgId, repoId, limit } = options;
  const sql = `SELECT org_id, repo_id, name, target_sha, updated_at FROM refs WHERE org_id = ? AND repo_id = ? ORDER BY name ASC`;
  const rows = await database.getAll<RefRow>(sql + (limit ? ' LIMIT ?' : ''), limit ? [orgId, repoId, limit] : [orgId, repoId]);
  return rows;
}

export interface LatestPackOptions {
  orgId: string;
  repoId: string;
}

export async function getLatestPack(database: PowerSyncDatabase, options: LatestPackOptions): Promise<PackRow | null> {
  const { orgId, repoId } = options;
  const sql = `SELECT org_id, repo_id, pack_oid, pack_bytes, created_at FROM objects WHERE org_id = ? AND repo_id = ? ORDER BY COALESCE(created_at, '') DESC, pack_oid DESC LIMIT 1`;
  const row = await database.getOptional<PackRow>(sql, [orgId, repoId]);
  return row;
}

export interface ListReposOptions {
  orgId: string;
  limit?: number;
}

export async function listRepos(database: PowerSyncDatabase, options: ListReposOptions): Promise<RepoSummaryRow[]> {
  const { orgId, limit } = options;
  const sql = `SELECT org_id, repo_id, COUNT(*) AS ref_count, MAX(updated_at) AS latest_ref_updated_at FROM refs WHERE org_id = ? GROUP BY org_id, repo_id ORDER BY repo_id ASC`;
  const rows = await database.getAll<RepoSummaryRow>(sql + (limit ? ' LIMIT ?' : ''), limit ? [orgId, limit] : [orgId]);
  return rows.map((row) => ({
    org_id: row.org_id,
    repo_id: row.repo_id,
    ref_count: Number(row.ref_count) || 0,
    latest_ref_updated_at: row.latest_ref_updated_at ?? null,
  }));
}

export async function getRepoSummary(
  database: PowerSyncDatabase,
  options: { orgId: string; repoId: string },
): Promise<{ orgId: string; repoId: string; counts: Record<PowerSyncTableName, number> }> {
  const { orgId, repoId } = options;
  const counts = {} as Record<PowerSyncTableName, number>;

  for (const tableName of Object.keys(powerSyncSchemaSpec) as PowerSyncTableName[]) {
    const row = await database.getOptional<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${tableName} WHERE org_id = ? AND repo_id = ?`,
      [orgId, repoId],
    );
    counts[tableName] = Number(row?.count ?? 0);
  }

  return { orgId, repoId, counts };
}

export interface PushUpdateRow {
  src: string;
  dst: string;
  force?: boolean;
}

export interface PersistPushOptions {
  orgId: string;
  repoId: string;
  updates: PushUpdateRow[];
  packBase64?: string;
  packEncoding?: string;
  packOid?: string;
  summary?: GitPushSummary | null;
  createdAt?: string;
  dryRun?: boolean;
}

export interface PersistPushResult {
  ok: boolean;
  results: Record<string, { status: 'ok' | 'error'; message?: string }>;
  packOid?: string;
  packSize?: number;
}

function refId(orgId: string, repoId: string, name: string): string {
  return `${orgId}/${repoId}/${name}`;
}

function commitId(orgId: string, repoId: string, sha: string): string {
  return `${orgId}/${repoId}/${sha}`;
}

function fileChangeId(orgId: string, repoId: string, commitSha: string, path: string): string {
  return `${orgId}/${repoId}/${commitSha}/${path}`;
}

function packId(orgId: string, repoId: string, packOid: string): string {
  return `${orgId}/${repoId}/${packOid}`;
}

export async function persistPush(database: PowerSyncDatabase, options: PersistPushOptions): Promise<PersistPushResult> {
  const { orgId, repoId, updates } = options;
  if (!Array.isArray(updates) || updates.length === 0) {
    return {
      ok: true,
      results: {},
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      results: buildUpdateResults(updates),
    };
  }

  let resolvedPackOid = sanitizeOid(options.packOid);
  let packSize: number | undefined;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const packBase64 = options.packBase64 && options.packBase64.length > 0 ? options.packBase64 : undefined;

  if (packBase64) {
    const encoding = (options.packEncoding ?? 'base64').toLowerCase();
    if (encoding !== 'base64') {
      throw new Error(`Unsupported pack encoding: ${encoding}`);
    }
    const packBuffer = Buffer.from(packBase64, 'base64');
    packSize = packBuffer.length;
    if (!resolvedPackOid) {
      resolvedPackOid = createHash('sha1').update(packBuffer).digest('hex');
    }
  }

  const summary = sanitizePushSummary(options.summary);

  await database.writeTransaction(async (tx: WriteContext) => {
    if (packBase64 && resolvedPackOid) {
      const id = packId(orgId, repoId, resolvedPackOid);
      await tx.execute('DELETE FROM objects WHERE id = ?', [id]);
      await tx.execute(
        `INSERT INTO objects (id, org_id, repo_id, pack_oid, pack_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, orgId, repoId, resolvedPackOid, packBase64, createdAt],
      );
    }

    if (summary) {
      console.info('[powersync-daemon] persistPush summary', {
        orgId,
        repoId,
        refs: summary.refs?.length ?? 0,
        commits: summary.commits?.length ?? 0,
      });
      await applyRefUpdates(tx, orgId, repoId, summary.refs, summary.head);
      await applyCommitUpdates(tx, orgId, repoId, summary.commits);
    }
  });

  return {
    ok: true,
    results: buildUpdateResults(updates),
    packOid: resolvedPackOid,
    packSize,
  };
}

function sanitizeOid(value?: string | null): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizePushSummary(
  summary: GitPushSummary | null | undefined,
): ({ head?: string; refs: GitRefSummary[]; commits: GitCommitSummary[] }) | null {
  if (!summary || typeof summary !== 'object') return null;
  const refs = Array.isArray(summary.refs)
    ? summary.refs
        .map((ref) => ({
          name: typeof ref?.name === 'string' ? ref.name : '',
          target: typeof ref?.target === 'string' ? ref.target : '',
        }))
        .filter((ref) => ref.name.length > 0)
    : [];
  const commits = Array.isArray(summary.commits)
    ? summary.commits
        .map((commit) => ({
          sha: typeof commit?.sha === 'string' ? commit.sha : '',
          tree: typeof commit?.tree === 'string' ? commit.tree : '',
          author_name: typeof commit?.author_name === 'string' ? commit.author_name : '',
          author_email: typeof commit?.author_email === 'string' ? commit.author_email : '',
          authored_at: typeof commit?.authored_at === 'string' ? commit.authored_at : new Date().toISOString(),
          message: typeof commit?.message === 'string' ? commit.message : '',
          parents: Array.isArray(commit?.parents)
            ? commit.parents.filter((parent): parent is string => typeof parent === 'string')
            : [],
          files: Array.isArray(commit?.files)
            ? commit.files
                .map((file) => ({
                  path: typeof file?.path === 'string' ? file.path : '',
                  additions: Number.isFinite(file?.additions) ? Number(file?.additions) : 0,
                  deletions: Number.isFinite(file?.deletions) ? Number(file?.deletions) : 0,
                }))
                .filter((file) => file.path.length > 0)
            : [],
        }))
        .filter((commit) => commit.sha.length > 0)
    : [];

  const head = typeof summary.head === 'string' && summary.head.trim().length > 0 ? summary.head : undefined;

  return { head, refs, commits };
}

async function applyRefUpdates(
  tx: WriteContext,
  orgId: string,
  repoId: string,
  refs: GitRefSummary[],
  head?: string,
): Promise<void> {
  const nowIso = new Date().toISOString();

  for (const ref of refs) {
    const name = typeof ref.name === 'string' ? ref.name : '';
    if (!name) continue;
    const target = typeof ref.target === 'string' ? ref.target : '';
    const rowId = refId(orgId, repoId, name);

    if (!target || isZeroSha(target)) {
      await tx.execute('DELETE FROM refs WHERE id = ?', [rowId]);
      continue;
    }

    await tx.execute('DELETE FROM refs WHERE id = ?', [rowId]);
    await tx.execute(
      `INSERT INTO refs (id, org_id, repo_id, name, target_sha, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [rowId, orgId, repoId, name, target, nowIso],
    );
  }

  if (head && head.length > 0) {
    const headId = refId(orgId, repoId, 'HEAD');
    await tx.execute('DELETE FROM refs WHERE id = ?', [headId]);
    await tx.execute(
      `INSERT INTO refs (id, org_id, repo_id, name, target_sha, updated_at)
       VALUES (?, ?, ?, 'HEAD', ?, ?)`,
      [headId, orgId, repoId, head, nowIso],
    );
  }
}

async function applyCommitUpdates(
  tx: WriteContext,
  orgId: string,
  repoId: string,
  commits: GitCommitSummary[],
): Promise<void> {
  if (!commits.length) {
    await tx.execute('DELETE FROM file_changes WHERE org_id = ? AND repo_id = ?', [orgId, repoId]);
    await tx.execute('DELETE FROM commits WHERE org_id = ? AND repo_id = ?', [orgId, repoId]);
    return;
  }

  await tx.execute('DELETE FROM file_changes WHERE org_id = ? AND repo_id = ?', [orgId, repoId]);
  await tx.execute('DELETE FROM commits WHERE org_id = ? AND repo_id = ?', [orgId, repoId]);

  for (const commit of commits) {
    if (!commit || !commit.sha) continue;
    const commitRowId = commitId(orgId, repoId, commit.sha);
    await tx.execute(
      `INSERT INTO commits (id, org_id, repo_id, sha, author_name, author_email, authored_at, message, tree_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        commitRowId,
        orgId,
        repoId,
        commit.sha,
        commit.author_name ?? '',
        commit.author_email ?? '',
        commit.authored_at ?? new Date().toISOString(),
        commit.message ?? '',
        commit.tree ?? '',
      ],
    );

    if (Array.isArray(commit.files)) {
      for (const file of commit.files) {
        if (!file || !file.path) continue;
        const additions = Number.isFinite(file.additions) ? Number(file.additions) : 0;
        const deletions = Number.isFinite(file.deletions) ? Number(file.deletions) : 0;
        const fileRowId = fileChangeId(orgId, repoId, commit.sha, file.path);
        await tx.execute(
          `INSERT INTO file_changes (id, org_id, repo_id, commit_sha, path, additions, deletions)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [fileRowId, orgId, repoId, commit.sha, file.path, additions, deletions],
        );
      }
    }
  }
}

function isZeroSha(value: string): boolean {
  return value === '0000000000000000000000000000000000000000';
}

function buildUpdateResults(updates: PushUpdateRow[]): Record<string, { status: 'ok' }> {
  return Object.fromEntries(updates.map((update) => [update.dst ?? '', { status: 'ok' as const }]));
}
