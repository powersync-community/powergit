-- PowerSync Git metadata tables managed by Supabase migrations.
-- Dev-only: we drop and recreate the PowerSync tables each run so relic views/tables never collide.

do $$
declare relkind char;
begin
  select c.relkind
    into relkind
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'refs'
  limit 1;

  if relkind = 'v' or relkind = 'm' then
    execute 'drop view if exists public.refs cascade';
  elsif relkind = 'r' or relkind = 'p' then
    execute 'drop table if exists public.refs cascade';
  end if;
end
$$;

create table if not exists public.refs (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  name text not null,
  target_sha text not null,
  updated_at timestamptz not null default now()
);

do $$
declare relkind char;
begin
  select c.relkind
    into relkind
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'commits'
  limit 1;

  if relkind = 'v' or relkind = 'm' then
    execute 'drop view if exists public.commits cascade';
  elsif relkind = 'r' or relkind = 'p' then
    execute 'drop table if exists public.commits cascade';
  end if;
end
$$;

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

do $$
declare relkind char;
begin
  select c.relkind
    into relkind
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'file_changes'
  limit 1;

  if relkind = 'v' or relkind = 'm' then
    execute 'drop view if exists public.file_changes cascade';
  elsif relkind = 'r' or relkind = 'p' then
    execute 'drop table if exists public.file_changes cascade';
  end if;
end
$$;

create table if not exists public.file_changes (
  id text primary key,
  org_id text not null,
  repo_id text not null,
  commit_sha text not null,
  path text not null,
  additions integer not null,
  deletions integer not null
);

do $$
declare relkind char;
begin
  select c.relkind
    into relkind
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'objects'
  limit 1;

  if relkind = 'v' or relkind = 'm' then
    execute 'drop view if exists public.objects cascade';
  elsif relkind = 'r' or relkind = 'p' then
    execute 'drop table if exists public.objects cascade';
  end if;
end
$$;

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
