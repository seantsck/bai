-- 016_web_reader_role
-- Login role for the web server's read pool (BAI_PUBLIC_DATABASE_URL), so the app never holds the owner credential.
--
-- Rules encoded here:
--   * bai_web owns nothing and inherits nothing (NOINHERIT): connected as bai_web, a query sees no BAI object at all.
--   * Its only membership is anon, which it may SET ROLE to. lib/db.ts runs every page query as `set local role anon`
--     inside a read-only transaction, so the app reads exactly what the public anon role may read, and no more.
--   * No password is set here. An operator sets it out of band (see docs/supabase.md); migrations never carry secrets.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bai_web') then
    create role bai_web login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

grant anon to bai_web;
