-- Org ACL + repo visibility for Powergit.
-- Introduces orgs/org_members, repo visibility, and replaces "allow_all_*" policies with membership-aware RLS.

-- Orgs
create table if not exists public.orgs (
  id text primary key,
  name text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now()
);

-- Org members (org-scoped roles)
create table if not exists public.org_members (
  org_id text not null,
  user_id uuid not null,
  role text not null default 'read',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index if not exists org_members_user_idx on public.org_members (user_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'org_members_role_check'
  ) then
    alter table public.org_members
      add constraint org_members_role_check check (role in ('admin', 'write', 'read'));
  end if;
end$$;

-- Repo visibility (public/private)
alter table public.repositories
  add column if not exists visibility text not null default 'public';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'repositories_visibility_check'
  ) then
    alter table public.repositories
      add constraint repositories_visibility_check check (visibility in ('public', 'private'));
  end if;
end$$;

-- Import job ownership (used for "queued/running" visibility before repo rows exist)
alter table public.import_jobs
  add column if not exists requested_by uuid;

-- Helper functions (used by both RLS policies and PowerSync sync rules)
create or replace function public.powergit_repo_is_public(org_id text, repo_id text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.repositories r
    where r.org_id = $1
      and r.repo_id = $2
      and r.visibility = 'public'
  );
$$;

create or replace function public.powergit_user_is_org_member(org_id text, user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is distinct from $2 then false
    else exists (
      select 1
      from public.org_members m
      where m.org_id = $1
        and m.user_id = $2
    )
  end;
$$;

create or replace function public.powergit_user_is_org_admin(org_id text, user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is distinct from $2 then false
    else exists (
      select 1
      from public.org_members m
      where m.org_id = $1
        and m.user_id = $2
        and m.role = 'admin'
    )
  end;
$$;

create or replace function public.powergit_user_can_read_repo(org_id text, repo_id text, user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is distinct from $3 then false
    else public.powergit_repo_is_public($1, $2)
      or public.powergit_user_is_org_member($1, $3)
  end;
$$;

create or replace function public.powergit_user_can_write_repo(org_id text, repo_id text, user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is distinct from $3 then false
    else exists (
      select 1
      from public.org_members m
      where m.org_id = $1
        and m.user_id = $3
        and m.role in ('admin', 'write')
    )
  end;
$$;

create or replace function public.powergit_storage_org_id(object_name text)
returns text
language sql
immutable
as $$
  select nullif(split_part($1, '/', 1), '');
$$;

create or replace function public.powergit_storage_repo_id(object_name text)
returns text
language sql
immutable
as $$
  select nullif(split_part($1, '/', 2), '');
$$;

-- Enable RLS (idempotent)
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.repositories enable row level security;
alter table public.import_jobs enable row level security;
alter table public.refs enable row level security;
alter table public.commits enable row level security;
alter table public.file_changes enable row level security;
alter table public.objects enable row level security;

-- Drop legacy open policies
drop policy if exists allow_all_refs_rw on public.refs;
drop policy if exists allow_all_commits_rw on public.commits;
drop policy if exists allow_all_file_changes_rw on public.file_changes;
drop policy if exists allow_all_objects_rw on public.objects;
drop policy if exists allow_all_repositories_rw on public.repositories;
drop policy if exists allow_all_import_jobs_rw on public.import_jobs;

-- Drop legacy storage policies (too permissive)
drop policy if exists git_packs_auth_read on storage.objects;
drop policy if exists git_packs_auth_write on storage.objects;
drop policy if exists git_packs_auth_update on storage.objects;
drop policy if exists git_packs_auth_delete on storage.objects;

-- Orgs policies
drop policy if exists powergit_orgs_select_member on public.orgs;
drop policy if exists powergit_orgs_update_admin on public.orgs;
drop policy if exists powergit_orgs_delete_admin on public.orgs;

create policy powergit_orgs_select_member
  on public.orgs
  for select
  to authenticated
  using (public.powergit_user_is_org_member(id, auth.uid()));

create policy powergit_orgs_update_admin
  on public.orgs
  for update
  to authenticated
  using (public.powergit_user_is_org_admin(id, auth.uid()))
  with check (public.powergit_user_is_org_admin(id, auth.uid()));

create policy powergit_orgs_delete_admin
  on public.orgs
  for delete
  to authenticated
  using (public.powergit_user_is_org_admin(id, auth.uid()));

-- Org members policies
drop policy if exists powergit_org_members_select_member on public.org_members;
drop policy if exists powergit_org_members_admin_insert on public.org_members;
drop policy if exists powergit_org_members_admin_update on public.org_members;
drop policy if exists powergit_org_members_admin_delete on public.org_members;
drop policy if exists powergit_org_members_self_delete on public.org_members;

create policy powergit_org_members_select_member
  on public.org_members
  for select
  to authenticated
  using (public.powergit_user_is_org_member(org_id, auth.uid()));

create policy powergit_org_members_admin_insert
  on public.org_members
  for insert
  to authenticated
  with check (public.powergit_user_is_org_admin(org_id, auth.uid()));

create policy powergit_org_members_admin_update
  on public.org_members
  for update
  to authenticated
  using (public.powergit_user_is_org_admin(org_id, auth.uid()))
  with check (public.powergit_user_is_org_admin(org_id, auth.uid()));

create policy powergit_org_members_admin_delete
  on public.org_members
  for delete
  to authenticated
  using (public.powergit_user_is_org_admin(org_id, auth.uid()));

create policy powergit_org_members_self_delete
  on public.org_members
  for delete
  to authenticated
  using (user_id = auth.uid());

-- Repositories policies
drop policy if exists powergit_repositories_public_read on public.repositories;
drop policy if exists powergit_repositories_member_read on public.repositories;
drop policy if exists powergit_repositories_insert_write on public.repositories;
drop policy if exists powergit_repositories_update_write on public.repositories;
drop policy if exists powergit_repositories_delete_admin on public.repositories;

create policy powergit_repositories_public_read
  on public.repositories
  for select
  to anon, authenticated
  using (visibility = 'public');

create policy powergit_repositories_member_read
  on public.repositories
  for select
  to authenticated
  using (public.powergit_user_is_org_member(org_id, auth.uid()));

create policy powergit_repositories_insert_write
  on public.repositories
  for insert
  to authenticated
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_repositories_update_write
  on public.repositories
  for update
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()))
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_repositories_delete_admin
  on public.repositories
  for delete
  to authenticated
  using (public.powergit_user_is_org_admin(org_id, auth.uid()));

-- Git metadata policies
drop policy if exists powergit_refs_read on public.refs;
drop policy if exists powergit_refs_insert_write on public.refs;
drop policy if exists powergit_refs_update_write on public.refs;
drop policy if exists powergit_refs_delete_write on public.refs;

create policy powergit_refs_read
  on public.refs
  for select
  to anon, authenticated
  using (public.powergit_user_can_read_repo(org_id, repo_id, auth.uid()));

create policy powergit_refs_insert_write
  on public.refs
  for insert
  to authenticated
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_refs_update_write
  on public.refs
  for update
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()))
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_refs_delete_write
  on public.refs
  for delete
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

