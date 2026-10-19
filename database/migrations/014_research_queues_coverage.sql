-- 014_research_queues_coverage
-- Research queues (internal worklists with declared priorities) and the coverage dashboard read models.
--
-- Priorities are a fixed, documented table: 1 = blocks correct canonical data, 5 = enrichment. Nothing is model-generated.
-- Coverage cells never compute hit rates; they expose supports_population_rate so a page can say whether a rate is allowed.

create table public.research_queue_types (
  queue_key text primary key check (queue_key ~ '^[A-Z][A-Z0-9_]*$'),
  priority smallint not null check (priority between 1 and 5),
  description text not null,
  priority_basis text not null
);

insert into public.research_queue_types (queue_key, priority, description, priority_basis) values
  ('IDENTITY_AMBIGUOUS', 1, 'Staged record whose player could not be linked safely (probable, ambiguous or conflicting identity)', 'Held records cannot be applied; a wrong merge corrupts every downstream fact.'),
  ('SOURCE_CONFLICT', 1, 'Active observations disagree on a field and no recorded resolution covers them', 'The canonical value is contested until resolved.'),
  ('DRAFT_SIGNING_STATUS_UNKNOWN', 2, 'Draft selection with no signing research', 'Signed / unsigned decides cohort membership.'),
  ('MISSING_SIGNING_DATE', 2, 'International signing without a day-precision date', 'Period assignment and the hindsight cutoff depend on the date.'),
  ('CLASS_INCOMPLETE', 2, 'Draft class or signing period scope with records that is not a complete census', 'Rates stay blocked until coverage is established.'),
  ('MISSING_COST', 3, 'Signed acquisition with no known bonus', 'Cost analysis excludes unknown cost; it is never treated as zero.'),
  ('MISSING_SIGNING_MARKET', 3, 'International signing without a market', 'Market breakdowns exclude it.'),
  ('SCHOOL_UNRESOLVED', 3, 'Draft selection without a linked school / program', 'School breakdowns exclude it.'),
  ('OUTCOME_NOT_AUDITED', 4, 'Acquired player whose outcome has not been audited', 'Needed before any outcome rate; not blocking for ingestion.'),
  ('MISSING_EXPECTATION', 5, 'Acquisition with no acquisition-time expectation linked', 'Enrichment; expectation analyses are optional.')
on conflict (queue_key) do update set priority = excluded.priority, description = excluded.description, priority_basis = excluded.priority_basis;

