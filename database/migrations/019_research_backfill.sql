-- 019_research_backfill
-- League-wide research orchestration: research classes (organization x channel x draft/period), an explicit stage
-- machine, durable jobs, resumable research batches, source leads, review of agent-staged imports, certification, and
-- the structures the backfill needs around them (historical franchise names, outcome audit details, economics views).
--
-- Rules encoded here:
--   * Nothing is organization-specific. A class is any organization x implemented channel x scope; every table keys on
--     organization_id, and the universe is public.organizations (30 franchises).
--   * Workflow state (research.*) never replaces coverage state (public.coverage_assessments): a class can be
--     READY_FOR_REVIEW or even CERTIFIED while its coverage stays PARTIAL_RECONSTRUCTION.
--   * Stages advance one at a time (a trigger refuses skips). CERTIFIED needs an active certification row, which only the
--     deterministic certification check writes, and never for an agent.
--   * Jobs and batches keep an append-only event history; terminal job states need a rationale.
--   * Research workflow lives in the private schema `research`, never exposed through the Data API and never granted to
--     public roles. The only public addition is a certification flag per class (rm_research_certification).
--   * Leads are not provenance: canonical facts still enter only through ingest batches, and a batch staged by an agent
--     cannot be applied until a human has reviewed it.

create schema if not exists research;
revoke all on schema research from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Franchise history: names a source may use, resolved to the canonical organization (no duplicate franchises)
-- ---------------------------------------------------------------------------------------------------------------

insert into public.sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date, notes)
values ('bai-reference:mlb-team-history', 'OFFICIAL_LEAGUE', 'OFFICIAL', 'MLB Stats API team history (teams 120, 139, 146)', 'MLB Advanced Media',
        'https://statsapi.mlb.com/api/v1/teams/history?teamIds=146,139,120', '2026-10-19',
        'Name change points: Florida Marlins -> Miami Marlins (2012, FLA -> MIA); Tampa Bay Devil Rays -> Tampa Bay Rays (2008); Montreal Expos (MON) -> Washington Nationals (2005). First seasons of the earlier names are left open.')
on conflict (source_key) do nothing;

do $$
declare
  src bigint := (select id from public.sources where source_key = 'bai-reference:mlb-team-history');
  r record;
begin
  for r in select * from (values
      ('MIA', 'Miami Marlins', 'Florida Marlins', 2012),
      ('TB', 'Tampa Bay Rays', 'Tampa Bay Devil Rays', 2008),
      ('WSH', 'Washington Nationals', 'Montreal Expos', 2005)) as v (franchise_key, current_name, former_name, renamed_in) loop
    -- Only when the seed still has the open-ended current name and no former name yet (convergent).
    if not exists (select 1 from public.organization_names n join public.organizations o on o.id = n.organization_id
                   where o.franchise_key = r.franchise_key and n.name = r.former_name) then
      update public.organization_names n set first_season = r.renamed_in, source_id = src
      from public.organizations o
      where o.id = n.organization_id and o.franchise_key = r.franchise_key and n.name = r.current_name and n.first_season is null and n.last_season is null;
      insert into public.organization_names (organization_id, name, first_season, last_season, source_id)
      select o.id, r.former_name, null, r.renamed_in - 1, src from public.organizations o where o.franchise_key = r.franchise_key;
    end if;
  end loop;
end $$;

insert into public.organization_aliases (organization_id, alias, alias_kind)
select o.id, a.alias, a.kind from public.organizations o
join (values ('MIA', 'Florida Marlins', 'HISTORICAL_NAME'), ('MIA', 'FLA', 'ABBREVIATION'),
             ('TB', 'Tampa Bay Devil Rays', 'HISTORICAL_NAME'),
             ('WSH', 'Montreal Expos', 'HISTORICAL_NAME'), ('WSH', 'MON', 'ABBREVIATION')) as a (franchise_key, alias, kind)
  on a.franchise_key = o.franchise_key
on conflict (organization_id, alias_normalized) do nothing;

-- Resolves how a source names a club (franchise key, abbreviation, current or historical name) to one organization.
-- With a season, names are matched against the seasons they were in use. Ambiguous or unknown wording returns null:
-- the caller must refuse it, never guess.
create function public.resolve_organization(p_name text, p_season integer default null) returns bigint
language sql stable
set search_path = pg_catalog, public
as $$
  with by_key as (select id from public.organizations where franchise_key = upper(btrim(p_name))),
  by_name as (
    select distinct n.organization_id as id from public.organization_names n
    where public.normalize_name(n.name) = public.normalize_name(p_name) and (p_season is null or n.seasons @> p_season)),
  by_alias as (
    select distinct a.organization_id as id from public.organization_aliases a
    where a.alias_normalized = public.normalize_name(p_name)
      and (p_season is null or a.alias_kind <> 'HISTORICAL_NAME'
           or exists (select 1 from public.organization_names n where n.organization_id = a.organization_id
                      and public.normalize_name(n.name) = a.alias_normalized and n.seasons @> p_season)))
  select coalesce(
    (select id from by_key),
    case when (select count(*) from by_name) = 1 then (select id from by_name) end,
    case when (select count(*) from by_name) = 0 and (select count(*) from by_alias) = 1 then (select id from by_alias) end)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Outcome audit details (public facts; the audit state itself stays in outcome_audits, 008)