drop policy if exists powergit_commits_read on public.commits;
drop policy if exists powergit_commits_insert_write on public.commits;
drop policy if exists powergit_commits_update_write on public.commits;
drop policy if exists powergit_commits_delete_write on public.commits;

create policy powergit_commits_read
  on public.commits
  for select
  to anon, authenticated
  using (public.powergit_user_can_read_repo(org_id, repo_id, auth.uid()));

create policy powergit_commits_insert_write
  on public.commits
  for insert
  to authenticated
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_commits_update_write
  on public.commits
  for update
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()))
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_commits_delete_write
  on public.commits
  for delete
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

drop policy if exists powergit_file_changes_read on public.file_changes;
drop policy if exists powergit_file_changes_insert_write on public.file_changes;
drop policy if exists powergit_file_changes_update_write on public.file_changes;
drop policy if exists powergit_file_changes_delete_write on public.file_changes;

create policy powergit_file_changes_read
  on public.file_changes
  for select
  to anon, authenticated
  using (public.powergit_user_can_read_repo(org_id, repo_id, auth.uid()));

create policy powergit_file_changes_insert_write
  on public.file_changes
  for insert
  to authenticated
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_file_changes_update_write
  on public.file_changes
  for update
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()))
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_file_changes_delete_write
  on public.file_changes
  for delete
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

