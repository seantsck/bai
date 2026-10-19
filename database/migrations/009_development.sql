-- 009_development
-- Shared development infrastructure: affiliates by season, player assignments (stints) and promotion/demotion chronology.
--
-- Reasons for a move are stored only when a source states them (reason requires reason_source_id). BAI never infers why.

create type public.development_level as enum (
  'MLB', 'AAA', 'AA', 'HIGH_A', 'A', 'LOW_A', 'SHORT_SEASON_A', 'ROOKIE_ADVANCED', 'ROOKIE', 'COMPLEX', 'DSL', 'VSL', 'OTHER'
);

-- Ordinal for chronology checks only (higher = closer to MLB). OTHER has no rank.
create function public.development_level_rank(p_level public.development_level) returns integer
language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  select case p_level
    when 'MLB' then 9 when 'AAA' then 8 when 'AA' then 7 when 'HIGH_A' then 6 when 'A' then 5 when 'LOW_A' then 5
    when 'SHORT_SEASON_A' then 4 when 'ROOKIE_ADVANCED' then 3 when 'ROOKIE' then 2 when 'COMPLEX' then 2
    when 'DSL' then 1 when 'VSL' then 1 else null end
$$;

create table public.affiliates (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  city text,
  mlb_team_id integer unique                -- MLBAM sport team id where known
);

-- Affiliation and level change over time, so they are recorded per season.
create table public.affiliate_seasons (
  id bigint generated always as identity primary key,
  affiliate_id bigint not null references public.affiliates (id),
  organization_id bigint not null references public.organizations (id),
  season integer not null check (season between 1871 and 2100),
  level public.development_level not null,
  league_name text,
  source_id bigint not null references public.sources (id),
  unique (affiliate_id, season)
);

create table public.player_assignments (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id),
  organization_id bigint not null references public.organizations (id),
  affiliate_id bigint references public.affiliates (id),
  level public.development_level not null,
  season integer not null check (season between 1871 and 2100),
  start_date date,
  end_date date,
  date_precision public.date_precision not null default 'SEASON',
  games integer check (games >= 0),        -- null = not recorded (not zero games)
  source_id bigint not null references public.sources (id),
  check (end_date is null or start_date is null or end_date >= start_date),
  check (start_date is null or extract(year from start_date) = season),
  unique nulls not distinct (player_id, organization_id, affiliate_id, level, season, start_date)
);
create index player_assignments_player_idx on public.player_assignments (player_id, season);

create type public.development_event_type as enum ('ASSIGNED', 'PROMOTED', 'DEMOTED', 'INJURED_LIST', 'ACTIVATED', 'RELEASED', 'OTHER');

create table public.development_events (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id),
  organization_id bigint not null references public.organizations (id),
  event_type public.development_event_type not null,
  event_date date not null,
  date_precision public.date_precision not null default 'DAY',
  from_level public.development_level,
  to_level public.development_level,
  reason text,
  reason_source_id bigint references public.sources (id),
  source_id bigint not null references public.sources (id),
  check (reason is null or reason_source_id is not null),
  check (event_type not in ('PROMOTED', 'DEMOTED') or (from_level is not null and to_level is not null)),
  check (event_type <> 'PROMOTED' or public.development_level_rank(to_level) > public.development_level_rank(from_level)),
  check (event_type <> 'DEMOTED' or public.development_level_rank(to_level) < public.development_level_rank(from_level))
);
create index development_events_player_idx on public.development_events (player_id, event_date);

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('affiliate_seasons', 'DEVELOPMENT', 'Affiliate parent club and level in a season'),
  ('player_assignments', 'DEVELOPMENT', 'Player assignment / stint'),
  ('development_events', 'DEVELOPMENT', 'Promotion / demotion / status event')
on conflict (table_name) do nothing;

create view public.v_player_development_chronology with (security_invoker = true) as
select player_id, organization_id, coalesce(start_date, make_date(season, 1, 1)) as sort_date, season,
       'ASSIGNMENT'::text as entry_kind, level::text as level, null::text as from_level, games, source_id
from public.player_assignments
union all
select player_id, organization_id, event_date, extract(year from event_date)::int, event_type::text, to_level::text, from_level::text, null, source_id
from public.development_events;
