-- Fix org create RPC for Postgres plpgsql.variable_conflict=error environments.
-- Earlier deployments used an unqualified `org_id` column reference inside
-- `powergit_create_org`, which collides with the function argument and raises:
--   column reference "org_id" is ambiguous

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
    -- Qualify org_id to avoid ambiguity with the `org_id` function argument.
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
