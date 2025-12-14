-- Ensure PowerSync logical replication publication includes new tables.
-- Without this, PowerSync clients won't receive `repositories` / `import_jobs` updates.

do $$
declare
  pub_all boolean;
begin
  select puballtables into pub_all
  from pg_publication
  where pubname = 'powersync';

  if not found then
    -- Prefer FOR ALL TABLES so future tables replicate automatically.
    create publication powersync for all tables;
    pub_all := true;
  end if;

  if pub_all is distinct from true then
    -- Add missing tables explicitly when the publication is not FOR ALL TABLES.
    begin
      alter publication powersync add table public.repositories;
    exception
      when duplicate_object then
        null;
    end;

    begin
      alter publication powersync add table public.import_jobs;
    exception
      when duplicate_object then
        null;
    end;
  end if;
end$$;

-- Backfill: emit replication events for existing rows (no-op update).
update public.repositories set updated_at = updated_at;
update public.import_jobs set updated_at = updated_at;