drop policy if exists powergit_objects_read on public.objects;
drop policy if exists powergit_objects_insert_write on public.objects;
drop policy if exists powergit_objects_update_write on public.objects;
drop policy if exists powergit_objects_delete_write on public.objects;

create policy powergit_objects_read
  on public.objects
  for select
  to anon, authenticated
  using (public.powergit_user_can_read_repo(org_id, repo_id, auth.uid()));

create policy powergit_objects_insert_write
  on public.objects
  for insert
  to authenticated
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_objects_update_write
  on public.objects
  for update
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()))
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

create policy powergit_objects_delete_write
  on public.objects
  for delete
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()));

-- Import jobs policies
drop policy if exists powergit_import_jobs_read_requester on public.import_jobs;
drop policy if exists powergit_import_jobs_read_member on public.import_jobs;
drop policy if exists powergit_import_jobs_read_public on public.import_jobs;
drop policy if exists powergit_import_jobs_insert_write on public.import_jobs;
drop policy if exists powergit_import_jobs_update_write on public.import_jobs;
drop policy if exists powergit_import_jobs_delete_admin on public.import_jobs;

create policy powergit_import_jobs_read_requester
  on public.import_jobs
  for select
  to authenticated
  using (requested_by = auth.uid());

create policy powergit_import_jobs_read_member
  on public.import_jobs
  for select
  to authenticated
  using (public.powergit_user_is_org_member(org_id, auth.uid()));

create policy powergit_import_jobs_read_public
  on public.import_jobs
  for select
  to anon, authenticated
  using (public.powergit_repo_is_public(org_id, repo_id));

create policy powergit_import_jobs_insert_write
  on public.import_jobs
  for insert
  to authenticated
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()) or requested_by = auth.uid());

create policy powergit_import_jobs_update_write
  on public.import_jobs
  for update
  to authenticated
  using (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()) or requested_by = auth.uid())
  with check (public.powergit_user_can_write_repo(org_id, repo_id, auth.uid()) or requested_by = auth.uid());

create policy powergit_import_jobs_delete_admin
  on public.import_jobs
  for delete
  to authenticated
  using (public.powergit_user_is_org_admin(org_id, auth.uid()));

-- Storage policies for git packs (path is "${org}/${repo}/${oid}.pack")
drop policy if exists powergit_git_packs_read on storage.objects;
drop policy if exists powergit_git_packs_insert on storage.objects;
drop policy if exists powergit_git_packs_update on storage.objects;
drop policy if exists powergit_git_packs_delete on storage.objects;

create policy powergit_git_packs_read
  on storage.objects
  for select
  to anon, authenticated
  using (
    bucket_id = 'git-packs'
    and public.powergit_user_can_read_repo(
      public.powergit_storage_org_id(name),
      public.powergit_storage_repo_id(name),
      auth.uid()
    )
  );

create policy powergit_git_packs_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'git-packs'
    and public.powergit_user_can_write_repo(
      public.powergit_storage_org_id(name),
      public.powergit_storage_repo_id(name),
      auth.uid()
    )
  );

create policy powergit_git_packs_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'git-packs'
    and public.powergit_user_can_write_repo(
      public.powergit_storage_org_id(name),
      public.powergit_storage_repo_id(name),
      auth.uid()
    )
  )
  with check (
    bucket_id = 'git-packs'
    and public.powergit_user_can_write_repo(
      public.powergit_storage_org_id(name),
      public.powergit_storage_repo_id(name),
      auth.uid()
    )
  );

create policy powergit_git_packs_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'git-packs'
    and public.powergit_user_can_write_repo(
      public.powergit_storage_org_id(name),
      public.powergit_storage_repo_id(name),
      auth.uid()
    )
  );

-- Grants (RLS still applies)
grant select, insert, update, delete on public.orgs to authenticated;
grant select, insert, update, delete on public.org_members to authenticated;

-- Org management RPCs (frontend/CLI)
create or replace function public.powergit_list_my_orgs()
returns table (org_id text, name text, role text, created_at timestamptz)
language sql
stable
as $$
  select m.org_id, o.name, m.role, o.created_at
  from public.org_members m
  left join public.orgs o on o.id = m.org_id
  where m.user_id = auth.uid()
  order by m.org_id;
$$;

