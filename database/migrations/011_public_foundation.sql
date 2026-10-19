-- 011_public_foundation
-- Public read boundary (RLS + grants) and the bounded read models that serve heavy summaries.
--
-- Serving rule (learned from DISI v1.0.0 / 045a): simple indexed facts are queried directly; anything that aggregates across
-- domains is computed in analytics.*, materialized into rm_* tables by a controlled refresh, and the app reads only rm_*.
-- Public requests never execute analytics views or the refresh.

-- ---------------------------------------------------------------------------------------------------------------
-- Read models (bounded: one overview row, one row per organization, one row per coverage assessment)
-- ---------------------------------------------------------------------------------------------------------------

create table public.read_model_refreshes (
  generation_id bigint primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  overview_rows integer not null,
  organization_rows integer not null,
  coverage_rows integer not null
);

create table public.rm_overview (
  singleton boolean primary key default true check (singleton),
  organizations integer not null,
  players integer not null,
  sources integer not null,
  international_signing_periods integer not null,
  international_signings integer not null,
  drafts integer not null,
  draft_selections integer not null,
  coverage_assessments integer not null,
  population_rate_scopes integer not null,
  generation_id bigint not null,
  refreshed_at timestamptz not null
);

create table public.rm_organization_summary (
  organization_id bigint primary key references public.organizations (id),
  franchise_key text not null,
  slug text not null unique,
  name text not null,
  league public.league_code not null,
  division text not null,
  international_signings integer not null,
  draft_selections integer not null,
  draft_signed integer not null,
  draft_did_not_sign integer not null,
  draft_signing_unknown integer not null,
  acquired_players integer not null,
  audited_reached_mlb integer not null,
  audited_no_mlb integer not null,
  not_audited integer not null,
  other_outcome_states integer not null,
  coverage_assessments integer not null,
  population_rate_scopes integer not null,
  generation_id bigint not null,
  refreshed_at timestamptz not null
);

create table public.rm_coverage_summary (
  coverage_assessment_id bigint primary key references public.coverage_assessments (id) on delete cascade,
  domain public.coverage_domain not null,
  scope_key text not null,
  organization_id bigint references public.organizations (id),
  coverage_state public.coverage_state not null,
  tracked_count integer not null,
  expected_count integer,
  supports_population_rate boolean not null,
  assessed_on date not null,
  generation_id bigint not null,
  refreshed_at timestamptz not null
);
create index rm_coverage_summary_org_idx on public.rm_coverage_summary (organization_id);

create view analytics.organization_summary with (security_invoker = true) as
with acq as (select * from public.v_acquisitions),
outcomes as (
  select a.organization_id, a.player_id, o.audit_state
  from (select distinct organization_id, player_id from acq) a
  join public.v_player_outcome_status o on o.player_id = a.player_id
),
cov as (
  select organization_id, count(*) as n, count(*) filter (where public.coverage_supports_population_rate(coverage_state)) as rate_scopes
  from public.coverage_assessments where organization_id is not null group by organization_id
)
select o.id as organization_id, o.franchise_key, o.slug, o.current_name as name, o.league, o.division,
       (select count(*) from acq where acq.organization_id = o.id and channel = 'INTERNATIONAL')::int as international_signings,
       (select count(*) from acq where acq.organization_id = o.id and channel = 'DRAFT')::int as draft_selections,
       (select count(*) from acq where acq.organization_id = o.id and channel = 'DRAFT' and signing_status = 'SIGNED')::int as draft_signed,
       (select count(*) from acq where acq.organization_id = o.id and channel = 'DRAFT' and signing_status = 'DID_NOT_SIGN')::int as draft_did_not_sign,
       (select count(*) from acq where acq.organization_id = o.id and channel = 'DRAFT' and signing_status = 'UNKNOWN')::int as draft_signing_unknown,
       (select count(*) from outcomes x where x.organization_id = o.id)::int as acquired_players,
       (select count(*) from outcomes x where x.organization_id = o.id and audit_state = 'AUDITED_REACHED_MLB')::int as audited_reached_mlb,
       (select count(*) from outcomes x where x.organization_id = o.id and audit_state = 'AUDITED_NO_MLB')::int as audited_no_mlb,
       (select count(*) from outcomes x where x.organization_id = o.id and audit_state = 'NOT_AUDITED')::int as not_audited,
       (select count(*) from outcomes x where x.organization_id = o.id
          and audit_state not in ('AUDITED_REACHED_MLB', 'AUDITED_NO_MLB', 'NOT_AUDITED'))::int as other_outcome_states,
       coalesce(c.n, 0)::int as coverage_assessments,
       coalesce(c.rate_scopes, 0)::int as population_rate_scopes
