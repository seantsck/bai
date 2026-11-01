-- Reverse of migration 034 (G6D): restores EXACTLY the post-033 state of public.player_aliases. NOT a migration (it is not in database/migrations and the runner never applies it);
-- tests/db/rest-boundary.test.mjs compares the result with a database that never had 034. It REOPENS player_aliases (alias text) to the Data API: run it only for an unexpected
-- website or REST failure, only with the owner's authorization. It leaves the migration ledger alone (034 stays recorded); the correction that follows is a new migration (035).
-- If 033 must also be reversed, run this script first, then docs/transactions/g6b-rollback-033.sql.
begin;
set local lock_timeout = '5s';
grant select on public.player_aliases to anon, authenticated;
drop policy if exists site_read on public.player_aliases;
drop policy if exists public_read on public.player_aliases;
create policy public_read on public.player_aliases for select to anon, authenticated using (true);
revoke select on public.player_aliases from bai_site;        -- bai_site read this table through anon before 034
delete from public.internal_objects where object_name = 'player_aliases' and reason = 'player names and aliases: the website role only (no Data API access)';
commit;