grant execute on function public.powergit_list_my_orgs() to authenticated;

create or replace function public.powergit_create_org(org_id text, name text default null)
returns public.orgs
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  normalized text;
  candidate_name text;
  existing public.orgs%rowtype;
  member_count int;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  normalized := lower(trim(org_id));
  if normalized is null or normalized = '' then
    raise exception 'org_id is required.' using errcode = '22023';
  end if;

  if normalized like 'gh-%' or normalized like 'github-%' then
    raise exception 'Org ids starting with "gh-" or "github-" are reserved.' using errcode = '22023';
  end if;

  if normalized !~ '^[a-z0-9][a-z0-9._-]{0,79}$' then
    raise exception 'Invalid org id "%". Use 1-80 chars: [a-z0-9._-].', normalized using errcode = '22023';
  end if;

  candidate_name := nullif(trim(coalesce(name, '')), '');

  select * into existing from public.orgs where id = normalized limit 1;
  if found then
    select count(*) into member_count from public.org_members m where m.org_id = normalized;
    if member_count = 0 then
      update public.orgs
        set
          name = coalesce(candidate_name, public.orgs.name),
          created_by = coalesce(public.orgs.created_by, uid),
          updated_at = now()
        where id = normalized;
      insert into public.org_members (org_id, user_id, role)
        values (normalized, uid, 'admin')
        on conflict on constraint org_members_pkey do update set role = 'admin', updated_at = now();
      select * into existing from public.orgs where id = normalized limit 1;
      return existing;
    end if;
    raise exception 'Org "%" already exists.', normalized using errcode = '23505';
  end if;

  insert into public.orgs (id, name, created_by)
    values (normalized, candidate_name, uid)
    returning * into existing;

  insert into public.org_members (org_id, user_id, role)
    values (normalized, uid, 'admin')
    on conflict on constraint org_members_pkey do update set role = 'admin', updated_at = now();

  return existing;
end;
$$;

grant execute on function public.powergit_create_org(text, text) to authenticated;

create or replace function public.powergit_list_org_members(target_org_id text)
returns table (user_id uuid, email text, role text, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if not public.powergit_user_is_org_member(target_org_id, auth.uid()) then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;

  return query
    select m.user_id,
           u.email::text,
           m.role,
           m.created_at,
           m.updated_at
      from public.org_members m
      join auth.users u on u.id = m.user_id
     where m.org_id = target_org_id
     order by coalesce(u.email::text, ''), m.user_id;
end;
$$;

grant execute on function public.powergit_list_org_members(text) to authenticated;

create or replace function public.powergit_add_org_member(target_org_id text, target_email text, target_role text default 'read')
returns public.org_members
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  normalized_role text;
  lookup_email text;
  target_user uuid;
  result public.org_members%rowtype;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if not public.powergit_user_is_org_admin(target_org_id, uid) then
    raise exception 'Not authorized (admin required).' using errcode = '42501';
  end if;

  lookup_email := lower(trim(coalesce(target_email, '')));
  if lookup_email = '' then
    raise exception 'Email is required.' using errcode = '22023';
  end if;

  normalized_role := lower(trim(coalesce(target_role, 'read')));
  if normalized_role not in ('admin', 'write', 'read') then
    raise exception 'Invalid role "%". Use admin|write|read.', normalized_role using errcode = '22023';
  end if;

  select u.id into target_user
    from auth.users u
   where lower(u.email::text) = lookup_email
   limit 1;

  if target_user is null then
    raise exception 'No user found for "%".', lookup_email using errcode = '22023';
  end if;

  insert into public.org_members (org_id, user_id, role)
    values (target_org_id, target_user, normalized_role)
    on conflict (org_id, user_id) do update
      set role = excluded.role, updated_at = now()
    returning * into result;

  return result;
end;
$$;

grant execute on function public.powergit_add_org_member(text, text, text) to authenticated;

create or replace function public.powergit_remove_org_member(target_org_id text, target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  deleted_count int;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if not public.powergit_user_is_org_admin(target_org_id, uid) then
    raise exception 'Not authorized (admin required).' using errcode = '42501';
  end if;

  delete from public.org_members
   where org_id = target_org_id
     and user_id = target_user_id;

  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

grant execute on function public.powergit_remove_org_member(text, uuid) to authenticated;
