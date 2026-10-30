-- 032_source_display_release
-- A public display release, separate from the publication grant, so Retrosheet-derived rows can be imported and stay invisible to public roles.
-- (031 is reserved by docs/transactions/later-added/proposal.md.) Additive: with no RETROSHEET source on the database, every public read returns what it did.
--
-- Why the grant is not enough. A grant (025) only governs the transaction read model (030). An import also writes tables the public roles can read directly
-- (players, player_external_ids, source_observations, coverage_assessments, sources), and refresh_read_models() copies counts from them into public summaries.
--
-- The model. The default state is HELD.
--   * A RETROSHEET source's rows are public only while public.source_display_releases holds a row for THAT source. The row needs the category's grant (a foreign
--     key, ON DELETE CASCADE), names the exact batch files approved (approved_batch_sha256) and is refused unless they are exactly the applied batches citing it.
--   * A later file has a new source row, so it stays held. While any release of the category exists, a batch outside the approved lineage cannot be applied.
--   * players follow their name observation: a player is public only with a visible full_name observation, so a player known only through a held source is hidden,
--     and a player another source also names stays public. Ids follow the player and their own source. Everything public is decided by RLS, read live, so the
--     security_invoker views follow it with no change, and no function is callable by a public role.
--   * Withdrawal (deleting the release or its grant) hides the live rows at once, and a trigger scrubs the cached summaries and withdraws the read model in the same
--     transaction, so no reader sees a stale summary after the commit. The refreshes take a lock on the release table, so a refresh cannot republish past a withdrawal.
--   * A released source publishes its approved batches only: a row citing it is writable only by an apply of an approved batch (below), and the Data API refuses the
--     planner-based counts that would show how many held rows exist.

create table public.source_display_releases (
  source_id bigint primary key references public.sources (id),
  attribution_category text not null references ingest.source_publication_grants (attribution_category) on delete cascade,
  approved_batch_sha256 text[] not null check (cardinality(approved_batch_sha256) > 0),
  basis_reference text not null check (length(trim(basis_reference)) > 0),
  released_by text not null default session_user,
  released_at timestamptz not null default now(),
  check (attribution_category = 'RETROSHEET')
);
comment on table public.source_display_releases is 'Public display release of one gated source (032). Empty means HELD. Written only by the owner; public roles can read it because the row-level policies of the gated tables read it, and it only ever holds what has been released.';

-- ---------------------------------------------------------------------------------------------------------------
-- The owner's view of the gate (never executable by a public role: apply_public_boundary revokes it)
-- ---------------------------------------------------------------------------------------------------------------

create function public.display_held_source_ids() returns setof bigint
language sql stable
set search_path = pg_catalog, public
as $$
  select s.id from public.sources s
  where s.attribution_category = 'RETROSHEET' and not exists (select 1 from public.source_display_releases r where r.source_id = s.id)
$$;

-- Corrects every cached public summary to what the live policies show. Absolute values, so it is safe to run twice. It raises nothing of its own: a withdrawal must not
-- depend on a read model's validation rules.
create function public.rm_apply_display_gate() returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  create temporary table _held on commit drop as select id from public.display_held_source_ids() as t(id);
  create temporary table _held_cov on commit drop as select c.id from public.coverage_assessments c where c.source_id in (select id from _held);

  delete from public.rm_coverage_summary where coverage_assessment_id in (select id from _held_cov);

  update public.rm_overview set
    players = (select count(*) from public.players p where exists (select 1 from public.source_observations o where o.subject_table = 'players' and o.subject_id = p.id and o.field_name = 'full_name' and o.source_id not in (select id from _held))),
    sources = (select count(*) from public.sources where id not in (select id from _held)),
    coverage_assessments = (select count(*) from public.coverage_assessments where id not in (select id from _held_cov)),
    population_rate_scopes = (select count(*) from public.coverage_assessments where id not in (select id from _held_cov) and public.coverage_supports_population_rate(coverage_state));

  update public.rm_organization_summary s set
    coverage_assessments = (select count(*) from public.coverage_assessments c where c.organization_id = s.organization_id and c.id not in (select id from _held_cov)),
    population_rate_scopes = (select count(*) from public.coverage_assessments c where c.organization_id = s.organization_id and c.id not in (select id from _held_cov) and public.coverage_supports_population_rate(c.coverage_state));

  update public.rm_research_queue_summary s set open_items = (
    select count(*) from public.v_research_queue q
    where q.queue_key = s.queue_key
      and not (q.subject_table = 'coverage_assessments' and q.subject_id in (select id from _held_cov))
      and not (q.queue_key = 'SOURCE_CONFLICT' and exists (select 1 from public.source_observations o where o.subject_table = q.subject_table and o.subject_id = q.subject_id and o.source_id in (select id from _held)))
      and not (q.queue_key = 'IDENTITY_AMBIGUOUS' and exists (select 1 from ingest.staged_records r join ingest.staged_sources ss on ss.batch_id = r.batch_id join public.sources h on h.source_key = ss.source_key
                 where r.id = q.subject_id and h.id in (select id from _held))));
  drop table _held_cov; drop table _held;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Writing a release: immutable, exact lineage, and withdrawal that fails closed
