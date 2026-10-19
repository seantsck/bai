-- 007_draft
-- MLB amateur draft, schools/programs, and the shared acquisition layer (both channels + acquisition-time expectations).
--
-- PLAYER, DRAFT, DRAFT SELECTION and DRAFT SIGNING are separate entities:
--   * a player may be selected in several drafts (one selection per draft);
--   * a selection is a historical fact whether or not the player signed;
--   * signing status lives on draft_signings; a selection without a signing row is UNKNOWN (not researched), never "unsigned".
-- Draft structure (rounds, phases, compensation picks, pick numbering) is stored per draft, never assumed.

create type public.school_type as enum ('HIGH_SCHOOL', 'COLLEGE', 'JUNIOR_COLLEGE', 'OTHER');

create table public.schools (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  name_normalized text generated always as (public.normalize_name(name)) stored,
  school_type public.school_type not null,
  city text,
  region text,                           -- state / province
  country text,
  source_id bigint references public.sources (id)
);
create index schools_name_normalized_idx on public.schools (name_normalized);

create table public.school_aliases (
  id bigint generated always as identity primary key,
  school_id bigint not null references public.schools (id) on delete cascade,
  alias text not null,
  alias_normalized text generated always as (public.normalize_name(alias)) stored,
  unique (school_id, alias_normalized)
);
create index school_aliases_normalized_idx on public.school_aliases (alias_normalized);

create type public.draft_kind as enum ('JUNE_AMATEUR', 'JANUARY_REGULAR', 'JANUARY_SECONDARY', 'JUNE_SECONDARY', 'OTHER');

create table public.drafts (
  id bigint generated always as identity primary key,
  draft_key text not null unique check (draft_key ~ '^[0-9]{4}-[A-Z_]+$'),     -- '2019-JUNE_AMATEUR'
  draft_year integer not null check (draft_year between 1965 and 2100),
  draft_kind public.draft_kind not null,
  start_date date not null,
  end_date date,
  total_rounds integer check (total_rounds > 0),
  structure_note text,
  source_id bigint not null references public.sources (id),
  check (end_date is null or end_date >= start_date),
  check (extract(year from start_date) = draft_year),
  unique (draft_year, draft_kind)
);

create type public.draft_phase as enum ('REGULAR', 'COMPENSATION', 'COMPETITIVE_BALANCE_A', 'COMPETITIVE_BALANCE_B', 'SUPPLEMENTAL', 'PRIZE', 'OTHER');

create table public.draft_rounds (
  id bigint generated always as identity primary key,
  draft_id bigint not null references public.drafts (id) on delete cascade,
  round_code text not null,              -- as published: '1', 'C-1', 'CB-A', '2', ...
  round_order integer not null check (round_order > 0),
  phase public.draft_phase not null,
  label text,
  unique (draft_id, round_code),
  unique (draft_id, round_order),
  unique (id, draft_id)
);

create type public.draft_selection_type as enum ('STANDARD', 'COMPENSATION', 'COMPETITIVE_BALANCE', 'PRIZE', 'SUPPLEMENTAL', 'OTHER');

create table public.draft_selections (
  id bigint generated always as identity primary key,
  draft_id bigint not null references public.drafts (id),
  round_id bigint not null,
  overall_pick integer check (overall_pick > 0),
  round_pick integer check (round_pick > 0),
  organization_id bigint not null references public.organizations (id),
  selection_type public.draft_selection_type not null default 'STANDARD',
  player_id bigint not null references public.players (id),
  position text,
  school_id bigint references public.schools (id),
  school_type_at_selection public.school_type,
  selection_date date,
  source_id bigint not null references public.sources (id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (round_id, draft_id) references public.draft_rounds (id, draft_id),
  unique (draft_id, overall_pick),
  unique (round_id, round_pick),
  unique (draft_id, player_id)          -- once per draft; repeat selections across drafts are allowed
);
create index draft_selections_org_idx on public.draft_selections (organization_id, draft_id);
create index draft_selections_player_idx on public.draft_selections (player_id);
create trigger draft_selections_updated_at before update on public.draft_selections for each row execute function public.set_updated_at();

create table public.slot_values (
  id bigint generated always as identity primary key,
  draft_id bigint not null references public.drafts (id),
  overall_pick integer not null check (overall_pick > 0),
  slot_value_usd numeric(14, 2) not null check (slot_value_usd >= 0),
  source_id bigint not null references public.sources (id),
  unique (draft_id, overall_pick)
);

create table public.organization_draft_pools (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id),
  draft_id bigint not null references public.drafts (id),
  bonus_pool_usd numeric(14, 2) check (bonus_pool_usd >= 0),
  source_id bigint not null references public.sources (id),
  unique (organization_id, draft_id)
);

create type public.draft_signing_status as enum ('SIGNED', 'DID_NOT_SIGN');

create table public.draft_signings (
  id bigint generated always as identity primary key,
  draft_selection_id bigint not null unique references public.draft_selections (id),
  signing_status public.draft_signing_status not null,
  signing_bonus_usd numeric(14, 2) check (signing_bonus_usd >= 0),      -- null = unknown, even when SIGNED
  signing_date date,
  signing_date_precision public.date_precision,
  source_id bigint not null references public.sources (id),
  notes text,
  check ((signing_date is null) = (signing_date_precision is null)),
  check (signing_status = 'SIGNED' or (signing_bonus_usd is null and signing_date is null))
);

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('drafts', 'DRAFT', 'Draft event and structure'),
  ('draft_selections', 'DRAFT', 'Draft selection (pick)'),
  ('draft_signings', 'DRAFT', 'Signing outcome of a selection'),
  ('slot_values', 'DRAFT', 'Assigned slot value of a pick'),
  ('organization_draft_pools', 'DRAFT', 'Club bonus pool for a draft')
