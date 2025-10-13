-- PowerSync Git metadata tables managed by Supabase migrations
-- Run via `supabase db push` or `supabase db reset`.

drop table if exists public.refs cascade;
create table if not exists public.raw_refs (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  name text not null,
  target_sha text not null,
  updated_at timestamptz not null default now()
);

drop table if exists public.commits cascade;
create table if not exists public.raw_commits (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  sha text not null,
  author_name text not null,
  author_email text not null,
  authored_at timestamptz not null,
  message text not null,
  tree_sha text not null
);

drop table if exists public.file_changes cascade;
create table if not exists public.raw_file_changes (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  commit_sha text not null,
  path text not null,
  additions integer not null,
  deletions integer not null
);

drop table if exists public.git_packs cascade;
create table if not exists public.raw_objects (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  pack_oid text not null,
  pack_bytes text not null,
  created_at timestamptz not null default now()
);

create index if not exists raw_refs_org_repo_idx on public.raw_refs (org_id, repo_id);
create unique index if not exists raw_refs_org_repo_name_idx on public.raw_refs (org_id, repo_id, name);

create index if not exists raw_commits_org_repo_idx on public.raw_commits (org_id, repo_id);
create unique index if not exists raw_commits_org_repo_sha_idx on public.raw_commits (org_id, repo_id, sha);
create index if not exists raw_commits_author_idx on public.raw_commits (author_email);

create index if not exists raw_file_changes_org_repo_idx on public.raw_file_changes (org_id, repo_id);
create index if not exists raw_file_changes_path_idx on public.raw_file_changes (path);
create unique index if not exists raw_file_changes_commit_path_idx on public.raw_file_changes (org_id, repo_id, commit_sha, path);

create index if not exists raw_objects_recent_idx on public.raw_objects (org_id, repo_id, created_at desc);
create unique index if not exists raw_objects_oid_idx on public.raw_objects (org_id, repo_id, pack_oid);

create or replace view public.refs as
  select id, org_id, repo_id, name, target_sha, updated_at
  from public.raw_refs;

create or replace view public.commits as
  select id, org_id, repo_id, sha, author_name, author_email, authored_at, message, tree_sha
  from public.raw_commits;

create or replace view public.file_changes as
  select id, org_id, repo_id, commit_sha, path, additions, deletions
  from public.raw_file_changes;

create or replace view public.git_packs as
  select id, org_id, repo_id, pack_oid, pack_bytes, created_at
  from public.raw_objects;
