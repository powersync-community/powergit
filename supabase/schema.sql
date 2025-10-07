-- PowerSync Git metadata tables managed by Supabase migrations
-- Run via `supabase db push` or `supabase db reset`.

create table if not exists public.refs (
  org_id text not null,
  repo_id text not null,
  name text not null,
  target_sha text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, repo_id, name)
);

create table if not exists public.commits (
  org_id text not null,
  repo_id text not null,
  sha text not null,
  author_name text not null,
  author_email text not null,
  authored_at timestamptz not null,
  message text not null,
  tree_sha text not null,
  primary key (org_id, repo_id, sha)
);

create table if not exists public.file_changes (
  org_id text not null,
  repo_id text not null,
  commit_sha text not null,
  path text not null,
  additions integer not null,
  deletions integer not null,
  primary key (org_id, repo_id, commit_sha, path)
);

create table if not exists public.git_packs (
  org_id text not null,
  repo_id text not null,
  pack_oid text not null,
  pack_bytes bytea not null,
  created_at timestamptz not null default now(),
  primary key (org_id, repo_id, pack_oid)
);

create index if not exists refs_org_repo_idx on public.refs (org_id, repo_id);
create index if not exists commits_org_repo_idx on public.commits (org_id, repo_id);
create index if not exists commits_author_idx on public.commits (author_email);
create index if not exists file_changes_org_repo_idx on public.file_changes (org_id, repo_id);
create index if not exists file_changes_path_idx on public.file_changes (path);
create index if not exists git_packs_recent_idx on public.git_packs (org_id, repo_id, created_at desc);
