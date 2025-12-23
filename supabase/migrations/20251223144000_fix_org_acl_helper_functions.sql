-- Fix org ACL helper functions for RLS recursion.
-- Older deployments defined these helpers as INVOKER functions, but they are used inside RLS
-- policies for `org_members`, causing infinite recursion and:
--   stack depth limit exceeded
--
-- This migration replaces the helpers with SECURITY DEFINER variants that (a) avoid recursion by
-- bypassing RLS as the table owner and (b) refuse checks for other users by validating auth.uid().

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

grant execute on function public.powergit_user_is_org_member(text, uuid) to anon, authenticated, service_role;
grant execute on function public.powergit_user_is_org_admin(text, uuid) to anon, authenticated, service_role;
grant execute on function public.powergit_user_can_read_repo(text, text, uuid) to anon, authenticated, service_role;
grant execute on function public.powergit_user_can_write_repo(text, text, uuid) to anon, authenticated, service_role;