from public.organizations o
left join cov c on c.organization_id = o.id
where o.active;

-- Controlled refresh. Run by the owner from scripts/db/refresh-read-models.mjs, never by a page request.
-- Serialized by an EXCLUSIVE lock (readers keep ACCESS SHARE); DELETE + INSERT inside one transaction so readers see the
-- old or the new generation, never a mix; validated before commit. Re-running on unchanged data converges to the same rows.
create function public.refresh_read_models() returns bigint
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_generation bigint;
  v_started timestamptz := clock_timestamp();
  v_now timestamptz := now();
  v_orgs integer;
  v_cov integer;
begin
  lock table public.read_model_refreshes in exclusive mode;
  select coalesce(max(generation_id), 0) + 1 into v_generation from public.read_model_refreshes;

  delete from public.rm_overview;
  insert into public.rm_overview
  select true,
         (select count(*) from public.organizations where active), (select count(*) from public.players), (select count(*) from public.sources),
         (select count(*) from public.international_signing_periods), (select count(*) from public.international_signings),
         (select count(*) from public.drafts), (select count(*) from public.draft_selections),
         (select count(*) from public.coverage_assessments),
         (select count(*) from public.coverage_assessments where public.coverage_supports_population_rate(coverage_state)),
         v_generation, v_now;

  delete from public.rm_organization_summary;
  insert into public.rm_organization_summary select s.*, v_generation, v_now from analytics.organization_summary s;
  get diagnostics v_orgs = row_count;

  delete from public.rm_coverage_summary;
  insert into public.rm_coverage_summary
  select id, domain, scope_key, organization_id, coverage_state, tracked_count, expected_count,
         public.coverage_supports_population_rate(coverage_state), assessed_on, v_generation, v_now
  from public.coverage_assessments;
  get diagnostics v_cov = row_count;

  if v_orgs <> (select count(*) from public.organizations where active) then
    raise exception 'read model validation failed: % organization rows', v_orgs;
  end if;
  if exists (select 1 from public.rm_organization_summary
             where audited_reached_mlb + audited_no_mlb + not_audited + other_outcome_states <> acquired_players) then
    raise exception 'read model validation failed: outcome states do not partition acquired players';
  end if;

  insert into public.read_model_refreshes values (v_generation, v_started, clock_timestamp(), 1, v_orgs, v_cov);
  return v_generation;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Public boundary
-- ---------------------------------------------------------------------------------------------------------------

-- Objects that are internal: research operations, refresh bookkeeping, conflict worklists.
create table public.internal_objects (object_name text primary key, reason text not null);
insert into public.internal_objects values
  ('research_tasks', 'research operations'),
  ('quality_flags', 'research operations'),
  ('read_model_refreshes', 'refresh bookkeeping'),
  ('internal_objects', 'boundary registry'),
  ('v_source_conflicts', 'research worklist')
on conflict (object_name) do nothing;

do $$
declare
  t record;
begin
  -- Every table: RLS on, no implicit access. Public tables get read-only grants and a read policy; nothing gets write access.
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('revoke all on public.%I from public, anon, authenticated', t.relname);
    if not exists (select 1 from public.internal_objects where object_name = t.relname) then
      execute format('grant select on public.%I to anon, authenticated', t.relname);
      execute format('drop policy if exists public_read on public.%I', t.relname);
      execute format('create policy public_read on public.%I for select to anon, authenticated using (true)', t.relname);
    end if;
  end loop;

  -- Views are security_invoker, so the underlying tables' RLS applies to whoever reads them.
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' loop
    execute format('revoke all on public.%I from public, anon, authenticated', t.relname);
    if not exists (select 1 from public.internal_objects where object_name = t.relname) then
      execute format('grant select on public.%I to anon, authenticated', t.relname);
    end if;
  end loop;
end $$;

-- No function is executable by the public roles (the refresh in particular). Generated columns and CHECKs evaluate at write.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke all on schema analytics from public, anon, authenticated;
revoke all on all tables in schema analytics from public, anon, authenticated;