on conflict (table_name) do nothing;

-- Pick list with derived signing status. UNKNOWN = no signing research recorded; it is never treated as DID_NOT_SIGN.
create view public.v_draft_picks with (security_invoker = true) as
select s.id as draft_selection_id, d.id as draft_id, d.draft_key, d.draft_year, d.draft_kind, r.round_code, r.phase, s.overall_pick, s.round_pick,
       s.selection_type, s.organization_id, s.player_id, s.position, s.school_id,
       coalesce(s.school_type_at_selection, sc.school_type) as school_type,
       sv.slot_value_usd,
       coalesce(ds.signing_status::text, 'UNKNOWN') as signing_status,
       ds.signing_bonus_usd, ds.signing_date, s.source_id
from public.draft_selections s
join public.drafts d on d.id = s.draft_id
join public.draft_rounds r on r.id = s.round_id
left join public.schools sc on sc.id = s.school_id
left join public.slot_values sv on sv.draft_id = s.draft_id and sv.overall_pick = s.overall_pick
left join public.draft_signings ds on ds.draft_selection_id = s.id;

-- ---------------------------------------------------------------------------------------------------------------
-- Shared acquisition layer
-- ---------------------------------------------------------------------------------------------------------------

-- One row per acquisition event in either channel. acquisition_cutoff_date is the last date strictly before which evidence
-- counts as acquisition-time expectation: the exact signing / selection date, or (when only the period is known) the period's
-- start date, which is conservative.
create view public.v_acquisitions with (security_invoker = true) as
select 'INTERNATIONAL'::public.acquisition_domain as channel, i.id as acquisition_id, i.player_id, i.organization_id,
       coalesce(case when i.signing_date_precision = 'DAY' then i.signing_date end, p.start_date) as acquisition_cutoff_date,
       i.signing_date as acquisition_date, i.pathway::text as acquisition_kind, null::text as signing_status
from public.international_signings i
left join public.international_signing_periods p on p.id = i.signing_period_id
union all
select 'DRAFT', s.id, s.player_id, s.organization_id, coalesce(s.selection_date, d.start_date), coalesce(s.selection_date, d.start_date),
       'DRAFT_SELECTION', coalesce(ds.signing_status::text, 'UNKNOWN')
from public.draft_selections s
join public.drafts d on d.id = s.draft_id
left join public.draft_signings ds on ds.draft_selection_id = s.id;

-- Researcher-curated links from an acquisition to the expectation evidence that applied at that time.
create table public.acquisition_expectation_links (
  id bigint generated always as identity primary key,
  international_signing_id bigint references public.international_signings (id) on delete cascade,
  draft_selection_id bigint references public.draft_selections (id) on delete cascade,
  ranking_entry_id bigint references public.ranking_entries (id),
  evaluation_id bigint references public.evaluations (id),
  check (num_nonnulls(international_signing_id, draft_selection_id) = 1),
  check (num_nonnulls(ranking_entry_id, evaluation_id) = 1),
  unique nulls not distinct (international_signing_id, draft_selection_id, ranking_entry_id, evaluation_id)
);

-- Hindsight guard: evidence must concern the same player, the same channel, and be published strictly before the cutoff.
create function public.acquisition_expectation_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_channel public.acquisition_domain;
  v_player bigint;
  v_cutoff date;
  e_domain public.acquisition_domain;
  e_player bigint;
  e_published date;
begin
  select channel, player_id, acquisition_cutoff_date into v_channel, v_player, v_cutoff
  from public.v_acquisitions
  where (channel = 'INTERNATIONAL' and acquisition_id = new.international_signing_id)
     or (channel = 'DRAFT' and acquisition_id = new.draft_selection_id);

  if new.ranking_entry_id is not null then
    select l.domain, e.player_id, l.published_date into e_domain, e_player, e_published
    from public.ranking_entries e join public.ranking_lists l on l.id = e.ranking_list_id where e.id = new.ranking_entry_id;
  else
    select domain, player_id, published_date into e_domain, e_player, e_published from public.evaluations where id = new.evaluation_id;
  end if;

  if e_player <> v_player then
    raise exception 'expectation evidence concerns player %, acquisition concerns player %', e_player, v_player using errcode = 'check_violation';
  end if;
  if e_domain <> v_channel then
    raise exception 'expectation evidence domain % does not match acquisition channel %', e_domain, v_channel using errcode = 'check_violation';
  end if;
  if v_cutoff is null or e_published >= v_cutoff then
    raise exception 'hindsight: evidence published % is not before acquisition cutoff %', e_published, v_cutoff using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger acquisition_expectation_links_guard before insert or update on public.acquisition_expectation_links
  for each row execute function public.acquisition_expectation_guard();

-- Every structured expectation published before the acquisition cutoff (no curation required, no hindsight possible).
create view public.v_acquisition_time_expectations with (security_invoker = true) as
select a.channel, a.acquisition_id, a.player_id, a.organization_id, a.acquisition_cutoff_date,
       'RANKING'::text as evidence_kind, l.id as evidence_id, l.source_id, l.list_name as evidence_label, l.published_date,
       e.rank, null::numeric as future_value
from public.v_acquisitions a
join public.ranking_entries e on e.player_id = a.player_id
join public.ranking_lists l on l.id = e.ranking_list_id and l.domain = a.channel and l.published_date < a.acquisition_cutoff_date
union all
select a.channel, a.acquisition_id, a.player_id, a.organization_id, a.acquisition_cutoff_date,
       'EVALUATION', v.id, v.source_id, null, v.published_date, null, v.future_value
from public.v_acquisitions a
join public.evaluations v on v.player_id = a.player_id and v.domain = a.channel and v.published_date < a.acquisition_cutoff_date;
