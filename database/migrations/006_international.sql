-- 006_international
-- International acquisition: markets, date-bounded signing periods, signings with separate cost components, organization
-- period context, trainers and academies.
--
-- Rules encoded here:
--   * Signing periods are explicit [start_date, end_date] ranges that may not overlap. A signing's date must fall inside its
--     assigned period (periods have not always started on July 2; the calendar is data, never derived from a year).
--   * Acquisition pathways stay distinct (amateur, posting, other international professional, other).
--   * Cost components are separate nullable columns. NULL = unknown; 0 = known to be zero. Known total is the sum of known
--     components and is NULL when nothing is known; cost_completeness says whether the total is the full cost.

create table public.markets (
  id bigint generated always as identity primary key,
  market_key text not null unique check (market_key ~ '^[A-Z]{2,12}$'),   -- usually ISO 3166-1 alpha-3
  name text not null,
  region text,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create table public.international_signing_periods (
  id bigint generated always as identity primary key,
  period_key text not null unique check (period_key ~ '^[0-9]{4}(-[0-9]{2})?$'),   -- '2019-20' or '2022'
  label text not null,
  start_date date not null,
  end_date date not null,
  rules_note text,
  source_id bigint not null references public.sources (id),
  period_range daterange generated always as (daterange(start_date, end_date, '[]')) stored,
  check (start_date <= end_date),
  exclude using gist (period_range with &&)
);

-- The period whose window contains a date (null when no recorded period covers it).
create function public.international_period_for_date(p_date date) returns bigint
language sql stable
set search_path = pg_catalog, public
as $$ select id from public.international_signing_periods where period_range @> p_date $$;

create type public.international_pathway as enum ('INTERNATIONAL_AMATEUR', 'POSTING_SYSTEM', 'INTERNATIONAL_PROFESSIONAL', 'OTHER');
create type public.cost_completeness as enum ('ALL_COMPONENTS_KNOWN', 'PARTIAL', 'UNKNOWN');

create table public.international_signings (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id),
  organization_id bigint not null references public.organizations (id),
  signing_period_id bigint references public.international_signing_periods (id),
  signing_date date,
  signing_date_precision public.date_precision,
  pathway public.international_pathway not null,
  market_id bigint references public.markets (id),
  birth_country text,
  position text,
  age_at_signing numeric(4, 1) check (age_at_signing between 14 and 50),
  age_basis text check (age_basis in ('BIRTH_DATE_AND_SIGNING_DATE', 'PUBLISHED_AGE')),
  signing_bonus_usd numeric(14, 2) check (signing_bonus_usd >= 0),
  posting_fee_usd numeric(14, 2) check (posting_fee_usd >= 0),
  transfer_fee_usd numeric(14, 2) check (transfer_fee_usd >= 0),
  other_cost_usd numeric(14, 2) check (other_cost_usd >= 0),
  known_total_cost_usd numeric(15, 2) generated always as (
    case when coalesce(signing_bonus_usd, posting_fee_usd, transfer_fee_usd, other_cost_usd) is null then null
         else coalesce(signing_bonus_usd, 0) + coalesce(posting_fee_usd, 0) + coalesce(transfer_fee_usd, 0) + coalesce(other_cost_usd, 0) end
  ) stored,
  cost_completeness public.cost_completeness generated always as (
    case when signing_bonus_usd is not null and posting_fee_usd is not null and transfer_fee_usd is not null and other_cost_usd is not null
           then 'ALL_COMPONENTS_KNOWN'::public.cost_completeness
         when coalesce(signing_bonus_usd, posting_fee_usd, transfer_fee_usd, other_cost_usd) is null then 'UNKNOWN'::public.cost_completeness
         else 'PARTIAL'::public.cost_completeness end
  ) stored,
  source_id bigint not null references public.sources (id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (signing_period_id is not null or signing_date is not null),
  check ((signing_date is null) = (signing_date_precision is null)),
  check (age_at_signing is null or age_basis is not null),
  unique nulls not distinct (player_id, organization_id, signing_period_id, signing_date)
);
create index international_signings_org_idx on public.international_signings (organization_id, signing_period_id);
create index international_signings_player_idx on public.international_signings (player_id);
create trigger international_signings_updated_at before update on public.international_signings for each row execute function public.set_updated_at();

create function public.international_signing_period_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_range daterange;
begin
  if new.signing_period_id is not null and new.signing_date is not null and new.signing_date_precision = 'DAY' then
    select period_range into v_range from public.international_signing_periods where id = new.signing_period_id;
    if not v_range @> new.signing_date then
      raise exception 'international signing % dated % falls outside its signing period %', new.id, new.signing_date, v_range
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger international_signings_period_guard before insert or update on public.international_signings
  for each row execute function public.international_signing_period_guard();

create type public.pool_restriction_status as enum ('NONE', 'RESTRICTED', 'UNKNOWN');

create table public.organization_signing_period_context (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id),
  signing_period_id bigint not null references public.international_signing_periods (id),
  base_pool_usd numeric(14, 2) check (base_pool_usd >= 0),
  pool_after_trades_usd numeric(14, 2) check (pool_after_trades_usd >= 0),
  restriction_status public.pool_restriction_status not null default 'UNKNOWN',
  restriction_cap_usd numeric(14, 2) check (restriction_cap_usd >= 0),
  source_id bigint not null references public.sources (id),
  notes text,
  unique (organization_id, signing_period_id),
  check (restriction_status = 'RESTRICTED' or restriction_cap_usd is null)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Trainers and academies (pre-acquisition development network). Only verified/reported relationships with a source.
-- ---------------------------------------------------------------------------------------------------------------

create type public.relationship_verification as enum ('VERIFIED', 'REPORTED');

create table public.trainers (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  name_basis text not null default 'NAMED' check (name_basis in ('NAMED', 'NICKNAME_ONLY', 'DESCRIPTIVE')),
  country text,
  source_id bigint not null references public.sources (id)
);

create table public.academies (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  academy_kind text not null check (academy_kind in ('INDEPENDENT_PROGRAM', 'LEAGUE_PROGRAM', 'SCHOOL_PROGRAM', 'OTHER')),
  country text,
  city text,
  operator_trainer_id bigint references public.trainers (id),
  source_id bigint not null references public.sources (id)
);

create table public.player_trainer_relationships (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id),
  trainer_id bigint not null references public.trainers (id),
  verification public.relationship_verification not null,
  start_year integer, end_year integer,
  at_signing boolean,                    -- null = not established
  source_id bigint not null references public.sources (id),
  unique (player_id, trainer_id, source_id)
);

create table public.player_academy_relationships (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id),
  academy_id bigint not null references public.academies (id),
  verification public.relationship_verification not null,
  start_year integer, end_year integer,
  at_signing boolean,
  source_id bigint not null references public.sources (id),
  unique (player_id, academy_id, source_id)
);

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('international_signing_periods', 'INTERNATIONAL', 'Signing period calendar'),
  ('international_signings', 'INTERNATIONAL', 'International acquisition'),
  ('organization_signing_period_context', 'INTERNATIONAL', 'Club pool / restriction context per period'),
  ('trainers', 'INTERNATIONAL', 'Trainer identity'),
  ('academies', 'INTERNATIONAL', 'Academy / program identity'),
  ('player_trainer_relationships', 'INTERNATIONAL', 'Player-trainer link'),
  ('player_academy_relationships', 'INTERNATIONAL', 'Player-academy link')
on conflict (table_name) do nothing;