-- ---------------------------------------------------------------------------------------------------------------

create type public.player_current_status as enum ('WITH_ACQUIRING_ORGANIZATION', 'WITH_OTHER_ORGANIZATION', 'FREE_AGENT', 'RELEASED', 'RETIRED', 'INACTIVE', 'UNKNOWN');
create type public.acquisition_disposition as enum ('RETAINED', 'TRADED', 'RELEASED', 'LOST_RULE_5', 'LOST_WAIVERS', 'LEFT_AS_FREE_AGENT', 'RETIRED', 'UNSIGNED', 'OTHER', 'UNKNOWN');

create table public.outcome_audit_details (
  id bigint generated always as identity primary key,
  outcome_audit_id bigint not null unique references public.outcome_audits (id) on delete cascade,
  as_of_date date not null,                                -- the outcome is true as of this date, never "forever"
  reached_affiliated boolean,                              -- null = not established
  first_affiliated_season integer check (first_affiliated_season between 1871 and 2100),
  mlb_games integer check (mlb_games >= 0),
  mlb_plate_appearances integer check (mlb_plate_appearances >= 0),
  mlb_innings_pitched numeric(7, 1) check (mlb_innings_pitched >= 0),
  current_status public.player_current_status not null default 'UNKNOWN',
  disposition public.acquisition_disposition not null default 'UNKNOWN',
  disposition_transaction_id bigint references public.transactions (id),
  source_id bigint not null references public.sources (id),
  notes text,
  created_at timestamptz not null default now(),
  check (disposition <> 'TRADED' or disposition_transaction_id is not null)
);

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('outcome_audit_details', 'OUTCOME', 'Outcome audit details (affiliated reach, playing time, status, disposition) as of a date')
on conflict (table_name) do nothing;

-- One row per player and audit: debut age is derived (birth date + debut), WAR stays per provider (never one "truth").
create view analytics.player_outcome_profile with (security_invoker = true) as
select p.id as player_id, s.audit_state, s.observation_through_season, s.audited_on,
       d.as_of_date, d.reached_affiliated, d.first_affiliated_season, d.mlb_games, d.mlb_plate_appearances, d.mlb_innings_pitched,
       d.current_status, d.disposition, d.disposition_transaction_id,
       s.debut_date, s.debut_organization_id,
       case when s.debut_date is not null and p.birth_date is not null and p.birth_date_precision = 'DAY'
            then extract(year from age(s.debut_date, p.birth_date))::int end as debut_age,
       (select w.war_value from public.war_observations w where w.player_id = p.id and w.war_system = 'BREF' and w.scope = 'CAREER'
         order by w.through_season desc, w.observed_on desc limit 1) as career_war_bref,
       (select w.war_value from public.war_observations w where w.player_id = p.id and w.war_system = 'FANGRAPHS' and w.scope = 'CAREER'
         order by w.through_season desc, w.observed_on desc limit 1) as career_war_fangraphs
from public.players p
join public.v_player_outcome_status s on s.player_id = p.id
left join lateral (select x.* from public.outcome_audits a join public.outcome_audit_details x on x.outcome_audit_id = a.id
                   where a.player_id = p.id order by a.observation_through_season desc nulls last, a.audited_on desc limit 1) d on true;

-- ---------------------------------------------------------------------------------------------------------------
-- Channels, stages, classes
-- ---------------------------------------------------------------------------------------------------------------

create table research.channels (
  channel_key text primary key check (channel_key ~ '^[A-Z][A-Z0-9_]*$'),
  label text not null,
  scope_kind text not null check (scope_kind in ('DRAFT', 'SIGNING_PERIOD', 'SEASON')),
  coverage_domain public.coverage_domain,
  implemented boolean not null default false,          -- class creation is refused for channels not implemented yet
  description text not null
);
insert into research.channels (channel_key, label, scope_kind, coverage_domain, implemented, description) values
  ('DRAFT', 'Rule 4 draft', 'DRAFT', 'DRAFT', true, 'Selections, signing status, bonus, slot and school for one organization in one Rule 4 draft'),
  ('INTERNATIONAL', 'International signings', 'SIGNING_PERIOD', 'INTERNATIONAL', true, 'Amateur and exempt professional signings for one organization in one signing period'),
  ('RULE_5', 'Rule 5 draft', 'SEASON', null, false, 'Reserved: Rule 5 selections by season'),
  ('UNDRAFTED_FREE_AGENT', 'Undrafted free agents', 'SEASON', null, false, 'Reserved: domestic amateur free agents signed after the draft')
on conflict (channel_key) do nothing;

create type research.stage as enum ('DISCOVERY', 'ROSTER_RECONSTRUCTION', 'IDENTITY_RECONCILIATION', 'SIGNING_STATUS', 'FINANCIALS',
  'SOURCE_RECONCILIATION', 'OUTCOME_AUDIT', 'COVERAGE_REVIEW', 'CERTIFIED');

