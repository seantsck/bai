-- 004_research_coverage
-- Coverage states, research tasks and quality flags.
--
-- tracked != complete population: a coverage row states how much of a defined population BAI holds and on what basis.
-- Only COMPLETE_CENSUS and SUBSTANTIALLY_COMPLETE scopes may be used as denominators for population rates.

create type public.coverage_state as enum (
  'COMPLETE_CENSUS',          -- every member of the defined population is tracked; expected size is known and matched
  'SUBSTANTIALLY_COMPLETE',   -- expected size is known; tracked is close to it and gaps are listed
  'PARTIAL_RECONSTRUCTION',   -- a reconstructed subset; expected size may be unknown
  'RANKED_SAMPLE',            -- membership defined by appearing on a published ranking (selected, not random)
  'INDIVIDUALLY_VERIFIED',    -- an ad hoc set of individually verified records
  'UNKNOWN'
);

create type public.acquisition_domain as enum ('INTERNATIONAL', 'DRAFT');
create type public.coverage_domain as enum ('INTERNATIONAL', 'DRAFT', 'OUTCOMES', 'DEVELOPMENT', 'TRANSACTIONS', 'EXPECTATIONS');

create table public.coverage_assessments (
  id bigint generated always as identity primary key,
  domain public.coverage_domain not null,
  scope_key text not null check (scope_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),   -- e.g. period '2019-20', draft '2019-JUNE'
  organization_id bigint references public.organizations (id),                      -- null = league-wide scope
  coverage_state public.coverage_state not null,
  tracked_count integer not null check (tracked_count >= 0),
  expected_count integer check (expected_count >= 0),                               -- null = population size not established
  sample_basis text,
  gap_notes text,
  assessed_on date not null,
  source_id bigint references public.sources (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (domain, scope_key, organization_id),
  check (expected_count is null or tracked_count <= expected_count),
  -- State semantics
  check (coverage_state <> 'COMPLETE_CENSUS' or (expected_count is not null and tracked_count = expected_count and source_id is not null)),
  check (coverage_state <> 'SUBSTANTIALLY_COMPLETE' or (expected_count is not null and source_id is not null and gap_notes is not null)),
  check (coverage_state <> 'RANKED_SAMPLE' or sample_basis is not null)
);
create trigger coverage_assessments_updated_at before update on public.coverage_assessments for each row execute function public.set_updated_at();

-- The only gate for population-rate denominators.
create function public.coverage_supports_population_rate(p_state public.coverage_state) returns boolean
language sql immutable parallel safe
set search_path = pg_catalog, public
as $$ select coalesce(p_state in ('COMPLETE_CENSUS', 'SUBSTANTIALLY_COMPLETE'), false) $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Research operations (internal; not part of the public read surface)
-- ---------------------------------------------------------------------------------------------------------------

create type public.research_task_status as enum ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'WONT_DO');

create table public.research_tasks (
  id bigint generated always as identity primary key,
  task_type text not null check (task_type ~ '^[A-Z][A-Z0-9_]*$'),     -- e.g. AUDIT_OUTCOME, RESOLVE_IDENTITY, BACKFILL_PERIOD
  domain public.coverage_domain,
  title text not null,
  player_id bigint references public.players (id),
  organization_id bigint references public.organizations (id),
  scope_key text,
  status public.research_task_status not null default 'OPEN',
  priority smallint not null default 3 check (priority between 1 and 5),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status in ('DONE', 'WONT_DO')) = (completed_at is not null))
);
create trigger research_tasks_updated_at before update on public.research_tasks for each row execute function public.set_updated_at();

create type public.flag_severity as enum ('INFO', 'WARNING', 'BLOCKING');

create table public.quality_flags (
  id bigint generated always as identity primary key,
  subject_table text not null,
  subject_id bigint not null,
  flag_code text not null check (flag_code ~ '^[A-Z][A-Z0-9_]*$'),     -- e.g. SOURCE_CONFLICT, DATE_PRECISION_LOW, IDENTITY_AMBIGUOUS
  severity public.flag_severity not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'ACCEPTED')),
  notes text,
  raised_on date not null default current_date,
  resolved_on date,
  check ((status = 'OPEN') = (resolved_on is null))
);
create index quality_flags_subject_idx on public.quality_flags (subject_table, subject_id);
