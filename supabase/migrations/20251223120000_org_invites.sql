-- Org member invitations by email.
-- Allows org admins to invite emails that don't yet exist as Supabase users.

create table if not exists public.org_member_invites (
  org_id text not null,
  email text not null,
  role text not null default 'read',
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, email)
);

create index if not exists org_member_invites_email_idx on public.org_member_invites (email);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'org_member_invites_role_check'
  ) then
    alter table public.org_member_invites
      add constraint org_member_invites_role_check check (role in ('admin', 'write', 'read'));
  end if;
end
$$;

alter table public.org_member_invites enable row level security;

create or replace function public.powergit_current_user_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(u.email::text)
  from auth.users u
  where u.id = auth.uid()
  limit 1;
$$;

drop policy if exists powergit_org_invites_select on public.org_member_invites;
drop policy if exists powergit_org_invites_admin_insert on public.org_member_invites;
drop policy if exists powergit_org_invites_admin_update on public.org_member_invites;
drop policy if exists powergit_org_invites_delete on public.org_member_invites;

create policy powergit_org_invites_select
  on public.org_member_invites
  for select
  to authenticated
  using (
    public.powergit_user_is_org_admin(org_id, auth.uid())
    or email = public.powergit_current_user_email()
  );

create policy powergit_org_invites_admin_insert
  on public.org_member_invites
  for insert
  to authenticated
  with check (public.powergit_user_is_org_admin(org_id, auth.uid()));

create policy powergit_org_invites_admin_update
  on public.org_member_invites
  for update
  to authenticated
  using (public.powergit_user_is_org_admin(org_id, auth.uid()))
  with check (public.powergit_user_is_org_admin(org_id, auth.uid()));

create policy powergit_org_invites_delete
  on public.org_member_invites
  for delete
  to authenticated
  using (
    public.powergit_user_is_org_admin(org_id, auth.uid())
    or email = public.powergit_current_user_email()
  );

create or replace function public.powergit_invite_org_member(target_org_id text, target_email text, target_role text default 'read')
returns jsonb
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

  if target_user is not null then
    insert into public.org_members (org_id, user_id, role)
      values (target_org_id, target_user, normalized_role)
      on conflict (org_id, user_id) do update
        set role = excluded.role, updated_at = now()
      returning * into result;

    delete from public.org_member_invites
     where org_id = target_org_id
       and email = lookup_email;

    return jsonb_build_object(
      'status', 'added',
      'org_id', target_org_id,
      'email', lookup_email,
      'role', result.role,
      'user_id', result.user_id
    );
  end if;

  insert into public.org_member_invites (org_id, email, role, invited_by)
    values (target_org_id, lookup_email, normalized_role, uid)
    on conflict (org_id, email) do update
      set role = excluded.role,
          invited_by = excluded.invited_by,
          updated_at = now();

  return jsonb_build_object(
    'status', 'invited',
    'org_id', target_org_id,
    'email', lookup_email,
    'role', normalized_role
  );
end;
$$;

grant execute on function public.powergit_invite_org_member(text, text, text) to authenticated;

create or replace function public.powergit_list_org_invites(target_org_id text)
returns table (email text, role text, invited_by uuid, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if not public.powergit_user_is_org_admin(target_org_id, auth.uid()) then
    raise exception 'Not authorized (admin required).' using errcode = '42501';
  end if;

  return query
    select i.email,
           i.role,
           i.invited_by,
           i.created_at,
           i.updated_at
      from public.org_member_invites i
     where i.org_id = target_org_id
     order by i.created_at desc, i.email;
end;
$$;

grant execute on function public.powergit_list_org_invites(text) to authenticated;

create or replace function public.powergit_list_my_org_invites()
returns table (org_id text, org_name text, role text, invited_by uuid, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  lookup_email text;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  select lower(u.email::text) into lookup_email
    from auth.users u
   where u.id = uid
   limit 1;

  if lookup_email is null or lookup_email = '' then
    return;
  end if;

  return query
    select i.org_id,
           o.name as org_name,
           i.role,
           i.invited_by,
           i.created_at,
           i.updated_at
      from public.org_member_invites i
      left join public.orgs o on o.id = i.org_id
     where i.email = lookup_email
     order by i.created_at desc, i.org_id;
end;
$$;

grant execute on function public.powergit_list_my_org_invites() to authenticated;

create or replace function public.powergit_accept_org_invite(target_org_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  lookup_email text;
  invite_role text;
  deleted_count int;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  select lower(u.email::text) into lookup_email
    from auth.users u
   where u.id = uid
   limit 1;

  if lookup_email is null or lookup_email = '' then
    raise exception 'User email unavailable.' using errcode = '22023';
  end if;

  select i.role into invite_role
    from public.org_member_invites i
   where i.org_id = target_org_id
     and i.email = lookup_email
   limit 1;

  if invite_role is null then
    raise exception 'No pending invite for org "%".', target_org_id using errcode = '22023';
  end if;

  insert into public.org_members (org_id, user_id, role)
    values (target_org_id, uid, invite_role)
    on conflict (org_id, user_id) do update
      set role = excluded.role, updated_at = now();

  delete from public.org_member_invites
   where org_id = target_org_id
     and email = lookup_email;

  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

grant execute on function public.powergit_accept_org_invite(text) to authenticated;

create or replace function public.powergit_cancel_org_invite(target_org_id text, target_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  lookup_email text;
  deleted_count int;
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

  delete from public.org_member_invites
   where org_id = target_org_id
     and email = lookup_email;

  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

grant execute on function public.powergit_cancel_org_invite(text, text) to authenticated;

