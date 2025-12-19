
export type OrgId = string;
export type RepoId = string;

export interface RefRow { id: string; org_id: OrgId; repo_id: RepoId; name: string; target_sha: string; updated_at: string; }
export interface CommitRow { id: string; org_id: OrgId; repo_id: RepoId; sha: string; author_name: string; author_email: string; authored_at: string; message: string; tree_sha: string; }
export interface FileChangeRow { id: string; org_id: OrgId; repo_id: RepoId; commit_sha: string; path: string; additions: number; deletions: number; }
export interface PackRow {
  id: string;
  org_id: OrgId;
  repo_id: RepoId;
  pack_oid: string;
  storage_key: string;
  size_bytes: number | null;
  created_at: string;
}
export interface RepoSummaryRow {
  org_id: OrgId;
  repo_id: RepoId;
  ref_count: number;
  latest_ref_updated_at: string | null;
}

export const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
export function invariant(cond: any, msg: string): asserts cond { if (!cond) throw new Error(msg); }

export interface ParsedPSUrl {
  endpoint: string;
  basePath: string;
  org: string;
  repo: string;
}
export function parsePowerSyncUrl(url: string): ParsedPSUrl {
  const idx = url.indexOf('::');
  const raw = idx >= 0 ? url.slice(idx+2) : url;
  const u = new URL(raw);
  const parts = u.pathname.split('/').filter(Boolean);
  const orgIdx = parts.lastIndexOf('orgs');
  const repoIdx = parts.lastIndexOf('repos');
  if (orgIdx === -1 || repoIdx === -1 || repoIdx !== orgIdx + 2) throw new Error('Invalid powergit URL');

  const baseSegments = parts.slice(0, orgIdx);
  const org = decodeURIComponent(parts[orgIdx + 1] ?? '');
  const repo = decodeURIComponent(parts[repoIdx + 1] ?? '');
  if (!org || !repo) throw new Error('Invalid powergit URL');

  const basePath = baseSegments.length ? `/${baseSegments.map(segment => encodeURIComponent(segment)).join('/')}` : '';
  return { endpoint: u.origin, basePath, org, repo };
}

export * from './supabase.js'
export * from './powersync/schema.js'
export * from './powersync/streams.js'
export { PROFILE_DEFAULTS, cloneProfileDefaults } from './profile-defaults.js'
export { PowerSyncRemoteClient } from './node.js'
export type { RepoDataSummary } from './node.js'
export * from './git.js'
export * from './importer.js'
export {
  createSupabaseFileStorage,
  clearSupabaseFileStorage,
  resolveSupabaseSessionPath,
  SupabaseFileStorage,
} from './supabase/file-storage.js'
