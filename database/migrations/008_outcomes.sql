-- 008_outcomes
-- Outcome audits, MLB debuts and WAR observations.
--
-- Rules encoded here:
--   * unaudited != failed: a player with no audit row is NOT_AUDITED, and only AUDITED_* states enter reach-rate denominators.
--   * Missing WAR is absent (no row), never zero. war_value is NOT NULL; nothing coalesces it to 0.
--   * Career value (scope CAREER) and organization-realized value (scope ORGANIZATION_TENURE) are separate observations.
--   * Audit state and debut facts must agree (deferred constraint triggers).

create type public.outcome_audit_state as enum (
  'NOT_AUDITED', 'AUDITED_REACHED_MLB', 'AUDITED_NO_MLB', 'ACTIVE_TOO_RECENT', 'OUT_OF_SCOPE', 'UNKNOWN'
);

create table public.outcome_audits (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id),
  audit_state public.outcome_audit_state not null,
  observation_through_season integer check (observation_through_season between 1871 and 2100),
  audited_on date not null,
  source_id bigint references public.sources (id),
  notes text,
  created_at timestamptz not null default now(),
  unique nulls not distinct (player_id, observation_through_season),
  check (audit_state not in ('AUDITED_REACHED_MLB', 'AUDITED_NO_MLB', 'ACTIVE_TOO_RECENT')
         or (observation_through_season is not null and source_id is not null))
);
create index outcome_audits_player_idx on public.outcome_audits (player_id, audited_on desc);

create table public.mlb_debuts (
  id bigint generated always as identity primary key,
  player_id bigint not null unique references public.players (id),
  debut_date date not null,
  debut_organization_id bigint not null references public.organizations (id),
  source_id bigint not null references public.sources (id)
);

create function public.outcome_consistency_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_player bigint := coalesce(new.player_id, old.player_id);
  v_bad record;
begin
  select a.id, a.audit_state, a.observation_through_season, d.debut_date into v_bad
  from public.outcome_audits a
  left join public.mlb_debuts d on d.player_id = a.player_id
  where a.player_id = v_player
    and ((a.audit_state = 'AUDITED_REACHED_MLB' and (d.id is null or extract(year from d.debut_date) > a.observation_through_season))
      or (a.audit_state = 'AUDITED_NO_MLB' and d.id is not null and extract(year from d.debut_date) <= a.observation_through_season))
  limit 1;
  if found then
    raise exception 'outcome audit % (%) through % is inconsistent with debut %', v_bad.id, v_bad.audit_state,
      v_bad.observation_through_season, v_bad.debut_date using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger outcome_audits_consistency after insert or update on public.outcome_audits
  deferrable initially deferred for each row execute function public.outcome_consistency_guard();
create constraint trigger mlb_debuts_consistency after insert or update or delete on public.mlb_debuts
  deferrable initially deferred for each row execute function public.outcome_consistency_guard();

create type public.war_system as enum ('BREF', 'FANGRAPHS', 'OTHER');     -- BREF = bWAR / rWAR
create type public.war_scope as enum ('CAREER', 'SEASON', 'ORGANIZATION_TENURE');

create table public.war_observations (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id),
  war_system public.war_system not null,
  scope public.war_scope not null,
  season integer,
  organization_id bigint references public.organizations (id),
  through_season integer not null check (through_season between 1871 and 2100),
  war_value numeric(6, 1) not null,
  observed_on date not null,
  source_id bigint not null references public.sources (id),
  check (scope <> 'CAREER' or (season is null and organization_id is null)),
  check (scope <> 'SEASON' or (season is not null and season <= through_season)),
  check (scope <> 'ORGANIZATION_TENURE' or organization_id is not null),
  unique nulls not distinct (player_id, war_system, scope, season, organization_id, through_season)
);
create index war_observations_player_idx on public.war_observations (player_id);

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('mlb_debuts', 'OUTCOME', 'MLB debut'),
  ('war_observations', 'OUTCOME', 'WAR observation (career / season / organization tenure)')
on conflict (table_name) do nothing;

-- Current outcome per player. Players with no audit are NOT_AUDITED. Career bWAR is the latest observation or NULL.
create view public.v_player_outcome_status with (security_invoker = true) as
select p.id as player_id,
       coalesce(a.audit_state, 'NOT_AUDITED') as audit_state,
       a.observation_through_season, a.audited_on,
       d.debut_date, d.debut_organization_id,
       w.war_value as career_bwar, w.through_season as career_bwar_through_season
from public.players p
left join lateral (select * from public.outcome_audits oa where oa.player_id = p.id
                   order by oa.observation_through_season desc nulls last, oa.audited_on desc limit 1) a on true
left join public.mlb_debuts d on d.player_id = p.id
left join lateral (select * from public.war_observations wo where wo.player_id = p.id and wo.war_system = 'BREF' and wo.scope = 'CAREER'
                   order by wo.through_season desc, wo.observed_on desc limit 1) w on true;

-- MLB reach among audited acquisitions only. Unaudited, unknown, too-recent and out-of-scope players are counted separately
-- and never enter the denominator. Not public: summaries reach the app only through read models (011).
create view analytics.acquisition_outcome_summary with (security_invoker = true) as
select a.organization_id, a.channel,
       count(distinct a.player_id) as acquired_players,
       count(distinct a.player_id) filter (where o.audit_state = 'AUDITED_REACHED_MLB') as audited_reached_mlb,
       count(distinct a.player_id) filter (where o.audit_state = 'AUDITED_NO_MLB') as audited_no_mlb,
       count(distinct a.player_id) filter (where o.audit_state = 'NOT_AUDITED') as not_audited,
       count(distinct a.player_id) filter (where o.audit_state not in ('AUDITED_REACHED_MLB', 'AUDITED_NO_MLB', 'NOT_AUDITED')) as other_states
from public.v_acquisitions a
join public.v_player_outcome_status o on o.player_id = a.player_id
group by a.organization_id, a.channel;