create function research.stage_index(p research.stage) returns integer
language sql immutable parallel safe
set search_path = pg_catalog, research
as $$ select array_position(enum_range(null::research.stage), p) $$;

create table research.classes (
  id bigint generated always as identity primary key,
  class_key text not null unique check (class_key ~ '^[A-Z]{2,4}/[A-Z][A-Z0-9_]*/[A-Za-z0-9][A-Za-z0-9_.-]*$'),
  organization_id bigint not null references public.organizations (id),
  channel_key text not null references research.channels (channel_key),
  draft_id bigint references public.drafts (id),
  signing_period_id bigint references public.international_signing_periods (id),
  season integer check (season between 1871 and 2100),
  scope_key text not null,
  stage research.stage not null default 'DISCOVERY',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, channel_key, scope_key),
  check (num_nonnulls(draft_id, signing_period_id, season) = 1)
);
create trigger classes_updated_at before update on research.classes for each row execute function public.set_updated_at();

create table research.stage_events (
  id bigint generated always as identity primary key,
  class_id bigint not null references research.classes (id),
  from_stage research.stage,
  to_stage research.stage not null,
  actor text not null,
  rationale text,
  open_jobs jsonb not null default '{}',          -- open/blocked job counts per stage at the moment of the transition
  at timestamptz not null default now()
);

create table research.certifications (
  id bigint generated always as identity primary key,
  class_id bigint not null references research.classes (id),
  certified_by text not null check (certified_by !~ '^agent:'),
  certified_at timestamptz not null default now(),
  coverage_state public.coverage_state not null,       -- coverage at certification; certification never changes it
  report jsonb not null,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  check ((revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_reason is null))
);
create unique index certifications_active_idx on research.certifications (class_id) where revoked_at is null;

-- Scope must match the channel; stages move one step forward (or back with a rationale); CERTIFIED only with an active
-- certification; a class leaves CERTIFIED only by revoking it.
create function research.class_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public, research
as $$
declare
  ch research.channels;
begin
  select * into ch from research.channels where channel_key = new.channel_key;
  if tg_op = 'INSERT' then
    if not ch.implemented then raise exception 'channel % is not implemented yet', new.channel_key using errcode = 'check_violation'; end if;
    if (ch.scope_kind = 'DRAFT' and new.draft_id is null) or (ch.scope_kind = 'SIGNING_PERIOD' and new.signing_period_id is null)
       or (ch.scope_kind = 'SEASON' and new.season is null) then
      raise exception 'class scope does not match channel % (%)', new.channel_key, ch.scope_kind using errcode = 'check_violation';
    end if;
    if new.stage <> 'DISCOVERY' then raise exception 'a class starts at DISCOVERY' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if new.organization_id <> old.organization_id or new.channel_key <> old.channel_key or new.scope_key <> old.scope_key
     or new.draft_id is distinct from old.draft_id or new.signing_period_id is distinct from old.signing_period_id or new.season is distinct from old.season then
    raise exception 'a class identity is immutable' using errcode = 'check_violation';
  end if;
  if new.stage is distinct from old.stage then
    if new.stage = 'CERTIFIED' and not exists (select 1 from research.certifications c where c.class_id = new.id and c.revoked_at is null) then
      raise exception 'CERTIFIED needs an active certification (research:certify)' using errcode = 'check_violation';
    end if;
    if old.stage = 'CERTIFIED' and exists (select 1 from research.certifications c where c.class_id = new.id and c.revoked_at is null) then
      raise exception 'revoke the certification before reopening the class' using errcode = 'check_violation';
    end if;
    if research.stage_index(new.stage) > research.stage_index(old.stage) + 1 then
      raise exception 'stage % -> % skips a stage', old.stage, new.stage using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger classes_guard before insert or update on research.classes for each row execute function research.class_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------------------------------------------

