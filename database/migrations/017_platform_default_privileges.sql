-- 017_platform_default_privileges
-- Hosted Supabase projects created before the 2026 Data API change carry default privileges (pg_default_acl) that grant
-- anon, authenticated and service_role full access to every table, sequence and function `postgres` creates in public.
-- BAI's boundary (011/012) already revokes tables, views and functions from anon and authenticated object by object, but
-- the defaults still left identity sequences usable by anon (including setval) and gave service_role grants it has
-- nowhere else. Supabase applies this same revoke to every existing project on 2026-10-30; BAI opts in now so that a
-- hosted database carries exactly the grants a local replay does.
--
-- Rules encoded here:
--   * No default privileges for the platform roles on objects BAI creates in public. Every grant is explicit
--     (011/012 apply_public_boundary: SELECT for anon/authenticated on non-internal tables and views, nothing else).
--   * Sequences are never usable by the platform roles; public roles never insert.
--   * service_role holds no grants on BAI objects. BAI never uses a secret/service-role key.
--   * Platform-owned functions in public (event-trigger handlers such as Supabase's rls_auto_enable) are left alone.
-- On plain PostgreSQL (local replays) none of these privileges exist, so every statement is a no-op.

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;

revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all tables in schema public from service_role;

do $$
declare
  f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and not exists (select 1 from pg_event_trigger e where e.evtfoid = p.oid)
             and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') loop
    execute format('revoke all on function %s from service_role', f.sig);
  end loop;
end $$;