-- ---------------------------------------------------------------------------------------------------------------

create function public.source_display_release_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_applied text[];
  v_key text;
begin
  if tg_op = 'UPDATE' then raise exception 'a display release is immutable: withdraw it and record a new one' using errcode = 'check_violation'; end if;
  select source_key into v_key from public.sources s where s.id = new.source_id and s.attribution_category = new.attribution_category;
  if v_key is null then raise exception 'source % is not in category %', new.source_id, new.attribution_category using errcode = 'check_violation'; end if;
  select coalesce(array_agg(distinct b.file_sha256 order by b.file_sha256), '{}') into v_applied
  from ingest.import_batches b join ingest.staged_sources ss on ss.batch_id = b.id where ss.source_key = v_key and b.status = 'APPLIED';
  if v_applied is distinct from (select array_agg(distinct x order by x) from unnest(new.approved_batch_sha256) x) then
    raise exception 'the approved lineage of % is not exactly the batches applied from it (applied: %)', v_key, cardinality(v_applied) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger source_display_releases_guard before insert or update on public.source_display_releases
  for each row execute function public.source_display_release_guard();

create function public.source_display_release_withdrawn() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'TRUNCATE' then
    perform public.rm_withdraw_category('RETROSHEET', 'display release truncated');
  else
    perform public.rm_withdraw_category(old.attribution_category, format('display release of source %s withdrawn', old.source_id));
  end if;
  perform public.rm_apply_display_gate();
  return null;
end $$;
create trigger source_display_releases_withdraw after delete on public.source_display_releases
  for each row execute function public.source_display_release_withdrawn();
create trigger source_display_releases_withdraw_truncate after truncate on public.source_display_releases
  for each statement execute function public.source_display_release_withdrawn();

-- While a category has a release, nothing outside its approved lineage can reach canonical tables: what was reviewed stays what is public. Withdraw first to import more.
create function ingest.display_release_batch_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  v_key text;
begin
  select ss.source_key into v_key
  from ingest.staged_sources ss join public.sources s on s.source_key = ss.source_key
  where ss.batch_id = new.id and s.attribution_category in (select attribution_category from public.source_display_releases)
    and not exists (select 1 from public.source_display_releases r where r.source_id = s.id and new.file_sha256 = any (r.approved_batch_sha256))
  limit 1;
  if v_key is not null then
    raise exception 'batch % cites %, which is outside an active display release; withdraw the release before importing it', new.batch_key, v_key using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger import_batches_display_release_guard before update of status on ingest.import_batches
  for each row when (new.status = 'APPLIED' and old.status is distinct from 'APPLIED') execute function ingest.display_release_batch_guard();
revoke all on function ingest.display_release_batch_guard() from public;

-- ---------------------------------------------------------------------------------------------------------------
-- Both refreshes obey the release. Each takes a lock on it first, so a concurrent withdrawal either commits before the refresh reads or waits and then scrubs what it wrote.
-- ---------------------------------------------------------------------------------------------------------------

do $$
declare
  v_def text := pg_get_functiondef('public.refresh_read_models()'::regprocedure);
  v_lock text := 'lock table public.read_model_refreshes in exclusive mode;';
  v_tail text := 'get diagnostics v_queues = row_count;';
begin
  if position(v_lock in v_def) = 0 or position(v_tail in v_def) = 0 then raise exception '032: refresh_read_models() is not the expected definition'; end if;
  v_def := replace(v_def, v_lock, 'lock table public.source_display_releases in share mode;' || E'\n  ' || v_lock);
  execute replace(v_def, v_tail, v_tail || E'\n\n  perform public.rm_apply_display_gate();');
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.refresh_transaction_read_models()'::regprocedure);
  v_lock text := 'lock table ingest.source_publication_grants,';
  v_auth text := 'or exists (select 1 from ingest.source_publication_grants g where g.attribution_category = s.category);';
  v_withheld text := 'select count(*) - v_displayable into v_withheld from public.transactions;';
