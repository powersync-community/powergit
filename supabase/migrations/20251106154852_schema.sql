-- PowerSync Git metadata tables
-- Production-safe: no destructive drops; idempotent creates.

-- Refs
create table if not exists public.refs (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  name text not null,
  target_sha text not null,
  updated_at timestamptz not null default now()
);

-- Commits
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

-- File changes
create table if not exists public.file_changes (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  commit_sha text not null,
  path text not null,
  additions integer not null,
  deletions integer not null
);

-- Pack metadata
create table if not exists public.objects (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  pack_oid text not null,
  storage_key text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now()
);

-- Indexes
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

-- RLS
alter table public.refs enable row level security;
alter table public.commits enable row level security;
alter table public.file_changes enable row level security;
alter table public.objects enable row level security;

-- Policies (dev-friendly defaults: open RW)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'refs' and policyname = 'allow_all_refs_rw') then
    create policy allow_all_refs_rw on public.refs for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commits' and policyname = 'allow_all_commits_rw') then
    create policy allow_all_commits_rw on public.commits for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'file_changes' and policyname = 'allow_all_file_changes_rw') then
    create policy allow_all_file_changes_rw on public.file_changes for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'objects' and policyname = 'allow_all_objects_rw') then
    create policy allow_all_objects_rw on public.objects for all using (true) with check (true);
  end if;
end$$;