-- Priority rank is the documented, fixed ordering of research value (docs/backfill-methodology.md). Lower = sooner.
create table research.job_categories (
  category_key text primary key check (category_key ~ '^[A-Z][A-Z0-9_]*$'),
  stage research.stage not null,
  priority_rank smallint not null check (priority_rank between 1 and 10),
  label text not null,
  source_requirements text not null
);
insert into research.job_categories (category_key, stage, priority_rank, label, source_requirements) values
  ('CLASS_NOT_RECONSTRUCTED', 'ROSTER_RECONSTRUCTION', 1, 'Reconstruct the class roster', 'An official or primary list of the class (draft tracker / transaction wire); aggregators only as corroboration'),
  ('EXPECTED_UNIVERSE_UNKNOWN', 'DISCOVERY', 2, 'Establish the expected universe', 'A source stating the class size (number of picks; for international, a complete published list), or a rationale that none exists'),
  ('IDENTITY_UNRESOLVED', 'IDENTITY_RECONCILIATION', 3, 'Resolve player identity', 'An external id (MLBAM, Baseball-Reference) or name plus exact birth date from a citable source'),
  ('SIGNING_STATUS_UNKNOWN', 'SIGNING_STATUS', 4, 'Determine signing status', 'Club or MLB announcement, transaction wire, or pro appearances for the drafting club (flagged)'),
  ('TRANSACTION_DATE_MISSING', 'SIGNING_STATUS', 5, 'Find the exact transaction date', 'Transaction wire or club release with a day-precision date'),
  ('ACQUISITION_COST_MISSING', 'FINANCIALS', 6, 'Find the acquisition cost', 'A published figure (bonus, fees); excerpt-only figures must be flagged; unknown stays unknown'),
  ('SLOT_VALUE_MISSING', 'FINANCIALS', 6, 'Capture the pick slot value', 'Published slot values for the draft year'),
  ('SCHOOL_MISSING', 'ROSTER_RECONSTRUCTION', 6, 'Identify the school or previous institution', 'Draft tracker or reference database'),
  ('SOURCE_CONFLICT', 'SOURCE_RECONCILIATION', 7, 'Resolve a source conflict', 'Both claims stay; resolve by the declared field rule or a researcher rationale'),
  ('OUTCOME_NOT_AUDITED', 'OUTCOME_AUDIT', 8, 'Audit the outcome', 'Reference database or official stats as of a stated date; WAR attributed to its provider'),
  ('LOW_QUALITY_SOURCE', 'SOURCE_RECONCILIATION', 9, 'Replace low-quality evidence', 'The full page behind an excerpt-only or archived figure'),
  ('COVERAGE_CERTIFICATION', 'COVERAGE_REVIEW', 10, 'Review coverage and certify the class', 'All earlier stages resolved or explicitly unresolved; research:certify')
on conflict (category_key) do nothing;

create type research.job_state as enum ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'UNRESOLVED', 'CANCELLED', 'SUPERSEDED');

create function research.job_state_terminal(p research.job_state) returns boolean
language sql immutable parallel safe
set search_path = pg_catalog, research
as $$ select p in ('DONE', 'UNRESOLVED', 'CANCELLED', 'SUPERSEDED') $$;