begin
  if position(v_lock in v_def) = 0 or position(v_auth in v_def) = 0 then raise exception '032: refresh_transaction_read_models() is not the expected definition'; end if;
  if position(v_withheld in v_def) = 0 then raise exception '032: refresh_transaction_read_models() has no withheld count to correct'; end if;
  v_def := replace(v_def, v_lock, 'lock table public.source_display_releases, ingest.source_publication_grants,');
  -- the public "withheld" count must not reveal how many held records exist
  v_def := replace(v_def, v_withheld, $new$select count(*) - v_displayable into v_withheld from public.transactions t
  where t.source_id not in (select id from public.display_held_source_ids() as h(id))
    and not exists (select 1 from public.transaction_sources ts where ts.transaction_id = t.id and ts.source_id in (select id from public.display_held_source_ids() as h(id)));$new$);
  execute replace(v_def, v_auth, $new$or (exists (select 1 from ingest.source_publication_grants g where g.attribution_category = s.category)
         and (s.category is distinct from 'RETROSHEET' or exists (select 1 from public.source_display_releases r where r.source_id = s.id)));$new$);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- The boundary: a later apply_public_boundary() must not reopen the gated tables with using (true)
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.apply_public_boundary() returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  t record;
begin
  for t in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') loop
    if t.relkind <> 'v' then execute format('alter table public.%I enable row level security', t.relname); end if;
    execute format('revoke all on public.%I from public, anon, authenticated', t.relname);
    if not exists (select 1 from public.internal_objects where object_name = t.relname) then
      execute format('grant select on public.%I to anon, authenticated', t.relname);
      if t.relkind <> 'v' and t.relname not in ('sources', 'source_observations', 'coverage_assessments', 'players', 'player_external_ids') then
        execute format('drop policy if exists public_read on public.%I', t.relname);
        execute format('create policy public_read on public.%I for select to anon, authenticated using (true)', t.relname);
      end if;
    end if;
  end loop;
  revoke execute on all functions in schema public from public, anon, authenticated;
  revoke all on all tables in schema analytics from public, anon, authenticated;
end $$;

-- Every player on this database must already be public under the new rule, or the migration stops: no existing public record may disappear.
do $$
begin
  if exists (select 1 from public.players p where not exists (select 1 from public.source_observations o where o.subject_table = 'players' and o.subject_id = p.id and o.field_name = 'full_name')) then
    raise exception '032: a player has no full_name observation and would stop being public';
  end if;
end $$;

drop policy public_read on public.sources;
create policy public_read on public.sources for select to anon, authenticated using (
  attribution_category is distinct from 'RETROSHEET' or exists (select 1 from public.source_display_releases r where r.source_id = sources.id));
drop policy public_read on public.source_observations;
create policy public_read on public.source_observations for select to anon, authenticated using (
  exists (select 1 from public.sources s where s.id = source_observations.source_id));
drop policy public_read on public.coverage_assessments;
create policy public_read on public.coverage_assessments for select to anon, authenticated using (
  source_id is null or exists (select 1 from public.sources s where s.id = coverage_assessments.source_id));
drop policy public_read on public.players;
create policy public_read on public.players for select to anon, authenticated using (
  exists (select 1 from public.source_observations o where o.subject_table = 'players' and o.subject_id = players.id and o.field_name = 'full_name'));
drop policy public_read on public.player_external_ids;
create policy public_read on public.player_external_ids for select to anon, authenticated using (
  exists (select 1 from public.players p where p.id = player_external_ids.player_id) and (player_external_ids.source_id is null or exists (select 1 from public.sources s where s.id = player_external_ids.source_id)));

-- ---------------------------------------------------------------------------------------------------------------
-- A released source publishes its APPROVED batches only. Direct owner SQL (outside the importer) is the other way a row citing a released source could appear, and the
-- policies above would show it at once. So while a source has a release, a row citing it can be inserted, re-pointed, or have its content edited only by an apply of
-- one of the release's approved batches: the importer sets bai.import_batch_id for the whole of its transaction, and that batch's file must be on the release. Anything
-- else is refused, naming the remedy (withdraw the release, write, release again). A source with no release is not affected, and no release is ever created for a
-- future file by this rule. This is a safeguard against accidents and shortcuts by the owner, not a barrier against a deliberate owner (who can drop a trigger).
-- ---------------------------------------------------------------------------------------------------------------

create function ingest.display_release_lineage_guard() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, ingest
as $$
declare
  v_batch text := nullif(current_setting('bai.import_batch_id', true), '');
begin
  if new.source_id is null or not exists (select 1 from public.source_display_releases r where r.source_id = new.source_id) then return new; end if;
  if v_batch is not null and exists (
       select 1 from ingest.import_batches b join public.source_display_releases r on r.source_id = new.source_id
       where b.id::text = v_batch and b.file_sha256 = any (r.approved_batch_sha256)) then
    return new;
  end if;
  raise exception 'a record in % cites a source with an active display release, and only an approved batch may write it; withdraw the release, write, and release again', tg_table_name
    using errcode = 'check_violation';
