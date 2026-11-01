-- 034_player_aliases_boundary
-- public.player_aliases (alias text: player names) leaves the Data API, as the raw identity tables did in 033. Requires 033. Does not touch 001-033, any row, any other relation,
-- the raw historical transaction data or the import batches. (031 is reserved.)
--
-- WHY. BAI's public product is the website, not a supported raw-data API. An alias is a name for a player; nothing on the website reads the table directly (v_source_attribution
-- counts it, and that view is already the website role's since 033), and no consumer was found (repository, and hosted request statistics for the 13 days before this migration).
-- The import pipeline writes aliases for any record that carries them, so a future Retrosheet-associated alias would otherwise be public the moment it is imported.
--
-- WHAT (exactly, the 033 model, for this one table): GRANT SELECT to bai_site (explicit); REVOKE ALL from PUBLIC, anon and authenticated; the policy public_read (anon,
-- authenticated) is replaced by site_read (bai_site); the table is registered in public.internal_objects so that every later apply_public_boundary() keeps it closed.
-- 033's ingest.promotion_readers() already counts bai_site as a reader when it holds a grant directly, so the emergency procedure handles this table with no change.
--
-- LOCKS. One short ACCESS EXCLUSIVE lock on one table (a few milliseconds, no rewrite). RECOVERY. One transaction: a failure rolls back to the 033 state;
-- after commit docs/transactions/g6d-rollback-034.sql restores the post-033 state exactly.

do $$
begin
  if to_regprocedure('ingest.promotion_readers(regclass)') is null or not exists (select 1 from pg_roles where rolname = 'bai_site') then
    raise exception '034 requires 033 (ingest.promotion_readers and the role bai_site)';
  end if;
  if to_regclass('public.player_aliases') is null then raise exception '034: public.player_aliases does not exist'; end if;
  grant select on public.player_aliases to bai_site;
  revoke all on public.player_aliases from public, anon, authenticated;
  drop policy if exists public_read on public.player_aliases;
  drop policy if exists site_read on public.player_aliases;
  create policy site_read on public.player_aliases for select to bai_site using (true);
  insert into public.internal_objects (object_name, reason) values ('player_aliases', 'player names and aliases: the website role only (no Data API access)') on conflict do nothing;
end $$;