-- One row per open work item. Internal (research operations).
create view public.v_research_queue with (security_invoker = true) as
with items as (
  select 'IDENTITY_AMBIGUOUS' as queue_key, 'ingest.staged_records' as subject_table, r.id as subject_id, null::bigint as player_id,
         null::bigint as organization_id, b.batch_key as scope_key,
         format('%s: %s (%s)', r.identity_state, r.payload #>> '{player,full_name}', r.record_type) as detail
  from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id
  where r.identity_state in ('PROBABLE_MATCH', 'AMBIGUOUS', 'CONFLICT') and r.applied_at is null
    and r.review_state not in ('APPROVED', 'REJECTED') and b.status <> 'ABANDONED'
  union all
  select 'SOURCE_CONFLICT', c.subject_table, c.subject_id, null, null, c.field_name,
         format('%s.%s: %s distinct values (rule %s)', c.subject_table, c.field_name, c.distinct_values, c.declared_rule)
  from public.v_open_fact_conflicts c
  union all
  select 'DRAFT_SIGNING_STATUS_UNKNOWN', 'draft_selections', p.draft_selection_id, p.player_id, p.organization_id, p.draft_key, format('pick %s', p.overall_pick)
  from public.v_draft_picks p where p.signing_status = 'UNKNOWN'
  union all
  select 'MISSING_SIGNING_DATE', 'international_signings', s.id, s.player_id, s.organization_id, ip.period_key,
         coalesce('precision ' || s.signing_date_precision, 'no date')
  from public.international_signings s left join public.international_signing_periods ip on ip.id = s.signing_period_id
  where s.signing_date is null or s.signing_date_precision <> 'DAY'
  union all
  select 'MISSING_COST', 'international_signings', s.id, s.player_id, s.organization_id, ip.period_key, 'signing bonus unknown'
  from public.international_signings s left join public.international_signing_periods ip on ip.id = s.signing_period_id
  where s.signing_bonus_usd is null
  union all
  select 'MISSING_COST', 'draft_selections', p.draft_selection_id, p.player_id, p.organization_id, p.draft_key, 'signed; bonus unknown'
  from public.v_draft_picks p where p.signing_status = 'SIGNED' and p.signing_bonus_usd is null
  union all
  select 'MISSING_SIGNING_MARKET', 'international_signings', s.id, s.player_id, s.organization_id, ip.period_key, 'no market'
  from public.international_signings s left join public.international_signing_periods ip on ip.id = s.signing_period_id
  where s.market_id is null
  union all
  select 'SCHOOL_UNRESOLVED', 'draft_selections', s.id, s.player_id, s.organization_id, d.draft_key, coalesce(s.notes, 'no school linked')
  from public.draft_selections s join public.drafts d on d.id = s.draft_id where s.school_id is null
  union all
  select 'OUTCOME_NOT_AUDITED', 'players', a.player_id, a.player_id, min(a.organization_id), null, 'outcome not audited'
  from public.v_acquisitions a join public.v_player_outcome_status o on o.player_id = a.player_id
  where o.audit_state = 'NOT_AUDITED' group by a.player_id
  union all
  select 'MISSING_EXPECTATION', case a.channel when 'DRAFT' then 'draft_selections' else 'international_signings' end, a.acquisition_id,
         a.player_id, a.organization_id, null, 'no acquisition-time expectation linked'
  from public.v_acquisitions a
  where not exists (select 1 from public.acquisition_expectation_links l
                    where (a.channel = 'DRAFT' and l.draft_selection_id = a.acquisition_id)
                       or (a.channel = 'INTERNATIONAL' and l.international_signing_id = a.acquisition_id))
  union all
  select 'CLASS_INCOMPLETE', 'coverage_assessments', c.id, null, c.organization_id, c.scope_key, c.coverage_state::text
  from public.coverage_assessments c where c.coverage_state <> 'COMPLETE_CENSUS'
)
select i.*, t.priority, t.priority_basis from items i join public.research_queue_types t using (queue_key);

-- ---------------------------------------------------------------------------------------------------------------
-- Coverage dashboard: one cell per (draft or signing period) x active organization
-- ---------------------------------------------------------------------------------------------------------------

create view analytics.research_coverage_cells with (security_invoker = true) as
with draft_cells as (
  select 'DRAFT'::public.coverage_domain as domain, d.draft_key as scope_key, d.draft_year::text as scope_label, d.start_date as scope_start,
         o.id as organization_id,
         count(s.id)::int as tracked_records,
         count(distinct s.player_id) filter (where ps.audit_state <> 'NOT_AUDITED')::int as audited_outcomes,
         count(s.id) filter (where ds.signing_status = 'SIGNED')::int as cost_basis_records,
         count(s.id) filter (where ds.signing_status = 'SIGNED' and ds.signing_bonus_usd is not null)::int as cost_known_records,
         max(s.updated_at)::date as last_record_date
  from public.drafts d cross join public.organizations o
  left join public.draft_selections s on s.draft_id = d.id and s.organization_id = o.id
  left join public.draft_signings ds on ds.draft_selection_id = s.id
  left join public.v_player_outcome_status ps on ps.player_id = s.player_id
  where o.active and d.draft_kind = 'JUNE_AMATEUR'
  group by d.id, o.id
), intl_cells as (
  select 'INTERNATIONAL'::public.coverage_domain, ip.period_key, ip.label, ip.start_date, o.id,
         count(s.id)::int,
         count(distinct s.player_id) filter (where ps.audit_state <> 'NOT_AUDITED')::int,
         count(s.id)::int,
         count(s.id) filter (where s.signing_bonus_usd is not null)::int,
         max(s.updated_at)::date
  from public.international_signing_periods ip cross join public.organizations o
  left join public.international_signings s on s.signing_period_id = ip.id and s.organization_id = o.id
  left join public.v_player_outcome_status ps on ps.player_id = s.player_id
  where o.active
  group by ip.id, o.id
), cells as (select * from draft_cells union all select * from intl_cells)
select c.*, a.coverage_state, a.expected_count, coalesce(public.coverage_supports_population_rate(a.coverage_state), false) as supports_population_rate,
       greatest(c.last_record_date, a.assessed_on) as last_research_date
from cells c
left join public.coverage_assessments a on a.domain = c.domain and a.scope_key = c.scope_key and a.organization_id = c.organization_id;

create table public.rm_research_coverage (
  domain public.coverage_domain not null,
  scope_key text not null,
  scope_label text not null,
  scope_start date not null,
  organization_id bigint not null references public.organizations (id),
  tracked_records integer not null,
  audited_outcomes integer not null,
  cost_basis_records integer not null,
  cost_known_records integer not null,
  coverage_state public.coverage_state,            -- null = not assessed
  expected_count integer,
  supports_population_rate boolean not null,
  last_research_date date,
  generation_id bigint not null,
  refreshed_at timestamptz not null,
  primary key (domain, scope_key, organization_id)
);

-- Queue sizes only; the items themselves stay internal.
create table public.rm_research_queue_summary (
  queue_key text primary key,
  priority smallint not null,
  description text not null,
  open_items integer not null,
  generation_id bigint not null,
  refreshed_at timestamptz not null
);

alter table public.read_model_refreshes
  add column research_coverage_rows integer not null default 0,
  add column queue_rows integer not null default 0;

insert into public.internal_objects values
  ('v_research_queue', 'research worklist')
on conflict (object_name) do nothing;

create or replace function public.refresh_read_models() returns bigint
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_generation bigint;
  v_started timestamptz := clock_timestamp();
  v_now timestamptz := now();
  v_orgs integer;
  v_cov integer;
  v_cells integer;
  v_expected_cells integer;
  v_queues integer;
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

  delete from public.rm_research_coverage;
  insert into public.rm_research_coverage
  select domain, scope_key, scope_label, scope_start, organization_id, tracked_records, audited_outcomes, cost_basis_records,
         cost_known_records, coverage_state, expected_count, supports_population_rate, last_research_date, v_generation, v_now
  from analytics.research_coverage_cells;
  get diagnostics v_cells = row_count;

  delete from public.rm_research_queue_summary;
  insert into public.rm_research_queue_summary
  select t.queue_key, t.priority, t.description, (select count(*) from public.v_research_queue q where q.queue_key = t.queue_key)::int,
         v_generation, v_now
  from public.research_queue_types t;
  get diagnostics v_queues = row_count;

  if v_orgs <> (select count(*) from public.organizations where active) then
    raise exception 'read model validation failed: % organization rows', v_orgs;
  end if;
  if exists (select 1 from public.rm_organization_summary
             where audited_reached_mlb + audited_no_mlb + not_audited + other_outcome_states <> acquired_players) then
    raise exception 'read model validation failed: outcome states do not partition acquired players';
  end if;
  v_expected_cells := ((select count(*) from public.drafts where draft_kind = 'JUNE_AMATEUR') + (select count(*) from public.international_signing_periods))
                      * (select count(*) from public.organizations where active);
  if v_cells <> v_expected_cells then
    raise exception 'read model validation failed: % coverage cells, expected %', v_cells, v_expected_cells;
  end if;
  if exists (select 1 from public.rm_research_coverage where cost_known_records > cost_basis_records or cost_basis_records > tracked_records) then
    raise exception 'read model validation failed: cost coverage exceeds its basis';
  end if;

  insert into public.read_model_refreshes (generation_id, started_at, finished_at, overview_rows, organization_rows, coverage_rows, research_coverage_rows, queue_rows)
  values (v_generation, v_started, clock_timestamp(), 1, v_orgs, v_cov, v_cells, v_queues);
  return v_generation;
end $$;

select public.apply_public_boundary();
revoke all on schema ingest from public, anon, authenticated;