end $$;
revoke all on function ingest.display_release_lineage_guard() from public;

do $$
declare
  t text;
begin
  for t in select c.table_name from information_schema.columns c join information_schema.tables x using (table_schema, table_name)
           where c.table_schema = 'public' and c.column_name = 'source_id' and x.table_type = 'BASE TABLE' and c.table_name not in ('fact_resolutions', 'source_display_releases') and c.table_name not like 'rm\_%' order by 1   -- rm_*: caches the refreshes derive from the canonical rows
  loop
    execute format('create trigger %I after insert on public.%I for each row execute function ingest.display_release_lineage_guard()', t || '_display_lineage_insert', t);
    execute format('create trigger %I before update of source_id on public.%I for each row when (old.source_id is distinct from new.source_id) execute function ingest.display_release_lineage_guard()', t || '_display_lineage_source', t);
  end loop;
end $$;
-- The five tables the public roles read directly: an edit of what they say is a write too (a change of status or supersession by another source's batch is not).
create trigger source_observations_display_lineage_edit before update of subject_table, subject_id, field_name, observed_value, locator, observed_on on public.source_observations
  for each row execute function ingest.display_release_lineage_guard();
create trigger player_external_ids_display_lineage_edit before update of player_id, id_system, external_id on public.player_external_ids
  for each row execute function ingest.display_release_lineage_guard();
create trigger coverage_assessments_display_lineage_edit before update on public.coverage_assessments
  for each row when ((to_jsonb(old) - 'updated_at') is distinct from (to_jsonb(new) - 'updated_at')) execute function ingest.display_release_lineage_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- The Data API must not answer a planner-based count. Prefer: count=planned and count=estimated return the planner's row estimate, which is made from the whole table, hidden rows
-- included, and so tracks how many held rows exist (row-level security cannot change that). PostgREST runs db_pre_request after it has switched to the requesting role, so this
-- guard refuses those counts for every Data API role but service_role. Any occurrence in any Prefer header is refused (several headers, mixed order, any case, spacing or quoting);
-- count=exact, count=none and ordinary requests are untouched. The guard has no exception handler: an unreadable header raises, and the request fails rather than passes.
-- It lives in its own schema, which the Data API does not expose, so it is not an RPC endpoint.
-- ---------------------------------------------------------------------------------------------------------------

create schema bai_guard;
comment on schema bai_guard is 'The Data API pre-request guard (032). Not exposed through the Data API; the public roles may only execute the one function in it.';

create function bai_guard.reject_planner_counts() returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  h record;
  v_headers text := current_setting('request.headers', true);
begin
  if v_headers is null or v_headers = '' then return; end if;   -- not a Data API request (a direct SQL session has no request headers)
  if current_user = 'service_role' then return; end if;
  for h in select lower(j.key) as k, j.value as v from json_each_text(v_headers::json) j loop   -- json_each_text keeps repeated headers
    if h.k = 'prefer' and h.v ~* 'count\s*=\s*"?\s*(planned|estimated)' then
      raise sqlstate 'PGRST' using message = '{"code":"BAI01","message":"planner-based counts (count=planned, count=estimated) are not available; use count=exact","details":null,"hint":null}', detail = '{"status":400,"headers":{}}';
    end if;
    if h.k = 'accept' and h.v ~* 'vnd\.pgrst\.plan' then
      raise sqlstate 'PGRST' using message = '{"code":"BAI02","message":"query plans are not available","details":null,"hint":null}', detail = '{"status":400,"headers":{}}';
    end if;
  end loop;
end $$;
revoke all on schema bai_guard from public;
revoke all on function bai_guard.reject_planner_counts() from public;
grant usage on schema bai_guard to anon, authenticated;
grant execute on function bai_guard.reject_planner_counts() to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema bai_guard to service_role;
    grant execute on function bai_guard.reject_planner_counts() to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    if exists (select 1 from pg_roles r cross join unnest(r.rolconfig) c where r.rolname = 'authenticator' and c like 'pgrst.db_pre_request=%' and c <> 'pgrst.db_pre_request=bai_guard.reject_planner_counts') then
      raise exception '032: authenticator already has another pgrst.db_pre_request; chain the guard into it first';
    end if;
    alter role authenticator set pgrst.db_pre_request = 'bai_guard.reject_planner_counts';
    notify pgrst, 'reload config';
  end if;
end $$;

select public.apply_public_boundary();
