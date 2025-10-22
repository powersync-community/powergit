-- PowerSync Git metadata tables managed by Supabase migrations
-- Run via `supabase db push` or `supabase db reset`.

create table if not exists public.refs (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  name text not null,
  target_sha text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.commits (
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

create table if not exists public.file_changes (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  commit_sha text not null,
  path text not null,
  additions integer not null,
  deletions integer not null
);

create table if not exists public.objects (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  pack_oid text not null,
  pack_bytes text not null,
  created_at timestamptz not null default now()
);

create index if not exists refs_org_repo_idx on public.refs (org_id, repo_id);
create unique index if not exists refs_org_repo_name_idx on public.refs (org_id, repo_id, name);

create index if not exists commits_org_repo_idx on public.commits (org_id, repo_id);
create unique index if not exists commits_org_repo_sha_idx on public.commits (org_id, repo_id, sha);
create index if not exists commits_author_idx on public.commits (author_email);

create index if not exists file_changes_org_repo_idx on public.file_changes (org_id, repo_id);
create index if not exists file_changes_path_idx on public.file_changes (path);
create unique index if not exists file_changes_commit_path_idx on public.file_changes (org_id, repo_id, commit_sha, path);

create index if not exists objects_recent_idx on public.objects (org_id, repo_id, created_at desc);
create unique index if not exists objects_oid_idx on public.objects (org_id, repo_id, pack_oid);

alter table public.refs enable row level security;
alter table public.commits enable row level security;
alter table public.file_changes enable row level security;
alter table public.objects enable row level security;

create policy allow_all_refs_rw on public.refs
  for all
  using (true)
  with check (true);

create policy allow_all_commits_rw on public.commits
  for all
  using (true)
  with check (true);

create policy allow_all_file_changes_rw on public.file_changes
  for all
  using (true)
  with check (true);

create policy allow_all_objects_rw on public.objects
  for all
  using (true)
  with check (true);
