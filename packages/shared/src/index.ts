
export type OrgId = string;
export type RepoId = string;

export interface RefRow { org_id: OrgId; repo_id: RepoId; name: string; target_sha: string; updated_at: string; }
export interface CommitRow { org_id: OrgId; repo_id: RepoId; sha: string; author_name: string; author_email: string; authored_at: string; message: string; tree_sha: string; }
export interface FileChangeRow { org_id: OrgId; repo_id: RepoId; commit_sha: string; path: string; additions: number; deletions: number; }

export const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
export function invariant(cond: any, msg: string): asserts cond { if (!cond) throw new Error(msg); }

export interface ParsedPSUrl { endpoint: string; org: string; repo: string; }
export function parsePowerSyncUrl(url: string): ParsedPSUrl {
  const idx = url.indexOf('::');
  const raw = idx >= 0 ? url.slice(idx+2) : url;
  const u = new URL(raw);
  const parts = u.pathname.split('/').filter(Boolean);
  const orgIdx = parts.indexOf('orgs');
  const repoIdx = parts.indexOf('repos');
  if (orgIdx === -1 || repoIdx === -1 || repoIdx <= orgIdx) throw new Error('Invalid powersync URL');
  return { endpoint: u.origin, org: parts[orgIdx+1], repo: parts[repoIdx+1] };
}

export * from './supabase.js'