create table research.jobs (
  id bigint generated always as identity primary key,
  job_key text not null unique,                        -- deterministic natural key: same class + subject => same job
  class_id bigint not null references research.classes (id),
  category_key text not null references research.job_categories (category_key),
  subject_table text,
  subject_id bigint,
  subject_label text,                                  -- natural label (e.g. 'pick 184', 'Yusniel Díaz'), stable across databases
  player_id bigint references public.players (id),
  title text not null,
  state research.job_state not null default 'OPEN',
  assigned_to text,
  source_requirements text,
  notes text,
  blocking_reason text,
  depends_on_job_id bigint references research.jobs (id),
  completion_rationale text,
  origin text not null check (origin in ('PLANNER', 'RESEARCHER', 'AGENT')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (state <> 'BLOCKED' or blocking_reason is not null),
  check (research.job_state_terminal(state) = (completed_at is not null)),
  check (not research.job_state_terminal(state) or completion_rationale is not null),
  check (depends_on_job_id is distinct from id)
);
create index jobs_class_idx on research.jobs (class_id, state);
create trigger jobs_updated_at before update on research.jobs for each row execute function public.set_updated_at();

create table research.job_events (
  id bigint generated always as identity primary key,
  job_id bigint not null references research.jobs (id),
  from_state research.job_state,
  to_state research.job_state not null,
  actor text not null,
  note text,
  at timestamptz not null default now()
);

-- Every state change is logged, with the actor taken from the session (set by the CLI: bai.actor).
create function research.log_job_event() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'INSERT' or new.state is distinct from old.state then
    insert into research.job_events (job_id, from_state, to_state, actor, note)
    values (new.id, case when tg_op = 'UPDATE' then old.state end, new.state,
            coalesce(nullif(current_setting('bai.actor', true), ''), current_user),
            coalesce(case when new.state = 'BLOCKED' then new.blocking_reason end, new.completion_rationale));
  end if;
  return new;
end $$;
create trigger jobs_log after insert or update on research.jobs for each row execute function research.log_job_event();

-- A job cannot start before what it depends on is finished.
create function research.job_dependency_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if new.depends_on_job_id is not null and new.state in ('IN_PROGRESS', 'DONE')
     and exists (select 1 from research.jobs d where d.id = new.depends_on_job_id and not research.job_state_terminal(d.state)) then
    raise exception 'job % depends on unfinished job %', new.job_key, new.depends_on_job_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger jobs_dependency before insert or update on research.jobs for each row execute function research.job_dependency_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Research batches (resumable working sessions over a class)
-- ---------------------------------------------------------------------------------------------------------------

create type research.batch_state as enum ('STARTED', 'PAUSED', 'COMPLETED', 'FAILED', 'SUPERSEDED');

create table research.batches (
  id bigint generated always as identity primary key,
  batch_key text not null unique check (batch_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  class_id bigint not null references research.classes (id),
  state research.batch_state not null default 'STARTED',
  operator text not null,
  goal text,
  failure_reason text,
  superseded_by_id bigint references research.batches (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  check ((state in ('COMPLETED', 'FAILED', 'SUPERSEDED')) = (ended_at is not null)),
  check (state <> 'FAILED' or failure_reason is not null),
  check (state <> 'SUPERSEDED' or superseded_by_id is not null)
);
create unique index batches_one_active_idx on research.batches (class_id) where state = 'STARTED';
create trigger batches_updated_at before update on research.batches for each row execute function public.set_updated_at();

create table research.batch_jobs (
  batch_id bigint not null references research.batches (id),
  job_id bigint not null references research.jobs (id),
  added_at timestamptz not null default now(),
  primary key (batch_id, job_id)
);

create table research.batch_events (
  id bigint generated always as identity primary key,
  batch_id bigint not null references research.batches (id),
  from_state research.batch_state,
  to_state research.batch_state not null,
  actor text not null,
  note text,
  at timestamptz not null default now()
);

create function research.log_batch_event() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'INSERT' or new.state is distinct from old.state then
    insert into research.batch_events (batch_id, from_state, to_state, actor, note)
    values (new.id, case when tg_op = 'UPDATE' then old.state end, new.state,
            coalesce(nullif(current_setting('bai.actor', true), ''), current_user), coalesce(new.failure_reason, new.goal));
  end if;
  return new;
end $$;
create trigger batches_log after insert or update on research.batches for each row execute function research.log_batch_event();

-- Import batches that belong to a class (an import may span classes: re-drafts by other clubs).
create table research.class_imports (
  class_id bigint not null references research.classes (id),
  import_batch_id bigint not null references ingest.import_batches (id),
  linked_by text not null,
  linked_at timestamptz not null default now(),
  primary key (class_id, import_batch_id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Source discovery and automation safety
-- ---------------------------------------------------------------------------------------------------------------

create type research.lead_access as enum ('ACCESSIBLE', 'EXCERPT_ONLY', 'ARCHIVE_ONLY', 'BLOCKED', 'PAYWALLED', 'NOT_FOUND');

-- A lead is what a researcher (or agent) found and where; it is not provenance. Facts become canonical only through an
-- ingest batch that cites a registered source.
create table research.source_leads (
  id bigint generated always as identity primary key,
  job_id bigint not null references research.jobs (id),
  url text,
  reference text,
  source_type public.source_type not null,
  authority_level public.source_authority not null,
  access research.lead_access not null,
  retrieved_date date,
  archived_url text,
  evidence_note text not null check (length(btrim(evidence_note)) >= 10),
  excerpt_only boolean not null default false,
  fields_supported text[] not null default '{}',
  recorded_by text not null,
  origin text not null check (origin in ('RESEARCHER', 'AGENT')),
  created_at timestamptz not null default now(),
  check (url is not null or reference is not null),
  check (access in ('BLOCKED', 'PAYWALLED', 'NOT_FOUND') or (retrieved_date is not null and cardinality(fields_supported) > 0)),
  check (access <> 'EXCERPT_ONLY' or excerpt_only),
  check (access <> 'ARCHIVE_ONLY' or archived_url is not null)
);
create index source_leads_job_idx on research.source_leads (job_id);

-- An import staged by an automated agent (imported_by 'agent:<name>') may be validated and dry-run, but it cannot be
-- applied with --write until a human review exists. Enforced in the pipeline (applyBatch) and recorded here.
create table research.import_reviews (
  import_batch_id bigint primary key references ingest.import_batches (id),
  reviewed_by text not null check (reviewed_by !~ '^agent:'),
  review_note text not null,
  reviewed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------------
-- Program order (which organizations first); data, not schema, so the benchmark set can change freely
-- ---------------------------------------------------------------------------------------------------------------

create table research.program_waves (
  organization_id bigint primary key references public.organizations (id),
  wave smallint not null check (wave between 1 and 9),
  rationale text not null,
  set_by text not null,
  set_at timestamptz not null default now()
);
insert into research.program_waves (organization_id, wave, rationale, set_by)
select id, 1, 'Validation organization: the 2015 pilot exists and DISI''s Dodgers research is a known cross-check', 'migration 019'
from public.organizations where franchise_key = 'LAD'
on conflict (organization_id) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Class metrics (one row per class) and the derived workflow status
-- ---------------------------------------------------------------------------------------------------------------

create view research.v_class_metrics with (security_invoker = true) as
with draft_picks as (
  select c.id as class_id, s.id as selection_id, s.player_id, s.round_pick, s.school_id, s.source_id, r.round_order,
         g.signing_status, g.signing_bonus_usd, g.source_id as signing_source_id, v.slot_value_usd,
         exists (select 1 from public.player_external_ids x where x.player_id = s.player_id) as has_external_id
  from research.classes c
  join public.draft_selections s on s.draft_id = c.draft_id and s.organization_id = c.organization_id
  join public.draft_rounds r on r.id = s.round_id
  left join public.draft_signings g on g.draft_selection_id = s.id
  left join public.slot_values v on v.draft_id = s.draft_id and v.overall_pick = s.overall_pick
  where c.channel_key = 'DRAFT'),
intl as (
  select c.id as class_id, i.id as signing_id, i.player_id, i.signing_date_precision, i.pathway, i.cost_completeness, i.source_id,
         exists (select 1 from public.player_external_ids x where x.player_id = i.player_id) as has_external_id
  from research.classes c
  join public.international_signings i on i.signing_period_id = c.signing_period_id and i.organization_id = c.organization_id
  where c.channel_key = 'INTERNATIONAL'),
subjects as (
  select class_id, 'draft_selections' as t, selection_id as id, player_id from draft_picks
  union all select dp.class_id, 'draft_signings', g.id, dp.player_id from draft_picks dp join public.draft_signings g on g.draft_selection_id = dp.selection_id
  union all select class_id, 'international_signings', signing_id, player_id from intl
  union all select class_id, 'players', player_id, player_id from draft_picks
  union all select class_id, 'players', player_id, player_id from intl),
class_players as (select distinct class_id, player_id from subjects)
select c.id as class_id, c.class_key, c.organization_id, c.channel_key, c.scope_key, c.stage,
       ca.coverage_state, ca.expected_count, ca.source_id as coverage_source_id,
       coalesce(dp.tracked, it.tracked, 0) as tracked,
       dp.signed, dp.unsigned, dp.status_unknown, dp.bonus_known, dp.bonus_missing, dp.slot_applicable, dp.slot_known, dp.school_known, dp.round_pick_known,
       it.day_dated, it.amateur, it.professional, it.cost_known, it.cost_unknown,
       coalesce(dp.identity_complete, it.identity_complete, 0) as identity_complete,
       coalesce(dp.provenanced, it.provenanced, 0) as provenanced,
       (select count(*) from public.v_open_fact_conflicts f join subjects s on s.t = f.subject_table and s.id = f.subject_id and s.class_id = c.id)::int as open_conflicts,
       (select count(*) from public.quality_flags q join subjects s on s.t = q.subject_table and s.id = q.subject_id and s.class_id = c.id
        where q.status = 'OPEN' and q.flag_code = 'EVIDENCE_EXCERPT_ONLY')::int as excerpt_only_flags,
       (select count(*) from class_players cp join public.v_player_outcome_status o on o.player_id = cp.player_id
        where cp.class_id = c.id and o.audit_state <> 'NOT_AUDITED')::int as outcomes_audited,
       (select count(*) from class_players cp where cp.class_id = c.id)::int as players
from research.classes c
left join public.coverage_assessments ca on ca.organization_id = c.organization_id
  and ca.domain = (select coverage_domain from research.channels where channel_key = c.channel_key) and ca.scope_key = c.scope_key
left join lateral (select count(*)::int tracked,
       count(*) filter (where signing_status = 'SIGNED')::int signed, count(*) filter (where signing_status = 'DID_NOT_SIGN')::int unsigned,
       count(*) filter (where signing_status is null)::int status_unknown,
       count(*) filter (where signing_status = 'SIGNED' and signing_bonus_usd is not null)::int bonus_known,
       count(*) filter (where signing_status = 'SIGNED' and signing_bonus_usd is null)::int bonus_missing,
       count(*) filter (where round_order <= 100)::int slot_applicable, count(*) filter (where round_order <= 100 and slot_value_usd is not null)::int slot_known,
       count(*) filter (where school_id is not null)::int school_known, count(*) filter (where round_pick is not null)::int round_pick_known,
       count(*) filter (where has_external_id)::int identity_complete,
       count(*) filter (where source_id is not null and (signing_status is null or signing_source_id is not null))::int provenanced
     from draft_picks x where x.class_id = c.id) dp on c.channel_key = 'DRAFT'
left join lateral (select count(*)::int tracked, count(*) filter (where signing_date_precision = 'DAY')::int day_dated,
       count(*) filter (where pathway = 'INTERNATIONAL_AMATEUR')::int amateur, count(*) filter (where pathway <> 'INTERNATIONAL_AMATEUR')::int professional,
       count(*) filter (where cost_completeness <> 'UNKNOWN')::int cost_known, count(*) filter (where cost_completeness = 'UNKNOWN')::int cost_unknown,
       count(*) filter (where has_external_id)::int identity_complete, count(*) filter (where source_id is not null)::int provenanced
     from intl x where x.class_id = c.id) it on c.channel_key = 'INTERNATIONAL';

-- Workflow status is derived, never typed in. Order of precedence:
--   CERTIFIED > READY_FOR_REVIEW > BLOCKED > IN_PROGRESS > PARTIAL > NOT_STARTED
create view research.v_class_status with (security_invoker = true) as
with j as (
  select c.id as class_id,
         count(*) filter (where not research.job_state_terminal(j.state))::int open_jobs,
         count(*) filter (where j.state = 'BLOCKED')::int blocked_jobs,
         count(*) filter (where j.state in ('OPEN', 'IN_PROGRESS') and (j.category_key <> 'COVERAGE_CERTIFICATION' or c.stage = 'COVERAGE_REVIEW')
           and (j.depends_on_job_id is null
           or exists (select 1 from research.jobs d where d.id = j.depends_on_job_id and research.job_state_terminal(d.state))))::int actionable_jobs,
         -- Work that must finish before review: outcome audits (NOT_AUDITED is not failure), excerpt-only replacement and the
         -- certification job itself do not hold a class back (same rule as research:certify).
         count(*) filter (where not research.job_state_terminal(j.state)
           and j.category_key not in ('OUTCOME_NOT_AUDITED', 'LOW_QUALITY_SOURCE', 'COVERAGE_CERTIFICATION'))::int open_work,
         count(*) filter (where j.state <> 'OPEN')::int touched_jobs,
         count(*) filter (where j.state = 'UNRESOLVED')::int unresolved_jobs
  from research.classes c left join research.jobs j on j.class_id = c.id group by c.id, c.stage)
select c.id as class_id, c.class_key, c.stage, j.open_jobs, j.blocked_jobs, j.actionable_jobs, j.open_work, j.unresolved_jobs,
       exists (select 1 from research.batches b where b.class_id = c.id and b.state = 'STARTED') as batch_active,
       cert.certified_at,
       case
         when cert.id is not null then 'CERTIFIED'
         when c.stage = 'COVERAGE_REVIEW' and j.open_work = 0 then 'READY_FOR_REVIEW'
         when j.blocked_jobs > 0 and j.actionable_jobs = 0 then 'BLOCKED'
         when exists (select 1 from research.batches b where b.class_id = c.id and b.state = 'STARTED') then 'IN_PROGRESS'
         when j.touched_jobs > 0 or c.stage <> 'DISCOVERY' or exists (select 1 from research.batches b where b.class_id = c.id) then 'PARTIAL'
         else 'NOT_STARTED'
       end as workflow_status
from research.classes c
join j on j.class_id = c.id
left join research.certifications cert on cert.class_id = c.id and cert.revoked_at is null;

-- The deterministic work queue: actionable jobs (open or in progress, dependency finished, class not certified; the
-- certification job only once the class is at COVERAGE_REVIEW) in the
-- documented order: program wave, category priority rank, class chronology, franchise key, job key.
create view research.v_next_jobs with (security_invoker = true) as
select j.id as job_id, j.job_key, j.title, j.state, j.category_key, k.priority_rank, k.stage as job_stage, c.class_key, c.stage as class_stage,
       o.franchise_key, c.channel_key, c.scope_key, coalesce(w.wave, 3) as wave,
       coalesce(d.start_date, p.start_date, make_date(c.season, 1, 1)) as scope_start,
       j.subject_label, j.player_id, j.assigned_to, j.source_requirements,
       row_number() over (order by coalesce(w.wave, 3), k.priority_rank, coalesce(d.start_date, p.start_date, make_date(c.season, 1, 1)), o.franchise_key, c.channel_key, j.job_key) as queue_position
from research.jobs j
join research.classes c on c.id = j.class_id
join research.job_categories k on k.category_key = j.category_key
join public.organizations o on o.id = c.organization_id
left join research.program_waves w on w.organization_id = c.organization_id
left join public.drafts d on d.id = c.draft_id
left join public.international_signing_periods p on p.id = c.signing_period_id
where j.state in ('OPEN', 'IN_PROGRESS') and c.stage <> 'CERTIFIED'
  and (j.category_key <> 'COVERAGE_CERTIFICATION' or c.stage = 'COVERAGE_REVIEW')    -- certification is actionable only at review
  and (j.depends_on_job_id is null or exists (select 1 from research.jobs dj where dj.id = j.depends_on_job_id and research.job_state_terminal(dj.state)));

-- ---------------------------------------------------------------------------------------------------------------
-- Acquisition economics (private analytics; rates only for certified, census-level cohorts)
-- ---------------------------------------------------------------------------------------------------------------

create function public.bonus_band(p numeric) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$ select case when p is null then null when p < 100000 then 'UNDER_100K' when p < 500000 then '100K_500K' when p < 1000000 then '500K_1M'
  when p < 2000000 then '1M_2M' when p < 5000000 then '2M_5M' else '5M_PLUS' end $$;

create view analytics.acquisition_economics with (security_invoker = true) as
select 'DRAFT'::public.acquisition_domain as channel, s.organization_id, d.draft_key as scope_key, s.player_id, s.overall_pick, r.round_code,
       g.signing_status::text as signing_status, g.signing_bonus_usd as acquisition_cost_usd, v.slot_value_usd,
       g.signing_bonus_usd - v.slot_value_usd as bonus_minus_slot_usd, public.bonus_band(g.signing_bonus_usd) as bonus_band,
       sc.school_type::text as school_type, null::text as birth_country, s.position, d.rules_era_id,
       o.audit_state, o.career_war_bref, o.career_war_fangraphs,
       case o.audit_state when 'AUDITED_REACHED_MLB' then true when 'AUDITED_NO_MLB' then false end as reached_mlb
from public.draft_selections s
join public.drafts d on d.id = s.draft_id
join public.draft_rounds r on r.id = s.round_id
left join public.draft_signings g on g.draft_selection_id = s.id
left join public.slot_values v on v.draft_id = s.draft_id and v.overall_pick = s.overall_pick
left join public.schools sc on sc.id = s.school_id
join analytics.player_outcome_profile o on o.player_id = s.player_id
union all
select 'INTERNATIONAL', i.organization_id, p.period_key, i.player_id, null, null, i.pathway::text, i.known_total_cost_usd, null, null,
       public.bonus_band(i.signing_bonus_usd), null, i.birth_country, i.position, p.rules_era_id,
       o.audit_state, o.career_war_bref, o.career_war_fangraphs,
       case o.audit_state when 'AUDITED_REACHED_MLB' then true when 'AUDITED_NO_MLB' then false end
from public.international_signings i
join public.international_signing_periods p on p.id = i.signing_period_id
join analytics.player_outcome_profile o on o.player_id = i.player_id;

-- Per class: totals of KNOWN values only, and rates that stay null unless the cohort is census-level and certified.
create view analytics.class_economics with (security_invoker = true) as
with agg as (
  select e.channel, e.organization_id, e.scope_key, count(*)::int acquisitions,
         count(*) filter (where e.acquisition_cost_usd is not null)::int cost_known,
         sum(e.acquisition_cost_usd) as known_cost_usd, sum(e.slot_value_usd) as known_slot_usd,
         count(*) filter (where e.audit_state <> 'NOT_AUDITED')::int audited,
         count(*) filter (where e.reached_mlb)::int audited_reached_mlb,
         sum(coalesce(e.career_war_bref, 0)) filter (where e.audit_state <> 'NOT_AUDITED') as audited_war_bref
  from analytics.acquisition_economics e group by 1, 2, 3)
select a.*, ca.coverage_state, (cert.id is not null) as certified,
       (public.coverage_supports_population_rate(ca.coverage_state) and cert.id is not null and a.audited = a.acquisitions and a.cost_known = a.acquisitions) as rates_allowed,
       case when public.coverage_supports_population_rate(ca.coverage_state) and cert.id is not null and a.audited = a.acquisitions
            then round(a.audited_reached_mlb::numeric / nullif(a.acquisitions, 0), 3) end as mlb_reach_rate,
       case when public.coverage_supports_population_rate(ca.coverage_state) and cert.id is not null and a.audited = a.acquisitions and a.cost_known = a.acquisitions
            then round(a.known_cost_usd / nullif(a.audited_reached_mlb, 0), 0) end as cost_per_mlb_player
from agg a
left join public.coverage_assessments ca on ca.organization_id = a.organization_id and ca.domain::text = a.channel::text and ca.scope_key = a.scope_key
left join research.classes c on c.organization_id = a.organization_id and c.channel_key = a.channel::text and c.scope_key = a.scope_key
left join research.certifications cert on cert.class_id = c.id and cert.revoked_at is null;

-- ---------------------------------------------------------------------------------------------------------------
-- Public read model: certification state per class (no workflow detail, no notes)
-- ---------------------------------------------------------------------------------------------------------------

create table public.rm_research_certification (
  domain public.acquisition_domain not null,
  scope_key text not null,
  organization_id bigint not null references public.organizations (id),
  certified boolean not null,
  certified_on date,
  coverage_state_at_certification public.coverage_state,
  refreshed_at timestamptz not null,
  primary key (domain, scope_key, organization_id)
);

create function public.refresh_research_certification() returns integer
language plpgsql
set search_path = pg_catalog, public, research
as $$
declare
  n integer;
begin
  delete from public.rm_research_certification;
  insert into public.rm_research_certification (domain, scope_key, organization_id, certified, certified_on, coverage_state_at_certification, refreshed_at)
  select ch.coverage_domain::text::public.acquisition_domain, c.scope_key, c.organization_id, true, cert.certified_at::date, cert.coverage_state, now()
  from research.classes c
  join research.channels ch on ch.channel_key = c.channel_key and ch.coverage_domain in ('DRAFT', 'INTERNATIONAL')
  join research.certifications cert on cert.class_id = c.id and cert.revoked_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Boundary: public objects through the standard boundary; the research schema stays closed to every platform role
-- ---------------------------------------------------------------------------------------------------------------

-- Defense in depth: research tables also carry RLS with no policies, so they stay closed even if someone exposed the
-- schema by mistake (the owner bypasses RLS; nothing else may read them).
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'research' and c.relkind = 'r' loop
    execute format('alter table research.%I enable row level security', t.relname);
  end loop;
end $$;

select public.apply_public_boundary();
revoke all on all tables in schema research from public, anon, authenticated, service_role;
revoke all on all sequences in schema research from public, anon, authenticated, service_role;
revoke all on all functions in schema research from public, anon, authenticated, service_role;
revoke all on all tables in schema analytics from public, anon, authenticated, service_role;
